import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const cgroup = await importBuiltModule<
  typeof import("../../src/core/rin-daemon/worker-cgroup-isolation.js")
>("dist/core/rin-daemon/worker-cgroup-isolation.js");

function fakeCgroup(selfPath: string, score = 100) {
  const servicePath = selfPath.endsWith("/daemon")
    ? path.posix.dirname(selfPath)
    : selfPath;
  const files = new Map<string, string>([
    ["/proc/self/cgroup", `0::${selfPath}\n`],
    ["/proc/self/oom_score_adj", `${score}\n`],
    [`/sys/fs/cgroup${servicePath}/cgroup.controllers`, "memory pids\n"],
  ]);
  const directories = new Set<string>();
  const writes: Array<[string, string]> = [];
  const warnings: string[] = [];
  const deps: any = {
    platform: "linux",
    env: { [cgroup.WORKER_CGROUP_DELEGATION_ENV]: "1" },
    pid: 101,
    readText(filePath: string) {
      const value = files.get(filePath);
      if (value === undefined) {
        const error: NodeJS.ErrnoException = new Error(`missing:${filePath}`);
        error.code = "ENOENT";
        throw error;
      }
      return value;
    },
    writeText(filePath: string, value: string) {
      writes.push([filePath, value]);
      files.set(filePath, value);
    },
    mkdir(filePath: string) {
      if (directories.has(filePath)) {
        const error: NodeJS.ErrnoException = new Error("exists");
        error.code = "EEXIST";
        throw error;
      }
      directories.add(filePath);
    },
    rmdir(filePath: string) {
      directories.delete(filePath);
    },
    exists(filePath: string) {
      return files.has(filePath) || filePath.endsWith("/cgroup.kill");
    },
    async sleep() {},
    sleepSync() {},
    warn(message: string) {
      warnings.push(message);
    },
  };
  return { servicePath, files, directories, writes, warnings, deps };
}

const delegatedPath =
  "/user.slice/user-1000.slice/user@1000.service/app.slice/rin.service/daemon";

test("default filesystem dependencies retain the real cgroup adapter contract", async () => {
  const fake = fakeCgroup(delegatedPath);
  const original = {
    readFileSync: fs.readFileSync,
    writeFileSync: fs.writeFileSync,
    mkdirSync: fs.mkdirSync,
    rmdirSync: fs.rmdirSync,
    existsSync: fs.existsSync,
  };
  fs.readFileSync = ((filePath: fs.PathOrFileDescriptor) =>
    fake.deps.readText(String(filePath))) as typeof fs.readFileSync;
  fs.writeFileSync = ((filePath: fs.PathOrFileDescriptor, value: any) =>
    fake.deps.writeText(
      String(filePath),
      String(value),
    )) as typeof fs.writeFileSync;
  fs.mkdirSync = ((filePath: fs.PathLike) =>
    fake.deps.mkdir(String(filePath))) as typeof fs.mkdirSync;
  fs.rmdirSync = ((filePath: fs.PathLike) =>
    fake.deps.rmdir(String(filePath))) as typeof fs.rmdirSync;
  fs.existsSync = ((filePath: fs.PathLike) =>
    fake.deps.exists(String(filePath))) as typeof fs.existsSync;
  try {
    const isolation = cgroup.createWorkerCgroupIsolation({
      platform: fake.deps.platform,
      env: fake.deps.env,
      pid: fake.deps.pid,
      sleep: fake.deps.sleep,
      sleepSync: fake.deps.sleepSync,
      warn: fake.deps.warn,
    });
    assert.ok(isolation);
    const lease = isolation.attachWorker("default-fs", 201);
    const workerPath = `/sys/fs/cgroup${fake.servicePath}/workers/default-fs-201`;
    fake.files.set(`${workerPath}/cgroup.events`, "populated 0\n");
    assert.equal(await lease.cleanup(), true);
  } finally {
    Object.assign(fs, original);
  }
});

test("worker cgroup isolation attaches, detects OOM, and releases a worker", async () => {
  const fake = fakeCgroup(delegatedPath);
  const isolation = cgroup.createWorkerCgroupIsolation(fake.deps);
  assert.ok(isolation);

  const lease = isolation.attachWorker("worker unsafe/id", 202);
  const workerPath = `/sys/fs/cgroup${fake.servicePath}/workers/worker_unsafe_id-202`;
  assert.ok(fake.directories.has(workerPath));
  assert.ok(
    fake.writes.some(
      ([filePath, value]) =>
        filePath === `${workerPath}/memory.oom.group` && value === "1\n",
    ),
  );
  assert.ok(
    fake.writes.some(
      ([filePath, value]) =>
        filePath === `${workerPath}/memory.high` && value === "1073741824\n",
    ),
  );
  assert.ok(
    fake.writes.some(
      ([filePath, value]) =>
        filePath === `${workerPath}/memory.max` && value === "1610612736\n",
    ),
  );
  assert.ok(
    fake.writes.some(
      ([filePath, value]) =>
        filePath === "/proc/202/oom_score_adj" && value === "500\n",
    ),
  );

  fake.files.set(`${workerPath}/memory.events.local`, "oom_kill 1\n");
  fake.files.set(`${workerPath}/cgroup.events`, "populated 0\n");
  assert.equal(lease.wasOomKilled(), true);
  assert.equal(await lease.cleanup(), true);
  assert.equal(fake.directories.has(workerPath), false);
});

