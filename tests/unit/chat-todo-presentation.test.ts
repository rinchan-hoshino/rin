import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const presentation = await importBuiltModule<
  typeof import("../../src/core/chat/todo-presentation.js")
>("dist/core/chat/todo-presentation.js");

const todos = [
  { id: 1, text: "First task", done: false },
  { id: 2, text: "Completed task", done: true },
];

test("todo presenter leaves platform rendering to Chat transports", () => {
  const notice = presentation.presentTodoNotice(
    "example/bot:channel",
    todos,
    "ignored",
  );
  assert.equal(notice.mode, "markdown");
  assert.deepEqual(notice.todos, todos);
  assert.match(notice.text, /⬜ First task/);
  assert.match(notice.text, /✅ ~~Completed task~~/);
});

test("todo presenter keeps empty snapshots empty and preserves text-only notices", () => {
  assert.deepEqual(
    presentation.presentTodoNotice("example/bot:chat", [], "ignored"),
    { mode: "markdown", todos: [], text: "" },
  );
  assert.deepEqual(
    presentation.presentTodoNotice("example/bot:chat", undefined, "  status  "),
    { mode: "markdown", todos: undefined, text: "status" },
  );
});
