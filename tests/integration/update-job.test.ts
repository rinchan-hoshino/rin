import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const updateJob = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "update-job.js")).href
);

test("daemon ownership uses exact cgroup unit boundaries", () => {
  assert.equal(
    updateJob.isProcessInTargetDaemonCgroup("rin", {
      platform: "linux",
      cgroupText: "0::/user.slice/app.slice/rin-daemon-rin.service",
    }),
    true,
  );
  assert.equal(
    updateJob.isProcessInTargetDaemonCgroup("rin", {
      platform: "linux",
      cgroupText: "0::/user.slice/app.slice/not-rin-daemon-rin.service",
    }),
    false,
  );
  assert.equal(
    updateJob.isProcessInTargetDaemonCgroup("rin", {
      platform: "darwin",
      cgroupText: "0::/rin-daemon-rin.service",
    }),
    false,
  );
  assert.equal(
    updateJob.isDaemonOwnedUpdate("rin", {
      platform: "linux",
      cgroupText: "0::/user.slice/app.slice/rin-daemon-rin.service",
      env: {},
    }),
    true,
  );
});

test("daemon ownership accepts the explicit worker owner contract", () => {
  assert.equal(
    updateJob.isDaemonOwnedUpdate("rin", {
      platform: "linux",
      cgroupText: "0::/user.slice/user-1000.slice/session-1.scope",
      env: { RIN_DAEMON_WORKER_OWNER: "rin" },
    }),
    true,
  );
  assert.equal(
    updateJob.isDaemonOwnedUpdate("other", {
      platform: "linux",
      cgroupText: "0::/user.slice/user-1000.slice/session-1.scope",
      env: { RIN_DAEMON_WORKER_OWNER: "rin" },
    }),
    false,
  );
});

test("Linux update launches an installer-owned transient service", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-update-job-"),
  );
  const calls = [];
  try {
    const launched = updateJob.launchIndependentUpdateJob(
      {
        targetUser: "rin",
        installDir,
        nodePath: "/runtime/node",
        updateEntryPath: "/release/dist/app/rin-install/update-payload.js",
        executorEntryPath: "/release/dist/app/rin-install/update-job.js",
        updateArgs: ["--yes"],
        cwd: "/release",
      },
      {
        platform: "linux",
        env: { RIN_DAEMON_WORKER_OWNER: "rin" },
        now: () => new Date("2026-07-17T04:00:00.000Z"),
        randomId: () => "abc123",
        systemdRunPath: "/usr/bin/systemd-run",
        execFileSync(command, args, options) {
          calls.push({ command, args, options });
          return "Running as unit";
        },
      },
    );

    assert.equal(launched?.detached, true);
    assert.match(launched.unit, /^rin-update-rin-/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "/usr/bin/systemd-run");
    assert.ok(calls[0].args.includes("--collect"));
    assert.ok(calls[0].args.includes("--property=Type=exec"));
    assert.equal(calls[0].args.at(-3), "/runtime/node");
    assert.equal(
      calls[0].args.at(-2),
      "/release/dist/app/rin-install/update-job.js",
    );
    assert.equal(calls[0].args.at(-1), launched.jobPath);

    const record = JSON.parse(await fs.readFile(launched.jobPath, "utf8"));
    assert.equal(record.status, "queued");
    assert.equal(record.command, "/runtime/node");
    assert.deepEqual(record.args, [
      "/release/dist/app/rin-install/update-payload.js",
      "--yes",
    ]);
    assert.equal((await fs.stat(launched.jobPath)).mode & 0o777, 0o600);
  } finally {
    await fs.rm(installDir, { recursive: true, force: true });
  }
});

