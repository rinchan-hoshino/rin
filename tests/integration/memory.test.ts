import "../support/require-test-sandbox.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const transcripts = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "memory", "transcripts.js"))
    .href
);
const transcriptArchiveModule = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "memory", "transcript-archive.js"),
  ).href
);
const memoryExtensionModule = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "memory", "index.js")).href
);
const recallPresentation = await import(
  pathToFileURL(
    path.join(
      rootDir,
      "dist",
      "core",
      "rin-tui",
      "tool-renderers",
      "recall.js",
    ),
  ).href
);
const transcriptSchemaMigration = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "memory", "install-migration.js"),
  ).href
);
const BetterSqlite3 = (await import("better-sqlite3")).default;

async function withTempRoot(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-memory-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function snapshotFiles(filePaths) {
  return Promise.all(
    filePaths.map(async (filePath) => {
      try {
        return { filePath, bytes: await fs.readFile(filePath) };
      } catch (error) {
        if (error?.code === "ENOENT") return { filePath, bytes: null };
        throw error;
      }
    }),
  );
}

async function writeSessionFile(root, name, entries) {
  const filePath = path.join(root, "sessions", name);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
  return filePath;
}

async function withJsonlDaemonSocket(handler, fn) {
  const runtimeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-memory-daemon-"),
  );
  const socketPath = path.join(runtimeDir, "rin-daemon", "daemon.sock");
  const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const payload = JSON.parse(line);
        Promise.resolve(handler(payload)).then((data) => {
          socket.write(
            `${JSON.stringify({
              type: "response",
              id: payload.id,
              command: payload.type,
              success: true,
              data,
            })}\n`,
          );
        });
      }
    });
  });
  await fs.mkdir(path.dirname(socketPath), { recursive: true });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  try {
    await fn(socketPath);
  } finally {
    if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
    await new Promise((resolve) => server.close(() => resolve()));
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
}

test("memory transcripts archive entries under memory/transcripts", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-04T11:11:11.000Z",
        sessionId: "session-1",
        sessionFile: "/tmp/session-1.jsonl",
        role: "user",
        content: [
          { type: "text", text: "Does Rin keep raw conversation transcripts?" },
        ],
      },
      root,
    );

    const sessionPath = transcripts.getTranscriptArchivePath(
      {
        timestamp: "2026-04-04T11:11:11.000Z",
        sessionId: "session-1",
      },
      root,
    );
    assert.match(
      sessionPath,
      /memory[\\/]transcripts[\\/]2026[\\/]04[\\/]session-1\.jsonl$/,
    );
  });
});

test("transcript archive iteration streams JSONL with stable physical line numbers", async () => {
  await withTempRoot(async (root) => {
    const archivePath = path.join(root, "archive.jsonl");
    await fs.writeFile(
      archivePath,
      [
        JSON.stringify({ sessionId: "one", role: "user", text: "first" }),
        "not-json",
        "",
        JSON.stringify({ sessionId: "two", role: "assistant", text: "last" }),
        "",
      ].join("\n"),
    );
    const entries = [];
    for await (const entry of transcriptArchiveModule.iterateTranscriptArchiveFile(
      archivePath,
    )) {
      entries.push(entry);
    }
    assert.deepEqual(
      entries.map((entry) => ({ text: entry.text, line: entry.archiveLine })),
      [
        { text: "first", line: 1 },
        { text: "last", line: 4 },
      ],
    );
  });
});

test("recall returns session-level archived transcript matches and creates persistent index", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-04T11:11:11.000Z",
        sessionId: "session-1",
        sessionFile: "/tmp/session-1.jsonl",
        role: "user",
        content: [
          { type: "text", text: "Does Rin keep raw conversation transcripts?" },
        ],
      },
      root,
    );

    const results = await transcripts.searchTranscriptArchive(
      "raw conversation transcripts",
      { limit: 8 },
      root,
    );
    assert.ok(Array.isArray(results));
    assert.equal(results[0].sourceType, "session");
    assert.equal(results[0].sessionId, "session-1");
    assert.match(results[0].path, /2026[\\/]04[\\/]session-1\.jsonl$/);
    assert.match(results[0].preview, /raw conversation transcripts/);
    assert.equal(results[0].hitCount, 1);

    const searchDbPath = path.join(root, "memory", "search.db");
    await assert.doesNotReject(() => fs.access(searchDbPath));
  });
});

test("transcript search uses external-content FTS without canonical entry JSON", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-04T11:11:11.000Z",
        sessionId: "session-schema-v6",
        sessionFile: "/tmp/session-schema-v6.jsonl",
        role: "assistant",
        content: [{ type: "text", text: "external content schema marker" }],
        provider: "provider-kept-in-archive",
      },
      root,
    );

    transcripts.flushTranscriptSearchIndexWrites(root);
    assert.deepEqual(
      JSON.parse(
        await fs.readFile(
          path.join(root, "memory", "search.db.schema.json"),
          "utf8",
        ),
      ),
      { schemaVersion: 6, state: "current" },
    );
    const db = new BetterSqlite3(path.join(root, "memory", "search.db"), {
      readonly: true,
    });
    try {
      const columns = db
        .prepare("PRAGMA table_info('entries')")
        .all()
        .map((row) => row.name);
      assert.equal(columns.includes("entry_json"), false);
      const virtualTables = db
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE name IN ('entries_fts_token', 'entries_fts_trigram') ORDER BY name",
        )
        .all();
      assert.equal(virtualTables.length, 2);
      assert.ok(
        virtualTables.every((row) => /content\s*=\s*'entries'/i.test(row.sql)),
      );
      const shadowContentTables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('entries_fts_token_content', 'entries_fts_trigram_content')",
        )
        .all();
      assert.deepEqual(shadowContentTables, []);
      assert.equal(
        db
          .prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
          .get().value,
        "6",
      );
    } finally {
      db.close();
    }

    const loaded = await transcripts.loadTranscriptSessionEntries(
      { sessionId: "session-schema-v6" },
      root,
    );
    assert.equal(loaded[0].provider, "provider-kept-in-archive");
    assert.equal(loaded[0].content, undefined);
  });
});

test("transcript search rebuilds canonical archives when search.db is missing", async () => {
  await withTempRoot(async (root) => {
    const entry = {
      id: "missing-db-1",
      timestamp: "2026-04-04T11:11:11.000Z",
      sessionId: "session-missing-db",
      sessionFile: "/tmp/session-missing-db.jsonl",
      role: "assistant",
      text: "missing database canonical recovery marker",
    };
    const archivePath = transcripts.getTranscriptArchivePath(entry, root);
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    await fs.writeFile(archivePath, `${JSON.stringify(entry)}\n`);
    assert.equal(
      fsSync.existsSync(path.join(root, "memory", "search.db")),
      false,
    );

    const results = await transcripts.searchTranscriptArchive(
      "missing database canonical recovery marker",
      { limit: 8 },
      root,
    );
    assert.equal(results[0].sessionId, entry.sessionId);
  });
});

test("installer replaces a schema-v4 transcript index from canonical archives", async () => {
  await withTempRoot(async (root) => {
    const canonical = {
      id: "canonical-v5-rebuild",
      timestamp: "2026-04-04T11:11:11.000Z",
      sessionId: "session-schema-rebuild",
      sessionFile: "/tmp/session-schema-rebuild.jsonl",
      role: "assistant",
      text: "schema rebuild fidelity marker",
    };
    const archivePath = transcripts.getTranscriptArchivePath(canonical, root);
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    await fs.writeFile(archivePath, `${JSON.stringify(canonical)}\n`);

    const dbPath = path.join(root, "memory", "search.db");
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const oldDb = new BetterSqlite3(dbPath);
    oldDb.pragma("journal_mode = WAL");
    oldDb.pragma("wal_autocheckpoint = 0");
    oldDb.exec(`
      CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata(key, value) VALUES ('schema_version', '4');
      CREATE TABLE file_state(
        archive_path TEXT PRIMARY KEY,
        mtime_ms INTEGER NOT NULL,
        size INTEGER NOT NULL
      );
      CREATE TABLE entries(
        row_key TEXT PRIMARY KEY,
        archive_path TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        session_file TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        line_number INTEGER NOT NULL,
        role TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        custom_type TEXT NOT NULL,
        text TEXT NOT NULL,
        preview TEXT NOT NULL,
        entry_json TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE entries_fts_token USING fts5(
        row_key UNINDEXED, session_id, role, tool_name, custom_type, text
      );
      CREATE VIRTUAL TABLE entries_fts_trigram USING fts5(
        row_key UNINDEXED, session_id, role, tool_name, custom_type, text,
        tokenize = 'trigram'
      );
    `);
    const ghost = JSON.stringify({
      ...canonical,
      id: "schema-v4-ghost",
      text: "stale schema v4 ghost marker",
    });
    oldDb
      .prepare(
        `INSERT INTO entries VALUES(
          'ghost-row', 'ghost-archive', 'schema-v4-ghost', 'ghost-session',
          'ghost-session', '/tmp/ghost.jsonl', '2026-04-01T00:00:00.000Z',
          1, 1, 'assistant', '', '', 'stale schema v4 ghost marker',
          'stale schema v4 ghost marker', ?
        )`,
      )
      .run(ghost);
    oldDb
      .prepare("INSERT INTO entries_fts_token VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        "ghost-row",
        "ghost-session",
        "assistant",
        "",
        "",
        "stale schema v4 ghost marker",
      );
    oldDb
      .prepare("INSERT INTO entries_fts_trigram VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        "ghost-row",
        "ghost-session",
        "assistant",
        "",
        "",
        "stale schema v4 ghost marker",
      );
    const protectedPaths = [
      dbPath,
      `${dbPath}-wal`,
      `${dbPath}-shm`,
      `${dbPath}.schema.json`,
    ];
    const filesBeforeRuntimeOpen = await snapshotFiles(protectedPaths);
    assert.ok(filesBeforeRuntimeOpen[0].bytes);
    assert.ok(filesBeforeRuntimeOpen[1].bytes);
    assert.ok(filesBeforeRuntimeOpen[2].bytes);
    assert.equal(filesBeforeRuntimeOpen[3].bytes, null);

    await assert.rejects(
      transcripts.searchTranscriptArchive(
        "schema rebuild fidelity marker",
        { limit: 8 },
        root,
      ),
      /transcript_search_install_migration_required/,
    );
    assert.deepEqual(
      await snapshotFiles(protectedPaths),
      filesBeforeRuntimeOpen,
    );
    const preflight =
      transcriptSchemaMigration.preflightTranscriptSearchMigration(root);
    assert.equal(preflight.action, "rebuild");
    assert.equal(preflight.currentVersion, null);
    assert.equal(preflight.reason, "unmarked");
    assert.deepEqual(
      await snapshotFiles(protectedPaths),
      filesBeforeRuntimeOpen,
    );
    const prepared =
      await transcriptSchemaMigration.prepareTranscriptSearchMigrationForMigration(
        root,
      );
    assert.equal(prepared.prepared, true);
    assert.equal(fsSync.existsSync(prepared.stagingDbPath), true);
    assert.deepEqual(
      await snapshotFiles(protectedPaths),
      filesBeforeRuntimeOpen,
    );
    await fs.appendFile(
      archivePath,
      `${JSON.stringify({
        ...canonical,
        id: "canonical-after-preflight",
        text: "canonical entry appended after migration preparation",
      })}\n`,
    );
    const stillOldDb = new BetterSqlite3(dbPath, { readonly: true });
    try {
      assert.equal(
        stillOldDb
          .prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
          .get().value,
        "4",
      );
    } finally {
      stillOldDb.close();
      oldDb.close();
    }

    let publishGuardObserved = false;
    const migration =
      await transcriptSchemaMigration.migrateTranscriptSearchIndexForMigration(
        root,
        {
          runtimeQuiesced: true,
          onPublishGuard() {
            publishGuardObserved = true;
            assert.equal(fsSync.statSync(dbPath).isDirectory(), true);
            assert.throws(() => new BetterSqlite3(dbPath));
          },
        },
      );
    assert.equal(publishGuardObserved, true);
    assert.equal(migration.action, "rebuilt");
    assert.equal(
      transcriptSchemaMigration.finalizeTranscriptSearchMigrationForMigration(
        root,
      ).skipped,
      false,
    );

    const results = await transcripts.searchTranscriptArchive(
      "schema rebuild fidelity marker",
      { limit: 8 },
      root,
    );
    assert.equal(results[0].sessionId, canonical.sessionId);
    assert.equal(
      (
        await transcripts.searchTranscriptArchive(
          "canonical entry appended after migration preparation",
          { limit: 8 },
          root,
        )
      )[0].sessionId,
      canonical.sessionId,
    );
    assert.deepEqual(
      await transcripts.searchTranscriptArchive(
        "stale schema v4 ghost marker",
        { limit: 8, fidelity: "exact" },
        root,
      ),
      [],
    );
    const rebuiltDb = new BetterSqlite3(dbPath, { readonly: true });
    try {
      assert.equal(
        rebuiltDb
          .prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
          .get().value,
        "6",
      );
      assert.deepEqual(
        rebuiltDb
          .prepare(
            "SELECT name FROM sqlite_master WHERE name IN ('entries_fts_token_content', 'entries_fts_trigram_content')",
          )
          .all(),
        [],
      );
    } finally {
      rebuiltDb.close();
    }
  });
});

