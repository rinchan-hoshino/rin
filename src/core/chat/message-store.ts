import path from "node:path";
import { createHash } from "node:crypto";

import { chatDataPath } from "../data-layout.js";
import {
  allocateChatSequenceInDatabase,
  openChatDatabase,
} from "./database.js";
import { localDateUtcBounds, normalizeLocalDateOnly } from "./date.js";
import {
  chatScopedDatePath,
  getChatMessageStoreLayout,
  sanitizePathSegment,
} from "./message-store-layout.js";
import { parseChatKey } from "./support.js";
import { normalizeSessionRef, toStoredSessionFile } from "../session/ref.js";
import { safeString } from "../text-utils.js";
import { nowIso } from "../time-utils.js";

export type StoredChatMessage = {
  version: 1;
  recordKey: string;
  messageId: string;
  role?: "user" | "assistant";
  replyToMessageId?: string;
  sessionId?: string;
  sessionFile?: string;
  acceptedAt?: string;
  processedAt?: string;
  deliveryKind?:
    | "final"
    | "interim"
    | "passive_notice"
    | "command_ack"
    | "error"
    | "generic";
  lastReceivedAt?: string;
  duplicateCount?: number;
  updatedAt?: string;
  chatKey: string;
  platform: string;
  botId?: string;
  chatId: string;
  chatThreadId?: string;
  messageThreadId?: string;
  chatType?: "private" | "group";
  receivedAt: string;
  platformTimestamp?: number;
  providerCursor?: string;
  userId?: string;
  nickname?: string;
  chatName?: string;
  trust?: string;
  text?: string;
  rawContent?: string;
  strippedContent?: string;
  elements?: Array<{ type: string; attrs?: Record<string, string> }>;
  quote?: {
    messageId?: string;
    userId?: string;
    nickname?: string;
    content?: string;
  };
};

function hashKey(value: string) {
  return createHash("sha1").update(value).digest("hex");
}

function legacyMessageStoreDir(agentDir: string) {
  return chatDataPath(agentDir, "message-store");
}

/** Legacy archive location retained only for text logs and one-time migration. */
export function chatMessageStoreDir(agentDir: string) {
  return legacyMessageStoreDir(agentDir);
}

export function chatMessageLogDir(agentDir: string) {
  return getChatMessageStoreLayout(agentDir).primaryRoot.logDir;
}

export function chatMessageLogPath(
  agentDir: string,
  chatKey: string,
  date: string,
) {
  return chatScopedDatePath(chatMessageLogDir(agentDir), chatKey, date, ".txt");
}

export function storedChatMessageTimestamp(
  record:
    | Pick<StoredChatMessage, "receivedAt" | "processedAt">
    | null
    | undefined,
) {
  if (!record) return "";
  return safeString(record.receivedAt || record.processedAt || "").trim();
}

function sortChatMessages(messages: StoredChatMessage[]) {
  return [...messages].sort((a, b) => {
    const left = Date.parse(storedChatMessageTimestamp(a)) || 0;
    const right = Date.parse(storedChatMessageTimestamp(b)) || 0;
    if (left !== right) return left - right;
    return a.recordKey.localeCompare(b.recordKey);
  });
}

export function normalizeStoredChatMessageRole(value: unknown) {
  const text = safeString(value).trim();
  return text === "user" || text === "assistant"
    ? (text as "user" | "assistant")
    : undefined;
}

export function normalizeStoredChatMessageText(
  record:
    | Pick<StoredChatMessage, "text" | "strippedContent" | "rawContent">
    | null
    | undefined,
) {
  if (!record) return "";
  return safeString(
    record.text || record.strippedContent || record.rawContent,
  ).trim();
}

export type StoredChatLogProjection = {
  timestamp: string;
  role: "user" | "assistant";
  text: string;
  messageId?: string;
  replyToMessageId?: string;
  sessionFile?: string;
  userId?: string;
  nickname?: string;
};

