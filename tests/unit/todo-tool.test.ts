import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const todoModule = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "todo.js")).href
);

test("todo tool replaces the whole checklist in one write", async () => {
  const tool = todoModule.default().tools[0];

  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["todos"]);
  assert.deepEqual(tool.parameters.required, ["todos"]);

  const first = await tool.execute(
    "todo-write-1",
    { todos: [{ text: "First item" }, { text: "Done item", done: true }] },
    undefined,
    undefined,
    {},
  );

  assert.equal(first.details.action, "write");
  assert.deepEqual(first.details.todos, [
    { id: 1, text: "First item", done: false },
    { id: 2, text: "Done item", done: true },
  ]);
  assert.equal(first.details.nextId, 3);

  const second = await tool.execute(
    "todo-write-2",
    { todos: [{ text: "Replacement item" }] },
    undefined,
    undefined,
    {},
  );

  assert.equal(second.details.action, "write");
  assert.deepEqual(second.details.todos, [
    { id: 1, text: "Replacement item", done: false },
  ]);
  assert.equal(second.details.nextId, 2);
  assert.doesNotMatch(second.content[0].text, /First item|Done item/);
});
