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

function toolCallMessage(id: string, name = "read", argumentsValue: any = {}) {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id,
        name,
        arguments: argumentsValue,
      },
    ],
  };
}

function toolExchange(id: string, name = "read", argumentsValue: any = {}) {
  return [
    toolCallMessage(id, name, argumentsValue),
    {
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      content: `result-${id}`,
    },
  ];
}

function toolCallPadding(count: number, start = 0) {
  return Array.from({ length: count }, (_, index) =>
    toolExchange(`padding-${start + index}`),
  ).flat();
}

function countToolCalls(messages: any[]) {
  return messages.reduce(
    (count, message) =>
      count +
      (Array.isArray(message?.content)
        ? message.content.filter(
            (part: any) =>
              String(part?.type || "").toLowerCase() === "toolcall" &&
              String(part?.id ?? part?.toolCallId ?? "").trim(),
          ).length
        : 0),
    0,
  );
}

function ageContext(messages: any[], totalToolCalls = 64) {
  const remaining = totalToolCalls - countToolCalls(messages);
  return remaining > 0
    ? [...messages, ...toolCallPadding(remaining, 10_000)]
    : messages;
}

test("session pruning normalizes public tool-call bucket boundaries", () => {
  assert.equal(pruning.normalizeToolCallBucketSize(7.9), 7);
  assert.equal(pruning.normalizeToolCallBucketSize(0), 16);
  assert.equal(pruning.normalizeToolCallBucketSize(Infinity), 16);
  assert.equal(pruning.normalizeRetainedToolCallBuckets("3"), 3);
  assert.equal(pruning.normalizeRetainedToolCallBuckets(-1), 4);
  assert.equal(pruning.findProtectedToolCallBucketStart([], 0, 0), 0);
  assert.equal(
    pruning.findProtectedToolCallBucketStart(
      [...padding(100), ...toolCallPadding(9)],
      2.9,
      "2" as any,
    ),
    6,
  );
  assert.deepEqual(pruning.pruneSessionContextMessages(null as any), []);
});

test("session pruning counts only tool calls and counts each call once", () => {
  assert.equal(pruning.RIN_SESSION_PRUNING_TOOL_CALL_BUCKET_SIZE, 16);
  assert.equal(pruning.RIN_SESSION_PRUNING_RETAINED_TOOL_CALL_BUCKETS, 4);

  const openingExchange = toolExchange("opening");
  const messages = [
    { role: "user", content: "not counted" },
    ...padding(300),
    ...openingExchange,
    ...toolCallPadding(62, 1),
    ...padding(300, 300),
  ];

  assert.equal(pruning.pruneSessionContextMessages(messages), messages);
  assert.equal(messages.includes(openingExchange[1]), true);

  const repeatedIdsStillRepresentTwoCalls = [
    ...toolCallPadding(62),
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "repeated", name: "read", arguments: {} },
        { type: "toolCall", id: "repeated", name: "read", arguments: {} },
      ],
    },
  ];
  assert.equal(
    pruning.findProtectedToolCallBucketStart(
      repeatedIdsStillRepresentTwoCalls,
      16,
      4,
    ),
    16,
  );
});

