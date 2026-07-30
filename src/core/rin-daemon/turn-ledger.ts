import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";

import { coreDataPath } from "../data-layout.js";
import { safeString } from "../text-utils.js";
import { nowIso } from "../time-utils.js";

export type DaemonChatDeliveryContext = {
  turnId: string;
  chatKey: string;
  messageId: string;
};

export type DaemonTurnState = "active" | "complete" | "error" | "interrupted";

export type DaemonTurnRecord = {
  requestTag: string;
  sessionFile?: string;
  sessionId?: string;
  chatDeliveryContext?: DaemonChatDeliveryContext;
  state: DaemonTurnState;
  terminalId?: string;
  terminalEvent?: Record<string, unknown>;
  createdAt: string;
  terminalAt?: string;
  acknowledgedAt?: string;
};

type BeginDaemonTurnInput = {
  requestTag: string;
  sessionFile?: string;
  sessionId?: string;
  chatDeliveryContext?: DaemonChatDeliveryContext;
};

type TerminalDaemonTurnInput = {
  requestTag: string;
  terminalKind: "complete" | "error";
  terminalEvent: Record<string, unknown>;
};

type TurnRow = {
  request_tag: string;
  session_file: string | null;
  session_id: string | null;
  transport_turn_id: string | null;
  chat_key: string | null;
  message_id: string | null;
  state: DaemonTurnState;
  terminal_id: string | null;
  terminal_event_json: string | null;
  created_at: string;
  terminal_at: string | null;
  acknowledged_at: string | null;
};

const databases = new Map<string, BetterSqlite3.Database>();

export function resolveDaemonTurnLedgerPath(agentDir: string) {
  return coreDataPath(agentDir, "daemon", "turn-ledger.sqlite");
}

function requireText(value: unknown, marker: string) {
  const normalized = safeString(value).trim();
  if (!normalized) throw new Error(marker);
  return normalized;
}

function optionalText(value: unknown) {
  return safeString(value).trim() || null;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown) {
  return JSON.stringify(canonicalValue(value));
}

function normalizeChatContext(
  input: unknown,
): DaemonChatDeliveryContext | undefined {
  if (input == null) return undefined;
  const value = input as Record<string, unknown>;
  return {
    turnId: requireText(value.turnId, "rin_turn_ledger_turn_id_required"),
    chatKey: requireText(value.chatKey, "rin_turn_ledger_chat_key_required"),
    messageId: requireText(
      value.messageId,
      "rin_turn_ledger_message_id_required",
    ),
  };
}

function normalizeBegin(input: BeginDaemonTurnInput) {
  return {
    requestTag: requireText(
      input.requestTag,
      "rin_turn_ledger_request_tag_required",
    ),
    sessionFile: optionalText(input.sessionFile),
    sessionId: optionalText(input.sessionId),
    chatDeliveryContext: normalizeChatContext(input.chatDeliveryContext),
  };
}