test("installer memory-v6 migration sanitizes transcripts without reading managed sessions", async () => {
  await withTempRoot(async (root) => {
    const managedSession = await writeSessionFile(root, "managed.jsonl", [
      { type: "session", id: "managed-session" },
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "image", data: "managed-base64" }],
        },
      },
    ]);
    const managedBefore = await fs.readFile(managedSession);
    const archivePath = path.join(
      root,
      "memory",
      "transcripts",
      "2026",
      "08",
      "managed-session.jsonl",
    );
    const legacyArchive = `${JSON.stringify({
      id: "image-entry",
      timestamp: "2026-08-11T02:00:00.000Z",
      sessionId: "managed-session",
      sessionFile: managedSession,
      role: "toolResult",
      text: "read image [image:image/png]",
      content: [
        {
          type: "image",
          data: "transcript-base64",
          mimeType: "image/png",
          width: 800,
          height: 600,
        },
      ],
    })}\n`;
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    await fs.writeFile(archivePath, legacyArchive);
    const dbPath = path.join(root, "memory", "search.db");
    const legacyDb = new BetterSqlite3(dbPath);
    legacyDb.exec(`
      CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata(key, value) VALUES ('schema_version', '5');
    `);
    legacyDb.close();
    await fs.writeFile(
      `${dbPath}.schema.json`,
      `${JSON.stringify({ schemaVersion: 5, state: "current" })}\n`,
    );

    const prepared =
      await transcriptSchemaMigration.prepareTranscriptSearchMigrationForMigration(
        root,
      );
    assert.equal("transcriptManifest" in prepared, false);
    assert.ok(JSON.stringify(prepared).length < 16_384);
    const stagedArchive = path.join(
      prepared.stagingTranscriptRoot,
      "2026",
      "08",
      "managed-session.jsonl",
    );
    assert.doesNotMatch(await fs.readFile(stagedArchive, "utf8"), /base64/);
    assert.equal(await fs.readFile(archivePath, "utf8"), legacyArchive);
    assert.deepEqual(await fs.readFile(managedSession), managedBefore);
    await assert.rejects(
      () =>
        transcriptSchemaMigration.migrateTranscriptSearchIndexForMigration(
          root,
        ),
      /memory_install_migration_runtime_not_quiesced/,
    );
    assert.equal(await fs.readFile(archivePath, "utf8"), legacyArchive);
    await assert.rejects(
      () =>
        transcriptSchemaMigration.migrateTranscriptSearchIndexForMigration(
          root,
          {
            runtimeQuiesced: true,
            afterTranscriptPublish() {
              throw new Error("interrupt_after_transcript_publish");
            },
          },
        ),
      /interrupt_after_transcript_publish/,
    );
    assert.equal(await fs.readFile(archivePath, "utf8"), legacyArchive);
    assert.deepEqual(await fs.readFile(managedSession), managedBefore);
    const restoredDb = new BetterSqlite3(dbPath, { readonly: true });
    try {
      assert.equal(
        restoredDb
          .prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
          .get().value,
        "5",
      );
    } finally {
      restoredDb.close();
    }
    await transcriptSchemaMigration.prepareTranscriptSearchMigrationForMigration(
      root,
    );

    await transcriptSchemaMigration.migrateTranscriptSearchIndexForMigration(
      root,
      { runtimeQuiesced: true },
    );
    assert.doesNotMatch(await fs.readFile(archivePath, "utf8"), /base64/);
    assert.deepEqual(await fs.readFile(managedSession), managedBefore);

    const rolledBack =
      transcriptSchemaMigration.rollbackTranscriptSearchMigrationForMigration(
        root,
      );
    assert.equal(rolledBack.skipped, false);
    assert.equal(await fs.readFile(archivePath, "utf8"), legacyArchive);
    assert.equal(
      fsSync.existsSync(
        path.join(root, "memory", "transcripts", ".sanitization-manifest.json"),
      ),
      false,
    );
    assert.deepEqual(await fs.readFile(managedSession), managedBefore);

    await transcriptSchemaMigration.prepareTranscriptSearchMigrationForMigration(
      root,
    );
    await transcriptSchemaMigration.migrateTranscriptSearchIndexForMigration(
      root,
      { runtimeQuiesced: true },
    );
    assert.equal(
      transcriptSchemaMigration.finalizeTranscriptSearchMigrationForMigration(
        root,
      ).cleanupPending,
      false,
    );
    assert.doesNotMatch(await fs.readFile(archivePath, "utf8"), /base64/);
    assert.equal(
      fsSync.existsSync(
        `${path.join(root, "memory", "transcripts")}.migration-backup-v6`,
      ),
      false,
    );
    assert.equal(fsSync.existsSync(`${dbPath}.migration-backup-v6`), false);
    const migrationReport = JSON.parse(
      await fs.readFile(
        path.join(root, "memory", "transcript-migration-v6.json"),
        "utf8",
      ),
    );
    assert.equal(migrationReport.summary.unknownCorruptLines, 0);
    assert.deepEqual(await fs.readFile(managedSession), managedBefore);
  });
});

test("installer publish failure restores the live transcript index", async () => {
  await withTempRoot(async (root) => {
    const dbPath = path.join(root, "memory", "search.db");
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const liveDb = new BetterSqlite3(dbPath);
    liveDb.exec(`
      CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata(key, value) VALUES ('schema_version', '4');
    `);
    liveDb.close();
    const liveBytes = await fs.readFile(dbPath);
    const failures = [
      {
        label: "before-first-backup-move",
        options: {
          beforeBackupMove(_livePath: string, index: number) {
            if (index === 0) throw new Error("test_before_backup_abort");
          },
        },
      },
      {
        label: "after-first-backup-move",
        options: {
          afterBackupMove(_livePath: string, index: number) {
            if (index === 0) throw new Error("test_after_backup_abort");
          },
        },
      },
      {
        label: "after-publish-guard",
        options: {
          onPublishGuard() {
            assert.equal(fsSync.statSync(dbPath).isDirectory(), true);
            throw new Error("test_publish_abort");
          },
        },
      },
    ];
    for (const failure of failures) {
      const prepared =
        await transcriptSchemaMigration.prepareTranscriptSearchMigrationForMigration(
          root,
        );
      assert.equal(prepared.prepared, true, failure.label);
      await assert.rejects(
        transcriptSchemaMigration.migrateTranscriptSearchIndexForMigration(
          root,
          { runtimeQuiesced: true, ...failure.options },
        ),
        /test_(before_backup|after_backup|publish)_abort/,
        failure.label,
      );
      assert.equal(fsSync.statSync(dbPath).isFile(), true, failure.label);
      assert.deepEqual(await fs.readFile(dbPath), liveBytes, failure.label);
      assert.equal(
        fsSync.existsSync(`${dbPath}.schema.json`),
        false,
        failure.label,
      );
      assert.equal(
        fsSync.existsSync(prepared.stagingDbPath),
        true,
        failure.label,
      );
    }
  });
});

