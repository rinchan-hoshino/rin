import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import BetterSqlite3 from "better-sqlite3";

import {
  appendTranscriptArchiveEntry,
  loadRecentTranscriptSessions,
  loadTranscriptSessionEntries,
  repairTranscriptSearchIndex,
  searchTranscriptArchive,
} from "../../dist/core/memory/transcript-search.js";
import {
  getTranscriptArchivePath,
  resolveTranscriptSearchDbPath,
} from "../../dist/core/memory/transcript-archive.js";

async function withSearchRoot(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-search-owner-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function createSessionFile(root: string, name: string) {
  const sessionFile = path.join(root, "sessions", `${name}.jsonl`);
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(
    sessionFile,
    `${JSON.stringify({ type: "session", id: name, name: `Owner ${name}` })}\n`,
  );
  return sessionFile;
}

function archiveInput(
  sessionFile: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "owner-entry",
    timestamp: "2026-07-17T08:00:00.000Z",
    sessionId: "owner-session",
    sessionFile,
    role: "assistant",
    text: "owner alpha release path /srv/rin/main.ts",
    ...overrides,
  };
}

test("transcript search incrementally indexes valid records and exposes session views", async () => {
  await withSearchRoot(async (root) => {
    const firstSession = await createSessionFile(root, "first");
    const secondSession = await createSessionFile(root, "second");

    await appendTranscriptArchiveEntry({}, root);
    await appendTranscriptArchiveEntry(
      { role: "assistant", text: "missing session file" },
      root,
    );
    await appendTranscriptArchiveEntry(archiveInput(firstSession), root);
    await appendTranscriptArchiveEntry(
      archiveInput(firstSession, {
        id: "owner-tool",
        timestamp: "2026-07-17T08:01:00.000Z",
        role: "toolResult",
        toolName: "read",
        text: "read /srv/rin/main.ts returned owner alpha",
      }),
      root,
    );
    await appendTranscriptArchiveEntry(
      archiveInput(secondSession, {
        id: "owner-second",
        timestamp: "2026-07-17T09:00:00.000Z",
        sessionId: "second-session",
        text: "owner beta release only",
      }),
      root,
    );

    const structured = await searchTranscriptArchive(
      "alpha /srv/rin/main.ts",
      { limit: 2 },
      root,
    );
    assert.equal(structured.length, 1);
    assert.equal(structured[0].id, "owner-session");
    assert.equal(structured[0].hitCount, 2);
    assert.deepEqual(
      structured[0].messages.map((message) => message.id),
      ["owner-entry", "owner-tool"],
    );

    const byFile = await loadTranscriptSessionEntries(
      { sessionFile: firstSession },
      root,
    );
    assert.deepEqual(
      byFile.map((entry) => entry.id),
      ["owner-entry", "owner-tool"],
    );
    const byId = await loadTranscriptSessionEntries(
      { sessionId: "second-session" },
      root,
    );
    assert.deepEqual(
      byId.map((entry) => entry.id),
      ["owner-second"],
    );
    assert.deepEqual(
      await loadTranscriptSessionEntries({ sessionId: "missing" }, root),
      [],
    );
    assert.deepEqual(await loadTranscriptSessionEntries({}, root), []);

    const recent = await loadRecentTranscriptSessions({ limit: 2 }, root);
    assert.deepEqual(
      recent.map((session) => session.id),
      ["second-session", "owner-session"],
    );
    assert.equal(
      (await loadRecentTranscriptSessions({ limit: "invalid" }, root)).length,
      2,
    );
  });
});

test("transcript search supports exact, quoted, structured, and CJK queries", async () => {
  await withSearchRoot(async (root) => {
    const sessionFile = await createSessionFile(root, "multilingual");
    await appendTranscriptArchiveEntry(
      archiveInput(sessionFile, {
        id: "quoted",
        text: 'Owner said "release now" for api/v2:deploy',
      }),
      root,
    );
    await appendTranscriptArchiveEntry(
      archiveInput(sessionFile, {
        id: "cjk",
        timestamp: "2026-07-17T08:02:00.000Z",
        text: "\u94c3\u9171\u68c0\u7d22\u676d\u5dde\u53d1\u5e03\u8bb0\u5f55",
      }),
      root,
    );

    assert.equal(
      (await searchTranscriptArchive("api/v2:deploy", {}, root))[0].id,
      "owner-session",
    );
    assert.equal(
      (await searchTranscriptArchive('release "now"', {}, root))[0].id,
      "owner-session",
    );
    assert.equal(
      (await searchTranscriptArchive("\u676d\u5dde\u53d1\u5e03", {}, root))[0]
        .id,
      "owner-session",
    );
    assert.deepEqual(
      await searchTranscriptArchive(
        "release missing",
        { fidelity: "exact" },
        root,
      ),
      [],
    );
    assert.equal(
      (
        await searchTranscriptArchive(
          "release now",
          { fidelity: "exact" },
          root,
        )
      ).length,
      1,
    );
    assert.deepEqual(await searchTranscriptArchive("   ", {}, root), []);
    assert.deepEqual(
      await searchTranscriptArchive("no-such-token", {}, root),
      [],
    );
  });
});

