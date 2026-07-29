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

function finishSchemaUpgrade(db: BetterSqlite3.Database) {
  const admissionsWithoutHash = db
    .prepare(
      `SELECT turn_id, admission_json
         FROM turns
        WHERE admission_json IS NOT NULL AND admission_hash IS NULL`,
    )
    .all() as Array<{ turn_id: string; admission_json: string }>;
  const writeAdmissionHash = db.prepare(
    `UPDATE turns SET admission_hash = ?
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

function interruptRunningTurnsForCanonicalUpgrade(db: BetterSqlite3.Database) {
  const turns = db
    .prepare(
      `SELECT t.turn_id AS turnId,
              t.chat_key AS chatKey,
              m.message_id AS messageId
         FROM turns t
         JOIN messages m ON m.id = t.inbound_message_id
        WHERE t.state = 'running' AND t.run_id IS NULL
        ORDER BY t.sequence ASC, t.turn_id ASC`,
    )
    .all() as Array<{ turnId: string; chatKey: string; messageId: string }>;
  if (!turns.length) return;

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
      WHERE turn_id = ? AND state = 'running'`,
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
  finishSchemaUpgrade(db);
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
            WHERE state = 'running'${hasRunId ? " AND run_id IS NULL" : ""}`,
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
      const rows = db
        .prepare(
          `SELECT turns.turn_id, turns.state, turns.admission_state,
                  turns.chat_key, turns.sequence, turns.run_id,
                  messages.id AS message_row_id, messages.message_id
             FROM turns
             JOIN messages ON messages.id = turns.inbound_message_id
            WHERE json_valid(turns.admission_json)
              AND json_extract(turns.admission_json, '$.kind') IN (?, ?)
            ORDER BY turns.chat_key, turns.sequence`,
        )
        .all(...OLD_ADMISSION_KINDS) as any[];
      for (const row of rows) {
        const state = safeString(row.state);
        const recordOnly = safeString(row.admission_state) === "record_only";
        if (safeString(row.run_id).trim()) {
          db.prepare(
            `UPDATE turns
                SET admission_state = 'unclassified', admission_json = NULL,
                    admission_hash = NULL, submission_json = NULL,
                    submission_hash = NULL, updated_at = ?
              WHERE turn_id = ?`,
          ).run(timestamp, row.turn_id);
        } else if (!["terminal", "superseded"].includes(state)) {
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
              targetState = "superseded";
              terminalKind = "legacy_history_superseded";
              disposition = "superseded";
              historyResolved += 1;
            } else {
              terminalKind = "interrupted_unknown";
              interruptedUnknown += 1;
            }
          }
          db.prepare(
            `UPDATE turns
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
            `UPDATE turns
                SET admission_state = 'unclassified', admission_json = NULL,
                    admission_hash = NULL, submission_json = NULL,
                    submission_hash = NULL, updated_at = ?
              WHERE turn_id = ?`,
          ).run(timestamp, row.turn_id);
        }
        migratedTurns += 1;
      }

      // These rows have no turn, and outbox.turn_id is a foreign key to turns,
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
                SELECT 1 FROM turns
                 WHERE turns.inbound_message_id = messages.id
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
          ).run(timestamp, laterHandled ? "superseded" : "actionable", row.id);
          orphanedMessages += 1;
          historyResolved += 1;
          continue;
        }
        db.prepare(
          `INSERT INTO turns (
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
          `UPDATE turns
              SET state = 'pending', owner_epoch = NULL, lease_until = NULL,
                  heartbeat_at = NULL, next_attempt_at = NULL,
                  last_error = NULL, updated_at = ?
            WHERE state = 'running' AND run_id IS NULL`,
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
    migrationDb
      .transaction(() => {
        const currentVersion = Number(
          migrationDb.pragma("user_version", { simple: true }),
        );
        if (options.runtimeQuiesced !== true) {
          assertNoActiveOldAdmissionOwner(migrationDb, currentVersion);
          assertNoUnfencedRunningTurns(migrationDb, currentVersion);
        }
        upgradeRecordedChatDatabase(migrationDb, options);
        if (options.runtimeQuiesced === true) {
          interruptRunningTurnsForCanonicalUpgrade(migrationDb);
        }
        migrationDb
          .prepare(
            `DELETE FROM schema_meta WHERE key = 'admission_model_version'`,
          )
          .run();
        migrateLegacyChatControlData(agentDir, migrationDb);
        consumeOldAdmissionRowsForInstall(migrationDb);
      })
      .exclusive();
  } finally {
    migrationDb.close();
  }
  return openChatDatabaseForInstall(agentDir);
}
