import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const restartJob = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "restart-job.js"))
    .href
);
const independentJob = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "independent-job.js"))
    .href
);

function queuedRecord(jobPath, overrides = {}) {
  return {
    version: 1,
    kind: "restart",
    id: "rin-restart-owner-test",
    targetUser: "rin",
    installDir: path.dirname(path.dirname(path.dirname(jobPath))),
    command: "/runtime/node",
    args: ["/release/dist/app/rin/main.js", "restart", "--user", "rin"],
    cwd: "/release",
    environment: {
      RIN_DIR: "/Users/rin/.rin",
      RIN_DAEMON_WORKER_OWNER: "rin",
      RIN_UPDATE_JOB_AUTH: "forbidden-auth",
      RIN_UPDATE_JOB_TOKEN: "forbidden-token",
    },
    executorEntryPath: "/release/dist/app/rin/restart-job.js",
    waitForPid: 777,
    status: { state: "queued", createdAt: "2026-09-04T00:00:00.000Z" },
    ...overrides,
  };
}

test("restart daemon ownership matches an exact cgroup unit boundary", () => {
  const exact = "0::/user.slice/rin-daemon-rin.service\n";
  const padded = "0::/user.slice/rin-daemon-rin.service-extra\n";
  assert.equal(
    independentJob.isDaemonOwnedInvocation("rin", {
      platform: "linux",
      env: {},
      readFile: () => exact,
    }),
    true,
  );
  assert.equal(
    independentJob.isDaemonOwnedInvocation("rin", {
      platform: "linux",
      env: {},
      readFile: () => padded,
    }),
    false,
  );
});

test("macOS daemon-owned restart launches a kicked independent LaunchAgent", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-restart-mac-"),
  );
  const calls = [];
  let servicePath;
  try {
    const launched = await restartJob.launchIndependentRestartJob(
      {
        targetUser: "rin",
        installDir,
        nodePath: "/runtime/node",
        rinEntryPath: "/release/dist/app/rin/main.js",
        executorEntryPath: "/release/dist/app/rin/restart-job.js",
        restartArgs: ["restart", "--user", "rin"],
        cwd: "/release",
        callerPid: 777,
      },
      {
        platform: "darwin",
        env: {
          HOME: "/Users/rin",
          RIN_DIR: "/Users/rin/.rin",
          RIN_DAEMON_WORKER_OWNER: "rin",
          RIN_UPDATE_JOB_AUTH: "must-not-forward",
        },
        randomId: () => "mac123",
        now: () => "2026-09-04T00:00:00.000Z",
        runSync(command, args) {
          calls.push({ command, args });
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );
    assert.equal(launched.detached, true);
    assert.equal(launched.launcher, "launchd");
    assert.deepEqual(
      calls.map((call) => call.args[0]),
      ["bootout", "bootstrap", "kickstart"],
    );
    const record = JSON.parse(await fs.readFile(launched.jobPath, "utf8"));
    assert.deepEqual(calls[2].args, [
      "kickstart",
      `${record.launcher.domain}/${record.launcher.label}`,
    ]);
    assert.equal(record.kind, "restart");
    assert.equal(record.waitForPid, 777);
    assert.equal(record.status.state, "queued");
    assert.equal(record.environment.RIN_DAEMON_WORKER_OWNER, undefined);
    assert.equal(record.environment.RIN_UPDATE_JOB_AUTH, undefined);
    servicePath = record.launcher.servicePath;
  } finally {
    if (servicePath) await fs.rm(servicePath, { force: true });
    await fs.rm(installDir, { recursive: true, force: true });
  }
});

test("Windows restart confirms detached executor spawn before accepting", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-restart-windows-"),
  );
  const child = new EventEmitter();
  let unrefCount = 0;
  child.unref = () => {
    unrefCount += 1;
  };
  let spawned;
  const launching = restartJob.launchIndependentRestartJob(
    {
      targetUser: "rin",
      installDir,
      nodePath: "C:\\runtime\\node.exe",
      rinEntryPath: "C:\\release\\dist\\app\\rin\\main.js",
      executorEntryPath: "C:\\release\\dist\\app\\rin\\restart-job.js",
      restartArgs: ["restart", "--user", "rin"],
      cwd: "C:\\release",
      callerPid: 777,
    },
    {
      platform: "win32",
      env: { RIN_DAEMON_WORKER_OWNER: "rin" },
      randomId: () => "win123",
      spawnProcess(command, args, options) {
        spawned = { command, args, options };
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
    },
  );
  const launched = await launching;
  assert.equal(launched.launcher, "windows-detached");
  assert.equal(spawned.command, "powershell.exe");
  assert.equal(spawned.options.detached, true);
  assert.equal(unrefCount, 1);
  await fs.rm(installDir, { recursive: true, force: true });
});

test("restart executor waits for caller exit and strips daemon and update authority", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-restart-executor-"),
  );
  const jobPath = path.join(installDir, "jobs", "restart", "job.json");
  await fs.mkdir(path.dirname(jobPath), { recursive: true });
  await fs.writeFile(jobPath, JSON.stringify(queuedRecord(jobPath)));
  const writes = [];
  const waits = [];
  let childOptions;
  const child = new EventEmitter();
  child.pid = 9001;
  const completed = restartJob.runRestartJobExecutor(jobPath, {
    waitForProcessExit: async (pid) => waits.push(pid),
    spawnProcess(command, args, options) {
      assert.equal(command, "/runtime/node");
      assert.deepEqual(args.slice(-3), ["restart", "--user", "rin"]);
      childOptions = options;
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    },
    now: (() => {
      const values = ["2026-09-04T00:00:01.000Z", "2026-09-04T00:00:02.000Z"];
      return () => values.shift();
    })(),
    writeRecord(_path, record) {
      writes.push(structuredClone(record));
    },
    cleanupLauncher() {},
  });
  const result = await completed;
  assert.deepEqual(waits, [777]);
  assert.equal(childOptions.env.RIN_DIR, "/Users/rin/.rin");
  assert.equal(childOptions.env.RIN_DAEMON_WORKER_OWNER, undefined);
  assert.equal(childOptions.env.RIN_UPDATE_JOB_AUTH, undefined);
  assert.equal(childOptions.env.RIN_UPDATE_JOB_TOKEN, undefined);
  assert.deepEqual(
    writes.map((record) => record.status.state),
    ["running", "succeeded"],
  );
  assert.equal(result.status.state, "succeeded");
  await fs.rm(installDir, { recursive: true, force: true });
});

test("restart executor rejects an update job record", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-restart-kind-"),
  );
  const jobPath = path.join(installDir, "jobs", "restart", "job.json");
  await fs.mkdir(path.dirname(jobPath), { recursive: true });
  await fs.writeFile(
    jobPath,
    JSON.stringify(queuedRecord(jobPath, { kind: "update" })),
  );
  await assert.rejects(
    restartJob.runRestartJobExecutor(jobPath),
    /rin_independent_job_kind_mismatch:restart:update/,
  );
  await fs.rm(installDir, { recursive: true, force: true });
});
