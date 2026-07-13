import fs from "node:fs";
import path from "node:path";

import { coreDataPath } from "../data-layout.js";
import { normalizeSessionRef } from "../session/ref.js";

const RUNNING_WORKERS_FILE = "running-workers.json";

type RunningWorkerState = {
  schemaVersion: 1;
  sessionFiles: string[];
  requestTags?: Record<string, string>;
  frontendOwners?: Record<string, true>;
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

function readState(filePath: string): RunningWorkerState {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const rawSessionFiles = Array.isArray(parsed?.sessionFiles)
      ? parsed.sessionFiles
      : [];
    const rawRequestTags =
      parsed?.requestTags && typeof parsed.requestTags === "object"
        ? parsed.requestTags
        : {};
    const rawFrontendOwners =
      parsed?.frontendOwners && typeof parsed.frontendOwners === "object"
        ? parsed.frontendOwners
        : {};
    const seen = new Set<string>();
    const sessionFiles: string[] = [];
    const requestTags: Record<string, string> = {};
    const frontendOwners: Record<string, true> = {};
    for (const value of rawSessionFiles) {
      const sessionFile = normalizeSessionFile(value);
      if (!sessionFile || seen.has(sessionFile)) continue;
      seen.add(sessionFile);
      sessionFiles.push(sessionFile);
      const requestTag = rawRequestTags[sessionFile];
      if (typeof requestTag === "string" && requestTag.length > 0) {
        requestTags[sessionFile] = requestTag;
      }
      if (rawFrontendOwners[sessionFile] === true) {
        frontendOwners[sessionFile] = true;
      }
    }
    return {
      schemaVersion: 1,
      sessionFiles,
      ...(Object.keys(requestTags).length ? { requestTags } : {}),
      ...(Object.keys(frontendOwners).length ? { frontendOwners } : {}),
    };
  } catch {
    return { schemaVersion: 1, sessionFiles: [] };
  }
}

function writeState(filePath: string, state: RunningWorkerState) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, {
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
  const state = readState(filePath);
  const sessionFiles = state.sessionFiles.filter(
    (entry) => entry !== normalized,
  );
  const requestTags = { ...(state.requestTags || {}) };
  const frontendOwners = { ...(state.frontendOwners || {}) };
  if (running) {
    sessionFiles.push(normalized);
    if (typeof requestTag === "string" && requestTag.length > 0) {
      requestTags[normalized] = requestTag;
    } else {
      delete requestTags[normalized];
    }
    if (frontendOwner) {
      frontendOwners[normalized] = true;
    } else {
      delete frontendOwners[normalized];
    }
  } else {
    delete requestTags[normalized];
    delete frontendOwners[normalized];
  }
  writeState(filePath, {
    schemaVersion: 1,
    sessionFiles,
    ...(Object.keys(requestTags).length ? { requestTags } : {}),
    ...(Object.keys(frontendOwners).length ? { frontendOwners } : {}),
  });
}
