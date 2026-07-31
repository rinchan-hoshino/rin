import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import BetterSqlite3 from "better-sqlite3";

const LOCK_DIR_NAME = "daemon.lock";
const UPDATE_FENCE_DIR_NAME = "update.lock";
const LOCK_OWNER_FILE = "owner.json";

export type DaemonLockPurpose = "daemon" | "migration" | "update";

export interface DaemonLockOwner {
  pid: number;
  token: string;
  createdAt: string;
  processStartTime?: string;
  purpose?: DaemonLockPurpose;
  agentDir?: string;
  socketPath?: string;
  argv?: string[];
}

export interface DaemonInstanceLock {
  lockDir: string;
  ownerPath: string;
  token: string;
  owner: DaemonLockOwner;
  release(): Promise<void>;
}

interface DatabaseLease {
  close(): void;
}

export function daemonInstanceLockPath(agentDir: string) {
  return path.join(agentDir, "core", "data", "daemon", LOCK_DIR_NAME);
}

export function daemonUpdateFencePath(
  agentDir: string,
  options: { socketPath?: string } = {},
) {
  const socketPath = String(options.socketPath || "");
  if (socketPath && !socketPath.startsWith("\\\\.\\pipe\\")) {
    return path.join(path.dirname(socketPath), UPDATE_FENCE_DIR_NAME);
  }
  return path.join(agentDir, "core", "data", "daemon", UPDATE_FENCE_DIR_NAME);
}

function lockOwnerPath(lockDir: string) {
  return path.join(lockDir, LOCK_OWNER_FILE);
}

function lockDatabasePath(lockDir: string) {
  return `${lockDir}.sqlite`;
}

