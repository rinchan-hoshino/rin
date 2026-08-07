import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createTestSandbox } from "../support/test-sandbox.js";

const execFile = promisify(execFileCallback);
const entrypoint = path.resolve("dist/app/rin-install/update-payload.js");
const fixture = path.resolve(
  "tests/support/register-update-payload-entrypoint-owner-fixture.ts",
);

test("update payload entrypoint owns success and non-Error failure boundaries", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-update-payload-entrypoint-owner-"),
  );
  const sandbox = await createTestSandbox(root);
  try {
    const success = await execFile(
      process.execPath,
      ["--import", "tsx", "--import", fixture, entrypoint],
      { env: { ...sandbox.env, NODE_NO_WARNINGS: "1" } },
    );
    assert.match(success.stdout, /owner payload started/);
    assert.equal(success.stderr, "");

    for (const [failure, expected] of [
      ["string", /owner payload failure/],
      ["error", /owner error failure/],
      ["empty", /update payload failed/],
    ] as const) {
      await assert.rejects(
        () =>
          execFile(
            process.execPath,
            ["--import", "tsx", "--import", fixture, entrypoint],
            {
              env: {
                ...sandbox.env,
                NODE_NO_WARNINGS: "1",
                RIN_TEST_UPDATE_PAYLOAD_FAILURE: failure,
              },
            },
          ),
        (error: any) => {
          assert.equal(error.code, 1);
          assert.match(error.stderr, expected);
          return true;
        },
      );
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
