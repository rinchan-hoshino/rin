import fs from "node:fs";
import path from "node:path";

import { isJsonRecord } from "../json-utils.js";
import { readJsonFile, writeJsonAtomic } from "../platform/fs.js";

const LOCK_FILE_MODE = 0o600;
const INSTANCE_STATE_FILE = "state.json";

function readJsonRecord(filePath: string): Record<string, unknown> | null {
  const value = readJsonFile<unknown>(filePath, null);
  return isJsonRecord(value) ? value : null;
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
