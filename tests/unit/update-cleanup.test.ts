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
const updateWorkflow = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-install", "update-workflow.js"),
  ).href
);

test("cleanupStaleUpdateWorkDirs prunes only stale work dirs", async () => {
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rin-update-root-"));
  try {
    const staleDir = path.join(workRoot, "work-stale");
    const keepDir = path.join(workRoot, "work-keep");
    const otherDir = path.join(workRoot, "misc-stale");
    await fs.mkdir(staleDir, { recursive: true });
    await fs.mkdir(keepDir, { recursive: true });
    await fs.mkdir(otherDir, { recursive: true });

    const oldTime = new Date(Date.now() - 60_000);
    await fs.utimes(staleDir, oldTime, oldTime);
    await fs.utimes(otherDir, oldTime, oldTime);

    const removed = shared.cleanupStaleUpdateWorkDirs(
      path.join(workRoot, "."),
      {
        keepPaths: [path.join(workRoot, ".", "work-keep")],
        staleAfterMs: 5_000,
        nowMs: Date.now(),
      },
    );

    assert.deepEqual(removed, [staleDir]);
    await assert.doesNotReject(fs.access(keepDir));
    await assert.doesNotReject(fs.access(otherDir));
    await assert.rejects(fs.access(staleDir));
  } finally {
    await fs.rm(workRoot, { recursive: true, force: true });
  }
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

test("createUpdateRuntimeSourceWorkspace writes the release handoff", async () => {
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rin-update-work-"));
  const release = {
    channel: "stable",
    archiveUrl: "https://example.invalid/rin.tgz",
    version: "1.2.3",
    branch: "stable",
    ref: "abc1234",
    sourceLabel: "stable 1.2.3",
  };

  try {
    const workspace = updateWorkflow.createUpdateRuntimeSourceWorkspace(
      release,
      workRoot,
    );
    assert.equal(path.dirname(workspace.tempRoot), workRoot);
    assert.equal(
      await fs.readFile(workspace.releaseFile, "utf8"),
      `${JSON.stringify(release)}\n`,
    );
    await assert.doesNotReject(fs.access(workspace.sourceRoot));
    await assert.doesNotReject(fs.access(workspace.tmpDir));
    await assert.doesNotReject(fs.access(workspace.logFile));
  } finally {
    await fs.rm(workRoot, { recursive: true, force: true });
  }
});

test("disablePackageRootPrepareScript removes only the package prepare hook", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-update-package-"));
  const packageJson = path.join(dir, "package.json");
  try {
    await fs.writeFile(
      packageJson,
      `${JSON.stringify({ scripts: { prepare: "husky", build: "tsc" } })}\n`,
      "utf8",
    );

    updateWorkflow.disablePackageRootPrepareScript(dir);

    const parsed = JSON.parse(await fs.readFile(packageJson, "utf8"));
    assert.deepEqual(parsed.scripts, { build: "tsc" });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
