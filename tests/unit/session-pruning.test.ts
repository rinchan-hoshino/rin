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
