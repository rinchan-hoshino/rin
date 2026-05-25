import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";

import {
  acquireDaemonInstanceLock,
  daemonInstanceLockPath,
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

function spawnDaemon(agentDir: string, socketPath: string) {
  const child = spawn(
    process.execPath,
    [
      path.join(rootDir, "dist", "core", "rin-daemon", "daemon.js"),
      socketPath,
      "--shutdown-grace-ms",
      "200",
    ],
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
