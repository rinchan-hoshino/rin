import assert from "node:assert/strict";
import test from "node:test";
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
const itemToolModule = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "item-tool.js"))
    .href
);

async function setup(
  initialEntries: any[] = [],
  managerOverrides: Record<string, any> = {},
) {
  const capability = todoModule.default();
  const entries = [...initialEntries];
  const sessionManager = {
    getBranch: () => entries,
    appendCustomEntry(customType: string, data: any) {
      entries.push({ type: "custom", customType, data });
    },
    ...managerOverrides,
  };
  await capability.hooks?.session_start?.[0]?.({}, { sessionManager });
  return { capability, tool: capability.tools[0], entries, sessionManager };
}

async function execute(tool: any, params: any, signal?: AbortSignal) {
  return tool.execute("todo-call", params, signal, undefined, {});
}

test("shared item helpers validate operation shapes, IDs, insertion, and removal", () => {
  assert.match(
    itemToolModule.validateItemActionParams(null).error,
    /action is required/,
  );
  assert.match(
    itemToolModule.validateItemActionParams({ action: "legacy" }).error,
    /action must be read, add, edit, or remove/,
  );
  assert.match(
    itemToolModule.validateItemActionParams({ action: "read", id: 1 }).error,
    /read does not accept: id/,
  );
  assert.deepEqual(
    itemToolModule.validateItemActionParams({
      action: "read",
      offset: 2,
      limit: 3,
    }),
    { action: "read" },
  );
  assert.deepEqual(
    itemToolModule.validateItemActionParams({ action: "add", items: [] }),
    { action: "add" },
  );

  assert.equal(itemToolModule.normalizeItemId(1), 1);
  assert.equal(itemToolModule.normalizeItemId(" #2 "), 2);
  assert.equal(itemToolModule.normalizeItemId(0), undefined);
  assert.equal(itemToolModule.normalizeItemId("bad"), undefined);
  assert.equal(itemToolModule.normalizeItemId({}), undefined);
  assert.equal(itemToolModule.normalizeNextItemId([{ id: 3 }], 2), 4);
  assert.equal(itemToolModule.normalizeNextItemId([{ id: 3 }], 8), 8);

  assert.deepEqual(
    itemToolModule.resolveItemReadWindow(["A", "B", "C"], { limit: 2 }),
    {
      items: ["A", "B"],
      ranged: true,
      offset: 1,
      total: 3,
    },
  );
  assert.deepEqual(
    itemToolModule.resolveItemReadWindow(["A", "B", "C"], { offset: 4 }),
    {
      items: [],
      ranged: true,
      offset: 4,
      total: 3,
    },
  );
  assert.equal(
    itemToolModule.formatItemReadWindowLabel({
      items: [],
      offset: 4,
      total: 3,
    }),
    "No items at offset 4 (3 total)",
  );

  const items = [{ id: 1 }, { id: 2 }];
  assert.deepEqual(itemToolModule.resolveInsertIndex(items, undefined), {
    index: 2,
  });
  assert.deepEqual(itemToolModule.resolveInsertIndex(items, "#2"), {
    index: 1,
  });
  assert.match(
    itemToolModule.resolveInsertIndex(items, 0).error,
    /positive integer/,
  );
  assert.match(
    itemToolModule.resolveInsertIndex(items, 3).error,
    /anchor #3 not found/,
  );

  assert.deepEqual(itemToolModule.resolveRemovalIds({ all: true }, items), {
    clear: true,
    ids: [1, 2],
  });
  assert.match(
    itemToolModule.resolveRemovalIds({ all: true, ids: [1] }, items).error,
    /either ids or all/,
  );
  assert.match(
    itemToolModule.resolveRemovalIds({ all: false }, items).error,
    /all must be true/,
  );
  assert.match(
    itemToolModule.resolveRemovalIds({ ids: [] }, items).error,
    /requires one or more ids/,
  );
  assert.match(
    itemToolModule.resolveRemovalIds({ ids: [0] }, items).error,
    /positive integers/,
  );
  assert.match(
    itemToolModule.resolveRemovalIds({ ids: [3] }, items).error,
    /#3 not found/,
  );
  assert.deepEqual(
    itemToolModule.resolveRemovalIds({ ids: [2, 1, 2] }, items),
    { ids: [2, 1] },
  );
});

test("todo exposes ranged reads and item-level mutation inputs", async () => {
  const { tool } = await setup();
  assert.equal(tool.name, "todo");
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), [
    "action",
    "all",
    "beforeId",
    "id",
    "ids",
    "item",
    "items",
    "limit",
    "offset",
  ]);
  assert.deepEqual(tool.parameters.required, ["action"]);
  assert.deepEqual(
    tool.parameters.properties.action.anyOf.map((entry: any) => entry.const),
    ["read", "add", "edit", "remove"],
  );
  assert.equal(tool.parameters.properties.offset.minimum, 1);
  assert.equal(tool.parameters.properties.limit.minimum, 1);
  assert.equal(tool.parameters.properties.todos, undefined);
});

