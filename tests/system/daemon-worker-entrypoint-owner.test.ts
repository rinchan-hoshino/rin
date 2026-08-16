import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createTestSandbox } from "../support/test-sandbox.js";

const execFileAsync = promisify(execFile);
const entrypoint = path.resolve("dist/app/rin-daemon/worker.js");
const failureRegister = path.resolve(
  "tests/support/register-entrypoint-failure.ts",
);

async function runWorker(mode: "resolve" | "error" | "empty" | "terminate") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-worker-entry-"));
  const sandbox = await createTestSandbox(root);
  try {
    return await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--import", failureRegister, entrypoint],
      {
        env: {
          ...sandbox.env,
          NODE_NO_WARNINGS: "1",
          RIN_TEST_ENTRYPOINT_FAILURE_TARGET: "dist/core/rin-daemon/worker.js",
          RIN_TEST_ENTRYPOINT_FAILURE_MODE: mode,
        },
      },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("daemon worker entrypoint completes success and formats dependency failures", async () => {
  const success = await runWorker("resolve");
  assert.equal(success.stdout, "");
  assert.equal(success.stderr, "");

  await assert.rejects(
    () => runWorker("error"),
    (error: any) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /worker fixture failure/);
      return true;
    },
  );

  await assert.rejects(
    () => runWorker("terminate"),
    (error: any) => {
      assert.equal(error.code, 23);
      return true;
    },
  );

  await assert.rejects(
    () => runWorker("empty"),
    (error: any) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Rin worker failed before it could start/);
      assert.doesNotMatch(error.stderr, /rin_app_worker_failed/);
      return true;
    },
  );
});
