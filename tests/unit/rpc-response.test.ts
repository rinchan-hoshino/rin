import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const rpcResponse = await importBuiltModule<
  typeof import("../../src/core/rin-lib/rpc-response.js")
>("dist/core/rin-lib/rpc-response.js");

test("rpc response helpers preserve payloads and normalize failures", () => {
  assert.deepEqual(rpcResponse.response("1", "get_state", true), {
    id: "1",
    type: "response",
    command: "get_state",
    success: true,
  });
  assert.deepEqual(rpcResponse.ok(undefined, "prompt", { accepted: true }), {
    id: undefined,
    type: "response",
    command: "prompt",
    success: true,
    data: { accepted: true },
  });
  assert.deepEqual(rpcResponse.fail("2", "prompt", { message: " stopped " }), {
    id: "2",
    type: "response",
    command: "prompt",
    success: false,
    error: "stopped",
  });
  assert.equal(
    rpcResponse.fail("3", "prompt", { error: "failed" }).error,
    "failed",
  );
  assert.equal(rpcResponse.fail("4", "prompt", " denied ").error, "denied");
  assert.equal(rpcResponse.fail("5", "prompt", {}).error, "[object Object]");
  assert.equal(
    rpcResponse.fail("6", "prompt", "   ").error,
    "rin_request_failed",
  );
  assert.equal(
    rpcResponse.fail("7", "prompt", null).error,
    "rin_request_failed",
  );
});
