import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  RIN_CHAT_PLATFORM_EVENT,
  defineRinExtension,
} from "../../dist/core/rin-extension-api.js";

test("Rin keeps Pi factory identity and one optional Chat event", () => {
  const factory = () => undefined;
  assert.equal(defineRinExtension(factory), factory);
  assert.equal(RIN_CHAT_PLATFORM_EVENT, "rin.chat.platform.v1");
});
