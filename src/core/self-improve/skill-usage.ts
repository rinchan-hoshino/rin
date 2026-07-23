import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

import lockfile from "proper-lockfile";

import { readSessionMetadata } from "../session/metadata.js";
import { safeString } from "./core/utils.js";
import { selfImproveSkillsDir, selfImproveStateDir } from "./paths.js";

export const SKILL_USAGE_STATS_FILE = "skill-usage.json";

export type SkillUsageSource =
  | "user"
  | "scheduled-task"
  | "self-improve"
  | "other"
  | "legacy";

type SkillUsageSourceEntry = {
  count: number;
  firstUsedAt: string;
  lastUsedAt: string;
};

type SkillUsageEntry = {
  name: string;
  count: number;
  firstUsedAt: string;
  lastUsedAt: string;
  bySource: Partial<Record<SkillUsageSource, SkillUsageSourceEntry>>;
  lastSessionId?: string;
  lastSessionFile?: string;
  lastPath?: string;
};

type SkillUsageRecovery = {
  recoveredAt: string;
  backupFile: string;
  reason: "trailing-content" | "invalid-json";
};

type SkillUsageStats = {
  version: 2;
  updatedAt: string;
  skills: Record<string, SkillUsageEntry>;
  recovery?: SkillUsageRecovery;
};

type ParsedSkillUsageStats = {
  stats: SkillUsageStats;
  recoveryReason?: SkillUsageRecovery["reason"];
};

const SKILL_USAGE_SOURCES = new Set<SkillUsageSource>([
  "user",
  "scheduled-task",
  "self-improve",
  "other",
  "legacy",
]);

class UnsupportedSkillUsageVersionError extends Error {}

const USER_PROMPT_SOURCES = new Set([
  "chat-bridge",
  "cli",
  "gui",
  "rpc",
  "tui",
  "user",
]);

function nowIso() {
  return new Date().toISOString();
}

function emptyStats(): SkillUsageStats {
  return { version: 2, updatedAt: "", skills: {} };
}

export function skillUsageStatsPath(agentDir: string): string {
  return path.join(selfImproveStateDir(agentDir), SKILL_USAGE_STATS_FILE);
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

function normalizeCount(value: unknown) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function earlierTimestamp(left: string, right: string) {
  if (!left) return right;
  if (!right) return left;
  return left <= right ? left : right;
}

function laterTimestamp(left: string, right: string) {
  if (!left) return right;
  if (!right) return left;
  return left >= right ? left : right;
}

function normalizeUsageSource(value: unknown): SkillUsageSource {
  const source = safeString(value).trim() as SkillUsageSource;
  return SKILL_USAGE_SOURCES.has(source) ? source : "other";
}

function normalizeSourceEntry(value: unknown): SkillUsageSourceEntry | null {
  if (!value || typeof value !== "object") return null;
  const count = normalizeCount((value as any).count);
  if (!count) return null;
  return {
    count,
    firstUsedAt: safeString((value as any).firstUsedAt).trim(),
    lastUsedAt: safeString((value as any).lastUsedAt).trim(),
  };
}

function normalizeSkillUsageEntry(
  name: string,
  value: unknown,
): SkillUsageEntry | null {
  const entry = value && typeof value === "object" ? (value as any) : {};
  const skillName = safeString(entry.name || name).trim();
  if (!skillName) return null;

  const bySource: Partial<Record<SkillUsageSource, SkillUsageSourceEntry>> = {};
  for (const [rawSource, rawSourceEntry] of Object.entries(
    entry.bySource || {},
  )) {
    const source = normalizeUsageSource(rawSource);
    const sourceEntry = normalizeSourceEntry(rawSourceEntry);
    if (!sourceEntry) continue;
    const previous = bySource[source];
    bySource[source] = previous
      ? {
          count: previous.count + sourceEntry.count,
          firstUsedAt: earlierTimestamp(
            previous.firstUsedAt,
            sourceEntry.firstUsedAt,
          ),
          lastUsedAt: laterTimestamp(
            previous.lastUsedAt,
            sourceEntry.lastUsedAt,
          ),
        }
      : sourceEntry;
  }

  const storedCount = normalizeCount(entry.count);
  const classifiedCount = Object.values(bySource).reduce(
    (total, sourceEntry) => total + (sourceEntry?.count || 0),
    0,
  );
  if (storedCount > classifiedCount) {
    const difference = storedCount - classifiedCount;
    const previous = bySource.legacy;
    bySource.legacy = {
      count: (previous?.count || 0) + difference,
      firstUsedAt:
        previous?.firstUsedAt || safeString(entry.firstUsedAt).trim(),
      lastUsedAt: previous?.lastUsedAt || safeString(entry.lastUsedAt).trim(),
    };
  }

  return {
    name: skillName,
    count: Math.max(storedCount, classifiedCount),
    firstUsedAt: safeString(entry.firstUsedAt).trim(),
    lastUsedAt: safeString(entry.lastUsedAt).trim(),
    bySource,
    lastSessionId: safeString(entry.lastSessionId).trim() || undefined,
    lastSessionFile: safeString(entry.lastSessionFile).trim() || undefined,
    lastPath: safeString(entry.lastPath).trim() || undefined,
  };
}

function normalizeStats(value: unknown): SkillUsageStats {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid skill usage statistics shape");
  }
  const parsed = value as any;
  if (parsed.version !== 1 && parsed.version !== 2) {
    throw new UnsupportedSkillUsageVersionError(
      `Unsupported skill usage statistics version: ${String(parsed.version)}`,
    );
  }
  if (
    parsed.skills !== undefined &&
    (!parsed.skills ||
      typeof parsed.skills !== "object" ||
      Array.isArray(parsed.skills))
  ) {
    throw new Error("Invalid skill usage statistics skills map");
  }
  const skills: Record<string, SkillUsageEntry> = {};
  for (const [name, entry] of Object.entries(parsed.skills || {})) {
    const normalized = normalizeSkillUsageEntry(name, entry);
    if (normalized) skills[normalized.name] = normalized;
  }
  const recovery = parsed.recovery;
  const recoveryReason = safeString(recovery?.reason).trim();
  return {
    version: 2,
    updatedAt: safeString(parsed.updatedAt).trim(),
    skills,
    ...(recovery &&
    (recoveryReason === "trailing-content" || recoveryReason === "invalid-json")
      ? {
          recovery: {
            recoveredAt: safeString(recovery.recoveredAt).trim(),
            backupFile: safeString(recovery.backupFile).trim(),
            reason: recoveryReason,
          },
        }
      : {}),
  };
}

