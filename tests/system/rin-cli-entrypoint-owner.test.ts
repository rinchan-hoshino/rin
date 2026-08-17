import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createTestSandbox } from "../support/test-sandbox.js";

const execFileAsync = promisify(execFile);
const sandboxRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "rin-cli-entrypoint-owner-"),
);
const sandbox = await createTestSandbox(sandboxRoot);
test.after(async () => {
  await fs.rm(sandboxRoot, { recursive: true, force: true });
});
const entrypoint = path.resolve("dist/app/rin/main.js");
const failureRegister = path.resolve(
  "tests/support/register-entrypoint-failure.ts",
);

async function runFixture(
  mode: "resolve" | "number" | "termination" | "empty" | "error",
) {
  return await execFileAsync(
    process.execPath,
    [
      "--disable-warning=DEP0205",
      "--import",
      "tsx",
      "--import",
      failureRegister,
      entrypoint,
    ],
    {
      env: {
        ...sandbox.env,
        RIN_TEST_ENTRYPOINT_FAILURE_TARGET: "dist/core/rin/main.js",
        RIN_TEST_ENTRYPOINT_FAILURE_MODE: mode,
      },
    },
  );
}

test("Rin CLI entrypoint delegates successful startup without diagnostics", async () => {
  const result = await runFixture("resolve");
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("Rin CLI entrypoint preserves numeric and requested termination exit codes", async () => {
  await assert.rejects(
    () => runFixture("number"),
    (error: any) => {
      assert.equal(error.code, 19);
      return true;
    },
  );
  await assert.rejects(
    () => runFixture("termination"),
    (error: any) => {
      assert.equal(error.code, 23);
      return true;
    },
  );
});

test("Rin CLI entrypoint completes its caught-error boundary after requesting exit", async () => {
  const script = `
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    let exitCode;
    process.exit = (code) => { exitCode = code; };
    await import(pathToFileURL(${JSON.stringify(entrypoint)}).href);
    for (let index = 0; index < 100 && exitCode === undefined; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(exitCode, 1);
    console.log(JSON.stringify({ exitCode }));
  `;
  const result = await execFileAsync(
    process.execPath,
    [
      "--disable-warning=DEP0205",
      "--import",
      "tsx",
      "--import",
      failureRegister,
      "--input-type=module",
      "-e",
      script,
    ],
    {
      env: {
        ...sandbox.env,
        RIN_TEST_ENTRYPOINT_FAILURE_TARGET: "dist/core/rin/main.js",
        RIN_TEST_ENTRYPOINT_FAILURE_MODE: "error",
      },
    },
  );
  assert.deepEqual(JSON.parse(result.stdout), { exitCode: 1 });
  assert.match(result.stderr, /Rin request failed/);
});

test("Rin CLI entrypoint formats empty and marked startup failures", async () => {
  await assert.rejects(
    () => runFixture("empty"),
    (error: any) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Rin command failed before it could finish/);
      return true;
    },
  );
  await assert.rejects(
    () => runFixture("error"),
    (error: any) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Rin request failed/);
      assert.doesNotMatch(error.stderr, /rin_request_failed/);
      return true;
    },
  );
});
