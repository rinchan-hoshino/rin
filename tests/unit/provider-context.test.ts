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

test("provider-bound context policy prunes images by role and protected turn window", () => {
  const oldUserImage = {
    type: "image",
    data: "old-user-base64",
    mimeType: "image/png",
  };
  const recentUserImage = {
    type: "image",
    data: "recent-user-base64",
    mimeType: "image/png",
  };
  const assistantImage = {
    type: "image",
    data: "assistant-base64",
    mimeType: "image/png",
  };
  const messages = [
    {
      role: "user",
      content: [{ type: "text", text: "turn 1" }, oldUserImage],
    },
    { role: "assistant", content: [{ type: "text", text: "done 1" }] },
    {
      role: "user",
      content: [{ type: "text", text: "turn 2" }, recentUserImage],
    },
    { role: "assistant", content: [{ type: "text", text: "done 2" }] },
    { role: "user", content: [{ type: "text", text: "turn 3" }] },
    { role: "assistant", content: [{ type: "text", text: "done 3" }] },
    { role: "user", content: [{ type: "text", text: "turn 4" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "done 4" }, assistantImage],
    },
    { role: "user", content: [{ type: "text", text: "turn 5" }] },
  ];

  const providerMessages =
    providerContext.buildProviderBoundContextMessages(messages);

  assert.notEqual(providerMessages, messages);
  assert.deepEqual(providerMessages[0].content, [
    { type: "text", text: "turn 1" },
    { type: "text", text: "[image omitted to save context.]" },
  ]);
  assert.equal(providerMessages[2].content[1], recentUserImage);
  assert.deepEqual(providerMessages[7].content, [
    { type: "text", text: "done 4" },
    { type: "text", text: "[image omitted to save context.]" },
  ]);
  assert.equal(messages[0].content[1], oldUserImage);
  assert.equal(messages[7].content[1], assistantImage);
});

test("provider-bound context policy prunes nested assistant images", () => {
  const messages = [
    { role: "user", content: "start" },
    {
      role: "assistant",
      content: [
        {
          type: "paragraph",
          children: [
            { type: "text", text: "see " },
            { type: "image", attrs: { src: "file:///tmp/large.png" } },
          ],
        },
      ],
    },
  ];

  const providerMessages =
    providerContext.buildProviderBoundContextMessages(messages);

  assert.deepEqual(providerMessages[1].content, [
    {
      type: "paragraph",
      children: [
        { type: "text", text: "see " },
        { type: "text", text: "[image omitted to save context.]" },
      ],
    },
  ]);
});

test("provider-bound context policy keeps non-image rich media nodes", () => {
  const filePart = { type: "file", attrs: { src: "file:///tmp/large.zip" } };
  const messages = [
    { role: "user", content: "start" },
    {
      role: "assistant",
      content: [{ type: "text", text: "see " }, filePart],
    },
  ];

  const providerMessages =
    providerContext.buildProviderBoundContextMessages(messages);

  assert.equal(providerMessages, messages);
  assert.equal(providerMessages[1].content[1], filePart);
});

test("provider-bound context policy omits old tool results", () => {
  const messages = [
    { role: "user", content: "turn 1" },
    { role: "toolResult", content: "huge old output" },
    { role: "assistant", content: "done 1" },
    { role: "user", content: "turn 2" },
    { role: "assistant", content: "done 2" },
    { role: "user", content: "turn 3" },
    { role: "assistant", content: "done 3" },
    { role: "user", content: "turn 4" },
    { role: "assistant", content: "done 4" },
    { role: "user", content: "turn 5" },
    { role: "assistant", content: "done 5" },
  ];

  const providerMessages =
    providerContext.buildProviderBoundContextMessages(messages);

  assert.notEqual(providerMessages, messages);
  assert.equal(
    providerMessages[1].content,
    "[old tool result omitted to save context.]",
  );
  assert.equal(messages[1].content, "huge old output");
});

for (const stopReason of ["error", "aborted"] as const) {
  test(`provider-bound context drops ${stopReason} assistant tool calls and their tool results`, () => {
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

    assert.notEqual(providerMessages, messages);
    assert.equal(providerMessages.includes(incompleteAssistant), false);
    assert.equal(providerMessages.includes(interruptedResult), false);
    assert.equal(
      providerMessages.some(
        (message: any) => message?.toolCallId === "call-broken",
      ),
      false,
    );
    assert.equal(
      providerMessages.some(
        (message: any) => message?.toolCallId === "call-ok",
      ),
      true,
    );
    assert.equal(messages.includes(incompleteAssistant), true);
    assert.equal(messages.includes(interruptedResult), true);
  });
}

