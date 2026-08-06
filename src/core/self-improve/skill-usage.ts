import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

import lockfile from "proper-lockfile";

import { appendJsonLine, writeJsonAtomic } from "../platform/fs.js";
import { readSessionMetadata } from "../session/metadata.js";
import { safeString } from "./core/utils.js";
import { selfImproveSkillsDir, selfImproveStateDir } from "./paths.js";

export const SKILL_USAGE_STATS_FILE = "skill-usage.json";
export const SKILL_USAGE_EVENTS_FILE = "skill-usage-events.jsonl";

type SkillUsageEntry = {
  name: string;
  count: number;
  firstUsedAt: string;
  lastUsedAt: string;
  lastSessionId?: string;
  lastSessionFile?: string;
  lastPath?: string;
};

type SkillUsageStats = {
  version: 2;
  startedAt: string;
  updatedAt: string;
  skills: Record<string, SkillUsageEntry>;
};

type SkillUsageEvent = {
  version: 1;
  kind?: "read";
  timestamp: string;
  name: string;
  sessionId?: string;
  sessionFile?: string;
  path?: string;
};

type SkillUsageSnapshotEvent = {
  version: 1;
  kind: "snapshot";
  timestamp: string;
  stats: SkillUsageStats;
};

function nowIso() {
  return new Date().toISOString();
}

function emptyStats(): SkillUsageStats {
  return { version: 2, startedAt: "", updatedAt: "", skills: {} };
}

export function skillUsageStatsPath(agentDir: string): string {
  return path.join(selfImproveStateDir(agentDir), SKILL_USAGE_STATS_FILE);
}

export function skillUsageEventsPath(agentDir: string): string {
  return path.join(selfImproveStateDir(agentDir), SKILL_USAGE_EVENTS_FILE);
}

function isInside(root: string, target: string) {
  const relative = path.relative(root, target);
  return (
    Boolean(relative) &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

function normalizeReadPath(cwd: string, value: unknown) {
  const text = safeString(value).trim();
  if (!text) return "";
  return path.resolve(
    path.isAbsolute(text) ? text : path.join(cwd || process.cwd(), text),
  );
}

export function detectSelfImproveSkillRead(options: {
  agentDir: string;
  cwd?: string;
  args?: unknown;
}): { skillName: string; skillPath: string } | null {
  const args =
    options.args && typeof options.args === "object"
      ? (options.args as any)
      : {};
  const readPath = normalizeReadPath(safeString(options.cwd).trim(), args.path);
  if (!readPath) return null;
  const skillsRoot = path.resolve(selfImproveSkillsDir(options.agentDir));
  if (!isInside(skillsRoot, readPath)) return null;
  const parts = path
    .relative(skillsRoot, readPath)
    .split(path.sep)
    .filter(Boolean);
  const skillName = safeString(parts[0]).trim();
  if (!skillName) return null;
  return { skillName, skillPath: readPath };
}

function normalizeStats(parsed: any): SkillUsageStats {
  const stats = emptyStats();
  for (const [name, entry] of Object.entries(parsed?.skills || {})) {
    const skillName = safeString((entry as any)?.name || name).trim();
    if (!skillName) continue;
    stats.skills[skillName] = {
      name: skillName,
      count: Math.max(0, Math.floor(Number((entry as any)?.count) || 0)),
      firstUsedAt: safeString((entry as any)?.firstUsedAt).trim(),
      lastUsedAt: safeString((entry as any)?.lastUsedAt).trim(),
      lastSessionId:
        safeString((entry as any)?.lastSessionId).trim() || undefined,
      lastSessionFile:
        safeString((entry as any)?.lastSessionFile).trim() || undefined,
      lastPath: safeString((entry as any)?.lastPath).trim() || undefined,
    };
  }
  const firstUses = Object.values(stats.skills)
    .map((entry) => entry.firstUsedAt)
    .filter(Boolean)
    .sort();
  const lastUses = Object.values(stats.skills)
    .map((entry) => entry.lastUsedAt)
    .filter(Boolean)
    .sort();
  stats.startedAt = safeString(parsed?.startedAt).trim() || firstUses[0] || "";
  stats.updatedAt =
    safeString(parsed?.updatedAt).trim() || lastUses.at(-1) || stats.startedAt;
  return stats;
}

function readAggregate(agentDir: string): SkillUsageStats | null {
  try {
    return normalizeStats(
      JSON.parse(fsSync.readFileSync(skillUsageStatsPath(agentDir), "utf8")),
    );
  } catch {
    return null;
  }
}

function applyEvent(stats: SkillUsageStats, event: SkillUsageEvent) {
  const previous = stats.skills[event.name];
  stats.skills[event.name] = {
    name: event.name,
    count: (previous?.count || 0) + 1,
    firstUsedAt: previous?.firstUsedAt || event.timestamp,
    lastUsedAt: event.timestamp,
    lastSessionId: event.sessionId || previous?.lastSessionId,
    lastSessionFile: event.sessionFile || previous?.lastSessionFile,
    lastPath: event.path || previous?.lastPath,
  };
  stats.startedAt = stats.startedAt || event.timestamp;
  stats.updatedAt = event.timestamp;
}

function rebuildFromEvents(agentDir: string): SkillUsageStats {
  let stats = emptyStats();
  let text = "";
  try {
    text = fsSync.readFileSync(skillUsageEventsPath(agentDir), "utf8");
  } catch {
    return stats;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.kind === "snapshot" && parsed?.stats) {
        stats = normalizeStats(parsed.stats);
        continue;
      }
      const timestamp = safeString(parsed?.timestamp).trim();
      const name = safeString(parsed?.name).trim();
      if (!timestamp || !name) continue;
      applyEvent(stats, {
        version: 1,
        kind: "read",
        timestamp,
        name,
        sessionId: safeString(parsed?.sessionId).trim() || undefined,
        sessionFile: safeString(parsed?.sessionFile).trim() || undefined,
        path: safeString(parsed?.path).trim() || undefined,
      });
    } catch {}
  }
  return stats;
}

