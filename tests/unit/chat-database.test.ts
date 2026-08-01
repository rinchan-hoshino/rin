import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const chatDatabase = {
  ...(await import(
    pathToFileURL(path.join(rootDir, "dist", "core", "chat", "database.js"))
      .href
  )),
  ...(await import(
    pathToFileURL(
      path.join(
        rootDir,
        "dist",
        "core",
        "chat",
        "database-install-migration.js",
      ),
    ).href
  )),
};
const chatInbox = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "inbox.js")).href
);
const chatOutbox = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "chat-outbox.js"))
    .href
);

function runNodeProcess(code, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`child_exit_${code}:${stderr}`));
    });
  });
}

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-database-"));
  try {
    await fn(dir);
  } finally {
    chatDatabase.closeChatDatabase(dir);
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function dropDurableAdmissionColumns(db) {
  db.exec(`
    ALTER TABLE inbox_jobs RENAME TO turns;
    ALTER TABLE turns DROP COLUMN execution_session_file;
    ALTER TABLE turns DROP COLUMN submission_hash;
    ALTER TABLE turns DROP COLUMN submission_json;
    ALTER TABLE turns DROP COLUMN admission_hash;
    ALTER TABLE turns DROP COLUMN admission_json;
    ALTER TABLE turns DROP COLUMN admission_state;
  `);
}

test("chat database owns message, turn, outbox, delivery, and chat generation state", async () => {
  await withTempDir(async (agentDir) => {
    const db = chatDatabase.openChatDatabase(agentDir);
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
      )
      .all()
      .map((row) => row.name);

    assert.deepEqual(
      tables.filter((name) => !name.startsWith("sqlite_")),
      [
        "chat_state",
        "inbound_heads",
        "inbox_jobs",
        "messages",
        "outbox",
        "outbox_deliveries",
        "schema_meta",
      ],
    );
    assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
    assert.equal(
      chatDatabase.chatDatabasePath(agentDir),
      path.join(agentDir, "data", "chat", "chat.sqlite"),
    );
    assert.ok(
      (await fs.stat(chatDatabase.chatDatabasePath(agentDir))).isFile(),
    );
  });
});