test("installer completes recovery after interruption following publish", async () => {
  await withTempRoot(async (root) => {
    const dbPath = path.join(root, "memory", "search.db");
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const liveDb = new BetterSqlite3(dbPath);
    liveDb.exec(`
      CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata(key, value) VALUES ('schema_version', '4');
    `);
    liveDb.close();
    await transcriptSchemaMigration.prepareTranscriptSearchMigrationForMigration(
      root,
    );

    const result =
      await transcriptSchemaMigration.migrateTranscriptSearchIndexForMigration(
        root,
        {
          runtimeQuiesced: true,
          afterPublish() {
            throw new Error("simulated-post-publish-interruption");
          },
        },
      );
    assert.equal(result.action, "rebuilt");
    assert.equal(fsSync.existsSync(`${dbPath}.migration-backup-v6`), true);
    assert.deepEqual(
      JSON.parse(await fs.readFile(`${dbPath}.schema.json`, "utf8")),
      { schemaVersion: 6, state: "installer-migrating" },
    );
    const finalized =
      transcriptSchemaMigration.finalizeTranscriptSearchMigrationForMigration(
        root,
      );
    assert.equal(finalized.skipped, false);
    assert.equal(finalized.cleanupPending, false);
    assert.equal(fsSync.existsSync(`${dbPath}.migration-backup-v6`), false);
    assert.deepEqual(
      JSON.parse(await fs.readFile(`${dbPath}.schema.json`, "utf8")),
      { schemaVersion: 6, state: "current" },
    );
  });
});

test("installer rollback restores legacy bytes before restarting the old runtime", async () => {
  await withTempRoot(async (root) => {
    const dbPath = path.join(root, "memory", "search.db");
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const liveDb = new BetterSqlite3(dbPath);
    liveDb.exec(`
      CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata(key, value) VALUES ('schema_version', '4');
    `);
    liveDb.close();
    const legacyBytes = await fs.readFile(dbPath);
    await transcriptSchemaMigration.prepareTranscriptSearchMigrationForMigration(
      root,
    );
    await transcriptSchemaMigration.migrateTranscriptSearchIndexForMigration(
      root,
      { runtimeQuiesced: true },
    );

    const rolledBack =
      transcriptSchemaMigration.rollbackTranscriptSearchMigrationForMigration(
        root,
      );
    assert.equal(rolledBack.skipped, false);
    assert.deepEqual(await fs.readFile(dbPath), legacyBytes);
    assert.equal(fsSync.existsSync(`${dbPath}.schema.json`), false);
    assert.equal(fsSync.existsSync(`${dbPath}.migration-backup-v6`), false);
  });
});

test("installer rollback removes a pre-backup marker before old-runtime restart", async () => {
  await withTempRoot(async (root) => {
    const dbPath = path.join(root, "memory", "search.db");
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const liveDb = new BetterSqlite3(dbPath);
    liveDb.exec(`
      CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata(key, value) VALUES ('schema_version', '4');
    `);
    liveDb.close();
    const legacyBytes = await fs.readFile(dbPath);
    await fs.writeFile(
      `${dbPath}.schema.json`,
      `${JSON.stringify({ schemaVersion: 6, state: "installer-migrating" })}\n`,
    );

    const result =
      transcriptSchemaMigration.rollbackTranscriptSearchMigrationForMigration(
        root,
      );
    assert.equal(result.skipped, true);
    assert.deepEqual(await fs.readFile(dbPath), legacyBytes);
    assert.equal(fsSync.existsSync(`${dbPath}.schema.json`), false);
  });
});

test("installer preserves backup payloads when the backup manifest is invalid", async () => {
  await withTempRoot(async (root) => {
    const dbPath = path.join(root, "memory", "search.db");
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const liveDb = new BetterSqlite3(dbPath);
    liveDb.exec(`
      CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata(key, value) VALUES ('schema_version', '4');
    `);
    liveDb.close();
    await transcriptSchemaMigration.prepareTranscriptSearchMigrationForMigration(
      root,
    );

    const backupDir = `${dbPath}.migration-backup-v6`;
    const backupDbPath = path.join(backupDir, "search.db");
    await fs.mkdir(backupDir, { recursive: true });
    await fs.rename(dbPath, backupDbPath);
    const backupBytes = await fs.readFile(backupDbPath);
    await fs.writeFile(
      path.join(backupDir, "manifest.json"),
      `${JSON.stringify({ version: 1, files: [] })}\n`,
    );

    await assert.rejects(
      transcriptSchemaMigration.migrateTranscriptSearchIndexForMigration(root, {
        runtimeQuiesced: true,
      }),
      /transcript_search_install_backup_manifest_invalid/,
    );
    assert.deepEqual(await fs.readFile(backupDbPath), backupBytes);
    assert.equal(fsSync.existsSync(dbPath), false);
  });
});

test("installer preserves a guard when a declared backup payload is missing", async () => {
  await withTempRoot(async (root) => {
    const dbPath = path.join(root, "memory", "search.db");
    const backupDir = `${dbPath}.migration-backup-v6`;
    await fs.mkdir(backupDir, { recursive: true });
    await fs.mkdir(dbPath);
    const manifestPath = path.join(backupDir, "manifest.json");
    const manifest = {
      version: 1,
      phase: "guarded",
      files: [
        { livePath: dbPath, existed: true },
        { livePath: `${dbPath}-wal`, existed: false },
        { livePath: `${dbPath}-shm`, existed: false },
      ],
    };
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

    await assert.rejects(
      transcriptSchemaMigration.migrateTranscriptSearchIndexForMigration(root, {
        runtimeQuiesced: true,
      }),
      /transcript_search_install_backup_manifest_invalid/,
    );
    assert.equal(fsSync.statSync(dbPath).isDirectory(), true);
    assert.deepEqual(
      JSON.parse(await fs.readFile(manifestPath, "utf8")),
      manifest,
    );
  });
});

test("installer rejects a symlinked staging database before live mutation", async (t) => {
  if (process.platform === "win32")
    t.skip("symlink creation requires privileges");
  await withTempRoot(async (root) => {
    const dbPath = path.join(root, "memory", "search.db");
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const liveDb = new BetterSqlite3(dbPath);
    liveDb.exec(`
      CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata(key, value) VALUES ('schema_version', '4');
    `);
    liveDb.close();
    const legacyBytes = await fs.readFile(dbPath);
    const prepared =
      await transcriptSchemaMigration.prepareTranscriptSearchMigrationForMigration(
        root,
      );
    const sentinelPath = path.join(root, "sentinel.db");
    await fs.rename(prepared.stagingDbPath, sentinelPath);
    await fs.symlink(sentinelPath, prepared.stagingDbPath);

    await assert.rejects(
      transcriptSchemaMigration.migrateTranscriptSearchIndexForMigration(root),
      /transcript_search_install_staging_path_invalid/,
    );
    assert.deepEqual(await fs.readFile(dbPath), legacyBytes);
    assert.equal(fsSync.existsSync(`${dbPath}.schema.json`), false);
    assert.equal(
      (await fs.lstat(prepared.stagingDbPath)).isSymbolicLink(),
      true,
    );
  });
});

test("installer rejects symlink backup payloads before finalization", async (t) => {
  if (process.platform === "win32")
    t.skip("symlink creation requires privileges");
  await withTempRoot(async (root) => {
    const dbPath = path.join(root, "memory", "search.db");
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const liveDb = new BetterSqlite3(dbPath);
    liveDb.exec(`
      CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata(key, value) VALUES ('schema_version', '4');
    `);
    liveDb.close();
    await transcriptSchemaMigration.prepareTranscriptSearchMigrationForMigration(
      root,
    );
    await transcriptSchemaMigration.migrateTranscriptSearchIndexForMigration(
      root,
      { runtimeQuiesced: true },
    );
    const backupPath = path.join(`${dbPath}.migration-backup-v6`, "search.db");
    const sentinelPath = path.join(root, "sentinel.db");
    await fs.writeFile(sentinelPath, "sentinel");
    await fs.rm(backupPath);
    await fs.symlink(sentinelPath, backupPath);

    assert.throws(
      () =>
        transcriptSchemaMigration.finalizeTranscriptSearchMigrationForMigration(
          root,
        ),
      /transcript_search_install_backup_manifest_invalid/,
    );
    assert.equal((await fs.lstat(backupPath)).isSymbolicLink(), true);
    assert.equal(await fs.readFile(sentinelPath, "utf8"), "sentinel");
  });
});

test("installer completes rollback after payload restore but before marker cleanup", async () => {
  await withTempRoot(async (root) => {
    const dbPath = path.join(root, "memory", "search.db");
    const backupDir = `${dbPath}.migration-backup-v6`;
    await fs.mkdir(backupDir, { recursive: true });
    const liveDb = new BetterSqlite3(dbPath);
    liveDb.exec(`
      CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata(key, value) VALUES ('schema_version', '4');
    `);
    liveDb.close();
    const manifest = {
      version: 1,
      phase: "published",
      files: [
        { livePath: dbPath, existed: true },
        { livePath: `${dbPath}-wal`, existed: false },
        { livePath: `${dbPath}-shm`, existed: false },
      ],
    };
    await fs.writeFile(
      path.join(backupDir, "manifest.json"),
      `${JSON.stringify(manifest)}\n`,
    );
    await fs.writeFile(
      `${dbPath}.schema.json`,
      `${JSON.stringify({ schemaVersion: 6, state: "current" })}\n`,
    );

    const result =
      transcriptSchemaMigration.rollbackTranscriptSearchMigrationForMigration(
        root,
      );
    assert.equal(result.skipped, false);
    assert.equal(fsSync.existsSync(`${dbPath}.schema.json`), false);
    assert.equal(fsSync.existsSync(backupDir), false);
  });
});

test("installer cleans an interrupted manifest temp before retry", async () => {
  await withTempRoot(async (root) => {
    const dbPath = path.join(root, "memory", "search.db");
    const backupDir = `${dbPath}.migration-backup-v6`;
    await fs.mkdir(backupDir, { recursive: true });
    await fs.writeFile(
      path.join(backupDir, "manifest.json.123.tmp"),
      "partial",
    );

    const result =
      await transcriptSchemaMigration.migrateTranscriptSearchIndexForMigration(
        root,
        { runtimeQuiesced: true },
      );
    assert.equal(result.action, "none");
    assert.equal(fsSync.existsSync(backupDir), false);
  });
});

