import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createTestSandbox } from "../support/test-sandbox.js";

const execFileAsync = promisify(execFile);
const entrypoint = path.resolve("dist/app/rin-desktop-host/main.js");
const failureRegister = path.resolve(
  "tests/support/register-entrypoint-failure.ts",
);

test("desktop host entrypoint formats argument and empty host failures", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-desktop-entry-"));
  const sandbox = await createTestSandbox(root);
  try {
    await assert.rejects(
      () =>
        execFileAsync(process.execPath, [entrypoint, "--not-a-host-option"], {
          env: sandbox.env,
        }),
      (error: any) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /desktop host unknown arg/);
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
                "dist/core/rin-gui/native-desktop.js",
            },
          },
        ),
      (error: any) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /desktop host failed before it could start/);
        assert.doesNotMatch(error.stderr, /rin_desktop_host_failed/);
        return true;
      },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
