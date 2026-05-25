import path from "node:path";
import fssync from "node:fs";

import { getRuntimeSessionDir } from "../rin-lib/profile.js";
import { safeString } from "../text-utils.js";

export type SessionRef = {
  sessionId?: string;
  sessionFile?: string;
};

export type SessionRefInput = {
  sessionId?: unknown;
  sessionFile?: unknown;
  sessionPath?: unknown;
};

export type SessionFileInput = string | SessionRefInput;

export function normalizeSessionValue(value: unknown) {
  const text = safeString(value).trim();
  return text || undefined;
}

export function resolveSessionValue(primary: unknown, fallback?: unknown) {
  return normalizeSessionValue(primary) ?? normalizeSessionValue(fallback);
}

function getAgentSessionDir(agentDir: string) {
  return getRuntimeSessionDir(process.cwd(), agentDir);
}

function normalizeStoredSessionPath(value: string) {
  const normalized = path.posix.normalize(
    String(value || "")
      .replace(/\\+/g, "/")
      .trim(),
  );
  const trimmed = normalized
    .replace(/^\/+/, "")
    .replace(/^(?:\.\/)+/, "")
    .trim();
  return trimmed && trimmed !== "." ? trimmed : undefined;
}

function isSessionDirRelativePath(value: string) {
  return Boolean(value) && !value.startsWith("..") && !path.isAbsolute(value);
}

export function toStoredSessionFile(agentDir: string, value: unknown) {
  const sessionFile = normalizeSessionValue(value);
  if (!sessionFile) return undefined;
  if (!path.isAbsolute(sessionFile)) {
    return normalizeStoredSessionPath(sessionFile);
  }
  const sessionDir = getAgentSessionDir(agentDir);
  const resolvedSessionFile = path.resolve(sessionFile);
  const relative = path.relative(sessionDir, resolvedSessionFile);
  if (!isSessionDirRelativePath(relative)) {
    return resolvedSessionFile;
  }
  return normalizeStoredSessionPath(relative);
}

export function resolveStoredSessionFile(agentDir: string, value: unknown) {
  const sessionFile = normalizeSessionValue(value);
  if (!sessionFile) return undefined;
  if (path.isAbsolute(sessionFile)) return path.resolve(sessionFile);
  const relative = normalizeStoredSessionPath(sessionFile);
  if (!relative) return undefined;
  return path.resolve(getAgentSessionDir(agentDir), relative);
}

export function normalizeSessionRef(
  value: SessionRefInput | null | undefined,
): SessionRef {
  return {
    sessionId: normalizeSessionValue(value?.sessionId),
    sessionFile: resolveSessionValue(value?.sessionFile, value?.sessionPath),
  };
}

export function hasSessionRef(value: SessionRefInput | null | undefined) {
  const ref = normalizeSessionRef(value);
  return Boolean(ref.sessionFile || ref.sessionId);
}

export function readSessionFile(
  value: SessionFileInput | null | undefined,
): string | undefined {
  if (typeof value === "string") return normalizeSessionValue(value);
  return normalizeSessionRef(value).sessionFile;
}

export function requireSessionFile(
  value: SessionFileInput | null | undefined,
  error = "Session file is required",
): string {
  const sessionFile = readSessionFile(value);
  if (sessionFile) return sessionFile;
  throw new Error(error);
}

export function sessionFileExists(sessionFile: unknown) {
  const normalized = normalizeSessionValue(sessionFile);
  return Boolean(normalized && fssync.existsSync(normalized));
}

export function missingSessionFileError(sessionFile: unknown) {
  const normalized =
    normalizeSessionValue(sessionFile) || "the selected session";
  return new Error(
    `Session record is missing or expired: ${normalized}. Start a new session instead.`,
  );
}

export function requireExistingSessionFile(
  value: SessionFileInput | null | undefined,
): string {
  const sessionFile = requireSessionFile(value);
  if (sessionFileExists(sessionFile)) return sessionFile;
  throw missingSessionFileError(sessionFile);
}

export function resolveSessionRef(
  primary: SessionRefInput | null | undefined,
  fallback: SessionRefInput | null | undefined,
): SessionRef {
  const primaryRef = normalizeSessionRef(primary);
  const fallbackRef = normalizeSessionRef(fallback);
  return {
    sessionId: primaryRef.sessionId ?? fallbackRef.sessionId,
    sessionFile: primaryRef.sessionFile ?? fallbackRef.sessionFile,
  };
}

export function sessionRefMatches(
  current: SessionRefInput | null | undefined,
  selector: SessionRefInput | null | undefined,
) {
  const currentRef = normalizeSessionRef(current);
  const selectorRef = normalizeSessionRef(selector);
  if (!hasSessionRef(selectorRef)) return false;
  if (
    selectorRef.sessionFile &&
    currentRef.sessionFile !== selectorRef.sessionFile
  ) {
    return false;
  }
  if (selectorRef.sessionId && currentRef.sessionId !== selectorRef.sessionId) {
    return false;
  }
  return true;
}
