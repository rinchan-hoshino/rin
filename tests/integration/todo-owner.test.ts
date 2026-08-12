import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const todoModule = await importBuiltModule<
  typeof import("../../src/core/rin-lib/todo.js")
>("dist/core/rin-lib/todo.js");

const theme = {
  fg(_color: string, text: unknown) {
    return String(text);
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
    tool: capability.tools![0] as any,
    entries,
    sessionManager,
  };
}

test("todo owner preserves insertion order while reconstructing branch checkpoints", async () => {
  const entries = [
    {
      type: "custom",
      customType: "rin.todo",
      data: {
        todos: [
          { id: 3, text: "inserted first", done: false },
          { id: 1, text: "older second", done: true },
        ],
        nextId: 4,
      },
    },
  ];
  const { tool } = await setup(entries);
  const read = await tool.execute(
    "read",
    { action: "read" },
    undefined,
    undefined,
    {},
  );
  assert.deepEqual(read.details.items, [
    { id: 3, text: "inserted first", done: false },
    { id: 1, text: "older second", done: true },
  ]);
  assert.equal(
    read.content[0].text,
    "[ ] #3 inserted first\n[x] #1 older second",
  );
});

test("todo owner reports thrown persistence values without mutating accepted state", async () => {
  const { tool } = await setup([], {
    appendCustomEntry() {
      throw "disk failed";
    },
  });
  const result = await tool.execute(
    "add",
    { action: "add", items: [{ text: "Cannot persist" }] },
    undefined,
    undefined,
    {},
  );
  assert.match(result.details.error, /disk failed/);
  assert.deepEqual(result.details.items, []);
});

test("todo owner updates one TUI component and hides an empty checklist", async () => {
  const { tool } = await setup();
  const pending = tool.renderCall({ action: "add" }, theme, {
    isPartial: true,
    lastComponent: undefined,
  });
  assert.match(pending.render(80).join(""), /todo add/);
  const updatedPending = tool.renderCall({ action: "edit" }, theme, {
    isPartial: true,
    lastComponent: pending,
  });
  assert.equal(updatedPending, pending);
  assert.match(updatedPending.render(80).join(""), /todo edit/);
  assert.match(
    tool
      .renderCall({}, theme, { isPartial: true, lastComponent: undefined })
      .render(80)
      .join(""),
    /todo …/,
  );
  assert.equal(
    tool.renderCall({}, theme, { isPartial: false }).render(80).join(""),
    "",
  );

  const rendered = tool
    .renderResult(
      {
        content: [{ type: "text", text: "" }],
        details: {
          action: "read",
          items: [
            { id: 1, text: "Open", done: false },
            { id: 2, text: "Done", done: true },
          ],
          nextId: 3,
        },
      },
      {},
      theme,
      {},
    )
    .render(80)
    .join("\n");
  assert.match(rendered, /○ Open/);
  assert.match(rendered, /✓ Done/);
  assert.doesNotMatch(rendered, /#1|#2/);

  const firstResult = tool.renderResult(
    {
      content: [{ type: "text", text: "" }],
      details: {
        action: "read",
        items: [{ id: 1, text: "Old", done: false }],
        nextId: 2,
      },
    },
    {},
    theme,
    { lastComponent: undefined },
  );
  const updatedResult = tool.renderResult(
    {
      content: [{ type: "text", text: "" }],
      details: {
        action: "edit",
        items: [{ id: 1, text: "New", done: true }],
        nextId: 2,
      },
    },
    {},
    theme,
    { lastComponent: firstResult },
  );
  assert.equal(updatedResult, firstResult);
  assert.match(updatedResult.render(80).join("\n"), /✓ New/);
  assert.doesNotMatch(updatedResult.render(80).join("\n"), /Old/);

  const empty = tool
    .renderResult(
      {
        content: [{ type: "text", text: "" }],
        details: { action: "remove", items: [], nextId: 1 },
      },
      {},
      theme,
      { lastComponent: undefined },
    )
    .render(80)
    .join("");
  assert.equal(empty, "");

  const error = tool
    .renderResult(
      {
        content: [{ type: "text", text: "" }],
        details: {
          action: "edit",
          items: [{ id: 1, text: "Kept", done: false }],
          nextId: 2,
          error: "failed",
        },
      },
      {},
      theme,
      {},
    )
    .render(80)
    .join("\n");
  assert.match(error, /^Error: failed/);
  assert.match(error, /○ Kept/);
  assert.doesNotMatch(error, /#1/);

  assert.equal(
    tool
      .renderResult(
        { content: [{ type: "text", text: "fallback" }] },
        {},
        theme,
        {},
      )
      .render(80)
      .join("")
      .trimEnd(),
    "fallback",
  );
});
