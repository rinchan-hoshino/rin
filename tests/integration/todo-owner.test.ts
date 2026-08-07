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

test("todo owner renders normalized calls, results, errors, and fallbacks", async () => {
  const { tool } = await setup();
  assert.match(
    tool
      .renderCall({ action: "add" }, theme, { isPartial: true })
      .render(80)
      .join(""),
    /todo add/,
  );
  assert.match(
    tool.renderCall({}, theme, { isPartial: true }).render(80).join(""),
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
  assert.match(rendered, /○ #1 Open/);
  assert.match(rendered, /✓ #2 Done/);

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
  assert.match(error, /○ #1 Kept/);

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
