import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const todoModule = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "todo.js")).href
);

async function createTodoTool() {
  const capability = todoModule.default();
  const entries: any[] = [];
  const sessionManager = {
    getBranch: () => entries,
    appendCustomEntry(customType: string, data: any) {
      entries.push({ type: "custom", customType, data });
    },
  };
  await capability.hooks?.session_start?.[0]?.({}, { sessionManager });
  return { capability, tool: capability.tools[0], entries, sessionManager };
}

test("todo tool replaces the whole checklist in one write", async () => {
  const { tool } = await createTodoTool();

  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["todos"]);
  assert.deepEqual(tool.parameters.required ?? [], []);

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

test("todo tool reads current checklist when todos is omitted", async () => {
  const { tool } = await createTodoTool();

  await tool.execute(
    "todo-write-before-read",
    { todos: [{ text: "Keep this item" }, { text: "Done item", done: true }] },
    undefined,
    undefined,
    {},
  );

  const read = await tool.execute("todo-read", {}, undefined, undefined, {});

  assert.equal(read.details.action, "list");
  assert.deepEqual(read.details.todos, [
    { id: 1, text: "Keep this item", done: false },
    { id: 2, text: "Done item", done: true },
  ]);
  assert.equal(read.details.nextId, 3);
  assert.equal(read.content[0].text, "[ ] Keep this item\n[x] Done item");
});

test("todo tool clears only when todos is an empty array", async () => {
  const { tool } = await createTodoTool();

  await tool.execute(
    "todo-write-before-clear",
    { todos: [{ text: "Clear this item" }] },
    undefined,
    undefined,
    {},
  );

  const cleared = await tool.execute(
    "todo-clear",
    { todos: [] },
    undefined,
    undefined,
    {},
  );

  assert.equal(cleared.details.action, "clear");
  assert.deepEqual(cleared.details.todos, []);
  assert.equal(cleared.details.nextId, 1);
  assert.equal(cleared.content[0].text, "No todos");
});

test("todo tool errors when session custom entries are unavailable", async () => {
  const capability = todoModule.default();
  const tool = capability.tools[0];
  await capability.hooks?.session_start?.[0]?.(
    {},
    { sessionManager: { getBranch: () => [] } },
  );

  const result = await tool.execute(
    "todo-write-without-custom-entry",
    { todos: [{ text: "Cannot persist" }] },
    undefined,
    undefined,
    {},
  );

  assert.equal(result.details.action, "write");
  assert.match(
    result.details.error,
    /session custom entries are not available/,
  );
  assert.match(result.content[0].text, /^Error: failed to persist todo state:/);
});

test("todo tool writes session custom entry checkpoints", async () => {
  const { tool, entries, sessionManager } = await createTodoTool();
  await tool.execute(
    "todo-write-custom-entry",
    { todos: [{ text: "Persist via custom entry" }] },
    undefined,
    undefined,
    {},
  );

  assert.deepEqual(entries, [
    {
      type: "custom",
      customType: "rin.todo",
      data: {
        todos: [{ id: 1, text: "Persist via custom entry", done: false }],
        nextId: 2,
      },
    },
  ]);

  const restoredCapability = todoModule.default();
  const restoredTool = restoredCapability.tools[0];
  await restoredCapability.hooks?.session_start?.[0]?.({}, { sessionManager });

  const read = await restoredTool.execute(
    "todo-read-after-restore",
    {},
    undefined,
    undefined,
    {},
  );

  assert.equal(read.content[0].text, "[ ] Persist via custom entry");
  assert.deepEqual(read.details.todos, [
    { id: 1, text: "Persist via custom entry", done: false },
  ]);
});
