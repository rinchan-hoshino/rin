import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";

import { nowIso } from "../time-utils.js";
import { safeString } from "../text-utils.js";
import {
  CHAT_ADMISSION_MODEL_VERSION,
  CHAT_DATABASE_SCHEMA_VERSION,
  chatDatabasePath,
  chatDatabaseSchemaFingerprint,
  closeChatDatabase,
  configureChatDatabase,
  openChatDatabaseForInstall,
  readChatDatabaseTables,
  validateRecordedChatDatabaseSchema,
} from "./database.js";
import {
  migrateLegacyChatControlData,
  readLegacyControlMigrationPreservedSummary,
} from "./legacy-migration.js";

function retireLegacyTerminalWal(agentDir: string) {
  const source = path.join(agentDir, "data", "chat", "terminal-wal");
  if (!fs.existsSync(source)) return;
  const stamp = nowIso().replace(/[:.]/g, "-");
  fs.renameSync(
    source,
    path.join(path.dirname(source), `terminal-wal-retired-${stamp}`),
  );
}

const OLD_ADMISSION_KINDS = [
  "legacy_message_projection",
  "legacy_accepted_orphan",
] as const;

function tableHasColumn(
  db: BetterSqlite3.Database,
  table: string,
  column: string,
) {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).some(
    (item) => item.name === column,
  );
}

function finishSchemaUpgrade(
  db: BetterSqlite3.Database,
  tableName: "turns" | "inbox_jobs" = "turns",
) {
  const admissionsWithoutHash = db
    .prepare(
      `SELECT turn_id, admission_json
         FROM ${tableName}
        WHERE admission_json IS NOT NULL AND admission_hash IS NULL`,
    )
    .all() as Array<{ turn_id: string; admission_json: string }>;
  const writeAdmissionHash = db.prepare(
    `UPDATE ${tableName} SET admission_hash = ?
      WHERE turn_id = ? AND admission_json = ? AND admission_hash IS NULL`,
  );
  for (const row of admissionsWithoutHash) {
    writeAdmissionHash.run(
      createHash("sha256").update(row.admission_json).digest("hex"),
      row.turn_id,
      row.admission_json,
    );
  }
  db.prepare(
    `UPDATE schema_meta SET value = ? WHERE key = 'schema_version'`,
  ).run(String(CHAT_DATABASE_SCHEMA_VERSION));
  db.prepare(
    `UPDATE schema_meta SET value = ? WHERE key = 'schema_fingerprint'`,
  ).run(chatDatabaseSchemaFingerprint(db));
  db.pragma(`user_version = ${CHAT_DATABASE_SCHEMA_VERSION}`);
}

