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
        "messages",
        "outbox",
        "outbox_deliveries",
        "schema_meta",
        "turns",
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

test("chat database reopens the current version 6 durable admission layout", async () => {
  await withTempDir(async (agentDir) => {
    const created = chatDatabase.openChatDatabase(agentDir);
    assert.equal(created.pragma("user_version", { simple: true }), 6);
    assert.deepEqual(
      created
        .prepare(`PRAGMA table_info(turns)`)
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
    assert.equal(reopened.pragma("user_version", { simple: true }), 6);
    assert.equal(
      reopened
        .prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`)
        .get().value,
      "6",
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
    assert.equal(migrated.pragma("user_version", { simple: true }), 6);
    assert.equal(
      migrated
        .prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`)
        .get().value,
      "6",
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
    assert.equal(migrated.pragma("user_version", { simple: true }), 6);
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
    assert.equal(migrated.pragma("user_version", { simple: true }), 6);
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
    assert.equal(migrated.pragma("user_version", { simple: true }), 6);
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

test("chat install migration terminalizes ambiguous accepted version 5 turns", async () => {
  await withTempDir(async (agentDir) => {
    const db = chatDatabase.openChatDatabase(agentDir);
    db.prepare(
      `INSERT INTO chat_state (
         chat_key, current_generation, next_sequence, updated_at
       ) VALUES (?, 0, 2, ?)`,
    ).run("telegram/1:2", "2026-07-23T00:00:00.000Z");
    db.prepare(
      `INSERT INTO messages (
         id, record_key, chat_key, message_id, platform, chat_id,
         session_file, accepted_at, received_at, sequence, generation,
         disposition, record_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'record_only', '{}')`,
    ).run(
      "legacy-message",
      "legacy-record",
      "telegram/1:2",
      "legacy-accepted",
      "telegram",
      "2",
      "/tmp/legacy-accepted.jsonl",
      "2026-07-23T00:00:01.000Z",
      "2026-07-23T00:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO turns (
         turn_id, inbound_message_id, chat_key, generation, sequence, state,
         attempt, created_at, updated_at
       ) VALUES (?, ?, ?, 0, 1, 'pending', 1, ?, ?)`,
    ).run(
      "legacy-turn",
      "legacy-message",
      "telegram/1:2",
      "2026-07-23T00:00:00.000Z",
      "2026-07-23T00:00:00.000Z",
    );
    dropDurableAdmissionColumns(db);
    db.exec(`
      UPDATE schema_meta SET value = '5' WHERE key = 'schema_version';
      PRAGMA user_version = 5;
    `);
    const objects = db
      .prepare(
        `SELECT type, name, sql FROM sqlite_master
         WHERE type IN ('table', 'index', 'trigger', 'view')
           AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
         ORDER BY type, name`,
      )
      .all();
    db.prepare(
      `UPDATE schema_meta SET value = ? WHERE key = 'schema_fingerprint'`,
    ).run(createHash("sha256").update(JSON.stringify(objects)).digest("hex"));
    chatDatabase.closeChatDatabase(agentDir);

    const migrated = chatDatabase.migrateChatDatabaseForInstall(agentDir);
    assert.equal(migrated.pragma("user_version", { simple: true }), 6);
    assert.deepEqual(
      migrated
        .prepare(
          `SELECT state, terminal_kind, admission_state, admission_json,
                  execution_session_file
           FROM turns WHERE turn_id = 'legacy-turn'`,
        )
        .get(),
      {
        state: "terminal",
        terminal_kind: "interrupted_unknown",
        admission_state: "unclassified",
        admission_json: null,
        execution_session_file: "/tmp/legacy-accepted.jsonl",
      },
    );
    assert.equal(
      migrated
        .prepare(
          `SELECT COUNT(*) AS count FROM outbox
            WHERE turn_id = 'legacy-turn' AND delivery_kind = 'error'`,
        )
        .get().count,
      1,
    );
  });
});

test("chat install migration terminalizes version 5 record-only turns without runtime admission", async () => {
  await withTempDir(async (agentDir) => {
    const db = chatDatabase.openChatDatabase(agentDir);
    db.prepare(
      `INSERT INTO chat_state (
         chat_key, current_generation, next_sequence, updated_at
       ) VALUES (?, 0, 2, ?)`,
    ).run("telegram/1:2", "2026-07-23T00:00:00.000Z");
    db.prepare(
      `INSERT INTO messages (
         id, record_key, chat_key, message_id, platform, chat_id,
         received_at, sequence, generation, disposition, record_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 'record_only', '{}')`,
    ).run(
      "legacy-record-only-message",
      "legacy-record-only-record",
      "telegram/1:2",
      "legacy-record-only",
      "telegram",
      "2",
      "2026-07-23T00:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO turns (
         turn_id, inbound_message_id, chat_key, generation, sequence, state,
         attempt, created_at, updated_at
       ) VALUES (?, ?, ?, 0, 1, 'pending', 1, ?, ?)`,
    ).run(
      "legacy-record-only-turn",
      "legacy-record-only-message",
      "telegram/1:2",
      "2026-07-23T00:00:00.000Z",
      "2026-07-23T00:00:00.000Z",
    );
    dropDurableAdmissionColumns(db);
    db.exec(`
      UPDATE schema_meta SET value = '5' WHERE key = 'schema_version';
      PRAGMA user_version = 5;
    `);
    const objects = db
      .prepare(
        `SELECT type, name, sql FROM sqlite_master
         WHERE type IN ('table', 'index', 'trigger', 'view')
           AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
         ORDER BY type, name`,
      )
      .all();
    db.prepare(
      `UPDATE schema_meta SET value = ? WHERE key = 'schema_fingerprint'`,
    ).run(createHash("sha256").update(JSON.stringify(objects)).digest("hex"));
    chatDatabase.closeChatDatabase(agentDir);

    const migrated = chatDatabase.migrateChatDatabaseForInstall(agentDir);
    assert.deepEqual(
      migrated
        .prepare(
          `SELECT state, terminal_kind, admission_state, admission_json,
                  admission_hash
             FROM turns WHERE turn_id = 'legacy-record-only-turn'`,
        )
        .get(),
      {
        state: "terminal",
        terminal_kind: "record_only",
        admission_state: "unclassified",
        admission_json: null,
        admission_hash: null,
      },
    );
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
    assert.equal(db.pragma("user_version", { simple: true }), 6);
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

test("chat database fences accepted, session binding, and superseded updates", async () => {
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
      `INSERT INTO turns (
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
        .prepare(`SELECT execution_session_file FROM turns WHERE turn_id = ?`)
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
    assert.equal(
      chatDatabase.supersedeChatTurnWithFence(agentDir, currentFence),
      true,
    );
    assert.deepEqual(
      db
        .prepare(
          `SELECT turns.state, messages.disposition, messages.processed_at
           FROM turns JOIN messages ON messages.id = turns.inbound_message_id
           WHERE turns.turn_id = ?`,
        )
        .get("fenced-turn"),
      {
        state: "superseded",
        disposition: "superseded",
        processed_at: null,
      },
    );
    assert.deepEqual(
      db
        .prepare(
          `SELECT state, failure_kind, last_error
           FROM outbox WHERE outbox_id = 'fenced-interim'`,
        )
        .get(),
      {
        state: "failed",
        failure_kind: "permanent",
        last_error: "chat_outbox_turn_superseded",
      },
    );
    assert.equal(
      chatDatabase.markChatMessageAcceptedWithFence(agentDir, currentFence),
      false,
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
      `INSERT INTO turns (
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
      db.prepare(`SELECT state FROM turns WHERE turn_id = ?`).get("turn-1")
        .state,
      "terminal",
    );
  });
});
