import fs from "node:fs";
import path from "node:path";

import { coreDataPath } from "../data-layout.js";
import { installedRinDocsRoot } from "../rin-install/paths.js";
import { stringifyJson } from "../platform/fs.js";
import { safeString } from "../text-utils.js";
import { nowIso } from "../time-utils.js";

export const AGENT_PRACTICES_REPOSITORY =
  "https://github.com/rinchan-hoshino/rin-agent-practices";
export const AGENT_PRACTICES_RAW_BASE_URL =
  "https://raw.githubusercontent.com/rinchan-hoshino/rin-agent-practices/main";
export type AgentPracticesSyncResult = {
  source: string;
  targetDir: string;
  files: string[];
  syncedAt: string;
};

type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<any>;

type LoggerLike = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

function practicesTargetDir(agentDir: string) {
  return path.join(installedRinDocsRoot(agentDir), "practices");
}

function practicesSyncStatePath(agentDir: string) {
  return coreDataPath(agentDir, "docs", "agent-practices-sync.json");
}

function validateManifestFileName(value: unknown): string {
  const file = safeString(value).trim().replace(/\\/g, "/");
  if (!file || file.startsWith("/") || file.includes("../")) {
    throw new Error(`invalid_practices_manifest_path:${file}`);
  }
  if (file === "manifest.json") {
    throw new Error("invalid_practices_manifest_path:manifest.json");
  }
  if (file.split("/").some((part) => part === ".." || part === "")) {
    throw new Error(`invalid_practices_manifest_path:${file}`);
  }
  if (!file.endsWith(".md")) {
    throw new Error(`invalid_practices_manifest_path:${file}`);
  }
  return file;
}

export function normalizeAgentPracticesManifest(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    throw new Error("invalid_practices_manifest");
  }
  const files = (value as any).files;
  if (!Array.isArray(files)) throw new Error("invalid_practices_manifest");
  return Array.from(new Set(files.map(validateManifestFileName))).sort();
}

async function fetchText(fetcher: FetchLike, url: string): Promise<string> {
  const response = await fetcher(url, {
    headers: { accept: "text/plain, application/json;q=0.9, */*;q=0.1" },
  });
  if (!response?.ok) {
    throw new Error(
      `agent_practices_fetch_failed:${response?.status || 0}:${url}`,
    );
  }
  return String(await response.text());
}

function writeSyncState(agentDir: string, value: unknown) {
  const statePath = practicesSyncStatePath(agentDir);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, stringifyJson(value), "utf8");
}

async function writeSyncedPracticesTree(
  agentDir: string,
  files: string[],
  contents: Map<string, string>,
  manifestText: string,
) {
  const targetDir = practicesTargetDir(agentDir);
  const tmpRoot = coreDataPath(agentDir, "docs", "agent-practices-sync-tmp");
  fs.mkdirSync(tmpRoot, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(tmpRoot, "practices-"));
  try {
    for (const file of files) {
      const targetPath = path.join(tmpDir, file);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, contents.get(file) || "", "utf8");
    }
    fs.writeFileSync(path.join(tmpDir, "manifest.json"), manifestText, "utf8");
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, targetDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return targetDir;
}

export async function syncAgentPracticesDocs(
  agentDir: string,
  options: {
    rawBaseUrl?: string;
    fetch?: FetchLike;
    logger?: LoggerLike;
  } = {},
): Promise<AgentPracticesSyncResult> {
  const rawBaseUrl =
    safeString(options.rawBaseUrl).trim().replace(/\/+$/, "") ||
    AGENT_PRACTICES_RAW_BASE_URL;
  const fetcher = options.fetch || globalThis.fetch?.bind(globalThis);
  if (!fetcher) throw new Error("agent_practices_fetch_unavailable");

  const attemptedAt = nowIso();
  try {
    const manifestUrl = `${rawBaseUrl}/manifest.json`;
    const manifestText = await fetchText(fetcher, manifestUrl);
    const files = normalizeAgentPracticesManifest(JSON.parse(manifestText));
    const contents = new Map<string, string>();
    for (const file of files) {
      contents.set(file, await fetchText(fetcher, `${rawBaseUrl}/${file}`));
    }
    const targetDir = await writeSyncedPracticesTree(
      agentDir,
      files,
      contents,
      manifestText.endsWith("\n") ? manifestText : `${manifestText}\n`,
    );
    const result = {
      source: rawBaseUrl,
      targetDir,
      files,
      syncedAt: nowIso(),
    };
    writeSyncState(agentDir, {
      ...result,
      lastAttemptAt: attemptedAt,
      status: "ok",
    });
    options.logger?.info?.(
      `agent practices docs synced: ${files.length} files from ${rawBaseUrl}`,
    );
    return result;
  } catch (error: any) {
    const message = safeString(error?.message || error) || "sync_failed";
    writeSyncState(agentDir, {
      source: rawBaseUrl,
      targetDir: practicesTargetDir(agentDir),
      lastAttemptAt: attemptedAt,
      status: "error",
      error: message,
    });
    options.logger?.warn?.(`agent practices docs sync failed: ${message}`);
    throw error;
  }
}
