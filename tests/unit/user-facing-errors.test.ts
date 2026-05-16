import assert from "node:assert/strict";
import test from "node:test";

import { formatRuntimeErrorForUser } from "../../src/core/rin-lib/user-facing-errors.js";

test("runtime error formatter keeps human messages", () => {
  assert.equal(formatRuntimeErrorForUser("fetch failed"), "fetch failed");
  assert.equal(
    formatRuntimeErrorForUser("prompt is too long"),
    "prompt is too long",
  );
});

test("runtime error formatter maps known internal markers to actionable messages", () => {
  assert.equal(
    formatRuntimeErrorForUser("new_session_session_file_unsupported"),
    "Could not start a new chat session because the command was bound to a replied message's old session. Retry /new; chat commands should not use replied-message sessions.",
  );
  assert.equal(
    formatRuntimeErrorForUser("frontend_model_not_found:openai/missing"),
    "Model not found: openai/missing. Choose an available model in /model or settings.",
  );
});

test("runtime error formatter labels unknown internal markers", () => {
  assert.equal(
    formatRuntimeErrorForUser("rpc_turn_final_output_missing"),
    "Internal error: rpc_turn_final_output_missing",
  );
});