test("macOS update launches a separate LaunchAgent", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-update-mac-"),
  );
  const calls = [];
  try {
    const launched = updateJob.launchIndependentUpdateJob(
      {
        targetUser: "rin",
        installDir,
        nodePath: "/runtime/node",
        updateEntryPath: "/release/updater.js",
        executorEntryPath: "/release/executor.js",
        updateArgs: [],
        cwd: "/release",
      },
      {
        platform: "darwin",
        env: {
          RIN_DAEMON_WORKER_OWNER: "rin",
          RIN_DIR: "/Users/rin/.rin-custom",
          HTTPS_PROXY: "http://proxy.example",
          HOME: "/Users/rin",
        },
        uid: 501,
        now: () => new Date("2026-07-17T04:00:00.000Z"),
        randomId: () => "mac123",
        launchctlPath: "/bin/launchctl",
        execFileSync(command, args) {
          calls.push({ command, args });
          return "";
        },
      },
    );
    assert.equal(launched?.launcher, "launchd");
    assert.equal(calls[0].command, "/bin/launchctl");
    assert.deepEqual(calls[0].args.slice(0, 2), ["bootstrap", "gui/501"]);
    const plistPath = calls[0].args[2];
    const plist = await fs.readFile(plistPath, "utf8");
    assert.match(plist, /<string>\/runtime\/node<\/string>/);
    assert.match(plist, /<string>\/release\/executor\.js<\/string>/);
    assert.match(plist, new RegExp(launched.id));
    assert.match(
      plist,
      /<key>RIN_DIR<\/key>\s*<string>\/Users\/rin\/\.rin-custom<\/string>/,
    );
    assert.match(
      plist,
      /<key>HTTPS_PROXY<\/key>\s*<string>http:\/\/proxy\.example<\/string>/,
    );
    assert.doesNotMatch(plist, /RIN_DAEMON_WORKER_OWNER/);
    assert.equal(
      launched.logHint,
      path.join(path.dirname(launched.jobPath), `${launched.id}.log`),
    );
  } finally {
    await fs.rm(installDir, { recursive: true, force: true });
  }
});

test("Windows update launches a detached executor", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-update-win-"),
  );
  const calls = [];
  try {
    const launched = updateJob.launchIndependentUpdateJob(
      {
        targetUser: "rin",
        installDir,
        nodePath: "C:\\Rin\\node.exe",
        updateEntryPath: "C:\\Rin\\updater.js",
        executorEntryPath: "C:\\Rin\\executor.js",
        updateArgs: [],
        cwd: "C:\\Rin",
      },
      {
        platform: "win32",
        env: { RIN_DAEMON_WORKER_OWNER: "rin" },
        now: () => new Date("2026-07-17T04:00:00.000Z"),
        randomId: () => "win123",
        execFileSync(command, args, options) {
          calls.push({ command, args, options });
          return "";
        },
      },
    );
    assert.equal(launched?.launcher, "windows-detached");
    assert.equal(calls[0].command, "C:\\Rin\\node.exe");
    assert.deepEqual(calls[0].args, [
      "C:\\Rin\\executor.js",
      "--detach",
      launched.jobPath,
    ]);
    assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(
      launched.logHint,
      path.join(path.dirname(launched.jobPath), `${launched.id}.log`),
    );
  } finally {
    await fs.rm(installDir, { recursive: true, force: true });
  }
});

