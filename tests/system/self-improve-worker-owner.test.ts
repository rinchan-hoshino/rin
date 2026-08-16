import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createTestSandbox } from "../support/test-sandbox.js";

const execFileAsync = promisify(execFile);
const entrypoint = path.resolve("dist/app/rin-daemon/self-improve-worker.js");
const failureRegister = path.resolve(
  "tests/support/register-entrypoint-failure.ts",
);
const emptyAgentDirRegister = path.resolve(
  "tests/support/register-self-improve-empty-agent-dir.ts",
);

async function runWorker(args: string[], env: NodeJS.ProcessEnv = {}) {
  return await execFileAsync(process.execPath, [entrypoint, ...args], {
    env: { ...process.env, ...env },
  });
}

test("self-improve worker accepts each agent-dir source and an empty invocation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-memory-worker-"));
  const sandbox = await createTestSandbox(root);
  try {
    for (const invocation of [
      { args: [] as string[], env: { RIN_DIR: "" } },
      { args: ["--agent-dir", path.join(root, "separate")], env: {} },
      { args: [`--agent-dir=${path.join(root, "equals")}`], env: {} },
      { args: [], env: { RIN_DIR: path.join(root, "environment") } },
    ]) {
      const result = await runWorker(invocation.args, {
        ...sandbox.env,
        ...invocation.env,
      });
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("self-improve worker preserves string, empty, and unresolved agent-dir boundaries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-memory-worker-"));
  const sandbox = await createTestSandbox(root);
  try {
    for (const [mode, pattern] of [
      ["string", /owner self-improve string/],
      ["empty", /rin_memory_worker_failed/],
    ] as const) {
      await assert.rejects(
        () =>
          execFileAsync(
            process.execPath,
            ["--import", "tsx", "--import", failureRegister, entrypoint],
            {
              env: {
                ...sandbox.env,
                RIN_TEST_ENTRYPOINT_FAILURE_TARGET:
                  "dist/core/self-improve/worker.js",
                RIN_TEST_ENTRYPOINT_FAILURE_MODE: mode,
              },
            },
          ),
        (error: any) => {
          assert.equal(error.code, 1);
          assert.match(error.stderr, pattern);
          return true;
        },
      );
    }

    const unresolved = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--import", emptyAgentDirRegister, entrypoint],
      { env: sandbox.env },
    );
    assert.equal(unresolved.stdout, "");
    assert.equal(unresolved.stderr, "");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("self-improve worker reports filesystem failures without a stack trace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-memory-worker-"));
  const sandbox = await createTestSandbox(root);
  const file = path.join(root, "not-a-directory");
  await fs.writeFile(file, "x");
  try {
    await assert.rejects(
      () => runWorker([`--agent-dir=${file}`], sandbox.env),
      (error: any) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /ENOTDIR/);
        assert.doesNotMatch(error.stderr, /\n\s+at /);
        return true;
      },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
