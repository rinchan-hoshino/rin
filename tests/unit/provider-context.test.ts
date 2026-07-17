import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const providerContext = await importBuiltModule<
  typeof import("../../src/core/rin-lib/provider-context.js")
>("dist/core/rin-lib/provider-context.js");

function prunableContext() {
  return [
    { role: "user", content: "turn 1" },
    { role: "toolResult", content: "large old result" },
    { role: "user", content: "turn 2" },
    { role: "user", content: "turn 3" },
    { role: "user", content: "turn 4" },
    { role: "user", content: "turn 5" },
  ];
}

test("provider context wrappers share the pruning policy without mutating input", () => {
  const messages = prunableContext();
  const built = providerContext.buildProviderBoundContextMessages(messages);
  assert.notEqual(built, messages);
  assert.equal(built[1].content, "old tool result omitted");
  assert.equal(messages[1].content, "large old result");

  const mapped = providerContext.mapMessagesToProviderBoundContext(
    [messages[0], messages[1]],
    messages,
  );
  assert.equal(mapped[1].content, "old tool result omitted");
});

test("provider context preserves incomplete and orphan tool-result flows", () => {
  const incompleteAssistant = {
    role: "assistant",
    stopReason: "error",
    errorMessage: "connection failed",
    content: [{ type: "toolCall", name: "write", id: "call-broken" }],
  };
  const interruptedResult = {
    role: "toolResult",
    toolCallId: "call-broken",
    content: "The tool was interrupted.",
  };
  const orphanResult = {
    role: "toolResult",
    toolCallId: "call-orphan",
    content: "Orphan output",
  };
  const messages = [
    { role: "user", content: "start" },
    incompleteAssistant,
    interruptedResult,
    orphanResult,
    { role: "user", content: "next" },
  ];
  assert.equal(
    providerContext.buildProviderBoundContextMessages(messages),
    messages,
  );
  assert.equal(messages[2], interruptedResult);
  assert.equal(messages[3], orphanResult);
});

test("provider context events exist only when a message list changes", () => {
  assert.equal(providerContext.buildProviderBoundContextEvent(null), undefined);
  const unchanged = [{ role: "user", content: "one" }];
  assert.equal(
    providerContext.buildProviderBoundContextEvent({ messages: unchanged }),
    undefined,
  );

  const messages = prunableContext();
  assert.deepEqual(
    providerContext.buildProviderBoundContextEvent({ messages }),
    {
      messages: providerContext.buildProviderBoundContextMessages(messages),
    },
  );
});

test("provider context normalizes numeric and structured token estimates", () => {
  assert.equal(providerContext.normalizeContextTokenEstimate(42), 42);
  assert.equal(
    providerContext.normalizeContextTokenEstimate({ tokens: "18" }),
    18,
  );
  assert.equal(providerContext.normalizeContextTokenEstimate({}), 0);
  assert.equal(providerContext.normalizeContextTokenEstimate(Infinity), 0);
});

test("provider context strips only stale assistant usage after the latest compaction", () => {
  const unchanged = [{ role: "assistant", usage: { input: 1 } }];
  assert.equal(
    providerContext.stripStaleAssistantUsageAfterCompaction(unchanged),
    unchanged,
  );

  const messages = [
    { role: "assistant", timestamp: 10, usage: { input: 1 }, content: "old" },
    { role: "user", timestamp: 15, content: "user" },
    { role: "compactionSummary", timestamp: "1970-01-01T00:00:00.020Z" },
    { role: "assistant", timestamp: "bad", usage: { input: 2 } },
    { role: "assistant", timestamp: 30, content: "no usage" },
    { role: "assistant", timestamp: 31, usage: { input: 3 }, content: "new" },
    { role: "compactionSummary", timestamp: "bad" },
  ];
  const stripped =
    providerContext.stripStaleAssistantUsageAfterCompaction(messages);
  assert.notEqual(stripped, messages);
  assert.equal("usage" in stripped[0], false);
  assert.equal(stripped[1], messages[1]);
  assert.equal(stripped[3], messages[3]);
  assert.equal(stripped[4], messages[4]);
  assert.equal(stripped[5], messages[5]);
  assert.deepEqual(stripped[5].usage, { input: 3 });
});

test("provider context token estimation receives stripped and pruned messages", () => {
  assert.equal(
    providerContext.estimateProviderBoundContextTokens([], undefined),
    0,
  );

  const messages = [
    {
      role: "assistant",
      timestamp: 10,
      usage: { input: 999 },
      content: "before",
    },
    { role: "compactionSummary", timestamp: 20 },
    ...prunableContext(),
  ];
  let estimatedMessages: any[] = [];
  const tokens = providerContext.estimateProviderBoundContextTokens(
    messages,
    (nextMessages) => {
      estimatedMessages = nextMessages;
      return { tokens: 25 };
    },
    { protectRecentTurns: 4, cwd: "/tmp" },
  );
  assert.equal(tokens, 25);
  assert.equal("usage" in estimatedMessages[0], false);
  assert.equal(estimatedMessages[3].content, "old tool result omitted");
});
