import assert from "node:assert/strict";
import test from "node:test";

import {
  formatChatRuntimeErrorForUser,
  isTransientChatRuntimeError,
} from "../../src/core/chat/runtime-errors.js";

test("chat runtime treats websocket provider failures as transient", () => {
  assert.equal(isTransientChatRuntimeError("WebSocket closed 1009"), true);
  assert.equal(isTransientChatRuntimeError("WebSocket error"), true);
  assert.equal(
    isTransientChatRuntimeError(new Error("WebSocket closed 1006")),
    true,
  );
});

test("chat runtime treats frontend turn disposal as transient", () => {
  assert.equal(
    isTransientChatRuntimeError("frontend_turn_driver_disposed"),
    true,
  );
});

test("chat runtime treats worker exits without detail as transient", () => {
  assert.equal(isTransientChatRuntimeError("rin_worker_exit"), true);
});

test("chat runtime prefixes terse Rin errors", () => {
  assert.equal(
    formatChatRuntimeErrorForUser("new_session_session_file_unsupported"),
    "rin error: new session session file unsupported",
  );
  assert.equal(
    formatChatRuntimeErrorForUser("frontend_model_not_found:openai/missing"),
    "rin error: frontend model not found: openai/missing",
  );
  assert.equal(
    formatChatRuntimeErrorForUser("prompt is too long"),
    "rin error: prompt is too long",
  );
});
