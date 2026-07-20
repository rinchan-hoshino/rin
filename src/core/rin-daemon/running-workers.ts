import fs from "node:fs";
import path from "node:path";

import { coreDataPath } from "../data-layout.js";
import { normalizeSessionRef } from "../session/ref.js";

const RUNNING_WORKERS_FILE = "running-workers.json";

type RunningWorkerState = {
  schemaVersion: 1;
  sessionFiles: string[];
  requestTags?: Record<string, string>;
  frontendOwners?: Record<string, boolean>;
};

export type RunningWorkerSession = {
  sessionFile: string;
  requestTag?: string;
  frontendOwner?: true;
};

export function runningWorkersStatePath(agentDir: string) {
  return coreDataPath(agentDir, "workers", RUNNING_WORKERS_FILE);
}

function normalizeSessionFile(value: unknown) {
  return normalizeSessionRef({ sessionFile: value }).sessionFile;
}

function normalizeState(parsed: any): RunningWorkerState {
  const rawSessionFiles = Array.isArray(parsed?.sessionFiles)
    ? parsed.sessionFiles
    : [];
  const rawRequestTags =
    parsed?.requestTags && typeof parsed.requestTags === "object"
      ? parsed.requestTags
      : {};
  const hasExplicitFrontendOwners = Boolean(
    parsed?.frontendOwners && typeof parsed.frontendOwners === "object",
  );
  const rawFrontendOwners = hasExplicitFrontendOwners
    ? parsed.frontendOwners
    : {};
  const seen = new Set<string>();
  const sessionFiles: string[] = [];
  const requestTags: Record<string, string> = {};
  const frontendOwners: Record<string, boolean> = {};
  for (const value of rawSessionFiles) {
    const sessionFile = normalizeSessionFile(value);
    if (!sessionFile || seen.has(sessionFile)) continue;
    seen.add(sessionFile);
    sessionFiles.push(sessionFile);
    const requestTag = rawRequestTags[sessionFile];
    if (typeof requestTag === "string" && requestTag.length > 0) {
      requestTags[sessionFile] = requestTag;
    }
    if (hasExplicitFrontendOwners) {
      frontendOwners[sessionFile] = rawFrontendOwners[sessionFile] === true;
    } else if (
      typeof requestTag === "string" &&
      requestTag.startsWith("chat-inbox-")
    ) {
      frontendOwners[sessionFile] = true;
    }
  }
  return {
    schemaVersion: 1,
    sessionFiles,
    ...(Object.keys(requestTags).length ? { requestTags } : {}),
    ...(Object.keys(frontendOwners).length ? { frontendOwners } : {}),
  };
}

function serializeState(state: RunningWorkerState) {
  return `${JSON.stringify(state, null, 2)}\n`;
}

function readStateSnapshot(filePath: string): {
  state: RunningWorkerState;
  serialized?: string;
} {
  try {
    const serialized = fs.readFileSync(filePath, "utf8");
    return { state: normalizeState(JSON.parse(serialized)), serialized };
  } catch {
    return { state: { schemaVersion: 1, sessionFiles: [] } };
  }
}

function readState(filePath: string): RunningWorkerState {
  return readStateSnapshot(filePath).state;
}

function writeState(filePath: string, state: RunningWorkerState) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, serializeState(state), {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tmpPath, filePath);
}

export function listRunningWorkerSessions(agentDir: string) {
  const state = readState(runningWorkersStatePath(agentDir));
  return state.sessionFiles.map((sessionFile) => ({
    sessionFile,
    ...(state.requestTags?.[sessionFile]
      ? { requestTag: state.requestTags[sessionFile] }
      : {}),
    ...(state.frontendOwners?.[sessionFile]
      ? { frontendOwner: true as const }
      : {}),
  }));
}

export function listRunningWorkerSessionFiles(agentDir: string) {
  return listRunningWorkerSessions(agentDir).map((item) => item.sessionFile);
}

export function setRunningWorkerSession(
  agentDir: string | undefined,
  sessionFile: string | undefined,
  running: boolean,
  requestTag?: string,
  frontendOwner = false,
) {
  if (!agentDir || !sessionFile) return;
  const filePath = runningWorkersStatePath(agentDir);
  const normalized = normalizeSessionFile(sessionFile);
  if (!normalized) return;
  const snapshot = readStateSnapshot(filePath);
  const state = snapshot.state;
  const sessionFiles = state.sessionFiles.includes(normalized)
    ? [...state.sessionFiles]
    : [...state.sessionFiles, normalized];
  const requestTags = { ...(state.requestTags || {}) };
  const frontendOwners = { ...(state.frontendOwners || {}) };
  if (running) {
    if (typeof requestTag === "string" && requestTag.length > 0) {
      requestTags[normalized] = requestTag;
    } else {
      delete requestTags[normalized];
    }
    if (
      frontendOwner ||
      requestTag?.startsWith("chat-inbox-") ||
      normalized in frontendOwners
    ) {
      frontendOwners[normalized] = frontendOwner;
    } else {
      delete frontendOwners[normalized];
    }
  } else {
    delete requestTags[normalized];
    delete frontendOwners[normalized];
  }
  const nextState: RunningWorkerState = {
    schemaVersion: 1,
    sessionFiles: running
      ? sessionFiles
      : sessionFiles.filter((entry) => entry !== normalized),
    ...(Object.keys(requestTags).length ? { requestTags } : {}),
    ...(Object.keys(frontendOwners).length ? { frontendOwners } : {}),
  };
  if (serializeState(nextState) === snapshot.serialized) return;
  writeState(filePath, nextState);
}
