import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const noteModule = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "note.js")).href
);
const noteStateModule = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "note-state.js"))
    .href
);

async function setup(
  initialEntries: any[] = [],
  managerOverrides: Record<string, any> = {},
) {
  const capability = noteModule.default();
  const entries = [...initialEntries];
  let branch = entries;
  const sessionManager = {
    getBranch: () => branch,
    appendCustomEntry(customType: string, data: any) {
      entries.push({ type: "custom", customType, data });
    },
    ...managerOverrides,
  };
  await capability.hooks?.session_start?.[0]?.({}, { sessionManager });
  return {
    capability,
    tool: capability.tools[0],
    entries,
    sessionManager,
    setBranch(next: any[]) {
      branch = next;
    },
  };
}

async function execute(tool: any, params: any, signal?: AbortSignal) {
  return tool.execute("note-call", params, signal, undefined, {});
}

test("note exposes ranged reads and item-level mutation inputs", async () => {
  const { tool } = await setup();
  assert.equal(tool.name, "note");
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
  assert.match(
    tool.parameters.properties.items.items.properties.text.description,
    /Shortest verified content that must survive compaction exactly/,
  );
  assert.match(
    tool.parameters.properties.item.properties.text.description,
    /Shortest complete replacement that must survive compaction exactly/,
  );
  for (const retired of ["content", "edits"]) {
    assert.equal(tool.parameters.properties[retired], undefined);
  }
});

