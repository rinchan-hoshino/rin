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
import { parseChatKey } from "./support.js";

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

function upgradeRecordedChatDatabase(db: BetterSqlite3.Database) {
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
  } else {
    throw new Error(`chat_database_unsupported_schema:${currentVersion}`);
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
  const active = hasDurableAdmission
    ? db
        .prepare(
          `SELECT turns.turn_id
             FROM turns
            WHERE turns.state = 'running' AND turns.lease_until > ?
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
              AND (messages.accepted_at IS NOT NULL
                   OR messages.disposition = 'actionable')
            LIMIT 1`,
        )
        .get(timestamp);
  if (active) {
    throw new Error("chat_install_migration_active_legacy_turn");
  }
}

function migrationOutboxId(turnId: string) {
  return createHash("sha256")
    .update(`chat-install-migration-interrupted-unknown:${turnId}`)
    .digest("hex");
}

function enqueueInterruptedUnknownForInstall(
  db: BetterSqlite3.Database,
  input: {
    turnId: string;
    chatKey: string;
    messageId: string;
    sessionFile?: string;
    timestamp: string;
  },
) {
  const existing = db
    .prepare(
      `SELECT 1 FROM outbox
        WHERE turn_id = ?
          AND (delivery_kind IN ('final', 'error', 'command_ack')
               OR post_delivery_json IS NOT NULL)
        LIMIT 1`,
    )
    .get(input.turnId);
  if (existing) return false;
  const sequence = Number(
    (
      db
        .prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM outbox`)
        .get() as any
    )?.value || 1,
  );
  const payload = {
    createdAt: input.timestamp,
    chatKey: input.chatKey,
    deliveryKind: "error",
    ...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
    parts: [
      { type: "quote", id: input.messageId },
      {
        type: "text",
        text: "The previous turn was interrupted, and Rin could not verify whether it completed. It was not submitted again.",
      },
    ],
  };
  const result = db
    .prepare(
      `INSERT INTO outbox (
         outbox_id, turn_id, idempotency_key, chat_key, delivery_kind,
         state, payload_json, plan_state, sequence, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'error', 'queued', ?, 'unplanned', ?, ?, ?)
       ON CONFLICT(idempotency_key) DO NOTHING`,
    )
    .run(
      migrationOutboxId(input.turnId),
      input.turnId,
      JSON.stringify(["install_migration_interrupted_unknown", input.turnId]),
      input.chatKey,
      JSON.stringify(payload),
      sequence,
      input.timestamp,
      input.timestamp,
    );
  return result.changes === 1;
}

function consumeOldAdmissionRowsForInstall(db: BetterSqlite3.Database) {
  return db
    .transaction(() => {
      const timestamp = nowIso();
      let migratedTurns = 0;
      let orphanedMessages = 0;
      let notices = 0;
      const rows = db
        .prepare(
          `SELECT turns.turn_id, turns.state, turns.admission_state,
                  turns.chat_key, turns.execution_session_file,
                  messages.id AS message_row_id, messages.message_id,
                  messages.session_file AS message_session_file
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
        if (!["terminal", "superseded"].includes(state)) {
          const chatKey = safeString(row.chat_key).trim();
          if (!recordOnly && parseChatKey(chatKey)) {
            notices += Number(
              enqueueInterruptedUnknownForInstall(db, {
                turnId: safeString(row.turn_id),
                chatKey,
                messageId: safeString(row.message_id),
                sessionFile:
                  safeString(row.execution_session_file).trim() ||
                  safeString(row.message_session_file).trim() ||
                  undefined,
                timestamp,
              }),
            );
          }
          db.prepare(
            `UPDATE turns
                SET state = 'terminal', terminal_kind = ?, owner_epoch = NULL,
                    lease_until = NULL, heartbeat_at = NULL,
                    next_attempt_at = NULL, last_error = NULL,
                    admission_state = 'unclassified', admission_json = NULL,
                    admission_hash = NULL, submission_json = NULL,
                    submission_hash = NULL, updated_at = ?
              WHERE turn_id = ?`,
          ).run(
            recordOnly ? "record_only" : "interrupted_unknown",
            timestamp,
            row.turn_id,
          );
          db.prepare(
            `UPDATE messages
                SET processed_at = COALESCE(processed_at, ?),
                    disposition = ?
              WHERE id = ?`,
          ).run(
            timestamp,
            recordOnly ? "record_only" : "actionable",
            row.message_row_id,
          );
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
        const canDeliverNotice = Boolean(parseChatKey(chatKey));
        const replyBoundary = db
          .prepare(
            `SELECT 1 FROM messages
              WHERE chat_key = ? AND role = 'assistant'
                AND reply_to_message_id = ? AND processed_at IS NOT NULL
                AND COALESCE(delivery_kind, 'final')
                    NOT IN ('interim', 'passive_notice')
              LIMIT 1`,
          )
          .get(chatKey, messageId);
        const laterHandled = db
          .prepare(
            `SELECT 1 FROM messages
              WHERE chat_key = ? AND role = 'user' AND sequence > ?
                AND processed_at IS NOT NULL
              LIMIT 1`,
          )
          .get(chatKey, Number(row.sequence));
        if (replyBoundary || laterHandled) {
          db.prepare(
            `UPDATE messages
                SET processed_at = COALESCE(processed_at, ?), disposition = ?
              WHERE id = ?`,
          ).run(timestamp, laterHandled ? "superseded" : "actionable", row.id);
          orphanedMessages += 1;
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
        if (canDeliverNotice) {
          notices += Number(
            enqueueInterruptedUnknownForInstall(db, {
              turnId: safeString(row.id),
              chatKey,
              messageId,
              sessionFile: safeString(row.session_file).trim() || undefined,
              timestamp,
            }),
          );
        }
        orphanedMessages += 1;
      }
      const previous = readAdmissionModelInstallMigrationSummary(db);
      const summary = {
        turns: previous.turns + migratedTurns,
        orphanedMessages: previous.orphanedMessages + orphanedMessages,
        notices: previous.notices + notices,
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
  if (!text) return { turns: 0, orphanedMessages: 0, notices: 0 };
  const parsed = JSON.parse(text);
  return {
    turns: Math.max(0, Number(parsed?.turns || 0)),
    orphanedMessages: Math.max(0, Number(parsed?.orphanedMessages || 0)),
    notices: Math.max(0, Number(parsed?.notices || 0)),
  };
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
      assertNoActiveOldAdmissionOwner(db, currentVersion);
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

export function migrateChatDatabaseForInstall(agentDir: string) {
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
        assertNoActiveOldAdmissionOwner(migrationDb, currentVersion);
        upgradeRecordedChatDatabase(migrationDb);
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