function hasUsageEvents(agentDir: string): boolean {
  try {
    return fsSync.statSync(skillUsageEventsPath(agentDir)).size > 0;
  } catch {
    return false;
  }
}

export function readSkillUsageStats(agentDir: string): SkillUsageStats {
  return readAggregate(agentDir) || rebuildFromEvents(agentDir);
}

async function withUsageMutationLock<T>(
  agentDir: string,
  action: () => Promise<T>,
): Promise<T> {
  const stateDir = selfImproveStateDir(agentDir);
  await fs.mkdir(stateDir, { recursive: true });
  const release = await lockfile.lock(stateDir, {
    realpath: false,
    lockfilePath: `${skillUsageStatsPath(agentDir)}.mutation-lock`,
    stale: 60_000,
    update: 10_000,
    retries: {
      retries: 100,
      factor: 1.2,
      minTimeout: 5,
      maxTimeout: 50,
      randomize: true,
    },
  });
  try {
    return await action();
  } finally {
    await release();
  }
}

export async function recordSelfImproveSkillUsage(options: {
  agentDir: string;
  skillName: string;
  skillPath?: string;
  sessionId?: string;
  sessionFile?: string;
  timestamp?: string;
}) {
  const skillName = safeString(options.skillName).trim();
  const agentDir = safeString(options.agentDir).trim();
  if (!agentDir || !skillName) return;
  const event: SkillUsageEvent = {
    version: 1,
    kind: "read",
    timestamp: safeString(options.timestamp).trim() || nowIso(),
    name: skillName,
    sessionId: safeString(options.sessionId).trim() || undefined,
    sessionFile: safeString(options.sessionFile).trim() || undefined,
    path: safeString(options.skillPath).trim() || undefined,
  };

  await withUsageMutationLock(agentDir, async () => {
    const existing = readAggregate(agentDir);
    if (
      existing &&
      !hasUsageEvents(agentDir) &&
      Object.keys(existing.skills).length > 0
    ) {
      const snapshot: SkillUsageSnapshotEvent = {
        version: 1,
        kind: "snapshot",
        timestamp: existing.updatedAt || event.timestamp,
        stats: existing,
      };
      await appendJsonLine(skillUsageEventsPath(agentDir), snapshot);
    }
    await appendJsonLine(skillUsageEventsPath(agentDir), event);
    const stats = existing || rebuildFromEvents(agentDir);
    if (existing) applyEvent(stats, event);
    writeJsonAtomic(skillUsageStatsPath(agentDir), stats);
  });
}

export async function recordSelfImproveSkillReadEvent(
  event: unknown,
  ctx: unknown,
) {
  const toolName = safeString((event as any)?.toolName).trim();
  if (toolName !== "read") return;
  const agentDir = safeString((ctx as any)?.agentDir).trim();
  if (!agentDir) return;
  const match = detectSelfImproveSkillRead({
    agentDir,
    cwd: safeString((ctx as any)?.cwd).trim(),
    args: (event as any)?.args,
  });
  if (!match) return;
  const meta = readSessionMetadata(ctx);
  await recordSelfImproveSkillUsage({
    agentDir,
    skillName: match.skillName,
    skillPath: match.skillPath,
    sessionId: meta.sessionId,
    sessionFile: meta.sessionFile,
  });
}
