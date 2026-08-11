import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const { createWorkerCgroupIsolation } = await import(
  pathToFileURL(
    path.join(
      rootDir,
      "dist",
      "core",
      "rin-daemon",
      "worker-cgroup-isolation.js",
    ),
  ).href
);

function createFakeCgroupFs(selfPath: string, daemonOomScore = 200) {
  const files = new Map<string, string>([
    ["/proc/self/cgroup", `0::${selfPath}\n`],
    ["/proc/self/oom_score_adj", `${daemonOomScore}\n`],
  ]);
  const directories = new Set<string>();
  const writes: Array<[string, string]> = [];
  const removed: string[] = [];
  const serviceRoot = selfPath.endsWith("/daemon")
    ? path.posix.dirname(selfPath)
    : selfPath;
  files.set(`/sys/fs/cgroup${serviceRoot}/cgroup.controllers`, "memory pids\n");

  return {
    files,
    directories,
    writes,
    removed,
    deps: {
      platform: "linux",
      env: { RIN_SYSTEMD_CGROUP_DELEGATION: "1" },
      pid: 101,
      readText(filePath: string) {
        const value = files.get(filePath);
        if (value == null) throw new Error(`missing:${filePath}`);
        return value;
      },
      writeText(filePath: string, value: string) {
        writes.push([filePath, value]);
        files.set(filePath, value);
      },
      mkdir(filePath: string) {
        directories.add(filePath);
      },
      rmdir(filePath: string) {
        removed.push(filePath);
        directories.delete(filePath);
      },
      exists(filePath: string) {
        return files.has(filePath) || filePath.endsWith("/cgroup.kill");
      },
      async sleep() {},
      sleepSync() {},
      warn(_message: string) {},
    },
  };
}

test("delegated isolation moves an older-systemd daemon into a leaf subgroup", () => {
  const selfPath =
    "/user.slice/user-1001.slice/user@1001.service/app.slice/rin-daemon-demo.service";
  const fake = createFakeCgroupFs(selfPath, 800);
  const isolation = createWorkerCgroupIsolation(fake.deps);

  assert.ok(isolation);
  assert.ok(
    fake.writes.some(
      ([filePath, value]) =>
        filePath === `/sys/fs/cgroup${selfPath}/daemon/cgroup.procs` &&
        value === "101\n",
    ),
  );
  isolation.attachWorker("worker_2", 303);
  assert.ok(
    fake.writes.some(
      ([filePath, value]) =>
        filePath === "/proc/303/oom_score_adj" && value === "1000\n",
    ),
  );
});

test("worker cgroup isolation reports when daemon OOM preference is already maximal", () => {
  const selfPath =
    "/user.slice/user-1001.slice/user@1001.service/app.slice/rin-daemon-demo.service/daemon";
  const fake = createFakeCgroupFs(selfPath, 1000);
  const warnings: string[] = [];
  fake.deps.warn = (message) => warnings.push(message);
  const isolation = createWorkerCgroupIsolation(fake.deps);

  assert.ok(isolation);
  isolation.attachWorker("worker_1", 202);
  assert.ok(
    warnings.some((message) => /cannot exceed the daemon/i.test(message)),
  );
  assert.ok(
    fake.writes.some(
      ([filePath, value]) =>
        filePath === "/proc/202/oom_score_adj" && value === "1000\n",
    ),
  );
});

test("worker cgroup attach fails closed when OOM preference cannot be written", () => {
  const selfPath =
    "/user.slice/user-1001.slice/user@1001.service/app.slice/rin-daemon-demo.service/daemon";
  const fake = createFakeCgroupFs(selfPath);
  const workerPath = `/sys/fs/cgroup${path.posix.dirname(selfPath)}/workers/worker_1-202`;
  let cleanupSleeps = 0;
  const writeText = fake.deps.writeText;
  fake.deps.writeText = (filePath, value) => {
    if (filePath === "/proc/202/oom_score_adj") {
      fake.files.set(`${workerPath}/cgroup.events`, "populated 1\n");
      const error = new Error("denied");
      (error as NodeJS.ErrnoException).code = "EACCES";
      throw error;
    }
    writeText(filePath, value);
  };
  fake.deps.sleepSync = () => {
    cleanupSleeps += 1;
    fake.files.set(`${workerPath}/cgroup.events`, "populated 0\n");
  };
  const isolation = createWorkerCgroupIsolation(fake.deps);

  assert.ok(isolation);
  assert.throws(
    () => isolation.attachWorker("worker_1", 202),
    /could not attach/i,
  );
  assert.ok(
    fake.writes.some(
      ([filePath, value]) =>
        filePath.endsWith("/workers/worker_1-202/cgroup.kill") &&
        value === "1\n",
    ),
  );
  assert.equal(cleanupSleeps, 1);
  assert.ok(fake.removed.includes(workerPath));
});

test("worker cgroup cleanup waits for the worker subtree to empty", async () => {
  const selfPath =
    "/user.slice/user-1001.slice/user@1001.service/app.slice/rin-daemon-demo.service/daemon";
  const fake = createFakeCgroupFs(selfPath);
  let sleeps = 0;
  fake.deps.sleep = async () => {
    sleeps += 1;
    const workerPath = `/sys/fs/cgroup${path.posix.dirname(selfPath)}/workers/worker_1-202`;
    fake.files.set(`${workerPath}/cgroup.events`, "populated 0\n");
  };
  const isolation = createWorkerCgroupIsolation(fake.deps);

  assert.ok(isolation);
  const lease = isolation.attachWorker("worker_1", 202);
  const workerPath = `/sys/fs/cgroup${path.posix.dirname(selfPath)}/workers/worker_1-202`;
  fake.files.set(`${workerPath}/cgroup.events`, "populated 1\n");

  assert.equal(await lease.cleanup(), true);
  assert.equal(sleeps, 1);
  assert.deepEqual(fake.removed, [workerPath]);
});

test("managed worker cgroup isolation fails closed without delegation", () => {
  const selfPath =
    "/user.slice/user-1001.slice/user@1001.service/app.slice/rin-daemon-demo.service/daemon";
  const fake = createFakeCgroupFs(selfPath);
  fake.files.set(
    `/sys/fs/cgroup${path.posix.dirname(selfPath)}/cgroup.controllers`,
    "pids\n",
  );

  assert.throws(
    () => createWorkerCgroupIsolation(fake.deps),
    /could not initialize worker cgroup isolation/i,
  );
});

test("worker cgroup isolation stays disabled outside the managed service", () => {
  const fake = createFakeCgroupFs("/user.slice/session-2.scope");
  fake.deps.env = {};
  assert.equal(createWorkerCgroupIsolation(fake.deps), undefined);
  assert.deepEqual(fake.writes, []);
});
