import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const updateJob = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "update-job.js")).href
);

test("updater detects only the target daemon systemd cgroup", () => {
  assert.equal(
    updateJob.isProcessInTargetDaemonCgroup("rin", {
      platform: "linux",
      cgroupText:
        "0::/user.slice/user-1001.slice/user@1001.service/app.slice/rin-daemon-rin.service/workers/worker_1-42\n",
    }),
    true,
  );
  assert.equal(
    updateJob.isProcessInTargetDaemonCgroup("other", {
      platform: "linux",
      cgroupText:
        "0::/user.slice/user-1001.slice/user@1001.service/app.slice/rin-daemon-rin.service/workers/worker_1-42\n",
    }),
    false,
  );
  assert.equal(
    updateJob.isProcessInTargetDaemonCgroup("rin", {
      platform: "darwin",
      cgroupText: "rin-daemon-rin.service",
    }),
    false,
  );
});

test("daemon-owned update launches an installer-owned transient service", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-update-job-"),
  );
  const calls = [];
  try {
    const launched = updateJob.launchDaemonIndependentUpdateJob(
      {
        targetUser: "rin",
        installDir,
        nodePath: "/runtime/node",
        updateEntryPath: "/release/dist/app/rin-install/main.js",
        executorEntryPath: "/release/dist/app/rin-install/update-job.js",
        updateArgs: ["--update", "--yes"],
        cwd: "/release",
      },
      {
        platform: "linux",
        cgroupText: "0::/rin-daemon-rin.service/workers/worker_1-42\n",
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
      "/release/dist/app/rin-install/main.js",
      "--update",
      "--yes",
    ]);
    assert.equal((await fs.stat(launched.jobPath)).mode & 0o777, 0o600);
  } finally {
    await fs.rm(installDir, { recursive: true, force: true });
  }
});

test("update job launcher stays synchronous outside the target daemon", () => {
  const launched = updateJob.launchDaemonIndependentUpdateJob(
    {
      targetUser: "rin",
      installDir: "/home/rin/.rin",
      nodePath: "/runtime/node",
      updateEntryPath: "/release/updater.js",
      executorEntryPath: "/release/executor.js",
      updateArgs: [],
      cwd: "/release",
    },
    {
      platform: "linux",
      cgroupText: "0::/user.slice/rin-update-rin-job.service\n",
      execFileSync() {
        throw new Error("must not launch");
      },
    },
  );
  assert.equal(launched, null);
});

test("update job executor persists terminal success", async () => {
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
    })}\n`,
    { mode: 0o600 },
  );
  const child = new EventEmitter();
  child.pid = 42;
  try {
    const resultPromise = updateJob.runUpdateJobExecutor(jobPath, {
      now: () => new Date("2026-07-17T04:01:00.000Z"),
      spawnImpl(command, args, options) {
        assert.equal(command, "/runtime/node");
        assert.deepEqual(args, ["updater.js"]);
        assert.equal(options.cwd, "/release");
        process.nextTick(() => child.emit("exit", 0, null));
        return child;
      },
    });
    assert.equal(await resultPromise, 0);
    const record = JSON.parse(await fs.readFile(jobPath, "utf8"));
    assert.equal(record.status, "succeeded");
    assert.equal(record.pid, 42);
    assert.equal(record.exitCode, 0);
    assert.equal(record.finishedAt, "2026-07-17T04:01:00.000Z");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