function interruptUnfencedLegacyTurnsForCanonicalUpgrade(
  db: BetterSqlite3.Database,
) {
  const turns = db
    .prepare(
      `SELECT t.turn_id AS turnId,
              t.chat_key AS chatKey,
              m.message_id AS messageId
         FROM turns t
         JOIN messages m ON m.id = t.inbound_message_id
        WHERE t.run_id IS NULL
          AND (
            t.state = 'running'
            OR (
              t.state = 'pending' AND t.attempt > 0
              AND json_valid(t.admission_json)
              AND json_extract(t.admission_json, '$.kind') = 'message'
            )
          )
        ORDER BY t.sequence ASC, t.turn_id ASC`,
    )
    .all() as Array<{
    turnId: string;
    chatKey: string;
    messageId: string;
  }>;
  if (!turns.length) return [];

  const timestamp = nowIso();
  const text =
    "Rin was updated while this turn was running, so it was stopped safely. Please send your request again.";
  const insertOutbox = db.prepare(
    `INSERT INTO outbox (
       outbox_id, turn_id, idempotency_key, chat_key, delivery_kind, state,
       payload_json, post_delivery_json, post_delivery_applied_at,
       adapter_id, adapter_version, plan_state, sequence, attempts,
       owner_epoch, lease_until, next_attempt_at, last_error, failure_kind,
       delivery_unconfirmed, delivery_result_json, created_at, updated_at,
       delivered_at, failed_at
     ) VALUES (?, ?, ?, ?, 'error', 'queued', ?, NULL, NULL,
               ?, '1', 'planned', ?, 0,
               NULL, NULL, NULL, NULL, NULL,
               0, NULL, ?, ?, NULL, NULL)`,
  );
  const insertDelivery = db.prepare(
    `INSERT INTO outbox_deliveries (
       delivery_id, outbox_id, destination, fragment_index, state,
       payload_json, owner_epoch, attempt, lease_until, next_attempt_at,
       last_error, provider_message_id, created_at, updated_at,
       delivered_at, failed_at
     ) VALUES (?, ?, ?, 0, 'queued', ?, NULL, 0, NULL, NULL,
               NULL, NULL, ?, ?, NULL, NULL)`,
  );
  const terminalizeTurn = db.prepare(
    `UPDATE turns
        SET state = 'terminal',
            terminal_kind = 'install_upgrade_interrupted',
            owner_epoch = NULL,
            lease_until = NULL,
            heartbeat_at = NULL,
            next_attempt_at = NULL,
            last_error = NULL,
            updated_at = ?
      WHERE turn_id = ?
        AND run_id IS NULL
        AND (state = 'running' OR (state = 'pending' AND attempt > 0))`,
  );
  for (const turn of turns) {
    const idempotencyKey = `install-upgrade-interrupted:${turn.turnId}`;
    const outboxId = `dedupe-${createHash("sha256")
      .update(idempotencyKey)
      .digest("hex")}`;
    const payloadJson = JSON.stringify({
      chatKey: turn.chatKey,
      parts: [
        ...(safeString(turn.messageId).trim()
          ? [{ type: "quote", id: safeString(turn.messageId).trim() }]
          : []),
        { type: "text", text },
      ],
      deliveryKind: "error",
      createdAt: timestamp,
    });
    const sequence = Number(
      (
        db
          .prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM outbox`)
          .get() as { value?: number }
      )?.value || 1,
    );
    insertOutbox.run(
      outboxId,
      turn.turnId,
      idempotencyKey,
      turn.chatKey,
      payloadJson,
      turn.chatKey.split("/", 1)[0] || "unknown",
      sequence,
      timestamp,
      timestamp,
    );
    insertDelivery.run(
      `${outboxId}:0`,
      outboxId,
      turn.chatKey,
      payloadJson,
      timestamp,
      timestamp,
    );
    terminalizeTurn.run(timestamp, turn.turnId);
    db.prepare(
      `UPDATE messages SET disposition = 'actionable'
        WHERE id = (SELECT inbound_message_id FROM turns WHERE turn_id = ?)`,
    ).run(turn.turnId);
  }
  return turns.map((turn) => ({
    chatKey: turn.chatKey,
    turnId: turn.turnId,
  }));
}

function reconcileOrphanedTransitionalCanonicalRuns(
  db: BetterSqlite3.Database,
) {
  const runIds = (
    db
      .prepare(
        `SELECT r.run_id AS runId
           FROM chat_runs r
          WHERE r.state = 'running'
            AND NOT EXISTS (
              SELECT 1 FROM turns t
               WHERE t.run_id = r.run_id
                 AND t.state IN ('pending', 'running')
            )
          ORDER BY r.created_at ASC, r.run_id ASC`,
      )
      .all() as Array<{ runId: string }>
  ).map((row) => safeString(row.runId).trim());
  if (!runIds.length) return [];
  const terminalPayload = JSON.stringify({
    reason: "install_upgrade_reconciled_transitional_run",
  });
  const terminalPayloadHash = createHash("sha256")
    .update(terminalPayload)
    .digest("hex");
  const retireRun = db.prepare(
    `UPDATE chat_runs
        SET state = 'manual_review',
            terminal_delivery_turn_id = delivery_turn_id,
            terminal_kind = 'install_upgrade_reconciled',
            terminal_payload_json = ?, terminal_payload_hash = ?,
            updated_at = ?, terminal_at = ?
      WHERE run_id = ? AND state = 'running'`,
  );
  for (const runId of runIds) {
    const timestamp = nowIso();
    retireRun.run(
      terminalPayload,
      terminalPayloadHash,
      timestamp,
      timestamp,
      runId,
    );
  }
  return runIds;
}

const CANONICAL_RECONCILIATION_SCHEMA_META_KEY =
  "canonical_run_reconciliation_v8";

function recordCanonicalReconciliation(
  db: BetterSqlite3.Database,
  input: {
    interruptedTurns: Array<{ chatKey: string; turnId: string }>;
    retiredRunIds: string[];
  },
) {
  const chatKeys = [
    ...new Set(
      input.interruptedTurns
        .map((entry) => safeString(entry.chatKey).trim())
        .filter(Boolean),
    ),
  ].sort();
  const value = JSON.stringify({
    version: 1,
    state: chatKeys.length ? "pending_session_retirement" : "complete",
    chatKeys,
    interruptedTurnIds: input.interruptedTurns.map((entry) => entry.turnId),
    retiredRunIds: input.retiredRunIds,
    createdAt: nowIso(),
    completedAt: chatKeys.length ? null : nowIso(),
  });
  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(CANONICAL_RECONCILIATION_SCHEMA_META_KEY, value);
}

export function readCanonicalReconciliationInstallState(
  db: BetterSqlite3.Database,
) {
  const row = db
    .prepare(`SELECT value FROM schema_meta WHERE key = ?`)
    .get(CANONICAL_RECONCILIATION_SCHEMA_META_KEY) as
    | { value?: string }
    | undefined;
  if (!row?.value) return null;
  const parsed = JSON.parse(row.value) as {
    version?: number;
    state?: string;
    chatKeys?: unknown;
    interruptedTurnIds?: unknown;
    retiredRunIds?: unknown;
    createdAt?: string;
    completedAt?: string | null;
  };
  if (
    parsed.version !== 1 ||
    !["pending_session_retirement", "complete"].includes(
      safeString(parsed.state),
    ) ||
    !Array.isArray(parsed.chatKeys) ||
    !Array.isArray(parsed.interruptedTurnIds) ||
    !Array.isArray(parsed.retiredRunIds)
  ) {
    throw new Error("chat_database_invalid_canonical_reconciliation_state");
  }
  return {
    version: 1 as const,
    state: parsed.state as "pending_session_retirement" | "complete",
    chatKeys: parsed.chatKeys
      .map((value) => safeString(value).trim())
      .filter(Boolean),
    interruptedTurnIds: parsed.interruptedTurnIds
      .map((value) => safeString(value).trim())
      .filter(Boolean),
    retiredRunIds: parsed.retiredRunIds
      .map((value) => safeString(value).trim())
      .filter(Boolean),
    createdAt: safeString(parsed.createdAt),
    completedAt: safeString(parsed.completedAt).trim() || null,
  };
}

export function completeCanonicalReconciliationInstallState(
  db: BetterSqlite3.Database,
) {
  const state = readCanonicalReconciliationInstallState(db);
  if (!state || state.state === "complete") return state;
  const completed = {
    ...state,
    state: "complete" as const,
    completedAt: nowIso(),
  };
  db.prepare(`UPDATE schema_meta SET value = ? WHERE key = ?`).run(
    JSON.stringify(completed),
    CANONICAL_RECONCILIATION_SCHEMA_META_KEY,
  );
  return completed;
}

function rebuildChatDeliveryTablesV9(db: BetterSqlite3.Database) {
  db.exec(`
    CREATE TEMP TABLE cutover_outbox_deliveries_v9 AS SELECT * FROM outbox_deliveries;
    CREATE TEMP TABLE cutover_outbox_v9 AS SELECT * FROM outbox;
    CREATE TEMP TABLE cutover_messages_v9 AS
      SELECT id, record_key, chat_key, message_id, platform, bot_id, chat_id,
             role, reply_to_message_id, session_file, accepted_at, processed_at,
             delivery_kind, last_received_at, duplicate_count, updated_at,
             chat_thread_id, message_thread_id, chat_type, received_at,
             platform_timestamp, provider_cursor, user_id, nickname, chat_name,
             trust, text, raw_content, stripped_content, elements_json,
             quote_json, sequence, generation,
             CASE WHEN disposition = 'superseded' THEN 'record_only'
                  ELSE disposition END AS disposition,
             record_json
        FROM messages;
    CREATE TEMP TABLE cutover_inbox_jobs_v9 AS
      SELECT turn_id, inbound_message_id, chat_key, generation, sequence,
             CASE WHEN state = 'superseded' THEN 'failed' ELSE state END AS state,
             CASE WHEN state = 'superseded' THEN 'interrupted'
                  ELSE terminal_kind END AS terminal_kind,
             CASE WHEN state IN ('running', 'superseded') THEN NULL
                  ELSE owner_epoch END AS owner_epoch,
             attempt,
             CASE WHEN state IN ('running', 'superseded') THEN NULL
                  ELSE lease_until END AS lease_until,
             CASE WHEN state IN ('running', 'superseded') THEN NULL
                  ELSE heartbeat_at END AS heartbeat_at,
             CASE WHEN state IN ('running', 'superseded') THEN NULL
                  ELSE next_attempt_at END AS next_attempt_at,
             CASE WHEN state = 'superseded' THEN 'chat_turn_interrupted'
                  ELSE last_error END AS last_error,
             routing_json, session_json, elements_json, admission_state,
             admission_json, admission_hash, submission_json, submission_hash,
             execution_session_file, created_at, updated_at
        FROM turns;
    DROP TABLE IF EXISTS chat_runs;
    DROP TABLE outbox_deliveries;
    DROP TABLE outbox;
    DROP TABLE turns;
    DROP TABLE messages;
    CREATE TABLE messages (
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
    CREATE TABLE inbox_jobs (
      turn_id TEXT PRIMARY KEY,
      inbound_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE RESTRICT,
      chat_key TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 0),
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'terminal', 'failed')),
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
    CREATE TABLE outbox (
      outbox_id TEXT PRIMARY KEY,
      turn_id TEXT REFERENCES inbox_jobs(turn_id) ON DELETE RESTRICT,
      idempotency_key TEXT UNIQUE,
      chat_key TEXT NOT NULL,
      delivery_kind TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued', 'planned', 'sending', 'delivered', 'failed')),
      payload_json TEXT NOT NULL,
      post_delivery_json TEXT,
      post_delivery_applied_at TEXT,
      adapter_id TEXT,
      adapter_version TEXT,
      plan_state TEXT NOT NULL DEFAULT 'unplanned' CHECK (plan_state IN ('unplanned', 'planned')),
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
    CREATE TABLE outbox_deliveries (
      delivery_id TEXT PRIMARY KEY,
      outbox_id TEXT NOT NULL REFERENCES outbox(outbox_id) ON DELETE CASCADE,
      destination TEXT NOT NULL,
      fragment_index INTEGER NOT NULL CHECK (fragment_index >= 0),
      state TEXT NOT NULL CHECK (state IN ('queued', 'sending', 'delivered', 'failed', 'unconfirmed')),
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
    INSERT INTO messages SELECT * FROM cutover_messages_v9;
    INSERT INTO inbox_jobs SELECT * FROM cutover_inbox_jobs_v9;
    INSERT INTO outbox SELECT * FROM cutover_outbox_v9;
    INSERT INTO outbox_deliveries SELECT * FROM cutover_outbox_deliveries_v9;
    DROP TABLE cutover_outbox_deliveries_v9;
    DROP TABLE cutover_outbox_v9;
    DROP TABLE cutover_inbox_jobs_v9;
    DROP TABLE cutover_messages_v9;
    CREATE INDEX messages_message_id_idx ON messages(message_id);
    CREATE INDEX messages_chat_order_idx ON messages(chat_key, sequence);
    CREATE INDEX messages_chat_date_idx ON messages(chat_key, received_at, record_key);
    CREATE INDEX messages_chat_processed_date_idx
      ON messages(chat_key, processed_at, record_key) WHERE received_at = '';
    CREATE INDEX messages_reply_idx
      ON messages(chat_key, reply_to_message_id, processed_at)
      WHERE reply_to_message_id IS NOT NULL;
    CREATE INDEX messages_recovery_head_idx
      ON messages(platform, bot_id, chat_key, platform_timestamp, sequence)
      WHERE role = 'user';
    CREATE INDEX messages_disposition_idx ON messages(disposition, chat_key, sequence);
    CREATE INDEX messages_orphan_recovery_idx
      ON messages(disposition, role, accepted_at, chat_key, sequence)
      WHERE role = 'user';
    CREATE INDEX inbox_jobs_claim_idx
      ON inbox_jobs(state, next_attempt_at, lease_until, chat_key, sequence);
    CREATE INDEX inbox_jobs_chat_generation_idx
      ON inbox_jobs(chat_key, generation, state, sequence);
    CREATE UNIQUE INDEX outbox_turn_terminal_idx
      ON outbox(turn_id)
      WHERE turn_id IS NOT NULL
        AND (delivery_kind IN ('final', 'error', 'command_ack')
             OR post_delivery_json IS NOT NULL);
    CREATE INDEX outbox_sequence_idx ON outbox(sequence);
    CREATE INDEX outbox_drain_idx ON outbox(state, next_attempt_at, sequence);
    CREATE INDEX outbox_delivered_cleanup_idx
      ON outbox(delivered_at) WHERE state = 'delivered';
    CREATE INDEX outbox_failed_cleanup_idx
      ON outbox(failed_at) WHERE state = 'failed';
    CREATE INDEX outbox_post_delivery_pending_idx
      ON outbox(post_delivery_applied_at, sequence)
      WHERE post_delivery_json IS NOT NULL
        AND post_delivery_applied_at IS NULL
        AND state IN ('queued', 'sending', 'delivered');
    CREATE INDEX outbox_deliveries_claim_idx
      ON outbox_deliveries(state, next_attempt_at, lease_until, outbox_id, destination, fragment_index);
  `);
}

function upgradeRecordedChatDatabase(
  db: BetterSqlite3.Database,
  options: { runtimeQuiesced?: boolean } = {},
) {
  const currentVersion = Number(db.pragma("user_version", { simple: true }));
  if (currentVersion > CHAT_DATABASE_SCHEMA_VERSION) {
    throw new Error(`chat_database_future_schema:${currentVersion}`);
  }
  if (currentVersion === CHAT_DATABASE_SCHEMA_VERSION) {
    validateRecordedChatDatabaseSchema(db, CHAT_DATABASE_SCHEMA_VERSION);
    return;
  }
  if (currentVersion === 0) {
    if (readChatDatabaseTables(db).size) {
      throw new Error("chat_database_partial_schema");
    }
    return;
  }

  validateRecordedChatDatabaseSchema(db, currentVersion);
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
  const canonicalRunUpgradeSql = `
    CREATE INDEX IF NOT EXISTS turns_run_idx
      ON turns(run_id, state, sequence)
      WHERE run_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS chat_runs (
      run_id TEXT PRIMARY KEY,
      chat_key TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 0),
      state TEXT NOT NULL
        CHECK (state IN ('running', 'draining', 'terminal', 'manual_review')),
      owner_epoch TEXT NOT NULL,
      producer_incarnation TEXT NOT NULL,
      delivery_turn_id TEXT NOT NULL REFERENCES turns(turn_id) ON DELETE RESTRICT,
      terminal_delivery_turn_id TEXT REFERENCES turns(turn_id) ON DELETE RESTRICT,
      terminal_kind TEXT,
      terminal_payload_json TEXT,
      terminal_payload_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      terminal_at TEXT,
      CHECK (
        (state IN ('running', 'draining')
          AND terminal_delivery_turn_id IS NULL
          AND terminal_kind IS NULL
          AND terminal_payload_json IS NULL
          AND terminal_payload_hash IS NULL
          AND terminal_at IS NULL)
        OR
        (state IN ('terminal', 'manual_review')
          AND terminal_delivery_turn_id IS NOT NULL
          AND terminal_kind IS NOT NULL
          AND terminal_at IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS chat_runs_state_idx
      ON chat_runs(state, updated_at, chat_key);
  `;
  const durableTurnAdmissionUpgradeSql = `
    ALTER TABLE turns ADD COLUMN admission_state TEXT NOT NULL DEFAULT 'unclassified'
      CHECK (admission_state IN ('unclassified', 'actionable', 'record_only'));
    ALTER TABLE turns ADD COLUMN admission_json TEXT;
    ALTER TABLE turns ADD COLUMN admission_hash TEXT;
    ALTER TABLE turns ADD COLUMN submission_json TEXT;
    ALTER TABLE turns ADD COLUMN submission_hash TEXT;
    ALTER TABLE turns ADD COLUMN execution_session_file TEXT;
    UPDATE turns
       SET admission_state = CASE
         WHEN EXISTS (
           SELECT 1 FROM messages
            WHERE messages.id = turns.inbound_message_id
              AND (messages.accepted_at IS NOT NULL
                   OR messages.disposition = 'actionable')
         ) THEN 'actionable'
         WHEN EXISTS (
           SELECT 1 FROM messages
            WHERE messages.id = turns.inbound_message_id
              AND messages.disposition = 'record_only'
         ) THEN 'record_only'
         ELSE 'unclassified'
       END,
           admission_json = CASE
             WHEN EXISTS (
               SELECT 1 FROM messages
                WHERE messages.id = turns.inbound_message_id
                  AND (messages.accepted_at IS NOT NULL
                       OR messages.disposition IN ('actionable', 'record_only'))
             ) THEN json_object(
               'version', 1,
               'kind', 'legacy_message_projection'
             )
             ELSE NULL
           END,
           execution_session_file = (
             SELECT messages.session_file FROM messages
              WHERE messages.id = turns.inbound_message_id
           );
  `;

  if (currentVersion <= 6) {
    if (currentVersion === 1) {
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
        ${durableTurnAdmissionUpgradeSql}
      `);
    } else if (currentVersion === 2) {
      db.exec(`
        ALTER TABLE chat_state ADD COLUMN session_file TEXT;
        ALTER TABLE chat_state ADD COLUMN legacy_session_imported INTEGER NOT NULL DEFAULT 0
          CHECK (legacy_session_imported IN (0, 1));
        ALTER TABLE outbox ADD COLUMN dispatch_started_at TEXT;
        ${inboundRecoveryLeaseUpgradeSql}
        ${durableTurnAdmissionUpgradeSql}
      `);
    } else if (currentVersion === 3) {
      db.exec(`
        ALTER TABLE outbox ADD COLUMN dispatch_started_at TEXT;
        ${inboundRecoveryLeaseUpgradeSql}
        ${durableTurnAdmissionUpgradeSql}
      `);
    } else if (currentVersion === 4) {
      db.exec(
        `${inboundRecoveryLeaseUpgradeSql}\n${durableTurnAdmissionUpgradeSql}`,
      );
    } else if (currentVersion === 5) {
      db.exec(durableTurnAdmissionUpgradeSql);
    } else if (currentVersion !== 6) {
      throw new Error(`chat_database_unsupported_schema:${currentVersion}`);
    }
    try {
      const activeRuns = Number(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS count FROM turns WHERE state = 'running'`,
            )
            .get() as { count?: number }
        )?.count || 0,
      );
      if (activeRuns > 0 && options.runtimeQuiesced !== true) {
        throw new Error(
          `chat_database_canonical_run_drain_required:${activeRuns}`,
        );
      }
      if (!tableHasColumn(db, "turns", "run_id")) {
        db.exec(`ALTER TABLE turns ADD COLUMN run_id TEXT;`);
      }
      db.exec(canonicalRunUpgradeSql);
    } catch (error: any) {
      throw new Error(
        `chat_database_canonical_run_upgrade_failed:${String(error?.message || error)}`,
      );
    }
  } else if (currentVersion !== 7 && currentVersion !== 8) {
    throw new Error(`chat_database_unsupported_schema:${currentVersion}`);
  }

  const supportsCanonicalReconciliation = currentVersion >= 6;
  const legacyTurns = supportsCanonicalReconciliation
    ? Number(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS count FROM turns
                WHERE run_id IS NULL
                  AND (
                    state = 'running'
                    OR (
                      state = 'pending' AND attempt > 0
                      AND json_valid(admission_json)
                      AND json_extract(admission_json, '$.kind') = 'message'
                    )
                  )`,
            )
            .get() as { count?: number }
        )?.count || 0,
      )
    : 0;
  const orphanedRuns =
    currentVersion >= 7
      ? Number(
          (
            db
              .prepare(
                `SELECT COUNT(*) AS count
                   FROM chat_runs r
                  WHERE r.state = 'running'
                    AND NOT EXISTS (
                      SELECT 1 FROM turns t
                       WHERE t.run_id = r.run_id
                         AND t.state IN ('pending', 'running')
                    )`,
              )
              .get() as { count?: number }
          )?.count || 0,
        )
      : 0;
  if (
    (legacyTurns > 0 || orphanedRuns > 0) &&
    options.runtimeQuiesced !== true
  ) {
    throw new Error(
      `chat_database_canonical_run_drain_required:${legacyTurns + orphanedRuns}`,
    );
  }
  const interruptedTurns =
    options.runtimeQuiesced && supportsCanonicalReconciliation
      ? interruptUnfencedLegacyTurnsForCanonicalUpgrade(db)
      : [];
  const retiredRunIds =
    options.runtimeQuiesced && currentVersion >= 7
      ? reconcileOrphanedTransitionalCanonicalRuns(db)
      : [];
  for (const { chatKey } of interruptedTurns) {
    db.prepare(
      `UPDATE chat_state
          SET session_file = NULL, legacy_session_imported = 0, updated_at = ?
        WHERE chat_key = ?`,
    ).run(nowIso(), chatKey);
  }
  if (supportsCanonicalReconciliation) {
    recordCanonicalReconciliation(db, {
      interruptedTurns,
      retiredRunIds,
    });
    for (const runId of retiredRunIds) {
      db.prepare(
        `UPDATE turns
         SET state = 'failed', terminal_kind = 'interrupted',
             last_error = 'chat_turn_interrupted', owner_epoch = NULL,
             lease_until = NULL, heartbeat_at = NULL, next_attempt_at = NULL,
             updated_at = ?
         WHERE run_id = ?`,
      ).run(new Date().toISOString(), runId);
    }
  }
  rebuildChatDeliveryTablesV9(db);
  finishSchemaUpgrade(db, "inbox_jobs");
}

function assertNoActiveOldAdmissionOwner(
  db: BetterSqlite3.Database,
  currentVersion: number,
) {
  if (!currentVersion || !tableHasColumn(db, "turns", "lease_until")) return;
  const timestamp = nowIso();
  const hasDurableAdmission = tableHasColumn(db, "turns", "admission_json");
  const hasRunId = tableHasColumn(db, "turns", "run_id");
  const active = hasDurableAdmission
    ? db
        .prepare(
          `SELECT turns.turn_id
             FROM turns
            WHERE turns.state = 'running' AND turns.lease_until > ?
              ${hasRunId ? "AND turns.run_id IS NULL" : ""}
              AND json_valid(turns.admission_json)
              AND json_extract(turns.admission_json, '$.kind') IN (?, ?)
            LIMIT 1`,
        )
        .get(timestamp, ...OLD_ADMISSION_KINDS)
    : db
        .prepare(
          `SELECT turns.turn_id
             FROM turns
             JOIN messages ON messages.id = turns.inbound_message_id
            WHERE turns.state = 'running' AND turns.lease_until > ?
              ${hasRunId ? "AND turns.run_id IS NULL" : ""}
              AND (messages.accepted_at IS NOT NULL
                   OR messages.disposition = 'actionable')
            LIMIT 1`,
        )
        .get(timestamp);
  if (active) {
    throw new Error("chat_install_migration_active_legacy_turn");
  }
}

function assertNoUnfencedRunningTurns(
  db: BetterSqlite3.Database,
  currentVersion: number,
) {
  if (currentVersion <= 0 || !readChatDatabaseTables(db).has("turns")) return;
  const hasRunId = tableHasColumn(db, "turns", "run_id");
  const activeRuns = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM turns
            WHERE ${hasRunId ? "run_id IS NULL AND " : ""}
              (
                state = 'running'
                ${currentVersion >= 6 && currentVersion < 8 ? "OR (state = 'pending' AND attempt > 0 AND json_valid(admission_json) AND json_extract(admission_json, '$.kind') = 'message')" : ""}
              )`,
        )
        .get() as { count?: number }
    )?.count || 0,
  );
  if (activeRuns > 0) {
    throw new Error(`chat_database_canonical_run_drain_required:${activeRuns}`);
  }
}

function terminalOutboxKindForInstall(
  db: BetterSqlite3.Database,
  turnId: string,
) {
  const row = db
    .prepare(
      `SELECT delivery_kind FROM outbox
        WHERE turn_id = ?
          AND (delivery_kind IN ('final', 'error', 'command_ack')
               OR post_delivery_json IS NOT NULL)
        LIMIT 1`,
    )
    .get(turnId) as any;
  const deliveryKind = safeString(row?.delivery_kind).trim();
  if (deliveryKind === "final") return "outbox_final";
  if (deliveryKind === "error") return "outbox_error";
  if (deliveryKind === "command_ack") return "command_ack";
  return row ? "outbox_terminal" : "";
}

function hasAssistantReplyForInstall(
  db: BetterSqlite3.Database,
  chatKey: string,
  messageId: string,
) {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM messages
          WHERE chat_key = ? AND role = 'assistant'
            AND reply_to_message_id = ? AND processed_at IS NOT NULL
            AND COALESCE(delivery_kind, 'final')
                NOT IN ('interim', 'passive_notice')
          LIMIT 1`,
      )
      .get(chatKey, messageId),
  );
}

function hasLaterHandledUserMessageForInstall(
  db: BetterSqlite3.Database,
  chatKey: string,
  sequence: number,
) {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM messages
          WHERE chat_key = ? AND role = 'user' AND sequence > ?
            AND processed_at IS NOT NULL
          LIMIT 1`,
      )
      .get(chatKey, sequence),
  );
}

function consumeOldAdmissionRowsForInstall(db: BetterSqlite3.Database) {
  return db
    .transaction(() => {
      const timestamp = nowIso();
      let migratedTurns = 0;
      let orphanedMessages = 0;
      let interruptedUnknown = 0;
      let historyResolved = 0;
      const hasRunId = tableHasColumn(db, "inbox_jobs", "run_id");
      const rows = db
        .prepare(
          `SELECT inbox_jobs.turn_id, inbox_jobs.state, inbox_jobs.admission_state,
                  inbox_jobs.chat_key, inbox_jobs.sequence,
                  ${hasRunId ? "inbox_jobs.run_id" : "NULL AS run_id"},
                  messages.id AS message_row_id, messages.message_id
             FROM inbox_jobs
             JOIN messages ON messages.id = inbox_jobs.inbound_message_id
            WHERE json_valid(inbox_jobs.admission_json)
              AND json_extract(inbox_jobs.admission_json, '$.kind') IN (?, ?)
            ORDER BY inbox_jobs.chat_key, inbox_jobs.sequence`,
        )
        .all(...OLD_ADMISSION_KINDS) as any[];
      for (const row of rows) {
        const state = safeString(row.state);
        const recordOnly = safeString(row.admission_state) === "record_only";
        if (safeString(row.run_id).trim()) {
          db.prepare(
            `UPDATE inbox_jobs
                SET admission_state = 'unclassified', admission_json = NULL,
                    admission_hash = NULL, submission_json = NULL,
                    submission_hash = NULL, updated_at = ?
              WHERE turn_id = ?`,
          ).run(timestamp, row.turn_id);
        } else if (state === "superseded") {
          db.prepare(
            `UPDATE inbox_jobs
                SET state = 'failed', terminal_kind = 'interrupted',
                    owner_epoch = NULL, lease_until = NULL,
                    heartbeat_at = NULL, updated_at = ?
              WHERE turn_id = ?`,
          ).run(timestamp, row.turn_id);
          db.prepare(
            `UPDATE messages SET disposition = 'record_only', updated_at = ?
              WHERE id = ?`,
          ).run(timestamp, row.message_row_id);
        } else if (state !== "terminal") {
          const chatKey = safeString(row.chat_key).trim();
          const messageId = safeString(row.message_id).trim();
          let targetState = "terminal";
          let terminalKind = "record_only";
          let disposition = "record_only";
          if (!recordOnly) {
            disposition = "actionable";
            const outboxKind = terminalOutboxKindForInstall(
              db,
              safeString(row.turn_id),
            );
            if (outboxKind) {
              terminalKind = outboxKind;
              historyResolved += 1;
            } else if (hasAssistantReplyForInstall(db, chatKey, messageId)) {
              terminalKind = "legacy_reply_observed";
              historyResolved += 1;
            } else if (
              hasLaterHandledUserMessageForInstall(
                db,
                chatKey,
                Number(row.sequence),
              )
            ) {
              targetState = "failed";
              terminalKind = "interrupted";
              disposition = "record_only";
              historyResolved += 1;
            } else {
              terminalKind = "interrupted_unknown";
              interruptedUnknown += 1;
            }
          }
          db.prepare(
            `UPDATE inbox_jobs
                SET state = ?, terminal_kind = ?, owner_epoch = NULL,
                    lease_until = NULL, heartbeat_at = NULL,
                    next_attempt_at = NULL, last_error = NULL,
                    admission_state = 'unclassified', admission_json = NULL,
                    admission_hash = NULL, submission_json = NULL,
                    submission_hash = NULL, updated_at = ?
              WHERE turn_id = ?`,
          ).run(targetState, terminalKind, timestamp, row.turn_id);
          db.prepare(
            `UPDATE messages
                SET processed_at = COALESCE(processed_at, ?),
                    disposition = ?
              WHERE id = ?`,
          ).run(timestamp, disposition, row.message_row_id);
        } else {
          db.prepare(
            `UPDATE inbox_jobs
                SET admission_state = 'unclassified', admission_json = NULL,
                    admission_hash = NULL, submission_json = NULL,
                    submission_hash = NULL, updated_at = ?
              WHERE turn_id = ?`,
          ).run(timestamp, row.turn_id);
        }
        migratedTurns += 1;
      }

      // These rows have no turn, and outbox.turn_id is a foreign key to inbox_jobs,
      // so a turn-owned terminal outbox cannot exist for an accepted orphan.
      const orphanRows = db
        .prepare(
          `SELECT messages.id, messages.chat_key, messages.message_id,
                  messages.generation, messages.sequence,
                  messages.session_file, messages.received_at
             FROM messages
            WHERE messages.role = 'user'
              AND messages.accepted_at IS NOT NULL
              AND messages.processed_at IS NULL
              AND messages.disposition IN ('unclassified', 'actionable')
              AND NOT EXISTS (
                SELECT 1 FROM inbox_jobs
                 WHERE inbox_jobs.inbound_message_id = messages.id
              )
            ORDER BY messages.chat_key, messages.sequence`,
        )
        .all() as any[];
      for (const row of orphanRows) {
        const chatKey = safeString(row.chat_key).trim();
        const messageId = safeString(row.message_id).trim();
        if (!chatKey || !messageId) {
          throw new Error("chat_install_migration_invalid_accepted_orphan");
        }
        const replyBoundary = hasAssistantReplyForInstall(
          db,
          chatKey,
          messageId,
        );
        const laterHandled = hasLaterHandledUserMessageForInstall(
          db,
          chatKey,
          Number(row.sequence),
        );
        if (replyBoundary || laterHandled) {
          db.prepare(
            `UPDATE messages
                SET processed_at = COALESCE(processed_at, ?), disposition = ?
              WHERE id = ?`,
          ).run(timestamp, laterHandled ? "record_only" : "actionable", row.id);
          orphanedMessages += 1;
          historyResolved += 1;
          continue;
        }
        db.prepare(
          `INSERT INTO inbox_jobs (
             turn_id, inbound_message_id, chat_key, generation, sequence,
             state, terminal_kind, owner_epoch, attempt, lease_until,
             heartbeat_at, next_attempt_at, last_error, routing_json,
             session_json, elements_json, admission_state, admission_json,
             admission_hash, submission_json, submission_hash,
             execution_session_file, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'terminal', 'interrupted_unknown', NULL,
                     0, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                     'unclassified', NULL, NULL, NULL, NULL, ?, ?, ?)`,
        ).run(
          row.id,
          row.id,
          chatKey,
          Number(row.generation),
          Number(row.sequence),
          safeString(row.session_file).trim() || null,
          safeString(row.received_at).trim() || timestamp,
          timestamp,
        );
        db.prepare(
          `UPDATE messages
              SET processed_at = COALESCE(processed_at, ?),
                  disposition = 'actionable'
            WHERE id = ?`,
        ).run(timestamp, row.id);
        interruptedUnknown += 1;
        orphanedMessages += 1;
      }
      const releasedCurrentClaims = db
        .prepare(
          `UPDATE inbox_jobs
              SET state = 'failed', terminal_kind = 'interrupted',
                  owner_epoch = NULL, lease_until = NULL,
                  heartbeat_at = NULL, next_attempt_at = NULL,
                  last_error = 'chat_turn_interrupted', updated_at = ?
            WHERE state = 'running' ${hasRunId ? "AND run_id IS NULL" : ""}`,
        )
        .run(timestamp).changes;

      const previous = readAdmissionModelInstallMigrationSummary(db);
      const summary = {
        turns: previous.turns + migratedTurns,
        orphanedMessages: previous.orphanedMessages + orphanedMessages,
        interruptedUnknown: previous.interruptedUnknown + interruptedUnknown,
        historyResolved: previous.historyResolved + historyResolved,
        legacyNotices: previous.legacyNotices,
        releasedCurrentClaims:
          previous.releasedCurrentClaims + releasedCurrentClaims,
      };
      db.prepare(
        `INSERT INTO schema_meta (key, value)
         VALUES ('admission_model_migration_summary', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(JSON.stringify(summary));
      db.prepare(
        `INSERT INTO schema_meta (key, value)
         VALUES ('admission_model_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(CHAT_ADMISSION_MODEL_VERSION);
      return summary;
    })
    .immediate();
}

export function readAdmissionModelInstallMigrationSummary(
  db: BetterSqlite3.Database,
) {
  const text = safeString(
    (
      db
        .prepare(
          `SELECT value FROM schema_meta
            WHERE key = 'admission_model_migration_summary'`,
        )
        .get() as any
    )?.value,
  ).trim();
  if (!text) {
    return {
      turns: 0,
      orphanedMessages: 0,
      interruptedUnknown: 0,
      historyResolved: 0,
      legacyNotices: 0,
      releasedCurrentClaims: 0,
    };
  }
  const parsed = JSON.parse(text);
  return {
    turns: Math.max(0, Number(parsed?.turns || 0)),
    orphanedMessages: Math.max(0, Number(parsed?.orphanedMessages || 0)),
    interruptedUnknown: Math.max(0, Number(parsed?.interruptedUnknown || 0)),
    historyResolved: Math.max(0, Number(parsed?.historyResolved || 0)),
    legacyNotices: Math.max(
      0,
      Number(parsed?.legacyNotices ?? parsed?.notices ?? 0),
    ),
    releasedCurrentClaims: Math.max(
      0,
      Number(parsed?.releasedCurrentClaims || 0),
    ),
  };
}

export function preflightChatDatabaseMigrationForInstall(
  agentDir: string,
  options: { runtimeWillBeQuiesced?: boolean } = {},
) {
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
      if (options.runtimeWillBeQuiesced !== true) {
        assertNoActiveOldAdmissionOwner(db, currentVersion);
        assertNoUnfencedRunningTurns(db, currentVersion);
      }
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
  options: { runtimeQuiesced?: boolean } = {},
) {
  closeChatDatabase(agentDir);
  const dbPath = chatDatabasePath(agentDir);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  let needsInitialization = !fs.existsSync(dbPath);
  if (!needsInitialization) {
    const probe = new BetterSqlite3(dbPath);
    try {
      configureChatDatabase(probe);
      needsInitialization =
        Number(probe.pragma("user_version", { simple: true })) === 0;
    } finally {
      probe.close();
    }
  }
  if (needsInitialization) {
    openChatDatabaseForInstall(agentDir);
    closeChatDatabase(agentDir);
  }

  const migrationDb = new BetterSqlite3(dbPath);
  try {
    configureChatDatabase(migrationDb);
    const currentVersion = Number(
      migrationDb.pragma("user_version", { simple: true }),
    );
    if (currentVersion < CHAT_DATABASE_SCHEMA_VERSION) {
      migrationDb.pragma("foreign_keys = OFF");
    }
    migrationDb
      .transaction(() => {
        if (options.runtimeQuiesced !== true) {
          assertNoActiveOldAdmissionOwner(migrationDb, currentVersion);
          assertNoUnfencedRunningTurns(migrationDb, currentVersion);
        }
        upgradeRecordedChatDatabase(migrationDb, options);
        migrationDb
          .prepare(
            `DELETE FROM schema_meta WHERE key = 'admission_model_version'`,
          )
          .run();
        migrateLegacyChatControlData(agentDir, migrationDb);
        consumeOldAdmissionRowsForInstall(migrationDb);
      })
      .exclusive();
    const foreignKeyViolations = migrationDb.pragma(
      "foreign_key_check",
    ) as any[];
    if (foreignKeyViolations.length > 0) {
      throw new Error("chat_database_foreign_key_mismatch");
    }
    migrationDb.pragma("foreign_keys = ON");
  } finally {
    migrationDb.close();
  }
  retireLegacyTerminalWal(agentDir);
  return openChatDatabaseForInstall(agentDir);
}
