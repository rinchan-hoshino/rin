import { randomUUID } from "node:crypto";

import { asArray } from "../json-utils.js";
import { nowIso } from "../time-utils.js";

type ForkCapabilities = {
  legacy: boolean;
  optionAware: boolean;
};

function normalizeLeafId(value: unknown) {
  const leafId = String(value || "").trim();
  return leafId || undefined;
}

export const EPHEMERAL_FORK_DISABLE_ROUTINE_COMPACTION_KEY = Symbol.for(
  "rin.ephemeralFork.disableRoutineCompaction",
);

type ForkSessionOptions = {
  persist?: boolean;
  leafId?: string;
  preserveSourceSessionId?: boolean;
  disableRoutineCompaction?: boolean;
};

function normalizeForkOptions(options: ForkSessionOptions = {}) {
  const normalized: ForkSessionOptions & {
    persist: boolean;
    preserveSourceSessionId: boolean;
  } = {
    ...options,
    leafId: normalizeLeafId(options.leafId),
    persist: options.persist !== false,
    preserveSourceSessionId: options.preserveSourceSessionId === true,
  };
  if (options.disableRoutineCompaction === true) {
    normalized.disableRoutineCompaction = true;
  }
  return normalized;
}

function getForkCapabilities(SessionManager: any): ForkCapabilities {
  const legacy = typeof SessionManager?.forkFrom === "function";
  return {
    legacy,
    optionAware: legacy && SessionManager.forkFrom.length >= 4,
  };
}

function resolveForkEntries(sourceManager: any, leafId?: string) {
  const branchEntries = asArray(
    leafId ? sourceManager.getBranch?.(leafId) : undefined,
  );
  if (branchEntries.length > 0) return branchEntries;
  return asArray(sourceManager.getEntries?.());
}

function createEphemeralForkManager(
  SessionManager: any,
  sourcePath: string,
  targetCwd: string,
  sessionDir: string | undefined,
  leafId: string | undefined,
  preserveSourceSessionId: boolean,
  disableRoutineCompaction: boolean,
) {
  if (
    typeof SessionManager?.open !== "function" ||
    typeof SessionManager !== "function"
  ) {
    throw new Error("session_fork_unsupported:ephemeral");
  }

  const sourceManager = SessionManager.open(sourcePath, sessionDir, undefined);
  const sourceHeader = sourceManager.getHeader?.() || {};
  const sourceSessionId = String(
    sourceHeader?.id || sourceManager.getSessionId?.() || "",
  ).trim();
  const forkSessionId =
    preserveSourceSessionId && sourceSessionId ? sourceSessionId : randomUUID();
  const manager = new SessionManager(
    targetCwd,
    sessionDir || "",
    undefined,
    false,
  );
  manager.fileEntries = [
    {
      ...sourceHeader,
      type: "session",
      version: Number(sourceHeader?.version || 3),
      id: forkSessionId,
      timestamp: nowIso(),
      cwd: targetCwd,
      parentSession: sourcePath,
    },
    ...resolveForkEntries(sourceManager, leafId),
  ];
  manager.sessionId = forkSessionId;
  manager.sessionFile = undefined;
  manager.flushed = false;
  if (disableRoutineCompaction) {
    manager[EPHEMERAL_FORK_DISABLE_ROUTINE_COMPACTION_KEY] = true;
  }
  manager._buildIndex?.();
  return manager;
}

export function forkSessionManagerCompat(
  SessionManager: any,
  sourcePath: string,
  targetCwd: string,
  sessionDir?: string,
  options: ForkSessionOptions = {},
) {
  const normalizedOptions = normalizeForkOptions(options);
  const capabilities = getForkCapabilities(SessionManager);

  if (normalizedOptions.preserveSourceSessionId && normalizedOptions.persist) {
    throw new Error(
      "session_fork_unsupported:preserve_source_session_id_persisted",
    );
  }
  if (normalizedOptions.disableRoutineCompaction && normalizedOptions.persist) {
    throw new Error("session_fork_unsupported:disable_compaction_persisted");
  }

  if (
    capabilities.optionAware &&
    !normalizedOptions.preserveSourceSessionId &&
    !normalizedOptions.disableRoutineCompaction
  ) {
    return SessionManager.forkFrom(
      sourcePath,
      targetCwd,
      sessionDir,
      normalizedOptions,
    );
  }

  if (normalizedOptions.persist) {
    if (!capabilities.legacy) {
      throw new Error("session_fork_unsupported:persisted");
    }
    return SessionManager.forkFrom(sourcePath, targetCwd, sessionDir);
  }

  return createEphemeralForkManager(
    SessionManager,
    sourcePath,
    targetCwd,
    sessionDir,
    normalizedOptions.leafId,
    normalizedOptions.preserveSourceSessionId,
    normalizedOptions.disableRoutineCompaction === true,
  );
}
