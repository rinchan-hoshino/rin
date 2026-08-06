import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { importBuiltModule } from "../support/import-built-module.js";

const lock = await importBuiltModule<
  typeof import("../../src/core/rin-daemon/lock.js")
>("dist/core/rin-daemon/lock.js");

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

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
        `rin_daemon_already_running:.*pid=${process.pid}.*createdAt=.*lock=${lockDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      ),
    );
  });
});

test("daemon lock reclaims dead and mismatched owners", async () => {
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
    const write = mock.method(fs, "writeFile", async () => {
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
        undefined,
      );
      await acquired.release();
    } finally {
      if (descriptor) Object.defineProperty(process, "platform", descriptor);
    }
  });
});

test("daemon lock fails closed for an unreadable pending owner", async () => {
  await withAgentDir(async (agentDir) => {
    const lockDir = lock.daemonInstanceLockPath(agentDir);
    await fs.mkdir(lockDir, { recursive: true });
    const syncFs = await import("node:fs");
    const stat = mock.method(syncFs.default, "statSync", () => {
      throw new Error("stat unavailable");
    });
    try {
      await assert.rejects(
        () => lock.acquireDaemonInstanceLock(agentDir),
        /rin_daemon_lock_owner_pending/,
      );
    } finally {
      stat.mock.restore();
    }
  });
});

test("daemon lock propagates unexpected lock-directory creation failures", async () => {
  await withAgentDir(async (agentDir) => {
    const lockDir = lock.daemonInstanceLockPath(agentDir);
    const originalMkdir = fs.mkdir.bind(fs);
    const mkdir = mock.method(
      fs,
      "mkdir",
      async (filePath: any, options: any) => {
        if (String(filePath).startsWith(`${lockDir}.rin-publish-`)) {
          const error: NodeJS.ErrnoException = new Error("mkdir denied");
          error.code = "EACCES";
          throw error;
        }
        return await originalMkdir(filePath, options);
      },
    );
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

test("daemon lock normalizes cross-platform paths and selects update fence namespaces", async () => {
  await withAgentDir(async (agentDir) => {
    assert.equal(
      lock.normalizeDaemonLockFilesystemPath("./core/../core"),
      path.resolve("core"),
    );
    assert.equal(
      lock.normalizeDaemonLockFilesystemPath("C:\\Owner\\..\\LOCK", "win32"),
      "c:\\lock",
    );
    assert.equal(
      lock.normalizeDaemonLockFilesystemPath("\\\\?\\C:\\OWNER\\lock", "win32"),
      "c:\\owner\\lock",
    );
    assert.equal(
      lock.normalizeDaemonLockFilesystemPath(
        "\\??\\UNC\\server\\share\\LOCK",
        "win32",
      ),
      "\\\\server\\share\\lock",
    );
    assert.equal(
      lock.daemonUpdateFencePath(agentDir, {
        socketPath: path.join(agentDir, "run", "daemon.sock"),
      }),
      path.join(agentDir, "run", "update.lock"),
    );
    assert.equal(
      lock.daemonUpdateFencePath(agentDir, {
        socketPath: "\\\\.\\pipe\\rin-owner",
      }),
      path.join(agentDir, "core", "data", "daemon", "update.lock"),
    );
  });
});

test("daemon update fence blocks peers, publishes ownership, and releases idempotently", async () => {
  await withAgentDir(async (agentDir) => {
    const socketPath = path.join(agentDir, "run", "daemon.sock");
    const fence = await lock.acquireDaemonUpdateFence(agentDir, { socketPath });
    assert.equal(fence.owner.purpose, "update");
    assert.equal(fence.owner.socketPath, undefined);
    assert.equal(
      fence.lockDir,
      lock.daemonUpdateFencePath(agentDir, { socketPath }),
    );
    assert.equal(lock.readDaemonInstanceLockOwner(agentDir), null);
    await assert.rejects(
      () => lock.assertNoDaemonUpdateInProgress(agentDir, { socketPath }),
      /rin_daemon_update_in_progress/,
    );
    await assert.rejects(
      () => lock.acquireDaemonUpdateFence(agentDir, { socketPath }),
      /rin_daemon_update_in_progress/,
    );
    await fence.release();
    await fence.release();
    await lock.assertNoDaemonUpdateInProgress(agentDir, { socketPath });
  });
});

test("daemon migration lock publishes migration ownership and rejects a live daemon", async () => {
  await withAgentDir(async (agentDir) => {
    const migration = await lock.acquireDaemonMigrationLock(agentDir, {
      socketPath: path.join(agentDir, "migration.sock"),
    });
    assert.equal(migration.owner.purpose, "migration");
    assert.equal(
      lock.readDaemonInstanceLockOwner(agentDir)?.token,
      migration.token,
    );
    await assert.rejects(
      () => lock.acquireDaemonMigrationLock(agentDir),
      /rin_daemon_already_running/,
    );
    await migration.release();
    const second = await lock.acquireDaemonMigrationLock(agentDir);
    await second.release();
  });
});

test("daemon lock cleans a partially published update fence when owner writing fails", async () => {
  await withAgentDir(async (agentDir) => {
    const fenceDir = lock.daemonUpdateFencePath(agentDir);
    const originalWrite = fs.writeFile.bind(fs);
    const write = mock.method(
      fs,
      "writeFile",
      async (filePath: any, ...args: any[]) => {
        if (String(filePath) === path.join(fenceDir, "owner.json")) {
          const error: NodeJS.ErrnoException = new Error("owner write denied");
          error.code = "EACCES";
          throw error;
        }
        return await (originalWrite as any)(filePath, ...args);
      },
    );
    try {
      await assert.rejects(
        () => lock.acquireDaemonUpdateFence(agentDir),
        /owner write denied/,
      );
      await assert.rejects(() => fs.access(fenceDir));
    } finally {
      write.mock.restore();
    }
  });
});

test("daemon lock swallows non-strict release failures and permits retry cleanup", async () => {
  await withAgentDir(async (agentDir) => {
    const acquired = await lock.acquireDaemonInstanceLock(agentDir);
    const originalRename = fs.rename.bind(fs);
    let failed = false;
    const rename = mock.method(fs, "rename", async (from: any, to: any) => {
      if (!failed && String(from) === acquired.lockDir) {
        failed = true;
        const error: NodeJS.ErrnoException = new Error("release rename denied");
        error.code = "EACCES";
        throw error;
      }
      return await originalRename(from, to);
    });
    try {
      await acquired.release();
    } finally {
      rename.mock.restore();
      await fs.rm(acquired.lockDir, { recursive: true, force: true });
    }
  });
});

test("daemon migration lock propagates strict release failure then retries", async () => {
  await withAgentDir(async (agentDir) => {
    const acquired = await lock.acquireDaemonMigrationLock(agentDir);
    const originalRename = fs.rename.bind(fs);
    let failed = false;
    const rename = mock.method(fs, "rename", async (from: any, to: any) => {
      if (!failed && String(from) === acquired.lockDir) {
        failed = true;
        const error: NodeJS.ErrnoException = new Error("strict release denied");
        error.code = "EACCES";
        throw error;
      }
      return await originalRename(from, to);
    });
    try {
      await assert.rejects(() => acquired.release(), /strict release denied/);
    } finally {
      rename.mock.restore();
    }
    await acquired.release();
  });
});

test("daemon lock owner directly covers marker validation branches", async () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import fs from "node:fs/promises";
    import os from "node:os";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const rootDir = process.env.RIN_REPO_ROOT;
    const mod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "rin-daemon", "lock.js")).href);
    const parse = (raw) => mod.__rinOwnerParseLockOwner(typeof raw === "string" ? raw : JSON.stringify(raw));
    assert.equal(parse(null), null);
    assert.equal(parse("invalid"), null);
    assert.equal(parse({ pid: 1.5, token: "x" }), null);
    assert.equal(parse({ pid: 1, token: "" }), null);
    assert.equal(parse({ pid: 1, token: 2 }), null);
    assert.equal(parse({ pid: 1, token: "x" }).token, "x");

    const base = await fs.mkdtemp(path.join(os.tmpdir(), "rin-lock-private-owner-"));
    try {
      const canonical = path.join(base, "daemon.lock");
      const marker = path.join(base, "marker");
      const owner = { pid: 1, token: "owner-token" };
      assert.equal(await mod.__rinOwnerReadPublishedMarkerTarget(marker), null);
      assert.equal(await mod.__rinOwnerValidatedPublishedMarkerTarget(marker, canonical, owner), null);

      const wrongParentTarget = path.join(base, "other", "daemon.lock.rin-publish-owner");
      await fs.mkdir(wrongParentTarget, { recursive: true });
      await fs.symlink(wrongParentTarget, marker, "dir");
      assert.equal(await mod.__rinOwnerValidatedPublishedMarkerTarget(marker, canonical, owner), null);
      await fs.unlink(marker);

      const wrongNameTarget = path.join(base, "wrong-name");
      await fs.mkdir(wrongNameTarget);
      await fs.symlink(wrongNameTarget, marker, "dir");
      assert.equal(await mod.__rinOwnerValidatedPublishedMarkerTarget(marker, canonical, owner), null);
      await fs.unlink(marker);

      const target = path.join(base, "daemon.lock.rin-publish-owner");
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, "owner.json"), JSON.stringify({ pid: 1, token: "other" }));
      await fs.symlink(target, marker, "dir");
      assert.equal(await mod.__rinOwnerValidatedPublishedMarkerTarget(marker, canonical, owner), null);
      await fs.writeFile(path.join(target, "owner.json"), JSON.stringify(owner));
      assert.equal(await mod.__rinOwnerValidatedPublishedMarkerTarget(marker, canonical, owner), target);
      await mod.__rinOwnerRemoveMarker(marker);
      await mod.__rinOwnerRemoveMarker(target);
      await mod.__rinOwnerRemoveMarker(path.join(base, "missing"));
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  `;
  await execFileAsync(
    process.execPath,
    [
      "--import",
      path.join(
        rootDir,
        "tests",
        "support",
        "register-daemon-lock-private-owner-fixture.mjs",
      ),
      "--input-type=module",
      "-e",
      script,
    ],
    {
      cwd: rootDir,
      env: { ...process.env, RIN_REPO_ROOT: rootDir },
      timeout: 10_000,
    },
  );
});
