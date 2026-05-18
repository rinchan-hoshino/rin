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

test("todo final continuation keeps prompting until todos complete", async () => {
  const snapshots = [
    todoResult([{ id: 1, text: "finish", done: false }], 2),
    todoResult([{ id: 1, text: "finish", done: true }], 2),
  ];
  const branch = [snapshots[0]];
  const prompts: string[] = [];
  const session = {
    sessionManager: { getBranch: () => branch },
    async prompt(text: string, options: any) {
      prompts.push(text);
      assert.equal(options.expandPromptTemplates, false);
      assert.equal(options.source, "builtin:todo-continuation");
      branch.push(snapshots[1]);
    },
  };

  const result = await todoState.continueTodoFinalIfNeeded(session);

  assert.equal(result.reason, "completed");
  assert.equal(result.continuations, 1);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /#1: finish/);
});

test("todo final continuation stops when todo state does not change", async () => {
  const branch = [todoResult([{ id: 1, text: "blocked", done: false }], 2)];
  let promptCount = 0;
  const session = {
    sessionManager: { getBranch: () => branch },
    async prompt() {
      promptCount += 1;
    },
  };

  const result = await todoState.continueTodoFinalIfNeeded(session);

  assert.equal(result.reason, "unchanged");
  assert.equal(result.continuations, 1);
  assert.equal(promptCount, 1);
});

test("todo final continuation caps runaway changing todo states", async () => {
  const branch = [todoResult([{ id: 1, text: "one", done: false }], 2)];
  const session = {
    sessionManager: { getBranch: () => branch },
    async prompt() {
      const id = branch.length + 1;
      branch.push(
        todoResult([{ id, text: `item ${id}`, done: false }], id + 1),
      );
    },
  };

  const result = await todoState.continueTodoFinalIfNeeded(session, {
    maxContinuations: 3,
  });

  assert.equal(result.reason, "max_turns");
  assert.equal(result.continuations, 3);
});