test("note adds groups, inserts before an id, and supports full or ranged reads", async () => {
  const { tool, entries } = await setup();
  await execute(tool, {
    action: "add",
    items: [{ text: " First fact " }, { text: "Third fact\nwith detail" }],
  });
  const inserted = await execute(tool, {
    action: "add",
    beforeId: 2,
    items: [{ text: "Second fact" }],
  });

  assert.deepEqual(inserted.details.items, [
    { id: 1, text: "First fact" },
    { id: 3, text: "Second fact" },
    { id: 2, text: "Third fact\nwith detail" },
  ]);
  assert.equal(inserted.details.nextId, 4);
  const read = await execute(tool, { action: "read" });
  assert.equal(read.details.action, "read");
  assert.deepEqual(read.details.items, inserted.details.items);
  assert.match(read.content[0].text, /#1 First fact/);
  assert.match(read.content[0].text, /#2 Third fact\nwith detail/);

  const ranged = await execute(tool, { action: "read", offset: 2, limit: 1 });
  assert.deepEqual(ranged.details.items, [{ id: 3, text: "Second fact" }]);
  assert.match(ranged.content[0].text, /^Items 2-2 of 3\n#3 Second fact$/);
  assert.doesNotMatch(ranged.content[0].text, /First fact|Third fact/);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.at(-1)?.data, {
    items: inserted.details.items,
    nextId: 4,
  });
});

test("note edits one entry, removes a group atomically, and clears explicitly", async () => {
  const { tool, entries } = await setup();
  await execute(tool, {
    action: "add",
    items: [{ text: "A" }, { text: "B" }, { text: "C" }],
  });
  const edited = await execute(tool, {
    action: "edit",
    id: 2,
    item: { text: " B updated " },
  });
  assert.deepEqual(edited.details.items[1], { id: 2, text: "B updated" });

  const missing = await execute(tool, { action: "remove", ids: [1, 99] });
  assert.match(missing.details.error, /#99 not found/);
  assert.equal(entries.length, 2);

  const removed = await execute(tool, { action: "remove", ids: [1, 3] });
  assert.deepEqual(removed.details.items, [{ id: 2, text: "B updated" }]);
  assert.equal(removed.details.nextId, 4);

  const cleared = await execute(tool, { action: "remove", all: true });
  assert.deepEqual(cleared.details.items, []);
  assert.equal(cleared.details.nextId, 1);
  assert.equal(cleared.content[0].text, "No notes");
});

test("note state normalizes current, legacy, malformed, and unavailable snapshots", () => {
  assert.equal(noteStateModule.normalizeRinNoteItem(null), undefined);
  assert.equal(
    noteStateModule.normalizeRinNoteItem({ id: 0, text: "zero" }),
    undefined,
  );
  assert.deepEqual(noteStateModule.normalizeRinNoteItem({ id: 1, text: 7 }), {
    id: 1,
    text: "7",
  });
  assert.equal(
    noteStateModule.normalizeRinNoteItem({ id: 1, text: "   " }),
    undefined,
  );
  assert.deepEqual(
    noteStateModule.normalizeRinNoteItem({ id: 2, text: "  kept  " }),
    { id: 2, text: "kept" },
  );

  const fromData = (data: unknown) =>
    noteStateModule.readNoteSnapshotFromSession({
      sessionManager: {
        getBranch: () => [
          null,
          { type: "custom", customType: "other", data: {} },
          { type: "custom", customType: "rin.note", data },
        ],
      },
    });
  assert.deepEqual(
    fromData({
      items: [
        { id: 3, text: "valid" },
        { id: -1, text: "invalid" },
      ],
      nextId: 2,
    }),
    { items: [{ id: 3, text: "valid" }], nextId: 4 },
  );
  assert.deepEqual(fromData({ content: "  legacy  " }), {
    items: [{ id: 1, text: "legacy" }],
    nextId: 2,
  });
  assert.deepEqual(fromData({ content: "   " }), {
    items: [],
    nextId: 1,
  });
  assert.deepEqual(fromData({ content: 5 }), { items: [], nextId: 1 });
  assert.deepEqual(fromData(null), { items: [], nextId: 1 });
  assert.deepEqual(noteStateModule.readNoteSnapshotFromSession({}), {
    items: [],
    nextId: 1,
  });
  assert.deepEqual(
    noteStateModule.readNoteSnapshotFromSession({
      sessionManager: { getBranch: () => "not-a-branch" },
    }),
    { items: [], nextId: 1 },
  );
  assert.deepEqual(
    noteStateModule.readNoteSnapshotFromSession({
      sessionManager: {
        getBranch() {
          throw new Error("unavailable");
        },
      },
    }),
    { items: [], nextId: 1 },
  );
});

test("note migrates a legacy text snapshot to one item without exposing the old protocol", async () => {
  const legacy = {
    type: "custom",
    customType: "rin.note",
    data: { content: "legacy fact\nwith detail" },
  };
  const { tool, entries } = await setup([legacy]);

  const read = await execute(tool, { action: "read" });
  assert.deepEqual(read.details.items, [
    { id: 1, text: "legacy fact\nwith detail" },
  ]);
  assert.equal(read.details.nextId, 2);

  await execute(tool, { action: "add", items: [{ text: "new fact" }] });
  assert.deepEqual(entries.at(-1)?.data, {
    items: [
      { id: 1, text: "legacy fact\nwith detail" },
      { id: 2, text: "new fact" },
    ],
    nextId: 3,
  });
});

test("note rejects old text-buffer calls and malformed operations without mutation", async () => {
  const { tool, entries } = await setup();
  for (const params of [
    { action: "write", content: "old" },
    { action: "append", content: "old" },
    { action: "read", offset: 0 },
    { action: "read", limit: 0 },
    { action: "add", offset: 1, items: [{ text: "not a read" }] },
    { action: "add", items: [] },
    { action: "add", items: [{ text: " " }] },
    { action: "add", beforeId: 4, items: [{ text: "missing anchor" }] },
    { action: "edit", id: 1, item: {} },
    { action: "remove", ids: [] },
    { action: "remove", all: false },
  ]) {
    const result = await execute(tool, params);
    assert.ok(result.details.error, JSON.stringify(params));
  }
  assert.equal(entries.length, 0);
});

test("note restores the selected branch and keeps state unchanged on abort or persistence failure", async () => {
  const main = {
    type: "custom",
    customType: "rin.note",
    data: { items: [{ id: 1, text: "main" }], nextId: 2 },
  };
  const fork = {
    type: "custom",
    customType: "rin.note",
    data: { items: [{ id: 2, text: "fork" }], nextId: 3 },
  };
  const state = await setup([main]);
  state.setBranch([main, fork]);
  await state.capability.hooks?.session_tree?.[0]?.(
    {},
    { sessionManager: state.sessionManager },
  );
  assert.deepEqual(
    (await execute(state.tool, { action: "read" })).details.items,
    [{ id: 2, text: "fork" }],
  );

  const controller = new AbortController();
  controller.abort();
  const aborted = await execute(
    state.tool,
    { action: "edit", id: 2, item: { text: "lost" } },
    controller.signal,
  );
  assert.match(aborted.details.error, /aborted/i);

  const unavailable = await setup([fork], { appendCustomEntry: undefined });
  const failed = await execute(unavailable.tool, {
    action: "edit",
    id: 2,
    item: { text: "lost" },
  });
  assert.match(
    failed.details.error,
    /session custom entries are not available/,
  );
  assert.deepEqual(
    (await execute(unavailable.tool, { action: "read" })).details.items,
    [{ id: 2, text: "fork" }],
  );
});

test("note updates the same TUI call and result components", async () => {
  const { tool } = await setup();
  const theme = { fg: (_color: string, text: unknown) => String(text) };
  const pending = tool.renderCall({ action: "add" }, theme, {
    isPartial: true,
    lastComponent: undefined,
  });
  assert.match(pending.render(80).join(""), /note add/);
  const updatedPending = tool.renderCall({ action: "edit" }, theme, {
    isPartial: true,
    lastComponent: pending,
  });
  assert.equal(updatedPending, pending);
  assert.match(updatedPending.render(80).join(""), /note edit/);
  assert.match(
    tool.renderCall({}, theme, { isPartial: true }).render(80).join(""),
    /note …/,
  );
  assert.equal(
    tool.renderCall({}, theme, { isPartial: false }).render(80).join(""),
    "",
  );
  const firstResult = tool.renderResult(
    {
      content: [{ type: "text", text: "" }],
      details: {
        action: "read",
        items: [{ id: 1, text: "old fact" }],
        nextId: 2,
      },
    },
    {},
    theme,
    { lastComponent: undefined },
  );
  assert.match(firstResult.render(80).join(""), /#1 old fact/);
  const updatedResult = tool.renderResult(
    {
      content: [{ type: "text", text: "" }],
      details: {
        action: "edit",
        items: [{ id: 1, text: "new fact" }],
        nextId: 2,
      },
    },
    {},
    theme,
    { lastComponent: firstResult },
  );
  assert.equal(updatedResult, firstResult);
  assert.match(updatedResult.render(80).join(""), /#1 new fact/);
  assert.doesNotMatch(updatedResult.render(80).join(""), /old fact/);
  assert.match(
    tool
      .renderResult(
        {
          content: [{ type: "text", text: "" }],
          details: {
            action: "edit",
            items: [],
            nextId: 1,
            error: "failed",
          },
        },
        {},
        theme,
        {},
      )
      .render(80)
      .join("\n"),
    /^Error: failed/,
  );
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