test("installer cleans partial backup deletion after durable current marker", async () => {
  await withTempRoot(async (root) => {
    const dbPath = path.join(root, "memory", "search.db");
    await transcripts.searchTranscriptArchive("initialize", {}, root);
    const backupDir = `${dbPath}.migration-backup-v6`;
    await fs.mkdir(backupDir, { recursive: true });
    await fs.writeFile(path.join(backupDir, "orphaned-payload"), "old");

    await transcriptSchemaMigration.migrateTranscriptSearchIndexForMigration(
      root,
      { runtimeQuiesced: true },
    );
    assert.equal(fsSync.existsSync(backupDir), false);
    assert.deepEqual(
      JSON.parse(await fs.readFile(`${dbPath}.schema.json`, "utf8")),
      { schemaVersion: 6, state: "current" },
    );
  });
});

test("installer preflight reuses and catches up a completed staging index", async () => {
  await withTempRoot(async (root) => {
    const dbPath = path.join(root, "memory", "search.db");
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const legacyDb = new BetterSqlite3(dbPath);
    legacyDb.exec(`
      CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata(key, value) VALUES ('schema_version', '4');
    `);
    legacyDb.close();
    const first =
      await transcriptSchemaMigration.prepareTranscriptSearchMigrationForMigration(
        root,
      );
    const firstInode = (await fs.stat(first.stagingDbPath)).ino;

    const second =
      await transcriptSchemaMigration.prepareTranscriptSearchMigrationForMigration(
        root,
      );
    assert.equal(second.reused, true);
    assert.equal((await fs.stat(second.stagingDbPath)).ino, firstInode);
  });
});

test("installer treats a migration marker without a live index as incomplete", async () => {
  await withTempRoot(async (root) => {
    const dbPath = path.join(root, "memory", "search.db");
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    await fs.writeFile(
      `${dbPath}.schema.json`,
      `${JSON.stringify({
        schemaVersion: 6,
        state: "installer-migrating",
      })}\n`,
    );
    assert.deepEqual(
      transcriptSchemaMigration.preflightTranscriptSearchMigration(root),
      {
        id: "transcript-search-schema-v6",
        skipped: false,
        action: "rebuild",
        currentVersion: 6,
        targetVersion: 6,
        reason: "incomplete",
      },
    );
  });
});

test("installer retries an interrupted schema-v6 transcript rebuild", async () => {
  await withTempRoot(async (root) => {
    const dbPath = path.join(root, "memory", "search.db");
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const interruptedDb = new BetterSqlite3(dbPath);
    interruptedDb.exec(`
      CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata(key, value) VALUES ('schema_version', '6');
      INSERT INTO metadata(key, value) VALUES ('rebuild_required', '1');
    `);
    interruptedDb.close();
    await fs.writeFile(
      `${dbPath}.schema.json`,
      `${JSON.stringify({
        schemaVersion: 6,
        state: "installer-migrating",
      })}\n`,
    );

    const preflight =
      transcriptSchemaMigration.preflightTranscriptSearchMigration(root);
    assert.equal(preflight.skipped, false);
    assert.equal(preflight.reason, "incomplete");
    const result =
      await transcriptSchemaMigration.migrateTranscriptSearchIndexForMigration(
        root,
        { runtimeQuiesced: true },
      );
    assert.equal(result.action, "rebuilt");
    assert.equal(result.currentVersion, 6);
    transcriptSchemaMigration.finalizeTranscriptSearchMigrationForMigration(
      root,
    );
    assert.equal(
      transcriptSchemaMigration.preflightTranscriptSearchMigration(root).reason,
      "current",
    );
  });
});

test("runtime leaves a metadata-less legacy transcript index to the installer", async () => {
  await withTempRoot(async (root) => {
    const dbPath = path.join(root, "memory", "search.db");
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const legacyDb = new BetterSqlite3(dbPath);
    legacyDb.exec("CREATE TABLE legacy_entries(id TEXT PRIMARY KEY)");
    legacyDb.close();
    const beforeRuntimeOpen = await fs.readFile(dbPath);

    await assert.rejects(
      transcripts.searchTranscriptArchive("legacy", { limit: 8 }, root),
      /transcript_search_install_migration_required/,
    );
    assert.deepEqual(await fs.readFile(dbPath), beforeRuntimeOpen);
    const preflight =
      transcriptSchemaMigration.preflightTranscriptSearchMigration(root);
    assert.equal(preflight.currentVersion, null);
    assert.equal(preflight.reason, "unmarked");
  });
});

test("transcript archive recall survives deletion of its source session file", async () => {
  await withTempRoot(async (root) => {
    const sessionFile = await writeSessionFile(
      root,
      "disposable-session.jsonl",
      [{ type: "message", role: "user", content: "session-only source" }],
    );
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-04T11:11:10.000Z",
        sessionId: "session-archive-independent",
        sessionFile,
        role: "assistant",
        content: [
          {
            type: "text",
            text: "archive remains canonical after session cleanup",
          },
        ],
      },
      root,
    );
    await fs.rm(sessionFile);

    const results = await transcripts.searchTranscriptArchive(
      "archive remains canonical",
      { limit: 8 },
      root,
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].sessionId, "session-archive-independent");
  });
});

test("transcript full-session loading reports a missing canonical archive", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-04T11:11:11.000Z",
        sessionId: "session-missing-archive",
        sessionFile: "/tmp/session-missing-archive.jsonl",
        role: "assistant",
        content: [{ type: "text", text: "missing archive marker" }],
      },
      root,
    );
    const archivePath = transcripts.getTranscriptArchivePath(
      {
        timestamp: "2026-04-04T11:11:11.000Z",
        sessionId: "session-missing-archive",
      },
      root,
    );
    await fs.rm(archivePath);
    await assert.rejects(
      transcripts.loadTranscriptSessionEntries(
        { sessionId: "session-missing-archive", path: archivePath },
        root,
      ),
      /transcript_archive_missing/,
    );
  });
});

test("recall does not match session file paths", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-04T11:11:11.000Z",
        sessionId: "chat-session-opaque-id",
        sessionFile:
          "/home/rin/.rin/sessions/2026-05-13T06-14-31-561Z_019e1ff8-fb89-710d-931e-a3e01347c315.jsonl",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Discussed the public mirror sync repair and validation plan.",
          },
        ],
      },
      root,
    );

    const byContent = await transcripts.searchTranscriptArchive(
      "public mirror sync repair",
      { limit: 8 },
      root,
    );
    assert.equal(byContent.length, 1);
    assert.equal(byContent[0].sessionId, "chat-session-opaque-id");

    const bySessionFile = await transcripts.searchTranscriptArchive(
      "019e1ff8-fb89-710d-931e-a3e01347c315",
      { limit: 8 },
      root,
    );
    assert.deepEqual(bySessionFile, []);
  });
});

test("recall index stays in sync when an archived session file grows", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-04T11:11:11.000Z",
        sessionId: "session-sync",
        sessionFile: "/tmp/session-sync.jsonl",
        role: "assistant",
        content: [{ type: "text", text: "first alpha result" }],
      },
      root,
    );

    const first = await transcripts.searchTranscriptArchive(
      "alpha",
      { limit: 8 },
      root,
    );
    assert.equal(first.length, 1);
    assert.equal(first[0].hitCount, 1);

    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-04T11:11:12.000Z",
        sessionId: "session-sync",
        sessionFile: "/tmp/session-sync.jsonl",
        role: "assistant",
        content: [{ type: "text", text: "second beta result" }],
      },
      root,
    );

    const second = await transcripts.searchTranscriptArchive(
      "beta",
      { limit: 8 },
      root,
    );
    assert.equal(second.length, 1);
    assert.equal(second[0].sessionId, "session-sync");
    assert.equal(second[0].hitCount, 1);
  });
});

test("recall indexes numeric millisecond timestamps for recent ordering", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-04T11:11:11.000Z",
        sessionId: "session-older-iso",
        sessionFile: "/tmp/session-older-iso.jsonl",
        role: "assistant",
        content: [{ type: "text", text: "older iso timestamp entry" }],
      },
      root,
    );

    const newerTimestamp = String(Date.UTC(2026, 4, 11, 7, 0, 0));
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: newerTimestamp,
        sessionId: "session-newer-ms",
        sessionFile: "/tmp/session-newer-ms.jsonl",
        role: "assistant",
        content: [{ type: "text", text: "newer numeric timestamp entry" }],
      },
      root,
    );

    const recent = await transcripts.loadRecentTranscriptSessions(
      { limit: 2 },
      root,
    );
    assert.equal(recent[0].sessionId, "session-newer-ms");
    assert.equal(recent[1].sessionId, "session-older-iso");
  });
});

test("memory transcripts preserve assistant tool calls and thinking for recall", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-04T11:11:11.000Z",
        sessionId: "session-2",
        sessionFile: "/tmp/session-2.jsonl",
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Need to inspect the repo before editing.",
          },
          {
            type: "toolCall",
            id: "call-1",
            name: "read",
            args: { path: "/tmp/demo.txt" },
          },
          { type: "text", text: "I checked the file and found the setting." },
        ],
      },
      root,
    );

    const byTool = await transcripts.searchTranscriptArchive(
      "read /tmp/demo.txt",
      { limit: 8 },
      root,
    );
    assert.equal(byTool[0].sessionId, "session-2");
    assert.match(byTool[0].preview, /tool:read/);
    assert.match(byTool[0].preview, /demo\.txt/);
    assert.ok(Array.isArray(byTool[0].messages));
    assert.match(byTool[0].messages[0].text, /demo\.txt/);
    assert.equal(byTool[0].messages[0].line, 1);

    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-04T11:12:11.000Z",
        sessionId: "session-2",
        sessionFile: "/tmp/session-2.jsonl",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Updated the same session with a follow-up note about retries.",
          },
        ],
      },
      root,
    );
    const followUp = await transcripts.searchTranscriptArchive(
      "follow-up note retries",
      { limit: 8 },
      root,
    );
    assert.equal(followUp[0].sessionId, "session-2");

    const entries = await transcripts.loadTranscriptSessionEntries(
      { sessionId: "session-2" },
      root,
    );
    assert.equal(entries.length, 2);
    assert.match(entries[0].text, /Need to inspect the repo/);
    assert.match(entries[0].text, /tool:read/);
    assert.match(entries[1].text, /follow-up note about retries/);
  });
});

