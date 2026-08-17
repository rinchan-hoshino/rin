import "../support/require-test-sandbox.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { importBuiltModule } from "../support/import-built-module.js";

const todoState = await importBuiltModule<
  typeof import("../../src/core/rin-lib/todo-state.js")
>("dist/core/rin-lib/todo-state.js");

function todoEntry(todos: any[], nextId = 1) {
  return {
    type: "custom",
    customType: todoState.RIN_TODO_CUSTOM_ENTRY_TYPE,
    data: { todos, nextId },
  };
}

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

test("todo state keeps retired continuation helpers out of its runtime surface", () => {
  for (const retired of [
    "continueTodoFinalIfNeeded",
    "buildTodoFinalContinuationPrompt",
    "TODO_FINAL_CONTINUATION_MAX_TURNS",
  ]) {
    assert.equal((todoState as Record<string, unknown>)[retired], undefined);
  }
});

test("todo state normalizes item and empty checklist inputs", () => {
  assert.equal(todoState.normalizeRinTodoItem(null), undefined);
  assert.equal(
    todoState.normalizeRinTodoItem({ id: 0, text: "invalid" }),
    undefined,
  );
  assert.equal(
    todoState.normalizeRinTodoItem({ id: 1, text: "   " }),
    undefined,
  );
  assert.deepEqual(
    todoState.normalizeRinTodoItems([
      { id: 2, text: " second ", done: 1 },
      { id: "bad", text: "ignored" },
    ]),
    [{ id: 2, text: "second", done: true }],
  );
  assert.equal(todoState.normalizeRinTodoItems({}), undefined);
  assert.equal(todoState.formatRinTodoItemText({ text: " item " }), "item");
  assert.equal(todoState.formatRinTodoChecklistContent([]), "No todos");
  assert.equal(todoState.formatRinTodoChecklistMarkdownContent([]), "No todos");
  assert.equal(
    todoState.formatRinTodoChecklistCharacterContent([]),
    "No todos",
  );
});

test("todo state falls back to agent messages and rejects invalid next ids", () => {
  const snapshot = todoState.readTodoSnapshotFromSession({
    agent: {
      state: {
        messages: [todoEntry([{ id: 2, text: "second", done: false }], 0)],
      },
    },
  });
  assert.deepEqual(snapshot.todos, [{ id: 2, text: "second", done: false }]);
  assert.equal(snapshot.nextId, undefined);
  assert.deepEqual(todoState.readTodoSnapshotFromSession({}).todos, []);
});

