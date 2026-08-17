import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const contextModule = await import(
  pathToFileURL(
    path.join(
      rootDir,
      "dist",
      "core",
      "rin-daemon",
      "rpc-command-handler-context.js",
    ),
  ).href
);

test("RPC command response helpers preserve direct and projected values", async () => {
  assert.deepEqual(contextModule.rpcDone("id-1", "state", { ready: true }), {
    id: "id-1",
    type: "response",
    command: "state",
    success: true,
    data: { ready: true },
  });
  assert.deepEqual(
    await contextModule.rpcRun("id-2", "count", () => 2),
    contextModule.rpcDone("id-2", "count", 2),
  );
  assert.deepEqual(
    await contextModule.rpcRun(
      "id-3",
      "count",
      async () => 2,
      (value) => ({
        doubled: value * 2,
      }),
    ),
    contextModule.rpcDone("id-3", "count", { doubled: 4 }),
  );
});

test("RPC command response helpers do not swallow operation failures", async () => {
  await assert.rejects(
    () =>
      contextModule.rpcRun("id-4", "failure", () => {
        throw new Error("operation failed");
      }),
    /operation failed/,
  );
});
