import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createTestSandbox } from "../support/test-sandbox.js";

const execFileAsync = promisify(execFile);
const entrypoint = path.resolve("dist/app/rin-gui/main.js");
const failureRegister = path.resolve(
  "tests/support/register-entrypoint-failure.ts",
);

test("GUI entrypoint parses argv before connecting and formats the failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-gui-entry-"));
  const sandbox = await createTestSandbox(root);
  try {
    await assert.rejects(
      () =>
        execFileAsync(process.execPath, [entrypoint, "--not-a-gui-option"], {
          env: sandbox.env,
        }),
      (error: any) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /unsupported option: --not-a-gui-option/);
        assert.doesNotMatch(error.stderr, /rin_gui_unrecognized_arg/);
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
              RIN_TEST_ENTRYPOINT_FAILURE_TARGET: "dist/core/rin-gui/main.js",
            },
          },
        ),
      (error: any) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /Rin GUI failed before it could start/);
        assert.doesNotMatch(error.stderr, /rin_gui_failed/);
        return true;
      },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
