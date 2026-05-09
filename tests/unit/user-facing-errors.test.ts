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

test("runtime error formatter makes internal marker messages readable", () => {
  assert.equal(
    formatRuntimeErrorForUser("rpc_turn_final_output_missing"),
    "rpc turn final output missing",
  );
  assert.equal(
    formatRuntimeErrorForUser("frontend_model_not_found:openai/missing"),
    "frontend model not found: openai/missing",
  );
});