export function projectStoredChatMessageToChatLog(
  record: StoredChatMessage,
): StoredChatLogProjection | null {
  const role = normalizeStoredChatMessageRole(record.role);
  const text = normalizeStoredChatMessageText(record);
  if (!role || !text) return null;
  const session = normalizeSessionRef(record);
  return {
    timestamp: storedChatMessageTimestamp(record),
    role,
    text,
    messageId: safeString(record.messageId).trim() || undefined,
    replyToMessageId: safeString(record.replyToMessageId).trim() || undefined,
    sessionFile: session.sessionFile,
    userId: safeString(record.userId).trim() || undefined,
    nickname: safeString(record.nickname).trim() || undefined,
  };
}

export function buildChatMessageRecordKey(chatKey: string, messageId: string) {
  return hashKey(`${chatKey}\n${messageId}`);
}

export function buildStoredChatMessage(
  input: Omit<StoredChatMessage, "version" | "recordKey">,
) {
  const chatKey = safeString(input.chatKey).trim();
  const messageId = safeString(input.messageId).trim();
  if (!chatKey) throw new Error("chat_message_store_chatKey_required");
  if (!messageId) throw new Error("chat_message_store_messageId_required");
  return {
    ...input,
    version: 1 as const,
    recordKey: buildChatMessageRecordKey(chatKey, messageId),
    messageId,
    role: normalizeStoredChatMessageRole(input.role),
    chatKey,
  };
}

function toStoredChatMessageInput(record: StoredChatMessage) {
  const { version: _version, recordKey: _recordKey, ...input } = record;
  return input;
}

function definedStoredChatMessagePatch(
  input: Partial<Omit<StoredChatMessage, "version" | "recordKey">>,
) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<StoredChatMessage>;
}

