import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";

import {
  acquireDaemonInstanceLock,
  acquireDaemonMigrationLock,
  acquireDaemonUpdateFence,
  daemonInstanceLockPath,
  daemonUpdateFencePath,
  normalizeDaemonLockFilesystemPath,
  type DaemonInstanceLock,
} from "../../src/core/rin-daemon/lock.js";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);

async function makeTempDir(prefix: string) {
  const root = process.env.RIN_TEST_TMPDIR || os.tmpdir();
  await fs.mkdir(root, { recursive: true });
  return await fs.mkdtemp(path.join(root, prefix));
}

test("Windows daemon lock paths normalize native namespace forms", () => {
  const normalize = (value: string) =>
    normalizeDaemonLockFilesystemPath(value, "win32");
  assert.equal(
    normalize(String.raw`\\?\C:\Users\Rin\lock`),
    normalize(String.raw`C:\Users\Rin\lock`),
  );
  assert.equal(
    normalize(String.raw`\??\C:\Users\Rin\lock`),
    normalize(String.raw`C:\Users\Rin\lock`),
  );
  assert.equal(
    normalize(String.raw`\\?\UNC\server\share\Rin\lock`),
    normalize(String.raw`\\server\share\Rin\lock`),
  );
  assert.equal(
    normalize(String.raw`\??\UNC\server\share\Rin\lock`),
    normalize(String.raw`\\server\share\Rin\lock`),
  );
});

function spawnDaemon(agentDir: string, socketPath: string) {
  const child = spawn(
    process.execPath,
    [path.join(rootDir, "dist", "core", "rin-daemon", "daemon.js"), socketPath],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        RIN_DIR: agentDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  return {
    child,
    stderr: () => stderr,
  };
}

async function waitForExit(child: ChildProcess, timeoutMs = 3000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
        child.once("error", reject);
      },
    ),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("process_exit_timeout")), timeoutMs),
    ),
  ]);
}

async function terminateChild(child: ChildProcess, timeoutMs = 1000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await waitForExit(child, timeoutMs);
  } catch {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child, timeoutMs).catch(() => {});
    }
  }
}

async function listenOnUnixSocket(socketPath: string) {
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.end("ok\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

async function connectAndRead(socketPath: string) {
  const socket = net.createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  let data = "";
  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("socket_read_timeout")),
        1000,
      );
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("end", onEnd);
        socket.off("error", onError);
      };
      const onData = (chunk: Buffer) => {
        data += String(chunk);
      };
      const onEnd = () => {
        cleanup();
        resolve(data);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      socket.on("data", onData);
      socket.once("end", onEnd);
      socket.once("error", onError);
    });
  } finally {
    socket.destroy();
  }
}