function rowToRecord(row: TurnRow): DaemonTurnRecord {
  const context = row.transport_turn_id
    ? {
        turnId: row.transport_turn_id,
        chatKey: row.chat_key!,
        messageId: row.message_id!,
      }
    : undefined;
  return {
    requestTag: row.request_tag,
    ...(row.session_file ? { sessionFile: row.session_file } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(context ? { chatDeliveryContext: context } : {}),
    state: row.state,
    ...(row.terminal_id ? { terminalId: row.terminal_id } : {}),
    ...(row.terminal_event_json
      ? { terminalEvent: JSON.parse(row.terminal_event_json) }
      : {}),
    createdAt: row.created_at,
    ...(row.terminal_at ? { terminalAt: row.terminal_at } : {}),
    ...(row.acknowledged_at ? { acknowledgedAt: row.acknowledged_at } : {}),
  };
}

function turnLedgerTableSql(tableName = "turn_records") {
  return `
    CREATE TABLE ${tableName} (
      request_tag TEXT PRIMARY KEY,
      session_file TEXT,
      session_id TEXT,
      transport_turn_id TEXT UNIQUE,
      chat_key TEXT,
      message_id TEXT,
      state TEXT NOT NULL
        CHECK (state IN ('active', 'complete', 'error', 'interrupted')),
      terminal_id TEXT UNIQUE,
      terminal_event_json TEXT,
      created_at TEXT NOT NULL,
      terminal_at TEXT,
      acknowledged_at TEXT,
      CHECK (
        (transport_turn_id IS NULL AND chat_key IS NULL AND message_id IS NULL)
        OR
        (transport_turn_id IS NOT NULL AND chat_key IS NOT NULL AND message_id IS NOT NULL)
      ),
      CHECK (
        (state = 'active'
          AND terminal_id IS NULL
          AND terminal_event_json IS NULL
          AND terminal_at IS NULL
          AND acknowledged_at IS NULL)
        OR
        (state IN ('complete', 'error', 'interrupted')
          AND terminal_id IS NOT NULL
          AND terminal_event_json IS NOT NULL
          AND terminal_at IS NOT NULL)
      )
    );
  `;
}

function createTurnLedgerIndexes(db: BetterSqlite3.Database) {
  db.exec(`
    CREATE UNIQUE INDEX turn_records_chat_message_idx
      ON turn_records(chat_key, message_id)
      WHERE chat_key IS NOT NULL AND message_id IS NOT NULL;
    CREATE INDEX turn_records_unacknowledged_chat_idx
      ON turn_records(chat_key, terminal_at)
      WHERE transport_turn_id IS NOT NULL
        AND state != 'active'
        AND acknowledged_at IS NULL;
  `);
}

function initialize(db: BetterSqlite3.Database) {
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("busy_timeout = 5000");
  const version = Number(db.pragma("user_version", { simple: true }) || 0);
  if (version > 2) throw new Error("rin_turn_ledger_newer_schema");
  if (version === 0) {
    db.exec(turnLedgerTableSql());
    createTurnLedgerIndexes(db);
    db.pragma("user_version = 2");
    return;
  }
  if (version === 1) {
    const migrate = db.transaction(() => {
      db.exec(`
        ALTER TABLE turn_records RENAME TO turn_records_v1;
        DROP INDEX IF EXISTS turn_records_unacknowledged_chat_idx;
        ${turnLedgerTableSql()}
        INSERT INTO turn_records (
          request_tag, session_file, session_id,
          transport_turn_id, chat_key, message_id,
          state, terminal_id, terminal_event_json,
          created_at, terminal_at, acknowledged_at
        )
        SELECT request_tag, session_file, session_id,
               transport_turn_id, chat_key, message_id,
               state, terminal_id, terminal_event_json,
               created_at, terminal_at, acknowledged_at
          FROM turn_records_v1;
        DROP TABLE turn_records_v1;
      `);
      createTurnLedgerIndexes(db);
      db.pragma("user_version = 2");
    });
    migrate();
  }
}

function open(agentDir: string) {
  const dbPath = resolveDaemonTurnLedgerPath(agentDir);
  const existing = databases.get(dbPath);
  if (existing?.open) return existing;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new BetterSqlite3(dbPath);
  initialize(db);
  databases.set(dbPath, db);
  return db;
}

function readRow(db: BetterSqlite3.Database, requestTag: string) {
  return db
    .prepare(`SELECT * FROM turn_records WHERE request_tag = ?`)
    .get(requestTag) as TurnRow | undefined;
}

export function beginDaemonTurn(
  agentDir: string,
  input: BeginDaemonTurnInput,
): { created: boolean; record: DaemonTurnRecord } {
  const normalized = normalizeBegin(input);
  const db = open(agentDir);
  const existing = readRow(db, normalized.requestTag);
  if (existing) {
    const expected = {
      requestTag: normalized.requestTag,
      sessionFile: normalized.sessionFile,
      sessionId: normalized.sessionId,
      chatDeliveryContext: normalized.chatDeliveryContext,
    };
    const actual = {
      requestTag: existing.request_tag,
      sessionFile: existing.session_file,
      sessionId: existing.session_id,
      chatDeliveryContext: existing.transport_turn_id
        ? {
            turnId: existing.transport_turn_id,
            chatKey: existing.chat_key,
            messageId: existing.message_id,
          }
        : undefined,
    };
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      throw new Error("rin_turn_ledger_begin_conflict");
    }
    return { created: false, record: rowToRecord(existing) };
  }
  const context = normalized.chatDeliveryContext;
  db.prepare(
    `INSERT INTO turn_records (
       request_tag, session_file, session_id,
       transport_turn_id, chat_key, message_id,
       state, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
  ).run(
    normalized.requestTag,
    normalized.sessionFile,
    normalized.sessionId,
    context?.turnId || null,
    context?.chatKey || null,
    context?.messageId || null,
    nowIso(),
  );
  return {
    created: true,
    record: rowToRecord(readRow(db, normalized.requestTag)!),
  };
}

export function readDaemonTurn(agentDir: string, requestTag: string) {
  const requiredTag = requireText(
    requestTag,
    "rin_turn_ledger_request_tag_required",
  );
  const row = readRow(open(agentDir), requiredTag);
  return row ? rowToRecord(row) : undefined;
}

function terminalId(requestTag: string) {
  return `terminal-${crypto.createHash("sha256").update(requestTag).digest("hex")}`;
}

function terminalize(
  agentDir: string,
  requestTag: string,
  state: Exclude<DaemonTurnState, "active">,
  terminalEvent: Record<string, unknown>,
) {
  const requiredTag = requireText(
    requestTag,
    "rin_turn_ledger_request_tag_required",
  );
  const db = open(agentDir);
  const transaction = db.transaction(() => {
    const existing = readRow(db, requiredTag);
    if (!existing) throw new Error("rin_turn_ledger_record_missing");
    const eventJson = canonicalJson(terminalEvent);
    if (existing.state !== "active") {
      if (
        existing.state !== state ||
        existing.terminal_event_json !== eventJson
      ) {
        throw new Error("rin_turn_ledger_terminal_conflict");
      }
      return rowToRecord(existing);
    }
    db.prepare(
      `UPDATE turn_records
          SET state = ?, terminal_id = ?, terminal_event_json = ?, terminal_at = ?
        WHERE request_tag = ? AND state = 'active'`,
    ).run(state, terminalId(requiredTag), eventJson, nowIso(), requiredTag);
    return rowToRecord(readRow(db, requiredTag)!);
  });
  return transaction();
}

export function recordDaemonTurnTerminal(
  agentDir: string,
  input: TerminalDaemonTurnInput,
) {
  const requestTag = requireText(
    input.requestTag,
    "rin_turn_ledger_request_tag_required",
  );
  const eventRequestTag = requireText(
    input.terminalEvent?.requestTag,
    "rin_turn_ledger_terminal_request_tag_required",
  );
  if (eventRequestTag !== requestTag) {
    throw new Error("rin_turn_ledger_terminal_request_mismatch");
  }
  const event = safeString(input.terminalEvent?.event).trim();
  if (event !== input.terminalKind) {
    throw new Error("rin_turn_ledger_terminal_kind_mismatch");
  }
  return terminalize(
    agentDir,
    requestTag,
    input.terminalKind,
    input.terminalEvent,
  );
}

export function interruptDaemonTurn(
  agentDir: string,
  requestTag: string,
  reason: string,
) {
  const requiredTag = requireText(
    requestTag,
    "rin_turn_ledger_request_tag_required",
  );
  const record = readDaemonTurn(agentDir, requiredTag);
  if (!record) throw new Error("rin_turn_ledger_record_missing");
  if (record.state !== "active") return record;
  return terminalize(agentDir, requiredTag, "interrupted", {
    type: "rpc_turn_event",
    event: "error",
    requestTag: requiredTag,
    ...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    error: requireText(reason, "rin_turn_ledger_interrupt_reason_required"),
    terminalSource: "daemon_supervisor",
  });
}

export function interruptActiveDaemonTurns(agentDir: string, reason: string) {
  const requiredReason = requireText(
    reason,
    "rin_turn_ledger_interrupt_reason_required",
  );
  const db = open(agentDir);
  const tags = db
    .prepare(`SELECT request_tag FROM turn_records WHERE state = 'active'`)
    .all() as Array<{ request_tag: string }>;
  const transaction = db.transaction(() => {
    for (const row of tags) {
      interruptDaemonTurn(agentDir, row.request_tag, requiredReason);
    }
  });
  transaction();
  return tags.length;
}

export function daemonTurnTerminalEvent(record: DaemonTurnRecord) {
  if (
    record.state === "active" ||
    !record.terminalId ||
    !record.terminalEvent
  ) {
    throw new Error("rin_turn_ledger_terminal_missing");
  }
  return {
    ...record.terminalEvent,
    ...(record.chatDeliveryContext
      ? { chatDeliveryContext: record.chatDeliveryContext }
      : {}),
    terminalRecord: {
      terminalId: record.terminalId,
      state: record.state,
      terminalAt: record.terminalAt,
    },
  };
}

export function listUnacknowledgedChatTerminals(
  agentDir: string,
  chatKey?: string,
) {
  const normalizedChatKey = safeString(chatKey).trim();
  const rows = (
    normalizedChatKey
      ? open(agentDir)
          .prepare(
            `SELECT * FROM turn_records
            WHERE chat_key = ?
              AND state != 'active'
              AND acknowledged_at IS NULL
            ORDER BY terminal_at, request_tag`,
          )
          .all(normalizedChatKey)
      : open(agentDir)
          .prepare(
            `SELECT * FROM turn_records
            WHERE transport_turn_id IS NOT NULL
              AND state != 'active'
              AND acknowledged_at IS NULL
            ORDER BY terminal_at, request_tag`,
          )
          .all()
  ) as TurnRow[];
  return rows.map(rowToRecord);
}

export function acknowledgeDaemonTurnTerminal(
  agentDir: string,
  input: { requestTag: string; terminalId: string },
) {
  const requestTag = requireText(
    input.requestTag,
    "rin_turn_ledger_request_tag_required",
  );
  const requiredTerminalId = requireText(
    input.terminalId,
    "rin_turn_ledger_terminal_id_required",
  );
  const db = open(agentDir);
  const row = readRow(db, requestTag);
  if (!row || row.state === "active") {
    throw new Error("rin_turn_ledger_terminal_missing");
  }
  if (row.terminal_id !== requiredTerminalId) {
    throw new Error("rin_turn_ledger_terminal_id_mismatch");
  }
  if (!row.acknowledged_at) {
    db.prepare(
      `UPDATE turn_records
          SET acknowledged_at = ?
        WHERE request_tag = ? AND acknowledged_at IS NULL`,
    ).run(nowIso(), requestTag);
  }
  return rowToRecord(readRow(db, requestTag)!);
}

export function inspectDaemonTurnLedger(agentDir: string) {
  const db = open(agentDir);
  return {
    path: resolveDaemonTurnLedgerPath(agentDir),
    journalMode: safeString(db.pragma("journal_mode", { simple: true })),
    userVersion: Number(db.pragma("user_version", { simple: true }) || 0),
  };
}

export function closeDaemonTurnLedger(agentDir: string) {
  const dbPath = resolveDaemonTurnLedgerPath(agentDir);
  const db = databases.get(dbPath);
  if (!db) return;
  databases.delete(dbPath);
  if (db.open) db.close();
}