async function readProcStartTime(pid: number) {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return undefined;
    const tail = stat
      .slice(closeParen + 2)
      .trim()
      .split(/\s+/);
    return tail[19] || undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

async function ownerProcessIsAlive(owner: DaemonLockOwner) {
  if (!isProcessAlive(owner.pid)) return false;
  if (!owner.processStartTime) return true;
  const currentStartTime = await readProcStartTime(owner.pid);
  return !currentStartTime || currentStartTime === owner.processStartTime;
}

function parseLockOwner(raw: string) {
  try {
    const parsed = JSON.parse(raw);
    if (
      !Number.isInteger(parsed?.pid) ||
      typeof parsed?.token !== "string" ||
      !parsed.token
    ) {
      return null;
    }
    return parsed as DaemonLockOwner;
  } catch {
    return null;
  }
}

function readLockOwnerSync(lockDir: string) {
  try {
    return parseLockOwner(fsSync.readFileSync(lockOwnerPath(lockDir), "utf8"));
  } catch {
    return null;
  }
}

function isDatabaseBusy(error: any) {
  return (
    error?.code === "SQLITE_BUSY" ||
    error?.code === "SQLITE_LOCKED" ||
    /database is locked/i.test(String(error?.message || ""))
  );
}

function acquireDatabaseLease(lockDir: string): DatabaseLease {
  fsSync.mkdirSync(path.dirname(lockDir), { recursive: true });
  const databasePath = lockDatabasePath(lockDir);
  const database = new BetterSqlite3(databasePath);
  try {
    fsSync.chmodSync(databasePath, 0o600);
  } catch {}
  try {
    database.pragma("busy_timeout = 0");
    database.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    database.close();
    throw error;
  }

  let closed = false;
  return {
    close() {
      if (closed) return;
      closed = true;
      try {
        database.exec("ROLLBACK");
      } finally {
        database.close();
      }
    },
  };
}

async function removeMarker(lockDir: string) {
  try {
    const entry = await fs.lstat(lockDir);
    if (entry.isSymbolicLink()) {
      await fs.unlink(lockDir);
      return;
    }
  } catch (error: any) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  await fs.rm(lockDir, { recursive: true, force: true });
}

export function normalizeDaemonLockFilesystemPath(
  value: string,
  platform: NodeJS.Platform = process.platform,
) {
  const pathApi = platform === "win32" ? path.win32 : path;
  let unnamespaced = value;
  if (platform === "win32") {
    const lower = unnamespaced.toLowerCase();
    if (lower.startsWith("\\\\?\\unc\\") || lower.startsWith("\\??\\unc\\")) {
      unnamespaced = `\\\\${unnamespaced.slice(8)}`;
    } else if (lower.startsWith("\\\\?\\") || lower.startsWith("\\??\\")) {
      unnamespaced = unnamespaced.slice(4);
    }
  }
  const normalized = pathApi.normalize(pathApi.resolve(unnamespaced));
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sameFilesystemPath(left: string, right: string) {
  return (
    normalizeDaemonLockFilesystemPath(left) ===
    normalizeDaemonLockFilesystemPath(right)
  );
}

async function readPublishedMarkerTarget(markerPath: string) {
  try {
    const entry = await fs.lstat(markerPath);
    if (!entry.isSymbolicLink()) return null;
    return path.resolve(
      path.dirname(markerPath),
      await fs.readlink(markerPath),
    );
  } catch {
    return null;
  }
}

async function validatedPublishedMarkerTarget(
  markerPath: string,
  canonicalLockDir: string,
  owner: DaemonLockOwner,
) {
  const target = await readPublishedMarkerTarget(markerPath);
  if (
    !target ||
    !sameFilesystemPath(path.dirname(target), path.dirname(canonicalLockDir))
  ) {
    return null;
  }
  if (
    !path
      .basename(target)
      .startsWith(`${path.basename(canonicalLockDir)}.rin-publish-`)
  ) {
    return null;
  }
  if (readLockOwnerSync(target)?.token !== owner.token) return null;
  return target;
}

function heldError(
  code: "rin_daemon_already_running" | "rin_daemon_update_in_progress",
  owner: DaemonLockOwner | null,
  lockDir: string,
) {
  const detail = owner
    ? ` owner pid=${owner.pid} createdAt=${owner.createdAt}`
    : "";
  return new Error(`${code}:${detail} lock=${lockDir}`);
}

function tryAcquireDatabaseLease(
  lockDir: string,
  code: "rin_daemon_already_running" | "rin_daemon_update_in_progress",
) {
  try {
    return acquireDatabaseLease(lockDir);
  } catch (error) {
    if (!isDatabaseBusy(error)) throw error;
    throw heldError(code, readLockOwnerSync(lockDir), lockDir);
  }
}

async function writeOwnerMarker(lockDir: string, owner: DaemonLockOwner) {
  await fs.writeFile(
    lockOwnerPath(lockDir),
    `${JSON.stringify(owner, null, 2)}\n`,
    {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    },
  );
}

async function publishLegacyCompatibleMarker(
  lockDir: string,
  owner: DaemonLockOwner,
) {
  // Publish a pre-populated marker in one namespace operation. Old daemons
  // either win mkdir(daemon.lock) or observe a complete live owner; they can
  // never observe this claimant between mkdir and owner publication.
  const stagingDir = `${lockDir}.rin-publish-${crypto.randomUUID()}`;
  await fs.mkdir(stagingDir, { recursive: false });
  try {
    await writeOwnerMarker(stagingDir, owner);
    if (process.platform === "win32") {
      // Directory junctions provide atomic no-replace publication without the
      // symbolic-link privilege required by ordinary Windows symlinks.
      await fs.symlink(path.resolve(stagingDir), lockDir, "junction");
    } else {
      await fs.symlink(path.basename(stagingDir), lockDir, "dir");
    }
    return stagingDir;
  } catch (error) {
    await removeMarker(stagingDir).catch(() => {});
    throw error;
  }
}

async function claimLegacyCompatibleMarker(
  lockDir: string,
  owner: DaemonLockOwner,
  heldCode: "rin_daemon_already_running" | "rin_daemon_update_in_progress",
): Promise<string> {
  while (true) {
    try {
      return await publishLegacyCompatibleMarker(lockDir, owner);
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }

    const observedOwner = readLockOwnerSync(lockDir);
    if (!observedOwner) {
      throw new Error(`rin_daemon_lock_owner_pending: lock=${lockDir}`);
    }
    if (await ownerProcessIsAlive(observedOwner)) {
      throw heldError(heldCode, observedOwner, lockDir);
    }

    const quarantinedPath = `${lockDir}.rin-stale-${process.pid}-${crypto.randomUUID()}`;
    try {
      await fs.rename(lockDir, quarantinedPath);
    } catch (error: any) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }

    const quarantinedOwner = readLockOwnerSync(quarantinedPath);
    if (!quarantinedOwner) {
      await fs.rename(quarantinedPath, lockDir).catch(() => {});
      throw new Error(`rin_daemon_lock_owner_pending: lock=${lockDir}`);
    }
    if (await ownerProcessIsAlive(quarantinedOwner)) {
      // A legacy daemon won the race after the first observation. Restore its
      // marker atomically when possible and abort before any data mutation.
      await fs.rename(quarantinedPath, lockDir).catch(() => {});
      throw heldError(heldCode, quarantinedOwner, lockDir);
    }
    const quarantinedPublishedTarget = await validatedPublishedMarkerTarget(
      quarantinedPath,
      lockDir,
      quarantinedOwner,
    );

    let stagingDir: string;
    try {
      stagingDir = await publishLegacyCompatibleMarker(lockDir, owner);
    } catch (error: any) {
      if (quarantinedPublishedTarget) {
        await removeMarker(quarantinedPublishedTarget).catch(() => {});
      }
      await removeMarker(quarantinedPath).catch(() => {});
      if (error?.code === "EEXIST") continue;
      throw error;
    }
    if (quarantinedPublishedTarget) {
      await removeMarker(quarantinedPublishedTarget).catch(() => {});
    }
    await removeMarker(quarantinedPath).catch(() => {});
    return stagingDir;
  }
}

async function acquireOwnedLock(
  lockDir: string,
  options: {
    purpose: DaemonLockPurpose;
    agentDir: string;
    socketPath?: string;
    heldCode: "rin_daemon_already_running" | "rin_daemon_update_in_progress";
    legacyCompatibleClaim?: boolean;
    strictRelease?: boolean;
  },
): Promise<DaemonInstanceLock> {
  const lease = tryAcquireDatabaseLease(lockDir, options.heldCode);
  const owner: DaemonLockOwner = {
    pid: process.pid,
    token: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    processStartTime: await readProcStartTime(process.pid),
    purpose: options.purpose,
    agentDir: options.agentDir,
    ...(options.socketPath ? { socketPath: options.socketPath } : {}),
    argv: process.argv.slice(0, 8),
  };

  let markerOwned = false;
  let publishedMarkerTarget: string | undefined;
  try {
    if (options.legacyCompatibleClaim) {
      publishedMarkerTarget = await claimLegacyCompatibleMarker(
        lockDir,
        owner,
        options.heldCode,
      );
    } else {
      // The database lease is the authority for fence-aware peers. Once held,
      // no live peer can own this marker.
      await removeMarker(lockDir);
      await fs.mkdir(lockDir, { recursive: false });
      markerOwned = true;
      await writeOwnerMarker(lockDir, owner);
    }
    markerOwned = true;
  } catch (error) {
    if (markerOwned) {
      await removeMarker(lockDir).catch(() => {});
      if (publishedMarkerTarget) {
        await removeMarker(publishedMarkerTarget).catch(() => {});
      }
    }
    lease.close();
    throw error;
  }

  const detachedMarkerPath = `${lockDir}.rin-release-${owner.token}`;
  let publishedMarkerDetached = false;
  let released = false;
  return {
    lockDir,
    ownerPath: lockOwnerPath(lockDir),
    token: owner.token,
    owner,
    async release() {
      if (released) return;
      try {
        if (publishedMarkerTarget) {
          if (!publishedMarkerDetached) {
            const currentTarget = await readPublishedMarkerTarget(lockDir);
            if (
              !currentTarget ||
              !sameFilesystemPath(currentTarget, publishedMarkerTarget)
            ) {
              throw new Error(
                `rin_daemon_lock_release_identity_changed: lock=${lockDir}`,
              );
            }
            // Detach our exact marker once. Retries clean only this private
            // path and can never remove a legacy daemon that subsequently wins
            // the canonical mkdir.
            await fs.rename(lockDir, detachedMarkerPath);
            publishedMarkerDetached = true;
          }
          await removeMarker(publishedMarkerTarget);
          await removeMarker(detachedMarkerPath);
        } else {
          await removeMarker(lockDir);
        }
      } catch (error) {
        if (options.strictRelease) throw error;
      }
      lease.close();
      released = true;
    },
  };
}

export function readDaemonInstanceLockOwner(agentDir: string) {
  return readLockOwnerSync(daemonInstanceLockPath(agentDir));
}

export async function assertNoDaemonUpdateInProgress(
  agentDir: string,
  options: { socketPath?: string } = {},
) {
  const fenceDir = daemonUpdateFencePath(agentDir, options);
  const lease = tryAcquireDatabaseLease(
    fenceDir,
    "rin_daemon_update_in_progress",
  );
  try {
    await removeMarker(fenceDir);
  } finally {
    lease.close();
  }
}

export async function acquireDaemonUpdateFence(
  agentDir: string,
  options: { socketPath?: string } = {},
): Promise<DaemonInstanceLock> {
  return await acquireOwnedLock(daemonUpdateFencePath(agentDir, options), {
    purpose: "update",
    agentDir,
    heldCode: "rin_daemon_update_in_progress",
    strictRelease: true,
  });
}

export async function acquireDaemonMigrationLock(
  agentDir: string,
  options: { socketPath?: string } = {},
): Promise<DaemonInstanceLock> {
  const legacyOwner = readDaemonInstanceLockOwner(agentDir);
  if (legacyOwner && (await ownerProcessIsAlive(legacyOwner))) {
    throw heldError(
      "rin_daemon_already_running",
      legacyOwner,
      daemonInstanceLockPath(agentDir),
    );
  }
  return await acquireOwnedLock(daemonInstanceLockPath(agentDir), {
    purpose: "migration",
    agentDir,
    socketPath: options.socketPath,
    heldCode: "rin_daemon_already_running",
    legacyCompatibleClaim: true,
    strictRelease: true,
  });
}

export async function acquireDaemonInstanceLock(
  agentDir: string,
  options: { socketPath?: string } = {},
): Promise<DaemonInstanceLock> {
  await assertNoDaemonUpdateInProgress(agentDir, options);
  const lock = await acquireOwnedLock(daemonInstanceLockPath(agentDir), {
    purpose: "daemon",
    agentDir,
    socketPath: options.socketPath,
    heldCode: "rin_daemon_already_running",
    legacyCompatibleClaim: true,
  });
  try {
    await assertNoDaemonUpdateInProgress(agentDir, options);
    return lock;
  } catch (error) {
    await lock.release();
    throw error;
  }
}
