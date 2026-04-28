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

test("updateWorkRoot prefers explicit installer tmpdir", async () => {
  const previous = process.env.RIN_INSTALL_TMPDIR;
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-install-explicit-"),
  );
  try {
    process.env.RIN_INSTALL_TMPDIR = path.join(root, " custom ", "..");
    assert.equal(shared.updateWorkRoot(), path.resolve(root));
  } finally {
    if (previous == null) delete process.env.RIN_INSTALL_TMPDIR;
    else process.env.RIN_INSTALL_TMPDIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
