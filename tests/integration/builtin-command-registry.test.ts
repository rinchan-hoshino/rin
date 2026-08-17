import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const { RIN_TUI_BUILTIN_COMMAND_REGISTRY: registry } = await importBuiltModule<
  typeof import("../../src/core/rin-tui/builtin-command-registry.js")
>("dist/core/rin-tui/builtin-command-registry.js");

test("one immutable frontend builtin registry owns metadata and dispatch", async () => {
  assert.equal(Object.isFrozen(registry), true);
  assert.equal(Object.isFrozen(registry.commands), true);
  assert.equal(registry.commands.every(Object.isFrozen), true);
  assert.deepEqual(
    registry.commands.map((command) => command.name),
    ["todos", "notes"],
  );
  assert.equal(
    registry.commands.some((command) => "execute" in command),
    false,
  );

  const calls: string[] = [];
  const context = {
    sessionManager: { getBranch: () => [] },
    ui: {
      async custom() {
        calls.push("custom");
      },
    },
  };
  assert.equal(await registry.execute("/todos", context), true);
  assert.deepEqual(calls, ["custom"]);
  assert.equal(await registry.execute("todos", context), false);
  assert.equal(await registry.execute("/owner-command", context), false);
});

async function renderCommand(name: string, branch: any[]) {
  let component: any;
  let closed = false;
  const notifications: any[] = [];
  const handled = await registry.execute(`/${name}`, {
    sessionManager: { getBranch: () => branch },
    ui: {
      theme: {
        fg: (_color: string, text: unknown) => String(text),
      },
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      async custom(factory: any) {
        component = factory({}, this.theme, {}, () => {
          closed = true;
        });
      },
    },
  });
  assert.equal(handled, true);
  return {
    text: component.render(100).join("\n"),
    component,
    isClosed: () => closed,
    notifications,
  };
}

test("registry describes /todos and /notes as branch viewers", () => {
  assert.deepEqual(
    registry.commands.map(({ name, description }) => [name, description]),
    [
      ["todos", "Show all todos on the current branch"],
      ["notes", "Show all notes on the current branch"],
    ],
  );
});

test("/todos hides stable ids while /notes keeps them for direct reference", async () => {
  const branch = [
    {
      type: "custom",
      customType: "rin.todo",
      data: {
        todos: [
          { id: 1, text: "open", done: false },
          { id: 2, text: "done", done: true },
        ],
        nextId: 3,
      },
    },
    {
      type: "custom",
      customType: "rin.note",
      data: { content: "legacy note" },
    },
  ];

  const todos = await renderCommand("todos", branch);
  assert.match(todos.text, /Todos/);
  assert.match(todos.text, /1\/2 completed/);
  assert.match(todos.text, /○ open/);
  assert.match(todos.text, /✓ done/);
  assert.doesNotMatch(todos.text, /#1|#2/);
  const cached = todos.component.render(100);
  assert.equal(todos.component.render(100), cached);
  todos.component.invalidate();
  assert.notEqual(todos.component.render(100), cached);
  todos.component.render(20);
  todos.component.handleInput("x");
  assert.equal(todos.isClosed(), false);
  todos.component.handleInput("\u001b");
  assert.equal(todos.isClosed(), true);

  const notes = await renderCommand("notes", branch);
  assert.match(notes.text, /Notes/);
  assert.match(notes.text, /#1 legacy note/);
  assert.match(notes.text, /1 note/);
  notes.component.handleInput("\u0003");
  assert.equal(notes.isClosed(), true);

  const pluralNotes = await renderCommand("notes", [
    {
      type: "custom",
      customType: "rin.note",
      data: {
        items: [
          { id: 3, text: "first" },
          { id: 4, text: "second" },
        ],
        nextId: 5,
      },
    },
  ]);
  assert.match(pluralNotes.text, /2 notes/);
});

test("builtin item commands render explicit TUI empty states", async () => {
  assert.match((await renderCommand("todos", [])).text, /No todos yet/);
  assert.match((await renderCommand("notes", [])).text, /No notes yet/);
});