function firstJsonObject(raw: string) {
  const start = raw.indexOf("{");
  if (start < 0) return "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const character = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return raw.slice(start, index + 1);
    }
  }
  return "";
}

function parseStatsText(raw: string): ParsedSkillUsageStats {
  try {
    const parsed = JSON.parse(raw);
    return { stats: normalizeStats(parsed) };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }

  const prefix = firstJsonObject(raw);
  if (prefix) {
    try {
      const parsed = JSON.parse(prefix);
      return {
        stats: normalizeStats(parsed),
        recoveryReason: "trailing-content",
      };
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  throw new Error("Invalid skill usage statistics JSON");
}

export function readSkillUsageStats(agentDir: string): SkillUsageStats {
  const filePath = skillUsageStatsPath(agentDir);
  try {
    const parsed = parseStatsText(fsSync.readFileSync(filePath, "utf8"));
    if (parsed.recoveryReason) {
      throw new Error(
        `Damaged skill usage statistics: ${parsed.recoveryReason}`,
      );
    }
    return parsed.stats;
  } catch (error: any) {
    if (error?.code === "ENOENT") return emptyStats();
    if (error instanceof UnsupportedSkillUsageVersionError) throw error;
    throw new Error(`Skill usage statistics are corrupt: ${filePath}`, {
      cause: error,
    });
  }
}

function skillUsageLockOptions() {
  return {
    realpath: false,
    stale: 60_000,
    update: 10_000,
    retries: {
      retries: 200,
      factor: 1.1,
      minTimeout: 10,
      maxTimeout: 100,
    },
  } as const;
}

async function backupDamagedLedger(
  filePath: string,
  raw: string,
  reason: SkillUsageRecovery["reason"],
): Promise<SkillUsageRecovery> {
  const recoveredAt = nowIso();
  const backupFile = `${path.basename(filePath)}.corrupt-${recoveredAt.replace(/[:.]/g, "-")}-${randomUUID()}.bak`;
  await fs.writeFile(path.join(path.dirname(filePath), backupFile), raw, {
    encoding: "utf8",
    flag: "wx",
  });
  return { recoveredAt, backupFile, reason };
}

async function readStatsForUpdate(filePath: string): Promise<SkillUsageStats> {
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return emptyStats();
    throw error;
  }

  let parsed: ParsedSkillUsageStats;
  try {
    parsed = parseStatsText(raw);
  } catch (error) {
    if (error instanceof UnsupportedSkillUsageVersionError) throw error;
    return {
      ...emptyStats(),
      recovery: await backupDamagedLedger(filePath, raw, "invalid-json"),
    };
  }
  if (!parsed.recoveryReason) return parsed.stats;
  return {
    ...parsed.stats,
    recovery: await backupDamagedLedger(filePath, raw, parsed.recoveryReason),
  };
}

async function writeSkillUsageStats(filePath: string, stats: SkillUsageStats) {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(stats, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

export async function recordSelfImproveSkillUsage(options: {
  agentDir: string;
  skillName: string;
  skillPath?: string;
  sessionId?: string;
  sessionFile?: string;
  timestamp?: string;
  usageSource?: SkillUsageSource;
}) {
  const skillName = safeString(options.skillName).trim();
  const agentDir = safeString(options.agentDir).trim();
  if (!agentDir || !skillName) return;
  const timestamp = safeString(options.timestamp).trim() || nowIso();
  const source = normalizeUsageSource(options.usageSource || "other");
  const filePath = skillUsageStatsPath(agentDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const release = await lockfile.lock(filePath, skillUsageLockOptions());
  try {
    const stats = await readStatsForUpdate(filePath);
    const previous = stats.skills[skillName];
    const previousSource = previous?.bySource[source];
    const newestUse = !previous?.lastUsedAt || timestamp >= previous.lastUsedAt;
    stats.skills[skillName] = {
      name: skillName,
      count: (previous?.count || 0) + 1,
      firstUsedAt: earlierTimestamp(previous?.firstUsedAt || "", timestamp),
      lastUsedAt: laterTimestamp(previous?.lastUsedAt || "", timestamp),
      bySource: {
        ...(previous?.bySource || {}),
        [source]: {
          count: (previousSource?.count || 0) + 1,
          firstUsedAt: earlierTimestamp(
            previousSource?.firstUsedAt || "",
            timestamp,
          ),
          lastUsedAt: laterTimestamp(
            previousSource?.lastUsedAt || "",
            timestamp,
          ),
        },
      },
      lastSessionId:
        newestUse && safeString(options.sessionId).trim()
          ? safeString(options.sessionId).trim()
          : previous?.lastSessionId,
      lastSessionFile:
        newestUse && safeString(options.sessionFile).trim()
          ? safeString(options.sessionFile).trim()
          : previous?.lastSessionFile,
      lastPath:
        newestUse && safeString(options.skillPath).trim()
          ? safeString(options.skillPath).trim()
          : previous?.lastPath,
    };
    stats.updatedAt = laterTimestamp(stats.updatedAt, timestamp);
    await writeSkillUsageStats(filePath, stats);
  } finally {
    await release();
  }
}

function promptSource(event: any, ctx: any) {
  return safeString(
    event?.source ?? ctx?.source ?? ctx?.sessionManager?.__rinLastPromptSource,
  )
    .trim()
    .toLowerCase();
}

function promptContext(event: any, ctx: any) {
  return (
    event?.promptContext ??
    ctx?.promptContext ??
    ctx?.sessionManager?.__rinLastPromptContext
  );
}

export function detectSkillUsageSource(
  event: unknown,
  ctx: unknown,
): SkillUsageSource {
  const source = promptSource(event as any, ctx as any);
  const context = promptContext(event as any, ctx as any) as any;
  const contextSource = safeString(context?.source).trim().toLowerCase();
  const contextKind = safeString(context?.taskContextKind).trim().toLowerCase();
  if (source === "builtin:self-improve" || contextSource === "self-improve") {
    return "self-improve";
  }
  if (
    source === "scheduled-task" ||
    contextSource === "scheduled-task" ||
    contextKind === "scheduled-task"
  ) {
    return "scheduled-task";
  }
  return USER_PROMPT_SOURCES.has(source) ||
    USER_PROMPT_SOURCES.has(contextSource)
    ? "user"
    : "other";
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
    usageSource: detectSkillUsageSource(event, ctx),
  });
}
