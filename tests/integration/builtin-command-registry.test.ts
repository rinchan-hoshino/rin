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
    ["todos"],
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
  assert.equal(await registry.execute("/notes", context), false);
  assert.equal(await registry.execute("todos", context), false);
  assert.equal(await registry.execute("/owner-command", context), false);
});

async function renderTodos(branch: any[]) {
  let component: any;
  let closed = false;
  const handled = await registry.execute("/todos", {
    sessionManager: { getBranch: () => branch },
    ui: {
      theme: {
        fg: (_color: string, text: unknown) => String(text),
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
  };
}

test("/todos renders current branch progress without internal item numbers", async () => {
  const todos = await renderTodos([
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
  ]);

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
});

test("/todos renders an explicit TUI empty state", async () => {
  assert.match((await renderTodos([])).text, /No todos yet/);
});
