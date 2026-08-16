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

test("todo presenter selects native and markdown surfaces from the chat platform", () => {
  const native = presentation.presentTodoNotice(
    "slack/bot:channel",
    todos,
    "ignored",
  );
  assert.equal(native.mode, "native");
  assert.deepEqual(native.todos, todos);
  assert.match(native.text, /First task/);
  assert.match(native.text, /Completed task/);

  const markdown = presentation.presentTodoNotice(
    "discord/bot:channel",
    todos,
    "ignored",
  );
  assert.equal(markdown.mode, "markdown");
  assert.match(markdown.text, /⬜ First task/);
  assert.match(markdown.text, /✅ ~~Completed task~~/);
});

test("todo presenter keeps empty snapshots empty and preserves text-only notices", () => {
  assert.deepEqual(
    presentation.presentTodoNotice("telegram/bot:chat", [], "ignored"),
    { mode: "markdown", todos: [], text: "" },
  );
  assert.deepEqual(
    presentation.presentTodoNotice("custom/bot:chat", undefined, "  status  "),
    { mode: "characters", todos: undefined, text: "status" },
  );
});