test("session pruning omits the oldest tool-call bucket when the fourth fills", () => {
  const beforeFull = toolCallPadding(63);
  assert.equal(pruning.pruneSessionContextMessages(beforeFull), beforeFull);

  const messages = [...beforeFull, ...toolExchange("fills-fourth-bucket")];
  const result = pruning.pruneSessionContextMessages(messages);

  assert.notEqual(result, messages);
  assert.equal(
    result[1].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
  assert.equal(
    result[31].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
  assert.equal(result[33], messages[33]);
});

test("session pruning keeps a stable tool-call boundary inside a bucket", () => {
  const atThree = toolCallPadding(3);
  const atFour = [...atThree, ...toolExchange("four")];
  const atFive = [...atFour, ...toolExchange("five")];
  const atSix = [...atFive, ...toolExchange("six")];
  const options = { toolCallBucketSize: 2, retainedToolCallBuckets: 2 };

  assert.equal(pruning.pruneSessionContextMessages(atThree, options), atThree);
  const resultFour = pruning.pruneSessionContextMessages(atFour, options);
  const resultFive = pruning.pruneSessionContextMessages(atFive, options);
  const resultSix = pruning.pruneSessionContextMessages(atSix, options);

  assert.equal(
    resultFour[1].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
  assert.equal(resultFour[5], atFour[5]);
  assert.equal(
    resultFive[1].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
  assert.equal(resultFive[5], atFive[5]);
  assert.equal(
    resultSix[5].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
});

test("session pruning reconstructs the same generation deterministically and resets after compaction", () => {
  const messages = toolCallPadding(64);
  const first = pruning.pruneSessionContextMessages(messages);
  const reconstructed = pruning.pruneSessionContextMessages(
    structuredClone(messages),
  );

  assert.deepEqual(reconstructed, first);
  assert.equal(
    reconstructed[1].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );

  const compactedMessages = [
    { role: "compactionSummary", content: "summary" },
    ...toolCallPadding(32, 200),
  ];
  assert.equal(
    pruning.pruneSessionContextMessages(compactedMessages),
    compactedMessages,
  );
});

test("session pruning counts parallel tool calls separately inside one user turn", () => {
  const calls = Array.from({ length: 5 }, (_, index) => ({
    type: "toolCall",
    id: `parallel-${index}`,
    name: "read",
    arguments: {},
  }));
  const messages = [
    { role: "user", content: "one long turn" },
    {
      role: "assistant",
      content: [{ type: "text", text: "working" }, ...calls],
    },
    ...calls.map((call) => ({
      role: "toolResult",
      toolCallId: call.id,
      content: "x".repeat(25_000),
    })),
  ];

  const result = pruning.pruneSessionContextMessages(messages, {
    toolCallBucketSize: 1,
    retainedToolCallBuckets: 4,
  });

  assert.equal(
    result[2].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
  assert.equal(
    result[3].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
  assert.equal(messages[2].content.length, 25_000);
});

test("session pruning supports small custom tool-call buckets", () => {
  const messages = [
    ...padding(20),
    ...toolCallPadding(5),
    { role: "user", content: "also not counted" },
  ];

  const result = pruning.pruneSessionContextMessages(messages, {
    toolCallBucketSize: 2,
    retainedToolCallBuckets: 2,
  });

  assert.equal(
    result[21].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
  assert.equal(result[25], messages[25]);
});

test("session pruning handles snake-case tool-result roles outside retained buckets", () => {
  const oldResult = {
    role: "tool_result",
    toolCallId: "old-snake",
    content: "old output",
  };
  const messages = [
    toolCallMessage("old-snake"),
    oldResult,
    ...toolCallPadding(128, 1),
  ];

  const result = pruning.pruneSessionContextMessages(messages);

  assert.equal(
    result[1].content,
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
  const messages = ageContext([
    { role: "user", content: [{ type: "text", text: "turn" }, oldUserImage] },
    toolCallMessage("call-old", "read"),
    oldResult,
    ...padding(127, 3),
  ]);

  const result = pruning.pruneSessionContextMessages(messages);

  assert.equal(result.length, messages.length);
  assert.equal(result[0], messages[0]);
  assert.equal(result[0].content[1], oldUserImage);
  assert.deepEqual({ ...result[2], content: oldResult.content }, oldResult);
  assert.equal(result[2].role, oldResult.role);
  assert.equal(result[2].toolCallId, oldResult.toolCallId);
  assert.equal(result[2].toolName, oldResult.toolName);
  assert.equal(result[2].isError, true);
});

test("session pruning keeps tool-result content shape stable and is idempotent", () => {
  const messages = [
    toolCallMessage("shape"),
    {
      role: "toolResult",
      toolCallId: "shape",
      content: [{ type: "text", text: "old output" }],
    },
    ...toolCallPadding(128, 1),
  ];

  const once = pruning.pruneSessionContextMessages(messages);
  assert.deepEqual(once[1].content, [
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
  messages.push(...toolCallPadding(127, 10_000));

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
  messages.push(...toolCallPadding(128, 10_000));

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
  messages.push(...toolCallPadding(127, 10_000));

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
  messages.push(...toolCallPadding(127, 10_000));

  const pruned = pruning.pruneSessionContextMessages(messages);

  assert.equal(pruned[0], messages[0]);
  assert.equal(pruned[1], writeResult);
  assert.equal(pruned[2], editResult);
  assert.equal(pruned[3], messages[3]);
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
  messages.push(...toolCallPadding(123, 10_000));

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
  messages.push(...toolCallPadding(60, 10_000));
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
        policyContext.protectedToolCallStart === 16,
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

  const retainedCall = {
    type: "toolCall",
    id: "retained-result",
    name: "custom",
    arguments: { value: "unchanged" },
  };
  const retained = [
    ...toolCallPadding(16),
    { role: "assistant", content: [retainedCall] },
    {
      role: "toolResult",
      toolCallId: "retained-result",
      content: "retained output",
    },
    ...toolCallPadding(47, 100),
  ];
  const retainedPruned = pruning.pruneSessionContextMessages(retained, {
    toolHistoryPolicies: {
      custom: {
        compactCallArguments: () => ({ compacted: true }),
        compactResultContent: () => "compacted output",
      },
    },
  });
  assert.notEqual(retainedPruned, retained);
  assert.equal(retainedPruned[32], retained[32]);
  assert.equal(retainedPruned[33], retained[33]);
});
