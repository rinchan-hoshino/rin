import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const platformFs = await importBuiltModule<
  typeof import("../../src/core/platform/fs.js")
>("dist/core/platform/fs.js");
const platformProcess = await importBuiltModule<
  typeof import("../../src/core/platform/process.js")
>("dist/core/platform/process.js");

async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-platform-owner-"));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("platform JSON reads default only when the file is missing", async () => {
  await withTempDir(async (dir) => {
    assert.deepEqual(
      platformFs.readJsonFileOrDefault(path.join(dir, "missing.json"), {
        missing: true,
      }),
      { missing: true },
    );

    const malformed = path.join(dir, "malformed.json");
    await fs.writeFile(malformed, "{", "utf8");
    assert.throws(
      () => platformFs.readJsonFileOrDefault(malformed, {}),
      SyntaxError,
    );

    const directory = path.join(dir, "directory.json");
    await fs.mkdir(directory);
    assert.throws(() => platformFs.readJsonFileOrDefault(directory, {}));
  });
});

test("platform filesystem helpers preserve cleanup contracts", async () => {
  await withTempDir(async (dir) => {
    const privateDir = path.join(dir, "private");
    platformFs.ensurePrivateDir(privateDir);
    assert.equal((await fs.stat(privateDir)).mode & 0o777, 0o700);

    assert.equal(
      platformFs.stringifyJson({ ok: true }, false),
      '{\n  "ok": true\n}',
    );
    assert.deepEqual(platformFs.listJsonFiles(path.join(dir, "missing")), []);

    const removable = path.join(dir, "removable.json");
    await fs.writeFile(removable, "{}", "utf8");
    platformFs.removeFileIfExists(removable);
    platformFs.removeFileIfExists(removable);
    await assert.rejects(fs.stat(removable));
  });
});

test("platform process helpers reject absent processes and resolve sleeps", async () => {
  assert.equal(platformProcess.isPidAlive(undefined), false);
  assert.equal(platformProcess.isPidAlive(0), false);
  assert.equal(platformProcess.isPidAlive(Number.MAX_SAFE_INTEGER), false);
  await platformProcess.sleep(0);
});