test("Windows detached launcher waits for a successful spawn", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-update-win-ack-"));
  const jobPath = path.join(dir, "job.json");
  await fs.writeFile(
    jobPath,
    `${JSON.stringify({
      version: 1,
      id: "job-win",
      status: "queued",
      createdAt: "2026-07-17T04:00:00.000Z",
      command: "/runtime/node",
      args: ["updater.js"],
      cwd: "/release",
    })}\n`,
    { mode: 0o600 },
  );
  const child = new EventEmitter();
  let unrefCount = 0;
  child.unref = () => {
    unrefCount += 1;
  };
  try {
    const launched = updateJob.launchWindowsDetachedUpdateJob(
      "/release/executor.js",
      jobPath,
      {
        spawnImpl(command, args, options) {
          assert.equal(command, "/runtime/node");
          assert.deepEqual(args, ["/release/executor.js", jobPath]);
          assert.equal(options.detached, true);
          process.nextTick(() => child.emit("spawn"));
          return child;
        },
      },
    );
    await launched;
    assert.equal(unrefCount, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Windows detached launcher rejects an asynchronous spawn error", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-update-win-error-"));
  const jobPath = path.join(dir, "job.json");
  await fs.writeFile(
    jobPath,
    `${JSON.stringify({
      version: 1,
      id: "job-win-error",
      status: "queued",
      createdAt: "2026-07-17T04:00:00.000Z",
      command: "/missing/node",
      args: ["updater.js"],
      cwd: "/release",
    })}\n`,
    { mode: 0o600 },
  );
  const child = new EventEmitter();
  child.unref = () => assert.fail("failed spawn must not be unrefed");
  try {
    await assert.rejects(
      updateJob.launchWindowsDetachedUpdateJob(
        "/release/executor.js",
        jobPath,
        {
          spawnImpl() {
            process.nextTick(() => child.emit("error", new Error("ENOENT")));
            return child;
          },
        },
      ),
      /ENOENT/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("terminal updates create the same job record without a second payload path", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-update-independent-"),
  );
  const calls = [];
  try {
    const launched = updateJob.launchIndependentUpdateJob(
      {
        targetUser: "rin",
        installDir,
        nodePath: "/runtime/node",
        updateEntryPath: "/release/updater.js",
        executorEntryPath: "/release/executor.js",
        updateArgs: [],
        cwd: "/release",
      },
      {
        platform: "linux",
        env: {},
        now: () => new Date("2026-07-17T04:00:00.000Z"),
        randomId: () => "outside",
        systemdRunPath: "/usr/bin/systemd-run",
        execFileSync(command, args) {
          calls.push({ command, args });
          return "";
        },
      },
    );
    assert.equal(launched.launcher, "foreground");
    assert.equal(launched.detached, false);
    assert.equal(calls.length, 0);
    const record = JSON.parse(await fs.readFile(launched.jobPath, "utf8"));
    assert.equal(record.status, "queued");
    assert.equal(record.command, "/runtime/node");
    assert.deepEqual(record.args, ["/release/updater.js"]);
  } finally {
    await fs.rm(installDir, { recursive: true, force: true });
  }
});

test("update launcher defaults time, id, platform, and systemd discovery safely", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-update-defaults-"),
  );
  try {
    const calls = [];
    const launched = updateJob.launchIndependentUpdateJob(
      {
        targetUser: "rin",
        installDir,
        nodePath: "/runtime/node",
        updateEntryPath: "/release/updater.js",
        executorEntryPath: "/release/executor.js",
        updateArgs: [],
        cwd: "/release",
      },
      {
        env: { RIN_DAEMON_WORKER_OWNER: "rin" },
        execFileSync(command, args) {
          calls.push({ command, args });
          return "";
        },
      },
    );
    assert.equal(launched?.launcher, "systemd");
    assert.equal(calls.length, 1);
    assert.match(launched.id, /^rin-update-rin-/);
  } finally {
    await fs.rm(installDir, { recursive: true, force: true });
  }
});

test("update launcher validates user domains and cleans failed platform jobs", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-update-launch-failures-"),
  );
  const options = {
    targetUser: " rin user ",
    installDir,
    nodePath: "/runtime/node",
    updateEntryPath: "/release/updater.js",
    executorEntryPath: "/release/executor.js",
    updateArgs: [],
    cwd: "/release",
  };
  try {
    assert.throws(
      () =>
        updateJob.launchIndependentUpdateJob(options, {
          platform: "darwin",
          env: { RIN_DAEMON_WORKER_OWNER: "rin user" },
          uid: -1,
        }),
      /rin_update_launchd_user_domain_missing/,
    );

    for (const platform of ["darwin", "win32", "linux"]) {
      assert.throws(
        () =>
          updateJob.launchIndependentUpdateJob(options, {
            platform,
            env: {
              RIN_DAEMON_WORKER_OWNER: "rin user",
              HOME: "/home/<rin>&\"'",
              PATH: "bad\nvalue",
            },
            uid: 501,
            now: () => new Date("2026-07-17T04:00:00.123Z"),
            randomId: () => " -- ",
            execFileSync() {
              throw new Error(`${platform} launch failed`);
            },
          }),
        new RegExp(`${platform} launch failed`),
      );
    }
    const jobsDir = path.join(installDir, "data", "core", "updates", "jobs");
    assert.deepEqual(await fs.readdir(jobsDir).catch(() => []), []);
  } finally {
    await fs.rm(installDir, { recursive: true, force: true });
  }
});

