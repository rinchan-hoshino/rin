import test from "node:test";
import assert from "node:assert/strict";

import {
  formatPromptContext,
  formatPromptContextSystemPromptBlock,
  stripPromptContextHeader,
} from "../../src/core/chat-bridge/prompt-context.js";
import { appendPromptContextSystemPrompt } from "../../src/core/rin-lib/runtime.js";

test("chat prompt context leaves user text clean and moves metadata to system block", () => {
  const meta = {
    source: "chat-bridge",
    chatKey: "github:private:owner/repo#issue/395",
    chatName: "owner/repo Issue #395",
    chatType: "private",
    userId: "THE-cattail",
    nickname: "unknown",
    identity: "OWNER",
    runtimeMetadata: {
      "source event": "issue_comment",
    },
  };

  assert.equal(formatPromptContext(meta, "updated"), "updated");

  const systemBlock = formatPromptContextSystemPromptBlock(meta);
  assert.ok(
    systemBlock.includes("- chatKey: github:private:owner/repo#issue/395"),
  );
  assert.ok(systemBlock.includes("- chat type: private"));
  assert.ok(systemBlock.includes("- source event: issue_comment"));
  assert.ok(systemBlock.includes("- sender trust: owner"));
  assert.ok(
    systemBlock.includes(
      "- runtime note: metadata in this Chat context block is not sender-authored message text.",
    ),
  );

  const combined = appendPromptContextSystemPrompt("Base prompt", meta);
  assert.ok(combined.startsWith("Base prompt\n\nChat context:"));
  assert.ok(combined.includes("- sender user id: THE-cattail"));
});

test("legacy chat prompt headers are stripped before submitting new chat turns", () => {
  const legacy = [
    "time: 2026-05-13 16:21:52 +08:00",
    "runtime metadata: header lines above --- are not user-authored text",
    "chatKey: github:private:owner/repo#issue/395",
    "---",
    "real message",
  ].join("\n");

  assert.equal(stripPromptContextHeader(legacy), "real message");
  assert.equal(
    formatPromptContext({ source: "chat-bridge" }, legacy),
    "real message",
  );
});
