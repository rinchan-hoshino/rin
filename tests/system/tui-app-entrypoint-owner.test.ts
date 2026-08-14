import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createTestSandbox } from "../support/test-sandbox.js";

const execFileAsync = promisify(execFile);
const entrypoint = path.resolve("dist/app/rin-tui/main.js");
const failureRegister = path.resolve(
  "tests/support/register-entrypoint-failure.ts",
);

test("app TUI entrypoint delegates failures to the frontend display boundary", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-tui-entry-"));
  const sandbox = await createTestSandbox(root);
  try {
    await assert.rejects(
      () =>
        execFileAsync(
          process.execPath,
          ["--import", "tsx", "--import", failureRegister, entrypoint],
          {
            env: {
              ...sandbox.env,
              RIN_TEST_ENTRYPOINT_FAILURE_TARGET:
                "dist/core/rin-tui/launcher.js",
            },
          },
        ),
      (error: any) => {
        assert.equal(error.code, 1);
        assert.equal(error.stderr.trim(), "request failed");
        assert.doesNotMatch(error.stderr, /rin_request_failed/);
        return true;
      },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