test("chat database cutover migrates v8 run ownership to interrupted delivery-only turns", async () => {
  await withTempDir(async (agentDir) => {
    const db = chatDatabase.openChatDatabase(agentDir);
    const now = new Date().toISOString();
    try {
      db.exec(`
      CREATE TABLE chat_runs (
        run_id TEXT PRIMARY KEY,
        chat_key TEXT NOT NULL,
        generation INTEGER NOT NULL,
        state TEXT NOT NULL,
        owner_epoch TEXT NOT NULL,
        producer_incarnation TEXT NOT NULL,
        delivery_turn_id TEXT NOT NULL,
        terminal_delivery_turn_id TEXT,
        terminal_kind TEXT,
        terminal_payload_json TEXT,
        terminal_payload_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        terminal_at TEXT
      );
    `);
    } catch (error) {
      throw new Error(
        `create chat_runs: ${String((error as any)?.message || error)}`,
      );
    }
    const queued = chatInbox.enqueueChatInboxItem(agentDir, {
      chatKey: "discord/1:2",
      messageId: "platform-v8",
      session: {
        platform: "discord",
        selfId: "1",
        channelId: "2",
        messageId: "platform-v8",
        content: "preserved",
        stripped: { content: "preserved" },
      },
      elements: [{ type: "text", attrs: { content: "preserved" } }],
    }).item;
    const pending = chatInbox.enqueueChatInboxItem(agentDir, {
      chatKey: "discord/1:2",
      messageId: "platform-v8-pending",
      session: {
        platform: "discord",
        selfId: "1",
        channelId: "2",
        messageId: "platform-v8-pending",
        content: "must not replay after cutover",
        stripped: { content: "must not replay after cutover" },
      },
      elements: [
        {
          type: "text",
          attrs: { content: "must not replay after cutover" },
        },
      ],
    }).item;
    const claimed = chatInbox.claimChatInboxItem(agentDir, queued.itemId);
    assert.ok(claimed);
    db.exec(`ALTER TABLE inbox_jobs RENAME TO turns;`);
    db.exec(`ALTER TABLE turns ADD COLUMN run_id TEXT;`);
    db.prepare(`UPDATE turns SET run_id = ? WHERE turn_id = ?`).run(
      "run-v8",
      queued.itemId,
    );
    db.prepare(
      `INSERT INTO chat_runs (
         run_id, chat_key, generation, state, owner_epoch,
         producer_incarnation, delivery_turn_id, created_at, updated_at
       ) VALUES (?, ?, 1, 'running', ?, ?, ?, ?, ?)`,
    ).run(
      "run-v8",
      "discord/1:2",
      "owner-v8",
      "producer-v8",
      queued.itemId,
      now,
      now,
    );
    db.pragma("user_version = 8");
    db.prepare(
      `UPDATE schema_meta SET value = '8' WHERE key = 'schema_version'`,
    ).run();
    db.prepare(
      `UPDATE schema_meta SET value = ? WHERE key = 'schema_fingerprint'`,
    ).run(chatDatabase.chatDatabaseSchemaFingerprint(db));
    chatDatabase.closeChatDatabase(agentDir);

    try {
      chatDatabase.migrateChatDatabaseForInstall(agentDir, {
        runtimeQuiesced: true,
      });
    } catch (error) {
      throw new Error(String((error as any)?.message || error));
    }
    const migrated = chatDatabase.openChatDatabase(agentDir);
    assert.equal(migrated.pragma("user_version", { simple: true }), 9);
    assert.equal(
      migrated
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_runs'`,
        )
        .get(),
      undefined,
    );
    assert.equal(
      migrated
        .prepare(`PRAGMA table_info(inbox_jobs)`)
        .all()
        .some((column) => column.name === "run_id"),
      false,
    );
    assert.deepEqual(
      migrated
        .prepare(
          `SELECT state, terminal_kind, last_error FROM inbox_jobs WHERE turn_id = ?`,
        )
        .get(queued.itemId),
      {
        state: "failed",
        terminal_kind: "interrupted",
        last_error: "install_upgrade_interrupted",
      },
    );
    assert.deepEqual(
      migrated
        .prepare(
          `SELECT state, terminal_kind, last_error FROM inbox_jobs WHERE turn_id = ?`,
        )
        .get(pending.itemId),
      {
        state: "failed",
        terminal_kind: "interrupted",
        last_error: "install_upgrade_interrupted",
      },
    );
    assert.equal(
      migrated
        .prepare(
          `SELECT stripped_content
           FROM messages
           WHERE id = (SELECT inbound_message_id FROM inbox_jobs WHERE turn_id = ?)`,
        )
        .get(queued.itemId).stripped_content,
      "preserved",
    );
    const freshAgentDir = path.join(agentDir, "fresh-v9");
    const fresh = chatDatabase.openChatDatabase(freshAgentDir);
    const schemaRows = (db) =>
      db
        .prepare(
          `SELECT type, name, tbl_name, sql FROM sqlite_master
           WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
        )
        .all()
        .map((row) => ({
          ...row,
          sql: String(row.sql || "")
            .replace(/\s+/g, " ")
            .trim(),
        }));
    assert.deepEqual(schemaRows(migrated), schemaRows(fresh));
    chatDatabase.closeChatDatabase(freshAgentDir);
  });
});

test("chat database reopens the current version 9 delivery-only layout", async () => {
  await withTempDir(async (agentDir) => {
    const created = chatDatabase.openChatDatabase(agentDir);
    assert.equal(created.pragma("user_version", { simple: true }), 9);
    assert.deepEqual(
      created
        .prepare(`PRAGMA table_info(inbox_jobs)`)
        .all()
        .map((column) => column.name)
        .filter((name) =>
          [
            "admission_state",
            "admission_json",
            "admission_hash",
            "submission_json",
            "submission_hash",
            "execution_session_file",
          ].includes(name),
        ),
      [
        "admission_state",
        "admission_json",
        "admission_hash",
        "submission_json",
        "submission_hash",
        "execution_session_file",
      ],
    );
    chatDatabase.closeChatDatabase(agentDir);

    const reopened = chatDatabase.openChatDatabase(agentDir);
    assert.equal(reopened.pragma("user_version", { simple: true }), 9);
    assert.equal(
      reopened
        .prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`)
        .get().value,
      "9",
    );
    assert.equal(
      reopened
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_runs'`,
        )
        .get(),
      undefined,
    );
  });
});

