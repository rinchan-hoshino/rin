import assert from "node:assert/strict";
import test from "node:test";

import {
  formatChatRuntimeErrorForUser,
  isChatLifecycleRuntimeError,
  isSilentChatRuntimeRetryError,
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

test("chat runtime treats frontend lifecycle cancellation as silent transient", () => {
  assert.equal(
    isTransientChatRuntimeError("rin_frontend_turn_cancelled"),
    true,
  );
  assert.equal(
    isSilentChatRuntimeRetryError("rin_frontend_turn_cancelled"),
    true,
  );
  assert.equal(
    isTransientChatRuntimeError("frontend_turn_driver_disposed"),
    false,
  );
});

test("chat runtime treats worker exits without detail as silent lifecycle transients", () => {
  assert.equal(isTransientChatRuntimeError("rin_worker_exit"), true);
  assert.equal(isChatLifecycleRuntimeError("rin_worker_exit"), true);
  assert.equal(isSilentChatRuntimeRetryError("rin_worker_exit"), true);
});

test("chat runtime does not classify bare pending outbox markers as retry state", () => {
  assert.equal(
    isTransientChatRuntimeError("chat_outbox_delivery_pending"),
    false,
  );
  assert.equal(
    isChatLifecycleRuntimeError("chat_outbox_delivery_pending"),
    false,
  );
  assert.equal(
    isSilentChatRuntimeRetryError("chat_outbox_delivery_pending"),
    false,
  );
});

/* Recovery timeout is not auto-retried, but chat should not expose the raw marker. */
test("chat runtime formats recovery lifecycle errors as user-facing text", () => {
  assert.equal(
    isChatLifecycleRuntimeError("rin_turn_result_recovery_timeout"),
    true,
  );
  assert.equal(
    formatChatRuntimeErrorForUser("rin_turn_result_recovery_timeout"),
    "Rin could not recover the remote turn result before the timeout.",
  );
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
