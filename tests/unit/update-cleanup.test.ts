import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const shared = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "shared.js")).href
);

test("cleanupStaleUpdateWorkDirs prunes only stale work dirs", async () => {
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rin-update-root-"));
  const staleDir = path.join(workRoot, "work-stale");
  const keepDir = path.join(workRoot, "work-keep");
  const otherDir = path.join(workRoot, "misc-stale");
  await fs.mkdir(staleDir, { recursive: true });
  await fs.mkdir(keepDir, { recursive: true });
  await fs.mkdir(otherDir, { recursive: true });

  const oldTime = new Date(Date.now() - 60_000);
  await fs.utimes(staleDir, oldTime, oldTime);
  await fs.utimes(otherDir, oldTime, oldTime);

  const removed = shared.cleanupStaleUpdateWorkDirs(path.join(workRoot, "."), {
    keepPaths: [path.join(workRoot, ".", "work-keep")],
    staleAfterMs: 5_000,
    nowMs: Date.now(),
  });

  assert.deepEqual(removed, [staleDir]);
  await assert.doesNotReject(fs.access(keepDir));
  await assert.doesNotReject(fs.access(otherDir));
  await assert.rejects(fs.access(staleDir));
});

test("updateWorkRoot uses the platform cache root", async () => {
  const previous = process.env.XDG_CACHE_HOME;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-update-cache-"));
  try {
    process.env.XDG_CACHE_HOME = root;
    assert.equal(shared.updateWorkRoot(), path.join(root, "rin-update"));
  } finally {
    if (previous == null) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
