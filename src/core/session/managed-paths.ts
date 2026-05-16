import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { getRuntimeSessionDir } from "../rin-lib/profile.js";
import { nowFileTimestamp } from "../time-utils.js";
import { safeString } from "../text-utils.js";

const HOME_DIR = os.homedir();

export const MANAGED_CHAT_SESSION_LEAF = "chat";
export const MANAGED_TASK_SESSION_LEAF = "task";
export const MANAGED_CLI_SESSION_LEAF = "cli";

function sanitizeManagedSessionBasename(value: unknown, fallback: string) {
  const normalized = safeString(value)
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, "_")
    .replace(/^[_./:-]+|[_./:-]+$/g, "");
  return normalized || fallback;
}

export function normalizeManagedSessionLeaf(value: unknown) {
  return sanitizeManagedSessionBasename(value, "session");
}

export function getManagedSessionRoot(agentDir: string) {
  return path.join(getRuntimeSessionDir(HOME_DIR, agentDir), "managed");
}

export function getManagedSessionDir(agentDir: string, leaf: unknown) {
  return path.join(
    getManagedSessionRoot(agentDir),
    normalizeManagedSessionLeaf(leaf),
  );
}

export function getManagedTaskSessionDir(agentDir: string) {
  return getManagedSessionDir(agentDir, MANAGED_TASK_SESSION_LEAF);
}

export function getManagedTaskSessionFile(agentDir: string, taskId: unknown) {
  const basename = sanitizeManagedSessionBasename(taskId, "task").replace(
    /:/g,
    "_",
  );
  return path.join(getManagedTaskSessionDir(agentDir), `${basename}.jsonl`);
}

export function getManagedChatSessionDir(agentDir: string) {
  return getManagedSessionDir(agentDir, MANAGED_CHAT_SESSION_LEAF);
}

export function getManagedSessionSearchDirs(agentDir: string) {
  return [
    getRuntimeSessionDir(HOME_DIR, agentDir),
    getManagedChatSessionDir(agentDir),
    getManagedTaskSessionDir(agentDir),
    getManagedSessionDir(agentDir, MANAGED_CLI_SESSION_LEAF),
  ];
}

export function getManagedSessionFile(
  agentDir: string,
  leaf: unknown,
  name: unknown = leaf,
) {
  const timestamp = nowFileTimestamp();
  const basename = sanitizeManagedSessionBasename(name, "session").replace(
    /:/g,
    "_",
  );
  const suffix = randomUUID().slice(0, 8);
  return path.join(
    getManagedSessionDir(agentDir, leaf),
    `${timestamp}_${basename}_${suffix}.jsonl`,
  );
}
