import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createTestSandbox } from "../support/test-sandbox.js";

const execFileAsync = promisify(execFile);
const entrypoint = path.resolve("dist/app/rin-install/main.js");
const failureRegister = path.resolve(
  "tests/support/register-entrypoint-failure.ts",
);

test("installer entrypoint formats ordinary errors and honors apply-error handoff", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-install-entry-"));
  const sandbox = await createTestSandbox(root);
  try {
    await assert.rejects(
      () =>
        execFileAsync(process.execPath, [entrypoint, "--gui"], {
          env: sandbox.env,
        }),
      (error: any) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /installer GUI is temporarily disabled/);
        assert.doesNotMatch(error.stderr, /rin_installer_gui_disabled/);
        return true;
      },
    );

    await assert.rejects(
      () =>
        execFileAsync(
          process.execPath,
          ["--import", "tsx", "--import", failureRegister, entrypoint],
          {
            env: {
              ...sandbox.env,
              RIN_TEST_ENTRYPOINT_FAILURE_TARGET:
                "dist/core/rin-install/main.js",
            },
          },
        ),
      (error: any) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /installer failed before it could finish/);
        assert.doesNotMatch(error.stderr, /rin_app_install_failed/);
        return true;
      },
    );

    const errorFile = path.join(root, "apply-error.txt");
    await assert.rejects(
      () =>
        execFileAsync(
          process.execPath,
          [
            entrypoint,
            "--apply-plan-file",
            path.join(root, "missing-plan.json"),
            "--apply-error-file",
            errorFile,
          ],
          {
            env: sandbox.env,
          },
        ),
      (error: any) => {
        assert.equal(error.code, 1);
        assert.equal(error.stderr, "");
        return true;
      },
    );
    assert.match(await fs.readFile(errorFile, "utf8"), /ENOENT/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