test("session selectors load every monthly archive even when a path hint is present", async () => {
  await withTempRoot(async (root) => {
    const base = {
      sessionId: "session-spanning-months",
      sessionFile: "/tmp/session-spanning-months.jsonl",
      role: "assistant",
    };
    await transcripts.appendTranscriptArchiveEntry(
      {
        ...base,
        id: "month-april",
        timestamp: "2026-04-30T23:59:59.000Z",
        text: "april archive entry",
      },
      root,
    );
    await transcripts.appendTranscriptArchiveEntry(
      {
        ...base,
        id: "month-may",
        timestamp: "2026-05-01T00:00:01.000Z",
        text: "may archive entry",
      },
      root,
    );
    const aprilPath = transcripts.getTranscriptArchivePath(
      { ...base, timestamp: "2026-04-30T23:59:59.000Z" },
      root,
    );
    const entries = await transcripts.loadTranscriptSessionEntries(
      {
        sessionId: base.sessionId,
        sessionFile: base.sessionFile,
        path: aprilPath,
      },
      root,
    );
    assert.deepEqual(
      entries.map((entry) => entry.id),
      ["month-april", "month-may"],
    );
  });
});

test("memory can browse recent sessions without a query", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-04T11:11:11.000Z",
        sessionId: "session-1",
        sessionFile: "/tmp/session-1.jsonl",
        role: "assistant",
        content: [{ type: "text", text: "This is an older session." }],
      },
      root,
    );
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-05T12:22:22.000Z",
        sessionId: "session-2",
        sessionFile: "/tmp/session-2.jsonl",
        role: "user",
        content: [{ type: "text", text: "This is the latest session." }],
      },
      root,
    );
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-05T12:22:23.000Z",
        sessionId: "session-2",
        sessionFile: "/tmp/session-2.jsonl",
        role: "toolResult",
        toolName: "read",
        content: "tool output should not replace the session preview",
      },
      root,
    );
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-05T12:22:24.000Z",
        sessionId: "session-2",
        sessionFile: "/tmp/session-2.jsonl",
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "browser_click",
            args: { selector: "Next" },
          },
          {
            type: "text",
            text: "Stuck on the captcha page; next step is to receive the captcha.",
          },
        ],
      },
      root,
    );

    const results = await transcripts.loadRecentTranscriptSessions(
      { limit: 2 },
      root,
    );
    assert.ok(Array.isArray(results));
    assert.equal(results.length, 2);
    assert.equal(results[0].sourceType, "session");
    assert.equal(results[0].sessionId, "session-2");
    assert.match(results[0].preview, /browser_click/);
    assert.match(results[0].preview, /captcha/);
    assert.doesNotMatch(results[0].preview, /tool output should not replace/);
    assert.ok(Array.isArray(results[0].messages));
    assert.ok(results[0].messages.length >= 1);
    assert.ok(Number.isInteger(results[0].messages[0].line));
    assert.equal(results[1].sessionId, "session-1");
  });
});

test("presentSessionResult shares ranked preview and message ordering while keeping latest timestamp", () => {
  const result = transcriptArchiveModule.presentSessionResult(
    [
      {
        id: "assistant-tool",
        timestamp: "2026-04-05T12:22:24.000Z",
        sessionId: "session-2",
        sessionFile: "/tmp/session-2.jsonl",
        role: "assistant",
        text: '[tool:browser_click] {"selector":"Next"}\nStuck on the captcha page; next step is to receive the captcha.',
        toolName: "browser_click",
      },
      {
        id: "newer-tool-result",
        timestamp: "2026-04-05T12:22:25.000Z",
        sessionId: "session-2",
        sessionFile: "/tmp/session-2.jsonl",
        role: "toolResult",
        text: "tool output should not replace the session preview",
        toolName: "read",
      },
      {
        id: "older-user",
        timestamp: "2026-04-05T12:22:22.000Z",
        sessionId: "session-2",
        sessionFile: "/tmp/session-2.jsonl",
        role: "user",
        text: "This is the latest session.",
      },
    ],
    7,
  );

  assert.match(result.preview, /browser_click/);
  assert.equal(result.messages[0].id, "assistant-tool");
  assert.equal(result.messages[1].id, "newer-tool-result");
  assert.equal(result.timestamp, "2026-04-05T12:22:25.000Z");
});

test("recall merges multiple message hits from the same session", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-06T10:00:00.000Z",
        sessionId: "session-a",
        sessionFile: "/tmp/session-a.jsonl",
        role: "assistant",
        content: [
          { type: "text", text: "Debugged chat outbound send routing." },
        ],
      },
      root,
    );
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-06T10:01:00.000Z",
        sessionId: "session-a",
        sessionFile: "/tmp/session-a.jsonl",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Fixed chat reply context and outbound send retry.",
          },
        ],
      },
      root,
    );
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-06T11:00:00.000Z",
        sessionId: "session-b",
        sessionFile: "/tmp/session-b.jsonl",
        role: "assistant",
        content: [
          { type: "text", text: "Looked at unrelated Telegram bridge code." },
        ],
      },
      root,
    );

    const results = await transcripts.searchTranscriptArchive(
      "chat outbound send",
      { limit: 2 },
      root,
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].sessionId, "session-a");
    assert.equal(results[0].hitCount, 2);
    assert.ok(Array.isArray(results[0].messages));
    assert.equal(results[0].messages.length, 2);
  });
});

test("recall can rank matching sessions newest-first without changing relevance default", async () => {
  await withTempRoot(async (root) => {
    for (const [id, timestamp, text] of [
      [
        "old-1",
        "2026-01-01T09:00:00.000Z",
        "Project Aurora current status is draft.",
      ],
      [
        "old-2",
        "2026-01-01T09:01:00.000Z",
        "Project Aurora current status remains draft.",
      ],
    ]) {
      await transcripts.appendTranscriptArchiveEntry(
        {
          id,
          timestamp,
          sessionId: "old-session",
          sessionFile: "/tmp/old-session.jsonl",
          role: "assistant",
          text,
        },
        root,
      );
    }
    await transcripts.appendTranscriptArchiveEntry(
      {
        id: "new-1",
        timestamp: "2026-07-20T09:00:00.000Z",
        sessionId: "new-session",
        sessionFile: "/tmp/new-session.jsonl",
        role: "assistant",
        text: "Project Aurora current status is released.",
      },
      root,
    );

    const relevanceResults = await transcripts.searchTranscriptArchive(
      "Project Aurora current status",
      { limit: 2 },
      root,
    );
    assert.deepEqual(
      relevanceResults.map((result) => result.sessionId),
      ["old-session", "new-session"],
    );

    const newestResults = await transcripts.searchTranscriptArchive(
      "Project Aurora current status",
      { limit: 2, order: "newest" },
      root,
    );
    assert.deepEqual(
      newestResults.map((result) => result.sessionId),
      ["new-session", "old-session"],
    );
  });
});

test("recall resolves an explicit session selector without FTS", async () => {
  await withTempRoot(async (root) => {
    for (const [id, timestamp, text] of [
      ["target-old", "2026-07-20T09:00:00.000Z", "Older target context."],
      ["target-new", "2026-07-20T10:00:00.000Z", "Newest target context."],
    ]) {
      await transcripts.appendTranscriptArchiveEntry(
        {
          id,
          timestamp,
          sessionId: "target-session",
          sessionFile: "/tmp/target-session.jsonl",
          role: "assistant",
          text,
        },
        root,
      );
    }
    await transcripts.appendTranscriptArchiveEntry(
      {
        id: "other",
        timestamp: "2026-07-20T11:00:00.000Z",
        sessionId: "other-session",
        sessionFile: "/tmp/other-session.jsonl",
        role: "assistant",
        text: "A message that mentions session:target-session.",
      },
      root,
    );

    const originalPrepare = BetterSqlite3.prototype.prepare;
    const preparedSql = [];
    BetterSqlite3.prototype.prepare = function patchedPrepare(sql, ...args) {
      preparedSql.push(String(sql || ""));
      return originalPrepare.call(this, sql, ...args);
    };

    try {
      const results = await transcripts.searchTranscriptArchive(
        "session:target-session",
        { limit: 2, order: "newest", fidelity: "exact" },
        root,
      );
      assert.equal(results.length, 1);
      assert.equal(results[0].sessionId, "target-session");
      assert.equal(results[0].messages[0].id, "target-new");
      assert.ok(
        preparedSql.some((sql) => /WHERE session_id = \?/i.test(sql)),
        "expected a direct session_id lookup",
      );
      assert.ok(
        preparedSql.every((sql) => !/\bMATCH\b/i.test(sql)),
        "explicit session lookup must not prepare FTS MATCH statements",
      );
    } finally {
      BetterSqlite3.prototype.prepare = originalPrepare;
    }
  });
});

test("recall falls back to FTS when an explicit session selector has no exact session", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        id: "fallback-message",
        timestamp: "2026-07-20T09:00:00.000Z",
        sessionId: "fallback-session",
        sessionFile: "/tmp/fallback-session.jsonl",
        role: "assistant",
        text: "The migration note references session:missing-session.",
      },
      root,
    );

    const results = await transcripts.searchTranscriptArchive(
      "session:missing-session",
      { limit: 2 },
      root,
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].sessionId, "fallback-session");
  });
});

test("relevance recall orders FTS matches by rank", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-07-20T09:00:00.000Z",
        sessionId: "rank-session",
        sessionFile: "/tmp/rank-session.jsonl",
        role: "assistant",
        text: "Project Aurora rank optimization evidence.",
      },
      root,
    );

    const originalPrepare = BetterSqlite3.prototype.prepare;
    const ftsQueries = [];
    BetterSqlite3.prototype.prepare = function patchedPrepare(sql, ...args) {
      const text = String(sql || "");
      if (/\bMATCH\b/i.test(text)) ftsQueries.push(text);
      return originalPrepare.call(this, sql, ...args);
    };

    try {
      const results = await transcripts.searchTranscriptArchive(
        "Project Aurora rank optimization",
        { limit: 2 },
        root,
      );
      assert.equal(results[0].sessionId, "rank-session");
      assert.equal(ftsQueries.length, 2);
      assert.ok(
        ftsQueries.every((sql) => /ORDER BY rank\b/i.test(sql)),
        "relevance FTS queries must use the optimized rank ordering",
      );
      assert.ok(ftsQueries.every((sql) => !/\bbm25\s*\(/i.test(sql)));
    } finally {
      BetterSqlite3.prototype.prepare = originalPrepare;
    }
  });
});

