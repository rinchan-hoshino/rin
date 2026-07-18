import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

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
  "update-job.js",
);
const fixturePath = path.join(
  rootDir,
  "tests",
  "support",
  "register-update-job-entrypoint-fixture.ts",
);
const sandboxRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "rin-update-job-entrypoint-"),
);
const sandbox = await createTestSandbox(sandboxRoot);
after(() => fs.rm(sandboxRoot, { recursive: true, force: true }));

async function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return await execFileAsync(
    process.execPath,
    ["--import", fixturePath, entryPath, ...args],
    { env: { ...sandbox.env, ...env } },
  );
}

async function rejectsWith(args: string[], pattern: RegExp, env = {}) {
  await assert.rejects(
    () => run(args, env),
    (error: any) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, pattern);
      return true;
    },
  );
}

test("update job entrypoint owns executor, detach, and failure modes", async () => {
  assert.equal((await run(["job.json"])).stderr, "");
  await assert.rejects(
    () => run(["job.json"], { RIN_TEST_UPDATE_JOB_EXIT_CODE: "7" }),
    (error: any) => error.code === 7 && error.stderr === "",
  );
  await rejectsWith([], /update job file was not provided/i);
  await rejectsWith(["--detach"], /update job file was not provided/i);
  assert.equal((await run(["--detach", "job.json"])).stderr, "");
  await rejectsWith(["job.json"], /fixture run failed/, {
    RIN_TEST_UPDATE_JOB_THROW: "run",
  });
  await rejectsWith(["--detach", "job.json"], /fixture detach failed/, {
    RIN_TEST_UPDATE_JOB_THROW: "detach",
  });
});