function parseStoredTimestamp(value: unknown) {
  const parsed = Date.parse(safeString(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function pickLaterStoredTimestamp(left: unknown, right: unknown) {
  const leftText = safeString(left).trim();
  const rightText = safeString(right).trim();
  if (!leftText) return rightText;
  if (!rightText) return leftText;
  const leftTime = parseStoredTimestamp(leftText);
  const rightTime = parseStoredTimestamp(rightText);
  if (leftTime === null) return rightText;
  if (rightTime === null) return leftText;
  return rightTime > leftTime ? rightText : leftText;
}

function preferRicherStoredString(current: unknown, incoming: unknown) {
  const currentText = safeString(current);
  const incomingText = safeString(incoming);
  if (!currentText.trim())
    return incomingText.trim() ? incomingText : undefined;
  if (!incomingText.trim()) return currentText;
  return incomingText.length > currentText.length ? incomingText : currentText;
}

function preferRicherStoredElements(
  current: StoredChatMessage["elements"],
  incoming: StoredChatMessage["elements"],
) {
  const currentElements = Array.isArray(current) ? current : [];
  const incomingElements = Array.isArray(incoming) ? incoming : [];
  if (!currentElements.length)
    return incomingElements.length ? incoming : current;
  if (!incomingElements.length) return current;
  return incomingElements.length > currentElements.length ? incoming : current;
}

function mergeDuplicateInboundChatMessage(
  existing: StoredChatMessage,
  incoming: StoredChatMessage,
): StoredChatMessage {
  const patch = definedStoredChatMessagePatch(
    toStoredChatMessageInput(incoming),
  );
  const next: StoredChatMessage = {
    ...existing,
    ...patch,
    version: 1,
    recordKey: existing.recordKey,
    chatKey: existing.chatKey,
    messageId: existing.messageId,
    role: existing.role || "user",
    platform: existing.platform || incoming.platform,
    chatId: existing.chatId || incoming.chatId,
    receivedAt: existing.receivedAt || incoming.receivedAt,
    acceptedAt: existing.acceptedAt || incoming.acceptedAt,
    processedAt: existing.processedAt || incoming.processedAt,
    sessionFile: existing.sessionFile || incoming.sessionFile,
    duplicateCount: Math.max(0, Number(existing.duplicateCount || 0)) + 1,
    lastReceivedAt: pickLaterStoredTimestamp(
      existing.lastReceivedAt || existing.receivedAt,
      incoming.receivedAt,
    ),
    updatedAt: new Date().toISOString(),
  };
  next.text = preferRicherStoredString(existing.text, incoming.text);
  next.rawContent = preferRicherStoredString(
    existing.rawContent,
    incoming.rawContent,
  );
  next.strippedContent = preferRicherStoredString(
    existing.strippedContent,
    incoming.strippedContent,
  );
  next.elements = preferRicherStoredElements(
    existing.elements,
    incoming.elements,
  );
  next.quote = existing.quote || incoming.quote;
  return next;
}

export function normalizeStoredSessionFields<T extends Record<string, any>>(
  agentDir: string,
  input: T,
): T {
  const normalized: Record<string, any> = { ...input };
  if (Object.prototype.hasOwnProperty.call(normalized, "sessionFile")) {
    normalized.sessionFile = toStoredSessionFile(
      agentDir,
      normalized.sessionFile,
    );
  }
  if (Object.prototype.hasOwnProperty.call(normalized, "sessionId")) {
    delete normalized.sessionId;
  }
  return normalized as T;
}

function optionalText(value: unknown) {
  return safeString(value).trim() || null;
}

function optionalNumber(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function optionalJson(value: unknown) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function messageRow(
  record: StoredChatMessage,
  sequence: number,
  generation: number,
) {
  return {
    id: record.recordKey,
    record_key: record.recordKey,
    chat_key: record.chatKey,
    message_id: record.messageId,
    platform: record.platform,
    bot_id: optionalText(record.botId),
    chat_id: record.chatId,
    role: record.role || null,
    reply_to_message_id: optionalText(record.replyToMessageId),
    session_file: optionalText(record.sessionFile),
    accepted_at: optionalText(record.acceptedAt),
    processed_at: optionalText(record.processedAt),
    delivery_kind: optionalText(record.deliveryKind),
    last_received_at: optionalText(record.lastReceivedAt),
    duplicate_count: Math.max(0, Number(record.duplicateCount || 0)),
    updated_at: optionalText(record.updatedAt),
    chat_thread_id: optionalText(record.chatThreadId),
    message_thread_id: optionalText(record.messageThreadId),
    chat_type: record.chatType || null,
    received_at: record.receivedAt,
    platform_timestamp: optionalNumber(record.platformTimestamp),
    provider_cursor: optionalText(record.providerCursor),
    user_id: optionalText(record.userId),
    nickname: optionalText(record.nickname),
    chat_name: optionalText(record.chatName),
    trust: optionalText(record.trust),
    text: record.text ?? null,
    raw_content: record.rawContent ?? null,
    stripped_content: record.strippedContent ?? null,
    elements_json: optionalJson(record.elements),
    quote_json: optionalJson(record.quote),
    sequence,
    generation,
    disposition: record.role === "user" ? "unclassified" : "record_only",
    record_json: JSON.stringify(record),
  };
}

const MESSAGE_INSERT_SQL = `
  INSERT INTO messages (
    id, record_key, chat_key, message_id, platform, bot_id, chat_id, role,
    reply_to_message_id, session_file, accepted_at, processed_at, delivery_kind,
    last_received_at, duplicate_count, updated_at, chat_thread_id,
    message_thread_id, chat_type, received_at, platform_timestamp,
    provider_cursor, user_id, nickname, chat_name, trust, text, raw_content,
    stripped_content, elements_json, quote_json, sequence, generation,
    disposition, record_json
  ) VALUES (
    @id, @record_key, @chat_key, @message_id, @platform, @bot_id, @chat_id, @role,
    @reply_to_message_id, @session_file, @accepted_at, @processed_at, @delivery_kind,
    @last_received_at, @duplicate_count, @updated_at, @chat_thread_id,
    @message_thread_id, @chat_type, @received_at, @platform_timestamp,
    @provider_cursor, @user_id, @nickname, @chat_name, @trust, @text, @raw_content,
    @stripped_content, @elements_json, @quote_json, @sequence, @generation,
    @disposition, @record_json
  )
`;

const MESSAGE_UPDATE_SQL = `
  UPDATE messages SET
    platform = @platform,
    bot_id = @bot_id,
    chat_id = @chat_id,
    role = @role,
    reply_to_message_id = @reply_to_message_id,
    session_file = @session_file,
    accepted_at = @accepted_at,
    processed_at = @processed_at,
    delivery_kind = @delivery_kind,
    last_received_at = @last_received_at,
    duplicate_count = @duplicate_count,
    updated_at = @updated_at,
    chat_thread_id = @chat_thread_id,
    message_thread_id = @message_thread_id,
    chat_type = @chat_type,
    received_at = @received_at,
    platform_timestamp = @platform_timestamp,
    provider_cursor = @provider_cursor,
    user_id = @user_id,
    nickname = @nickname,
    chat_name = @chat_name,
    trust = @trust,
    text = @text,
    raw_content = @raw_content,
    stripped_content = @stripped_content,
    elements_json = @elements_json,
    quote_json = @quote_json,
    record_json = @record_json
  WHERE id = @id
`;

function rowToStoredChatMessage(row: any): StoredChatMessage | null {
  if (!row) return null;
  try {
    const record = JSON.parse(safeString(row.record_json));
    return record && safeString(record.messageId).trim()
      ? (record as StoredChatMessage)
      : null;
  } catch {
    return null;
  }
}

type ChatDatabase = ReturnType<typeof openChatDatabase>;

function findRowByChatAndIdInDatabase(
  db: ChatDatabase,
  chatKey: string,
  messageId: string,
) {
  return db
    .prepare(`SELECT * FROM messages WHERE chat_key = ? AND message_id = ?`)
    .get(chatKey, messageId) as any;
}

function findRowByChatAndId(
  agentDir: string,
  chatKey: string,
  messageId: string,
) {
  return findRowByChatAndIdInDatabase(
    openChatDatabase(agentDir),
    chatKey,
    messageId,
  );
}

function updateInboundHeadInDatabase(
  db: ChatDatabase,
  record: StoredChatMessage,
  sequence: number,
) {
  if (record.role !== "user") return;
  const botId = safeString(record.botId).trim();
  if (!botId) return;
  db.prepare(
    `INSERT INTO inbound_heads (
      platform, bot_id, chat_key, chat_id, message_id, platform_timestamp,
      received_at, provider_cursor, sequence, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, bot_id, chat_key) DO UPDATE SET
      chat_id = excluded.chat_id,
      message_id = excluded.message_id,
      platform_timestamp = excluded.platform_timestamp,
      received_at = excluded.received_at,
      provider_cursor = excluded.provider_cursor,
      sequence = excluded.sequence,
      updated_at = excluded.updated_at,
      recovery_failure_count = 0,
      recovery_first_failed_at = NULL,
      recovery_last_failed_at = NULL,
      recovery_paused_at = NULL,
      recovery_next_attempt_at = NULL,
      recovery_version = inbound_heads.recovery_version + 1
    WHERE COALESCE(excluded.platform_timestamp, 0) >
            COALESCE(inbound_heads.platform_timestamp, 0)
       OR (
         COALESCE(excluded.platform_timestamp, 0) =
           COALESCE(inbound_heads.platform_timestamp, 0)
         AND excluded.sequence >= inbound_heads.sequence
       )`,
  ).run(
    record.platform,
    botId,
    record.chatKey,
    record.chatId,
    record.messageId,
    optionalNumber(record.platformTimestamp),
    record.receivedAt,
    optionalText(record.providerCursor),
    sequence,
    nowIso(),
  );
}

function insertRecordInDatabase(db: ChatDatabase, record: StoredChatMessage) {
  const { sequence, generation } = allocateChatSequenceInDatabase(
    db,
    record.chatKey,
  );
  db.prepare(MESSAGE_INSERT_SQL).run(messageRow(record, sequence, generation));
  updateInboundHeadInDatabase(db, record, sequence);
  return record;
}

function updateRecordInDatabase(
  db: ChatDatabase,
  record: StoredChatMessage,
  existingRow: any,
) {
  const sequence = Number(existingRow.sequence);
  db.prepare(MESSAGE_UPDATE_SQL).run(
    messageRow(record, sequence, Number(existingRow.generation)),
  );
  updateInboundHeadInDatabase(db, record, sequence);
  return record;
}

export function saveChatMessage(
  agentDir: string,
  input: Omit<StoredChatMessage, "version" | "recordKey">,
) {
  const record = buildStoredChatMessage(
    normalizeStoredSessionFields(agentDir, input),
  );
  const db = openChatDatabase(agentDir);
  const persisted = db
    .transaction(() => {
      const existing = findRowByChatAndIdInDatabase(
        db,
        record.chatKey,
        record.messageId,
      );
      return existing
        ? updateRecordInDatabase(db, record, existing)
        : insertRecordInDatabase(db, record);
    })
    .immediate();
  return { record: persisted };
}

export function saveInboundChatMessageInDatabase(
  db: ChatDatabase,
  agentDir: string,
  input: Omit<StoredChatMessage, "version" | "recordKey">,
) {
  const normalized = buildStoredChatMessage(
    normalizeStoredSessionFields(agentDir, input),
  );
  const existingRow = findRowByChatAndIdInDatabase(
    db,
    normalized.chatKey,
    normalized.messageId,
  );
  if (!existingRow) return insertRecordInDatabase(db, normalized);
  const existing = rowToStoredChatMessage(existingRow)!;
  return updateRecordInDatabase(
    db,
    mergeDuplicateInboundChatMessage(existing, normalized),
    existingRow,
  );
}

export function saveInboundChatMessage(
  agentDir: string,
  input: Omit<StoredChatMessage, "version" | "recordKey">,
) {
  const db = openChatDatabase(agentDir);
  const record = db
    .transaction(() => saveInboundChatMessageInDatabase(db, agentDir, input))
    .immediate();
  return { record };
}

export function upsertChatMessage(
  agentDir: string,
  input: Omit<StoredChatMessage, "version" | "recordKey">,
) {
  const normalized = buildStoredChatMessage(
    normalizeStoredSessionFields(agentDir, input),
  );
  const db = openChatDatabase(agentDir);
  return db
    .transaction(() => {
      const existingRow = findRowByChatAndIdInDatabase(
        db,
        normalized.chatKey,
        normalized.messageId,
      );
      if (!existingRow) return insertRecordInDatabase(db, normalized);
      const existing = rowToStoredChatMessage(existingRow)!;
      const next: StoredChatMessage = {
        ...existing,
        ...definedStoredChatMessagePatch(toStoredChatMessageInput(normalized)),
        version: 1,
        recordKey: existing.recordKey,
        chatKey: existing.chatKey,
        messageId: existing.messageId,
        role: normalizeStoredChatMessageRole(normalized.role) || existing.role,
        platform: existing.platform,
        chatId: existing.chatId,
      };
      return updateRecordInDatabase(db, next, existingRow);
    })
    .immediate();
}

export function getChatMessagesByMessageId(
  agentDir: string,
  messageId: string,
) {
  return openChatDatabase(agentDir)
    .prepare(
      `SELECT record_json FROM messages
       WHERE message_id = ?
       ORDER BY received_at, record_key`,
    )
    .all(safeString(messageId).trim())
    .map(rowToStoredChatMessage)
    .filter((item): item is StoredChatMessage => Boolean(item));
}

export function getChatMessage(
  agentDir: string,
  chatKey: string,
  messageId: string,
) {
  return rowToStoredChatMessage(
    findRowByChatAndId(agentDir, chatKey, messageId),
  );
}

export function updateChatMessage(
  agentDir: string,
  chatKey: string,
  messageId: string,
  patch: Partial<StoredChatMessage>,
) {
  const normalizedPatch = normalizeStoredSessionFields(agentDir, patch);
  const db = openChatDatabase(agentDir);
  return db
    .transaction(() => {
      const existingRow = findRowByChatAndIdInDatabase(db, chatKey, messageId);
      const current = rowToStoredChatMessage(existingRow);
      if (!current) return null;
      const next: StoredChatMessage = {
        ...current,
        ...normalizedPatch,
        version: 1,
        recordKey: current.recordKey,
        chatKey: current.chatKey,
        messageId: current.messageId,
        role:
          normalizeStoredChatMessageRole(normalizedPatch.role) || current.role,
        platform: current.platform,
        chatId: current.chatId,
      };
      return updateRecordInDatabase(db, next, existingRow);
    })
    .immediate();
}

export function findChatMessageByChatAndId(
  agentDir: string,
  chatKey: string,
  messageId: string,
) {
  return getChatMessage(agentDir, chatKey, messageId);
}

export function listChatMessages(agentDir: string) {
  return openChatDatabase(agentDir)
    .prepare(
      `SELECT record_json FROM messages ORDER BY received_at, record_key`,
    )
    .all()
    .map(rowToStoredChatMessage)
    .filter((item): item is StoredChatMessage => Boolean(item));
}

export function listChatMessagesByChat(agentDir: string, chatKey: string) {
  const nextChatKey = safeString(chatKey).trim();
  if (!nextChatKey) return [] as StoredChatMessage[];
  return openChatDatabase(agentDir)
    .prepare(
      `SELECT record_json FROM messages
       WHERE chat_key = ?
       ORDER BY received_at, record_key`,
    )
    .all(nextChatKey)
    .map(rowToStoredChatMessage)
    .filter((item): item is StoredChatMessage => Boolean(item));
}

export type ChatMessageListWindow = {
  chatKey: string;
  before?: string;
  after?: string;
  limit?: number;
};

export function listChatMessagesByChatWindow(
  agentDir: string,
  window: ChatMessageListWindow,
) {
  const chatKey = safeString(window?.chatKey).trim();
  if (!chatKey) return [] as StoredChatMessage[];
  const before = safeString(window?.before).trim();
  const after = safeString(window?.after).trim();
  const requestedLimit = Number(window?.limit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(100, Math.trunc(requestedLimit)))
    : 20;
  const conditions = ["chat_key = ?"];
  const parameters: Array<string | number> = [chatKey];
  if (before) {
    conditions.push(
      "sequence < (SELECT sequence FROM messages WHERE chat_key = ? AND message_id = ?)",
    );
    parameters.push(chatKey, before);
  }
  if (after) {
    conditions.push(
      "sequence > (SELECT sequence FROM messages WHERE chat_key = ? AND message_id = ?)",
    );
    parameters.push(chatKey, after);
  }
  const ascending = Boolean(after);
  parameters.push(limit);
  const rows = openChatDatabase(agentDir)
    .prepare(
      `SELECT record_json FROM messages
       WHERE ${conditions.join(" AND ")}
       ORDER BY sequence ${ascending ? "ASC" : "DESC"}
       LIMIT ?`,
    )
    .all(...parameters)
    .map(rowToStoredChatMessage)
    .filter((item): item is StoredChatMessage => Boolean(item));
  return ascending ? rows : rows.reverse();
}

export function listChatMessagesByReplyTo(
  agentDir: string,
  chatKey: string,
  replyToMessageId: string,
) {
  const nextChatKey = safeString(chatKey).trim();
  const nextReplyToMessageId = safeString(replyToMessageId).trim();
  if (!nextChatKey || !nextReplyToMessageId) return [] as StoredChatMessage[];
  return openChatDatabase(agentDir)
    .prepare(
      `SELECT record_json FROM messages
       WHERE chat_key = ? AND reply_to_message_id = ?
       ORDER BY sequence`,
    )
    .all(nextChatKey, nextReplyToMessageId)
    .map(rowToStoredChatMessage)
    .filter((item): item is StoredChatMessage => Boolean(item));
}

export function listChatMessagesByChatAndDate(
  agentDir: string,
  chatKey: string,
  date: string,
) {
  const nextChatKey = safeString(chatKey).trim();
  const nextDate = normalizeLocalDateOnly(date);
  if (!nextChatKey || !nextDate) return [];
  const bounds = localDateUtcBounds(nextDate);
  if (!bounds) return [];
  const db = openChatDatabase(agentDir);
  const rows = [
    ...db
      .prepare(
        `SELECT record_json FROM messages
         WHERE chat_key = ?
           AND julianday(received_at) >= julianday(?)
           AND julianday(received_at) < julianday(?)
         ORDER BY received_at, record_key`,
      )
      .all(nextChatKey, bounds.start, bounds.end),
    ...db
      .prepare(
        `SELECT record_json FROM messages
         WHERE chat_key = ? AND received_at = ''
           AND julianday(processed_at) >= julianday(?)
           AND julianday(processed_at) < julianday(?)
         ORDER BY processed_at, record_key`,
      )
      .all(nextChatKey, bounds.start, bounds.end),
  ];
  return sortChatMessages(
    rows
      .map(rowToStoredChatMessage)
      .filter((item): item is StoredChatMessage => Boolean(item)),
  );
}

export function normalizeChatMessageLookup(
  agentDir: string,
  messageId: string,
  chatKey?: string,
) {
  const nextChatKey = safeString(chatKey).trim();
  const matches = nextChatKey
    ? (() => {
        const found = getChatMessage(agentDir, nextChatKey, messageId);
        return found ? [found] : [];
      })()
    : getChatMessagesByMessageId(agentDir, messageId);
  return matches.map((item) => ({
    ...item,
    parsedChatKey: parseChatKey(item.chatKey),
  }));
}

type ChatMessageRecordField = {
  detailLabel: string;
  summaryLabel: string;
  getValue: (record: StoredChatMessage) => string | undefined;
};

const CHAT_MESSAGE_RECORD_FIELDS: ChatMessageRecordField[] = [
  {
    detailLabel: "messageId",
    summaryLabel: "message id",
    getValue: (record) => record.messageId,
  },
  {
    detailLabel: "chatKey",
    summaryLabel: "chatKey",
    getValue: (record) => record.chatKey,
  },
  {
    detailLabel: "role",
    summaryLabel: "role",
    getValue: (record) => record.role,
  },
  {
    detailLabel: "replyToMessageId",
    summaryLabel: "reply to",
    getValue: (record) => record.replyToMessageId,
  },
  {
    detailLabel: "sessionFile",
    summaryLabel: "session file",
    getValue: (record) => record.sessionFile,
  },
  {
    detailLabel: "userId",
    summaryLabel: "sender user id",
    getValue: (record) => record.userId,
  },
  {
    detailLabel: "nickname",
    summaryLabel: "sender nickname",
    getValue: (record) => record.nickname,
  },
  {
    detailLabel: "chatName",
    summaryLabel: "chat name",
    getValue: (record) => record.chatName,
  },
  {
    detailLabel: "trust",
    summaryLabel: "sender trust",
    getValue: (record) => record.trust,
  },
  {
    detailLabel: "receivedAt",
    summaryLabel: "received at",
    getValue: (record) => record.receivedAt,
  },
  {
    detailLabel: "text",
    summaryLabel: "text",
    getValue: (record) => record.text,
  },
];

function renderChatMessageRecord(
  record: StoredChatMessage,
  renderField: (field: ChatMessageRecordField, value: string) => string,
) {
  return CHAT_MESSAGE_RECORD_FIELDS.map((field) => {
    const value = field.getValue(record);
    return value ? renderField(field, value) : "";
  })
    .filter(Boolean)
    .join("\n");
}

export function describeChatMessageRecord(record: StoredChatMessage) {
  return renderChatMessageRecord(
    record,
    (field, value) => `${field.detailLabel}=${value}`,
  );
}

export function summarizeChatMessageRecord(record: StoredChatMessage) {
  return renderChatMessageRecord(
    record,
    (field, value) => `- ${field.summaryLabel}: ${value}`,
  );
}

export function normalizeElementSummary(
  elements: any,
): Array<{ type: string; attrs?: Record<string, string> }> {
  if (!Array.isArray(elements)) return [];
  return elements.map((element) => {
    const attrs =
      element?.attrs && typeof element.attrs === "object"
        ? Object.fromEntries(
            Object.entries(element.attrs)
              .map(([key, value]) => [key, safeString(value)])
              .filter(([, value]) => value),
          )
        : undefined;
    return {
      type: sanitizePathSegment(
        safeString(element?.type).toLowerCase(),
        "unknown",
      ),
      ...(attrs && Object.keys(attrs).length ? { attrs } : {}),
    };
  });
}
