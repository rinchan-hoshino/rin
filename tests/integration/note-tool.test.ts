import test from "node:test";
import assert from "node:assert/strict";
import {
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
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

async function createNoteTool(initialEntries: any[] = []) {
  const capability = noteModule.default();
  const entries = [...initialEntries];
  const sessionManager = {
    getBranch: () => entries,
    appendCustomEntry(customType: string, data: any) {
      entries.push({ type: "custom", customType, data });
    },
  };
  await capability.hooks?.session_start?.[0]?.({}, { sessionManager });
  return { capability, tool: capability.tools[0], entries, sessionManager };
}

async function execute(tool: any, params: any, signal?: AbortSignal) {
  return tool.execute("note-call", params, signal, undefined, {});
}

test("note tool exposes explicit read, write, edit, and append operations", async () => {
  const { tool } = await createNoteTool();

  assert.equal(tool.name, "note");
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), [
    "action",
    "content",
    "edits",
    "limit",
    "offset",
  ]);
  assert.deepEqual(tool.parameters.required, ["action"]);

  const piRead = createReadTool(rootDir);
  assert.deepEqual(
    tool.parameters.properties.offset,
    piRead.parameters.properties.offset,
  );
  assert.deepEqual(
    tool.parameters.properties.limit,
    piRead.parameters.properties.limit,
  );
  assert.deepEqual(
    tool.parameters.properties.content,
    createWriteTool(rootDir).parameters.properties.content,
  );
  assert.deepEqual(
    tool.parameters.properties.edits,
    createEditTool(rootDir).parameters.properties.edits,
  );
});

test("note tool writes, appends, and preserves Pi ranged read output", async () => {
  const { tool, entries } = await createNoteTool();

  const written = await execute(tool, {
    action: "write",
    content: "first\nsecond",
  });
  assert.match(written.content[0].text, /Successfully wrote/);
  assert.match(written.content[0].text, /\.rin-session-note\.txt/);
  assert.equal(written.details, undefined);

  const appended = await execute(tool, {
    action: "append",
    content: "\nthird\nfourth",
  });
  assert.equal(appended.details.action, "append");
  assert.equal(appended.details.lineCount, 4);
  assert.equal(appended.content[0].text, "Appended to note (4 lines total)");

  const read = await execute(tool, { action: "read", offset: 2, limit: 2 });
  assert.equal(
    read.content[0].text,
    "second\nthird\n\n[1 more lines in file. Use offset=4 to continue.]",
  );
  assert.equal(read.details, undefined);

  assert.deepEqual(entries, [
    {
      type: "custom",
      customType: "rin.note",
      data: { content: "first\nsecond" },
    },
    {
      type: "custom",
      customType: "rin.note",
      data: { content: "first\nsecond\nthird\nfourth" },
    },
  ]);
});

test("note read inherits Pi optional offset and limit behavior", async () => {
  const { tool } = await createNoteTool();
  await execute(tool, { action: "write", content: "one\ntwo\nthree" });

  assert.equal(
    (await execute(tool, { action: "read" })).content[0].text,
    "one\ntwo\nthree",
  );
  assert.equal(
    (await execute(tool, { action: "read", offset: 2 })).content[0].text,
    "two\nthree",
  );
  assert.equal(
    (await execute(tool, { action: "read", limit: 2 })).content[0].text,
    "one\ntwo\n\n[1 more lines in file. Use offset=3 to continue.]",
  );

  await assert.rejects(
    execute(tool, { action: "read", offset: 4 }),
    /beyond end of file \(3 lines total\)/,
  );
});

test("note write rejects missing Pi-required content without checkpointing", async () => {
  const { tool, entries } = await createNoteTool();

  await assert.rejects(
    execute(tool, { action: "write" }),
    /content must be a string/,
  );
  assert.equal(entries.length, 0);
});

test("note edit preserves Pi missing-edits validation without checkpointing", async () => {
  const { tool, entries } = await createNoteTool();

  await assert.rejects(
    execute(tool, { action: "edit" }),
    /edits must contain at least one replacement/,
  );
  assert.equal(entries.length, 0);
});

test("note write preserves Pi abort behavior without checkpointing", async () => {
  const { tool, entries } = await createNoteTool();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    execute(
      tool,
      { action: "write", content: "not written" },
      controller.signal,
    ),
    /Operation aborted/,
  );
  assert.equal(entries.length, 0);
});

test("note edit applies unique non-overlapping replacements atomically", async () => {
  const { tool, entries } = await createNoteTool();
  await execute(tool, {
    action: "write",
    content: "alpha beta alpha\ngamma",
  });

  await assert.rejects(
    execute(tool, {
      action: "edit",
      edits: [{ oldText: "alpha", newText: "A" }],
    }),
    /Found 2 occurrences.*text must be unique/,
  );
  assert.equal(entries.length, 1);

  const edited = await execute(tool, {
    action: "edit",
    edits: [
      { oldText: "alpha beta alpha", newText: "A beta A" },
      { oldText: "gamma", newText: "G" },
    ],
  });
  assert.equal(
    edited.content[0].text,
    "Successfully replaced 2 block(s) in .rin-session-note.txt.",
  );
  assert.match(edited.details.diff, /-1 alpha beta alpha/);
  assert.match(edited.details.diff, /\+1 A beta A/);
  assert.match(edited.details.diff, /-2 gamma/);
  assert.match(edited.details.diff, /\+2 G/);

  const read = await execute(tool, { action: "read", offset: 1, limit: 2 });
  assert.equal(read.content[0].text, "A beta A\nG");
  assert.equal(entries.length, 2);
});

