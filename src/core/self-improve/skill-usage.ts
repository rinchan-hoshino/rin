import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

import { readSessionMetadata } from "../session/metadata.js";
import { safeString } from "./core/utils.js";
import { selfImproveSkillsDir, selfImproveStateDir } from "./paths.js";

export const SKILL_USAGE_STATS_FILE = "skill-usage.json";

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
  version: 1;
  updatedAt: string;
  skills: Record<string, SkillUsageEntry>;
};

function nowIso() {
  return new Date().toISOString();
}

function emptyStats(): SkillUsageStats {
  return { version: 1, updatedAt: "", skills: {} };
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

export function readSkillUsageStats(agentDir: string): SkillUsageStats {
  const filePath = skillUsageStatsPath(agentDir);
  try {
    const parsed = JSON.parse(fsSync.readFileSync(filePath, "utf8"));
    const skills: Record<string, SkillUsageEntry> = {};
    for (const [name, entry] of Object.entries(parsed?.skills || {})) {
      const skillName = safeString((entry as any)?.name || name).trim();
      if (!skillName) continue;
      skills[skillName] = {
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
    return {
      version: 1,
      updatedAt: safeString(parsed?.updatedAt).trim(),
      skills,
    };
  } catch {
    return emptyStats();
  }
}

async function writeSkillUsageStats(agentDir: string, stats: SkillUsageStats) {
  const filePath = skillUsageStatsPath(agentDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(
    `${tempPath}`,
    `${JSON.stringify(stats, null, 2)}\n`,
    "utf8",
  );
  await fs.rename(tempPath, filePath);
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
  const timestamp = safeString(options.timestamp).trim() || nowIso();
  const stats = readSkillUsageStats(agentDir);
  const previous = stats.skills[skillName];
  stats.skills[skillName] = {
    name: skillName,
    count: (previous?.count || 0) + 1,
    firstUsedAt: previous?.firstUsedAt || timestamp,
    lastUsedAt: timestamp,
    lastSessionId:
      safeString(options.sessionId).trim() || previous?.lastSessionId,
    lastSessionFile:
      safeString(options.sessionFile).trim() || previous?.lastSessionFile,
    lastPath: safeString(options.skillPath).trim() || previous?.lastPath,
  };
  stats.updatedAt = timestamp;
  await writeSkillUsageStats(agentDir, stats);
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