test("todo adds one or many items and inserts a group before a stable id", async () => {
  const { tool, entries } = await setup();

  const added = await execute(tool, {
    action: "add",
    items: [{ text: " First " }, { text: "Third", done: true }],
  });
  assert.equal(added.details.action, "add");
  assert.deepEqual(added.details.items, [
    { id: 1, text: "First", done: false },
    { id: 2, text: "Third", done: true },
  ]);

  const inserted = await execute(tool, {
    action: "add",
    beforeId: 2,
    items: [{ text: "Second A" }, { text: "Second B" }],
  });
  assert.deepEqual(inserted.details.items, [
    { id: 1, text: "First", done: false },
    { id: 3, text: "Second A", done: false },
    { id: 4, text: "Second B", done: false },
    { id: 2, text: "Third", done: true },
  ]);
  assert.equal(inserted.details.nextId, 5);
  assert.match(inserted.content[0].text, /#3 Second A/);
  assert.equal(entries.length, 2);
});

test("todo supports full or ranged reads and edits exactly one item", async () => {
  const { tool, entries } = await setup();
  await execute(tool, {
    action: "add",
    items: [{ text: "A" }, { text: "B" }, { text: "C" }],
  });

  const edited = await execute(tool, {
    action: "edit",
    id: 2,
    item: { text: " B updated ", done: true },
  });
  assert.equal(edited.details.action, "edit");
  assert.deepEqual(edited.details.items, [
    { id: 1, text: "A", done: false },
    { id: 2, text: "B updated", done: true },
    { id: 3, text: "C", done: false },
  ]);

  const read = await execute(tool, { action: "read" });
  assert.equal(read.details.action, "read");
  assert.deepEqual(read.details.items, edited.details.items);
  assert.equal(read.content[0].text, "[ ] #1 A\n[x] #2 B updated\n[ ] #3 C");

  const ranged = await execute(tool, { action: "read", offset: 2, limit: 1 });
  assert.deepEqual(ranged.details.items, [
    { id: 2, text: "B updated", done: true },
  ]);
  assert.equal(ranged.content[0].text, "Items 2-2 of 3\n[x] #2 B updated");
  assert.equal(entries.length, 2);
});

test("todo removes selected ids atomically and clears only with all true", async () => {
  const { tool, entries } = await setup();
  await execute(tool, {
    action: "add",
    items: [{ text: "A" }, { text: "B" }, { text: "C" }],
  });

  const missing = await execute(tool, { action: "remove", ids: [2, 99] });
  assert.match(missing.details.error, /#99 not found/);
  assert.deepEqual(
    missing.details.items.map((item: any) => item.id),
    [1, 2, 3],
  );
  assert.equal(entries.length, 1);

  const removed = await execute(tool, { action: "remove", ids: [1, 3] });
  assert.deepEqual(removed.details.items, [{ id: 2, text: "B", done: false }]);
  assert.equal(removed.details.nextId, 4);

  const cleared = await execute(tool, { action: "remove", all: true });
  assert.deepEqual(cleared.details.items, []);
  assert.equal(cleared.details.nextId, 1);
  assert.equal(cleared.content[0].text, "No todos");
});

test("todo rejects old whole-list writes and malformed item operations without checkpointing", async () => {
  const { tool, entries } = await setup();
  for (const params of [
    {},
    { todos: [{ text: "old protocol" }] },
    { action: "write", items: [{ text: "old action" }] },
    { action: "read", offset: 0 },
    { action: "read", limit: 0 },
    { action: "edit", offset: 1, id: 1, item: { done: true } },
    { action: "add", items: [] },
    { action: "add", items: [{ text: "  " }] },
    { action: "add", beforeId: 99, items: [{ text: "missing anchor" }] },
    { action: "edit", id: 1, item: {} },
    { action: "remove", ids: [] },
    { action: "remove", all: false },
  ]) {
    const result = await execute(tool, params);
    assert.ok(result.details.error, JSON.stringify(params));
  }
  assert.equal(entries.length, 0);
});

test("todo preserves accepted state across aborts, persistence failures, and branch reconstruction", async () => {
  const first = await setup();
  await execute(first.tool, { action: "add", items: [{ text: "kept" }] });

  const controller = new AbortController();
  controller.abort();
  const aborted = await execute(
    first.tool,
    { action: "edit", id: 1, item: { done: true } },
    controller.signal,
  );
  assert.match(aborted.details.error, /aborted/i);

  const restored = await setup(first.entries);
  assert.deepEqual(
    (await execute(restored.tool, { action: "read" })).details.items,
    [{ id: 1, text: "kept", done: false }],
  );

  const unavailable = await setup(first.entries, {
    appendCustomEntry: undefined,
  });
  const failed = await execute(unavailable.tool, {
    action: "edit",
    id: 1,
    item: { done: true },
  });
  assert.match(
    failed.details.error,
    /session custom entries are not available/,
  );
  assert.deepEqual(
    (await execute(unavailable.tool, { action: "read" })).details.items,
    [{ id: 1, text: "kept", done: false }],
  );
});
