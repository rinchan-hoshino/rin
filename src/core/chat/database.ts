import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import BetterSqlite3 from "better-sqlite3";

import { chatDataPath } from "../data-layout.js";
import { toStoredSessionFile } from "../session/ref.js";
import { safeString } from "../text-utils.js";
export const CHAT_DATABASE_SCHEMA_VERSION = 10;
export const CHAT_ADMISSION_MODEL_VERSION = "1";
export const CHAT_TERMINAL_OUTBOX_ID_GLOB = "chat-terminal-?*";
export const CHAT_OUTBOX_SETTLEMENT_PREDICATE_SQL = `turn_id IS NOT NULL
        AND (outbox_id GLOB '${CHAT_TERMINAL_OUTBOX_ID_GLOB}'
             OR post_delivery_json IS NOT NULL)`;

const databaseCache = new Map<string, BetterSqlite3.Database>();

export type ChatDatabaseState = {
  chatKey: string;
  currentGeneration: number;
  nextSequence: number;
};

export type ChatTurnState = "pending" | "running" | "terminal" | "failed";

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

export function chatDatabaseSchemaFingerprint(db: BetterSqlite3.Database) {
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

const LEGACY_CHAT_DATABASE_TABLES = [
  "chat_state",
  "inbound_heads",
  "messages",
  "outbox",
  "outbox_deliveries",
  "schema_meta",
  "turns",
] as const;

const CHAT_DATABASE_TABLES = [
  "chat_state",
  "inbound_heads",
  "messages",
  "outbox",
  "outbox_deliveries",
  "schema_meta",
  "inbox_jobs",
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

export function configureChatDatabase(db: BetterSqlite3.Database) {
  // Configure connection behavior before journal_mode, which can itself need
  // a write lock during concurrent cold opens.
  db.pragma("busy_timeout = 120000");
  setWalJournalMode(db);
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
}

export function readChatDatabaseTables(db: BetterSqlite3.Database) {
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

export function validateRecordedChatDatabaseSchema(
  db: BetterSqlite3.Database,
  version: number,
) {
  const currentTables = readChatDatabaseTables(db);
  const expectedTables =
    version >= 7 && version <= 8
      ? (["chat_runs", ...LEGACY_CHAT_DATABASE_TABLES] as const)
      : version <= 8
        ? LEGACY_CHAT_DATABASE_TABLES
        : CHAT_DATABASE_TABLES;
  if (expectedTables.some((table) => !currentTables.has(table))) {
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

function validateCurrentChatAdmissionModel(db: BetterSqlite3.Database) {
  const version = safeString(
    (
      db
        .prepare(
          `SELECT value FROM schema_meta WHERE key = 'admission_model_version'`,
        )
        .get() as any
    )?.value,
  ).trim();
  if (version !== CHAT_ADMISSION_MODEL_VERSION) {
    throw new Error("chat_database_admission_model_incomplete");
  }
}

function initializeChatDatabase(
  db: BetterSqlite3.Database,
  admissionModelReady = true,
) {
  configureChatDatabase(db);

  db.transaction(() => {
    const readTables = () => readChatDatabaseTables(db);
    const currentVersion = Number(db.pragma("user_version", { simple: true }));
    if (currentVersion > CHAT_DATABASE_SCHEMA_VERSION) {
      throw new Error(`chat_database_future_schema:${currentVersion}`);
    }
    if (currentVersion === CHAT_DATABASE_SCHEMA_VERSION) {
      validateRecordedChatDatabaseSchema(db, CHAT_DATABASE_SCHEMA_VERSION);
      return;
    }
    if (currentVersion !== 0) {
      throw new Error(
        `chat_database_schema_upgrade_required:${currentVersion}:${CHAT_DATABASE_SCHEMA_VERSION}`,
      );
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
        CHECK (disposition IN ('unclassified', 'record_only', 'actionable')),
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

    CREATE TABLE IF NOT EXISTS inbox_jobs (
      turn_id TEXT PRIMARY KEY,
      inbound_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE RESTRICT,
      chat_key TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 0),
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      state TEXT NOT NULL
        CHECK (state IN ('pending', 'running', 'terminal', 'failed')),
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
      admission_state TEXT NOT NULL DEFAULT 'unclassified'
        CHECK (admission_state IN ('unclassified', 'actionable', 'record_only')),
      admission_json TEXT,
      admission_hash TEXT,
      submission_json TEXT,
      submission_hash TEXT,
      execution_session_file TEXT,
        created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS inbox_jobs_claim_idx
      ON inbox_jobs(state, next_attempt_at, lease_until, chat_key, sequence);
    CREATE INDEX IF NOT EXISTS inbox_jobs_chat_generation_idx
      ON inbox_jobs(chat_key, generation, state, sequence);
    CREATE TABLE IF NOT EXISTS outbox (
      outbox_id TEXT PRIMARY KEY,
      turn_id TEXT REFERENCES inbox_jobs(turn_id) ON DELETE RESTRICT,
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
      WHERE ${CHAT_OUTBOX_SETTLEMENT_PREDICATE_SQL};
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
      ${
        admissionModelReady
          ? `INSERT INTO schema_meta (key, value)
             VALUES ('admission_model_version', '${CHAT_ADMISSION_MODEL_VERSION}');`
          : ""
      }
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

function openChatDatabaseWithAdmissionModel(
  agentDir: string,
  requireCurrentAdmissionModel: boolean,
): BetterSqlite3.Database {
  const dbPath = chatDatabasePath(agentDir);
  const existing = databaseCache.get(dbPath);
  if (existing?.open) {
    if (requireCurrentAdmissionModel) {
      validateCurrentChatAdmissionModel(existing);
    }
    return existing;
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const databaseExists = fs.existsSync(dbPath);
  const db = new BetterSqlite3(dbPath);
  try {
    if (!databaseExists) {
      initializeChatDatabase(db, requireCurrentAdmissionModel);
    } else {
      configureChatDatabase(db);
      const currentVersion = Number(
        db.pragma("user_version", { simple: true }),
      );
      if (currentVersion === 0) {
        // Another process can create the SQLite file before its immediate
        // schema transaction begins. Enter the same initializer so the write
        // lock serializes fresh creation; a true partial schema still fails.
        initializeChatDatabase(db, requireCurrentAdmissionModel);
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
    if (requireCurrentAdmissionModel) {
      validateCurrentChatAdmissionModel(db);
    }
    databaseCache.set(dbPath, db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openChatDatabase(agentDir: string): BetterSqlite3.Database {
  return openChatDatabaseWithAdmissionModel(agentDir, true);
}

export function openChatDatabaseForMigration(
  agentDir: string,
): BetterSqlite3.Database {
  return openChatDatabaseWithAdmissionModel(agentDir, false);
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
           SELECT generation FROM inbox_jobs
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
             FROM inbox_jobs
             JOIN messages ON messages.id = inbox_jobs.inbound_message_id
             JOIN chat_state ON chat_state.chat_key = inbox_jobs.chat_key
             WHERE inbox_jobs.turn_id = ? AND inbox_jobs.chat_key = ?
               AND messages.message_id = ? AND inbox_jobs.state = 'running'
               AND inbox_jobs.owner_epoch = ? AND inbox_jobs.attempt = ?
               AND inbox_jobs.generation = chat_state.current_generation`,
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
                 ELSE 'chat_outbox_turn_interrupted' END,
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
                              ELSE 'chat_outbox_turn_interrupted' END,
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
              `SELECT inbox_jobs.turn_id, inbox_jobs.inbound_message_id, inbox_jobs.sequence
               FROM inbox_jobs
               JOIN messages ON messages.id = inbox_jobs.inbound_message_id
               WHERE inbox_jobs.chat_key = ? AND messages.message_id = ?`,
            )
            .get(chatKey, preserveMessageId) as any)
        : null;
      if (preservedTurn) {
        const resetSequence = Math.max(1, Number(preservedTurn.sequence || 0));
        db.prepare(
          `UPDATE inbox_jobs SET generation = ?, updated_at = ?
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
        `UPDATE inbox_jobs
       SET state = 'failed', terminal_kind = 'interrupted',
           last_error = 'chat_turn_interrupted_by_generation_reset',
           owner_epoch = NULL, lease_until = NULL, heartbeat_at = NULL, updated_at = ?
       WHERE chat_key = ? AND generation < ?
         AND state IN ('pending', 'running')`,
      ).run(timestamp, chatKey, currentGeneration);
      db.prepare(
        `UPDATE messages
         SET disposition = 'record_only'
         WHERE chat_key = ? AND generation < ?
           AND disposition IN ('unclassified', 'actionable')
           AND EXISTS (
             SELECT 1 FROM inbox_jobs
             WHERE inbox_jobs.inbound_message_id = messages.id
               AND inbox_jobs.state = 'failed' AND inbox_jobs.terminal_kind = 'interrupted'
           )`,
      ).run(chatKey, currentGeneration);
      db.prepare(
        `UPDATE outbox_deliveries
         SET state = CASE WHEN state = 'sending' THEN 'unconfirmed' ELSE 'failed' END,
             owner_epoch = NULL, lease_until = NULL, next_attempt_at = NULL,
             last_error = 'chat_outbox_turn_interrupted', updated_at = ?,
             failed_at = CASE WHEN state = 'queued' THEN ? ELSE failed_at END
         WHERE state IN ('queued', 'sending')
           AND outbox_id IN (
             SELECT outbox.outbox_id
             FROM outbox
             JOIN inbox_jobs ON inbox_jobs.turn_id = outbox.turn_id
             WHERE outbox.state IN ('queued', 'sending')
               AND inbox_jobs.state = 'failed' AND inbox_jobs.terminal_kind = 'interrupted'
           )`,
      ).run(timestamp, timestamp);
      db.prepare(
        `UPDATE outbox
         SET delivery_unconfirmed = CASE
               WHEN state = 'sending' THEN 1 ELSE delivery_unconfirmed END,
             state = 'failed', owner_epoch = NULL, lease_until = NULL,
             next_attempt_at = NULL, last_error = 'chat_outbox_turn_interrupted',
             failure_kind = 'permanent', updated_at = ?, failed_at = ?
         WHERE state IN ('queued', 'sending')
           AND turn_id IN (
             SELECT turn_id FROM inbox_jobs WHERE state = 'failed' AND terminal_kind = 'interrupted'
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
  input: {
    acceptedAt?: string;
    sessionFile?: string;
    joinedTurnId?: string;
  } = {},
) {
  const db = openChatDatabase(agentDir);
  return db
    .transaction(() => {
      const timestamp = safeString(input.acceptedAt).trim() || nowIso();
      const updatedAt = nowIso();
      const sessionFile =
        toStoredSessionFile(agentDir, input.sessionFile) || null;
      const joinedTurnId = safeString(input.joinedTurnId).trim() || null;
      const turn = db
        .prepare(
          `UPDATE inbox_jobs
           SET execution_session_file = COALESCE(execution_session_file, ?),
               admission_json = CASE
                 WHEN ? IS NULL THEN admission_json
                 ELSE json_set(COALESCE(admission_json, '{}'), '$.joinedTurnId', ?)
               END,
               updated_at = ?
           WHERE turn_id = ? AND chat_key = ? AND state = 'running'
             AND owner_epoch = ? AND attempt = ?
             AND inbound_message_id = (
               SELECT id FROM messages
                WHERE chat_key = ? AND message_id = ?
             )
             AND generation = (
               SELECT current_generation FROM chat_state
                WHERE chat_key = inbox_jobs.chat_key
             )
             AND (? IS NULL OR execution_session_file IS NULL
                  OR execution_session_file = ?)`,
        )
        .run(
          sessionFile,
          joinedTurnId,
          joinedTurnId,
          updatedAt,
          requiredText(fence.turnId, "chat_turn_id_required"),
          requiredText(fence.chatKey, "chat_turn_chat_key_required"),
          requiredText(fence.ownerEpoch, "chat_turn_owner_epoch_required"),
          Math.max(0, Math.floor(Number(fence.attempt || 0))),
          requiredText(fence.chatKey, "chat_turn_chat_key_required"),
          requiredText(fence.messageId, "chat_turn_message_id_required"),
          sessionFile,
          sessionFile,
        );
      if (turn.changes !== 1) return false;
      const message = db
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
             AND id = (
               SELECT inbound_message_id FROM inbox_jobs WHERE turn_id = ?
             )`,
        )
        .run(
          timestamp,
          sessionFile,
          timestamp,
          sessionFile,
          updatedAt,
          fence.chatKey,
          fence.messageId,
          fence.turnId,
        );
      if (message.changes !== 1) throw new Error("chat_turn_fence_lost");
      return true;
    })
    .immediate();
}

export function readLatestJoinedChatPresentation(
  agentDir: string,
  ownerTurnIdValue: string,
): { turnId: string; chatKey: string; messageId: string } | null {
  const ownerTurnId = requiredText(ownerTurnIdValue, "chat_turn_id_required");
  const db = openChatDatabase(agentDir);
  return (
    (db
      .prepare(
        `WITH owner AS (
           SELECT owner_inbox.chat_key AS chatKey,
                  owner_inbox.generation AS generation,
                  owner_message.sequence AS sequence
             FROM inbox_jobs AS owner_inbox
             JOIN messages AS owner_message
               ON owner_message.id = owner_inbox.inbound_message_id
            WHERE owner_inbox.turn_id = ?
         )
         SELECT inbox_jobs.turn_id AS turnId,
                inbox_jobs.chat_key AS chatKey,
                messages.message_id AS messageId
           FROM inbox_jobs
           JOIN owner
             ON owner.chatKey = inbox_jobs.chat_key
            AND owner.generation = inbox_jobs.generation
           JOIN messages ON messages.id = inbox_jobs.inbound_message_id
          WHERE json_extract(inbox_jobs.admission_json, '$.joinedTurnId') = ?
            AND messages.sequence > owner.sequence
            AND messages.accepted_at IS NOT NULL
          ORDER BY messages.sequence DESC
          LIMIT 1`,
      )
      .get(ownerTurnId, ownerTurnId) as
      | { turnId: string; chatKey: string; messageId: string }
      | undefined) || null
  );
}

export function markTerminalOwnerAndJoinedChatMessagesProcessed(
  agentDir: string,
  ownerTurnIdValue: string,
  input: {
    processedAt?: string;
    deliveryKind: "outbox_final" | "outbox_error";
    outboxId: string;
    deferProcessedMessage?: { chatKey: string; messageId: string };
  },
) {
  const ownerTurnId = requiredText(ownerTurnIdValue, "chat_turn_id_required");
  const deliveryKind = requiredText(
    input.deliveryKind,
    "chat_delivery_kind_required",
  );
  const outboxId = requiredText(input.outboxId, "chat_outbox_id_required");
  const outboxDeliveryKind =
    deliveryKind === "outbox_error" ? "error" : "final";
  const deferredChatKey =
    safeString(input.deferProcessedMessage?.chatKey).trim() || null;
  const deferredMessageId =
    safeString(input.deferProcessedMessage?.messageId).trim() || null;
  if (Boolean(deferredChatKey) !== Boolean(deferredMessageId)) {
    return { matched: false, processedMessages: 0 };
  }
  const timestamp = safeString(input.processedAt).trim() || nowIso();
  const db = openChatDatabase(agentDir);
  return db
    .transaction(() => {
      const committedTerminal = db
        .prepare(
          `SELECT 1
             FROM outbox
             JOIN inbox_jobs AS owner ON owner.turn_id = outbox.turn_id
            WHERE outbox.outbox_id = ?
              AND outbox.turn_id = ?
              AND outbox.outbox_id GLOB ?
              AND outbox.delivery_kind = ?
              AND (
                outbox.state = 'delivered'
                OR (outbox.state = 'failed' AND outbox.failure_kind = 'partial')
              )
              AND json_extract(
                    outbox.post_delivery_json,
                    '$.markJoinedProcessed.ownerTurnId'
                  ) = ?
              AND json_extract(
                    outbox.post_delivery_json,
                    '$.markJoinedProcessed.deliveryKind'
                  ) = ?
              AND NOT EXISTS (
                    SELECT 1
                      FROM inbox_jobs AS joined
                     WHERE json_extract(
                             joined.admission_json,
                             '$.joinedTurnId'
                           ) = ?
                       AND joined.state IN ('running', 'terminal')
                       AND (
                         joined.terminal_kind IS NULL
                         OR joined.terminal_kind = 'completed'
                       )
                       AND json_extract(
                             joined.admission_json,
                             '$.settledOutboxId'
                           ) IS NOT NULL
                       AND json_extract(
                             joined.admission_json,
                             '$.settledOutboxId'
                           ) <> ?
                  )
              AND owner.state = 'terminal'
              AND owner.terminal_kind = ?`,
        )
        .get(
          outboxId,
          ownerTurnId,
          CHAT_TERMINAL_OUTBOX_ID_GLOB,
          outboxDeliveryKind,
          ownerTurnId,
          deliveryKind,
          ownerTurnId,
          outboxId,
          deliveryKind,
        );
      if (!committedTerminal) {
        return { matched: false, processedMessages: 0 };
      }
      if (
        deferredChatKey &&
        !db
          .prepare(
            `SELECT 1
               FROM inbox_jobs AS target
               JOIN messages AS target_message
                 ON target_message.id = target.inbound_message_id
              WHERE target_message.chat_key = ?
                AND target_message.message_id = ?
                AND (
                  (
                    target.turn_id = ?
                    AND target.state = 'terminal'
                    AND target.terminal_kind = ?
                  )
                  OR (
                    json_extract(
                      target.admission_json,
                      '$.joinedTurnId'
                    ) = ?
                    AND target.state IN ('running', 'terminal')
                    AND (
                      target.terminal_kind IS NULL
                      OR target.terminal_kind = 'completed'
                    )
                  )
                )`,
          )
          .get(
            deferredChatKey,
            deferredMessageId,
            ownerTurnId,
            deliveryKind,
            ownerTurnId,
          )
      ) {
        return { matched: false, processedMessages: 0 };
      }

      db.prepare(
        `UPDATE inbox_jobs
         SET admission_json = json_set(
               admission_json,
               '$.settledOutboxId', ?
             ),
             updated_at = ?
         WHERE json_extract(admission_json, '$.joinedTurnId') = ?
           AND json_extract(admission_json, '$.settledOutboxId') IS NULL
           AND state IN ('running', 'terminal')
           AND (terminal_kind IS NULL OR terminal_kind = 'completed')`,
      ).run(outboxId, timestamp, ownerTurnId);
      const messages = db
        .prepare(
          `UPDATE messages
           SET processed_at = COALESCE(processed_at, ?),
               delivery_kind = COALESCE(delivery_kind, ?),
               disposition = 'actionable',
               record_json = json_set(
                 record_json,
                 '$.processedAt', COALESCE(json_extract(record_json, '$.processedAt'), ?),
                 '$.deliveryKind', COALESCE(json_extract(record_json, '$.deliveryKind'), ?),
                 '$.disposition', 'actionable'
               ),
               updated_at = ?
           WHERE id IN (
             SELECT inbound_message_id
               FROM inbox_jobs
              WHERE (
                      turn_id = ?
                      AND state = 'terminal'
                      AND terminal_kind = ?
                    )
                 OR (
                      json_extract(admission_json, '$.joinedTurnId') = ?
                      AND state IN ('running', 'terminal')
                      AND (terminal_kind IS NULL OR terminal_kind = 'completed')
                    )
           )
             AND processed_at IS NULL
             AND (
               ? IS NULL
               OR chat_key <> ?
               OR message_id <> ?
             )`,
        )
        .run(
          timestamp,
          deliveryKind,
          timestamp,
          deliveryKind,
          timestamp,
          ownerTurnId,
          deliveryKind,
          ownerTurnId,
          deferredChatKey,
          deferredChatKey,
          deferredMessageId,
        );
      return {
        matched: true,
        processedMessages: Number(messages.changes || 0),
      };
    })
    .immediate();
}

export function completeChatTurnWithoutDelivery(
  agentDir: string,
  fence: ChatTurnFenceInput,
  input: {
    sessionFile?: string;
  } = {},
) {
  const db = openChatDatabase(agentDir);
  return db
    .transaction(() => {
      const timestamp = nowIso();
      const sessionFile = safeString(input.sessionFile).trim() || null;
      const terminalized = db
        .prepare(
          `UPDATE inbox_jobs
           SET state = 'terminal', terminal_kind = 'empty_completion',
               owner_epoch = NULL, lease_until = NULL, heartbeat_at = NULL,
               next_attempt_at = NULL, last_error = NULL,
               execution_session_file = COALESCE(execution_session_file, ?),
               updated_at = ?
           WHERE turn_id = ? AND chat_key = ? AND state = 'running'
             AND owner_epoch = ? AND attempt = ?
             AND inbound_message_id = (
               SELECT id FROM messages
               WHERE chat_key = ? AND message_id = ?
             )
             AND generation = (
               SELECT current_generation FROM chat_state
               WHERE chat_key = inbox_jobs.chat_key
             )
             AND (? IS NULL OR execution_session_file IS NULL
                  OR execution_session_file = ?)`,
        )
        .run(
          sessionFile,
          timestamp,
          requiredText(fence.turnId, "chat_turn_id_required"),
          requiredText(fence.chatKey, "chat_turn_chat_key_required"),
          requiredText(fence.ownerEpoch, "chat_turn_owner_epoch_required"),
          Math.max(0, Math.floor(Number(fence.attempt || 0))),
          requiredText(fence.chatKey, "chat_turn_chat_key_required"),
          requiredText(fence.messageId, "chat_turn_message_id_required"),
          sessionFile,
          sessionFile,
        );
      if (terminalized.changes !== 1) return false;
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
      `UPDATE inbox_jobs
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