test("newest recall retrieves fresh matches before relevance candidate truncation", async () => {
  await withTempRoot(async (root) => {
    for (let index = 0; index < 55; index += 1) {
      await transcripts.appendTranscriptArchiveEntry(
        {
          id: `old-${index}`,
          timestamp: `2026-01-01T09:00:${String(index).padStart(2, "0")}.000Z`,
          sessionId: "old-saturated-session",
          sessionFile: "/tmp/old-saturated-session.jsonl",
          role: "assistant",
          text: `Project Aurora current status historical note ${index}.`,
        },
        root,
      );
    }
    await transcripts.appendTranscriptArchiveEntry(
      {
        id: "new-final",
        timestamp: "2026-07-20T09:00:00.000Z",
        sessionId: "new-final-session",
        sessionFile: "/tmp/new-final-session.jsonl",
        role: "assistant",
        text: "Project Aurora current status is released.",
      },
      root,
    );

    const newestResults = await transcripts.searchTranscriptArchive(
      "Project Aurora current status",
      { limit: 2, order: "newest" },
      root,
    );
    assert.deepEqual(
      newestResults.map((result) => result.sessionId),
      ["new-final-session", "old-saturated-session"],
    );
  });
});

test("recall avoids full entries-table exact scans before FTS lookup", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-06T12:00:00.000Z",
        sessionId: "session-fast-search",
        sessionFile: "/tmp/session-fast-search.jsonl",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Debugged chat outbound send routing without a table scan.",
          },
        ],
      },
      root,
    );

    const originalPrepare = BetterSqlite3.prototype.prepare;
    const likePreScans: string[] = [];
    const fullSessionLoads: string[] = [];
    BetterSqlite3.prototype.prepare = function patchedPrepare(sql, ...args) {
      const text = String(sql || "");
      if (/\bLIKE\b/i.test(text)) likePreScans.push(text);
      if (/WHERE session_key IN/i.test(text)) fullSessionLoads.push(text);
      return originalPrepare.call(this, sql, ...args);
    };

    try {
      const results = await transcripts.searchTranscriptArchive(
        "chat outbound send",
        { limit: 8 },
        root,
      );
      assert.equal(results.length, 1);
      assert.equal(results[0].sessionId, "session-fast-search");
      assert.deepEqual(likePreScans, []);
      assert.deepEqual(fullSessionLoads, []);
    } finally {
      BetterSqlite3.prototype.prepare = originalPrepare;
    }
  });
});

test("recall handles structured identifiers beyond exact raw substrings", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-07T08:08:08.000Z",
        sessionId: "session-ident",
        sessionFile: "/tmp/session-ident.jsonl",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Investigated chat-send.ts for the P2.2 outbound bridge regression.",
          },
        ],
      },
      root,
    );

    const results = await transcripts.searchTranscriptArchive(
      "chat send p2.2",
      { limit: 8 },
      root,
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].sessionId, "session-ident");
    assert.match(results[0].preview, /chat-send\.ts/);
    assert.match(results[0].messages[0].text, /P2\.2/);
  });
});

test("recall repairs a writer killed after canonical archive append", async () => {
  await withTempRoot(async (root) => {
    const transcriptsUrl = pathToFileURL(
      path.join(rootDir, "dist", "core", "memory", "transcripts.js"),
    ).href;
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const transcripts = await import(${JSON.stringify(transcriptsUrl)});\n` +
          `await transcripts.appendTranscriptArchiveEntry(${JSON.stringify({
            id: "dirty-kill-1",
            timestamp: "2026-04-08T09:09:09.000Z",
            sessionId: "session-dirty-kill",
            sessionFile: "/tmp/session-dirty-kill.jsonl",
            role: "assistant",
            text: "killed writer recovery marker",
          })}, ${JSON.stringify(root)});\n` +
          `process.kill(process.pid, "SIGKILL");`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(child.signal, "SIGKILL", child.stderr);

    const markerDir = path.join(root, "memory", "search-writers");
    assert.equal((await fs.readdir(markerDir)).length, 1);
    const results = await transcripts.searchTranscriptArchive(
      "killed writer recovery marker",
      { limit: 8 },
      root,
    );
    assert.equal(results[0].sessionId, "session-dirty-kill");
    assert.deepEqual(await fs.readdir(markerDir), []);
  });
});

test("transcript archive failures preserve the dirty marker for repair", async () => {
  await withTempRoot(async (root) => {
    await fs.mkdir(path.join(root, "memory"), { recursive: true });
    await fs.writeFile(path.join(root, "memory", "transcripts"), "blocked");
    const transcriptsUrl = pathToFileURL(
      path.join(rootDir, "dist", "core", "memory", "transcripts.js"),
    ).href;
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const transcripts = await import(${JSON.stringify(transcriptsUrl)});\n` +
          `try { await transcripts.appendTranscriptArchiveEntry(${JSON.stringify(
            {
              id: "archive-failure-1",
              timestamp: "2026-04-08T09:09:09.000Z",
              sessionId: "session-archive-failure",
              sessionFile: "/tmp/session-archive-failure.jsonl",
              role: "assistant",
              text: "archive failure marker",
            },
          )}, ${JSON.stringify(root)}); process.exit(2); } catch { process.exit(0); }`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
    const markerDir = path.join(root, "memory", "search-writers");
    assert.equal((await fs.readdir(markerDir)).length, 1);

    await fs.rm(path.join(root, "memory", "transcripts"));
    assert.deepEqual(
      await transcripts.searchTranscriptArchive(
        "archive failure marker",
        { limit: 8 },
        root,
      ),
      [],
    );
    assert.deepEqual(await fs.readdir(markerDir), []);
  });
});

test("transcript writers recreate an externally removed owned marker", async () => {
  await withTempRoot(async (root) => {
    const base = {
      timestamp: "2026-04-08T09:09:09.000Z",
      sessionId: "session-marker-recreate",
      sessionFile: "/tmp/session-marker-recreate.jsonl",
      role: "assistant",
    };
    await transcripts.appendTranscriptArchiveEntry(
      { ...base, id: "marker-1", text: "first marker entry" },
      root,
    );
    transcripts.flushTranscriptSearchIndexWrites(root);
    const markerDir = path.join(root, "memory", "search-writers");
    const firstMarkers = await fs.readdir(markerDir);
    assert.equal(firstMarkers.length, 1);
    await fs.rm(path.join(markerDir, firstMarkers[0]));

    await transcripts.appendTranscriptArchiveEntry(
      { ...base, id: "marker-2", text: "recreated marker entry" },
      root,
    );
    assert.equal((await fs.readdir(markerDir)).length, 1);
    const results = await transcripts.searchTranscriptArchive(
      "recreated marker entry",
      { limit: 8 },
      root,
    );
    assert.equal(results[0].sessionId, base.sessionId);
  });
});

test("recall repairs a failed marker even while its PID is alive", async () => {
  await withTempRoot(async (root) => {
    assert.deepEqual(
      await transcripts.searchTranscriptArchive(
        "failed marker before archive",
        { limit: 8 },
        root,
      ),
      [],
    );
    const entry = {
      id: "failed-live-1",
      timestamp: "2026-04-08T09:09:09.000Z",
      sessionId: "session-failed-live",
      sessionFile: "/tmp/session-failed-live.jsonl",
      role: "assistant",
      text: "failed live writer recovery marker",
    };
    const archivePath = transcripts.getTranscriptArchivePath(entry, root);
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    await fs.writeFile(archivePath, `${JSON.stringify(entry)}\n`);
    const markerDir = path.join(root, "memory", "search-writers");
    await fs.mkdir(markerDir, { recursive: true });
    await fs.writeFile(
      path.join(markerDir, `${process.pid}-failed-live.dirty`),
      JSON.stringify({
        pid: process.pid,
        processStartIdentity: "",
        createdAt: Date.now(),
        failed: true,
      }),
    );

    const results = await transcripts.searchTranscriptArchive(
      "failed live writer recovery marker",
      { limit: 8 },
      root,
    );
    assert.equal(results[0].sessionId, entry.sessionId);
    assert.deepEqual(await fs.readdir(markerDir), []);
  });
});

test("recall rejects a reused PID when the writer start identity differs", async () => {
  await withTempRoot(async (root) => {
    const entry = {
      id: "pid-reuse-1",
      timestamp: "2026-04-08T09:09:09.000Z",
      sessionId: "session-pid-reuse",
      sessionFile: "/tmp/session-pid-reuse.jsonl",
      role: "assistant",
      text: "pid reuse recovery marker",
    };
    assert.deepEqual(
      await transcripts.searchTranscriptArchive(
        "pid reuse marker before archive",
        { limit: 8 },
        root,
      ),
      [],
    );
    const archivePath = transcripts.getTranscriptArchivePath(entry, root);
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    await fs.writeFile(archivePath, `${JSON.stringify(entry)}\n`);
    assert.deepEqual(
      await transcripts.searchTranscriptArchive(
        "pid reuse recovery marker",
        { limit: 8 },
        root,
      ),
      [],
    );
    const markerDir = path.join(root, "memory", "search-writers");
    await fs.mkdir(markerDir, { recursive: true });
    await fs.writeFile(
      path.join(markerDir, `${process.pid}-reused.dirty`),
      JSON.stringify({
        pid: process.pid,
        processStartIdentity: "not-the-current-process",
        createdAt: Date.now(),
      }),
    );

    const results = await transcripts.searchTranscriptArchive(
      "pid reuse recovery marker",
      { limit: 8 },
      root,
    );
    assert.equal(results[0].sessionId, entry.sessionId);
    assert.deepEqual(await fs.readdir(markerDir), []);
  });
});

test("recall requires explicit repair for transcript files written outside incremental indexing", async () => {
  await withTempRoot(async (root) => {
    const entry = {
      id: "manual-1",
      timestamp: "2026-04-08T09:09:09.000Z",
      sessionId: "session-manual-repair",
      sessionFile: "/tmp/session-manual-repair.jsonl",
      role: "assistant",
      text: "Manual transcript write requires explicit repair.",
    };
    assert.deepEqual(
      await transcripts.searchTranscriptArchive(
        "manual archive not written yet",
        { limit: 8 },
        root,
      ),
      [],
    );
    const archivePath = transcripts.getTranscriptArchivePath(entry, root);
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    await fs.writeFile(archivePath, `${JSON.stringify(entry)}\n`);

    const beforeRepair = await transcripts.searchTranscriptArchive(
      "explicit repair",
      { limit: 8 },
      root,
    );
    assert.equal(beforeRepair.length, 0);

    const repair = await transcripts.repairTranscriptSearchIndex(root);
    assert.equal(repair.fileCount, 1);
    assert.equal(repair.entryCount, 1);

    const afterRepair = await transcripts.searchTranscriptArchive(
      "explicit repair",
      { limit: 8 },
      root,
    );
    assert.equal(afterRepair.length, 1);
    assert.equal(afterRepair[0].sessionId, entry.sessionId);
  });
});