test("worker cgroup isolation supports old service roots and bounded cleanup waits", async () => {
  const servicePath = delegatedPath.replace(/\/daemon$/, "");
  const fake = fakeCgroup(servicePath, 1000);
  let sleeps = 0;
  fake.deps.sleep = async () => {
    sleeps += 1;
    for (const filePath of fake.files.keys()) {
      if (filePath.endsWith("/cgroup.events")) {
        fake.files.set(filePath, "populated 0\n");
      }
    }
  };
  const isolation = cgroup.createWorkerCgroupIsolation(fake.deps);
  assert.ok(isolation);
  assert.ok(
    fake.writes.some(
      ([filePath, value]) =>
        filePath === `/sys/fs/cgroup${servicePath}/daemon/cgroup.procs` &&
        value === "101\n",
    ),
  );
  const lease = isolation.attachWorker("worker", 303);
  const workerPath = `/sys/fs/cgroup${servicePath}/workers/worker-303`;
  fake.files.set(`${workerPath}/cgroup.events`, "populated 1\n");
  assert.equal(await lease.cleanup(), true);
  assert.equal(sleeps, 1);
  assert.ok(fake.warnings.some((message) => /cannot exceed/.test(message)));
});

test("worker cgroup isolation cleans partial attachment failures", () => {
  const fake = fakeCgroup(delegatedPath);
  const originalWrite = fake.deps.writeText;
  let syncSleeps = 0;
  fake.deps.writeText = (filePath: string, value: string) => {
    if (filePath === "/proc/404/oom_score_adj") {
      const workerPath = `/sys/fs/cgroup${fake.servicePath}/workers/broken-404`;
      fake.files.set(`${workerPath}/cgroup.events`, "populated 1\n");
      throw new Error("write denied");
    }
    originalWrite(filePath, value);
  };
  fake.deps.sleepSync = () => {
    syncSleeps += 1;
    const workerPath = `/sys/fs/cgroup${fake.servicePath}/workers/broken-404`;
    fake.files.set(`${workerPath}/cgroup.events`, "populated 0\n");
  };
  const isolation = cgroup.createWorkerCgroupIsolation(fake.deps);
  assert.ok(isolation);
  assert.throws(
    () => isolation.attachWorker("broken", 404),
    /could not attach worker broken/,
  );
  assert.equal(syncSleeps, 1);
});

test("worker cgroup isolation fails closed on invalid delegation", () => {
  const disabled = fakeCgroup(delegatedPath);
  disabled.deps.platform = "darwin";
  assert.equal(cgroup.createWorkerCgroupIsolation(disabled.deps), undefined);
  disabled.deps.platform = "linux";
  disabled.deps.env = {};
  assert.equal(cgroup.createWorkerCgroupIsolation(disabled.deps), undefined);

  const missingPath = fakeCgroup(delegatedPath);
  missingPath.files.set("/proc/self/cgroup", "1:name=systemd:/legacy\n");
  assert.throws(
    () => cgroup.createWorkerCgroupIsolation(missingPath.deps),
    /could not initialize/,
  );

  const wrongRoot = fakeCgroup("/user.slice/session.scope");
  assert.throws(
    () => cgroup.createWorkerCgroupIsolation(wrongRoot.deps),
    /could not initialize/,
  );

  const noMemory = fakeCgroup(delegatedPath);
  noMemory.files.set(
    `/sys/fs/cgroup${noMemory.servicePath}/cgroup.controllers`,
    "pids\n",
  );
  assert.throws(
    () => cgroup.createWorkerCgroupIsolation(noMemory.deps),
    /could not initialize/,
  );
});

test("worker cgroup cleanup handles vanished and persistently busy groups", async () => {
  const vanished = fakeCgroup(delegatedPath);
  vanished.deps.exists = () => false;
  const vanishedIsolation = cgroup.createWorkerCgroupIsolation(vanished.deps);
  assert.ok(vanishedIsolation);
  const vanishedLease = vanishedIsolation.attachWorker("vanished", 504);
  assert.equal(await vanishedLease.cleanup(), true);

  const busy = fakeCgroup(delegatedPath);
  let sleeps = 0;
  busy.deps.rmdir = () => {
    const error: NodeJS.ErrnoException = new Error("busy");
    error.code = "EBUSY";
    throw error;
  };
  busy.deps.sleep = async () => {
    sleeps += 1;
  };
  const busyIsolation = cgroup.createWorkerCgroupIsolation(busy.deps);
  assert.ok(busyIsolation);
  const busyLease = busyIsolation.attachWorker("busy", 506);
  const busyPath = `/sys/fs/cgroup${busy.servicePath}/workers/busy-506`;
  busy.files.set(`${busyPath}/cgroup.events`, "populated 0\n");
  assert.equal(await busyLease.cleanup(), false);
  assert.equal(sleeps, 40);
  assert.ok(
    busy.warnings.some((message) => /remained populated/.test(message)),
  );
});

test("worker cgroup lease tolerates missing counters and cleanup errors", async () => {
  const fake = fakeCgroup(delegatedPath);
  fake.deps.rmdir = () => {
    throw new Error("remove denied");
  };
  const isolation = cgroup.createWorkerCgroupIsolation(fake.deps);
  assert.ok(isolation);
  const lease = isolation.attachWorker("worker", 505);
  assert.equal(lease.wasOomKilled(), false);

  const workerPath = `/sys/fs/cgroup${fake.servicePath}/workers/worker-505`;
  fake.files.set(`${workerPath}/cgroup.events`, "populated 0\n");
  assert.equal(await lease.cleanup(), false);
  assert.ok(fake.warnings.some((message) => /remove/.test(message)));
});
