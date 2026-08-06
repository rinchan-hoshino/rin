import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createTestSandbox } from "../support/test-sandbox.js";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const entryPath = path.join(
  rootDir,
  "dist",
  "app",
  "rin-install",
  "chat-migrations.js",
);
const migrations = await import(pathToFileURL(entryPath).href);
const sandboxRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "rin-chat-migrations-entrypoint-"),
);
const sandbox = await createTestSandbox(sandboxRoot);
after(() => fs.rm(sandboxRoot, { recursive: true, force: true }));

test("chat migration entrypoint owns direct preflight and commit modes", async () => {
  assert.throws(
    () => migrations.main([]),
    /chat_install_migration_install_dir_required/,
  );
  assert.throws(
    () => migrations.main(),
    /chat_install_migration_install_dir_required/,
  );
  const originalArgv1 = process.argv[1];
  try {
    process.argv[1] = "";
    await import(`${pathToFileURL(entryPath).href}?not-direct-entry`);
  } finally {
    process.argv[1] = originalArgv1;
  }

  const preflight = migrations.main(["--preflight", sandbox.agentDir]);
  assert.equal(preflight.sessionBindings.scanned, 0);
  const quiescingPreflight = migrations.main([
    "--preflight",
    "--runtime-will-be-quiesced",
    sandbox.agentDir,
  ]);
  assert.equal(quiescingPreflight.sessionBindings.scanned, 0);

  const committed = migrations.main([sandbox.agentDir]);
  assert.equal(committed.sessionBindings.scanned, 0);
  const quiescedCommit = migrations.main([
    "--runtime-quiesced",
    sandbox.agentDir,
  ]);
  assert.equal(quiescedCommit.sessionBindings.scanned, 0);

  const direct = await execFileAsync(
    process.execPath,
    [entryPath, "--preflight", sandbox.agentDir],
    { env: sandbox.env },
  );
  assert.equal(JSON.parse(direct.stdout).sessionBindings.scanned, 0);

  await assert.rejects(
    () => execFileAsync(process.execPath, [entryPath], { env: sandbox.env }),
    (error: any) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /chat_install_migration_install_dir_required/);
      return true;
    },
  );
});
