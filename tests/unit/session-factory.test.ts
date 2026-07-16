import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import BetterSqlite3 from "better-sqlite3";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const factory = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "session", "factory.js"))
    .href
);
const listing = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "session", "listing.js"))
    .href
);
const catalog = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "session", "catalog.js"))
    .href
);
async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function writeSessionRecord(sessionDir, name, entries) {
  const filePath = path.join(sessionDir, name);
  await fs.writeFile(
    filePath,
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
  await fs.utimes(
    filePath,
    new Date("2020-01-01T00:00:00.000Z"),
    new Date("2020-01-01T00:00:00.000Z"),
  );
  return filePath;
}

async function directorySize(root) {
  let total = 0;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    total += entry.isDirectory()
      ? await directorySize(entryPath)
      : (await fs.stat(entryPath)).size;
  }
  return total;
}

function readRawCatalogRow(sessionDir, sessionFile) {
  const db = new BetterSqlite3(
    path.join(sessionDir, ".rin-session-catalog", "v2", "catalog.sqlite"),
    { readonly: true },
  );
  try {
    return db.prepare("SELECT * FROM sessions WHERE path = ?").get(sessionFile);
  } finally {
    db.close();
  }
}

function sessionEntries({ id, cwd, first, last, name, parentSession }) {
  return [
    {
      type: "session",
      version: 3,
      id,
      timestamp: "2026-04-01T00:00:00.000Z",
      cwd,
      ...(parentSession ? { parentSession } : {}),
    },
    {
      type: "message",
      id: `${id}-user`,
      timestamp: first,
      message: {
        role: "user",
        content: [{ type: "text", text: `${id} first message` }],
      },
    },
    ...(name
      ? [
          {
            type: "session_info",
            id: `${id}-name`,
            timestamp: last,
            name,
          },
        ]
      : []),
    {
      type: "message",
      id: `${id}-assistant`,
      timestamp: last,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${id} assistant reply` }],
      },
    },
  ];
}

test("listBoundSessions does not create cwd-encoded empty session dirs", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-agent-"));
  const cwd = path.join(os.tmpdir(), "rin-project-cwd");
  const previousRinDir = process.env.RIN_DIR;
  process.env.RIN_DIR = agentDir;

  try {
    await factory.listBoundSessions({ cwd });
    assert.equal(
      await pathExists(
        path.join(agentDir, "sessions", "--tmp-rin-project-cwd--"),
      ),
      false,
    );
  } finally {
    if (previousRinDir === undefined) {
      delete process.env.RIN_DIR;
    } else {
      process.env.RIN_DIR = previousRinDir;
    }
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("listBoundSessions reads only canonical root sessions", async () => {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-sessions-"));
  const cwd = "/tmp/project";
  const legacyDir = path.join(sessionDir, "legacy");
  await fs.mkdir(legacyDir);

  try {
    await writeSessionRecord(
      sessionDir,
      "older.jsonl",
      sessionEntries({
        id: "older",
        cwd,
        first: "2026-04-16T00:00:00.000Z",
        last: "2026-04-16T00:05:00.000Z",
      }),
    );
    await writeSessionRecord(
      sessionDir,
      "newer.jsonl",
      sessionEntries({
        id: "newer",
        cwd,
        first: "2026-04-17T00:00:00.000Z",
        last: "2026-04-17T00:05:00.000Z",
      }),
    );
    await writeSessionRecord(
      legacyDir,
      "legacy.jsonl",
      sessionEntries({
        id: "legacy",
        cwd,
        first: "2026-04-18T00:00:00.000Z",
        last: "2026-04-18T00:05:00.000Z",
      }),
    );

    const sessions = await factory.listBoundSessions({
      cwd,
      sessionDir,
      SessionManager: {
        async list() {
          throw new Error("catalog must own canonical listing");
        },
      },
    });

    assert.deepEqual(
      sessions.map((item) => item.id),
      ["newer", "older"],
    );
  } finally {
    await fs.rm(sessionDir, { recursive: true, force: true });
  }
});

test("listBoundSessionPage returns a bounded recent page from root session records", async () => {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-page-"));
  const cwd = "/tmp/rin-page-project";
  const parentPath = path.join(sessionDir, "parent.jsonl");

  try {
    await writeSessionRecord(
      sessionDir,
      "old.jsonl",
      sessionEntries({
        id: "old",
        cwd,
        first: "2026-04-02T00:00:00.000Z",
        last: "2026-04-02T00:05:00.000Z",
      }),
    );
    await writeSessionRecord(
      sessionDir,
      "new.jsonl",
      sessionEntries({
        id: "new",
        cwd,
        first: "2026-04-04T00:00:00.000Z",
        last: "2026-04-04T00:05:00.000Z",
        name: "Newest named session",
      }),
    );
    await writeSessionRecord(
      sessionDir,
      "middle.jsonl",
      sessionEntries({
        id: "middle",
        cwd,
        first: "2026-04-03T00:00:00.000Z",
        last: "2026-04-03T00:05:00.000Z",
        parentSession: parentPath,
      }),
    );
    await writeSessionRecord(
      sessionDir,
      "other-cwd.jsonl",
      sessionEntries({
        id: "other-cwd",
        cwd: "/tmp/other-project",
        first: "2026-04-05T00:00:00.000Z",
        last: "2026-04-05T00:05:00.000Z",
      }),
    );

    const firstPage = await factory.listBoundSessionPage({
      cwd,
      sessionDir,
      limit: 2,
    });
    assert.deepEqual(
      firstPage.sessions.map((session) => session.id),
      ["new", "middle"],
    );
    assert.equal(firstPage.total, 3);
    assert.equal(firstPage.hasMore, true);
    assert.equal(firstPage.nextOffset, 2);
    assert.equal(firstPage.sessions[0].name, "Newest named session");
    assert.equal(firstPage.sessions[0].messageCount, 2);
    assert.equal(firstPage.sessions[1].parentSessionPath, parentPath);
    assert.equal(firstPage.sessions[0].cwd, undefined);

    const secondPage = await factory.listBoundSessionPage({
      cwd,
      sessionDir,
      limit: 2,
      offset: firstPage.nextOffset,
    });
    assert.deepEqual(
      secondPage.sessions.map((session) => session.id),
      ["old"],
    );
    assert.equal(secondPage.hasMore, false);
  } finally {
    await fs.rm(sessionDir, { recursive: true, force: true });
  }
});

test("listBoundSessionPage uses a built catalog without reparsing session jsonl files", async () => {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-catalog-"));
  const cwd = "/tmp/rin-catalog-project";

  try {
    await writeSessionRecord(
      sessionDir,
      "old.jsonl",
      sessionEntries({
        id: "old",
        cwd,
        first: "2026-04-02T00:00:00.000Z",
        last: "2026-04-02T00:05:00.000Z",
      }),
    );
    await writeSessionRecord(
      sessionDir,
      "new.jsonl",
      sessionEntries({
        id: "new",
        cwd,
        first: "2026-04-03T00:00:00.000Z",
        last: "2026-04-03T00:05:00.000Z",
      }),
    );

    await catalog.rebuildSessionCatalog(sessionDir);

    const page = await factory.listBoundSessionPage({
      cwd,
      sessionDir,
      limit: 1,
    });

    assert.deepEqual(
      page.sessions.map((session) => session.id),
      ["new"],
    );
    assert.equal(page.hasMore, true);
    assert.equal(page.nextOffset, 1);
  } finally {
    await fs.rm(sessionDir, { recursive: true, force: true });
  }
});

test("session catalog updates from a session manager without deleting sessions", async () => {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-catalog-"));
  const cwd = "/tmp/rin-catalog-live-project";
  const sessionFile = path.join(sessionDir, "live.jsonl");

  try {
    const entries = sessionEntries({
      id: "live",
      cwd,
      first: "2026-04-03T00:00:00.000Z",
      last: "2026-04-03T00:05:00.000Z",
      name: "Live indexed session",
    });
    await writeSessionRecord(sessionDir, "live.jsonl", entries);
    await catalog.updateSessionCatalogFromSessionManagerSync({
      sessionFile,
      fileEntries: entries,
      isPersisted: () => true,
    });

    const partialPage = await catalog.tryListSessionCatalogPage({
      cwd,
      sessionDir,
      offset: 0,
      limit: 1,
    });
    assert.equal(partialPage, undefined);

    await catalog.ensureSessionCatalog(sessionDir);
    const page = await catalog.tryListSessionCatalogPage({
      cwd,
      sessionDir,
      offset: 0,
      limit: 1,
    });
    assert.equal(page?.sessions[0]?.id, "live");
    assert.equal(page.sessions[0]?.name, "Live indexed session");
    assert.equal(await pathExists(sessionFile), true);
  } finally {
    await fs.rm(sessionDir, { recursive: true, force: true });
  }
});

test("session catalog reconcile repairs files persisted before a catalog update", async () => {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-catalog-"));
  const cwd = "/tmp/rin-catalog-reconcile-project";
  const sessionFile = path.join(sessionDir, "reconcile.jsonl");
  const entries = sessionEntries({
    id: "reconcile",
    cwd,
    first: "2026-04-03T00:00:00.000Z",
    last: "2026-04-03T00:05:00.000Z",
  });

  try {
    await writeSessionRecord(sessionDir, "reconcile.jsonl", entries);
    await catalog.rebuildSessionCatalog(sessionDir);
    entries.push({
      type: "message",
      id: "reconcile-after-crash",
      timestamp: "2026-04-03T00:06:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "persisted-before-index-update" }],
      },
    });
    await fs.writeFile(
      sessionFile,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );

    await catalog.ensureSessionCatalog(sessionDir);
    const page = await catalog.tryListSessionCatalogPage({
      cwd,
      sessionDir,
      offset: 0,
      limit: 10,
    });
    assert.match(
      page?.sessions[0]?.allMessagesText || "",
      /persisted-before-index-update/,
    );
  } finally {
    await fs.rm(sessionDir, { recursive: true, force: true });
  }
});

test("session catalog reconcile detects same-size rewrites with restored mtime", async () => {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-catalog-"));
  const cwd = "/tmp/rin-catalog-same-size-project";
  const sessionFile = path.join(sessionDir, "same-size.jsonl");
  const entries = sessionEntries({
    id: "same-size",
    cwd,
    first: "2026-04-03T00:00:00.000Z",
    last: "2026-04-03T00:05:00.000Z",
  });
  entries[2].message.content[0].text = "same-size-old-key";

  try {
    await writeSessionRecord(sessionDir, "same-size.jsonl", entries);
    await catalog.rebuildSessionCatalog(sessionDir);
    const before = await fs.stat(sessionFile);
    entries[2].message.content[0].text = "same-size-new-key";
    await fs.writeFile(
      sessionFile,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    const rewritten = await fs.stat(sessionFile);
    assert.equal(rewritten.size, before.size);
    await fs.utimes(sessionFile, before.atime, before.mtime);

    await catalog.ensureSessionCatalog(sessionDir);
    const page = await catalog.tryListSessionCatalogPage({
      cwd,
      sessionDir,
      offset: 0,
      limit: 10,
    });
    assert.doesNotMatch(page?.sessions[0]?.allMessagesText || "", /old-key/);
    assert.match(page?.sessions[0]?.allMessagesText || "", /new-key/);
  } finally {
    await fs.rm(sessionDir, { recursive: true, force: true });
  }
});

test("session catalog rebuild replaces a malformed same-version cache schema", async () => {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-catalog-"));
  const cwd = "/tmp/rin-catalog-schema-project";

  try {
    await writeSessionRecord(
      sessionDir,
      "schema.jsonl",
      sessionEntries({
        id: "schema",
        cwd,
        first: "2026-04-03T00:00:00.000Z",
        last: "2026-04-03T00:05:00.000Z",
      }),
    );
    const root = path.join(sessionDir, ".rin-session-catalog", "v2");
    await fs.mkdir(root, { recursive: true });
    const db = new BetterSqlite3(path.join(root, "catalog.sqlite"));
    db.exec(`
      CREATE TABLE catalog_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE sessions(path TEXT PRIMARY KEY);
    `);
    db.prepare("INSERT INTO catalog_meta(key, value) VALUES(?, ?)").run(
      "schema_version",
      "2",
    );
    db.close();

    await catalog.ensureSessionCatalog(sessionDir);
    const page = await catalog.tryListSessionCatalogPage({
      cwd,
      sessionDir,
      offset: 0,
      limit: 10,
    });
    assert.deepEqual(
      page?.sessions.map((session) => session.id),
      ["schema"],
    );
  } finally {
    await fs.rm(sessionDir, { recursive: true, force: true });
  }
});

test("session catalog rebuild publishes atomically without exposing incomplete rows", async () => {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-catalog-"));
  const cwd = "/tmp/rin-catalog-atomic-project";
  const entries = sessionEntries({
    id: "atomic",
    cwd,
    first: "2026-04-03T00:00:00.000Z",
    last: "2026-04-03T00:05:00.000Z",
  });

  try {
    await writeSessionRecord(sessionDir, "atomic.jsonl", entries);
    await catalog.rebuildSessionCatalog(sessionDir);
    entries.push({
      type: "message",
      id: "atomic-new",
      timestamp: "2026-04-03T00:06:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "atomic-new-content" }],
      },
    });
    await fs.writeFile(
      path.join(sessionDir, "atomic.jsonl"),
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    await writeSessionRecord(sessionDir, "large.jsonl", [
      {
        type: "session",
        version: 3,
        id: "large",
        timestamp: "2026-04-03T00:00:00.000Z",
        cwd,
      },
      {
        type: "message",
        id: "large-user",
        timestamp: "2026-04-03T00:01:00.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "x".repeat(8 * 1024 * 1024) }],
        },
      },
    ]);

    let settled = false;
    let sawIncomplete = false;
    const rebuilding = catalog.rebuildSessionCatalog(sessionDir).finally(() => {
      settled = true;
    });
    const dbPath = path.join(
      sessionDir,
      ".rin-session-catalog",
      "v2",
      "catalog.sqlite",
    );
    while (!settled) {
      const db = new BetterSqlite3(dbPath, { readonly: true });
      const row = db
        .prepare("SELECT value FROM catalog_meta WHERE key = 'complete'")
        .get();
      db.close();
      if (row?.value !== "1") sawIncomplete = true;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await rebuilding;

    assert.equal(sawIncomplete, false);
    const page = await catalog.tryListSessionCatalogPage({
      cwd,
      sessionDir,
      offset: 0,
      limit: 10,
    });
    assert.match(
      page?.sessions.find((session) => session.id === "atomic")
        ?.allMessagesText || "",
      /atomic-new-content/,
    );
  } finally {
    await fs.rm(sessionDir, { recursive: true, force: true });
  }
});

test("session catalog storage stays bounded when one live session updates repeatedly", async () => {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-catalog-"));
  const cwd = "/tmp/rin-catalog-bounded-project";
  const sessionFile = path.join(sessionDir, "live.jsonl");
  const entries = sessionEntries({
    id: "live",
    cwd,
    first: "2026-04-03T00:00:00.000Z",
    last: "2026-04-03T00:05:00.000Z",
    name: "Live bounded session",
  });

  try {
    await writeSessionRecord(sessionDir, "live.jsonl", entries);
    await catalog.rebuildSessionCatalog(sessionDir);
    const catalogRoot = path.join(sessionDir, ".rin-session-catalog");
    const initialSize = await directorySize(catalogRoot);

    for (let index = 0; index < 50; index += 1) {
      catalog.updateSessionCatalogFromSessionManagerSync({
        sessionFile,
        fileEntries: entries,
        getSessionDir: () => sessionDir,
        isPersisted: () => true,
      });
    }

    const finalSize = await directorySize(catalogRoot);
    assert.ok(
      finalSize <= initialSize * 3,
      `catalog grew from ${initialSize} to ${finalSize} bytes for one session`,
    );
    await catalog.ensureSessionCatalog(sessionDir);
    const page = await catalog.tryListSessionCatalogPage({
      cwd,
      sessionDir,
      offset: 0,
      limit: 10,
    });
    assert.deepEqual(
      page?.sessions.map((session) => session.id),
      ["live"],
    );
  } finally {
    await fs.rm(sessionDir, { recursive: true, force: true });
  }
});

test("session catalog matches Pi for named sessions without messages", async () => {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-catalog-"));
  const cwd = "/tmp/rin-catalog-no-message-project";
  const sessionFile = path.join(sessionDir, "no-message.jsonl");
  const entries = [
    {
      type: "session",
      version: 3,
      id: "no-message",
      timestamp: "2026-04-01T00:00:00.000Z",
      cwd,
    },
    {
      type: "session_info",
      id: "no-message-name",
      timestamp: "2026-04-03T00:00:00.000Z",
      name: "Named without messages",
    },
  ];

  try {
    await writeSessionRecord(sessionDir, "no-message.jsonl", entries);
    await catalog.rebuildSessionCatalog(sessionDir);
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const [pi] = await SessionManager.list(cwd, sessionDir);
    const [indexed] = await catalog.listAllSessionCatalog({ sessionDir, cwd });
    assert.deepEqual(
      {
        id: indexed.id,
        name: indexed.name,
        firstMessage: indexed.firstMessage,
        modified: indexed.modified.toISOString(),
        messageCount: indexed.messageCount,
        allMessagesText: indexed.allMessagesText,
      },
      {
        id: pi.id,
        name: pi.name,
        firstMessage: pi.firstMessage,
        modified: pi.modified.toISOString(),
        messageCount: pi.messageCount,
        allMessagesText: pi.allMessagesText,
      },
    );

    entries.push({
      type: "message",
      id: "no-message-first-activity",
      timestamp: "2025-01-01T00:00:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "first activity is older" }],
      },
    });
    await fs.writeFile(
      sessionFile,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    assert.equal(
      catalog.updateSessionCatalogFromSessionManagerSync({
        sessionFile,
        fileEntries: entries,
        getSessionDir: () => sessionDir,
        isPersisted: () => true,
      }),
      true,
    );
    await catalog.ensureSessionCatalog(sessionDir);
    assert.equal(
      readRawCatalogRow(sessionDir, sessionFile)?.modified,
      "2025-01-01T00:00:00.000Z",
    );
  } finally {
    await fs.rm(sessionDir, { recursive: true, force: true });
  }
});

test("session catalog matches Pi tie ordering and malformed-session exclusion", async () => {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-catalog-"));
  const cwd = "/tmp/rin-catalog-tie-project";
  const tied = (id) =>
    sessionEntries({
      id,
      cwd,
      first: "2026-04-03T00:00:00.000Z",
      last: "2026-04-03T00:05:00.000Z",
    });

  try {
    await writeSessionRecord(sessionDir, "z-tie.jsonl", tied("z-tie"));
    await writeSessionRecord(sessionDir, "a-tie.jsonl", tied("a-tie"));
    await writeSessionRecord(sessionDir, "malformed.jsonl", [
      {
        type: "session",
        version: 3,
        id: "malformed",
        timestamp: "2026-04-01T00:00:00.000Z",
        cwd,
      },
      {
        type: "message",
        id: "malformed-message",
        timestamp: "2026-04-03T00:05:00.000Z",
      },
    ]);
    await writeSessionRecord(sessionDir, "bad-name.jsonl", [
      {
        type: "session",
        version: 3,
        id: "bad-name",
        timestamp: "2026-04-01T00:00:00.000Z",
        cwd,
      },
      {
        type: "session_info",
        id: "bad-name-info",
        timestamp: "2026-04-03T00:05:00.000Z",
        name: 1,
      },
    ]);
    await fs.writeFile(
      path.join(sessionDir, "invalid-json.jsonl"),
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "invalid-json",
        timestamp: "2026-04-01T00:00:00.000Z",
        cwd,
      })}\n{invalid\n`,
    );
    await catalog.rebuildSessionCatalog(sessionDir);
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const pi = await SessionManager.list(cwd, sessionDir);
    const indexed = await catalog.listAllSessionCatalog({ sessionDir, cwd });
    assert.deepEqual(
      indexed.map((session) => path.basename(session.path)),
      pi.map((session) => path.basename(session.path)),
    );
  } finally {
    await fs.rm(sessionDir, { recursive: true, force: true });
  }
});

