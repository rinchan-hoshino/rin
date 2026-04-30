import os from "node:os";
import path from "node:path";

import { resolveRuntimeProfile } from "../rin-lib/profile.js";
import {
  getManagedSessionDir,
  MANAGED_SUBAGENT_SESSION_LEAF,
} from "../session/managed-paths.js";
import type { SubagentSessionConfig, SubagentSessionMode } from "./types.js";

const HOME_DIR = os.homedir();
const SESSION_FILE_TARGET_DESCRIPTION =
  "a sessionFile path relative to agentDir";

export const VALID_SUBAGENT_SESSION_MODES = [
  "memory",
  "persist",
  "resume",
  "fork",
] as const satisfies SubagentSessionMode[];

export type NormalizedSubagentSessionConfig = Required<
  Pick<SubagentSessionConfig, "mode">
> &
  SubagentSessionConfig & {
    invalidMode?: string;
  };

function normalizeSessionMode(value: unknown) {
  const mode = String(value || "")
    .trim()
    .toLowerCase();
  if (!mode) return { mode: "memory" as SubagentSessionMode };
  if ((VALID_SUBAGENT_SESSION_MODES as readonly string[]).includes(mode)) {
    return { mode: mode as SubagentSessionMode };
  }
  return {
    mode: "memory" as SubagentSessionMode,
    invalidMode: mode,
  };
}

function normalizeTrimmedText(value: unknown) {
  return String(value || "").trim();
}

function normalizeStoredSessionFile(value: unknown) {
  const text = normalizeTrimmedText(value);
  if (!text) return undefined;
  if (path.isAbsolute(text)) return path.resolve(text);
  const normalized = path.posix.normalize(text.replace(/\\+/g, "/"));
  const trimmed = normalized
    .replace(/^\/+/, "")
    .replace(/^(?:\.\/)+/, "")
    .trim();
  return trimmed && trimmed !== "." ? trimmed : undefined;
}

function isAgentRelativeSessionFile(value: string) {
  return Boolean(value) && !value.startsWith("..") && !path.isAbsolute(value);
}

function getSubagentSessionFileGuidanceText() {
  return `Inspect ${getDefaultSubagentSessionDir()} and use ${SESSION_FILE_TARGET_DESCRIPTION}.`;
}

export function normalizeSubagentSessionConfig(
  session: SubagentSessionConfig | undefined,
): NormalizedSubagentSessionConfig {
  const normalizedMode = normalizeSessionMode(session?.mode);
  return {
    ...normalizedMode,
    sessionFile: normalizeStoredSessionFile(session?.sessionFile),
    name: normalizeTrimmedText(session?.name) || undefined,
    keep: typeof session?.keep === "boolean" ? session.keep : undefined,
  };
}

export function resolveSubagentSessionFile(
  agentDir: string,
  value: unknown,
): string | undefined {
  const sessionFile = normalizeStoredSessionFile(value);
  if (!sessionFile) return undefined;
  if (path.isAbsolute(sessionFile)) return sessionFile;
  return path.resolve(agentDir, sessionFile);
}

export function toSubagentSessionFile(
  agentDir: string,
  value: unknown,
): string | undefined {
  const sessionFile = normalizeStoredSessionFile(value);
  if (!sessionFile) return undefined;
  if (!path.isAbsolute(sessionFile)) return sessionFile;
  const relative = path.relative(agentDir, sessionFile);
  if (!isAgentRelativeSessionFile(relative)) {
    return sessionFile;
  }
  return normalizeStoredSessionFile(relative);
}

export function getDefaultSubagentSessionDir() {
  const profile = resolveRuntimeProfile({ cwd: HOME_DIR });
  return getManagedSessionDir(profile.agentDir, MANAGED_SUBAGENT_SESSION_LEAF);
}

export function formatSubagentSessionFileRequiredError(
  mode: Extract<SubagentSessionMode, "resume" | "fork">,
): string {
  return `Session file is required when session.mode is ${mode}. ${getSubagentSessionFileGuidanceText()}`;
}

export function formatSubagentSessionFileNotFoundError(
  sessionFile: string,
): string {
  return `Session file not found: ${sessionFile}. ${getSubagentSessionFileGuidanceText()}`;
}

export function formatSubagentSessionFileHint(): string {
  return `Hint: inspect ${getDefaultSubagentSessionDir()} with bash/find/rg, then pass session.sessionFile as ${SESSION_FILE_TARGET_DESCRIPTION}.`;
}

export function formatSubagentSessionModeInvalidError(mode: string): string {
  return `Invalid session.mode: ${mode}. Allowed values: ${VALID_SUBAGENT_SESSION_MODES.join(", ")}.`;
}
