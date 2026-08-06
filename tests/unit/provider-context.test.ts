import test from "node:test";
import assert from "node:assert/strict";

import { importBuiltModule } from "../support/import-built-module.js";

const providerContext = await importBuiltModule<
  typeof import("../../src/core/rin-lib/provider-context.js")
>("dist/core/rin-lib/provider-context.js");

function padding(count: number, start = 0) {
  return Array.from({ length: count }, (_, index) => ({
    role: "assistant",
    content: `message ${start + index}`,
  }));
}

test("provider-bound context leaves non-tool rich content unchanged", () => {
  const userContent = "see image: [image: demo.png](file:///tmp/demo.png)";
  const assistantContent = [
    { type: "text", text: "done" },
    { type: "image", data: "assistant-base64", mimeType: "image/png" },
  ];
  const toolResultContent = [
    { type: "text", text: "caption" },
    { type: "image", data: "tool-base64", mimeType: "image/png" },
  ];
  const messages = [
    { role: "user", content: userContent },
    { role: "assistant", content: assistantContent },
    {
      role: "toolResult",
      toolCallId: "call-image",
      content: toolResultContent,
    },
  ];

  const providerMessages =
    providerContext.buildProviderBoundContextMessages(messages);

  assert.equal(providerMessages, messages);
  assert.equal(providerMessages[0].content, userContent);
  assert.equal(providerMessages[1].content, assistantContent);
  assert.equal(providerMessages[2].content, toolResultContent);
});

test("provider-bound context keeps the first four complete 32-message buckets", () => {
  const openingToolResult = {
    role: "toolResult",
    content: "x".repeat(25_000),
  };
  const messages = [openingToolResult, ...padding(127, 1)];

  assert.equal(
    providerContext.buildProviderBoundContextMessages(messages),
    messages,
  );
  assert.equal(messages[0], openingToolResult);
});

test("provider-bound context omits old tool results at a stable bucket rollover", () => {
  const oldToolResult = { role: "toolResult", content: "old output" };
  const retainedToolResult = {
    role: "toolResult",
    content: "retained output",
  };
  const messages = padding(129);
  messages[0] = oldToolResult;
  messages[32] = retainedToolResult;

  const providerMessages =
    providerContext.buildProviderBoundContextMessages(messages);

  assert.notEqual(providerMessages, messages);
  assert.equal(providerMessages[0].content, "old tool result omitted");
  assert.equal(providerMessages[32], retainedToolResult);
  assert.equal(messages[0].content, "old output");
});

test("provider-bound context exposes custom bucket sizing through one policy surface", () => {
  const oldToolResult = { role: "toolResult", content: "old output" };
  const messages = [oldToolResult, ...padding(4, 1)];

  const providerMessages = providerContext.buildProviderBoundContextMessages(
    messages,
    { messageBucketSize: 2, retainedBuckets: 2 },
  );

  assert.equal(providerMessages[0].content, "old tool result omitted");
});

for (const stopReason of ["error", "aborted"] as const) {
  test(`provider-bound context keeps ${stopReason} assistant tool calls and their recent tool results`, () => {
    const incompleteAssistant = {
      role: "assistant",
      stopReason,
      errorMessage: stopReason === "error" ? "WebSocket error" : undefined,
      content: [
        { type: "text", text: "working preface" },
        { type: "toolCall", name: "write", id: "call-broken" },
      ],
    };
    const interruptedResult = {
      role: "toolResult",
      toolCallId: "call-broken",
      content: "The tool was interrupted because the daemon exited.",
    };
    const messages = [
      { role: "user", content: "start" },
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "read", id: "call-ok" }],
      },
      { role: "toolResult", toolCallId: "call-ok", content: "ok" },
      incompleteAssistant,
      interruptedResult,
      { role: "user", content: "next" },
    ];

    const providerMessages =
      providerContext.buildProviderBoundContextMessages(messages);

    assert.equal(providerMessages, messages);
    assert.equal(providerMessages.includes(incompleteAssistant), true);
    assert.equal(providerMessages.includes(interruptedResult), true);
  });
}

test("provider-bound context keeps incomplete assistant messages without tool calls", () => {
  const incompleteAssistant = {
    role: "assistant",
    stopReason: "error",
    errorMessage: "WebSocket error",
    content: [{ type: "text", text: "partial text" }],
  };
  const messages = [
    { role: "user", content: "start" },
    incompleteAssistant,
    { role: "user", content: "next" },
  ];

  const providerMessages =
    providerContext.buildProviderBoundContextMessages(messages);

  assert.equal(providerMessages, messages);
});