test("note edit follows Pi matching for overlapping occurrences", async () => {
  const { tool, entries } = await createNoteTool();
  await execute(tool, { action: "write", content: "aaa" });

  await execute(tool, {
    action: "edit",
    edits: [{ oldText: "aa", newText: "A" }],
  });

  assert.equal(entries.length, 2);
  const read = await execute(tool, { action: "read", offset: 1, limit: 1 });
  assert.equal(read.content[0].text, "Aa");
});

test("note edit reuses Pi line-ending normalization and no-op rejection", async () => {
  const { tool, entries } = await createNoteTool();
  await execute(tool, { action: "write", content: "alpha\r\nbeta" });

  await execute(tool, {
    action: "edit",
    edits: [{ oldText: "alpha\nbeta", newText: "A\nB" }],
  });
  const read = await execute(tool, { action: "read", offset: 1, limit: 2 });
  assert.equal(read.content[0].text, "A\r\nB");

  await assert.rejects(
    execute(tool, {
      action: "edit",
      edits: [{ oldText: "A\nB", newText: "A\nB" }],
    }),
    /No changes made/,
  );
  assert.equal(entries.length, 2);
});

test("note edit rejects overlapping replacements without changing state", async () => {
  const { tool, entries } = await createNoteTool();
  await execute(tool, { action: "write", content: "abcdef" });

  await assert.rejects(
    execute(tool, {
      action: "edit",
      edits: [
        { oldText: "abcd", newText: "left" },
        { oldText: "cdef", newText: "right" },
      ],
    }),
    /edits\[0\] and edits\[1\] overlap/,
  );

  assert.equal(entries.length, 1);
  const read = await execute(tool, { action: "read", offset: 1, limit: 1 });
  assert.equal(read.content[0].text, "abcdef");
});

test("note append respects aborts while waiting behind Pi mutations", async () => {
  const { tool, entries } = await createNoteTool();
  await execute(tool, { action: "write", content: "alpha" });

  const edit = execute(tool, {
    action: "edit",
    edits: [{ oldText: "alpha", newText: "edited" }],
  });
  const controller = new AbortController();
  const append = execute(
    tool,
    { action: "append", content: " appended" },
    controller.signal,
  );
  controller.abort();

  await edit;
  await assert.rejects(append, /Operation aborted/);
  assert.equal(entries.length, 2);
  const read = await execute(tool, { action: "read", offset: 1, limit: 1 });
  assert.equal(read.content[0].text, "edited");
});

test("note checkpoints restore the current branch while a new session starts empty", async () => {
  const first = await createNoteTool();
  await execute(first.tool, { action: "write", content: "main branch" });

  const restored = await createNoteTool(first.entries);
  assert.equal(
    (await execute(restored.tool, { action: "read", offset: 1, limit: 1 }))
      .content[0].text,
    "main branch",
  );

  const fresh = await createNoteTool();
  const empty = await execute(fresh.tool, {
    action: "read",
    offset: 1,
    limit: 1,
  });
  assert.equal(empty.content[0].text, "");
  assert.equal(empty.details, undefined);
});

test("note session-tree reconstruction follows the selected branch", async () => {
  const capability = noteModule.default();
  const mainEntry = {
    type: "custom",
    customType: "rin.note",
    data: { content: "main" },
  };
  const forkEntry = {
    type: "custom",
    customType: "rin.note",
    data: { content: "fork" },
  };
  let branch = [mainEntry];
  const sessionManager = {
    getBranch: () => branch,
    appendCustomEntry() {},
  };

  await capability.hooks?.session_start?.[0]?.({}, { sessionManager });
  const tool = capability.tools[0];
  assert.equal(
    (await execute(tool, { action: "read", offset: 1, limit: 1 })).content[0]
      .text,
    "main",
  );

  branch = [mainEntry, forkEntry];
  await capability.hooks?.session_tree?.[0]?.({}, { sessionManager });
  assert.equal(
    (await execute(tool, { action: "read", offset: 1, limit: 1 })).content[0]
      .text,
    "fork",
  );
});

test("note mutation errors do not change in-memory state", async () => {
  const capability = noteModule.default();
  const tool = capability.tools[0];
  await capability.hooks?.session_start?.[0]?.(
    {},
    { sessionManager: { getBranch: () => [] } },
  );

  await assert.rejects(
    execute(tool, { action: "write", content: "lost" }),
    /session custom entries are not available/,
  );

  const read = await execute(tool, { action: "read", offset: 1, limit: 1 });
  assert.equal(read.content[0].text, "");
});
