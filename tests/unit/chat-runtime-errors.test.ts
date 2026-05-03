import assert from "node:assert/strict";
import test from "node:test";

import { isTransientChatRuntimeError } from "../../src/core/chat/runtime-errors.js";

test("chat runtime treats websocket provider failures as transient", () => {
  assert.equal(isTransientChatRuntimeError("WebSocket closed 1009"), true);
  assert.equal(isTransientChatRuntimeError("WebSocket error"), true);
  assert.equal(
    isTransientChatRuntimeError(new Error("WebSocket closed 1006")),
    true,
  );
});
