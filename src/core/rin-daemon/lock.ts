import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { coreDataPath } from "../data-layout.js";

import { ensureDir } from "../platform/fs.js";
import { sleep } from "../platform/process.js";
import { nowIso } from "../time-utils.js";

const LOCK_DIR_NAME = "daemon.lock";
const OWNER_FILE_NAME = "owner.json";
const PENDING_OWNER_GRACE_MS = 5_000;
const LOCK_RETRY_DELAY_MS = 50;

type DaemonLockOwner = {
  pid?: number;
  processStartTime?: string;
  token?: string;
  createdAt?: string;
  agentDir?: string;
  socketPath?: string;
  argv?: string[];
};

export type DaemonInstanceLock = {
  lockDir: string;
  ownerPath: string;
  token: string;
  release: () => Promise<void>;
};

export function daemonInstanceLockPath(agentDir: string) {
  return coreDataPath(agentDir, "daemon", LOCK_DIR_NAME);
}

function daemonInstanceLockOwnerPath(lockDir: string) {
  return path.join(lockDir, OWNER_FILE_NAME);
}

function readLockOwner(lockDir: string): DaemonLockOwner | null {
  try {
    const owner = JSON.parse(
      fs.readFileSync(daemonInstanceLockOwnerPath(lockDir), "utf8"),
    );
    return owner && typeof owner === "object" ? owner : null;
  } catch {
    return null;
  }
}

function writeLockOwner(lockDir: string, owner: DaemonLockOwner) {
  fs.writeFileSync(
    daemonInstanceLockOwnerPath(lockDir),
    `${JSON.stringify(owner, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function lockAgeMs(lockDir: string) {
  try {
    return Date.now() - fs.statSync(lockDir).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function linuxProcessStartTime(pid: number) {
  if (process.platform !== "linux") return "";
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fieldsAfterCommand = stat.slice(stat.lastIndexOf(")") + 2).trim();
    const fields = fieldsAfterCommand.split(/\s+/);
    return fields[19] || "";
  } catch {
    return "";
  }
}

function currentProcessStartTime() {
  return linuxProcessStartTime(process.pid);
}

function isProcessRunning(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

function isLockOwnerAlive(owner: DaemonLockOwner | null) {
  const pid = Number(owner?.pid || 0);
  if (!isProcessRunning(pid)) return false;
  const expectedStartTime = String(owner?.processStartTime || "").trim();
  const actualStartTime = linuxProcessStartTime(pid);
  if (
    expectedStartTime &&
    actualStartTime &&
    expectedStartTime !== actualStartTime
  ) {
    return false;
  }
  return true;
}

function formatAlreadyRunningError(owner: DaemonLockOwner, lockDir: string) {
  const parts = [
    "rin_daemon_already_running: another rin daemon is already running",
  ];
  if (owner?.pid) parts.push(`pid=${owner.pid}`);
  if (owner?.createdAt) parts.push(`createdAt=${owner.createdAt}`);
  if (owner?.socketPath) parts.push(`socket=${owner.socketPath}`);
  parts.push(`lock=${lockDir}`);
  return parts.join(" ");
}

function ownerTokenMatches(ownerPath: string, token: string) {
  try {
    const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    return owner?.pid === process.pid && owner?.token === token;
  } catch {
    return false;
  }
}

export async function acquireDaemonInstanceLock(
  agentDir: string,
  options: { socketPath?: string } = {},
): Promise<DaemonInstanceLock> {
  const lockDir = daemonInstanceLockPath(agentDir);
  const ownerPath = daemonInstanceLockOwnerPath(lockDir);
  ensureDir(path.dirname(lockDir));

  const pendingOwnerDeadline = Date.now() + PENDING_OWNER_GRACE_MS;
  while (true) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      break;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const owner = readLockOwner(lockDir);
      if (isLockOwnerAlive(owner)) {
        throw new Error(formatAlreadyRunningError(owner || {}, lockDir));
      }
      if (
        !owner &&
        Date.now() < pendingOwnerDeadline &&
        lockAgeMs(lockDir) < PENDING_OWNER_GRACE_MS
      ) {
        await sleep(LOCK_RETRY_DELAY_MS);
        continue;
      }
      try {
        fs.rmSync(lockDir, { recursive: true, force: true });
      } catch {}
    }
  }

  const token = randomUUID();
  const owner: DaemonLockOwner = {
    pid: process.pid,
    processStartTime: currentProcessStartTime(),
    token,
    createdAt: nowIso(),
    agentDir,
    socketPath: options.socketPath,
    argv: process.argv.slice(0, 8),
  };

  try {
    writeLockOwner(lockDir, owner);
  } catch (error) {
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {}
    throw error;
  }

  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    if (!ownerTokenMatches(ownerPath, token)) return;
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {}
  };

  return { lockDir, ownerPath, token, release };
}
