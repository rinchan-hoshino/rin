import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const todoState = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "todo-state.js"))
    .href
);

function todoResult(todos: any[], nextId = 1) {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "todo",
      details: { action: "list", todos, nextId },
    },
  };
}

test("todo state reads the latest branch-aware todo result", () => {
  const session = {
    sessionManager: {
      getBranch: () => [
        todoResult([{ id: 1, text: "first", done: false }], 2),
        { type: "message", message: { role: "assistant", content: [] } },
        todoResult(
          [
            { id: 1, text: "first", done: true },
            { id: 2, text: "second", done: false },
          ],
          3,
        ),
      ],
    },
  };

  const snapshot = todoState.readTodoSnapshotFromSession(session);

  assert.equal(snapshot.pendingCount, 1);
  assert.deepEqual(snapshot.todos, [
    { id: 1, text: "first", done: true },
    { id: 2, text: "second", done: false },
  ]);
});

test("todo state formats checklist content as markdown task items", () => {
  assert.equal(
    todoState.formatRinTodoChecklistContent([
      { text: "Open item", done: false },
      { text: "Done item", done: true },
    ]),
    "- [ ] Open item\n- [x] ~~Done item~~",
  );
});

test("todo state does not expose hidden final-continuation helpers", () => {
  assert.equal(todoState.continueTodoFinalIfNeeded, undefined);
  assert.equal(todoState.buildTodoFinalContinuationPrompt, undefined);
  assert.equal(todoState.TODO_FINAL_CONTINUATION_MAX_TURNS, undefined);
});
