import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const promptContext = await importBuiltModule<
  typeof import("../../src/core/chat-bridge/prompt-context.js")
>("dist/core/chat-bridge/prompt-context.js");

test("chat bridge prompt-context facade forwards the public context contract", () => {
  const meta = {
    source: "chat-bridge",
    sentAt: 1710000000000,
    chatKey: "telegram/bot:owner",
    chatType: "private",
    userId: "owner",
    nickname: "Owner",
    identity: "OWNER",
  };
  const formatted = promptContext.formatPromptContext(meta, "hello");
  assert.match(formatted, /runtime metadata: rin prompt context v1/);
  assert.match(formatted, /sender trust: owner/);
  assert.ok(formatted.endsWith("---\nhello"));
  assert.equal(
    promptContext.injectPromptContextHeader(meta, formatted),
    formatted,
  );
  assert.match(
    promptContext.formatPromptContextSystemPromptBlock(meta),
    /Chat context:/,
  );
});
