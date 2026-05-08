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

test("chat runtime hides internal marker errors from users", () => {
  assert.equal(
    formatChatRuntimeErrorForUser("frontend_model_not_found:openai/missing"),
    "Rin hit an internal chat error. Please retry, or ask the owner to check the logs.",
  );
  assert.equal(
    formatChatRuntimeErrorForUser("prompt is too long"),
    "prompt is too long",
  );
});
