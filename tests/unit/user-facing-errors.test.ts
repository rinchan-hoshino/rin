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

test("runtime error formatter hides internal marker messages", () => {
  assert.equal(
    formatRuntimeErrorForUser("rpc_turn_final_output_missing"),
    "Rin hit an internal error. Please retry, or check the logs for details.",
  );
  assert.equal(
    formatRuntimeErrorForUser("frontend_model_not_found:openai/missing"),
    "Rin hit an internal error. Please retry, or check the logs for details.",
  );
});
