import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const chat = await importBuiltModule<{
  default(): { name?: string; tools?: unknown[] };
}>("dist/core/chat/index.js");

test("chat capability exposes only its owned capability identity", () => {
  assert.deepEqual(chat.default(), { name: "chat" });
  assert.notEqual(chat.default(), chat.default());
});
