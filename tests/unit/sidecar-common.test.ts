import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const sidecar = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "sidecar", "common.js")).href
);

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-sidecar-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("sidecar common writes, reads and lists instance state", async () => {
  await withTempDir(async (dir) => {
    const instancesRoot = path.join(dir, "instances");
    const statePath = path.join(instancesRoot, "demo", "state.json");
    sidecar.writeInstanceState(statePath, { pid: 123, ownerPid: 456 });
    await fs.mkdir(path.join(instancesRoot, "empty"), { recursive: true });
    await fs.writeFile(path.join(instancesRoot, "note.txt"), "ignore", "utf8");
    const state = sidecar.readInstanceState(statePath);
    assert.deepEqual(state, { pid: 123, ownerPid: 456 });
    const ids = sidecar.listInstanceIds(instancesRoot);
    assert.deepEqual(ids, ["demo"]);
  });
});

test("sidecar common ignores malformed instance state payloads", async () => {
  await withTempDir(async (dir) => {
    const statePath = path.join(dir, "instances", "bad", "state.json");
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, '"bad"', "utf8");
    assert.equal(sidecar.readInstanceState(statePath), null);

    await fs.writeFile(statePath, '["bad"]', "utf8");
    assert.equal(sidecar.readInstanceState(statePath), null);

    await fs.writeFile(statePath, "null", "utf8");
    assert.equal(sidecar.readInstanceState(statePath), null);
  });
});

test("sidecar common acquires and releases process lock", async () => {
  await withTempDir(async (dir) => {
    const lockPath = path.join(dir, "demo.lock");
    const release = await sidecar.acquireProcessLock(lockPath, 500);
    const stat = await fs.stat(lockPath);
    assert.ok(stat.isFile());
    release();
    await assert.rejects(fs.stat(lockPath));
  });
});

test("sidecar common replaces stale or malformed locks", async () => {
  await withTempDir(async (dir) => {
    const lockPath = path.join(dir, "demo.lock");
    await fs.writeFile(lockPath, "not-json", "utf8");
    const release = await sidecar.acquireProcessLock(lockPath, 500);
    const lockState = JSON.parse(await fs.readFile(lockPath, "utf8"));
    assert.equal(lockState.pid, process.pid);
    assert.equal(typeof lockState.ts, "number");
    release();

    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: "999999", ts: "bad" }),
      "utf8",
    );
    const releaseStale = await sidecar.acquireProcessLock(lockPath, 500);
    const staleLockState = JSON.parse(await fs.readFile(lockPath, "utf8"));
    assert.equal(staleLockState.pid, process.pid);
    assert.equal(typeof staleLockState.ts, "number");
    releaseStale();
  });
});

test("sidecar common times out on live lock owner", async () => {
  await withTempDir(async (dir) => {
    const lockPath = path.join(dir, "demo.lock");
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, ts: Date.now() }),
      "utf8",
    );
    await assert.rejects(
      sidecar.acquireProcessLock(lockPath, 120),
      /sidecar_lock_timeout/,
    );
  });
});