test("memory-index repair rebuilds only the derived index", async () => {
  await withTempRoot(async (root) => {
    const entry = {
      id: "repair-derived-only-1",
      timestamp: "2026-04-08T09:09:09.000Z",
      sessionId: "session-repair-derived-only",
      sessionFile: "/tmp/session-repair-derived-only.jsonl",
      role: "assistant",
      text: "repair preserves canonical archive bytes",
    };
    const archivePath = transcripts.getTranscriptArchivePath(entry, root);
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    await fs.writeFile(archivePath, `${JSON.stringify(entry)}\n`);
    const before = await fs.readFile(archivePath);

    const repair = await transcripts.repairTranscriptSearchIndex(root);

    assert.equal(repair.fileCount, 1);
    assert.deepEqual(await fs.readFile(archivePath), before);
  });
});

test("recall repair refreshes rewritten transcript archives without stale rows", async () => {
  await withTempRoot(async (root) => {
    const firstEntry = {
      id: "manual-rewrite-1",
      timestamp: "2026-04-08T09:09:09.000Z",
      sessionId: "session-manual-rewrite",
      sessionFile: "/tmp/session-manual-rewrite.jsonl",
      role: "assistant",
      text: "alpha rewrite marker",
    };
    const archivePath = transcripts.getTranscriptArchivePath(firstEntry, root);
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    await fs.writeFile(archivePath, `${JSON.stringify(firstEntry)}\n`);

    await transcripts.repairTranscriptSearchIndex(root);
    const firstResults = await transcripts.searchTranscriptArchive(
      "alpha rewrite marker",
      { limit: 8, fidelity: "exact" },
      root,
    );
    assert.equal(firstResults.length, 1);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const secondEntry = {
      ...firstEntry,
      id: "manual-rewrite-2",
      text: "beta rewrite marker with longer text",
    };
    await fs.writeFile(archivePath, `${JSON.stringify(secondEntry)}\n`);

    await transcripts.repairTranscriptSearchIndex(root);
    const staleResults = await transcripts.searchTranscriptArchive(
      "alpha rewrite marker",
      { limit: 8, fidelity: "exact" },
      root,
    );
    assert.equal(staleResults.length, 0);

    const refreshedResults = await transcripts.searchTranscriptArchive(
      "beta rewrite marker",
      { limit: 8 },
      root,
    );
    assert.equal(refreshedResults.length, 1);
    assert.equal(refreshedResults[0].sessionId, secondEntry.sessionId);
    assert.equal(refreshedResults[0].hitCount, 1);
  });
});

test("memory transcript session loads can bypass search.db when result path is known", async () => {
  await withTempRoot(async (root) => {
    const entry = {
      timestamp: "2026-04-08T09:09:09.000Z",
      sessionId: "session-direct-path",
      sessionFile: "/tmp/session-direct-path.jsonl",
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Loaded transcript entries directly from the archive path.",
        },
      ],
    };
    await transcripts.appendTranscriptArchiveEntry(entry, root);
    const archivePath = transcripts.getTranscriptArchivePath(entry, root);
    await fs.mkdir(path.join(root, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(root, "memory", "search.db"),
      "not-a-sqlite-db",
    );
    const loaded = await transcripts.loadTranscriptSessionEntries(
      {
        sessionId: entry.sessionId,
        sessionFile: entry.sessionFile,
        path: archivePath,
      },
      root,
    );
    assert.equal(loaded.length, 1);
    assert.match(loaded[0].text, /directly from the archive path/);
  });
});

test("memory transcripts ignore transient in-memory sessions without a session file", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-08T09:09:09.000Z",
        sessionId: "session-transient",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "This should not be archived because the session is ephemeral.",
          },
        ],
      },
      root,
    );
    const results = await transcripts.loadRecentTranscriptSessions(
      { limit: 8 },
      root,
    );
    assert.equal(results.length, 0);
  });
});

test("memory transcripts reject legacy synthetic session summaries", async () => {
  await withTempRoot(async (root) => {
    const sessionFile = await writeSessionFile(root, "legacy-summary.jsonl", [
      {
        type: "session",
        version: 3,
        id: "legacy-summary",
        timestamp: "2026-04-08T09:00:00.000Z",
        cwd: "/tmp/project",
      },
    ]);

    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-08T09:10:00.000Z",
        sessionId: "legacy-summary",
        sessionFile,
        role: "sessionSummary",
        customType: "session_summary",
        text: "zebra only appears in the synthetic summary",
        display: false,
      },
      root,
    );

    const rows = await transcripts.searchTranscriptArchive(
      "zebra",
      { limit: 8 },
      root,
    );
    assert.equal(rows.length, 0);
  });
});

test("recall uses the first user message as the session display fallback", async () => {
  await withTempRoot(async (root) => {
    const sessionFile = await writeSessionFile(root, "fallback-session.jsonl", [
      {
        type: "session",
        version: 3,
        id: "fallback-session",
        timestamp: "2026-04-08T09:00:00.000Z",
        cwd: "/tmp/project",
      },
      {
        type: "message",
        id: "msg1",
        parentId: null,
        timestamp: "2026-04-08T09:02:00.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "Need help debugging the outbound chat routing bug",
            },
          ],
        },
      },
    ]);

    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-08T09:09:09.000Z",
        sessionId: "fallback-session",
        sessionFile,
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Verified the affected bridge path and confirmed outbound send recovery.",
          },
        ],
      },
      root,
    );

    const rows = await transcripts.searchTranscriptArchive(
      "outbound send recovery",
      { limit: 8 },
      root,
    );
    assert.equal(rows[0].summary, undefined);
    assert.equal(
      rows[0].name,
      "Need help debugging the outbound chat routing bug",
    );
  });
});

test("recall derives the display name without a full readFileSync slurp", async () => {
  await withTempRoot(async (root) => {
    const sessionFile = await writeSessionFile(
      root,
      "single-read-session.jsonl",
      [
        {
          type: "session",
          version: 3,
          id: "single-read-session",
          timestamp: "2026-04-08T09:00:00.000Z",
          cwd: "/tmp/project",
        },
        {
          type: "message",
          id: "msg1",
          parentId: null,
          timestamp: "2026-04-08T09:02:00.000Z",
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "Need help debugging the outbound chat routing bug",
              },
            ],
          },
        },
      ],
    );

    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-04-08T09:09:09.000Z",
        sessionId: "single-read-session",
        sessionFile,
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Verified the affected bridge path and confirmed outbound send recovery.",
          },
        ],
      },
      root,
    );

    const originalReadFileSync = fsSync.readFileSync;
    let sessionFileReadCount = 0;
    fsSync.readFileSync = function patchedReadFileSync(filePath, ...args) {
      if (path.resolve(String(filePath)) === path.resolve(sessionFile)) {
        sessionFileReadCount += 1;
      }
      return originalReadFileSync.call(this, filePath, ...args);
    };

    try {
      const rows = await transcripts.searchTranscriptArchive(
        "outbound send recovery",
        { limit: 8 },
        root,
      );
      assert.equal(
        rows[0].name,
        "Need help debugging the outbound chat routing bug",
      );
      assert.equal(sessionFileReadCount, 0);
    } finally {
      fsSync.readFileSync = originalReadFileSync;
    }
  });
});

test("executeRecall emits an initial status update before finishing", async () => {
  await withTempRoot(async (root) => {
    const updates = [];
    const result = await memoryExtensionModule.executeRecall(
      { query: "no hits yet", limit: 8 },
      { agentDir: root, model: { provider: "test", id: "demo" } },
      "medium",
      undefined,
      (update) => updates.push(update.details.userText),
    );

    assert.deepEqual(updates, [
      'Searching archived sessions for "no hits yet"...',
    ]);
    assert.match(result.details.userText, /No recall results found\./);
  });
});

test("recall user formatting omits duplicate header and shows raw messages", () => {
  const rendered = memoryExtensionModule.formatSearchResult({
    query: "minecraft server",
    results: [
      {
        timestamp: "2026-04-14T06:05:42.876Z",
        sessionFile: "/home/rin/.rin/sessions/demo.jsonl",
        path: "/home/rin/.rin/memory/transcripts/2026/04/demo.jsonl",
        summary:
          "Investigated the Minecraft server modpack crash and identified the failing config file.",
        preview: "raw preview should never leak",
        messages: [
          {
            line: 12,
            role: "toolResult",
            toolName: "bash",
            timestamp: "2026-04-14T06:05:40.000Z",
            text: "docker restart afbfee08-9ced-462b-9b30-8a5a09c2cb71 && grep 'Done (' logs/latest.log",
          },
        ],
      },
    ],
  });

  assert.doesNotMatch(rendered, /^recall minecraft server/m);
  assert.match(
    rendered,
    /\/home\/rin\/\.rin\/memory\/transcripts\/2026\/04\/demo\.jsonl/,
  );
  assert.match(rendered, /Investigated the Minecraft server modpack crash/);
  assert.match(rendered, /2026-04-14T06:05:42\.876Z/);
  assert.match(
    rendered,
    /L12 2026-04-14T06:05:40\.000Z toolResult\/bash: docker restart afbfee08-9ced-462b-9b30-8a5a09c2cb71/,
  );
  assert.doesNotMatch(rendered, /raw preview should never leak/);
});

test("recall agent formatting uses archive path and line-numbered raw messages", () => {
  const rendered = memoryExtensionModule.formatAgentSearchResult({
    query: "chat outbound",
    results: [
      {
        timestamp: "2026-04-14T06:05:42.876Z",
        sessionId: "b6745c84-869c-4bc4-9709-9cda7a4f6def",
        sessionFile:
          "/home/rin/.rin/sessions/2026-04-14T06-05-42-876Z_b6745c84-869c-4bc4-9709-9cda7a4f6def.jsonl",
        path: "/home/rin/.rin/memory/transcripts/2026/04/64ccd205-ea35-4716-b2d4-9eff931eb59c.jsonl",
        summary:
          "Fixed the Chat outbound send routing bug and verified the affected bridge path.",
        messages: [
          {
            line: 42,
            role: "assistant",
            timestamp: "2026-04-14T06:04:00.000Z",
            text: "Verified the affected bridge path and confirmed outbound send recovery.",
          },
        ],
      },
    ],
  });

  assert.match(rendered, /^recall chat outbound \(1\)/m);
  assert.match(
    rendered,
    /1\. 2026-04-14T06:05:42\.876Z \/home\/rin\/\.rin\/memory\/transcripts\/2026\/04\/64ccd205-ea35-4716-b2d4-9eff931eb59c\.jsonl/,
  );
  assert.match(
    rendered,
    /L42 2026-04-14T06:04:00\.000Z assistant: Verified the affected bridge path/,
  );
  assert.match(rendered, /^1\. 2026-04-14T06:05:42\.876Z /m);
});