test("chat database rejects unknown future and partial schemas instead of relabeling them", async () => {
  await withTempDir(async (agentDir) => {
    const db = chatDatabase.openChatDatabase(agentDir);
    db.pragma("user_version = 99");
    chatDatabase.closeChatDatabase(agentDir);
    assert.throws(
      () => chatDatabase.openChatDatabase(agentDir),
      /chat_database_future_schema:99/,
    );
  });

  const partialDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-database-partial-"),
  );
  try {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const dbPath = chatDatabase.chatDatabasePath(partialDir);
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const partial = new BetterSqlite3(dbPath);
    partial.exec(`CREATE TABLE stray_state (id TEXT PRIMARY KEY)`);
    partial.close();
    assert.throws(
      () => chatDatabase.migrateChatDatabaseForInstall(partialDir),
      /chat_database_partial_schema/,
    );
  } finally {
    chatDatabase.closeChatDatabase(partialDir);
    await fs.rm(partialDir, { recursive: true, force: true });
  }

  const incompleteDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-database-incomplete-"),
  );
  try {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const dbPath = chatDatabase.chatDatabasePath(incompleteDir);
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const incomplete = new BetterSqlite3(dbPath);
    incomplete.exec(
      `CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
       INSERT INTO schema_meta (key, value) VALUES ('schema_version', '1');
       PRAGMA user_version = 1;`,
    );
    incomplete.close();
    assert.throws(
      () => chatDatabase.migrateChatDatabaseForInstall(incompleteDir),
      /chat_database_incomplete_schema/,
    );
  } finally {
    chatDatabase.closeChatDatabase(incompleteDir);
    await fs.rm(incompleteDir, { recursive: true, force: true });
  }
});

