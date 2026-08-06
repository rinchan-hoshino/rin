import assert from "node:assert/strict";
import test from "node:test";

const pruning = await import("../../dist/core/rin-lib/session-pruning.js");

function padding(count: number, start = 0) {
  return Array.from({ length: count }, (_, index) => ({
    role: "assistant",
    content: `message-${start + index}`,
  }));
}

test("session pruning defaults to four stable 32-message buckets", () => {
  assert.equal(pruning.RIN_SESSION_PRUNING_MESSAGE_BUCKET_SIZE, 32);
  assert.equal(pruning.RIN_SESSION_PRUNING_RETAINED_BUCKETS, 4);

  const openingResult = { role: "toolResult", content: "opening output" };
  const messages = [openingResult, ...padding(127, 1)];

  assert.equal(messages.length, 128);
  assert.equal(pruning.pruneSessionContextMessages(messages), messages);
  assert.equal(messages[0], openingResult);
});

test("session pruning omits the oldest bucket in one batch at the fifth-bucket rollover", () => {
  const firstResult = { role: "toolResult", content: "bucket 1 start" };
  const lastFirstBucketResult = {
    role: "toolResult",
    content: "bucket 1 end",
  };
  const firstRetainedResult = {
    role: "toolResult",
    content: "bucket 2 start",
  };
  const messages = padding(129);
  messages[0] = firstResult;
  messages[31] = lastFirstBucketResult;
  messages[32] = firstRetainedResult;

  const result = pruning.pruneSessionContextMessages(messages);

  assert.notEqual(result, messages);
  assert.equal(
    result[0].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
  assert.equal(
    result[31].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
  assert.equal(result[32], firstRetainedResult);
  assert.equal(firstResult.content, "bucket 1 start");
});

test("session pruning keeps a stable boundary inside a bucket and advances only on rollover", () => {
  const bucketOneResult = { role: "toolResult", content: "bucket 1" };
  const bucketTwoResult = { role: "toolResult", content: "bucket 2" };
  const at129 = padding(129);
  at129[0] = bucketOneResult;
  at129[32] = bucketTwoResult;
  const at160 = [...at129, ...padding(31, 129)];
  const at161 = [...at160, { role: "assistant", content: "message-160" }];

  const result129 = pruning.pruneSessionContextMessages(at129);
  const result160 = pruning.pruneSessionContextMessages(at160);
  const result161 = pruning.pruneSessionContextMessages(at161);

  assert.equal(
    result129[0].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
  assert.equal(result129[32], bucketTwoResult);
  assert.equal(
    result160[0].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
  assert.equal(result160[32], bucketTwoResult);
  assert.equal(
    result161[32].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
});

test("session pruning reconstructs the same generation deterministically and resets after compaction", () => {
  const openingResult = { role: "toolResult", content: "opening output" };
  const messages = [openingResult, ...padding(128, 1)];

  const first = pruning.pruneSessionContextMessages(messages);
  const reconstructed = pruning.pruneSessionContextMessages(
    structuredClone(messages),
  );

  assert.deepEqual(reconstructed, first);
  assert.equal(
    reconstructed[0].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );

  const newGenerationResult = {
    role: "toolResult",
    content: "post-compaction output",
  };
  const compactedMessages = [
    { role: "compactionSummary", content: "summary" },
    newGenerationResult,
    ...padding(30, 2),
  ];
  assert.equal(
    pruning.pruneSessionContextMessages(compactedMessages),
    compactedMessages,
  );
  assert.equal(compactedMessages[1], newGenerationResult);
});

test("session pruning applies message depth even inside one arbitrarily long user turn", () => {
  const openingToolResult = {
    role: "toolResult",
    content: "x".repeat(25_000),
  };
  const messages = [
    { role: "user", content: "one long turn" },
    openingToolResult,
    ...padding(127, 2),
  ];

  const result = pruning.pruneSessionContextMessages(messages);

  assert.equal(messages.length, 129);
  assert.equal(
    result[1].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
  assert.equal(openingToolResult.content.length, 25_000);
});

test("session pruning supports small custom buckets for deterministic callers", () => {
  const firstResult = { role: "toolResult", content: "bucket 1" };
  const secondResult = { role: "toolResult", content: "bucket 2" };
  const messages = [
    firstResult,
    { role: "assistant", content: "message 2" },
    secondResult,
    { role: "assistant", content: "message 4" },
    { role: "assistant", content: "message 5" },
  ];

  const result = pruning.pruneSessionContextMessages(messages, {
    messageBucketSize: 2,
    retainMessageBuckets: 2,
  });

  assert.equal(
    result[0].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
  assert.equal(result[2], secondResult);
});

test("session pruning can extend bucket protection for an ephemeral source-turn window", () => {
  const oldResult = { role: "toolResult", content: "old output" };
  const protectedResult = { role: "toolResult", content: "source evidence" };
  const messages = [
    oldResult,
    { role: "user", content: "source turn" },
    protectedResult,
    ...padding(6, 3),
  ];

  const result = pruning.pruneSessionContextMessages(messages, {
    messageBucketSize: 2,
    retainMessageBuckets: 2,
    protectRecentTurns: 1,
  });

  assert.equal(
    result[0].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
  assert.equal(result[2], protectedResult);
});

test("session pruning handles snake-case tool-result roles outside retained buckets", () => {
  const oldResult = { role: "tool_result", content: "old output" };
  const messages = [oldResult, ...padding(128, 1)];

  const result = pruning.pruneSessionContextMessages(messages);

  assert.equal(
    result[0].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
});

test("session pruning changes only old tool-result content", () => {
  const oldUserImage = { type: "image", data: "old-user-base64" };
  const oldResult = {
    role: "toolResult",
    toolCallId: "call-old",
    toolName: "read",
    content: "old output",
    isError: true,
  };
  const messages = [
    { role: "user", content: [{ type: "text", text: "turn" }, oldUserImage] },
    oldResult,
    ...padding(127, 2),
  ];

  const result = pruning.pruneSessionContextMessages(messages);

  assert.equal(result.length, messages.length);
  assert.equal(result[0], messages[0]);
  assert.equal(result[0].content[1], oldUserImage);
  assert.deepEqual({ ...result[1], content: oldResult.content }, oldResult);
  assert.equal(result[1].role, oldResult.role);
  assert.equal(result[1].toolCallId, oldResult.toolCallId);
  assert.equal(result[1].toolName, oldResult.toolName);
  assert.equal(result[1].isError, true);
});

test("session pruning keeps tool-result content shape stable and is idempotent", () => {
  const messages = [
    {
      role: "toolResult",
      content: [{ type: "text", text: "old output" }],
    },
    ...padding(128, 1),
  ];

  const once = pruning.pruneSessionContextMessages(messages);
  assert.deepEqual(once[0].content, [
    { type: "text", text: pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT },
  ]);
  assert.equal(pruning.pruneSessionContextMessages(once), once);
});

test("session pruning preserves old Pi-classified skill read results", () => {
  const skillReadResult = {
    role: "toolResult",
    toolCallId: "call-skill",
    toolName: "read",
    content: "skill instructions",
  };
  const ordinaryReadResult = {
    role: "toolResult",
    toolCallId: "call-readme",
    toolName: "read",
    content: "old read output",
  };
  const messages = padding(129);
  messages[0] = {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call-skill",
        name: "read",
        arguments: {
          path: "/home/rin/.rin/self_improve/skills/demo/SKILL.md",
        },
      },
      {
        type: "toolCall",
        id: "call-readme",
        name: "read",
        arguments: { path: "/tmp/demo/README.md" },
      },
    ],
  };
  messages[1] = skillReadResult;
  messages[2] = ordinaryReadResult;

  const result = pruning.pruneSessionContextMessages(messages);

  assert.equal(result[1], skillReadResult);
  assert.equal(
    result[2].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
  assert.equal(ordinaryReadResult.content, "old read output");
});
