import fs from "node:fs";
import path from "node:path";

import { isJsonRecord } from "../json-utils.js";
import {
  ensurePrivateDir,
  readJsonFile,
  writeJsonAtomic,
} from "../platform/fs.js";
import { isPidAlive, sleep } from "../platform/process.js";

const LOCK_FILE_MODE = 0o600;
const INSTANCE_STATE_FILE = "state.json";
const LOCK_POLL_INTERVAL_MS = 100;

type ProcessLockState = {
  pid: number;
  ts?: number;
};

function removeFile(filePath: string) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {}
}

function readJsonRecord(filePath: string): Record<string, unknown> | null {
  const value = readJsonFile<unknown>(filePath, null);
  return isJsonRecord(value) ? value : null;
}

function normalizePid(value: unknown) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

function normalizeProcessLockState(
  state: Record<string, unknown> | null,
): ProcessLockState | null {
  if (!state) return null;
  const pid = normalizePid(state.pid);
  if (!pid) return null;
  const ts = Number(state.ts);
  return Number.isFinite(ts) ? { pid, ts } : { pid };
}

function readProcessLockState(lockPath: string): ProcessLockState | null {
  return normalizeProcessLockState(readJsonRecord(lockPath));
}

function createCurrentProcessLockState(): ProcessLockState {
  return { pid: process.pid, ts: Date.now() };
}

function tryAcquireProcessLock(lockPath: string) {
  const fd = fs.openSync(lockPath, "wx", LOCK_FILE_MODE);
  fs.writeFileSync(fd, JSON.stringify(createCurrentProcessLockState()));
  try {
    fs.closeSync(fd);
  } catch {}
  return () => removeFile(lockPath);
}

function isStaleProcessLock(lockPath: string) {
  const state = readProcessLockState(lockPath);
  return !state || !isPidAlive(state.pid);
}

export async function acquireProcessLock(lockPath: string, timeoutMs = 20_000) {
  ensurePrivateDir(path.dirname(lockPath));
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return tryAcquireProcessLock(lockPath);
    } catch {
      if (isStaleProcessLock(lockPath)) {
        removeFile(lockPath);
        continue;
      }
      await sleep(LOCK_POLL_INTERVAL_MS);
    }
  }
  throw new Error(`sidecar_lock_timeout:${lockPath}`);
}

export function listInstanceIds(instancesRoot: string) {
  try {
    return fs
      .readdirSync(instancesRoot, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          fs.existsSync(
            path.join(instancesRoot, entry.name, INSTANCE_STATE_FILE),
          ),
      )
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [] as string[];
  }
}

export function readInstanceState<T>(statePath: string) {
  return readJsonRecord(statePath) as T | null;
}

export function writeInstanceState(statePath: string, value: unknown) {
  writeJsonAtomic(statePath, value, LOCK_FILE_MODE, true);
}
