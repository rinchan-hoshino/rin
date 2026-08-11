import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createTestSandbox } from "../support/test-sandbox.js";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const memoryEntrypoint = path.join(
  rootDir,
  "dist",
  "app",
  "rin-install",
  "memory-migrations.js",
);
const memoryMigrations = await import(pathToFileURL(memoryEntrypoint).href);

test("memory migration entrypoint validates and dispatches every install phase", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-memory-entrypoint-"),
  );
  const sandbox = await createTestSandbox(root);
  try {
    await assert.rejects(
      () => memoryMigrations.main([]),
      /install_dir_required/,
    );
    await assert.rejects(
      () => memoryMigrations.main(["--unknown", root]),
      /mode_invalid:--unknown/,
    );
    await assert.rejects(
      () => memoryMigrations.main(["--preflight", "--rollback", root]),
      /mode_invalid:--preflight,--rollback/,
    );

    const preflight = await memoryMigrations.main(["--preflight", root]);
    assert.equal(preflight.reason, "missing");
    assert.equal((await memoryMigrations.main([root])).action, "none");
    assert.deepEqual(await memoryMigrations.main(["--finalize", root]), {
      skipped: true,
      cleanupPending: false,
    });
    assert.deepEqual(await memoryMigrations.main(["--rollback", root]), {
      skipped: true,
    });

    const direct = await execFileAsync(
      process.execPath,
      [memoryEntrypoint, root],
      {
        env: sandbox.env,
      },
    );
    assert.equal(JSON.parse(direct.stdout).action, "none");
    await assert.rejects(
      () =>
        execFileAsync(process.execPath, [memoryEntrypoint, "--invalid", root], {
          env: sandbox.env,
        }),
      (error: any) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /mode_invalid:--invalid/);
        return true;
      },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
