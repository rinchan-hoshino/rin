import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const todoModule = await importBuiltModule<
  typeof import("../../src/core/rin-lib/todo.js")
>("dist/core/rin-lib/todo.js");

const theme = {
  fg(_color: string, text: string) {
    return text;
  },
};

async function setup(
  entries: any[] = [],
  managerOverrides: Record<string, any> = {},
) {
  const capability = todoModule.default();
  const sessionManager = {
    getBranch: () => entries,
    appendCustomEntry(customType: string, data: any) {
      entries.push({ type: "custom", customType, data });
    },
    ...managerOverrides,
  };
  await capability.hooks?.session_start?.[0]?.({}, { sessionManager } as any);
  return {
    capability,
    tool: capability.tools[0] as any,
    entries,
    sessionManager,
  };
}

test("todo owner replaces, reads, clears, validates, and restores branch checkpoints", async () => {
  const { capability, tool, entries, sessionManager } = await setup();
  assert.equal(capability.name, "todo");
  assert.deepEqual(Object.keys((tool.parameters as any).properties), ["todos"]);

  const initial = await tool.execute("read", {}, undefined, undefined, {});
  assert.equal(initial.details.action, "list");
  assert.equal(initial.content[0].text, "No todos");

  const invalid = await tool.execute(
    "invalid",
    { todos: [{ text: "  " }] },
    undefined,
    undefined,
    {},
  );
  assert.equal(invalid.details.action, "write");
  assert.match(invalid.details.error, /complete array/);

  const written = await tool.execute(
    "write",
    { todos: [{ text: " First " }, { text: "Done", done: true }] },
    undefined,
    undefined,
    {},
  );
  assert.deepEqual(written.details.todos, [
    { id: 1, text: "First", done: false },
    { id: 2, text: "Done", done: true },
  ]);
  assert.equal(written.details.nextId, 3);
  assert.equal(written.content[0].text, "[ ] First\n[x] Done");
  assert.equal(entries.length, 1);

  const readNull = await tool.execute(
    "read-null",
    { todos: null },
    undefined,
    undefined,
    {},
  );
  assert.deepEqual(readNull.details.todos, written.details.todos);

  const cleared = await tool.execute(
    "clear",
    { todos: [] },
    undefined,
    undefined,
    {},
  );
  assert.equal(cleared.details.action, "clear");
  assert.equal(cleared.details.nextId, 1);

  entries.push({
    type: "custom",
    customType: "rin.todo",
    data: {
      todos: [
        { id: 4, text: " Restored ", done: 1 },
        { id: "bad", text: "ignored" },
        null,
      ],
      nextId: "bad",
    },
  });
  await capability.hooks?.session_tree?.[0]?.({}, { sessionManager } as any);
  const restored = await tool.execute(
    "restored",
    undefined,
    undefined,
    undefined,
    {},
  );
  assert.deepEqual(restored.details.todos, [
    { id: 4, text: "Restored", done: true },
  ]);
  assert.equal(restored.details.nextId, 5);
});

test("todo owner reports persistence errors without mutating the accepted checklist", async () => {
  const { tool } = await setup([], { appendCustomEntry: undefined });
  const result = await tool.execute(
    "write",
    { todos: [{ text: "Cannot persist" }] },
    undefined,
    undefined,
    {},
  );
  assert.match(
    result.details.error,
    /session custom entries are not available/,
  );
  assert.deepEqual(result.details.todos, []);

  const throwing = await setup([], {
    appendCustomEntry() {
      throw "disk failed";
    },
  });
  const stringError = await throwing.tool.execute(
    "write",
    { todos: [{ text: "Cannot persist" }] },
    undefined,
    undefined,
    {},
  );
  assert.match(stringError.details.error, /disk failed/);
});

test("todo owner renders calls and results from normalized public details", async () => {
  const { tool } = await setup();
  const partial = tool
    .renderCall(
      {
        todos: Array.from({ length: 7 }, (_, index) => ({
          text: `Item ${index + 1}`,
          done: index === 0,
        })),
      },
      theme,
      { isPartial: true },
    )
    .render(80)
    .join("\n");
  assert.match(partial, /✓ Item 1/);
  assert.match(partial, /○ Item 7/);
  assert.doesNotMatch(partial, /… 2 more/);
  const streamed = tool
    .renderCall(
      { todos: [null, { text: " Streamed " }, { text: "" }] },
      theme,
      { isPartial: true, argsComplete: false },
    )
    .render(80)
    .join("");
  assert.match(streamed, /Streamed/);
  assert.match(
    tool
      .renderCall({ todos: "pending" }, theme, {
        isPartial: true,
        argsComplete: false,
      })
      .render(80)
      .join(""),
    /…/,
  );
  assert.equal(
    tool.renderCall({}, theme, { isPartial: false }).render(80).join(""),
    "",
  );
  assert.equal(
    tool
      .renderCall({ todos: "bad" }, theme, { isPartial: true })
      .render(80)
      .join(""),
    "",
  );

  const fallback = tool
    .renderResult(
      { content: [{ type: "text", text: "fallback" }] },
      { expanded: false },
      theme,
      {},
    )
    .render(80)
    .join("\n");
  assert.equal(fallback.trimEnd(), "fallback");

  const compact = tool
    .renderResult(
      {
        content: [{ type: "text", text: "" }],
        details: {
          action: "unknown",
          todos: Array.from({ length: 7 }, (_, index) => ({
            id: index + 1,
            text: `Item ${index + 1}`,
            done: false,
          })),
          nextId: 8,
        },
      },
      { expanded: false },
      theme,
      {},
    )
    .render(80)
    .join("\n");
  assert.match(compact, /○ Item 7/);
  assert.doesNotMatch(compact, /… 2 more/);

  const expandedError = tool
    .renderResult(
      {
        content: [{ type: "text", text: "" }],
        details: {
          action: "write",
          todos: [{ id: 1, text: "Kept", done: false }],
          nextId: 2,
          error: "failed",
        },
      },
      { expanded: true },
      theme,
      {},
    )
    .render(80)
    .join("\n");
  assert.equal(
    expandedError
      .split("\n")
      .map((line: string) => line.trimEnd())
      .join("\n"),
    "Error: failed\n○ Kept",
  );

  const empty = tool
    .renderResult(
      {
        content: [{ type: "image" }],
        details: { action: "list", todos: [], nextId: 1 },
      },
      { expanded: false },
      theme,
      {},
    )
    .render(80)
    .join("\n");
  assert.equal(empty.trimEnd(), "○ No todos");
});
