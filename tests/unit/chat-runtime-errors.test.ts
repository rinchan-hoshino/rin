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

test("chat runtime maps internal marker errors to user-facing messages", () => {
  assert.equal(
    formatChatRuntimeErrorForUser("new_session_session_file_unsupported"),
    "Could not start a new chat session because the command was bound to a replied message's old session. Retry /new; chat commands should not use replied-message sessions.",
  );
  assert.equal(
    formatChatRuntimeErrorForUser("frontend_model_not_found:openai/missing"),
    "Model not found: openai/missing. Choose an available model in /model or settings.",
  );
  assert.equal(
    formatChatRuntimeErrorForUser("prompt is too long"),
    "prompt is too long",
  );
});
