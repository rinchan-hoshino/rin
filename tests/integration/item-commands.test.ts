import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const commandsModule = await importBuiltModule<
  typeof import("../../src/core/rin-lib/item-commands.js")
>("dist/core/rin-lib/item-commands.js");

function registerCommands() {
  const commands = new Map<string, any>();
  commandsModule.default({
    registerCommand(name: string, options: any) {
      commands.set(name, options);
    },
  } as any);
  return commands;
}

async function renderCommand(command: any, branch: any[]) {
  let component: any;
  let closed = false;
  const notifications: any[] = [];
  await command.handler("", {
    mode: "tui",
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
  return {
    text: component.render(100).join("\n"),
    component,
    isClosed: () => closed,
    notifications,
  };
}

test("core item commands register /todos and /notes as branch viewers", () => {
  const commands = registerCommands();
  assert.deepEqual([...commands.keys()], ["todos", "notes"]);
  assert.equal(
    commands.get("todos").description,
    "Show all todos on the current branch",
  );
  assert.equal(
    commands.get("notes").description,
    "Show all notes on the current branch",
  );
});

test("/todos and /notes render current stable ids, including legacy note snapshots", async () => {
  const commands = registerCommands();
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

  const todos = await renderCommand(commands.get("todos"), branch);
  assert.match(todos.text, /Todos/);
  assert.match(todos.text, /1\/2 completed/);
  assert.match(todos.text, /○ #1 open/);
  assert.match(todos.text, /✓ #2 done/);
  const cached = todos.component.render(100);
  assert.equal(todos.component.render(100), cached);
  todos.component.invalidate();
  assert.notEqual(todos.component.render(100), cached);
  todos.component.render(20);
  todos.component.handleInput("x");
  assert.equal(todos.isClosed(), false);
  todos.component.handleInput("\u001b");
  assert.equal(todos.isClosed(), true);

  const notes = await renderCommand(commands.get("notes"), branch);
  assert.match(notes.text, /Notes/);
  assert.match(notes.text, /#1 legacy note/);
  assert.match(notes.text, /1 note/);
  notes.component.handleInput("\u0003");
  assert.equal(notes.isClosed(), true);

  const pluralNotes = await renderCommand(commands.get("notes"), [
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

test("item commands notify RPC frontends and render explicit TUI empty states", async () => {
  const commands = registerCommands();
  const notifications: any[] = [];
  await commands.get("notes").handler("", {
    mode: "rpc",
    sessionManager: {
      getBranch: () => [
        {
          type: "custom",
          customType: "rin.note",
          data: { items: [{ id: 4, text: "remote note" }], nextId: 5 },
        },
      ],
    },
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  });
  assert.deepEqual(notifications, [
    { message: "- #4 remote note", level: "info" },
  ]);

  await commands.get("todos").handler("", {
    mode: "rpc",
    sessionManager: {
      getBranch: () => [
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
      ],
    },
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  });
  assert.deepEqual(notifications[1], {
    message: "[ ] #1 open\n[x] #2 done",
    level: "info",
  });

  await commands.get("notes").handler("", {
    mode: "rpc",
    sessionManager: { getBranch: () => [] },
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  });
  assert.deepEqual(notifications[2], {
    message: "No notes yet. Ask the agent to add verified facts!",
    level: "info",
  });

  assert.match(
    (await renderCommand(commands.get("todos"), [])).text,
    /No todos yet/,
  );
  assert.match(
    (await renderCommand(commands.get("notes"), [])).text,
    /No notes yet/,
  );
});
