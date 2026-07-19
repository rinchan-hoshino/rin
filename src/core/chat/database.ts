import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import BetterSqlite3 from "better-sqlite3";

import { chatDataPath } from "../data-layout.js";
import { safeString } from "../text-utils.js";
import {
  migrateLegacyChatControlData,
  readLegacyControlMigrationPreservedSummary,
} from "./legacy-migration.js";

const CHAT_DATABASE_SCHEMA_VERSION = 5;

const databaseCache = new Map<string, BetterSqlite3.Database>();

export type ChatDatabaseState = {
  chatKey: string;
  currentGeneration: number;
  nextSequence: number;
};

export type ChatTurnState =
  | "pending"
  | "running"
  | "terminal"
  | "failed"
  | "superseded";

function nowIso() {
  return new Date().toISOString();
}

function requiredText(value: unknown, error: string) {
  const text = safeString(value).trim();
  if (!text) throw new Error(error);
  return text;
}

export function chatDatabasePath(agentDir: string) {
  return chatDataPath(path.resolve(agentDir), "chat.sqlite");
}

function chatDatabaseSchemaFingerprint(db: BetterSqlite3.Database) {
  const objects = db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
       WHERE type IN ('table', 'index', 'trigger', 'view')
         AND name NOT LIKE 'sqlite_%'
         AND sql IS NOT NULL
       ORDER BY type, name`,
    )
    .all();
  return createHash("sha256").update(JSON.stringify(objects)).digest("hex");
}

const CHAT_DATABASE_TABLES = [
  "chat_state",
  "inbound_heads",
  "messages",
  "outbox",
  "outbox_deliveries",
  "schema_meta",
  "turns",
] as const;

function setWalJournalMode(db: BetterSqlite3.Database) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      db.pragma("journal_mode = WAL");
      return;
    } catch (error: any) {
      if (error?.code !== "SQLITE_BUSY" || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

function configureChatDatabase(db: BetterSqlite3.Database) {
  // Configure connection behavior before journal_mode, which can itself need
  // a write lock during concurrent cold opens.
  db.pragma("busy_timeout = 120000");
  setWalJournalMode(db);
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
}

function readChatDatabaseTables(db: BetterSqlite3.Database) {
  return new Set(
    (
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
}

function validateRecordedChatDatabaseSchema(
  db: BetterSqlite3.Database,
  version: number,
) {
  const currentTables = readChatDatabaseTables(db);
  if (CHAT_DATABASE_TABLES.some((table) => !currentTables.has(table))) {
    throw new Error("chat_database_incomplete_schema");
  }
  const storedVersion = Number(
    (
      db
        .prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`)
        .get() as any
    )?.value,
  );
  if (storedVersion !== version) {
    throw new Error("chat_database_schema_version_mismatch");
  }
  const storedFingerprint = safeString(
    (
      db
        .prepare(
          `SELECT value FROM schema_meta WHERE key = 'schema_fingerprint'`,
        )
        .get() as any
    )?.value,
  ).trim();
  if (
    !storedFingerprint ||
    storedFingerprint !== chatDatabaseSchemaFingerprint(db)
  ) {
    throw new Error("chat_database_schema_fingerprint_mismatch");
  }
}