test("recall tool schema exposes relevance and newest ordering", () => {
  const definition = memoryExtensionModule.default({
    getThinkingLevel: () => "medium",
  });
  const recallTool = definition.tools.find((tool) => tool.name === "recall");
  assert.equal(recallTool.parameters.properties.order.type, "string");
  assert.deepEqual(recallTool.parameters.properties.order.enum, [
    "relevance",
    "newest",
  ]);
});

test("recall call formatting keeps tool name and query in the TUI tool title", () => {
  const theme = {
    fg: (_name, value) => value,
    bold: (value) => value,
  };
  const rendered = recallPresentation.formatRecallCall(
    { query: "recall hang" },
    theme,
  );
  assert.equal(rendered, "recall recall hang");
});

test("recall rendered result appends timing info", () => {
  const theme = {
    fg: (_name, value) => value,
    bold: (value) => value,
  };
  const rendered = recallPresentation.formatRenderedRecallResult(
    {
      details: {
        userText: 'Searching archived sessions for "recall hang"...',
      },
    },
    { expanded: false, isPartial: false },
    theme,
    false,
    1000,
    3500,
  );

  assert.match(rendered, /Searching archived sessions for "recall hang"/);
  assert.match(rendered, /Took 2\.5s/);
});

test("installer restores a transcript guard that predates its backup manifest", async () => {
  await withTempRoot(async (root) => {
    const liveRoot = path.join(root, "memory", "transcripts");
    const backupRoot = `${liveRoot}.migration-backup-v6`;
    const archivePath = path.join(backupRoot, "2026", "08", "recovered.jsonl");
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    await fs.writeFile(
      archivePath,
      `${JSON.stringify({
        id: "recovered",
        timestamp: "2026-08-11T00:00:00.000Z",
        sessionId: "recovered",
        sessionFile: "/tmp/recovered.jsonl",
        role: "assistant",
        text: "recovered archive",
      })}\n`,
    );
    await fs.writeFile(liveRoot, "transcript migration guard\n");

    const recovered =
      await transcriptSchemaMigration.migrateTranscriptSearchIndexForMigration(
        root,
        { runtimeQuiesced: true },
      );
    assert.equal(recovered.action, "rebuilt");
    assert.equal(fsSync.statSync(liveRoot).isDirectory(), true);
    assert.equal(fsSync.existsSync(backupRoot), true);
    assert.match(
      await fs.readFile(
        path.join(liveRoot, "2026", "08", "recovered.jsonl"),
        "utf8",
      ),
      /recovered archive/,
    );
    transcriptSchemaMigration.finalizeTranscriptSearchMigrationForMigration(
      root,
    );
    assert.equal(fsSync.existsSync(backupRoot), false);
  });
});

test("installer rejects an unexplained transcript backup beside a live directory", async () => {
  await withTempRoot(async (root) => {
    const liveRoot = path.join(root, "memory", "transcripts");
    const backupRoot = `${liveRoot}.migration-backup-v6`;
    await fs.mkdir(liveRoot, { recursive: true });
    await fs.mkdir(backupRoot, { recursive: true });
    await fs.writeFile(path.join(backupRoot, "orphan"), "data");
    await assert.rejects(
      transcriptSchemaMigration.migrateTranscriptSearchIndexForMigration(root, {
        runtimeQuiesced: true,
      }),
      /transcript_archive_install_backup_manifest_invalid/,
    );
    assert.equal(fsSync.existsSync(path.join(backupRoot, "orphan")), true);
  });
});

test("installer recovers a guarded transcript manifest after both payloads publish", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-08-11T00:00:00.000Z",
        sessionId: "recovery-session",
        sessionFile: "/tmp/recovery-session.jsonl",
        role: "assistant",
        content: [{ type: "text", text: "recovery payload" }],
      },
      root,
    );
    transcripts.flushTranscriptSearchIndexWrites(root);
    const legacyDb = new BetterSqlite3(path.join(root, "memory", "search.db"));
    legacyDb
      .prepare("UPDATE metadata SET value = '5' WHERE key = 'schema_version'")
      .run();
    legacyDb.close();
    await fs.writeFile(
      path.join(root, "memory", "search.db.schema.json"),
      `${JSON.stringify({ schemaVersion: 5, state: "current" })}\n`,
    );
    await transcriptSchemaMigration.prepareTranscriptSearchMigrationForMigration(
      root,
    );
    await transcriptSchemaMigration.migrateTranscriptSearchIndexForMigration(
      root,
      { runtimeQuiesced: true },
    );
    const backupRoot = `${path.join(root, "memory", "transcripts")}.migration-backup-v6`;
    const manifestPath = path.join(backupRoot, ".migration-manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, phase: "guarded" })}\n`,
    );

    const recovered =
      await transcriptSchemaMigration.migrateTranscriptSearchIndexForMigration(
        root,
        { runtimeQuiesced: true },
      );
    assert.equal(recovered.action, "rebuilt");
    assert.equal(
      JSON.parse(await fs.readFile(manifestPath, "utf8")).phase,
      "published",
    );
    assert.equal(
      transcriptSchemaMigration.finalizeTranscriptSearchMigrationForMigration(
        root,
      ).cleanupPending,
      false,
    );
  });
});

test("installer refuses finalization without the transcript sanitization report", async () => {
  await withTempRoot(async (root) => {
    await transcripts.appendTranscriptArchiveEntry(
      {
        timestamp: "2026-08-11T00:00:00.000Z",
        sessionId: "missing-report-session",
        sessionFile: "/tmp/missing-report-session.jsonl",
        role: "assistant",
        content: [{ type: "text", text: "missing report payload" }],
      },
      root,
    );
    transcripts.flushTranscriptSearchIndexWrites(root);
    const legacyDb = new BetterSqlite3(path.join(root, "memory", "search.db"));
    legacyDb
      .prepare("UPDATE metadata SET value = '5' WHERE key = 'schema_version'")
      .run();
    legacyDb.close();
    await fs.writeFile(
      path.join(root, "memory", "search.db.schema.json"),
      `${JSON.stringify({ schemaVersion: 5, state: "current" })}\n`,
    );
    await transcriptSchemaMigration.prepareTranscriptSearchMigrationForMigration(
      root,
    );
    await transcriptSchemaMigration.migrateTranscriptSearchIndexForMigration(
      root,
      { runtimeQuiesced: true },
    );
    const backupRoot = `${path.join(root, "memory", "transcripts")}.migration-backup-v6`;
    const sanitizationPath = path.join(
      backupRoot,
      ".sanitization-manifest.json",
    );
    const sanitizationManifest = await fs.readFile(sanitizationPath);
    await fs.rm(sanitizationPath);
    await assert.rejects(
      Promise.resolve().then(() =>
        transcriptSchemaMigration.finalizeTranscriptSearchMigrationForMigration(
          root,
        ),
      ),
      /transcript_archive_install_migration_incomplete/,
    );
    await fs.writeFile(sanitizationPath, sanitizationManifest);
    const publishManifestPath = path.join(
      backupRoot,
      ".migration-manifest.json",
    );
    const publishManifest = JSON.parse(
      await fs.readFile(publishManifestPath, "utf8"),
    );
    await fs.writeFile(
      publishManifestPath,
      `${JSON.stringify({ ...publishManifest, phase: "guarded" })}\n`,
    );
    assert.throws(
      () =>
        transcriptSchemaMigration.finalizeTranscriptSearchMigrationForMigration(
          root,
        ),
      /transcript_archive_install_migration_incomplete/,
    );
    assert.equal(
      transcriptSchemaMigration.rollbackTranscriptSearchMigrationForMigration(
        root,
      ).skipped,
      false,
    );
  });
});

test("installer rejects non-directory transcript backups in every phase", async () => {
  for (const phase of ["apply", "finalize", "rollback"] as const) {
    await withTempRoot(async (root) => {
      const backupRoot = `${path.join(root, "memory", "transcripts")}.migration-backup-v6`;
      await fs.mkdir(path.dirname(backupRoot), { recursive: true });
      await fs.writeFile(backupRoot, "not-a-directory");
      if (phase === "apply") {
        await assert.rejects(
          transcriptSchemaMigration.migrateTranscriptSearchIndexForMigration(
            root,
            { runtimeQuiesced: true },
          ),
          /transcript_archive_install_backup_manifest_invalid/,
        );
      } else {
        assert.throws(
          () =>
            phase === "finalize"
              ? transcriptSchemaMigration.finalizeTranscriptSearchMigrationForMigration(
                  root,
                )
              : transcriptSchemaMigration.rollbackTranscriptSearchMigrationForMigration(
                  root,
                ),
          /transcript_archive_install_backup_manifest_invalid/,
        );
      }
    });
  }
});

test("installer requires quiescence even when only an empty legacy index exists", async () => {
  await withTempRoot(async (root) => {
    const dbPath = path.join(root, "memory", "search.db");
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const legacyDb = new BetterSqlite3(dbPath);
    legacyDb.exec(`
      CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata(key, value) VALUES ('schema_version', '5');
    `);
    legacyDb.close();
    await fs.writeFile(
      `${dbPath}.schema.json`,
      `${JSON.stringify({ schemaVersion: 5, state: "current" })}\n`,
    );
    await transcriptSchemaMigration.prepareTranscriptSearchMigrationForMigration(
      root,
    );
    await assert.rejects(
      transcriptSchemaMigration.migrateTranscriptSearchIndexForMigration(root),
      /memory_install_migration_runtime_not_quiesced/,
    );
    const unchanged = new BetterSqlite3(dbPath, { readonly: true });
    try {
      assert.equal(
        unchanged
          .prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
          .get().value,
        "5",
      );
    } finally {
      unchanged.close();
    }
  });
});
