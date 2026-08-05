import assert from "node:assert/strict";
import test from "node:test";

const pruning = await import("../../dist/core/rin-lib/session-pruning.js");

function tailPadding(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    role: "assistant",
    content: `tail-${index + 1}`,
  }));
}

test("session pruning omits old tool results while preserving the recent four turns", () => {
  const oldResult = { role: "toolResult", content: "old output" };
  const recentResults = Array.from({ length: 4 }, (_, index) => ({
    role: "toolResult",
    content: `recent output ${index + 2}`,
  }));
  const messages = [
    { role: "user", content: "turn 1" },
    oldResult,
    ...recentResults.flatMap((result, index) => [
      { role: "user", content: `turn ${index + 2}` },
      result,
    ]),
  ];

  const result = pruning.pruneSessionContextMessages(messages);

  assert.notEqual(result, messages);
  assert.equal(
    result[1].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
  for (const recentResult of recentResults) {
    assert.equal(result[messages.indexOf(recentResult)], recentResult);
  }
  assert.equal(oldResult.content, "old output");
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

test("session pruning preserves every tool result inside one arbitrarily long user turn", () => {
  const openingToolResult = {
    role: "toolResult",
    content: "x".repeat(25_000),
  };
  const messages = [
    { role: "user", content: "one long turn" },
    openingToolResult,
    ...tailPadding(64),
  ];

  assert.equal(pruning.pruneSessionContextMessages(messages), messages);
  assert.equal(messages[1], openingToolResult);
});

test("session pruning preserves every message in each of the recent four turns", () => {
  const oldResult = { role: "toolResult", content: "old output" };
  const recentResults = Array.from({ length: 4 }, (_, index) => ({
    role: "toolResult",
    content: `recent output ${index + 2}`.repeat(2_000),
  }));
  const messages = [
    { role: "user", content: "turn 1" },
    oldResult,
    ...recentResults.flatMap((result, index) => [
      { role: "user", content: `turn ${index + 2}` },
      result,
      ...tailPadding(24),
    ]),
  ];

  const result = pruning.pruneSessionContextMessages(messages);

  assert.equal(
    result[1].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
  for (const recentResult of recentResults) {
    assert.equal(result[messages.indexOf(recentResult)], recentResult);
  }
});

test("session pruning supports a custom recent-turn window", () => {
  const oldResult = { role: "toolResult", content: "old output" };
  const recentResult = { role: "toolResult", content: "recent output" };
  const messages = [
    { role: "user", content: "turn 1" },
    oldResult,
    { role: "user", content: "turn 2" },
    recentResult,
    { role: "user", content: "turn 3" },
  ];

  const result = pruning.pruneSessionContextMessages(messages, {
    protectRecentTurns: 2,
  });

  assert.equal(
    result[1].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
  assert.equal(result[3], recentResult);
});

test("session pruning handles snake-case tool-result roles outside the recent turns", () => {
  const oldResult = { role: "tool_result", content: "old output" };
  const messages = [
    { role: "user", content: "turn 1" },
    oldResult,
    { role: "user", content: "turn 2" },
    { role: "user", content: "turn 3" },
    { role: "user", content: "turn 4" },
    { role: "user", content: "turn 5" },
  ];

  const result = pruning.pruneSessionContextMessages(messages);

  assert.equal(
    result[1].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
});

test("session pruning does not omit rich user image content", () => {
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
    { role: "user", content: "turn 3" },
    { role: "user", content: "turn 4" },
    { role: "user", content: "turn 5" },
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
    { role: "user", content: "turn 2" },
    { role: "user", content: "turn 3" },
    { role: "user", content: "turn 4" },
    { role: "user", content: "turn 5" },
  ];

  const result = pruning.pruneSessionContextMessages(messages);

  assert.equal(result[2], skillReadResult);
  assert.equal(
    result[3].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
  assert.equal(ordinaryReadResult.content, "old read output");
});
