import "../support/require-test-sandbox.ts";
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

function toolExchange(id: string) {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id,
          name: "read",
          arguments: { path: `/tmp/${id}` },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: id,
      toolName: "read",
      content: `result ${id}`,
    },
  ];
}

function toolCallPadding(count: number, start = 0) {
  return Array.from({ length: count }, (_, index) =>
    toolExchange(`padding-${start + index}`),
  ).flat();
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

test("provider-bound context injects stable time into every ordinary user input", () => {
  const firstUser = {
    role: "user",
    content: "first",
    timestamp: 1710000000000,
  };
  const image = { type: "image", data: "base64", mimeType: "image/png" };
  const secondUser = {
    role: "user",
    content: [{ type: "text", text: "second" }, image],
    timestamp: 1710003600000,
  };
  const messages = [firstUser, { role: "assistant", content: "done" }];

  const firstPass = providerContext.buildProviderBoundContextMessages(messages);
  const repeatedPass =
    providerContext.buildProviderBoundContextMessages(messages);
  const appendedPass = providerContext.buildProviderBoundContextMessages([
    ...messages,
    secondUser,
  ]);

  assert.notEqual(firstPass, messages);
  assert.match(
    firstPass[0].content,
    /^time: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}\n---\nfirst$/,
  );
  assert.equal(firstUser.content, "first");
  assert.deepEqual(repeatedPass, firstPass);
  assert.deepEqual(appendedPass.slice(0, messages.length), firstPass);
  assert.match(
    appendedPass[2].content[0].text,
    /^time: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}\n---\nsecond$/,
  );
  assert.equal(appendedPass[2].content[1], image);
  assert.equal(secondUser.content[0].text, "second");
});

test("provider-bound context preserves an existing typed chat header", () => {
  const chatText = [
    "time: 2026-08-17 12:43:39 +08:00",
    "runtime metadata: rin prompt context v1",
    "sender user id: owner",
    "sender trust: owner",
    "---",
    "hello",
  ].join("\n");
  const message = {
    role: "user",
    content: [{ type: "text", text: chatText }],
    timestamp: 1710000000000,
  };

  const providerMessages = providerContext.buildProviderBoundContextMessages([
    message,
  ]);

  assert.equal(providerMessages[0], message);
  assert.equal(providerMessages[0].content[0].text, chatText);
  assert.equal(
    providerMessages[0].content[0].text.match(/^time:/gm)?.length,
    1,
  );
});

test("provider-bound token estimates include injected time text", () => {
  const messages = [
    { role: "user", content: "hello", timestamp: 1710000000000 },
  ];
  let estimatedMessages: any[] = [];

  const tokens = providerContext.estimateProviderBoundContextTokens(
    messages,
    (nextMessages: any[]) => {
      estimatedMessages = nextMessages;
      return nextMessages[0].content.length;
    },
  );

  assert.match(estimatedMessages[0].content, /^time: /);
  assert.ok(tokens > messages[0].content.length);
  assert.equal(messages[0].content, "hello");
});

test("provider-bound context keeps 63 tool calls before the fourth bucket fills", () => {
  const messages = toolCallPadding(63);
  messages.splice(2, 0, ...padding(300));

  assert.equal(
    providerContext.buildProviderBoundContextMessages(messages),
    messages,
  );
});

test("provider-bound context omits old tool results when the fourth tool-call bucket fills", () => {
  const messages = toolCallPadding(64);
  const oldToolResult = messages[1];
  const retainedToolResult = messages[33];

  const providerMessages =
    providerContext.buildProviderBoundContextMessages(messages);

  assert.notEqual(providerMessages, messages);
  assert.equal(providerMessages[1].content, "pruned");
  assert.equal(providerMessages[33], retainedToolResult);
  assert.equal(oldToolResult.content, "result padding-0");
});

test("provider-bound context exposes custom tool-call bucket sizing through one policy surface", () => {
  const messages = toolCallPadding(5);

  const providerMessages = providerContext.buildProviderBoundContextMessages(
    messages,
    { toolCallBucketSize: 2, retainedToolCallBuckets: 2 },
  );

  assert.equal(providerMessages[1].content, "pruned");
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
  const messages = toolCallPadding(5);
  messages[1] = { ...messages[1], content: "huge old output" };

  const tokens = providerContext.estimateProviderBoundContextTokens(
    messages,
    (nextMessages: any[]) => ({
      tokens: nextMessages.some(
        (message) => message.content === "huge old output",
      )
        ? 900
        : 10,
    }),
    { toolCallBucketSize: 2, retainedToolCallBuckets: 2 },
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

test("provider-bound context maps compaction slices without mutating history", () => {
  const fullContext = toolCallPadding(5);
  fullContext[1] = { ...fullContext[1], content: "huge old output" };
  const summarySlice = [fullContext[0], fullContext[1]];

  const mapped = providerContext.mapMessagesToProviderBoundContext(
    summarySlice,
    fullContext,
    { toolCallBucketSize: 2, retainedToolCallBuckets: 2 },
  );

  assert.notEqual(mapped, summarySlice);
  assert.equal(mapped[0], summarySlice[0]);
  assert.equal(mapped[1].content, "pruned");
  assert.equal(summarySlice[1].content, "huge old output");
});

test("provider-bound compaction projects both summary slices without mutating the event", () => {
  const fullContext = toolCallPadding(5);
  fullContext[1] = { ...fullContext[1], content: "huge old output" };
  const event = {
    preparation: {
      messagesToSummarize: [fullContext[0], fullContext[1]],
      turnPrefixMessages: [fullContext[1]],
    },
  };

  const projected = providerContext.buildProviderBoundCompactionEvent(
    event,
    fullContext,
    { toolCallBucketSize: 2, retainedToolCallBuckets: 2 },
  );

  assert.equal(projected.preparation.messagesToSummarize[1].content, "pruned");
  assert.equal(projected.preparation.turnPrefixMessages[0].content, "pruned");
  assert.equal(
    event.preparation.messagesToSummarize[1].content,
    "huge old output",
  );
  assert.equal(
    event.preparation.turnPrefixMessages[0].content,
    "huge old output",
  );
});

test("provider-bound context event uses the same tool-call bucket policy surface", () => {
  assert.equal(providerContext.buildProviderBoundContextEvent(null), undefined);
  assert.equal(
    providerContext.buildProviderBoundContextEvent({ messages: [] }),
    undefined,
  );
  const messages = toolCallPadding(5);
  messages[1] = { ...messages[1], content: "huge old output" };

  const result = providerContext.buildProviderBoundContextEvent(
    { messages },
    { toolCallBucketSize: 2, retainedToolCallBuckets: 2 },
  );

  assert.equal(result.messages[1].content, "pruned");
});