test("provider-bound context keeps recent orphan tool results", () => {
  const orphan = {
    role: "toolResult",
    toolCallId: "call-missing",
    content: "orphan output",
  };
  const messages = [
    { role: "user", content: "start" },
    orphan,
    { role: "user", content: "next" },
  ];

  const providerMessages =
    providerContext.buildProviderBoundContextMessages(messages);

  assert.equal(providerMessages, messages);
  assert.equal(messages.includes(orphan), true);
});

test("provider-bound context policy owns token estimates", () => {
  const messages = [
    { role: "toolResult", content: "huge old output" },
    ...padding(4, 1),
  ];

  const tokens = providerContext.estimateProviderBoundContextTokens(
    messages,
    (nextMessages: any[]) => ({
      tokens: nextMessages.some(
        (message) => message.content === "huge old output",
      )
        ? 900
        : 10,
    }),
    { messageBucketSize: 2, retainedBuckets: 2 },
  );

  assert.equal(tokens, 10);
});

test("provider-bound context normalizes estimates and stale usage around compaction", () => {
  assert.equal(providerContext.normalizeContextTokenEstimate(12), 12);
  assert.equal(
    providerContext.normalizeContextTokenEstimate({ tokens: "7" }),
    7,
  );
  assert.equal(
    providerContext.normalizeContextTokenEstimate({ tokens: Infinity }),
    0,
  );
  assert.equal(providerContext.normalizeContextTokenEstimate(null), 0);
  assert.equal(
    providerContext.estimateProviderBoundContextTokens([], undefined),
    0,
  );
  assert.equal(
    providerContext.stripStaleAssistantUsageAfterCompaction(null as any),
    null,
  );

  const unchanged = [{ role: "assistant", usage: { input: 1 }, timestamp: 1 }];
  assert.equal(
    providerContext.stripStaleAssistantUsageAfterCompaction(unchanged),
    unchanged,
  );
  const before = {
    role: "assistant",
    usage: { input: 2 },
    timestamp: "2026-07-26T00:00:00.000Z",
  };
  const sameTime = {
    role: "assistant",
    usage: { input: 3 },
    timestamp: "2026-07-27T00:00:00.000Z",
  };
  const after = {
    role: "assistant",
    usage: { input: 4 },
    timestamp: "2026-07-28T00:00:00.000Z",
  };
  const invalid = {
    role: "assistant",
    usage: { input: 5 },
    timestamp: "not-a-date",
  };
  const noUsage = { role: "assistant", timestamp: 1 };
  const user = { role: "user", usage: { input: 9 }, timestamp: 1 };
  const summaryOld = {
    role: "compactionSummary",
    timestamp: "2026-07-26T12:00:00.000Z",
  };
  const summary = {
    role: "compactionSummary",
    timestamp: "2026-07-27T00:00:00.000Z",
  };
  const stripped = providerContext.stripStaleAssistantUsageAfterCompaction([
    null,
    { role: "assistant", usage: { input: 6 }, timestamp: Infinity },
    { role: "assistant", usage: { input: 7 }, timestamp: {} },
    before,
    summaryOld,
    sameTime,
    after,
    invalid,
    noUsage,
    user,
    summary,
  ]);
  assert.equal(stripped[0], null);
  assert.equal(stripped[1].usage.input, 6);
  assert.equal(stripped[2].usage.input, 7);
  assert.equal("usage" in stripped[3], false);
  assert.equal("usage" in stripped[5], false);
  assert.equal(stripped[6], after);
  assert.equal(stripped[7], invalid);
  assert.equal(stripped[8], noUsage);
  assert.equal(stripped[9], user);

  const afterOnly = [
    summary,
    {
      role: "assistant",
      usage: { input: 8 },
      timestamp: "2026-07-28T00:00:00.000Z",
    },
  ];
  assert.equal(
    providerContext.stripStaleAssistantUsageAfterCompaction(afterOnly),
    afterOnly,
  );
});

test("provider-bound context event uses the same bucket policy surface", () => {
  assert.equal(providerContext.buildProviderBoundContextEvent(null), undefined);
  assert.equal(
    providerContext.buildProviderBoundContextEvent({ messages: [] }),
    undefined,
  );
  const messages = [
    { role: "toolResult", content: "huge old output" },
    ...padding(4, 1),
  ];

  const result = providerContext.buildProviderBoundContextEvent(
    { messages },
    { messageBucketSize: 2, retainedBuckets: 2 },
  );

  assert.equal(result.messages[0].content, "old tool result omitted");
});
