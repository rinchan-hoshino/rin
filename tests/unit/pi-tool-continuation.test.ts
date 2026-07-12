import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const continuation = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "pi", "tool-continuation.js"),
  ).href
);

const toolCall = (id: string) => ({ type: "toolCall", id, name: "read" });

test("Pi continuation preserves the legacy tool-call planning exports", () => {
  const messages = [
    { role: "user", content: [toolCall("ignored")] },
    { role: "assistant", stopReason: "toolUse", content: [toolCall("kept")] },
  ];
  assert.deepEqual(continuation.extractAssistantToolCallIds(messages[1]), [
    "kept",
  ]);
  const plan = continuation.buildPiToolContinuationPlan(messages);
  assert.deepEqual([...plan.visibleMessageIndexes], [1]);
  assert.deepEqual(plan.visibleToolCallPartsByMessageIndex.get(1), [
    toolCall("kept"),
  ]);
});

test("Pi continuation keeps complete assistant tool calls in order", () => {
  assert.deepEqual(
    continuation.extractPiContinuableToolCallIds({
      role: "assistant",
      stopReason: "toolUse",
      content: [
        toolCall("first"),
        { type: "text", text: "working" },
        toolCall("second"),
      ],
    }),
    ["first", "second"],
  );
});

test("Pi continuation rejects incomplete and non-assistant messages", () => {
  for (const message of [
    { role: "assistant", stopReason: "error", content: [toolCall("a")] },
    { role: "assistant", stopReason: "aborted", content: [toolCall("b")] },
    { role: "user", content: [toolCall("c")] },
    { role: "assistant", content: [toolCall("")] },
  ]) {
    assert.deepEqual(continuation.extractPiContinuableToolCallIds(message), []);
  }
});
