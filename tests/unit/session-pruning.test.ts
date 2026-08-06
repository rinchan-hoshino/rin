import test from "node:test";
import assert from "node:assert/strict";

import { importBuiltModule } from "../support/import-built-module.js";

const pruning = await importBuiltModule<
  typeof import("../../src/core/rin-lib/session-pruning.js")
>("dist/core/rin-lib/session-pruning.js");

function padding(count: number, start = 0) {
  return Array.from({ length: count }, (_, index) => ({
    role: "assistant",
    content: `message-${start + index}`,
  }));
}

test("session pruning normalizes public bucket boundaries", () => {
  assert.equal(pruning.normalizeMessageBucketSize(7.9), 7);
  assert.equal(pruning.normalizeMessageBucketSize(0), 32);
  assert.equal(pruning.normalizeMessageBucketSize(Infinity), 32);
  assert.equal(pruning.normalizeRetainedMessageBuckets("3"), 3);
  assert.equal(pruning.normalizeRetainedMessageBuckets(-1), 4);
  assert.equal(pruning.findProtectedMessageBucketStart([], 0, 0), 0);
  assert.equal(
    pruning.findProtectedMessageBucketStart(padding(9), 2.9, "2" as any),
    6,
  );
  assert.deepEqual(pruning.pruneSessionContextMessages(null as any), []);
});

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
    retainedBuckets: 2,
  });

  assert.equal(
    result[0].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
  assert.equal(result[2], secondResult);
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

test("session pruning keeps canonical result omission while allowing per-tool history overrides", () => {
  const call = {
    type: "toolCall",
    id: "call-custom",
    name: "custom",
    arguments: { payload: "large input" },
  };
  const result = {
    role: "toolResult",
    toolCallId: "call-custom",
    toolName: "custom",
    content: "large output",
  };
  const messages = padding(129);
  messages[0] = { role: "assistant", content: [call] };
  messages[1] = result;

  const canonical = pruning.pruneSessionContextMessages(messages);
  assert.equal(canonical[0], messages[0]);
  assert.equal(
    canonical[1].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );

  const customized = pruning.pruneSessionContextMessages(messages, {
    toolHistoryPolicies: {
      custom: {
        compactCallArguments: () => ({ payload: "custom input form" }),
        protect: () => ({ result: true }),
      },
    },
  });
  assert.deepEqual(customized[0].content[0].arguments, {
    payload: "custom input form",
  });
  assert.equal(customized[1], result);
  assert.equal(customized.length, messages.length);
  assert.equal(customized[0].content[0].id, "call-custom");
});

test("session pruning compacts old write and edit inputs with stable built-in forms", () => {
  const messages = padding(129);
  messages[0] = {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call-write",
        name: "write",
        arguments: { path: "/tmp/a", content: "large file body" },
      },
      {
        type: "toolCall",
        id: "call-edit",
        name: "edit",
        arguments: {
          path: "/tmp/b",
          edits: [
            { oldText: "large old text", newText: "large new text" },
            { oldText: "second old text", newText: "second new text" },
          ],
        },
      },
    ],
  };
  messages[1] = {
    role: "toolResult",
    toolCallId: "call-write",
    toolName: "write",
    content: "written",
  };
  messages[2] = {
    role: "toolResult",
    toolCallId: "call-edit",
    toolName: "edit",
    content: "edited",
  };

  const once = pruning.pruneSessionContextMessages(messages);
  assert.deepEqual(once[0].content[0].arguments, {
    path: "/tmp/a",
    content: pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_INPUT,
  });
  assert.deepEqual(once[0].content[1].arguments, {
    path: "/tmp/b",
    edits: [
      {
        oldText: pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_INPUT,
        newText: pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_INPUT,
      },
    ],
  });
  assert.equal(
    once[1].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
  assert.equal(
    once[2].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
  assert.equal(pruning.pruneSessionContextMessages(once), once);
});

test("session pruning protects failed built-in exchanges and ignores malformed history", () => {
  const writeCall = {
    type: "toolCall",
    id: "call-write-error",
    name: "write",
    arguments: { path: "/tmp/a", content: "preserve me" },
  };
  const editCall = {
    type: "TOOLCALL",
    toolCallId: "call-edit-error",
    toolName: "edit",
    arguments: {
      path: "/tmp/b",
      edits: [{ oldText: "before", newText: "after" }],
    },
  };
  const writeResult = {
    role: "toolResult",
    toolCallId: "call-write-error",
    content: "write failed",
    isError: true,
  };
  const editResult = {
    role: "tool_result",
    toolCallId: "call-edit-error",
    content: "edit failed",
    isError: true,
  };
  const messages = padding(129);
  messages[0] = {
    role: "assistant",
    content: [
      { type: "text", text: "not a call" },
      writeCall,
      { ...writeCall, arguments: { content: "duplicate" } },
      editCall,
      { type: "toolCall", id: "", name: "write", arguments: {} },
    ],
  };
  messages[1] = writeResult;
  messages[2] = editResult;
  messages[3] = {
    role: "toolResult",
    toolCallId: "missing-call",
    content: "orphan",
  };
  messages[4] = {
    role: "toolResult",
    toolCallId: "call-write-error",
    content: "duplicate result",
  };

  const pruned = pruning.pruneSessionContextMessages(messages);

  assert.equal(pruned[0], messages[0]);
  assert.equal(pruned[1], writeResult);
  assert.equal(pruned[2], editResult);
  assert.equal(
    pruned[3].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
  assert.equal(pruned[4], messages[4]);
});

test("session pruning leaves already compact or unsupported built-in inputs stable", () => {
  const calls = [
    {
      type: "toolCall",
      id: "write-array",
      name: "write",
      arguments: [],
    },
    {
      type: "toolCall",
      id: "write-omitted",
      name: "write",
      arguments: {
        content: pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_INPUT,
      },
    },
    {
      type: "toolCall",
      id: "write-non-string",
      name: "write",
      arguments: { content: 7 },
    },
    {
      type: "toolCall",
      id: "edit-missing",
      name: "edit",
      arguments: {},
    },
    {
      type: "toolCall",
      id: "edit-empty",
      name: "edit",
      arguments: { edits: [] },
    },
    {
      type: "toolCall",
      id: "edit-omitted",
      name: "edit",
      arguments: {
        edits: [
          {
            oldText: pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_INPUT,
            newText: pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_INPUT,
          },
        ],
      },
    },
  ];
  const messages = padding(129);
  messages[0] = { role: "assistant", content: calls };
  calls.forEach((call, index) => {
    messages[index + 1] = {
      role: "toolResult",
      toolCallId: call.id,
      content: `result-${index}`,
    };
  });

  const pruned = pruning.pruneSessionContextMessages(messages);

  assert.equal(pruned[0], messages[0]);
  for (let index = 1; index <= calls.length; index += 1) {
    assert.equal(
      pruned[index].content,
      pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
    );
  }
});

test("session pruning composes custom call and result policies at old boundaries", () => {
  const calls = [
    ["compact", { value: "large" }],
    ["protect-call", { value: "keep-call" }],
    ["protect-result", { value: "compact-call" }],
    ["same", { value: "same" }],
  ].map(([id, argumentsValue]) => ({
    type: "toolCall",
    id,
    name: "custom",
    arguments: argumentsValue,
  }));
  const messages = padding(129);
  messages[0] = { role: "assistant", content: calls };
  calls.forEach((call, index) => {
    messages[index + 1] = {
      role: "toolResult",
      toolCallId: call.id,
      content: `result-${call.id}`,
    };
  });
  const observedContexts: any[] = [];

  const pruned = pruning.pruneSessionContextMessages(messages, {
    cwd: "/workspace/owner",
    toolHistoryPolicies: {
      custom: {
        protect(exchange, policyContext) {
          observedContexts.push(policyContext);
          if (exchange.toolCallId === "protect-call") return { call: true };
          if (exchange.toolCallId === "protect-result") {
            return { result: true };
          }
          return undefined;
        },
        compactCallArguments(value, exchange) {
          if (exchange.toolCallId === "same") return value;
          return { compacted: exchange.toolCallId };
        },
        compactResultContent(content, exchange) {
          if (exchange.toolCallId === "same") return content;
          return `compact-result-${exchange.toolCallId}`;
        },
      },
    },
  });

  assert.ok(
    observedContexts.every(
      (policyContext) =>
        policyContext.cwd === "/workspace/owner" &&
        policyContext.pruningBoundary === 32,
    ),
  );
  assert.deepEqual(pruned[0].content[0].arguments, { compacted: "compact" });
  assert.equal(pruned[1].content, "compact-result-compact");
  assert.equal(pruned[0].content[1], calls[1]);
  assert.equal(pruned[2].content, "compact-result-protect-call");
  assert.deepEqual(pruned[0].content[2].arguments, {
    compacted: "protect-result",
  });
  assert.equal(pruned[3], messages[3]);
  assert.equal(pruned[0].content[3], calls[3]);
  assert.equal(
    pruned[4].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );

  const retained = padding(129);
  retained[0] = {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "retained-result",
        name: "custom",
        arguments: { value: "unchanged" },
      },
    ],
  };
  retained[32] = {
    role: "toolResult",
    toolCallId: "retained-result",
    content: "retained output",
  };
  assert.equal(
    pruning.pruneSessionContextMessages(retained, {
      toolHistoryPolicies: {
        custom: {
          compactCallArguments: () => ({ compacted: true }),
          compactResultContent: () => "compacted output",
        },
      },
    }),
    retained,
  );
});
