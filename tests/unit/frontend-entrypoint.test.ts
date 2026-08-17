import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const entrypoint = await importBuiltModule<
  typeof import("../../src/core/rin-frontend-sdk/entrypoint.js")
>("dist/core/rin-frontend-sdk/entrypoint.js");

test("frontend entrypoint returns successful startup results", async () => {
  assert.equal(await entrypoint.runFrontendEntrypoint(() => "ready"), "ready");
  assert.deepEqual(
    await entrypoint.runFrontendEntrypoint(async () => ({ status: "ready" })),
    { status: "ready" },
  );
});

test("frontend entrypoint formats startup failures before exiting", async () => {
  const errors: unknown[] = [];
  const exits: number[] = [];

  const result = await entrypoint.runFrontendEntrypoint(
    () => {
      throw new Error("rin_request_failed");
    },
    {
      stderr: { error: (value: unknown) => errors.push(value) },
      exit: (code: number) => exits.push(code),
    },
  );

  assert.equal(result, undefined);
  assert.deepEqual(errors, ["request failed"]);
  assert.deepEqual(exits, [1]);
});