test("transcript search bounds broad candidate sets while grouping one session", async () => {
  await withSearchRoot(async (root) => {
    const sessionFile = await createSessionFile(root, "broad");
    const archivePath = path.join(
      root,
      "memory",
      "transcripts",
      "2026",
      "07",
      "broad.jsonl",
    );
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    const records = Array.from({ length: 50 }, (_, index) =>
      JSON.stringify(
        archiveInput(sessionFile, {
          id: `broad-${index}`,
          timestamp: `2026-07-17T08:${String(index).padStart(2, "0")}:00.000Z`,
          text: `broad-owner-token record ${index}`,
        }),
      ),
    );
    await fs.writeFile(archivePath, `${records.join("\n")}\n`);
    await repairTranscriptSearchIndex(root);

    const results = await searchTranscriptArchive(
      "broad-owner-token",
      {},
      root,
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].id, "owner-session");
    assert.equal(results[0].hitCount, 50);
    assert.equal(results[0].messages.length, 3);
  });
});

test("transcript index repair rebuilds changed archives and removes deleted sessions", async () => {
  await withSearchRoot(async (root) => {
    const firstSession = await createSessionFile(root, "repair-first");
    const secondSession = await createSessionFile(root, "repair-second");
    const first = archiveInput(firstSession, {
      id: "repair-first",
      text: "first repair marker",
    });
    const second = archiveInput(secondSession, {
      id: "repair-second",
      sessionId: "repair-second-session",
      timestamp: "2026-07-17T10:00:00.000Z",
      text: "second repair marker",
    });
    const firstArchive = getTranscriptArchivePath(first, root);
    const secondArchive = getTranscriptArchivePath(second, root);
    await fs.mkdir(path.dirname(firstArchive), { recursive: true });
    await fs.writeFile(firstArchive, `${JSON.stringify(first)}\n`);
    await fs.writeFile(secondArchive, `${JSON.stringify(second)}\n`);

    const initial = await repairTranscriptSearchIndex(root);
    assert.equal(initial.fileCount, 2);
    assert.equal(initial.entryCount, 2);
    assert.equal(
      (await searchTranscriptArchive("repair marker", {}, root)).length,
      2,
    );

    await fs.writeFile(
      firstArchive,
      `${JSON.stringify({ ...first, text: "updated repair marker" })}\n`,
    );
    await fs.rm(secondArchive);
    const rebuilt = await repairTranscriptSearchIndex(root);
    assert.equal(rebuilt.fileCount, 1);
    assert.equal(rebuilt.entryCount, 1);
    assert.equal(
      (await searchTranscriptArchive("updated repair", {}, root)).length,
      1,
    );
    assert.deepEqual(
      await searchTranscriptArchive(
        "second repair",
        { fidelity: "exact" },
        root,
      ),
      [],
    );
  });
});

test("transcript search self-heals database files and ignores malformed indexed records", async () => {
  await withSearchRoot(async (root) => {
    const dbPath = resolveTranscriptSearchDbPath(root);
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    await fs.writeFile(dbPath, "not a sqlite database");
    assert.deepEqual(await searchTranscriptArchive("owner", {}, root), []);

    let db = new BetterSqlite3(dbPath);
    db.prepare("UPDATE metadata SET value = ? WHERE key = ?").run(
      "3",
      "schema_version",
    );
    db.close();
    assert.deepEqual(await loadRecentTranscriptSessions({}, root), []);

    const sessionFile = await createSessionFile(root, "malformed-index");
    await appendTranscriptArchiveEntry(
      archiveInput(sessionFile, {
        id: "malformed-index",
        text: "malformed index owner token",
        sessionId: "",
        role: "custom",
        customType: "owner-note",
        timestamp: "",
      }),
      root,
    );
    db = new BetterSqlite3(dbPath);
    db.prepare("UPDATE entries SET entry_json = ?").run("not json");
    db.close();
    assert.deepEqual(
      await searchTranscriptArchive("malformed index", {}, root),
      [],
    );
    assert.deepEqual(
      await loadTranscriptSessionEntries({ sessionFile }, root),
      [],
    );

    await repairTranscriptSearchIndex(root);
    db = new BetterSqlite3(dbPath);
    db.prepare("UPDATE entries SET entry_json = ?").run(
      JSON.stringify({ role: "custom", text: "" }),
    );
    db.close();
    assert.deepEqual(
      await searchTranscriptArchive("malformed index", {}, root),
      [],
    );

    await repairTranscriptSearchIndex(root);
    db = new BetterSqlite3(dbPath);
    db.prepare("UPDATE entries SET entry_json = ?").run(
      JSON.stringify({
        id: "legacy-summary",
        role: "sessionSummary",
        text: "malformed index owner token",
        sessionFile,
      }),
    );
    db.close();
    assert.deepEqual(
      await searchTranscriptArchive("malformed index", {}, root),
      [],
    );

    await repairTranscriptSearchIndex(root);
    db = new BetterSqlite3(dbPath);
    db.prepare("UPDATE entries SET entry_json = ?").run(
      JSON.stringify({
        id: "missing-session-file",
        role: "custom",
        text: "malformed index owner token",
      }),
    );
    db.close();
    assert.deepEqual(
      await searchTranscriptArchive("malformed index", {}, root),
      [],
    );

    await repairTranscriptSearchIndex(root);
    assert.deepEqual(await searchTranscriptArchive("x", {}, root), []);
    assert.deepEqual(await searchTranscriptArchive("1", {}, root), []);
    assert.equal(
      (await searchTranscriptArchive("owner", { limit: -4 }, root)).length,
      1,
    );
    assert.equal(
      (await searchTranscriptArchive("owner", { limit: "invalid" }, root))
        .length,
      1,
    );
  });
});