test("todo state reads the latest branch-aware custom entry", () => {
  const session = {
    sessionManager: {
      getBranch: () => [
        todoEntry([{ id: 1, text: "first", done: false }], 2),
        { type: "message", message: { role: "assistant", content: [] } },
        todoEntry(
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

test("todo state reads the latest todo from the active session-file branch", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-todo-state-"));
  const sessionFile = path.join(tempDir, "branch.jsonl");
  const entries = [
    {
      type: "custom",
      id: "todo-main",
      parentId: null,
      customType: todoState.RIN_TODO_CUSTOM_ENTRY_TYPE,
      data: {
        todos: [{ id: 1, text: "main task", done: false }],
        nextId: 2,
      },
    },
    {
      type: "custom",
      id: "todo-abandoned",
      parentId: "todo-main",
      customType: todoState.RIN_TODO_CUSTOM_ENTRY_TYPE,
      data: {
        todos: [{ id: 1, text: "wrong branch", done: false }],
        nextId: 2,
      },
    },
    {
      type: "message",
      id: "active-user",
      parentId: "todo-main",
      message: { role: "user", content: [{ type: "text", text: "continue" }] },
    },
  ];
  await fs.writeFile(
    sessionFile,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );

  try {
    const snapshot =
      await todoState.readTodoSnapshotFromSessionFile(sessionFile);
    assert.deepEqual(snapshot.todos, [
      { id: 1, text: "main task", done: false },
    ]);
    assert.deepEqual(
      (
        await todoState.readTodoSnapshotFromSessionFile(
          sessionFile,
          "active-user",
        )
      ).todos,
      [{ id: 1, text: "main task", done: false }],
    );
    assert.equal(
      await todoState.readTodoSnapshotFromSessionFile(
        sessionFile,
        "future-user",
      ),
      undefined,
    );
    assert.equal(
      await todoState.readTodoSnapshotFromSessionFile(sessionFile, "todo-main"),
      undefined,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("todo state retries an expected user leaf with an incomplete ancestor chain", async () => {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-todo-ancestors-"),
  );
  const sessionFile = path.join(tempDir, "ancestors.jsonl");
  const user = {
    type: "message",
    id: "user",
    parentId: "todo",
    message: { role: "user", content: [{ type: "text", text: "go" }] },
  };
  const todo = {
    type: "custom",
    id: "todo",
    parentId: null,
    customType: todoState.RIN_TODO_CUSTOM_ENTRY_TYPE,
    data: {
      todos: [{ id: 1, text: "wait for ancestors", done: false }],
      nextId: 2,
    },
  };

  try {
    await fs.writeFile(sessionFile, `${JSON.stringify(user)}\n`, "utf8");
    assert.equal(
      await todoState.readTodoSnapshotFromSessionFile(sessionFile, "user"),
      undefined,
    );

    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(user)}\n${JSON.stringify(todo)}\n`,
      "utf8",
    );
    assert.deepEqual(
      (await todoState.readTodoSnapshotFromSessionFile(sessionFile, "user"))
        .todos,
      [{ id: 1, text: "wait for ancestors", done: false }],
    );

    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ ...todo, parentId: "user" })}\n${JSON.stringify(
        user,
      )}\n`,
      "utf8",
    );
    assert.equal(
      await todoState.readTodoSnapshotFromSessionFile(sessionFile, "user"),
      undefined,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("todo state leaves unavailable session files distinguishable from empty todo", async () => {
  assert.equal(
    await todoState.readTodoSnapshotFromSessionFile(
      path.join(os.tmpdir(), "missing-rin-session.jsonl"),
    ),
    undefined,
  );
});

test("todo state treats a partially written JSONL tail as retryable", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-todo-partial-"));
  const sessionFile = path.join(tempDir, "partial.jsonl");
  const todo = {
    type: "custom",
    id: "todo",
    parentId: null,
    customType: todoState.RIN_TODO_CUSTOM_ENTRY_TYPE,
    data: {
      todos: [{ id: 1, text: "retry me", done: false }],
      nextId: 2,
    },
  };
  const user = {
    type: "message",
    id: "user",
    parentId: "todo",
    message: { role: "user", content: [{ type: "text", text: "go" }] },
  };

  try {
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(todo)}\n${JSON.stringify(user).slice(0, -2)}`,
      "utf8",
    );
    assert.equal(
      await todoState.readTodoSnapshotFromSessionFile(sessionFile),
      undefined,
    );

    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(todo)}\n${JSON.stringify(user)}\n`,
      "utf8",
    );
    const snapshot =
      await todoState.readTodoSnapshotFromSessionFile(sessionFile);
    assert.deepEqual(snapshot.todos, [
      { id: 1, text: "retry me", done: false },
    ]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("todo state ignores context-visible todo tool-result details", () => {
  const session = {
    sessionManager: {
      getBranch: () => [
        todoResult(
          [{ id: 1, text: "tool result should not persist", done: false }],
          2,
        ),
      ],
    },
  };

  const snapshot = todoState.readTodoSnapshotFromSession(session);

  assert.deepEqual(snapshot.todos, []);
  assert.equal(snapshot.pendingCount, 0);
});

test("todo state formats checklist content without markdown list markers", () => {
  assert.equal(
    todoState.formatRinTodoChecklistContent([
      { text: "Open item", done: false },
      { text: "Done item", done: true },
    ]),
    "[ ] Open item\n[x] Done item",
  );
});

test("todo state formats markdown chat fallback with markdown strikethrough", () => {
  const content = todoState.formatRinTodoChecklistMarkdownContent([
    { text: "Open item", done: false },
    { text: "Done item", done: true },
  ]);

  assert.equal(content, "⬜ Open item\n✅ ~~Done item~~");
});

test("todo state keeps completed text plain in character-only chat fallback", () => {
  const content = todoState.formatRinTodoChecklistCharacterContent([
    { text: "Open item", done: false },
    { text: "Done item", done: true },
  ]);

  assert.equal(content, "⬜ Open item\n✅ Done item");
});
