import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { importBuiltModule } from "../support/import-built-module.js";

const { acquireDaemonInstanceLock, daemonUpdateFencePath } =
  await importBuiltModule<typeof import("../../src/core/rin-daemon/lock.js")>(
    "dist/core/rin-daemon/lock.js",
  );
const updateFenceModule: any = await importBuiltModule(
  "dist/core/rin-install/daemon-update-fence.js",
);
const {
  acquireTargetDaemonMigrationLock,
  acquireTargetDaemonUpdateFence,
  __rinOwnerWaitForExit: waitForExit,
  __rinOwnerWaitForConfirmedExit: waitForConfirmedExit,
  __rinOwnerTerminateHolder: terminateHolder,
} = updateFenceModule;

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const lockModulePath = path.join(
  rootDir,
  "dist",
  "core",
  "rin-daemon",
  "lock.js",
);
const holderModulePath = path.join(
  rootDir,
  "dist",
  "core",
  "rin-install",
  "daemon-update-fence.js",
);

async function makeTempDir(prefix: string) {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("update fence owner covers holder wait and termination states", async () => {
  class FakeChild extends EventEmitter {
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    killedWith: string[] = [];
    stdin = { end: () => {} };
    kill(signal: string) {
      this.killedWith.push(signal);
      return true;
    }
  }

  await waitForExit({ exitCode: 0, signalCode: null } as any, 1);
  const exited = new FakeChild();
  const exitedPromise = waitForExit(exited as any, 100);
  exited.emit("exit", 0, null);
  await exitedPromise;

  const errored = new FakeChild();
  const erroredPromise = waitForExit(errored as any, 100);
  errored.emit("error", new Error("owner child error"));
  await assert.rejects(erroredPromise, /owner child error/);
  await assert.rejects(
    waitForExit(new FakeChild() as any, 1),
    /rin_update_fence_holder_exit_timeout/,
  );

  await waitForConfirmedExit({ exitCode: null, signalCode: "SIGTERM" } as any);
  const confirmed = new FakeChild();
  const confirmedPromise = waitForConfirmedExit(confirmed as any);
  confirmed.emit("exit", null, "SIGKILL");
  await confirmedPromise;

  await terminateHolder({ exitCode: 0, signalCode: null } as any);
  const normal = new FakeChild();
  normal.stdin.end = () => {
    normal.exitCode = 0;
    normal.emit("exit", 0, null);
  };
  await terminateHolder(normal as any);
  assert.deepEqual(normal.killedWith, []);
});

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("condition did not become true before timeout");
}

test("target-user update fence blocks daemon startup until release", async () => {
  const agentDir = await makeTempDir("rin-target-update-fence-");
  const socketPath = path.join(agentDir, "runtime", "daemon.sock");
  const fence = await acquireTargetDaemonUpdateFence({
    targetUser: os.userInfo().username,
    nodePath: process.execPath,
    lockModulePath,
    agentDir,
    socketPath,
  });
  try {
    assert.equal(fence.owner.purpose, "update");
    assert.notEqual(fence.owner.pid, process.pid);
    await assert.rejects(
      acquireDaemonInstanceLock(agentDir, { socketPath }),
      /rin_daemon_update_in_progress/,
    );
  } finally {
    await fence.release();
  }

  const lock = await acquireDaemonInstanceLock(agentDir, { socketPath });
  await lock.release();
  await fs.rm(agentDir, { recursive: true, force: true });
});