function initializeChatDatabase(db: BetterSqlite3.Database) {
  configureChatDatabase(db);

  db.transaction(() => {
    const readTables = () => readChatDatabaseTables(db);
    const validateRecordedSchema = (version: number) =>
      validateRecordedChatDatabaseSchema(db, version);
    const currentVersion = Number(db.pragma("user_version", { simple: true }));
    if (currentVersion > CHAT_DATABASE_SCHEMA_VERSION) {
      throw new Error(`chat_database_future_schema:${currentVersion}`);
    }
    const finishSchemaUpgrade = () => {
      db.prepare(
        `UPDATE schema_meta SET value = ? WHERE key = 'schema_version'`,
      ).run(String(CHAT_DATABASE_SCHEMA_VERSION));
      db.prepare(
        `UPDATE schema_meta SET value = ? WHERE key = 'schema_fingerprint'`,
      ).run(chatDatabaseSchemaFingerprint(db));
      db.pragma(`user_version = ${CHAT_DATABASE_SCHEMA_VERSION}`);
    };
    const inboundRecoveryLeaseUpgradeSql = `
      ALTER TABLE inbound_heads ADD COLUMN recovery_failure_count INTEGER NOT NULL DEFAULT 0
        CHECK (recovery_failure_count >= 0);
      ALTER TABLE inbound_heads ADD COLUMN recovery_first_failed_at TEXT;
      ALTER TABLE inbound_heads ADD COLUMN recovery_last_failed_at TEXT;
      ALTER TABLE inbound_heads ADD COLUMN recovery_paused_at TEXT;
      ALTER TABLE inbound_heads ADD COLUMN recovery_next_attempt_at TEXT;
      ALTER TABLE inbound_heads ADD COLUMN recovery_version INTEGER NOT NULL DEFAULT 0
        CHECK (recovery_version >= 0);
      CREATE INDEX inbound_heads_recovery_idx
        ON inbound_heads(platform, bot_id, recovery_next_attempt_at, chat_key);
    `;
    if (currentVersion === 1) {
      validateRecordedSchema(1);
      db.exec(`
        DROP INDEX outbox_turn_terminal_idx;
        CREATE UNIQUE INDEX outbox_turn_terminal_idx
          ON outbox(turn_id)
          WHERE turn_id IS NOT NULL
            AND (delivery_kind IN ('final', 'error', 'command_ack')
                 OR post_delivery_json IS NOT NULL);
        ALTER TABLE chat_state ADD COLUMN session_file TEXT;
        ALTER TABLE chat_state ADD COLUMN legacy_session_imported INTEGER NOT NULL DEFAULT 0
          CHECK (legacy_session_imported IN (0, 1));
        ALTER TABLE outbox ADD COLUMN dispatch_started_at TEXT;
        ${inboundRecoveryLeaseUpgradeSql}
      `);
      finishSchemaUpgrade();
      return;
    }
    if (currentVersion === 2) {
      validateRecordedSchema(2);
      db.exec(`
        ALTER TABLE chat_state ADD COLUMN session_file TEXT;
        ALTER TABLE chat_state ADD COLUMN legacy_session_imported INTEGER NOT NULL DEFAULT 0
          CHECK (legacy_session_imported IN (0, 1));
        ALTER TABLE outbox ADD COLUMN dispatch_started_at TEXT;
        ${inboundRecoveryLeaseUpgradeSql}
      `);
      finishSchemaUpgrade();
      return;
    }
    if (currentVersion === 3) {
      validateRecordedSchema(3);
      db.exec(`
        ALTER TABLE outbox ADD COLUMN dispatch_started_at TEXT;
        ${inboundRecoveryLeaseUpgradeSql}
      `);
      finishSchemaUpgrade();
      return;
    }
    if (currentVersion === 4) {
      validateRecordedSchema(4);
      db.exec(inboundRecoveryLeaseUpgradeSql);
      finishSchemaUpgrade();
      return;
    }
    if (currentVersion === CHAT_DATABASE_SCHEMA_VERSION) {
      validateRecordedSchema(CHAT_DATABASE_SCHEMA_VERSION);
      return;
    }
    if (currentVersion !== 0) {
      throw new Error(`chat_database_unsupported_schema:${currentVersion}`);
    }
    const existingTables = readTables();
    if (existingTables.size) {
      throw new Error("chat_database_partial_schema");
    }

    db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_state (
      chat_key TEXT PRIMARY KEY,
      current_generation INTEGER NOT NULL DEFAULT 0 CHECK (current_generation >= 0),
      next_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_sequence >= 1),
      session_file TEXT,
      legacy_session_imported INTEGER NOT NULL DEFAULT 0
        CHECK (legacy_session_imported IN (0, 1)),
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      record_key TEXT NOT NULL UNIQUE,
      chat_key TEXT NOT NULL,
      message_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      bot_id TEXT,
      chat_id TEXT NOT NULL,
      role TEXT CHECK (role IN ('user', 'assistant') OR role IS NULL),
      reply_to_message_id TEXT,
      session_file TEXT,
      accepted_at TEXT,
      processed_at TEXT,
      delivery_kind TEXT,
      last_received_at TEXT,
      duplicate_count INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
      updated_at TEXT,
      chat_thread_id TEXT,
      message_thread_id TEXT,
      chat_type TEXT CHECK (chat_type IN ('private', 'group') OR chat_type IS NULL),
      received_at TEXT NOT NULL,
      platform_timestamp INTEGER,
      provider_cursor TEXT,
      user_id TEXT,
      nickname TEXT,
      chat_name TEXT,
      trust TEXT,
      text TEXT,
      raw_content TEXT,
      stripped_content TEXT,
      elements_json TEXT,
      quote_json TEXT,
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      generation INTEGER NOT NULL CHECK (generation >= 0),
      disposition TEXT NOT NULL DEFAULT 'unclassified'
        CHECK (disposition IN ('unclassified', 'record_only', 'actionable', 'superseded')),
      record_json TEXT NOT NULL,
      UNIQUE (chat_key, message_id),
      UNIQUE (chat_key, sequence)
    );

    CREATE INDEX IF NOT EXISTS messages_message_id_idx
      ON messages(message_id);
    CREATE INDEX IF NOT EXISTS messages_chat_order_idx
      ON messages(chat_key, sequence);
    CREATE INDEX IF NOT EXISTS messages_chat_date_idx
      ON messages(chat_key, received_at, record_key);
    CREATE INDEX IF NOT EXISTS messages_chat_processed_date_idx
      ON messages(chat_key, processed_at, record_key)
      WHERE received_at = '';
    CREATE INDEX IF NOT EXISTS messages_reply_idx
      ON messages(chat_key, reply_to_message_id, processed_at)
      WHERE reply_to_message_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS messages_recovery_head_idx
      ON messages(platform, bot_id, chat_key, platform_timestamp, sequence)
      WHERE role = 'user';
    CREATE INDEX IF NOT EXISTS messages_disposition_idx
      ON messages(disposition, chat_key, sequence);
    CREATE INDEX IF NOT EXISTS messages_orphan_recovery_idx
      ON messages(disposition, role, accepted_at, chat_key, sequence)
      WHERE role = 'user';

    CREATE TABLE IF NOT EXISTS inbound_heads (
      platform TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      chat_key TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      platform_timestamp INTEGER,
      received_at TEXT NOT NULL,
      provider_cursor TEXT,
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      updated_at TEXT NOT NULL,
      recovery_failure_count INTEGER NOT NULL DEFAULT 0
        CHECK (recovery_failure_count >= 0),
      recovery_first_failed_at TEXT,
      recovery_last_failed_at TEXT,
      recovery_paused_at TEXT,
      recovery_next_attempt_at TEXT,
      recovery_version INTEGER NOT NULL DEFAULT 0
        CHECK (recovery_version >= 0),
      PRIMARY KEY (platform, bot_id, chat_key)
    );

    CREATE INDEX IF NOT EXISTS inbound_heads_recovery_idx
      ON inbound_heads(platform, bot_id, recovery_next_attempt_at, chat_key);

    CREATE TABLE IF NOT EXISTS turns (
      turn_id TEXT PRIMARY KEY,
      inbound_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE RESTRICT,
      chat_key TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 0),
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      state TEXT NOT NULL
        CHECK (state IN ('pending', 'running', 'terminal', 'failed', 'superseded')),
      terminal_kind TEXT,
      owner_epoch TEXT,
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      lease_until TEXT,
      heartbeat_at TEXT,
      next_attempt_at TEXT,
      last_error TEXT,
      routing_json TEXT,
      session_json TEXT,
      elements_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS turns_claim_idx
      ON turns(state, next_attempt_at, lease_until, chat_key, sequence);
    CREATE INDEX IF NOT EXISTS turns_chat_generation_idx
      ON turns(chat_key, generation, state, sequence);

    CREATE TABLE IF NOT EXISTS outbox (
      outbox_id TEXT PRIMARY KEY,
      turn_id TEXT REFERENCES turns(turn_id) ON DELETE RESTRICT,
      idempotency_key TEXT UNIQUE,
      chat_key TEXT NOT NULL,
      delivery_kind TEXT NOT NULL,
      state TEXT NOT NULL
        CHECK (state IN ('queued', 'planned', 'sending', 'delivered', 'failed')),
      payload_json TEXT NOT NULL,
      post_delivery_json TEXT,
      post_delivery_applied_at TEXT,
      adapter_id TEXT,
      adapter_version TEXT,
      plan_state TEXT NOT NULL DEFAULT 'unplanned'
        CHECK (plan_state IN ('unplanned', 'planned')),
      sequence INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      owner_epoch TEXT,
      lease_until TEXT,
      next_attempt_at TEXT,
      last_error TEXT,
      failure_kind TEXT,
      delivery_unconfirmed INTEGER NOT NULL DEFAULT 0 CHECK (delivery_unconfirmed IN (0, 1)),
      delivery_result_json TEXT,
      dispatch_started_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      delivered_at TEXT,
      failed_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS outbox_turn_terminal_idx
      ON outbox(turn_id)
      WHERE turn_id IS NOT NULL
        AND (delivery_kind IN ('final', 'error', 'command_ack')
             OR post_delivery_json IS NOT NULL);
    CREATE INDEX IF NOT EXISTS outbox_sequence_idx
      ON outbox(sequence);
    CREATE INDEX IF NOT EXISTS outbox_drain_idx
      ON outbox(state, next_attempt_at, sequence);
    CREATE INDEX IF NOT EXISTS outbox_delivered_cleanup_idx
      ON outbox(delivered_at)
      WHERE state = 'delivered';
    CREATE INDEX IF NOT EXISTS outbox_failed_cleanup_idx
      ON outbox(failed_at)
      WHERE state = 'failed';
    CREATE INDEX IF NOT EXISTS outbox_post_delivery_pending_idx
      ON outbox(post_delivery_applied_at, sequence)
      WHERE post_delivery_json IS NOT NULL
        AND post_delivery_applied_at IS NULL
        AND state IN ('queued', 'sending', 'delivered');

    CREATE TABLE IF NOT EXISTS outbox_deliveries (
      delivery_id TEXT PRIMARY KEY,
      outbox_id TEXT NOT NULL REFERENCES outbox(outbox_id) ON DELETE CASCADE,
      destination TEXT NOT NULL,
      fragment_index INTEGER NOT NULL CHECK (fragment_index >= 0),
      state TEXT NOT NULL
        CHECK (state IN ('queued', 'sending', 'delivered', 'failed', 'unconfirmed')),
      payload_json TEXT NOT NULL,
      owner_epoch TEXT,
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      lease_until TEXT,
      next_attempt_at TEXT,
      last_error TEXT,
      provider_message_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      delivered_at TEXT,
      failed_at TEXT,
      UNIQUE (outbox_id, destination, fragment_index)
    );

    CREATE INDEX IF NOT EXISTS outbox_deliveries_claim_idx
      ON outbox_deliveries(state, next_attempt_at, lease_until, outbox_id, destination, fragment_index);

      INSERT INTO schema_meta (key, value)
      VALUES ('schema_version', '${CHAT_DATABASE_SCHEMA_VERSION}');
    `);
    db.prepare(
      `INSERT INTO schema_meta (key, value)
       VALUES ('schema_fingerprint', ?)`,
    ).run(chatDatabaseSchemaFingerprint(db));
    db.pragma(`user_version = ${CHAT_DATABASE_SCHEMA_VERSION}`);
    const createdTables = readTables();
    if (CHAT_DATABASE_TABLES.some((table) => !createdTables.has(table))) {
      throw new Error("chat_database_incomplete_schema");
    }
  }).immediate();
}

export function preflightChatDatabaseMigrationForInstall(agentDir: string) {
  const dbPath = chatDatabasePath(agentDir);
  if (!fs.existsSync(dbPath)) {
    return {
      path: dbPath,
      fromVersion: 0,
      toVersion: CHAT_DATABASE_SCHEMA_VERSION,
    };
  }
  const db = new BetterSqlite3(dbPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const currentVersion = Number(db.pragma("user_version", { simple: true }));
    if (currentVersion > CHAT_DATABASE_SCHEMA_VERSION) {
      throw new Error(`chat_database_future_schema:${currentVersion}`);
    }
    if (currentVersion === 0) {
      if (readChatDatabaseTables(db).size) {
        throw new Error("chat_database_partial_schema");
      }
    } else {
      validateRecordedChatDatabaseSchema(db, currentVersion);
      readLegacyControlMigrationPreservedSummary(db);
    }
    return {
      path: dbPath,
      fromVersion: currentVersion,
      toVersion: CHAT_DATABASE_SCHEMA_VERSION,
    };
  } finally {
    db.close();
  }
}

export function migrateChatDatabaseForInstall(
  agentDir: string,
): BetterSqlite3.Database {
  const dbPath = chatDatabasePath(agentDir);
  const existing = databaseCache.get(dbPath);
  const db = existing?.open
    ? existing
    : (() => {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        return new BetterSqlite3(dbPath);
      })();
  try {
    initializeChatDatabase(db);
    migrateLegacyChatControlData(agentDir, db);
    databaseCache.set(dbPath, db);
    return db;
  } catch (error) {
    if (!existing?.open) db.close();
    throw error;
  }
}

export function openChatDatabase(agentDir: string): BetterSqlite3.Database {
  const dbPath = chatDatabasePath(agentDir);
  const existing = databaseCache.get(dbPath);
  if (existing?.open) return existing;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const databaseExists = fs.existsSync(dbPath);
  const db = new BetterSqlite3(dbPath);
  try {
    if (!databaseExists) {
      initializeChatDatabase(db);
    } else {
      configureChatDatabase(db);
      const currentVersion = Number(
        db.pragma("user_version", { simple: true }),
      );
      if (currentVersion === 0) {
        // Another process can create the SQLite file before its immediate
        // schema transaction begins. Enter the same initializer so the write
        // lock serializes fresh creation; a true partial schema still fails.
        initializeChatDatabase(db);
      } else if (currentVersion > CHAT_DATABASE_SCHEMA_VERSION) {
        throw new Error(`chat_database_future_schema:${currentVersion}`);
      } else if (currentVersion < CHAT_DATABASE_SCHEMA_VERSION) {
        throw new Error(
          `chat_database_schema_upgrade_required:${currentVersion}:${CHAT_DATABASE_SCHEMA_VERSION}`,
        );
      } else {
        validateRecordedChatDatabaseSchema(db, CHAT_DATABASE_SCHEMA_VERSION);
      }
    }
    databaseCache.set(dbPath, db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function closeChatDatabase(agentDir: string) {
  const dbPath = chatDatabasePath(agentDir);
  const db = databaseCache.get(dbPath);
  databaseCache.delete(dbPath);
  if (db?.open) db.close();
}

export function ensureChatState(db: BetterSqlite3.Database, chatKey: string) {
  const timestamp = nowIso();
  db.prepare(
    `INSERT INTO chat_state (
      chat_key, current_generation, next_sequence, updated_at
    ) VALUES (?, 0, 1, ?)
    ON CONFLICT(chat_key) DO NOTHING`,
  ).run(chatKey, timestamp);
}

export function importLegacyChatSessionBinding(
  agentDir: string,
  chatKeyInput: string,
  sessionFile: unknown,
) {
  const chatKey = requiredText(chatKeyInput, "chat_database_chatKey_required");
  const db = openChatDatabase(agentDir);
  return db
    .transaction(() => {
      ensureChatState(db, chatKey);
      const result = db
        .prepare(
          `UPDATE chat_state
           SET session_file = CASE
                 WHEN session_file IS NULL OR session_file = '' THEN ?
                 ELSE session_file END,
               legacy_session_imported = 1,
               updated_at = ?
           WHERE chat_key = ? AND legacy_session_imported = 0`,
        )
        .run(safeString(sessionFile).trim() || null, nowIso(), chatKey);
      return result.changes === 1;
    })
    .immediate();
}

export function readChatSessionBinding(agentDir: string, chatKeyInput: string) {
  const chatKey = requiredText(chatKeyInput, "chat_database_chatKey_required");
  const db = openChatDatabase(agentDir);
  ensureChatState(db, chatKey);
  return safeString(
    (
      db
        .prepare(`SELECT session_file FROM chat_state WHERE chat_key = ?`)
        .get(chatKey) as any
    )?.session_file,
  ).trim();
}

export function writeChatSessionBinding(
  agentDir: string,
  chatKeyInput: string,
  sessionFile: unknown,
  options: { onlyIfEmpty?: boolean } = {},
) {
  const chatKey = requiredText(chatKeyInput, "chat_database_chatKey_required");
  const db = openChatDatabase(agentDir);
  return db
    .transaction(() => {
      ensureChatState(db, chatKey);
      const result = db
        .prepare(
          `UPDATE chat_state
           SET session_file = ?, updated_at = ?
           WHERE chat_key = ?
             AND (? = 0 OR session_file IS NULL OR session_file = '')`,
        )
        .run(
          safeString(sessionFile).trim() || null,
          nowIso(),
          chatKey,
          options.onlyIfEmpty ? 1 : 0,
        );
      return result.changes === 1;
    })
    .immediate();
}

export function writeChatSessionBindingWithFence(
  agentDir: string,
  fence: {
    turnId: string;
    chatKey: string;
    messageId: string;
    ownerEpoch: string;
    attempt: number;
  },
  sessionFile: unknown,
) {
  const result = openChatDatabase(agentDir)
    .prepare(
      `UPDATE chat_state
       SET session_file = ?, updated_at = ?
       WHERE chat_key = ?
         AND current_generation = (
           SELECT generation FROM turns
           WHERE turn_id = ? AND chat_key = ? AND state = 'running'
             AND owner_epoch = ? AND attempt = ?
             AND inbound_message_id = (
               SELECT id FROM messages
               WHERE chat_key = ? AND message_id = ?
             )
         )`,
    )
    .run(
      safeString(sessionFile).trim() || null,
      nowIso(),
      requiredText(fence.chatKey, "chat_turn_chat_key_required"),
      requiredText(fence.turnId, "chat_turn_id_required"),
      requiredText(fence.chatKey, "chat_turn_chat_key_required"),
      requiredText(fence.ownerEpoch, "chat_turn_owner_epoch_required"),
      Math.max(0, Math.floor(Number(fence.attempt || 0))),
      requiredText(fence.chatKey, "chat_turn_chat_key_required"),
      requiredText(fence.messageId, "chat_turn_message_id_required"),
    );
  return result.changes === 1;
}

function normalizeChatState(row: any, chatKey: string): ChatDatabaseState {
  return {
    chatKey,
    currentGeneration: Math.max(0, Number(row?.current_generation || 0)),
    nextSequence: Math.max(1, Number(row?.next_sequence || 1)),
  };
}

export function readChatState(
  agentDir: string,
  chatKeyInput: string,
): ChatDatabaseState {
  const chatKey = requiredText(chatKeyInput, "chat_database_chatKey_required");
  const db = openChatDatabase(agentDir);
  return normalizeChatState(
    db
      .prepare(
        `SELECT current_generation, next_sequence
         FROM chat_state
         WHERE chat_key = ?`,
      )
      .get(chatKey),
    chatKey,
  );
}

export function allocateChatSequenceInDatabase(
  db: BetterSqlite3.Database,
  chatKeyInput: string,
) {
  const chatKey = requiredText(chatKeyInput, "chat_database_chatKey_required");
  ensureChatState(db, chatKey);
  const row = db
    .prepare(
      `SELECT current_generation, next_sequence
       FROM chat_state
       WHERE chat_key = ?`,
    )
    .get(chatKey) as any;
  const sequence = Math.max(1, Number(row.next_sequence));
  const generation = Math.max(0, Number(row.current_generation));
  db.prepare(
    `UPDATE chat_state
     SET next_sequence = ?, updated_at = ?
     WHERE chat_key = ?`,
  ).run(sequence + 1, nowIso(), chatKey);
  return { sequence, generation };
}

export function allocateChatSequence(agentDir: string, chatKeyInput: string) {
  const chatKey = requiredText(chatKeyInput, "chat_database_chatKey_required");
  const db = openChatDatabase(agentDir);
  return db
    .transaction(() => allocateChatSequenceInDatabase(db, chatKey))
    .immediate();
}

export function advanceChatGeneration(
  agentDir: string,
  chatKeyInput: string,
  options: {
    preserveInboundMessageId?: string;
    sessionFile?: string;
    turnFence?: ChatTurnFenceInput;
    resolveNonterminalSends?: boolean;
  } = {},
) {
  const chatKey = requiredText(chatKeyInput, "chat_database_chatKey_required");
  const db = openChatDatabase(agentDir);
  return db
    .transaction(() => {
      ensureChatState(db, chatKey);
      if (options.turnFence) {
        const fence = options.turnFence;
        const owned = db
          .prepare(
            `SELECT 1
             FROM turns
             JOIN messages ON messages.id = turns.inbound_message_id
             JOIN chat_state ON chat_state.chat_key = turns.chat_key
             WHERE turns.turn_id = ? AND turns.chat_key = ?
               AND messages.message_id = ? AND turns.state = 'running'
               AND turns.owner_epoch = ? AND turns.attempt = ?
               AND turns.generation = chat_state.current_generation`,
          )
          .get(
            requiredText(fence.turnId, "chat_turn_id_required"),
            requiredText(fence.chatKey, "chat_turn_chat_key_required"),
            requiredText(fence.messageId, "chat_turn_message_id_required"),
            requiredText(fence.ownerEpoch, "chat_turn_owner_epoch_required"),
            Math.max(0, Math.floor(Number(fence.attempt || 0))),
          );
        if (!owned || fence.chatKey !== chatKey) {
          throw new Error("chat_turn_fence_lost");
        }
      }
      if (options.resolveNonterminalSends) {
        const resolutionTime = nowIso();
        db.prepare(
          `UPDATE outbox_deliveries
           SET state = CASE
                 WHEN EXISTS (
                   SELECT 1 FROM outbox
                   WHERE outbox.outbox_id = outbox_deliveries.outbox_id
                     AND outbox.dispatch_started_at IS NOT NULL
                 ) THEN 'unconfirmed' ELSE 'failed' END,
               owner_epoch = NULL, lease_until = NULL,
               last_error = CASE
                 WHEN EXISTS (
                   SELECT 1 FROM outbox
                   WHERE outbox.outbox_id = outbox_deliveries.outbox_id
                     AND outbox.dispatch_started_at IS NOT NULL
                 ) THEN 'chat_outbox_reset_ambiguous'
                 ELSE 'chat_outbox_turn_superseded' END,
               failed_at = CASE
                 WHEN EXISTS (
                   SELECT 1 FROM outbox
                   WHERE outbox.outbox_id = outbox_deliveries.outbox_id
                     AND outbox.dispatch_started_at IS NULL
                 ) THEN ? ELSE NULL END,
               updated_at = ?
           WHERE state = 'sending' AND EXISTS (
             SELECT 1 FROM outbox
             WHERE outbox.outbox_id = outbox_deliveries.outbox_id
               AND outbox.chat_key = ? AND outbox.state = 'sending'
               AND outbox.delivery_kind NOT IN ('final', 'error', 'command_ack')
               AND outbox.post_delivery_json IS NULL
           )`,
        ).run(resolutionTime, resolutionTime, chatKey);
        db.prepare(
          `UPDATE outbox
           SET state = CASE WHEN dispatch_started_at IS NOT NULL
                         THEN 'delivered' ELSE 'failed' END,
               owner_epoch = NULL, lease_until = NULL, next_attempt_at = NULL,
               last_error = CASE WHEN dispatch_started_at IS NOT NULL
                              THEN 'chat_outbox_reset_ambiguous'
                              ELSE 'chat_outbox_turn_superseded' END,
               failure_kind = CASE WHEN dispatch_started_at IS NULL
                                THEN 'permanent' ELSE NULL END,
               delivery_unconfirmed = CASE WHEN dispatch_started_at IS NOT NULL
                                        THEN 1 ELSE 0 END,
               delivered_at = CASE WHEN dispatch_started_at IS NOT NULL
                                THEN ? ELSE NULL END,
               failed_at = CASE WHEN dispatch_started_at IS NULL
                             THEN ? ELSE NULL END,
               updated_at = ?
           WHERE chat_key = ? AND state = 'sending'
             AND delivery_kind NOT IN ('final', 'error', 'command_ack')
             AND post_delivery_json IS NULL`,
        ).run(resolutionTime, resolutionTime, resolutionTime, chatKey);
      }
      const inFlightNonterminal = db
        .prepare(
          `SELECT 1 FROM outbox
           WHERE chat_key = ? AND state = 'sending'
             AND delivery_kind NOT IN ('final', 'error', 'command_ack')
             AND post_delivery_json IS NULL
           LIMIT 1`,
        )
        .get(chatKey);
      if (inFlightNonterminal) {
        throw new Error("chat_generation_nonterminal_send_in_flight");
      }
      const current = db
        .prepare(`SELECT current_generation FROM chat_state WHERE chat_key = ?`)
        .get(chatKey) as any;
      const previousGeneration = Math.max(
        0,
        Number(current.current_generation || 0),
      );
      const currentGeneration = previousGeneration + 1;
      const timestamp = nowIso();
      const replaceSessionFile = Object.prototype.hasOwnProperty.call(
        options,
        "sessionFile",
      );
      db.prepare(
        `UPDATE chat_state
         SET current_generation = ?,
             session_file = CASE WHEN ? = 1 THEN ? ELSE session_file END,
             updated_at = ?
         WHERE chat_key = ?`,
      ).run(
        currentGeneration,
        replaceSessionFile ? 1 : 0,
        replaceSessionFile
          ? safeString(options.sessionFile).trim() || null
          : null,
        timestamp,
        chatKey,
      );
      const preserveMessageId = safeString(
        options.preserveInboundMessageId,
      ).trim();
      const preservedTurn = preserveMessageId
        ? (db
            .prepare(
              `SELECT turns.turn_id, turns.inbound_message_id, turns.sequence
               FROM turns
               JOIN messages ON messages.id = turns.inbound_message_id
               WHERE turns.chat_key = ? AND messages.message_id = ?`,
            )
            .get(chatKey, preserveMessageId) as any)
        : null;
      if (preservedTurn) {
        const resetSequence = Math.max(1, Number(preservedTurn.sequence || 0));
        db.prepare(
          `UPDATE turns SET generation = ?, updated_at = ?
           WHERE chat_key = ? AND sequence >= ? AND generation = ?`,
        ).run(
          currentGeneration,
          timestamp,
          chatKey,
          resetSequence,
          previousGeneration,
        );
        db.prepare(
          `UPDATE messages SET generation = ?
           WHERE chat_key = ? AND sequence >= ? AND generation = ?`,
        ).run(currentGeneration, chatKey, resetSequence, previousGeneration);
      }
      db.prepare(
        `UPDATE turns
       SET state = 'superseded', owner_epoch = NULL, lease_until = NULL,
           heartbeat_at = NULL, updated_at = ?
       WHERE chat_key = ? AND generation < ?
         AND state IN ('pending', 'running')`,
      ).run(timestamp, chatKey, currentGeneration);
      db.prepare(
        `UPDATE messages
         SET disposition = 'superseded'
         WHERE chat_key = ? AND generation < ?
           AND disposition IN ('unclassified', 'actionable')
           AND EXISTS (
             SELECT 1 FROM turns
             WHERE turns.inbound_message_id = messages.id
               AND turns.state = 'superseded'
           )`,
      ).run(chatKey, currentGeneration);
      db.prepare(
        `UPDATE outbox_deliveries
         SET state = CASE WHEN state = 'sending' THEN 'unconfirmed' ELSE 'failed' END,
             owner_epoch = NULL, lease_until = NULL, next_attempt_at = NULL,
             last_error = 'chat_outbox_turn_superseded', updated_at = ?,
             failed_at = CASE WHEN state = 'queued' THEN ? ELSE failed_at END
         WHERE state IN ('queued', 'sending')
           AND outbox_id IN (
             SELECT outbox.outbox_id
             FROM outbox
             JOIN turns ON turns.turn_id = outbox.turn_id
             WHERE outbox.state IN ('queued', 'sending')
               AND turns.state = 'superseded'
           )`,
      ).run(timestamp, timestamp);
      db.prepare(
        `UPDATE outbox
         SET delivery_unconfirmed = CASE
               WHEN state = 'sending' THEN 1 ELSE delivery_unconfirmed END,
             state = 'failed', owner_epoch = NULL, lease_until = NULL,
             next_attempt_at = NULL, last_error = 'chat_outbox_turn_superseded',
             failure_kind = 'permanent', updated_at = ?, failed_at = ?
         WHERE state IN ('queued', 'sending')
           AND turn_id IN (
             SELECT turn_id FROM turns WHERE state = 'superseded'
           )`,
      ).run(timestamp, timestamp);
      return { previousGeneration, currentGeneration };
    })
    .immediate();
}

type ChatTurnFenceInput = {
  turnId: string;
  chatKey: string;
  messageId: string;
  ownerEpoch: string;
  attempt: number;
};

export function markChatMessageAcceptedWithFence(
  agentDir: string,
  fence: ChatTurnFenceInput,
  input: { acceptedAt?: string; sessionFile?: string } = {},
) {
  const db = openChatDatabase(agentDir);
  const result = db
    .prepare(
      `UPDATE messages
       SET accepted_at = COALESCE(accepted_at, ?),
           session_file = COALESCE(?, session_file),
           record_json = json_set(
             record_json,
             '$.acceptedAt', COALESCE(json_extract(record_json, '$.acceptedAt'), ?),
             '$.sessionFile', COALESCE(?, json_extract(record_json, '$.sessionFile'))
           ),
           updated_at = ?
       WHERE chat_key = ? AND message_id = ?
         AND EXISTS (
           SELECT 1
           FROM turns
           JOIN chat_state ON chat_state.chat_key = turns.chat_key
           WHERE turns.turn_id = ?
             AND turns.inbound_message_id = messages.id
             AND turns.chat_key = messages.chat_key
             AND turns.state = 'running'
             AND turns.owner_epoch = ?
             AND turns.attempt = ?
             AND turns.generation = chat_state.current_generation
         )`,
    )
    .run(
      safeString(input.acceptedAt).trim() || nowIso(),
      safeString(input.sessionFile).trim() || null,
      safeString(input.acceptedAt).trim() || nowIso(),
      safeString(input.sessionFile).trim() || null,
      nowIso(),
      requiredText(fence.chatKey, "chat_turn_chat_key_required"),
      requiredText(fence.messageId, "chat_turn_message_id_required"),
      requiredText(fence.turnId, "chat_turn_id_required"),
      requiredText(fence.ownerEpoch, "chat_turn_owner_epoch_required"),
      Math.max(0, Math.floor(Number(fence.attempt || 0))),
    );
  return result.changes === 1;
}

export function completeChatTurnWithoutDelivery(
  agentDir: string,
  fence: ChatTurnFenceInput,
  input: {
    sessionFile?: string;
    supersedeTurnFences?: ChatTurnFenceInput[];
  } = {},
) {
  const db = openChatDatabase(agentDir);
  return db
    .transaction(() => {
      const timestamp = nowIso();
      const terminalized = db
        .prepare(
          `UPDATE turns
           SET state = 'terminal', terminal_kind = 'empty_completion',
               owner_epoch = NULL, lease_until = NULL, heartbeat_at = NULL,
               next_attempt_at = NULL, last_error = NULL, updated_at = ?
           WHERE turn_id = ? AND chat_key = ? AND state = 'running'
             AND owner_epoch = ? AND attempt = ?
             AND inbound_message_id = (
               SELECT id FROM messages
               WHERE chat_key = ? AND message_id = ?
             )
             AND generation = (
               SELECT current_generation FROM chat_state
               WHERE chat_key = turns.chat_key
             )`,
        )
        .run(
          timestamp,
          requiredText(fence.turnId, "chat_turn_id_required"),
          requiredText(fence.chatKey, "chat_turn_chat_key_required"),
          requiredText(fence.ownerEpoch, "chat_turn_owner_epoch_required"),
          Math.max(0, Math.floor(Number(fence.attempt || 0))),
          requiredText(fence.chatKey, "chat_turn_chat_key_required"),
          requiredText(fence.messageId, "chat_turn_message_id_required"),
        );
      if (terminalized.changes !== 1) return false;
      const sessionFile = safeString(input.sessionFile).trim() || null;
      db.prepare(
        `UPDATE messages
         SET accepted_at = COALESCE(accepted_at, ?), processed_at = ?,
             session_file = COALESCE(?, session_file),
             disposition = 'actionable',
             record_json = json_set(
               record_json,
               '$.acceptedAt', COALESCE(json_extract(record_json, '$.acceptedAt'), ?),
               '$.processedAt', ?,
               '$.sessionFile', COALESCE(?, json_extract(record_json, '$.sessionFile')),
               '$.disposition', 'actionable'
             ),
             updated_at = ?
         WHERE chat_key = ? AND message_id = ?`,
      ).run(
        timestamp,
        timestamp,
        sessionFile,
        timestamp,
        timestamp,
        sessionFile,
        timestamp,
        fence.chatKey,
        fence.messageId,
      );
      for (const superseded of input.supersedeTurnFences || []) {
        if (!superseded || superseded.turnId === fence.turnId) continue;
        const result = db
          .prepare(
            `UPDATE turns
             SET state = 'superseded', terminal_kind = 'coalesced_steer',
                 owner_epoch = NULL, lease_until = NULL, heartbeat_at = NULL,
                 next_attempt_at = NULL, last_error = NULL, updated_at = ?
             WHERE turn_id = ? AND chat_key = ? AND state = 'running'
               AND owner_epoch = ? AND attempt = ?
               AND inbound_message_id = (
                 SELECT id FROM messages
                 WHERE chat_key = ? AND message_id = ?
               )
               AND generation = (
                 SELECT current_generation FROM chat_state
                 WHERE chat_key = turns.chat_key
               )`,
          )
          .run(
            timestamp,
            requiredText(superseded.turnId, "chat_turn_id_required"),
            requiredText(superseded.chatKey, "chat_turn_chat_key_required"),
            requiredText(
              superseded.ownerEpoch,
              "chat_turn_owner_epoch_required",
            ),
            Math.max(0, Math.floor(Number(superseded.attempt || 0))),
            requiredText(superseded.chatKey, "chat_turn_chat_key_required"),
            requiredText(superseded.messageId, "chat_turn_message_id_required"),
          );
        if (result.changes !== 1) throw new Error("chat_turn_fence_lost");
        db.prepare(
          `UPDATE messages
           SET disposition = 'superseded',
               record_json = json_set(record_json, '$.disposition', 'superseded'),
               updated_at = ?
           WHERE id = (
             SELECT inbound_message_id FROM turns WHERE turn_id = ?
           )`,
        ).run(timestamp, superseded.turnId);
      }
      return true;
    })
    .immediate();
}

export function supersedeChatTurnWithFence(
  agentDir: string,
  fence: ChatTurnFenceInput,
) {
  const db = openChatDatabase(agentDir);
  return db
    .transaction(() => {
      const timestamp = nowIso();
      const result = db
        .prepare(
          `UPDATE turns
           SET state = 'superseded', owner_epoch = NULL, lease_until = NULL,
               heartbeat_at = NULL, updated_at = ?
           WHERE turn_id = ? AND chat_key = ? AND state = 'running'
             AND owner_epoch = ? AND attempt = ?
             AND inbound_message_id = (
               SELECT id FROM messages
               WHERE chat_key = ? AND message_id = ?
             )
             AND generation = (
               SELECT current_generation FROM chat_state
               WHERE chat_key = turns.chat_key
             )`,
        )
        .run(
          timestamp,
          requiredText(fence.turnId, "chat_turn_id_required"),
          requiredText(fence.chatKey, "chat_turn_chat_key_required"),
          requiredText(fence.ownerEpoch, "chat_turn_owner_epoch_required"),
          Math.max(0, Math.floor(Number(fence.attempt || 0))),
          requiredText(fence.chatKey, "chat_turn_chat_key_required"),
          requiredText(fence.messageId, "chat_turn_message_id_required"),
        );
      if (result.changes !== 1) return false;
      db.prepare(
        `UPDATE messages
         SET disposition = 'superseded',
             record_json = json_set(record_json, '$.disposition', 'superseded'),
             updated_at = ?
         WHERE chat_key = ? AND message_id = ?`,
      ).run(timestamp, fence.chatKey, fence.messageId);
      db.prepare(
        `UPDATE outbox_deliveries
         SET state = CASE WHEN state = 'sending' THEN 'unconfirmed' ELSE 'failed' END,
             owner_epoch = NULL, lease_until = NULL, next_attempt_at = NULL,
             last_error = 'chat_outbox_turn_superseded', updated_at = ?,
             failed_at = CASE WHEN state = 'queued' THEN ? ELSE failed_at END
         WHERE state IN ('queued', 'sending')
           AND outbox_id IN (
             SELECT outbox_id FROM outbox
             WHERE turn_id = ? AND state IN ('queued', 'sending')
           )`,
      ).run(timestamp, timestamp, fence.turnId);
      db.prepare(
        `UPDATE outbox
         SET delivery_unconfirmed = CASE
               WHEN state = 'sending' THEN 1 ELSE delivery_unconfirmed END,
             state = 'failed', owner_epoch = NULL, lease_until = NULL,
             next_attempt_at = NULL, last_error = 'chat_outbox_turn_superseded',
             failure_kind = 'permanent', updated_at = ?, failed_at = ?
         WHERE turn_id = ? AND state IN ('queued', 'sending')`,
      ).run(timestamp, timestamp, fence.turnId);
      return true;
    })
    .immediate();
}

export function updateTurnWithFence(
  agentDir: string,
  input: {
    turnId: string;
    ownerEpoch: string;
    attempt: number;
    state: ChatTurnState;
  },
) {
  const db = openChatDatabase(agentDir);
  const result = db
    .prepare(
      `UPDATE turns
       SET state = @state, updated_at = @updatedAt
       WHERE turn_id = @turnId
         AND state = 'running'
         AND owner_epoch = @ownerEpoch
         AND attempt = @attempt`,
    )
    .run({
      turnId: requiredText(input.turnId, "chat_turn_id_required"),
      ownerEpoch: requiredText(
        input.ownerEpoch,
        "chat_turn_owner_epoch_required",
      ),
      attempt: Math.max(0, Math.floor(Number(input.attempt || 0))),
      state: input.state,
      updatedAt: nowIso(),
    });
  return result.changes === 1;
}
