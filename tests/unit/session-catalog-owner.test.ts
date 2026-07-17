import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const catalog = await importBuiltModule<
  typeof import("../../src/core/session/catalog.js")
>("dist/core/session/catalog.js");

async function withSessionDir(run: (directory: string) => Promise<void>) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-catalog-owner-"),
  );
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function sessionEntries(id: string, cwd: string, timestamp: string, name = "") {
  return [
    {
      type: "session",
      id,
      cwd,
      timestamp,
      parentSession: id === "child" ? "/parent.jsonl" : "",
    },
    ...(name ? [{ type: "session_info", name }] : []),
    {
      type: "message",
      timestamp,
      message: {
        role: "user",
        content: [
          { type: "text", text: `hello ${id}\u0000` },
          { type: "image" },
        ],
      },
    },
    {
      type: "message",
      timestamp: new Date(Date.parse(timestamp) + 1000).toISOString(),
      message: { role: "assistant", content: `answer ${id}` },
    },
    {
      type: "message",
      timestamp: "bad",
      message: { role: "toolResult", content: "ignored" },
    },
  ];
}

async function writeSession(filePath: string, entries: any[]) {
  await fs.writeFile(
    filePath,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
}

test("session catalog summarizes typed entries and rejects invalid records", () => {
  const fallback = new Date("2026-07-15T00:00:00.000Z");
  assert.equal(
    catalog.summarizeSessionEntries("/tmp/no-header.jsonl", [
      { type: "message" },
    ]),
    null,
  );
  const summary = catalog.summarizeSessionEntries(
    "/tmp/child.jsonl",
    sessionEntries("child", "/work/owner", "2026-07-15T01:00:00.000Z", "Named"),
    fallback,
  );
  assert.ok(summary);
  assert.equal(summary.id, "child");
  assert.equal(summary.name, "Named");
  assert.equal(summary.firstMessage, "hello child");
  assert.equal(summary.messageCount, 3);
  assert.equal(summary.parentSessionPath, "/parent.jsonl");
  assert.match(summary.allMessagesText, /answer child/);

  const fallbackSummary = catalog.summarizeSessionEntries(
    "/tmp/fallback.jsonl",
    [{ type: "session", timestamp: "bad" }],
    fallback,
  );
  assert.equal(fallbackSummary?.id, "fallback.jsonl");
  assert.equal(fallbackSummary?.firstMessage, "(no messages)");
  assert.equal(fallbackSummary?.modified.toISOString(), fallback.toISOString());
});

test("session catalog reads files, ignores malformed lines, and preserves order", async () => {
  await withSessionDir(async (directory) => {
    const first = path.join(directory, "first.jsonl");
    const second = path.join(directory, "second.jsonl");
    await writeSession(
      first,
      sessionEntries("first", "/work/a", "2026-07-15T01:00:00.000Z"),
    );
    await fs.writeFile(
      second,
      `not-json\n${JSON.stringify({ type: "session", id: "second", timestamp: "2026-07-15T02:00:00.000Z" })}\n`,
    );
    await fs.writeFile(path.join(directory, "ignored.txt"), "ignored");
    await fs.mkdir(path.join(directory, "folder.jsonl"));

    assert.deepEqual(
      await catalog.listSessionRecordFiles(path.join(directory, "missing")),
      [],
    );
    assert.deepEqual(
      (await catalog.listSessionRecordFiles(directory)).sort(),
      [first, second].sort(),
    );
    assert.equal(
      await catalog.readSessionSummary(path.join(directory, "ignored.txt")),
      null,
    );
    assert.equal(
      await catalog.readSessionSummary(path.join(directory, "missing.jsonl")),
      null,
    );
    assert.equal((await catalog.readSessionSummary(first))?.id, "first");

    const summaries = await catalog.loadSessionSummaries([
      first,
      "",
      path.join(directory, "missing"),
      second,
    ]);
    assert.deepEqual(
      summaries.map((summary) => summary.id),
      ["first", "second"],
    );
  });
});

test("session catalog rebuilds scoped pages and repairs partial state", async () => {
  await withSessionDir(async (directory) => {
    for (const [id, cwd, timestamp] of [
      ["one", "/work/a", "2026-07-15T01:00:00.000Z"],
      ["two", "/work/b", "2026-07-15T02:00:00.000Z"],
      ["three", "/work/a", "2026-07-15T03:00:00.000Z"],
    ] as const) {
      await writeSession(
        path.join(directory, `${id}.jsonl`),
        sessionEntries(id, cwd, timestamp),
      );
    }

    assert.equal(
      await catalog.tryListSessionCatalogPage({
        sessionDir: directory,
        offset: 0,
        limit: 2,
      }),
      undefined,
    );
    assert.deepEqual(await catalog.rebuildSessionCatalog(directory), {
      checked: 3,
      indexed: 3,
    });
    const firstPage = await catalog.tryListSessionCatalogPage({
      sessionDir: directory,
      offset: 0,
      limit: 2,
    });
    assert.deepEqual(
      firstPage?.sessions.map((session) => session.id),
      ["three", "two"],
    );
    assert.equal(firstPage?.hasMore, true);
    assert.equal(firstPage?.nextOffset, 2);

    const scoped = await catalog.tryListSessionCatalogPage({
      sessionDir: directory,
      cwd: "/work/a",
      offset: 0,
      limit: 10,
    });
    assert.deepEqual(
      scoped?.sessions.map((session) => session.id),
      ["three", "one"],
    );
    assert.equal(scoped?.hasMore, false);

    await catalog.ensureSessionCatalog(directory);
    await fs.rm(
      path.join(directory, ".rin-session-catalog", "v1", "state.json"),
    );
    await catalog.ensureSessionCatalog(directory);
    assert.ok(
      await catalog.tryListSessionCatalogPage({
        sessionDir: directory,
        offset: 0,
        limit: 1,
      }),
    );
  });
});

test("session catalog reads large head-tail files and filters malformed tail records", async () => {
  await withSessionDir(async (directory) => {
    const largePath = path.join(directory, "large.jsonl");
    const header = JSON.stringify({
      type: "session",
      id: "large",
      cwd: "/work/large",
      timestamp: "2026-07-15T00:00:00.000Z",
    });
    const filler = JSON.stringify({
      type: "metadata",
      value: "x".repeat(300_000),
    });
    const tail = JSON.stringify({
      type: "message",
      timestamp: "2026-07-15T05:00:00.000Z",
      message: { role: "user", content: "tail owner message" },
    });
    await fs.writeFile(largePath, `${header}\n${filler}\n${tail}\n`);
    const summary = await catalog.readSessionSummary(largePath);
    assert.equal(summary?.id, "large");
    assert.equal(summary?.firstMessage, "tail owner message");

    await catalog.rebuildSessionCatalog(directory);
    const allPath = path.join(
      directory,
      ".rin-session-catalog",
      "v1",
      "all.jsonl",
    );
    await fs.appendFile(
      allPath,
      [
        "not-json",
        JSON.stringify({ schemaVersion: 9 }),
        JSON.stringify({
          schemaVersion: 1,
          path: "/tmp/invalid-owner-catalog-record",
          modified: "bad",
        }),
        JSON.stringify({
          schemaVersion: 1,
          path: largePath,
          id: "large-new",
          firstMessage: "newest",
          modified: "2026-07-15T06:00:00.000Z",
          messageCount: -2,
          cwd: "/work/other",
        }),
      ].join("\n") + "\n",
    );
    const page = await catalog.tryListSessionCatalogPage({
      sessionDir: directory,
      offset: 0,
      limit: 10,
    });
    assert.deepEqual(
      page?.sessions.map((entry) => entry.id),
      ["large-new"],
    );
    assert.equal(page?.sessions[0].messageCount, 0);

    const missingScope = await catalog.tryListSessionCatalogPage({
      sessionDir: directory,
      cwd: "/work/missing",
      offset: 0,
      limit: 2,
    });
    assert.deepEqual(missingScope?.sessions, []);
  });
});

test("session catalog rebuilds an empty directory and sync falls back to the session path", async () => {
  await withSessionDir(async (directory) => {
    assert.deepEqual(await catalog.rebuildSessionCatalog(directory), {
      checked: 0,
      indexed: 0,
    });
    const sessionFile = path.join(directory, "fallback.jsonl");
    await fs.writeFile(sessionFile, "");
    assert.equal(
      catalog.updateSessionCatalogFromSessionManagerSync({
        sessionFile,
        fileEntries: sessionEntries("fallback", "", "2026-07-15T04:00:00.000Z"),
      }),
      true,
    );
    const page = await catalog.tryListSessionCatalogPage({
      sessionDir: directory,
      offset: 0,
      limit: 5,
    });
    assert.equal(page?.sessions[0].id, "fallback");
  });
});

test("session manager sync catalog accepts persisted sessions and handles malformed managers", async () => {
  await withSessionDir(async (directory) => {
    assert.equal(
      catalog.updateSessionCatalogFromSessionManagerSync({
        isPersisted: () => false,
      }),
      false,
    );
    assert.equal(
      catalog.updateSessionCatalogFromSessionManagerSync({
        isPersisted: () => true,
        fileEntries: [],
      }),
      false,
    );
    assert.equal(
      catalog.updateSessionCatalogFromSessionManagerSync({
        isPersisted: () => true,
        sessionFile: path.join(directory, "missing-header.jsonl"),
        fileEntries: [{ type: "message" }],
      }),
      false,
    );
    const filePath = path.join(directory, "live.jsonl");
    await writeSession(
      filePath,
      sessionEntries("live", "/work/live", "2026-07-15T04:00:00.000Z"),
    );
    assert.equal(
      catalog.updateSessionCatalogFromSessionManagerSync({
        isPersisted: () => true,
        sessionFile: filePath,
        fileEntries: sessionEntries(
          "live",
          "/work/live",
          "2026-07-15T04:00:00.000Z",
        ),
        getSessionDir: () => directory,
      }),
      true,
    );
    assert.equal(
      catalog.updateSessionCatalogFromSessionManagerSync({
        isPersisted: () => {
          throw new Error("broken manager");
        },
      }),
      false,
    );
    const page = await catalog.tryListSessionCatalogPage({
      sessionDir: directory,
      offset: 0,
      limit: 0,
    });
    assert.deepEqual(page?.sessions, []);
  });
});