test("session catalog preserves searchable text beyond the summary preview", async () => {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-catalog-"));
  const cwd = "/tmp/rin-catalog-search-project";
  const keyword = "late-search-keyword-7f4d";
  const entries = sessionEntries({
    id: "searchable",
    cwd,
    first: "2026-04-03T00:00:00.000Z",
    last: "2026-04-03T00:05:00.000Z",
  });
  for (let index = 0; index < 12; index += 1) {
    entries.splice(entries.length - 1, 0, {
      type: "message",
      id: `searchable-extra-${index}`,
      timestamp: `2026-04-03T00:04:${String(index).padStart(2, "0")}.000Z`,
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `${"x".repeat(1900)}${index === 11 ? keyword : ""}`,
          },
        ],
      },
    });
  }

  try {
    await writeSessionRecord(sessionDir, "searchable.jsonl", entries);
    await catalog.rebuildSessionCatalog(sessionDir);
    const page = await factory.listBoundSessionPage({
      cwd,
      sessionDir,
      limit: 10,
    });
    assert.match(page.sessions[0]?.allMessagesText || "", new RegExp(keyword));
  } finally {
    await fs.rm(sessionDir, { recursive: true, force: true });
  }
});

test("session catalog refreshes appended messages and rewrites after dirty marking", async () => {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-catalog-"));
  const cwd = "/tmp/rin-catalog-incremental-project";
  const sessionFile = path.join(sessionDir, "incremental.jsonl");
  const entries = sessionEntries({
    id: "incremental",
    cwd,
    first: "2026-04-03T00:00:00.000Z",
    last: "2026-04-03T00:05:00.000Z",
  });

  try {
    await writeSessionRecord(sessionDir, "incremental.jsonl", entries);
    await catalog.rebuildSessionCatalog(sessionDir);
    entries.push({
      type: "message",
      id: "incremental-late",
      timestamp: "2026-04-03T00:06:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "incremental-late-keyword" }],
      },
    });
    await fs.writeFile(
      sessionFile,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    assert.equal(
      catalog.updateSessionCatalogFromSessionManagerSync({
        sessionFile,
        fileEntries: entries,
        getSessionDir: () => sessionDir,
        isPersisted: () => true,
      }),
      true,
    );
    assert.equal(
      await catalog.tryListSessionCatalogPage({
        cwd,
        sessionDir,
        offset: 0,
        limit: 10,
      }),
      undefined,
    );
    await catalog.ensureSessionCatalog(sessionDir);
    let row = readRawCatalogRow(sessionDir, sessionFile);
    assert.match(row?.all_messages_text || "", /incremental-late-keyword/);

    const rewritten = entries.map((entry) =>
      entry.id === "incremental-late"
        ? {
            ...entry,
            message: {
              role: "assistant",
              content: [{ type: "text", text: "rewritten-late-keyword" }],
            },
          }
        : entry,
    );
    await fs.writeFile(
      sessionFile,
      `${rewritten.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    assert.equal(
      catalog.updateSessionCatalogFromSessionManagerSync({
        sessionFile,
        fileEntries: rewritten,
        getSessionDir: () => sessionDir,
        isPersisted: () => true,
      }),
      true,
    );
    await catalog.ensureSessionCatalog(sessionDir);
    row = readRawCatalogRow(sessionDir, sessionFile);
    assert.doesNotMatch(
      row?.all_messages_text || "",
      /incremental-late-keyword/,
    );
    assert.match(row?.all_messages_text || "", /rewritten-late-keyword/);
  } finally {
    await fs.rm(sessionDir, { recursive: true, force: true });
  }
});

test("session catalog reconciliation handles an older prefix rewrite", async () => {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-catalog-"));
  const cwd = "/tmp/rin-catalog-prefix-project";
  const sessionFile = path.join(sessionDir, "prefix.jsonl");
  const entries = sessionEntries({
    id: "prefix",
    cwd,
    first: "2026-04-03T00:00:00.000Z",
    last: "2026-04-03T00:05:00.000Z",
  });

  try {
    await writeSessionRecord(sessionDir, "prefix.jsonl", entries);
    await catalog.rebuildSessionCatalog(sessionDir);
    const changed = entries.map((entry) =>
      entry.id === "prefix-user"
        ? {
            ...entry,
            message: {
              role: "user",
              content: [{ type: "text", text: "prefix-rewritten-keyword" }],
            },
          }
        : entry,
    );
    changed.push({
      type: "message",
      id: "prefix-appended",
      timestamp: "2026-04-03T00:06:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "prefix-appended-keyword" }],
      },
    });
    await fs.writeFile(
      sessionFile,
      `${changed.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    assert.equal(
      catalog.updateSessionCatalogFromSessionManagerSync({
        sessionFile,
        fileEntries: changed,
        getSessionDir: () => sessionDir,
        isPersisted: () => true,
      }),
      true,
    );
    await catalog.ensureSessionCatalog(sessionDir);
    const row = readRawCatalogRow(sessionDir, sessionFile);
    assert.doesNotMatch(row?.all_messages_text || "", /prefix first message/);
    assert.match(row?.all_messages_text || "", /prefix-rewritten-keyword/);
    assert.match(row?.all_messages_text || "", /prefix-appended-keyword/);
  } finally {
    await fs.rm(sessionDir, { recursive: true, force: true });
  }
});

test("unpaginated session listing uses the catalog instead of reparsing session history", async () => {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-catalog-"));
  const cwd = "/tmp/rin-catalog-all-project";

  try {
    await writeSessionRecord(
      sessionDir,
      "old.jsonl",
      sessionEntries({
        id: "old",
        cwd,
        first: "2026-04-02T00:00:00.000Z",
        last: "2026-04-02T00:05:00.000Z",
      }),
    );
    await writeSessionRecord(
      sessionDir,
      "new.jsonl",
      sessionEntries({
        id: "new",
        cwd,
        first: "2026-04-03T00:00:00.000Z",
        last: "2026-04-03T00:05:00.000Z",
      }),
    );
    await catalog.rebuildSessionCatalog(sessionDir);

    const sessions = await factory.listBoundSessions({
      cwd,
      sessionDir,
      SessionManager: {
        async list() {
          throw new Error("session history must not be reparsed");
        },
      },
    });
    assert.deepEqual(
      sessions.map((session) => session.id),
      ["new", "old"],
    );
  } finally {
    await fs.rm(sessionDir, { recursive: true, force: true });
  }
});

test("listBoundSessions uses the fast page path when pagination is requested", async () => {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-page-"));
  const cwd = "/tmp/rin-page-project";
  let exactListCalled = false;

  try {
    await writeSessionRecord(
      sessionDir,
      "session.jsonl",
      sessionEntries({
        id: "session",
        cwd,
        first: "2026-04-02T00:00:00.000Z",
        last: "2026-04-02T00:05:00.000Z",
      }),
    );
    const sessions = await factory.listBoundSessions({
      cwd,
      sessionDir,
      limit: 1,
      SessionManager: {
        async list() {
          exactListCalled = true;
          return [];
        },
      },
    });

    assert.equal(exactListCalled, false);
    assert.deepEqual(
      sessions.map((session) => session.id),
      ["session"],
    );
  } finally {
    await fs.rm(sessionDir, { recursive: true, force: true });
  }
});

test("session listing normalizes legacy session metadata into canonical fields", () => {
  const sessions = listing.normalizeBoundSessionList([
    {
      id: "session-1",
      title: "Legacy title",
      subtitle: "2026-04-18T00:00:00.000Z",
    },
  ]);

  assert.deepEqual(
    {
      id: sessions[0]?.id,
      path: sessions[0]?.path,
      name: sessions[0]?.name,
      firstMessage: sessions[0]?.firstMessage,
      modified: sessions[0]?.modified?.toISOString(),
      messageCount: sessions[0]?.messageCount,
      cwd: sessions[0]?.cwd,
      allMessagesText: sessions[0]?.allMessagesText,
    },
    {
      id: "session-1",
      path: "session-1",
      name: undefined,
      firstMessage: "Legacy title",
      modified: "2026-04-18T00:00:00.000Z",
      messageCount: 0,
      cwd: undefined,
      allMessagesText: "Legacy title",
    },
  );
});

test("openBoundSession reports an explicit missing session file", async () => {
  await assert.rejects(
    () =>
      factory.openBoundSession({
        cwd: "/tmp/project",
        agentDir: "/tmp/rin-agent",
        sessionFile: "/tmp/missing-rin-session.jsonl",
      }),
    /Session record is missing or expired/,
  );
});

test("renameBoundSession delegates to SessionManager.open once", async () => {
  const renamed = [];
  await factory.renameBoundSession(
    { sessionPath: " /tmp/demo.jsonl " },
    "Renamed",
    {
      SessionManager: {
        open(sessionPath) {
          renamed.push(["open", sessionPath]);
          return {
            appendSessionInfo(name) {
              renamed.push(["rename", name]);
            },
          };
        },
      },
    },
  );

  assert.deepEqual(renamed, [
    ["open", "/tmp/demo.jsonl"],
    ["rename", "Renamed"],
  ]);
});

test("renameBoundSession rejects missing session file selectors", async () => {
  await assert.rejects(
    () =>
      factory.renameBoundSession({ sessionId: "memory-only" }, "Renamed", {
        SessionManager: {
          open() {
            throw new Error("should not reach open");
          },
        },
      }),
    /Session file is required/,
  );
});

test("session listing helpers derive presentation and active state consistently", () => {
  const session = {
    id: "session-1",
    path: "/tmp/session-1.jsonl",
    firstMessage: "Hello",
    modified: new Date("2026-04-18T00:00:00.000Z"),
    messageCount: 0,
    cwd: undefined,
    allMessagesText: "Hello",
  };

  assert.deepEqual(
    listing.describeBoundSession(session, " /tmp/session-1.jsonl "),
    {
      ...session,
      title: "Hello",
      subtitle: "2026-04-18T00:00:00.000Z",
      isActive: true,
    },
  );
  assert.deepEqual(
    listing.describeBoundSessions([session], "/tmp/session-1.jsonl"),
    [
      {
        ...session,
        title: "Hello",
        subtitle: "2026-04-18T00:00:00.000Z",
        isActive: true,
      },
    ],
  );
  assert.equal(
    listing.describeBoundSession({
      id: "legacy-session",
      title: "Legacy title",
      subtitle: "2026-04-19T00:00:00.000Z",
    })?.subtitle,
    "2026-04-19T00:00:00.000Z",
  );
  assert.equal(
    listing.describeBoundSession({
      id: "legacy-session",
      title: "Legacy title",
      modified: "not-a-date",
      subtitle: "2026-04-19T00:00:00.000Z",
    })?.subtitle,
    "2026-04-19T00:00:00.000Z",
  );
  assert.equal(
    listing.describeBoundSession({
      id: "legacy-session",
      title: "Legacy title",
      modified: "not-a-date",
      subtitle: "Legacy subtitle",
    })?.subtitle,
    "Legacy subtitle",
  );
  assert.equal(listing.getBoundSessionDisplayTitle(session), "Hello");
  assert.equal(
    listing.getBoundSessionSubtitle(session),
    "2026-04-18T00:00:00.000Z",
  );
  assert.equal(
    listing.getBoundSessionSubtitle({
      ...session,
      subtitle: "Custom subtitle",
      isActive: false,
      title: "Hello",
    }),
    "2026-04-18T00:00:00.000Z",
  );
  assert.equal(
    listing.isActiveBoundSession(session, " /tmp/session-1.jsonl "),
    true,
  );
});

test("session listing normalization trims legacy values and preserves normalized items", () => {
  const normalized = listing.normalizeBoundSessionListItem({
    id: " session-1 ",
    path: " /tmp/session-1.jsonl ",
    firstMessage: " Hello ",
    modified: "2026-04-18T00:00:00.000Z",
  });

  assert.deepEqual(normalized, {
    id: "session-1",
    path: "/tmp/session-1.jsonl",
    name: undefined,
    firstMessage: "Hello",
    modified: new Date("2026-04-18T00:00:00.000Z"),
    messageCount: 0,
    cwd: undefined,
    allMessagesText: "Hello",
  });
  assert.equal(listing.normalizeBoundSessionListItem(normalized), normalized);
  const legacyNormalized = listing.normalizeBoundSessionListItem({
    id: " legacy-session ",
  });
  assert.deepEqual(
    {
      id: legacyNormalized?.id,
      path: legacyNormalized?.path,
      name: legacyNormalized?.name,
      firstMessage: legacyNormalized?.firstMessage,
      messageCount: legacyNormalized?.messageCount,
      cwd: legacyNormalized?.cwd,
      allMessagesText: legacyNormalized?.allMessagesText,
      modifiedIsDate: legacyNormalized?.modified instanceof Date,
    },
    {
      id: "legacy-session",
      path: "legacy-session",
      name: undefined,
      firstMessage: "legacy-session",
      messageCount: 0,
      cwd: undefined,
      allMessagesText: "legacy-session",
      modifiedIsDate: true,
    },
  );
  assert.deepEqual(
    listing
      .normalizeBoundSessionList([
        normalized,
        {
          id: "session-1-copy",
          path: " /tmp/session-1.jsonl ",
          firstMessage: "Other",
          modified: "2026-04-19T00:00:00.000Z",
        },
      ])
      .map((item) => item.id),
    ["session-1"],
  );
});
