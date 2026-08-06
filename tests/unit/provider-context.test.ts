import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const providerContext = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-lib", "provider-context.js"),
  ).href
);

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

test("provider-bound context event uses the same bucket policy surface", () => {
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