test("chat database migrates the version 1 terminal outbox index", async () => {
  await withTempDir(async (agentDir) => {
    const db = chatDatabase.openChatDatabase(agentDir);
    dropDurableAdmissionColumns(db);
    db.exec(`
      DROP INDEX outbox_turn_terminal_idx;
      CREATE UNIQUE INDEX outbox_turn_terminal_idx
        ON outbox(turn_id)
        WHERE turn_id IS NOT NULL;
      ALTER TABLE chat_state DROP COLUMN legacy_session_imported;
      ALTER TABLE chat_state DROP COLUMN session_file;
      ALTER TABLE outbox DROP COLUMN dispatch_started_at;
      DROP INDEX inbound_heads_recovery_idx;
      ALTER TABLE inbound_heads DROP COLUMN recovery_version;
      ALTER TABLE inbound_heads DROP COLUMN recovery_next_attempt_at;
      ALTER TABLE inbound_heads DROP COLUMN recovery_paused_at;
      ALTER TABLE inbound_heads DROP COLUMN recovery_last_failed_at;
      ALTER TABLE inbound_heads DROP COLUMN recovery_first_failed_at;
      ALTER TABLE inbound_heads DROP COLUMN recovery_failure_count;
      UPDATE schema_meta SET value = '1' WHERE key = 'schema_version';
      PRAGMA user_version = 1;
    `);
    const objects = db
      .prepare(
        `SELECT type, name, sql FROM sqlite_master
         WHERE type IN ('table', 'index', 'trigger', 'view')
           AND name NOT LIKE 'sqlite_%'
           AND sql IS NOT NULL
         ORDER BY type, name`,
      )
      .all();
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(objects))
      .digest("hex");
    db.prepare(
      `UPDATE schema_meta SET value = ? WHERE key = 'schema_fingerprint'`,
    ).run(fingerprint);
    chatDatabase.closeChatDatabase(agentDir);

    const migrated = chatDatabase.migrateChatDatabaseForInstall(agentDir);
    assert.equal(migrated.pragma("user_version", { simple: true }), 9);
    assert.equal(
      migrated
        .prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`)
        .get().value,
      "9",
    );
    const indexSql = migrated
      .prepare(
        `SELECT sql FROM sqlite_master
         WHERE type = 'index' AND name = 'outbox_turn_terminal_idx'`,
      )
      .get().sql;
    assert.match(
      indexSql,
      /delivery_kind IN \('final', 'error', 'command_ack'\)/,
    );
    assert.match(indexSql, /post_delivery_json IS NOT NULL/);
  });
});

test("chat database migrates version 2 session binding authority", async () => {
  await withTempDir(async (agentDir) => {
    const db = chatDatabase.openChatDatabase(agentDir);
    dropDurableAdmissionColumns(db);
    db.exec(`
      ALTER TABLE chat_state DROP COLUMN legacy_session_imported;
      ALTER TABLE chat_state DROP COLUMN session_file;
      ALTER TABLE outbox DROP COLUMN dispatch_started_at;
      DROP INDEX inbound_heads_recovery_idx;
      ALTER TABLE inbound_heads DROP COLUMN recovery_version;
      ALTER TABLE inbound_heads DROP COLUMN recovery_next_attempt_at;
      ALTER TABLE inbound_heads DROP COLUMN recovery_paused_at;
      ALTER TABLE inbound_heads DROP COLUMN recovery_last_failed_at;
      ALTER TABLE inbound_heads DROP COLUMN recovery_first_failed_at;
      ALTER TABLE inbound_heads DROP COLUMN recovery_failure_count;
      UPDATE schema_meta SET value = '2' WHERE key = 'schema_version';
      PRAGMA user_version = 2;
    `);
    const objects = db
      .prepare(
        `SELECT type, name, sql FROM sqlite_master
         WHERE type IN ('table', 'index', 'trigger', 'view')
           AND name NOT LIKE 'sqlite_%'
           AND sql IS NOT NULL
         ORDER BY type, name`,
      )
      .all();
    db.prepare(
      `UPDATE schema_meta SET value = ? WHERE key = 'schema_fingerprint'`,
    ).run(createHash("sha256").update(JSON.stringify(objects)).digest("hex"));
    chatDatabase.closeChatDatabase(agentDir);

    const migrated = chatDatabase.migrateChatDatabaseForInstall(agentDir);
    assert.equal(migrated.pragma("user_version", { simple: true }), 9);
    assert.ok(
      migrated
        .prepare(`PRAGMA table_info(chat_state)`)
        .all()
        .some((column) => column.name === "session_file"),
    );
  });
});

test("chat database migrates version 3 dispatch evidence", async () => {
  await withTempDir(async (agentDir) => {
    const db = chatDatabase.openChatDatabase(agentDir);
    dropDurableAdmissionColumns(db);
    db.exec(`
      ALTER TABLE outbox DROP COLUMN dispatch_started_at;
      DROP INDEX inbound_heads_recovery_idx;
      ALTER TABLE inbound_heads DROP COLUMN recovery_version;
      ALTER TABLE inbound_heads DROP COLUMN recovery_next_attempt_at;
      ALTER TABLE inbound_heads DROP COLUMN recovery_paused_at;
      ALTER TABLE inbound_heads DROP COLUMN recovery_last_failed_at;
      ALTER TABLE inbound_heads DROP COLUMN recovery_first_failed_at;
      ALTER TABLE inbound_heads DROP COLUMN recovery_failure_count;
      UPDATE schema_meta SET value = '3' WHERE key = 'schema_version';
      PRAGMA user_version = 3;
    `);
    const objects = db
      .prepare(
        `SELECT type, name, sql FROM sqlite_master
         WHERE type IN ('table', 'index', 'trigger', 'view')
           AND name NOT LIKE 'sqlite_%'
           AND sql IS NOT NULL
         ORDER BY type, name`,
      )
      .all();
    db.prepare(
      `UPDATE schema_meta SET value = ? WHERE key = 'schema_fingerprint'`,
    ).run(createHash("sha256").update(JSON.stringify(objects)).digest("hex"));
    chatDatabase.closeChatDatabase(agentDir);

    const migrated = chatDatabase.migrateChatDatabaseForInstall(agentDir);
    assert.equal(migrated.pragma("user_version", { simple: true }), 9);
    assert.ok(
      migrated
        .prepare(`PRAGMA table_info(outbox)`)
        .all()
        .some((column) => column.name === "dispatch_started_at"),
    );
  });
});

test("chat database migrates version 4 inbound recovery lease state", async () => {
  await withTempDir(async (agentDir) => {
    const db = chatDatabase.openChatDatabase(agentDir);
    dropDurableAdmissionColumns(db);
    db.exec(`
      DROP INDEX inbound_heads_recovery_idx;
      ALTER TABLE inbound_heads DROP COLUMN recovery_version;
      ALTER TABLE inbound_heads DROP COLUMN recovery_next_attempt_at;
      ALTER TABLE inbound_heads DROP COLUMN recovery_paused_at;
      ALTER TABLE inbound_heads DROP COLUMN recovery_last_failed_at;
      ALTER TABLE inbound_heads DROP COLUMN recovery_first_failed_at;
      ALTER TABLE inbound_heads DROP COLUMN recovery_failure_count;
      UPDATE schema_meta SET value = '4' WHERE key = 'schema_version';
      PRAGMA user_version = 4;
    `);
    const objects = db
      .prepare(
        `SELECT type, name, sql FROM sqlite_master
         WHERE type IN ('table', 'index', 'trigger', 'view')
           AND name NOT LIKE 'sqlite_%'
           AND sql IS NOT NULL
         ORDER BY type, name`,
      )
      .all();
    db.prepare(
      `UPDATE schema_meta SET value = ? WHERE key = 'schema_fingerprint'`,
    ).run(createHash("sha256").update(JSON.stringify(objects)).digest("hex"));
    chatDatabase.closeChatDatabase(agentDir);

    const migrated = chatDatabase.migrateChatDatabaseForInstall(agentDir);
    assert.equal(migrated.pragma("user_version", { simple: true }), 9);
    const columns = new Set(
      migrated
        .prepare(`PRAGMA table_info(inbound_heads)`)
        .all()
        .map((column) => column.name),
    );
    assert.ok(columns.has("recovery_failure_count"));
    assert.ok(columns.has("recovery_paused_at"));
    assert.ok(columns.has("recovery_next_attempt_at"));
    assert.ok(columns.has("recovery_version"));
  });
});

test("chat database rejects schema objects that drift from the recorded fingerprint", async () => {
  await withTempDir(async (agentDir) => {
    const db = chatDatabase.openChatDatabase(agentDir);
    db.exec(`DROP INDEX messages_reply_idx`);
    chatDatabase.closeChatDatabase(agentDir);
    assert.throws(
      () => chatDatabase.openChatDatabase(agentDir),
      /chat_database_schema_fingerprint_mismatch/,
    );
  });
});

test("chat database fingerprint includes triggers and views", async () => {
  await withTempDir(async (agentDir) => {
    const db = chatDatabase.openChatDatabase(agentDir);
    db.exec(
      `CREATE TRIGGER unexpected_message_trigger
       AFTER INSERT ON messages
       BEGIN
         UPDATE messages SET updated_at = 'tampered' WHERE id = NEW.id;
       END`,
    );
    chatDatabase.closeChatDatabase(agentDir);
    assert.throws(
      () => chatDatabase.openChatDatabase(agentDir),
      /chat_database_schema_fingerprint_mismatch/,
    );
  });
});

test("chat database serializes concurrent cold initialization", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-database-cold-"),
  );
  try {
    const moduleUrl = pathToFileURL(
      path.join(rootDir, "dist", "core", "chat", "database.js"),
    ).href;
    const code = `
      const database = await import(process.env.CHAT_DATABASE_URL);
      database.openChatDatabase(process.env.AGENT_DIR);
      database.closeChatDatabase(process.env.AGENT_DIR);
    `;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        runNodeProcess(code, {
          CHAT_DATABASE_URL: moduleUrl,
          AGENT_DIR: agentDir,
        }),
      ),
    );
    const db = chatDatabase.openChatDatabase(agentDir);
    assert.equal(db.pragma("user_version", { simple: true }), 9);
    assert.deepEqual(
      db
        .prepare(`SELECT key FROM schema_meta ORDER BY key`)
        .all()
        .map((row) => row.key),
      ["admission_model_version", "schema_fingerprint", "schema_version"],
    );
  } finally {
    chatDatabase.closeChatDatabase(agentDir);
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat database serializes cross-process sequence and generation updates", async () => {
  await withTempDir(async (agentDir) => {
    chatDatabase.openChatDatabase(agentDir);
    chatDatabase.closeChatDatabase(agentDir);
    const moduleUrl = pathToFileURL(
      path.join(rootDir, "dist", "core", "chat", "database.js"),
    ).href;
    const code = `
      const database = await import(process.env.CHAT_DATABASE_URL);
      database.allocateChatSequence(process.env.AGENT_DIR, 'telegram/7:42');
      database.advanceChatGeneration(process.env.AGENT_DIR, 'telegram/7:42');
      database.closeChatDatabase(process.env.AGENT_DIR);
    `;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        runNodeProcess(code, {
          CHAT_DATABASE_URL: moduleUrl,
          AGENT_DIR: agentDir,
        }),
      ),
    );
    assert.deepEqual(chatDatabase.readChatState(agentDir, "telegram/7:42"), {
      chatKey: "telegram/7:42",
      currentGeneration: 8,
      nextSequence: 9,
    });
  });
});

test("chat database allocates per-chat sequence and advances reset generation transactionally", async () => {
  await withTempDir(async (agentDir) => {
    assert.deepEqual(chatDatabase.readChatState(agentDir, "telegram/7:42"), {
      chatKey: "telegram/7:42",
      currentGeneration: 0,
      nextSequence: 1,
    });

    assert.deepEqual(
      chatDatabase.allocateChatSequence(agentDir, "telegram/7:42"),
      { sequence: 1, generation: 0 },
    );
    assert.deepEqual(
      chatDatabase.allocateChatSequence(agentDir, "telegram/7:42"),
      { sequence: 2, generation: 0 },
    );

    chatDatabase.writeChatSessionBinding(
      agentDir,
      "telegram/7:42",
      "sessions/old.jsonl",
    );
    const db = chatDatabase.openChatDatabase(agentDir);
    db.prepare(
      `INSERT INTO outbox (
        outbox_id, chat_key, delivery_kind, state, payload_json,
        sequence, created_at, updated_at
      ) VALUES ('in-flight-interim', ?, 'interim', 'sending', '{}', 1, ?, ?)`,
    ).run(
      "telegram/7:42",
      "2026-07-14T00:00:00.000Z",
      "2026-07-14T00:00:00.000Z",
    );
    assert.throws(
      () =>
        chatDatabase.advanceChatGeneration(agentDir, "telegram/7:42", {
          sessionFile: "sessions/new.jsonl",
        }),
      /chat_generation_nonterminal_send_in_flight/,
    );
    assert.equal(
      chatDatabase.readChatSessionBinding(agentDir, "telegram/7:42"),
      "sessions/old.jsonl",
    );
    db.prepare(`UPDATE outbox SET state = 'failed' WHERE outbox_id = ?`).run(
      "in-flight-interim",
    );
    assert.deepEqual(
      chatDatabase.advanceChatGeneration(agentDir, "telegram/7:42", {
        sessionFile: "sessions/new.jsonl",
      }),
      { previousGeneration: 0, currentGeneration: 1 },
    );
    assert.equal(
      chatDatabase.readChatSessionBinding(agentDir, "telegram/7:42"),
      "sessions/new.jsonl",
    );
    assert.deepEqual(
      chatDatabase.allocateChatSequence(agentDir, "telegram/7:42"),
      { sequence: 3, generation: 1 },
    );
    assert.deepEqual(chatDatabase.readChatState(agentDir, "telegram/7:42"), {
      chatKey: "telegram/7:42",
      currentGeneration: 1,
      nextSequence: 4,
    });
  });
});

test("chat database fences acceptance and session binding updates", async () => {
  await withTempDir(async (agentDir) => {
    const chatKey = "telegram/7:42";
    const db = chatDatabase.openChatDatabase(agentDir);
    chatDatabase.readChatState(agentDir, chatKey);
    chatDatabase.writeChatSessionBinding(agentDir, chatKey, "current.jsonl");
    db.prepare(
      `INSERT INTO messages (
        id, record_key, chat_key, message_id, platform, chat_id, role,
        received_at, sequence, generation, disposition, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, 'user', ?, 1, 0, 'actionable', '{}')`,
    ).run(
      "fenced-message",
      "fenced-record",
      chatKey,
      "fenced-provider-message",
      "telegram",
      "42",
      "2026-07-14T00:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO inbox_jobs (
        turn_id, inbound_message_id, chat_key, generation, sequence,
        state, owner_epoch, attempt, created_at, updated_at
      ) VALUES (?, ?, ?, 0, 1, 'running', ?, 2, ?, ?)`,
    ).run(
      "fenced-turn",
      "fenced-message",
      chatKey,
      "current-owner",
      "2026-07-14T00:00:00.000Z",
      "2026-07-14T00:00:00.000Z",
    );
    const staleFence = {
      turnId: "fenced-turn",
      chatKey,
      messageId: "fenced-provider-message",
      ownerEpoch: "stale-owner",
      attempt: 1,
    };
    const currentFence = {
      ...staleFence,
      ownerEpoch: "current-owner",
      attempt: 2,
    };

    assert.throws(
      () =>
        chatDatabase.advanceChatGeneration(agentDir, chatKey, {
          sessionFile: "stale-new-session.jsonl",
          turnFence: staleFence,
        }),
      /chat_turn_fence_lost/,
    );
    assert.equal(
      chatDatabase.readChatState(agentDir, chatKey).currentGeneration,
      0,
    );
    assert.equal(
      chatDatabase.readChatSessionBinding(agentDir, chatKey),
      "current.jsonl",
    );
    assert.equal(
      chatDatabase.markChatMessageAcceptedWithFence(agentDir, staleFence, {
        sessionFile: "stale.jsonl",
      }),
      false,
    );
    assert.equal(
      chatDatabase.writeChatSessionBindingWithFence(
        agentDir,
        staleFence,
        "stale.jsonl",
      ),
      false,
    );
    assert.equal(
      chatDatabase.readChatSessionBinding(agentDir, chatKey),
      "current.jsonl",
    );
    assert.equal(
      chatDatabase.markChatMessageAcceptedWithFence(agentDir, currentFence, {
        sessionFile: "accepted.jsonl",
      }),
      true,
    );
    assert.equal(
      db
        .prepare(
          `SELECT execution_session_file FROM inbox_jobs WHERE turn_id = ?`,
        )
        .get("fenced-turn").execution_session_file,
      "accepted.jsonl",
    );
    assert.equal(
      chatDatabase.markChatMessageAcceptedWithFence(agentDir, currentFence, {
        sessionFile: "different.jsonl",
      }),
      false,
    );
    assert.equal(
      chatDatabase.completeChatTurnWithoutDelivery(agentDir, currentFence, {
        sessionFile: "different.jsonl",
      }),
      false,
    );
    db.prepare(
      `INSERT INTO outbox (
        outbox_id, turn_id, chat_key, delivery_kind, state, payload_json,
        sequence, created_at, updated_at
      ) VALUES (?, ?, ?, 'interim', 'queued', '{}', 1, ?, ?)`,
    ).run(
      "fenced-interim",
      "fenced-turn",
      chatKey,
      "2026-07-14T00:00:00.000Z",
      "2026-07-14T00:00:00.000Z",
    );
    assert.equal(
      chatDatabase.writeChatSessionBindingWithFence(
        agentDir,
        currentFence,
        "accepted.jsonl",
      ),
      true,
    );
  });
});