test("target-user migration lock proves daemon quiescence under the update fence", async () => {
  const agentDir = await makeTempDir("rin-target-migration-lock-");
  const socketPath = path.join(agentDir, "runtime", "daemon.sock");
  const options = {
    targetUser: os.userInfo().username,
    nodePath: process.execPath,
    lockModulePath,
    agentDir,
    socketPath,
  };
  const updateFence = await acquireTargetDaemonUpdateFence(options);
  let migrationLock: Awaited<
    ReturnType<typeof acquireTargetDaemonMigrationLock>
  > | null = null;
  try {
    migrationLock = await acquireTargetDaemonMigrationLock(options);
    assert.equal(migrationLock.owner.purpose, "migration");
    await assert.rejects(
      acquireDaemonInstanceLock(agentDir, { socketPath }),
      /rin_daemon_update_in_progress/,
    );
  } finally {
    await migrationLock?.release();
    await updateFence.release();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("update fence rejects invalid and failed holders and recovers abnormal release", async () => {
  const root = await makeTempDir("rin-update-fence-owner-errors-");
  const agentDir = path.join(root, "agent");
  const socketPath = path.join(agentDir, "runtime", "daemon.sock");
  const options = {
    targetUser: os.userInfo().username,
    nodePath: process.execPath,
    agentDir,
    socketPath,
  };
  try {
    const invalidPath = path.join(root, "invalid-ready.mjs");
    await fs.writeFile(
      invalidPath,
      `export async function acquireDaemonUpdateFence() { return { owner: { pid: process.pid, token: "", createdAt: new Date().toISOString() }, async release() {} }; }\n`,
    );
    await assert.rejects(
      acquireTargetDaemonUpdateFence({
        ...options,
        lockModulePath: invalidPath,
      }),
      /rin_update_fence_holder_invalid_ready/,
    );

    const failedPath = path.join(root, "failed-holder.mjs");
    await fs.writeFile(
      failedPath,
      `export async function acquireDaemonUpdateFence() { throw new Error("owner acquire exploded"); }\n`,
    );
    await assert.rejects(
      acquireTargetDaemonUpdateFence({
        ...options,
        lockModulePath: failedPath,
      }),
      /rin_update_fence_holder_exited:.*owner acquire exploded/s,
    );

    const recoveryPath = path.join(root, "recover-holder.mjs");
    await fs.writeFile(
      recoveryPath,
      `import fs from "node:fs";
export async function acquireDaemonUpdateFence(agentDir) {
  const marker = agentDir + "/release-attempted";
  return {
    owner: { pid: process.pid, token: "recover-owner", createdAt: new Date().toISOString(), purpose: "update" },
    async release() {
      if (!fs.existsSync(marker)) { fs.mkdirSync(agentDir, { recursive: true }); fs.writeFileSync(marker, "1"); throw new Error("first release failed"); }
    },
  };
}\n`,
    );
    const recovered = await acquireTargetDaemonUpdateFence({
      ...options,
      lockModulePath: recoveryPath,
    });
    await recovered.release();
    await recovered.release();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("updater fail-stops when a ready holder loses its kernel lease", async () => {
  const root = await makeTempDir("rin-lost-update-holder-");
  const fakeLockModulePath = path.join(root, "fake-lock.mjs");
  const agentDir = path.join(root, "agent");
  const socketPath = path.join(agentDir, "runtime", "daemon.sock");
  await fs.writeFile(
    fakeLockModulePath,
    `export async function acquireDaemonUpdateFence() {
  const owner = { pid: process.pid, token: "doomed-holder", createdAt: new Date().toISOString(), purpose: "update" };
  setTimeout(() => process.exit(91), 500);
  return { owner, async release() {} };
}\n`,
  );
  const script = String.raw`
import { pathToFileURL } from "node:url";
const [holderModulePath, lockModulePath, agentDir, socketPath, targetUser, nodePath] = process.argv.slice(1);
const { acquireTargetDaemonUpdateFence } = await import(pathToFileURL(holderModulePath).href);
await acquireTargetDaemonUpdateFence({ targetUser, nodePath, lockModulePath, agentDir, socketPath });
process.stdout.write("updater-ready\n");
setInterval(() => {}, 1000);
`;
  const updater = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      script,
      holderModulePath,
      fakeLockModulePath,
      agentDir,
      socketPath,
      os.userInfo().username,
      process.execPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  updater.stderr.setEncoding("utf8");
  updater.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`updater ready timeout: ${stderr}`)),
        10_000,
      );
      updater.stdout.setEncoding("utf8");
      updater.stdout.on("data", (chunk) => {
        if (!chunk.includes("updater-ready")) return;
        clearTimeout(timer);
        resolve();
      });
      updater.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(
          new Error(
            `updater exited before ready: code=${code} signal=${signal} stderr=${stderr}`,
          ),
        );
      });
    });
    const exit = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`updater exit timeout: ${stderr}`)),
        10_000,
      );
      updater.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    assert.equal(exit.code, 70);
    assert.equal(exit.signal, null);
    assert.match(stderr, /rin_update_fence_holder_lost: purpose=update/);
  } finally {
    if (updater.exitCode == null && updater.signalCode == null) {
      updater.kill("SIGKILL");
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test(
  "update fence holder releases when an interrupted updater loses its pipe",
  { skip: process.platform === "win32" },
  async () => {
    const agentDir = await makeTempDir("rin-interrupted-update-fence-");
    const socketPath = path.join(agentDir, "runtime", "daemon.sock");
    const script = String.raw`
import { pathToFileURL } from "node:url";
const [holderModulePath, lockModulePath, agentDir, socketPath, targetUser, nodePath] = process.argv.slice(1);
const { acquireTargetDaemonUpdateFence } = await import(pathToFileURL(holderModulePath).href);
const fence = await acquireTargetDaemonUpdateFence({ targetUser, nodePath, lockModulePath, agentDir, socketPath });
process.stdout.write(JSON.stringify({ event: "ready", owner: fence.owner }) + "\n");
setInterval(() => {}, 1000);
`;
    const updater = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        script,
        holderModulePath,
        lockModulePath,
        agentDir,
        socketPath,
        os.userInfo().username,
        process.execPath,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stderr = "";
    updater.stderr.setEncoding("utf8");
    updater.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    try {
      const owner = await new Promise<any>((resolve, reject) => {
        let stdout = "";
        const timer = setTimeout(
          () => reject(new Error(`updater ready timeout: ${stderr}`)),
          10_000,
        );
        updater.stdout.setEncoding("utf8");
        updater.stdout.on("data", (chunk) => {
          stdout += chunk;
          const newline = stdout.indexOf("\n");
          if (newline < 0) return;
          clearTimeout(timer);
          resolve(JSON.parse(stdout.slice(0, newline)).owner);
        });
        updater.once("exit", (code, signal) => {
          clearTimeout(timer);
          reject(
            new Error(
              `updater exited before ready: code=${code} signal=${signal} stderr=${stderr}`,
            ),
          );
        });
      });
      assert.equal(owner.purpose, "update");
      updater.kill("SIGKILL");
      await waitUntil(async () => {
        try {
          await fs.stat(daemonUpdateFencePath(agentDir, { socketPath }));
          return false;
        } catch (error: any) {
          if (error?.code === "ENOENT") return true;
          throw error;
        }
      });
      const lock = await acquireDaemonInstanceLock(agentDir, { socketPath });
      await lock.release();
    } finally {
      if (updater.exitCode == null && updater.signalCode == null) {
        updater.kill("SIGKILL");
      }
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  },
);
