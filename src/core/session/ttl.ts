import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";

import { coreDataPath } from "../data-layout.js";

import { getRuntimeSessionDir } from "../rin-lib/profile.js";

export const DEFAULT_SESSION_TTL_DAYS = 90;
const SESSION_TTL_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type SessionTtlConfig = {
  enabled: boolean;
  days: number;
};

export type SessionTtlResult = {
  enabled: boolean;
  sessionDir: string;
  cutoffMs: number;
  checked: number;
  deleted: string[];
  errors: Array<{ path: string; error: string }>;
};

function readJsonFile(filePath: string): any {
  try {
    return JSON.parse(fssync.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function normalizeSessionTtlConfig(settings: any): SessionTtlConfig {
  const sessionSettings = settings?.session || {};
  const enabled = sessionSettings.ttlEnabled !== false;
  const days = Number(sessionSettings.ttlDays);
  return {
    enabled,
    days:
      Number.isFinite(days) && days > 0
        ? Math.floor(days)
        : DEFAULT_SESSION_TTL_DAYS,
  };
}

export function loadSessionTtlConfig(agentDir: string): SessionTtlConfig {
  return normalizeSessionTtlConfig(
    readJsonFile(path.join(agentDir, "settings.json")),
  );
}

async function collectSessionFiles(dir: string): Promise<string[]> {
  if (!fssync.existsSync(dir)) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSessionFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(fullPath);
  }
  return files;
}

function isSessionPathUnderRoot(sessionDir: string, filePath: string) {
  const relative = path.relative(
    path.resolve(sessionDir),
    path.resolve(filePath),
  );
  return (
    Boolean(relative) &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

export async function runSessionTtlMaintenance(
  agentDir: string,
  options: { nowMs?: number; config?: SessionTtlConfig } = {},
): Promise<SessionTtlResult> {
  const config = options.config || loadSessionTtlConfig(agentDir);
  const sessionDir = getRuntimeSessionDir(process.cwd(), agentDir);
  const nowMs = Number.isFinite(options.nowMs)
    ? Number(options.nowMs)
    : Date.now();
  const cutoffMs = nowMs - config.days * SESSION_TTL_MIN_INTERVAL_MS;
  const result: SessionTtlResult = {
    enabled: config.enabled,
    sessionDir,
    cutoffMs,
    checked: 0,
    deleted: [],
    errors: [],
  };
  if (!config.enabled) return result;

  const files = await collectSessionFiles(sessionDir);
  for (const filePath of files) {
    result.checked += 1;
    if (!isSessionPathUnderRoot(sessionDir, filePath)) continue;
    try {
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs > cutoffMs) continue;
      await fs.rm(filePath, { force: true });
      result.deleted.push(filePath);
    } catch (error: any) {
      result.errors.push({
        path: filePath,
        error: String(error?.message || error || "session_ttl_delete_failed"),
      });
    }
  }
  return result;
}

function sessionTtlStatePath(agentDir: string) {
  return coreDataPath(agentDir, "sessions", "ttl-maintenance.json");
}

export async function runDueSessionTtlMaintenance(
  agentDir: string,
  options: { nowMs?: number; minIntervalMs?: number } = {},
): Promise<SessionTtlResult | undefined> {
  const nowMs = Number.isFinite(options.nowMs)
    ? Number(options.nowMs)
    : Date.now();
  const minIntervalMs = Number.isFinite(options.minIntervalMs)
    ? Math.max(0, Number(options.minIntervalMs))
    : SESSION_TTL_MIN_INTERVAL_MS;
  const statePath = sessionTtlStatePath(agentDir);
  const state = readJsonFile(statePath);
  const lastRunMs = Number(state?.lastRunMs || 0);
  if (lastRunMs && nowMs - lastRunMs < minIntervalMs) return undefined;

  const result = await runSessionTtlMaintenance(agentDir, { nowMs });
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(
    statePath,
    `${JSON.stringify(
      {
        lastRunMs: nowMs,
        lastRunAt: new Date(nowMs).toISOString(),
        checked: result.checked,
        deleted: result.deleted.length,
        errors: result.errors.length,
        enabled: result.enabled,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return result;
}