test("chat database rejects stale workers through owner epoch and attempt fencing", async () => {
  await withTempDir(async (agentDir) => {
    const db = chatDatabase.openChatDatabase(agentDir);
    db.prepare(
      `INSERT INTO messages (
        id, record_key, chat_key, message_id, platform, chat_id, role,
        received_at, sequence, generation, disposition, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, 'user', ?, ?, ?, 'actionable', ?)`,
    ).run(
      "message-1",
      "record-1",
      "telegram/7:42",
      "provider-message-1",
      "telegram",
      "42",
      "2026-07-14T00:00:00.000Z",
      1,
      0,
      "{}",
    );
    db.prepare(
      `INSERT INTO inbox_jobs (
        turn_id, inbound_message_id, chat_key, generation, sequence,
        state, owner_epoch, attempt, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
    ).run(
      "turn-1",
      "message-1",
      "telegram/7:42",
      0,
      1,
      "epoch-new",
      2,
      "2026-07-14T00:00:00.000Z",
      "2026-07-14T00:00:00.000Z",
    );

    assert.equal(
      chatDatabase.updateTurnWithFence(agentDir, {
        turnId: "turn-1",
        ownerEpoch: "epoch-old",
        attempt: 1,
        state: "terminal",
      }),
      false,
    );
    assert.equal(
      chatDatabase.updateTurnWithFence(agentDir, {
        turnId: "turn-1",
        ownerEpoch: "epoch-new",
        attempt: 2,
        state: "terminal",
      }),
      true,
    );
    assert.equal(
      db.prepare(`SELECT state FROM inbox_jobs WHERE turn_id = ?`).get("turn-1")
        .state,
      "terminal",
    );
  });
});

test("install migration retires the removed application terminal WAL directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-wal-retire-"));
  const agentDir = path.join(root, "agent");
  try {
    const walDir = path.join(agentDir, "data", "chat", "terminal-wal");
    await fs.mkdir(walDir, { recursive: true });
    await fs.writeFile(path.join(walDir, "legacy.json"), "{legacy-evidence}");
    chatDatabase.migrateChatDatabaseForInstall(agentDir, {
      runtimeQuiesced: true,
    });
    chatDatabase.closeChatDatabase(agentDir);
    await assert.rejects(fs.access(walDir));
    const entries = await fs.readdir(path.dirname(walDir));
    const retired = entries.find((entry) =>
      entry.startsWith("terminal-wal-retired-"),
    );
    assert.ok(retired);
    assert.equal(
      await fs.readFile(
        path.join(path.dirname(walDir), retired, "legacy.json"),
        "utf8",
      ),
      "{legacy-evidence}",
    );
  } finally {
    chatDatabase.closeChatDatabase(agentDir);
    await fs.rm(root, { recursive: true, force: true });
  }
});