async function closeServer(server: net.Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("daemon instance lock rejects a second daemon without unlinking the active socket", async () => {
  const agentDir = await makeTempDir("rin-daemon-lock-");
  const socketPath = path.join(agentDir, "daemon.sock");
  const lock = await acquireDaemonInstanceLock(agentDir, { socketPath });
  const server = await listenOnUnixSocket(socketPath);

  const daemon = spawnDaemon(agentDir, socketPath);
  try {
    const exit = await waitForExit(daemon.child);

    assert.equal(exit.code, 1);
    assert.match(daemon.stderr(), /rin_daemon_already_running/);
    assert.equal(await connectAndRead(socketPath), "ok\n");
  } finally {
    await terminateChild(daemon.child);
    await closeServer(server).catch(() => {});
    await lock.release();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("daemon instance lock removes stale dead-owner locks on startup", async () => {
  const agentDir = await makeTempDir("rin-daemon-stale-lock-");
  const socketPath = path.join(agentDir, "daemon.sock");
  const lockDir = daemonInstanceLockPath(agentDir);
  const ownerPath = path.join(lockDir, "owner.json");
  await fs.mkdir(lockDir, { recursive: true });
  await fs.writeFile(
    ownerPath,
    `${JSON.stringify({ pid: -1, token: "stale", createdAt: "2000-01-01T00:00:00.000Z" })}\n`,
  );

  const lock = await acquireDaemonInstanceLock(agentDir, { socketPath });
  try {
    const owner = JSON.parse(await fs.readFile(ownerPath, "utf8"));
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.socketPath, socketPath);
  } finally {
    await lock.release();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("migration lock never reclaims a legacy mkdir before owner publication", async () => {
  const agentDir = await makeTempDir("rin-legacy-owner-pending-");
  const socketPath = path.join(agentDir, "runtime", "daemon.sock");
  const lockDir = daemonInstanceLockPath(agentDir);
  const script = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const [lockDir] = process.argv.slice(1);
fs.mkdirSync(lockDir, { recursive: true });
process.stdout.write("mkdir-ready\n");
process.stdin.once("data", () => {
  fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, token: "legacy-pending", createdAt: new Date().toISOString() }) + "\n", { flag: "wx" });
  process.stdout.write("owner-ready\n");
});
setInterval(() => {}, 1000);
`;
  const legacyDaemon = spawn(process.execPath, ["-e", script, lockDir], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const waitForOutput = (expected: string) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`legacy daemon timeout: ${expected}`)),
        5000,
      );
      const onData = (chunk: Buffer | string) => {
        if (!chunk.toString().includes(expected)) return;
        clearTimeout(timer);
        legacyDaemon.stdout?.off("data", onData);
        resolve();
      };
      legacyDaemon.stdout?.on("data", onData);
      legacyDaemon.once("error", reject);
    });
  try {
    await waitForOutput("mkdir-ready");
    await assert.rejects(
      acquireDaemonMigrationLock(agentDir, { socketPath }),
      /rin_daemon_lock_owner_pending/,
    );
    const ownerReady = waitForOutput("owner-ready");
    legacyDaemon.stdin?.write("publish\n");
    await ownerReady;
    await assert.rejects(
      acquireDaemonMigrationLock(agentDir, { socketPath }),
      /rin_daemon_already_running/,
    );
  } finally {
    legacyDaemon.kill("SIGKILL");
    await waitForExit(legacyDaemon).catch(() => {});
  }

  const migrationLock = await acquireDaemonMigrationLock(agentDir, {
    socketPath,
  });
  assert.equal((await fs.lstat(lockDir)).isSymbolicLink(), true);
  const publishedTarget = path.resolve(
    path.dirname(lockDir),
    await fs.readlink(lockDir),
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(lockDir, "owner.json"), "utf8"))
      .token,
    migrationLock.token,
  );
  await migrationLock.release();
  await assert.rejects(fs.access(publishedTarget), { code: "ENOENT" });
  await fs.rm(agentDir, { recursive: true, force: true });
});

test("migration release retry never removes a replacement legacy marker", async () => {
  const agentDir = await makeTempDir("rin-migration-release-retry-");
  const socketPath = path.join(agentDir, "runtime", "daemon.sock");
  const lockDir = daemonInstanceLockPath(agentDir);
  const migrationLock = await acquireDaemonMigrationLock(agentDir, {
    socketPath,
  });
  const publishedTarget = path.resolve(
    path.dirname(lockDir),
    await fs.readlink(lockDir),
  );
  const originalRm = fs.rm;
  let failedTargetCleanup = false;
  try {
    (fs as any).rm = async (target: fs.PathLike, options?: any) => {
      if (
        !failedTargetCleanup &&
        path.resolve(String(target)) === publishedTarget
      ) {
        failedTargetCleanup = true;
        throw Object.assign(new Error("injected target cleanup failure"), {
          code: "EIO",
        });
      }
      return originalRm(target, options);
    };
    await assert.rejects(
      migrationLock.release(),
      /injected target cleanup failure/,
    );
  } finally {
    (fs as any).rm = originalRm;
  }

  assert.equal(failedTargetCleanup, true);
  await fs.mkdir(lockDir);
  const replacementOwner = {
    pid: process.pid,
    token: "replacement-legacy-owner",
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(
    path.join(lockDir, "owner.json"),
    `${JSON.stringify(replacementOwner)}\n`,
  );

  await migrationLock.release();
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(lockDir, "owner.json"), "utf8")),
    replacementOwner,
  );
  await fs.rm(agentDir, { recursive: true, force: true });
});

test("stale published marker takeover removes its private target", async () => {
  const agentDir = await makeTempDir("rin-stale-published-marker-");
  const socketPath = path.join(agentDir, "runtime", "daemon.sock");
  const lockDir = daemonInstanceLockPath(agentDir);
  const staleTarget = `${lockDir}.rin-publish-stale-test`;
  await fs.mkdir(path.dirname(lockDir), { recursive: true });
  await fs.mkdir(staleTarget);
  await fs.writeFile(
    path.join(staleTarget, "owner.json"),
    `${JSON.stringify({
      pid: 2_147_483_647,
      token: "dead-published-owner",
      createdAt: new Date(0).toISOString(),
    })}\n`,
  );
  if (process.platform === "win32") {
    await fs.symlink(path.resolve(staleTarget), lockDir, "junction");
  } else {
    await fs.symlink(path.basename(staleTarget), lockDir, "dir");
  }

  const migrationLock = await acquireDaemonMigrationLock(agentDir, {
    socketPath,
  });
  await assert.rejects(fs.access(staleTarget), { code: "ENOENT" });
  await migrationLock.release();
  await fs.rm(agentDir, { recursive: true, force: true });
});

test("migration lock rejects a live legacy daemon owner before takeover", async () => {
  const agentDir = await makeTempDir("rin-legacy-daemon-owner-");
  const socketPath = path.join(agentDir, "runtime", "daemon.sock");
  const lockDir = daemonInstanceLockPath(agentDir);
  const script = String.raw`
const fs = require("node:fs");
const [lockDir] = process.argv.slice(1);
fs.mkdirSync(lockDir, { recursive: true });
fs.writeFileSync(require("node:path").join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, token: "legacy-live", createdAt: new Date().toISOString() }) + "\n");
process.stdout.write("ready\n");
setInterval(() => {}, 1000);
`;
  const legacyDaemon = spawn(process.execPath, ["-e", script, lockDir], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("legacy daemon ready timeout")),
        5000,
      );
      legacyDaemon.stdout?.once("data", () => {
        clearTimeout(timer);
        resolve();
      });
      legacyDaemon.once("error", reject);
    });
    await assert.rejects(
      acquireDaemonMigrationLock(agentDir, { socketPath }),
      /rin_daemon_already_running/,
    );
  } finally {
    legacyDaemon.kill("SIGKILL");
    await waitForExit(legacyDaemon).catch(() => {});
  }

  const migrationLock = await acquireDaemonMigrationLock(agentDir, {
    socketPath,
  });
  await migrationLock.release();
  await fs.rm(agentDir, { recursive: true, force: true });
});

test("live update fence prevents daemon startup without masking its service", async () => {
  const agentDir = await makeTempDir("rin-daemon-update-fence-");
  const socketPath = path.join(agentDir, "runtime", "daemon.sock");
  const fence = await acquireDaemonUpdateFence(agentDir, { socketPath });
  try {
    await assert.rejects(
      acquireDaemonInstanceLock(agentDir, { socketPath }),
      /rin_daemon_update_in_progress/,
    );
    const owner = JSON.parse(
      await fs.readFile(
        path.join(
          daemonUpdateFencePath(agentDir, { socketPath }),
          "owner.json",
        ),
        "utf8",
      ),
    );
    assert.equal(owner.purpose, "update");
  } finally {
    await fence.release();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("concurrent stale-fence takeover grants exactly one update owner", async () => {
  const agentDir = await makeTempDir("rin-daemon-update-takeover-");
  const socketPath = path.join(agentDir, "runtime", "daemon.sock");
  const fenceDir = daemonUpdateFencePath(agentDir, { socketPath });
  await fs.mkdir(fenceDir, { recursive: true });
  await fs.writeFile(
    path.join(fenceDir, "owner.json"),
    `${JSON.stringify({ pid: -1, token: "stale", purpose: "update", createdAt: "2000-01-01T00:00:00.000Z" })}\n`,
  );

  const attempts = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      acquireDaemonUpdateFence(agentDir, { socketPath }),
    ),
  );
  const acquired = attempts.filter(
    (result): result is PromiseFulfilledResult<DaemonInstanceLock> =>
      result.status === "fulfilled",
  );
  try {
    assert.equal(acquired.length, 1);
    for (const result of attempts) {
      if (result.status === "rejected") {
        assert.match(String(result.reason), /rin_daemon_update_in_progress/);
      }
    }
  } finally {
    await acquired[0]?.value.release();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("daemon startup removes a stale update fence after its owner dies", async () => {
  const agentDir = await makeTempDir("rin-daemon-stale-update-fence-");
  const socketPath = path.join(agentDir, "runtime", "daemon.sock");
  const fenceDir = daemonUpdateFencePath(agentDir, { socketPath });
  await fs.mkdir(fenceDir, { recursive: true });
  await fs.writeFile(
    path.join(fenceDir, "owner.json"),
    `${JSON.stringify({ pid: -1, token: "stale", purpose: "update", createdAt: "2000-01-01T00:00:00.000Z" })}\n`,
  );

  const lock = await acquireDaemonInstanceLock(agentDir, { socketPath });
  try {
    await assert.rejects(fs.stat(fenceDir), { code: "ENOENT" });
  } finally {
    await lock.release();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});
