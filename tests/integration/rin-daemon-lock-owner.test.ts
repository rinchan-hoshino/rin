import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const lock = await importBuiltModule<
  typeof import("../../src/core/rin-daemon/lock.js")
>("dist/core/rin-daemon/lock.js");

async function withAgentDir(run: (agentDir: string) => Promise<void>) {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-lock-owner-"));
  try {
    await run(agentDir);
  } finally {
    await fs.chmod(agentDir, 0o700).catch(() => undefined);
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

async function writeOwner(agentDir: string, owner: unknown) {
  const lockDir = lock.daemonInstanceLockPath(agentDir);
  await fs.mkdir(lockDir, { recursive: true });
  await fs.writeFile(
    path.join(lockDir, "owner.json"),
    `${JSON.stringify(owner)}\n`,
  );
  return lockDir;
}

test("daemon lock records owner identity and releases only once", async () => {
  await withAgentDir(async (agentDir) => {
    assert.equal(lock.readDaemonInstanceLockOwner(agentDir), null);
    const acquired = await lock.acquireDaemonInstanceLock(agentDir, {
      socketPath: "/tmp/rin-owner.sock",
    });
    const owner = lock.readDaemonInstanceLockOwner(agentDir);
    assert.equal(owner?.pid, process.pid);
    assert.equal(owner?.token, acquired.token);
    assert.equal(owner?.agentDir, agentDir);
    assert.equal(owner?.socketPath, "/tmp/rin-owner.sock");
    assert.ok(owner?.createdAt);
    assert.ok(Array.isArray(owner?.argv));

    await acquired.release();
    await acquired.release();
    await assert.rejects(() => fs.access(acquired.lockDir));
  });
});

test("daemon lock never removes a lock after its owner token changes", async () => {
  await withAgentDir(async (agentDir) => {
    const acquired = await lock.acquireDaemonInstanceLock(agentDir);
    await fs.writeFile(
      acquired.ownerPath,
      JSON.stringify({ pid: process.pid, token: "replacement" }),
    );
    await acquired.release();
    await fs.access(acquired.lockDir);
    assert.equal(
      (lock.readDaemonInstanceLockOwner(agentDir) as any)?.token,
      "replacement",
    );
  });
});

test("daemon lock rejects a live owner with actionable metadata", async () => {
  await withAgentDir(async (agentDir) => {
    const lockDir = await writeOwner(agentDir, {
      pid: process.pid,
      token: "live",
      createdAt: "2026-07-16T00:00:00.000Z",
      socketPath: "/tmp/live.sock",
    });
    await assert.rejects(
      () => lock.acquireDaemonInstanceLock(agentDir),
      new RegExp(
        `rin_daemon_already_running:.*pid=${process.pid}.*createdAt=.*socket=/tmp/live\\.sock.*lock=${lockDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      ),
    );
  });
});

test("daemon lock reclaims dead, mismatched, and invalid stale owners", async () => {
  await withAgentDir(async (agentDir) => {
    await writeOwner(agentDir, { pid: 999_999_999, token: "dead" });
    const dead = await lock.acquireDaemonInstanceLock(agentDir);
    await dead.release();

    await writeOwner(agentDir, {
      pid: process.pid,
      processStartTime: "definitely-not-current",
      token: "reused-pid",
    });
    const reused = await lock.acquireDaemonInstanceLock(agentDir);
    await reused.release();

    const lockDir = lock.daemonInstanceLockPath(agentDir);
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(path.join(lockDir, "owner.json"), "not-json");
    const old = new Date(Date.now() - 10_000);
    await fs.utimes(lockDir, old, old);
    const invalid = await lock.acquireDaemonInstanceLock(agentDir);
    await invalid.release();
  });
});

test("daemon lock treats EPERM process probes as a live owner", async () => {
  await withAgentDir(async (agentDir) => {
    await writeOwner(agentDir, { pid: 424242, token: "protected" });
    const kill = mock.method(process, "kill", () => {
      const error: NodeJS.ErrnoException = new Error("denied");
      error.code = "EPERM";
      throw error;
    });
    try {
      await assert.rejects(
        () => lock.acquireDaemonInstanceLock(agentDir),
        /rin_daemon_already_running:.*pid=424242/,
      );
    } finally {
      kill.mock.restore();
    }
  });
});

test("daemon lock cleans up its directory when owner metadata cannot be written", async () => {
  await withAgentDir(async (agentDir) => {
    const syncFs = await import("node:fs");
    const write = mock.method(syncFs.default, "writeFileSync", () => {
      const error: NodeJS.ErrnoException = new Error("write denied");
      error.code = "EACCES";
      throw error;
    });
    try {
      await assert.rejects(
        () => lock.acquireDaemonInstanceLock(agentDir),
        /write denied/,
      );
      await assert.rejects(() =>
        fs.access(lock.daemonInstanceLockPath(agentDir)),
      );
    } finally {
      write.mock.restore();
    }
  });
});

test("daemon lock supports non-Linux owner records", async () => {
  await withAgentDir(async (agentDir) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const acquired = await lock.acquireDaemonInstanceLock(agentDir);
      assert.equal(
        lock.readDaemonInstanceLockOwner(agentDir)?.processStartTime,
        "",
      );
      await acquired.release();
    } finally {
      if (descriptor) Object.defineProperty(process, "platform", descriptor);
    }
  });
});

test("daemon lock treats an unreadable lock timestamp as stale", async () => {
  await withAgentDir(async (agentDir) => {
    const lockDir = lock.daemonInstanceLockPath(agentDir);
    await fs.mkdir(lockDir, { recursive: true });
    const syncFs = await import("node:fs");
    const stat = mock.method(syncFs.default, "statSync", () => {
      throw new Error("stat unavailable");
    });
    try {
      const acquired = await lock.acquireDaemonInstanceLock(agentDir);
      await acquired.release();
    } finally {
      stat.mock.restore();
    }
  });
});

test("daemon lock propagates unexpected lock-directory creation failures", async () => {
  await withAgentDir(async (agentDir) => {
    const lockDir = lock.daemonInstanceLockPath(agentDir);
    const syncFs = await import("node:fs");
    const originalMkdir = syncFs.default.mkdirSync.bind(syncFs.default);
    const mkdir = mock.method(syncFs.default, "mkdirSync", ((
      filePath: any,
      options: any,
    ) => {
      if (String(filePath) === lockDir) {
        const error: NodeJS.ErrnoException = new Error("mkdir denied");
        error.code = "EACCES";
        throw error;
      }
      return originalMkdir(filePath, options);
    }) as typeof syncFs.default.mkdirSync);
    try {
      await assert.rejects(
        () => lock.acquireDaemonInstanceLock(agentDir),
        /mkdir denied/,
      );
    } finally {
      mkdir.mock.restore();
    }
  });
});
