import fs from "node:fs";
import path from "node:path";

import { normalizeSessionRef } from "../session/ref.js";

const RUNNING_WORKERS_FILE = "running-workers.json";

type RunningWorkerState = {
  schemaVersion: 1;
  sessionFiles: string[];
};

export function runningWorkersStatePath(agentDir: string) {
  return path.join(agentDir, "data", RUNNING_WORKERS_FILE);
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
    const seen = new Set<string>();
    const sessionFiles: string[] = [];
    for (const value of rawSessionFiles) {
      const sessionFile = normalizeSessionFile(value);
      if (!sessionFile || seen.has(sessionFile)) continue;
      seen.add(sessionFile);
      sessionFiles.push(sessionFile);
    }
    return { schemaVersion: 1, sessionFiles };
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

export function listRunningWorkerSessionFiles(agentDir: string) {
  return readState(runningWorkersStatePath(agentDir)).sessionFiles;
}

export function setRunningWorkerSession(
  agentDir: string | undefined,
  sessionFile: string | undefined,
  running: boolean,
) {
  if (!agentDir || !sessionFile) return;
  const filePath = runningWorkersStatePath(agentDir);
  const normalized = normalizeSessionFile(sessionFile);
  if (!normalized) return;
  const state = readState(filePath);
  const sessionFiles = state.sessionFiles.filter(
    (entry) => entry !== normalized,
  );
  if (running) sessionFiles.push(normalized);
  writeState(filePath, { schemaVersion: 1, sessionFiles });
}