test("update job readers reject malformed records", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-update-invalid-"));
  const jobPath = path.join(dir, "job.json");
  try {
    for (const record of [
      {},
      { version: 1, id: 1, command: "/node", args: [], cwd: "/release" },
      { version: 1, id: "id", command: "node", args: [], cwd: "/release" },
      { version: 1, id: "id", command: "/node", args: "bad", cwd: "/release" },
      { version: 1, id: "id", command: "/node", args: [1], cwd: "/release" },
      { version: 1, id: "id", command: "/node", args: [], cwd: "relative" },
    ]) {
      await fs.writeFile(jobPath, `${JSON.stringify(record)}\n`);
      await assert.rejects(
        updateJob.launchWindowsDetachedUpdateJob(
          "/release/executor.js",
          jobPath,
          { spawnImpl: assert.fail },
        ),
        /rin_update_job_invalid/,
      );
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("update job executor persists spawn and signal failures", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-update-failed-"));
  const jobPath = path.join(dir, "job.json");
  const baseRecord = {
    version: 1,
    id: "job-failed",
    status: "queued",
    createdAt: "2026-07-17T04:00:00.000Z",
    command: "/runtime/node",
    args: ["updater.js"],
    cwd: "/release",
    cleanup: {
      command: "/missing/cleanup",
      args: ["done"],
      removePaths: [path.join(dir, "already-missing")],
    },
  };
  try {
    await fs.writeFile(jobPath, `${JSON.stringify(baseRecord)}\n`);
    const spawnFailure = new EventEmitter();
    const failed = updateJob.runUpdateJobExecutor(jobPath, {
      now: () => new Date("2026-07-17T04:02:00.000Z"),
      spawnImpl() {
        process.nextTick(() =>
          spawnFailure.emit("error", new Error("spawn failed")),
        );
        return spawnFailure;
      },
      execFileSync() {
        throw new Error("cleanup unavailable");
      },
    });
    await assert.rejects(failed, /spawn failed/);
    assert.equal(
      JSON.parse(await fs.readFile(jobPath, "utf8")).status,
      "failed",
    );

    await fs.writeFile(jobPath, `${JSON.stringify(baseRecord)}\n`);
    await assert.rejects(
      updateJob.runUpdateJobExecutor(jobPath, {
        spawnImpl() {
          throw new Error("synchronous spawn failed");
        },
        execFileSync() {
          return "";
        },
      }),
      /synchronous spawn failed/,
    );
    assert.equal(
      JSON.parse(await fs.readFile(jobPath, "utf8")).status,
      "failed",
    );

    await fs.writeFile(jobPath, `${JSON.stringify(baseRecord)}\n`);
    const signaled = new EventEmitter();
    const result = updateJob.runUpdateJobExecutor(jobPath, {
      spawnImpl() {
        process.nextTick(() => signaled.emit("exit", null, "SIGTERM"));
        return signaled;
      },
      execFileSync() {
        return "";
      },
    });
    assert.equal(await result, 1);
    const record = JSON.parse(await fs.readFile(jobPath, "utf8"));
    assert.equal(record.status, "failed");
    assert.equal(record.signal, "SIGTERM");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("update job executor persists terminal success and unloads a temporary launcher", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-update-executor-"));
  const jobPath = path.join(dir, "job.json");
  await fs.writeFile(
    jobPath,
    `${JSON.stringify({
      version: 1,
      id: "job-1",
      status: "queued",
      createdAt: "2026-07-17T04:00:00.000Z",
      command: "/runtime/node",
      args: ["updater.js"],
      cwd: "/release",
      cleanup: {
        command: "/bin/launchctl",
        args: ["bootout", "gui/501/job-1"],
        removePaths: [path.join(dir, "job-1.plist")],
      },
    })}\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(path.join(dir, "job-1.plist"), "plist");
  const child = new EventEmitter();
  child.pid = 42;
  const cleanupCalls = [];
  try {
    const resultPromise = updateJob.runUpdateJobExecutor(jobPath, {
      now: () => new Date("2026-07-17T04:01:00.000Z"),
      spawnImpl(command, args, options) {
        assert.equal(command, "/runtime/node");
        assert.deepEqual(args, ["updater.js"]);
        assert.equal(options.cwd, "/release");
        assert.equal(options.env.RIN_UPDATE_JOB_PATH, jobPath);
        assert.equal(options.env.RIN_UPDATE_JOB_ID, "job-1");
        assert.equal(options.stdio, "inherit");
        assert.equal(
          JSON.parse(fsSync.readFileSync(jobPath, "utf8")).status,
          "running",
        );
        process.nextTick(() => child.emit("exit", 0, null));
        return child;
      },
      execFileSync(command, args) {
        cleanupCalls.push({ command, args });
        return "";
      },
    });
    assert.equal(await resultPromise, 0);
    const record = JSON.parse(await fs.readFile(jobPath, "utf8"));
    assert.equal(record.status, "succeeded");
    assert.equal(record.pid, 42);
    assert.equal(record.exitCode, 0);
    assert.equal(record.finishedAt, "2026-07-17T04:01:00.000Z");
    assert.equal(
      await fs.stat(path.join(dir, "job-1.plist")).catch(() => null),
      null,
    );
    assert.deepEqual(cleanupCalls, [
      {
        command: "/bin/launchctl",
        args: ["bootout", "gui/501/job-1"],
      },
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
