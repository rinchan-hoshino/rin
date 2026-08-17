import "../support/require-test-sandbox.ts";
import test from "node:test";
import assert from "node:assert/strict";
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
const fsMod = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "platform", "fs.js")).href
);
const processMod = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "platform", "process.js"))
    .href
);
const textUtils = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "text-utils.js")).href
);

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-platform-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("platform/fs prefer Rin temp roots deterministically", () => {
  const previousTmpDir = process.env.TMPDIR;
  try {
    process.env.TMPDIR = "/tmp/rin-custom-root";
    assert.deepEqual(fsMod.preferredTempRootCandidates().slice(0, 2), [
      path.resolve("/tmp/rin-custom-root"),
      path.resolve("/home/rin/tmp"),
    ]);
  } finally {
    if (previousTmpDir == null) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpDir;
  }
});

test("platform/fs writeJsonAtomic and readJsonFile roundtrip", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "nested", "state.json");
    fsMod.writeJsonAtomic(filePath, { ok: true, count: 2 });
    const parsed = fsMod.readJsonFile(filePath);
    assert.deepEqual(parsed, { ok: true, count: 2 });
    assert.equal(
      await fs.readFile(filePath, "utf8"),
      '{\n  "ok": true,\n  "count": 2\n}\n',
    );
  });
});

test("platform/fs writeJsonFile writes pretty JSON with trailing newline", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "nested", "config.json");
    fsMod.writeJsonFile(filePath, { ok: true });
    assert.equal(await fs.readFile(filePath, "utf8"), '{\n  "ok": true\n}\n');
  });
});

test("platform/fs appendJsonLine helpers append compact jsonl entries", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "nested", "events.jsonl");
    await fsMod.appendJsonLine(filePath, { step: 1, ok: true });
    fsMod.appendJsonLineSync(filePath, { step: 2, ok: false });
    assert.equal(
      await fs.readFile(filePath, "utf8"),
      '{"step":1,"ok":true}\n{"step":2,"ok":false}\n',
    );
    assert.equal(fsMod.stringifyJsonLine({ ok: true }), '{"ok":true}\n');
  });
});

test("platform/fs listJsonFiles only returns sorted json files", async () => {
  await withTempDir(async (dir) => {
    await fs.mkdir(path.join(dir, "nested.json"), { recursive: true });
    await fs.writeFile(path.join(dir, "b.json"), "{}", "utf8");
    await fs.writeFile(path.join(dir, "a.json"), "{}", "utf8");
    await fs.writeFile(path.join(dir, "note.txt"), "ignore", "utf8");

    assert.deepEqual(fsMod.listJsonFiles(dir), [
      path.join(dir, "a.json"),
      path.join(dir, "b.json"),
    ]);
  });
});

test("platform/fs move helpers move files into target directories", async () => {
  await withTempDir(async (dir) => {
    const source = path.join(dir, "queue", "item.json");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, '{"ok":true}\n', "utf8");

    const claimedPath = fsMod.claimFileToDir(
      source,
      path.join(dir, "processing"),
    );
    assert.equal(claimedPath, path.join(dir, "processing", "item.json"));
    assert.equal(await fs.readFile(claimedPath, "utf8"), '{"ok":true}\n');

    const movedPath = fsMod.moveFileToDir(
      claimedPath,
      path.join(dir, "done"),
      "final.json",
    );
    assert.equal(movedPath, path.join(dir, "done", "final.json"));
    assert.equal(await fs.readFile(movedPath, "utf8"), '{"ok":true}\n');
    assert.equal(
      fsMod.claimFileToDir(
        path.join(dir, "missing.json"),
        path.join(dir, "processing"),
      ),
      "",
    );
    await assert.rejects(fs.stat(source));
    await assert.rejects(fs.stat(claimedPath));
  });
});

test("platform/fs moveFileToDir falls back to copy on EXDEV", async () => {
  await withTempDir(async (dir) => {
    const source = path.join(dir, "queue", "item.json");
    const targetDir = path.join(dir, "processing");
    const targetPath = path.join(targetDir, "renamed.json");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, '{"ok":true}\n', "utf8");

    const originalRenameSync = fsSync.renameSync;
    fsSync.renameSync = (from, to) => {
      if (from === source && to === targetPath) {
        const error = new Error("cross-device link not permitted");
        error.code = "EXDEV";
        throw error;
      }
      return originalRenameSync(from, to);
    };

    try {
      const movedPath = fsMod.moveFileToDir(source, targetDir, "renamed.json");
      assert.equal(movedPath, targetPath);
      assert.equal(await fs.readFile(targetPath, "utf8"), '{"ok":true}\n');
      await assert.rejects(fs.stat(source));
    } finally {
      fsSync.renameSync = originalRenameSync;
    }
  });
});

test("platform/process helpers behave as expected", async () => {
  assert.equal(processMod.safeString, textUtils.safeString);
  assert.equal(processMod.safeString(null), "");
  assert.equal(processMod.safeString(42), "42");
  assert.equal(processMod.isPidAlive(process.pid), true);
  assert.equal(processMod.isPidAlive(-1), false);
  assert.equal(processMod.isPidAlive(1.5), false);
  const started = Date.now();
  await processMod.sleep(20);
  assert.ok(Date.now() - started >= 10);
});