test("provider-bound context pruning does not depend on model", () => {
  const incompleteAssistant = {
    role: "assistant",
    stopReason: "error",
    errorMessage: "WebSocket error",
    content: [{ type: "toolCall", name: "write", id: "call-broken" }],
  };
  const interruptedResult = {
    role: "toolResult",
    toolCallId: "call-broken",
    content: "The tool was interrupted because the daemon exited.",
  };
  const messages = [
    { role: "user", content: "start" },
    incompleteAssistant,
    interruptedResult,
    { role: "user", content: "next" },
  ];

  const providerMessages =
    providerContext.buildProviderBoundContextMessages(messages);

  assert.deepEqual(providerMessages, [messages[0], messages[3]]);
});

test("provider-bound context drops incomplete assistant messages without tool calls", () => {
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

  assert.deepEqual(providerMessages, [messages[0], messages[2]]);
});

test("provider-bound context drops orphan tool results without dropping later turns", () => {
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

  assert.deepEqual(providerMessages, [messages[0], messages[2]]);
  assert.equal(messages.includes(orphan), true);
});

test("provider-bound context maps compaction slices without shifting dropped messages", () => {
  const incompleteAssistant = {
    role: "assistant",
    stopReason: "error",
    errorMessage: "WebSocket error",
    content: [{ type: "toolCall", name: "write", id: "call-broken" }],
  };
  const interruptedResult = {
    role: "toolResult",
    toolCallId: "call-broken",
    content: "The tool was interrupted because the daemon exited.",
  };
  const oldToolResult = { role: "toolResult", content: "huge old output" };
  const summarizedSlice = [
    incompleteAssistant,
    interruptedResult,
    oldToolResult,
  ];
  const fullContext = [
    { role: "user", content: "turn 1" },
    incompleteAssistant,
    interruptedResult,
    oldToolResult,
    { role: "assistant", content: "done 1" },
    { role: "user", content: "turn 2" },
    { role: "assistant", content: "done 2" },
    { role: "user", content: "turn 3" },
    { role: "assistant", content: "done 3" },
    { role: "user", content: "turn 4" },
    { role: "assistant", content: "done 4" },
    { role: "user", content: "turn 5" },
    { role: "assistant", content: "done 5" },
  ];

  const mapped = providerContext.mapMessagesToProviderBoundContext(
    summarizedSlice,
    fullContext,
  );

  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].content, "[old tool result omitted to save context.]");
  assert.equal(oldToolResult.content, "huge old output");
});

test("provider-bound context policy maps compaction slices through the full context view", () => {
  const oldToolResult = { role: "toolResult", content: "huge old output" };
  const summarizedSlice = [
    { role: "user", content: "turn 1" },
    oldToolResult,
    { role: "assistant", content: "done 1" },
  ];
  const fullContext = [
    summarizedSlice[0],
    oldToolResult,
    summarizedSlice[2],
    { role: "user", content: "turn 2" },
    { role: "assistant", content: "done 2" },
    { role: "user", content: "turn 3" },
    { role: "assistant", content: "done 3" },
    { role: "user", content: "turn 4" },
    { role: "assistant", content: "done 4" },
    { role: "user", content: "turn 5" },
    { role: "assistant", content: "done 5" },
  ];

  const mapped = providerContext.mapMessagesToProviderBoundContext(
    summarizedSlice,
    fullContext,
  );

  assert.notEqual(mapped, summarizedSlice);
  assert.equal(mapped[1].content, "[old tool result omitted to save context.]");
  assert.equal(oldToolResult.content, "huge old output");
});

test("provider-bound context policy owns token estimates", () => {
  const messages = [
    { role: "user", content: "turn 1" },
    { role: "toolResult", content: "huge old output" },
    { role: "assistant", content: "done 1" },
    { role: "user", content: "turn 2" },
    { role: "assistant", content: "done 2" },
    { role: "user", content: "turn 3" },
    { role: "assistant", content: "done 3" },
    { role: "user", content: "turn 4" },
    { role: "assistant", content: "done 4" },
    { role: "user", content: "turn 5" },
    { role: "assistant", content: "done 5" },
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
  );

  assert.equal(tokens, 10);
});

test("provider-bound context event uses the same policy surface", () => {
  const messages = [
    { role: "user", content: "turn 1" },
    { role: "toolResult", content: "huge old output" },
    { role: "assistant", content: "done 1" },
    { role: "user", content: "turn 2" },
    { role: "assistant", content: "done 2" },
    { role: "user", content: "turn 3" },
    { role: "assistant", content: "done 3" },
    { role: "user", content: "turn 4" },
    { role: "assistant", content: "done 4" },
    { role: "user", content: "turn 5" },
    { role: "assistant", content: "done 5" },
  ];

  const result = providerContext.buildProviderBoundContextEvent({ messages });

  assert.equal(
    result.messages[1].content,
    "[old tool result omitted to save context.]",
  );
});