test("transcript index repair tolerates sparse historical archive fields", async () => {
  await withSearchRoot(async (root) => {
    const archivePath = path.join(
      root,
      "memory",
      "transcripts",
      "2024",
      "01",
      "sparse.jsonl",
    );
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    await fs.writeFile(
      archivePath,
      `${JSON.stringify({ id: "", text: "sparse historical owner record" })}\n`,
    );

    const repaired = await repairTranscriptSearchIndex(root);
    assert.equal(repaired.fileCount, 1);
    assert.equal(repaired.entryCount, 1);
    assert.deepEqual(
      await searchTranscriptArchive("sparse historical", {}, root),
      [],
    );
  });
});

test("recent transcript sessions omit historical records without a session file", async () => {
  await withSearchRoot(async (root) => {
    const archivePath = path.join(
      root,
      "memory",
      "transcripts",
      "2024",
      "01",
      "no-session-file.jsonl",
    );
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    await fs.writeFile(
      archivePath,
      `${JSON.stringify({
        id: "historical-no-session-file",
        role: "assistant",
        text: "historical owner record without session file",
        timestamp: "2024-01-02T03:04:05.000Z",
      })}\n`,
    );

    const repaired = await repairTranscriptSearchIndex(root);
    assert.equal(repaired.entryCount, 1);
    assert.deepEqual(await loadRecentTranscriptSessions({}, root), []);
  });
});

test("transcript search honors default roots and keeps archive writes when index creation fails", async () => {
  await withSearchRoot(async (root) => {
    const previousRinDir = process.env.RIN_DIR;
    process.env.RIN_DIR = root;
    try {
      assert.deepEqual(await loadRecentTranscriptSessions(), []);
      const dbPath = resolveTranscriptSearchDbPath();
      await fs.rm(dbPath, { force: true });
      const db = new BetterSqlite3(dbPath);
      db.exec(
        "CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
      db.close();
      assert.deepEqual(await searchTranscriptArchive("owner"), []);

      const sessionFile = await createSessionFile(root, "default-root");
      await appendTranscriptArchiveEntry(
        archiveInput(sessionFile, {
          id: "default-root",
          sessionId: "",
          role: "user",
          text: "equal owner default root",
        }),
      );
      const fullHaystack = `equal owner default root user ${sessionFile}`;
      const exactHaystack = await searchTranscriptArchive(fullHaystack, {
        fidelity: "exact",
      });
      assert.equal(exactHaystack.length, 1);
      assert.equal(exactHaystack[0].messages[0].id, "default-root");
    } finally {
      if (previousRinDir === undefined) delete process.env.RIN_DIR;
      else process.env.RIN_DIR = previousRinDir;
    }

    const blockedRoot = path.join(root, "blocked-index");
    const blockedSession = await createSessionFile(blockedRoot, "blocked");
    await fs.mkdir(path.join(blockedRoot, "memory", "search.db"), {
      recursive: true,
    });
    const blockedInput = archiveInput(blockedSession, {
      id: "archive-survives-index-failure",
      text: "archive survives index failure",
    });
    await appendTranscriptArchiveEntry(blockedInput, blockedRoot);
    const archived = await fs.readFile(
      getTranscriptArchivePath(blockedInput, blockedRoot),
      "utf8",
    );
    assert.match(archived, /archive survives index failure/);
  });
});

test("transcript session loading accepts absolute and relative archive paths before index lookup", async () => {
  await withSearchRoot(async (root) => {
    const sessionFile = await createSessionFile(root, "direct");
    const input = archiveInput(sessionFile, {
      id: "direct-path",
      text: "direct path owner record",
    });
    await appendTranscriptArchiveEntry(input, root);
    const archivePath = getTranscriptArchivePath(input, root);
    const relativePath = path.relative(
      path.join(root, "memory", "transcripts"),
      archivePath,
    );

    assert.deepEqual(
      (await loadTranscriptSessionEntries({ path: archivePath }, root)).map(
        (entry) => entry.id,
      ),
      ["direct-path"],
    );
    assert.deepEqual(
      (await loadTranscriptSessionEntries({ path: relativePath }, root)).map(
        (entry) => entry.id,
      ),
      ["direct-path"],
    );
    assert.deepEqual(
      await loadTranscriptSessionEntries({ path: "missing.jsonl" }, root),
      [],
    );
    assert.equal(
      path.basename(resolveTranscriptSearchDbPath(root)),
      "search.db",
    );
  });
});
