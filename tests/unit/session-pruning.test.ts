import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const pruning = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-lib", "session-pruning.js"),
  ).href
);

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
  ];

  const once = pruning.pruneSessionContextMessages(messages);
  assert.deepEqual(once[1].content, [
    { type: "text", text: pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT },
  ]);
  assert.equal(pruning.pruneSessionContextMessages(once), once);
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
  ];

  const result = pruning.pruneSessionContextMessages(messages);

  assert.equal(result[2], skillReadResult);
  assert.equal(
    result[3].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
  assert.equal(ordinaryReadResult.content, "old read output");
});

test("session pruning normalizes options and handles alternate tool-result shapes", () => {
  assert.equal(pruning.normalizeProtectRecentTurns(0), 4);
  assert.equal(pruning.normalizeProtectRecentTurns(2.9), 2);
  assert.equal(
    pruning.findProtectedContextStart([{ role: "assistant" }], 2),
    0,
  );
  assert.deepEqual(pruning.pruneSessionContextMessages(null as any), []);

  const oldAlternateResult = {
    role: "tool_result",
    content: [{ type: "text", text: "different" }],
  };
  const messages = [
    { role: "user", content: "turn 1" },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "shell", name: "bash", arguments: {} },
        {
          type: "toolCall",
          id: "ordinary-read",
          toolName: "read",
          arguments: { path: "/tmp/README.md" },
        },
      ],
    },
    oldAlternateResult,
    { role: "user", content: "turn 2" },
    { role: "user", content: "turn 3" },
  ];
  const result = pruning.pruneSessionContextMessages(messages, {
    protectRecentTurns: 2,
    cwd: "/tmp",
  });
  assert.deepEqual(result[2].content, [
    { type: "text", text: pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT },
  ]);
  assert.equal(oldAlternateResult.content[0].text, "different");

  const list: any[] = [];
  assert.equal(pruning.mapMessagesToPrunedSessionContext(list, messages), list);
  assert.deepEqual(
    pruning.mapMessagesToPrunedSessionContext(null as any, null as any),
    [],
  );
  const unchanged = [{ role: "user", content: "one" }];
  assert.equal(
    pruning.mapMessagesToPrunedSessionContext(unchanged, unchanged),
    unchanged,
  );
});

test("session pruning maps compaction slices through the full provider-bound context", () => {
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

  const directSlicePrune = pruning.pruneSessionContextMessages(summarizedSlice);
  assert.equal(directSlicePrune, summarizedSlice);

  const mapped = pruning.mapMessagesToPrunedSessionContext(
    summarizedSlice,
    fullContext,
  );
  assert.notEqual(mapped, summarizedSlice);
  assert.equal(
    mapped[1].content,
    pruning.RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT,
  );
  assert.equal(oldToolResult.content, "huge old output");
});
