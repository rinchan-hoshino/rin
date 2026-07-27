import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const pruning = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-lib", "session-pruning.js"),
  ).href
);

function tailPadding(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    role: "assistant",
    content: `tail padding ${index + 1}`,
  }));
}

test("session pruning omits old tool results while preserving the recent four turns", () => {
  const messages = [
    { role: "user", content: "turn 1" },
    { role: "toolResult", content: "old output" },
    { role: "assistant", content: "done 1" },
    { role: "user", content: "turn 2" },
    { role: "toolResult", content: "recent output 2" },
    { role: "assistant", content: "done 2" },
    { role: "user", content: "turn 3" },
    { role: "toolResult", content: "recent output 3" },
    { role: "assistant", content: "done 3" },
    { role: "user", content: "turn 4" },
    { role: "toolResult", content: "recent output 4" },
    { role: "assistant", content: "done 4" },
    { role: "user", content: "turn 5" },
    { role: "toolResult", content: "recent output 5" },
    { role: "assistant", content: "tail padding 1" },
    { role: "assistant", content: "tail padding 2" },
    { role: "assistant", content: "tail padding 3" },
    { role: "assistant", content: "tail padding 4" },
  ];

  const result = pruning.pruneSessionContextMessages(messages);

  assert.notEqual(result, messages);
  assert.equal(
    result[1].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
  assert.equal(result[4].content, "recent output 2");
  assert.equal(result[7].content, "recent output 3");
  assert.equal(result[10].content, "recent output 4");
  assert.equal(result[13].content, "recent output 5");
  assert.equal(messages[1].content, "old output");
});

test("session pruning is a no-op until more than four user turns exist", () => {
  const messages = [
    { role: "user", content: "turn 1" },
    { role: "toolResult", content: "output 1" },
    { role: "user", content: "turn 2" },
    { role: "toolResult", content: "output 2" },
    { role: "user", content: "turn 3" },
    { role: "toolResult", content: "output 3" },
    { role: "user", content: "turn 4" },
    { role: "toolResult", content: "output 4" },
  ];

  assert.equal(pruning.pruneSessionContextMessages(messages), messages);
});

test("session pruning protects the latest sixteen messages across old turns", () => {
  const oldToolResult = {
    role: "toolResult",
    content: "x".repeat(25_000),
  };
  const messages = [
    { role: "user", content: "turn 1" },
    oldToolResult,
    { role: "user", content: "turn 2" },
    { role: "assistant", content: "done 2" },
    { role: "user", content: "turn 3" },
    { role: "assistant", content: "done 3" },
    { role: "user", content: "turn 4" },
    { role: "assistant", content: "done 4" },
    { role: "user", content: "turn 5" },
    { role: "assistant", content: "done 5" },
  ];

  assert.equal(pruning.pruneSessionContextMessages(messages), messages);
  assert.equal(messages[1], oldToolResult);
});

test("session pruning protects the final sixteen messages of each recent turn", () => {
  const toolResults = Array.from({ length: 4 }, (_, index) => ({
    role: "toolResult",
    content: String(index + 1).repeat(25_000),
  }));
  const messages = toolResults.flatMap((toolResult, index) => [
    { role: "user", content: `turn ${index + 1}` },
    toolResult,
    ...tailPadding(14),
  ]);

  assert.equal(pruning.pruneSessionContextMessages(messages), messages);
  for (const toolResult of toolResults) {
    assert.equal(toolResult.content.length, 25_000);
  }
});

test("session pruning batches results before each recent turn's protected tail", () => {
  const toolResults = Array.from({ length: 4 }, (_, index) => ({
    role: "toolResult",
    content: String(index + 1).repeat(25_000),
  }));
  const messages = toolResults.flatMap((toolResult, index) => [
    { role: "user", content: `turn ${index + 1}` },
    toolResult,
    ...tailPadding(16),
  ]);

  const result = pruning.pruneSessionContextMessages(messages);

  for (const toolResult of toolResults) {
    const index = messages.indexOf(toolResult);
    assert.equal(
      result[index].content,
      pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
    );
  }
});

test("session pruning does not combine sub-threshold batches across turns", () => {
  const first = { role: "toolResult", content: "a".repeat(10_000) };
  const second = { role: "toolResult", content: "b".repeat(10_000) };
  const messages = [
    { role: "user", content: "turn 1" },
    first,
    ...tailPadding(16),
    { role: "user", content: "turn 2" },
    second,
    ...tailPadding(16),
    { role: "user", content: "turn 3" },
    { role: "assistant", content: "done 3" },
    { role: "user", content: "turn 4" },
    ...tailPadding(16),
  ];

  assert.equal(pruning.pruneSessionContextMessages(messages), messages);
  assert.equal(first.content.length, 10_000);
  assert.equal(second.content.length, 10_000);
});

test("session pruning treats compaction summaries as synthetic turn boundaries", () => {
  const compactedToolResult = {
    role: "toolResult",
    content: "compacted".repeat(3_000),
  };
  const messages = [
    { role: "compactionSummary", summary: "earlier context" },
    compactedToolResult,
    ...tailPadding(14),
    ...Array.from({ length: 3 }, (_, index) => [
      { role: "user", content: `turn ${index + 2}` },
      { role: "toolResult", content: String(index + 2).repeat(25_000) },
      ...tailPadding(14),
    ]).flat(),
  ];

  assert.equal(pruning.pruneSessionContextMessages(messages), messages);
  assert.equal(compactedToolResult.content.length, 27_000);
});

test("per-turn protection never newly prunes a residual from the current policy", () => {
  const first = { role: "toolResult", content: "a".repeat(10_000) };
  const locallyProtected = {
    role: "toolResult",
    content: "b".repeat(10_000),
  };
  const currentResidual = {
    role: "toolResult",
    content: "c".repeat(10_000),
  };
  const messages = [
    { role: "user", content: "turn 1" },
    first,
    locallyProtected,
    ...tailPadding(15),
    { role: "user", content: "turn 2" },
    currentResidual,
    ...tailPadding(16),
    { role: "user", content: "turn 3" },
    { role: "assistant", content: "done 3" },
    { role: "user", content: "turn 4" },
    ...tailPadding(16),
  ];

  assert.equal(pruning.pruneSessionContextMessages(messages), messages);
  assert.equal(first.content.length, 10_000);
  assert.equal(locallyProtected.content.length, 10_000);
  assert.equal(currentResidual.content.length, 10_000);
});

test("session pruning protects the latest sixteen messages inside one user turn", () => {
  const oldToolResult = {
    role: "toolResult",
    content: "x".repeat(25_000),
  };
  const protectedTail = Array.from({ length: 16 }, (_, index) => ({
    role: "assistant",
    content: `recent ${index + 1}`,
  }));
  const messages = [
    { role: "user", content: "one long turn" },
    oldToolResult,
    ...protectedTail,
  ];

  const result = pruning.pruneSessionContextMessages(messages);

  assert.equal(pruning.RIN_SESSION_PRUNING_PROTECT_RECENT_MESSAGES, 16);
  assert.equal(pruning.RIN_SESSION_PRUNING_MINIMUM_RECLAIM_TOKENS, 4096);
  assert.equal(
    result[1].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
  assert.deepEqual(result.slice(-16), protectedTail);
  assert.equal(messages[1], oldToolResult);
});

test("message-tail pruning estimates snake-case tool results", () => {
  const oldToolResult = {
    role: "tool_result",
    content: "x".repeat(25_000),
  };
  const messages = [
    { role: "user", content: "one long turn" },
    oldToolResult,
    ...tailPadding(16),
  ];

  const result = pruning.pruneSessionContextMessages(messages);

  assert.equal(result[1].role, "tool_result");
  assert.equal(
    result[1].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
  assert.equal(messages[1], oldToolResult);
});

test("session pruning makes the recent message protection configurable", () => {
  const oldToolResult = {
    role: "toolResult",
    content: "x".repeat(25_000),
  };
  const messages = [
    { role: "user", content: "one long turn" },
    oldToolResult,
    ...Array.from({ length: 16 }, (_, index) => ({
      role: "assistant",
      content: `recent ${index + 1}`,
    })),
  ];

  assert.equal(
    pruning.pruneSessionContextMessages(messages, {
      protectRecentMessages: 17,
    }),
    messages,
  );
});

test("session pruning advances the message-tail boundary only in 4096-token reclaim batches", () => {
  const first = { role: "toolResult", content: "a".repeat(10_000) };
  const second = { role: "toolResult", content: "b".repeat(10_000) };
  const residual = { role: "toolResult", content: "small residual" };
  const oneCandidate = [
    { role: "user", content: "one long turn" },
    first,
    { role: "assistant", content: "latest" },
  ];

  assert.equal(
    pruning.pruneSessionContextMessages(oneCandidate, {
      protectRecentMessages: 1,
    }),
    oneCandidate,
  );

  const fullBatch = [
    { role: "user", content: "one long turn" },
    first,
    { role: "assistant", content: "middle" },
    second,
    { role: "assistant", content: "latest" },
  ];
  const batched = pruning.pruneSessionContextMessages(fullBatch, {
    protectRecentMessages: 1,
  });
  assert.equal(
    batched[1].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
  assert.equal(
    batched[3].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );

  const withResidual = [
    ...fullBatch.slice(0, -1),
    residual,
    { role: "assistant", content: "latest" },
  ];
  const stable = pruning.pruneSessionContextMessages(withResidual, {
    protectRecentMessages: 1,
  });
  assert.equal(
    stable[1].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
  assert.equal(
    stable[3].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
  assert.equal(stable[4], residual);
});

test("session pruning does not omit rich image content", () => {
  const oldUserImage = { type: "image", data: "old-user-base64" };
  const messages = [
    { role: "user", content: [{ type: "text", text: "turn 1" }, oldUserImage] },
    { role: "assistant", content: "done 1" },
    { role: "user", content: "turn 2" },
    { role: "assistant", content: "done 2" },
    { role: "user", content: "turn 3" },
    { role: "assistant", content: "done 3" },
    { role: "user", content: "turn 4" },
    { role: "assistant", content: "done 4" },
    { role: "user", content: "turn 5" },
  ];

  assert.equal(pruning.pruneSessionContextMessages(messages), messages);
  assert.equal(messages[0].content[1], oldUserImage);
});

test("session pruning keeps tool-result content shape stable and is idempotent", () => {
  const messages = [
    { role: "user", content: "turn 1" },
    { role: "toolResult", content: [{ type: "text", text: "old output" }] },
    { role: "user", content: "turn 2" },
    { role: "assistant", content: "done 2" },
    { role: "user", content: "turn 3" },
    { role: "assistant", content: "done 3" },
    { role: "user", content: "turn 4" },
    { role: "assistant", content: "done 4" },
    { role: "user", content: "turn 5" },
    { role: "assistant", content: "done 5" },
    ...tailPadding(8),
  ];

  const once = pruning.pruneSessionContextMessages(messages);
  assert.deepEqual(once[1].content, [
    { type: "text", text: pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT },
  ]);
  assert.equal(pruning.pruneSessionContextMessages(once), once);
});

test("message-tail pruning preserves protected skill read results", () => {
  const skillReadResult = {
    role: "toolResult",
    toolCallId: "call-skill",
    toolName: "read",
    content: "skill instructions".repeat(2_000),
  };
  const ordinaryReadResult = {
    role: "toolResult",
    toolCallId: "call-readme",
    toolName: "read",
    content: "ordinary output".repeat(2_000),
  };
  const messages = [
    { role: "user", content: "one long turn" },
    {
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
    },
    skillReadResult,
    ordinaryReadResult,
    ...Array.from({ length: 16 }, (_, index) => ({
      role: "assistant",
      content: `recent ${index + 1}`,
    })),
  ];

  const result = pruning.pruneSessionContextMessages(messages);

  assert.equal(result[2], skillReadResult);
  assert.equal(
    result[3].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
});

test("session pruning preserves old skill read results", () => {
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
  const messages = [
    { role: "user", content: "turn 1" },
    {
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
    },
    skillReadResult,
    ordinaryReadResult,
    { role: "assistant", content: "done 1" },
    { role: "user", content: "turn 2" },
    { role: "assistant", content: "done 2" },
    { role: "user", content: "turn 3" },
    { role: "assistant", content: "done 3" },
    { role: "user", content: "turn 4" },
    { role: "assistant", content: "done 4" },
    { role: "user", content: "turn 5" },
    { role: "assistant", content: "done 5" },
    ...tailPadding(7),
  ];

  const result = pruning.pruneSessionContextMessages(messages);

  assert.equal(result[2], skillReadResult);
  assert.equal(
    result[3].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
  assert.equal(ordinaryReadResult.content, "old read output");
});
