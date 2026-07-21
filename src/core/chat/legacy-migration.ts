import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type BetterSqlite3 from "better-sqlite3";

import { chatDataPath } from "../data-layout.js";
import { writeJsonAtomic } from "../platform/fs.js";
import { safeString } from "../text-utils.js";
import { getChatMessageStoreLayout } from "./message-store-layout.js";
import { validateChatOutboxPayloadParts } from "./outbox-payload-validation.js";
import {
  BOT_QUALIFIED_CHAT_PLATFORMS,
  composeCanonicalChatKeyValue,
  parseLegacyUnqualifiedChatKeyValue,
  resolveLegacyChatKeyRecordBotIds,
} from "./chat-key-record-resolution.js";
import type { StoredChatMessage } from "./message-store.js";

const MIGRATION_KEY = "legacy_control_migration";
const MIGRATION_SOURCE_FINGERPRINT_KEY =
  "legacy_control_migration_source_fingerprint";
const COMPLETE = "complete_v1";
const MIGRATION_PRESERVED_KEY = "legacy_control_migration_preserved";

type PreservedLegacyRecord = {
  kind: "message" | "inbox" | "outbox";
  filePath: string;
  reason: string;
};

type PreservedLegacyRecordSummary = {
  version: 1;
  total: number;
  reasons: Record<string, number>;
};

function emptyPreservedLegacyRecordSummary(): PreservedLegacyRecordSummary {
  return { version: 1, total: 0, reasons: {} };
}

function preservedLegacyRecordReason(error: unknown) {
  const message = safeString((error as any)?.message || error).trim();
  for (const prefix of [
    "chat_legacy_migration_invalid_json",
    "chat_legacy_migration_invalid_message_identity",
    "chat_legacy_migration_invalid_message_timestamp",
    "chat_legacy_migration_invalid_timestamp",
    "chat_legacy_migration_invalid_inbox_chat_key",
    "chat_legacy_migration_invalid_inbox",
    "chat_legacy_migration_invalid_outbox",
  ]) {
    if (message === prefix || message.startsWith(`${prefix}:`)) return prefix;
  }
  if (
    message === "chat_outbox_empty_message" ||
    message.startsWith("chat_outbox_invalid_part:") ||
    message.startsWith("chat_outbox_media_missing:")
  ) {
    return message;
  }
  return "";
}

function preserveLegacyRecord(
  records: PreservedLegacyRecord[],
  kind: PreservedLegacyRecord["kind"],
  filePath: string,
  error: unknown,
) {
  const reason = preservedLegacyRecordReason(error);
  if (!reason) return false;
  if (
    !records.some(
      (record) => record.kind === kind && record.filePath === filePath,
    )
  ) {
    records.push({ kind, filePath, reason });
  }
  return true;
}

function summarizePreservedLegacyRecords(
  records: PreservedLegacyRecord[],
): PreservedLegacyRecordSummary {
  const reasons: Record<string, number> = {};
  for (const record of records) {
    reasons[record.reason] = (reasons[record.reason] || 0) + 1;
  }
  return {
    version: 1,
    total: records.length,
    reasons: Object.fromEntries(
      Object.entries(reasons).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  };
}

function nowIso() {
  return new Date().toISOString();
}

function hashKey(value: string) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function readMigrationState(db: BetterSqlite3.Database) {
  return safeString(
    (
      db
        .prepare(`SELECT value FROM schema_meta WHERE key = ?`)
        .get(MIGRATION_KEY) as any
    )?.value,
  ).trim();
}

function collectFiles(root: string) {
  const files: string[] = [];
  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error: any) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files.push(target);
    }
  };
  visit(root);
  return files;
}

function collectJsonFiles(root: string) {
  const files: string[] = [];
  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error: any) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(filePath);
      else if (entry.isFile() && entry.name.endsWith(".json")) {
        files.push(filePath);
      }
    }
  };
  visit(root);
  return files.sort();
}

function readLegacyJson(filePath: string) {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error: any) {
    throw new Error(
      `chat_legacy_migration_read_failed:${filePath}:${safeString(error?.message || error)}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (error: any) {
    throw new Error(
      `chat_legacy_migration_invalid_json:${filePath}:${safeString(error?.message || error)}`,
    );
  }
}

function parseChatKey(chatKey: string) {
  const slash = chatKey.indexOf("/");
  const colon = chatKey.indexOf(":", slash + 1);
  if (slash <= 0 || colon <= slash + 1 || colon >= chatKey.length - 1) {
    return null;
  }
  return {
    platform: chatKey.slice(0, slash),
    botId: chatKey.slice(slash + 1, colon),
    chatId: chatKey.slice(colon + 1),
  };
}

const ARCHIVED_UNQUALIFIED_CHAT_PLATFORMS = new Set(["github", "matrix"]);

function parseArchivedUnqualifiedChatKey(chatKey: string) {
  const colon = chatKey.indexOf(":");
  if (colon <= 0 || colon >= chatKey.length - 1) return null;
  const platform = chatKey.slice(0, colon);
  if (!ARCHIVED_UNQUALIFIED_CHAT_PLATFORMS.has(platform)) return null;
  return {
    platform,
    chatId: chatKey.slice(colon + 1),
  };
}

function resolveLegacyMessageIdentity(raw: any) {
  const chatKey = safeString(raw?.chatKey).trim();
  const platform = safeString(raw?.platform).trim();
  const botId = safeString(raw?.botId).trim();
  const chatId = safeString(raw?.chatId).trim();

  // Retired adapters were intentionally excluded from the earlier
  // bot-qualified key migration. Parse their platform:chatId shape first so
  // slashes or later colons inside chatId cannot be mistaken for delimiters.
  const archived = parseArchivedUnqualifiedChatKey(chatKey);
  if (archived) {
    if (platform !== archived.platform || chatId !== archived.chatId) {
      return null;
    }
    return { chatKey, platform, botId, chatId };
  }

  const canonical = parseChatKey(chatKey);
  if (!canonical) return null;
  return {
    chatKey,
    platform: platform || canonical.platform,
    botId: botId || canonical.botId,
    chatId: chatId || canonical.chatId,
  };
}

function optionalText(value: unknown) {
  return safeString(value).trim() || null;
}

function normalizeOptionalLegacyTimestamp(value: unknown, field: string) {
  const text = safeString(value).trim();
  if (!text) return null;
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`chat_legacy_migration_invalid_timestamp:${field}`);
  }
  return new Date(timestamp).toISOString();
}

function optionalNumber(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function optionalJson(value: unknown) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function normalizeLegacyMessage(raw: any) {
  const identity = resolveLegacyMessageIdentity(raw);
  const messageId = safeString(raw?.messageId).trim();
  if (!identity || !messageId) {
    throw new Error("chat_legacy_migration_invalid_message_identity");
  }
  const receivedAtText =
    safeString(raw?.receivedAt || raw?.processedAt || raw?.acceptedAt).trim() ||
    nowIso();
  const receivedAtMs = Date.parse(receivedAtText);
  if (!Number.isFinite(receivedAtMs)) {
    throw new Error("chat_legacy_migration_invalid_message_timestamp");
  }
  const receivedAt = new Date(receivedAtMs).toISOString();
  const recordKey =
    safeString(raw?.recordKey).trim() ||
    hashKey(`${identity.chatKey}\n${messageId}`);
  const record = {
    ...raw,
    version: 1,
    recordKey,
    chatKey: identity.chatKey,
    messageId,
    platform: identity.platform,
    botId: identity.botId,
    chatId: identity.chatId,
    receivedAt,
    acceptedAt:
      normalizeOptionalLegacyTimestamp(raw?.acceptedAt, "acceptedAt") ||
      undefined,
    processedAt:
      normalizeOptionalLegacyTimestamp(raw?.processedAt, "processedAt") ||
      undefined,
    lastReceivedAt:
      normalizeOptionalLegacyTimestamp(raw?.lastReceivedAt, "lastReceivedAt") ||
      undefined,
    updatedAt:
      normalizeOptionalLegacyTimestamp(raw?.updatedAt, "updatedAt") ||
      undefined,
  };
  delete record.sessionId;
  return record;
}

function sortLegacyMessagesInTimelineOrder(
  entries: Array<{ filePath: string; raw: any }>,
) {
  return entries
    .sort((a, b) => {
      const left = normalizeLegacyMessage(a.raw);
      const right = normalizeLegacyMessage(b.raw);
      return (
        Date.parse(left.receivedAt) - Date.parse(right.receivedAt) ||
        left.chatKey.localeCompare(right.chatKey) ||
        left.messageId.localeCompare(right.messageId) ||
        a.filePath.localeCompare(b.filePath)
      );
    })
    .map((entry) => entry.raw);
}

function insertLegacyMessage(
  db: BetterSqlite3.Database,
  raw: any,
  nextSequence: Map<string, number>,
) {
  const record = normalizeLegacyMessage(raw);
  const existing = db
    .prepare(
      `SELECT id, sequence, generation FROM messages WHERE chat_key = ? AND message_id = ?`,
    )
    .get(record.chatKey, record.messageId) as any;
  if (existing) return existing;

  let sequence = nextSequence.get(record.chatKey);
  if (!sequence) {
    const row = db
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
         FROM messages WHERE chat_key = ?`,
      )
      .get(record.chatKey) as any;
    sequence = Math.max(1, Number(row?.next_sequence || 1));
  }
  nextSequence.set(record.chatKey, sequence + 1);
  const generation = 0;
  db.prepare(
    `INSERT INTO messages (
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
    )`,
  ).run({
    id: record.recordKey,
    record_key: record.recordKey,
    chat_key: record.chatKey,
    message_id: record.messageId,
    platform: record.platform,
    bot_id: optionalText(record.botId),
    chat_id: record.chatId,
    role:
      record.role === "user" || record.role === "assistant"
        ? record.role
        : null,
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
    chat_type:
      record.chatType === "private" || record.chatType === "group"
        ? record.chatType
        : null,
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
    disposition:
      record.role === "user"
        ? record.processedAt
          ? "actionable"
          : "unclassified"
        : "record_only",
    record_json: JSON.stringify(record),
  });
  db.prepare(
    `INSERT INTO chat_state (chat_key, current_generation, next_sequence, updated_at)
     VALUES (?, 0, ?, ?)
     ON CONFLICT(chat_key) DO UPDATE SET
       next_sequence = MAX(chat_state.next_sequence, excluded.next_sequence),
       updated_at = excluded.updated_at`,
  ).run(record.chatKey, sequence + 1, nowIso());
  if (record.role === "user" && safeString(record.botId).trim()) {
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
        updated_at = excluded.updated_at
      WHERE COALESCE(excluded.platform_timestamp, 0) >
              COALESCE(inbound_heads.platform_timestamp, 0)
         OR (
           COALESCE(excluded.platform_timestamp, 0) =
             COALESCE(inbound_heads.platform_timestamp, 0)
           AND excluded.sequence >= inbound_heads.sequence
         )`,
    ).run(
      record.platform,
      record.botId,
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
  return { id: record.recordKey, sequence, generation };
}

function legacyInboxState(filePath: string) {
  if (filePath.includes(`${path.sep}failed${path.sep}`)) return "failed";
  return "pending";
}

function legacyInboxToMessage(item: any) {
  const chatKey = safeString(item?.chatKey).trim();
  const session =
    item?.session && typeof item.session === "object" ? item.session : {};
  const identity = resolveLegacyMessageIdentity({
    chatKey,
    platform: session.platform,
    botId: session.selfId,
    chatId: session.channelId || session.chatId,
  });
  if (!identity) {
    throw new Error("chat_legacy_migration_invalid_inbox_chat_key");
  }
  return {
    chatKey: identity.chatKey,
    messageId: safeString(item?.messageId).trim(),
    platform: identity.platform,
    botId: identity.botId,
    chatId: identity.chatId,
    role: "user",
    receivedAt: safeString(item?.createdAt).trim() || nowIso(),
    text: safeString(
      item?.routing?.text || session?.stripped?.content || session?.content,
    ),
    rawContent: safeString(session?.content),
    strippedContent: safeString(session?.stripped?.content),
    elements: Array.isArray(item?.elements) ? item.elements : [],
    acceptedAt:
      normalizeOptionalLegacyTimestamp(item?.acceptedAt, "inbox.acceptedAt") ||
      undefined,
  };
}

function importLegacyInbox(
  db: BetterSqlite3.Database,
  inboxRoot: string,
  nextSequence: Map<string, number>,
  preservedRecords: PreservedLegacyRecord[],
) {
  const importItem = db.transaction((filePath: string) => {
    const item = readLegacyJson(filePath);
    const chatKey = safeString(item?.chatKey).trim();
    const messageId = safeString(item?.messageId).trim();
    if (!chatKey || !messageId) {
      throw new Error(`chat_legacy_migration_invalid_inbox:${filePath}`);
    }
    const message = insertLegacyMessage(
      db,
      legacyInboxToMessage(item),
      nextSequence,
    );
    const turnId =
      safeString(item?.itemId).trim() || hashKey(`${chatKey}\n${messageId}`);
    const timestamp =
      normalizeOptionalLegacyTimestamp(
        item?.updatedAt || item?.createdAt,
        "inbox.updatedAt",
      ) || nowIso();
    let state = legacyInboxState(filePath);
    if (
      state === "pending" &&
      db
        .prepare(
          `SELECT 1 FROM messages
           WHERE chat_key = ? AND role = 'user' AND sequence > ?
             AND processed_at IS NOT NULL
           LIMIT 1`,
        )
        .get(chatKey, Number(message.sequence))
    ) {
      state = "superseded";
      db.prepare(
        `UPDATE messages SET disposition = 'superseded' WHERE id = ?`,
      ).run(message.id);
    }
    db.prepare(
      `INSERT INTO turns (
        turn_id, inbound_message_id, chat_key, generation, sequence, state,
        terminal_kind, owner_epoch, attempt, lease_until, heartbeat_at,
        next_attempt_at, last_error, routing_json, session_json, elements_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(inbound_message_id) DO NOTHING`,
    ).run(
      turnId,
      message.id,
      chatKey,
      Number(message.generation || 0),
      Number(message.sequence),
      state,
      state === "failed"
        ? "legacy_failed"
        : state === "superseded"
          ? "legacy_later_handled"
          : null,
      Math.max(0, Number(item?.attemptCount || 0)),
      normalizeOptionalLegacyTimestamp(
        item?.nextAttemptAt,
        "inbox.nextAttemptAt",
      ),
      optionalText(item?.lastError),
      JSON.stringify(item?.routing || {}),
      JSON.stringify(item?.session || {}),
      JSON.stringify(Array.isArray(item?.elements) ? item.elements : []),
      normalizeOptionalLegacyTimestamp(item?.createdAt, "inbox.createdAt") ||
        timestamp,
      timestamp,
    );
  });
  for (const filePath of collectJsonFiles(inboxRoot)) {
    try {
      importItem(filePath);
    } catch (error) {
      if (preserveLegacyRecord(preservedRecords, "inbox", filePath, error)) {
        continue;
      }
      throw error;
    }
  }
}

function normalizeLegacyOutboxState(value: unknown) {
  const state = safeString(value).trim();
  return state === "sending" || state === "delivered" || state === "failed"
    ? state
    : "queued";
}

const NON_AUTHORITATIVE_OUTBOX_DIRECTORIES = new Set([
  "archived-manual",
  "invalid",
]);

function importLegacyOutbox(
  db: BetterSqlite3.Database,
  outboxRoot: string,
  preservedRecords: PreservedLegacyRecord[],
) {
  let fallbackSequence = Number(
    (
      db
        .prepare(`SELECT COALESCE(MAX(sequence), 0) AS value FROM outbox`)
        .get() as any
    )?.value || 0,
  );
  for (const filePath of collectJsonFiles(outboxRoot)) {
    const topLevelDirectory = path
      .relative(outboxRoot, filePath)
      .split(path.sep, 1)[0];
    if (NON_AUTHORITATIVE_OUTBOX_DIRECTORIES.has(topLevelDirectory)) continue;
    try {
      db.transaction(() => {
        const item = readLegacyJson(filePath);
        const sourcePayload =
          item?.payload && typeof item.payload === "object"
            ? item.payload
            : item;
        const legacyText = safeString(sourcePayload?.text).trim();
        const payload =
          (!Array.isArray(sourcePayload?.parts) ||
            !sourcePayload.parts.length) &&
          legacyText
            ? {
                ...sourcePayload,
                parts: [{ type: "text" as const, text: legacyText }],
              }
            : sourcePayload;
        const chatKey = safeString(payload?.chatKey).trim();
        const outboxId = safeString(item?.id).trim();
        if (
          !chatKey ||
          !outboxId ||
          !Array.isArray(payload?.parts) ||
          !payload.parts.length
        ) {
          throw new Error(`chat_legacy_migration_invalid_outbox:${filePath}`);
        }
        const legacyState = normalizeLegacyOutboxState(item?.status);
        validateChatOutboxPayloadParts(payload, {
          requireLocalFiles:
            legacyState === "queued" || legacyState === "sending",
        });
        const wasSending = legacyState === "sending";
        const state = wasSending ? "delivered" : legacyState;
        const deliveryUnconfirmed =
          wasSending || item?.deliveryUnconfirmed === true;
        const sequence = Number.isFinite(Number(item?.sequence))
          ? Number(item.sequence)
          : ++fallbackSequence;
        const createdAt =
          normalizeOptionalLegacyTimestamp(
            item?.createdAt || payload?.createdAt,
            "outbox.createdAt",
          ) || nowIso();
        const updatedAt =
          normalizeOptionalLegacyTimestamp(
            item?.updatedAt,
            "outbox.updatedAt",
          ) || createdAt;
        const deliveryResult = Array.isArray(item?.deliveryResult)
          ? item.deliveryResult
              .map((value: unknown) => safeString(value).trim())
              .filter(Boolean)
          : [];
        db.prepare(
          `INSERT INTO outbox (
        outbox_id, turn_id, idempotency_key, chat_key, delivery_kind, state,
        payload_json, post_delivery_json, adapter_id, adapter_version, plan_state,
        sequence, attempts, owner_epoch, lease_until, next_attempt_at, last_error,
        failure_kind, delivery_unconfirmed, delivery_result_json, created_at,
        updated_at, delivered_at, failed_at
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, '1', 'planned', ?, ?, NULL,
                NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(outbox_id) DO NOTHING`,
        ).run(
          outboxId,
          optionalText(item?.idempotencyKey),
          chatKey,
          safeString(item?.deliveryKind).trim() || "generic",
          state,
          JSON.stringify(payload),
          optionalJson(item?.postDelivery),
          chatKey.split("/", 1)[0] || "unknown",
          sequence,
          Math.max(0, Number(item?.attempts || 0)),
          wasSending
            ? null
            : normalizeOptionalLegacyTimestamp(
                item?.nextAttemptAt,
                "outbox.nextAttemptAt",
              ),
          wasSending
            ? "chat_outbox_legacy_sending_ambiguous"
            : optionalText(item?.lastError),
          wasSending ? null : optionalText(item?.failureKind),
          deliveryUnconfirmed ? 1 : 0,
          deliveryResult.length ? JSON.stringify(deliveryResult) : null,
          createdAt,
          updatedAt,
          wasSending
            ? normalizeOptionalLegacyTimestamp(
                item?.deliveredAt,
                "outbox.deliveredAt",
              ) || updatedAt
            : normalizeOptionalLegacyTimestamp(
                item?.deliveredAt,
                "outbox.deliveredAt",
              ),
          normalizeOptionalLegacyTimestamp(item?.failedAt, "outbox.failedAt"),
        );
        const fragments = deliveryResult.length ? deliveryResult : [null];
        fragments.forEach((providerMessageId, index) => {
          const fragmentState =
            state === "delivered"
              ? deliveryUnconfirmed
                ? "unconfirmed"
                : "delivered"
              : state === "failed"
                ? "failed"
                : "queued";
          db.prepare(
            `INSERT INTO outbox_deliveries (
          delivery_id, outbox_id, destination, fragment_index, state,
          payload_json, owner_epoch, attempt, lease_until, next_attempt_at,
          last_error, provider_message_id, created_at, updated_at,
          delivered_at, failed_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(outbox_id, destination, fragment_index) DO NOTHING`,
          ).run(
            `${outboxId}:${index}`,
            outboxId,
            chatKey,
            index,
            fragmentState,
            JSON.stringify(payload),
            Math.max(0, Number(item?.attempts || 0)),
            wasSending
              ? null
              : normalizeOptionalLegacyTimestamp(
                  item?.nextAttemptAt,
                  "outbox.delivery.nextAttemptAt",
                ),
            wasSending
              ? "chat_outbox_legacy_sending_ambiguous"
              : optionalText(item?.lastError),
            providerMessageId,
            createdAt,
            updatedAt,
            wasSending
              ? normalizeOptionalLegacyTimestamp(
                  item?.deliveredAt,
                  "outbox.delivery.deliveredAt",
                ) || updatedAt
              : normalizeOptionalLegacyTimestamp(
                  item?.deliveredAt,
                  "outbox.delivery.deliveredAt",
                ),
            normalizeOptionalLegacyTimestamp(
              item?.failedAt,
              "outbox.delivery.failedAt",
            ),
          );
        });
      })();
    } catch (error) {
      if (preserveLegacyRecord(preservedRecords, "outbox", filePath, error)) {
        continue;
      }
      throw error;
    }
  }
}

function archiveLegacyPath(agentDir: string, source: string, name: string) {
  const archiveRoot = chatDataPath(agentDir, "legacy-migrated-v1");
  fs.mkdirSync(archiveRoot, { recursive: true });
  const target = path.join(archiveRoot, name);
  if (!fs.existsSync(source)) {
    // A prior process may have completed this atomic rename before dying.
    // Existing archive plus missing source is therefore already complete.
    return;
  }
  if (fs.existsSync(target)) {
    throw new Error(`chat_legacy_migration_archive_collision:${target}`);
  }
  fs.renameSync(source, target);
}

function legacyControlArchiveGroups(agentDir: string) {
  const archiveRoot = chatDataPath(agentDir, "legacy-migrated-v1");
  const groups: Array<{ key: string; source: string; archive: string }> = [];
  for (const [index, root] of getChatMessageStoreLayout(
    agentDir,
  ).readRoots.entries()) {
    const suffix = index === 0 ? "" : `-${index}`;
    for (const [kind, source] of [
      ["message-records", root.recordsDir],
      ["message-indexes", root.indexesDir],
    ] as const) {
      const key = `${kind}${suffix}`;
      groups.push({ key, source, archive: path.join(archiveRoot, key) });
    }
  }
  for (const key of ["inbox", "outbox"] as const) {
    groups.push({
      key,
      source: chatDataPath(agentDir, key),
      archive: path.join(archiveRoot, key),
    });
  }
  return groups;
}

function legacyControlSourceFingerprint(agentDir: string) {
  const entries: Array<[string, string, string]> = [];
  for (const group of legacyControlArchiveGroups(agentDir)) {
    for (const root of [group.source, group.archive]) {
      for (const filePath of collectFiles(root)) {
        entries.push([
          group.key,
          path.relative(root, filePath).split(path.sep).join("/"),
          crypto
            .createHash("sha256")
            .update(fs.readFileSync(filePath))
            .digest("hex"),
        ]);
      }
    }
  }
  entries.sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex");
}

function archiveLegacyControlData(agentDir: string) {
  for (const group of legacyControlArchiveGroups(agentDir)) {
    archiveLegacyPath(agentDir, group.source, group.key);
  }
}

function importLegacyControlData(agentDir: string, db: BetterSqlite3.Database) {
  const nextSequence = new Map<string, number>();
  const preservedRecords: PreservedLegacyRecord[] = [];
  const groups = legacyControlArchiveGroups(agentDir);
  const inboxRoots = groups
    .filter((group) => group.key === "inbox")
    .flatMap((group) => [group.source, group.archive]);
  const outboxRoots = groups
    .filter((group) => group.key === "outbox")
    .flatMap((group) => [group.source, group.archive]);
  const recordRoots = groups
    .filter((group) => group.key.startsWith("message-records"))
    .flatMap((group) => [group.source, group.archive]);
  const messageEntries: Array<{ filePath: string; raw: any }> = [];
  const storedMessageKeys = new Set<string>();
  for (const recordsRoot of recordRoots) {
    for (const filePath of collectJsonFiles(recordsRoot)) {
      try {
        const raw = readLegacyJson(filePath);
        const legacy = parseLegacyUnqualifiedChatKeyValue(raw?.chatKey);
        if (legacy && BOT_QUALIFIED_CHAT_PLATFORMS.has(legacy.platform)) {
          continue;
        }
        const record = normalizeLegacyMessage(raw);
        const key = JSON.stringify([record.chatKey, record.messageId]);
        if (storedMessageKeys.has(key)) continue;
        storedMessageKeys.add(key);
        messageEntries.push({ filePath, raw });
      } catch (error) {
        if (
          preserveLegacyRecord(preservedRecords, "message", filePath, error)
        ) {
          continue;
        }
        throw error;
      }
    }
  }
  for (const inboxRoot of inboxRoots) {
    for (const filePath of collectJsonFiles(inboxRoot)) {
      try {
        const raw = legacyInboxToMessage(readLegacyJson(filePath));
        const record = normalizeLegacyMessage(raw);
        const key = JSON.stringify([record.chatKey, record.messageId]);
        if (storedMessageKeys.has(key)) continue;
        storedMessageKeys.add(key);
        messageEntries.push({ filePath, raw });
      } catch (error) {
        if (preserveLegacyRecord(preservedRecords, "inbox", filePath, error)) {
          continue;
        }
        throw error;
      }
    }
  }
  for (const raw of sortLegacyMessagesInTimelineOrder(messageEntries)) {
    insertLegacyMessage(db, raw, nextSequence);
  }
  for (const inboxRoot of inboxRoots) {
    importLegacyInbox(db, inboxRoot, nextSequence, preservedRecords);
  }
  for (const outboxRoot of outboxRoots) {
    importLegacyOutbox(db, outboxRoot, preservedRecords);
  }
  return summarizePreservedLegacyRecords(preservedRecords);
}

const RESOLVED_CHAT_KEY_LEDGER = "chat-key-v1-resolved-records.json";

type ResolvedChatKeyLedgerEntry = {
  sourceChatKey: string;
  messageId: string;
  canonicalChatKey: string;
  botId: string;
  resolvedAt: string;
};

type ResolvedChatKeyLedger = {
  version: 1;
  records: Record<string, ResolvedChatKeyLedgerEntry>;
};

function resolvedChatKeyLedgerPath(agentDir: string) {
  return path.join(agentDir, "data", "migrations", RESOLVED_CHAT_KEY_LEDGER);
}

function resolvedChatKeyLedgerRecordIdFromIdentity(
  sourceChatKey: string,
  messageId: string,
) {
  return hashKey(JSON.stringify([sourceChatKey, messageId]));
}

function readResolvedChatKeyLedger(agentDir: string): ResolvedChatKeyLedger {
  const filePath = resolvedChatKeyLedgerPath(agentDir);
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return { version: 1, records: {} };
    throw new Error(
      `chat_key_migration_invalid_resolved_ledger:${safeString(error?.message || error)}`,
    );
  }
  try {
    const parsed = JSON.parse(text);
    if (
      parsed?.version !== 1 ||
      !parsed.records ||
      typeof parsed.records !== "object" ||
      Array.isArray(parsed.records)
    ) {
      throw new Error("expected version 1 records object");
    }
    for (const [recordId, rawEntry] of Object.entries(parsed.records)) {
      if (
        !rawEntry ||
        typeof rawEntry !== "object" ||
        Array.isArray(rawEntry)
      ) {
        throw new Error("expected record entry object");
      }
      const entry = rawEntry as ResolvedChatKeyLedgerEntry;
      const sourceChatKey = safeString(entry.sourceChatKey).trim();
      const messageId = safeString(entry.messageId).trim();
      const canonicalChatKey = safeString(entry.canonicalChatKey).trim();
      const botId = safeString(entry.botId).trim();
      const resolvedAt = safeString(entry.resolvedAt).trim();
      const legacy = parseLegacyUnqualifiedChatKeyValue(sourceChatKey);
      if (
        !legacy ||
        !BOT_QUALIFIED_CHAT_PLATFORMS.has(legacy.platform) ||
        !messageId ||
        !botId ||
        canonicalChatKey !==
          composeCanonicalChatKeyValue(legacy.platform, botId, legacy.chatId) ||
        !Number.isFinite(Date.parse(resolvedAt)) ||
        recordId !==
          resolvedChatKeyLedgerRecordIdFromIdentity(sourceChatKey, messageId)
      ) {
        throw new Error("invalid record entry identity");
      }
    }
    return parsed as ResolvedChatKeyLedger;
  } catch (error: any) {
    throw new Error(
      `chat_key_migration_invalid_resolved_ledger:${safeString(error?.message || error)}`,
    );
  }
}

export function validateResolvedChatKeyLedger(agentDirInput: string) {
  const ledger = readResolvedChatKeyLedger(path.resolve(agentDirInput));
  return { records: Object.keys(ledger.records).length };
}

function resolvedChatKeyLedgerRecordId(record: StoredChatMessage) {
  return resolvedChatKeyLedgerRecordIdFromIdentity(
    safeString(record.chatKey).trim(),
    safeString(record.messageId).trim(),
  );
}

function unresolvedReasonCounts(reasons: string[]) {
  const counts: Record<string, number> = {};
  for (const reason of reasons) counts[reason] = (counts[reason] || 0) + 1;
  return counts;
}

export function retryUnresolvedLegacyChatKeyMessages(
  agentDirInput: string,
  db: BetterSqlite3.Database,
) {
  const agentDir = path.resolve(agentDirInput);
  const archivedRecords: StoredChatMessage[] = [];
  const unresolvedReasons: string[] = [];
  const seenRecords = new Set<string>();
  for (const group of legacyControlArchiveGroups(agentDir)) {
    if (!group.key.startsWith("message-records")) continue;
    for (const root of [group.source, group.archive]) {
      for (const filePath of collectJsonFiles(root)) {
        let raw: StoredChatMessage;
        try {
          raw = readLegacyJson(filePath) as StoredChatMessage;
        } catch (error) {
          const reason = preservedLegacyRecordReason(error);
          if (reason) {
            unresolvedReasons.push(
              reason.replace(/^chat_legacy_migration_/, ""),
            );
            continue;
          }
          throw error;
        }
        const legacy = parseLegacyUnqualifiedChatKeyValue(raw?.chatKey);
        if (!legacy || !BOT_QUALIFIED_CHAT_PLATFORMS.has(legacy.platform)) {
          continue;
        }
        const key = JSON.stringify([
          safeString(raw.chatKey).trim(),
          safeString(raw.messageId).trim(),
        ]);
        if (seenRecords.has(key)) continue;
        seenRecords.add(key);
        archivedRecords.push(raw);
      }
    }
  }
  if (!archivedRecords.length) {
    return {
      resolvedRecords: 0,
      unresolvedRecords: unresolvedReasons.length,
      unresolvedRecordReasons: unresolvedReasonCounts(unresolvedReasons),
    };
  }

  const currentRecords = (
    db.prepare(`SELECT record_json FROM messages`).all() as Array<{
      record_json: string;
    }>
  )
    .map((row) => {
      try {
        return JSON.parse(row.record_json) as StoredChatMessage;
      } catch {
        return null;
      }
    })
    .filter((record): record is StoredChatMessage => Boolean(record));
  const combined = [...currentRecords, ...archivedRecords];
  const resolutions = resolveLegacyChatKeyRecordBotIds(combined).slice(
    currentRecords.length,
  );
  const ledger = readResolvedChatKeyLedger(agentDir);
  const nextLedger: ResolvedChatKeyLedger = {
    version: 1,
    records: { ...ledger.records },
  };
  let addedLedgerEntries = 0;
  archivedRecords.forEach((record, index) => {
    const legacy = parseLegacyUnqualifiedChatKeyValue(record.chatKey);
    const messageId = safeString(record.messageId).trim();
    if (!messageId) {
      unresolvedReasons.push("invalid_message_identity");
      return;
    }
    const recordId = resolvedChatKeyLedgerRecordId(record);
    const existing = nextLedger.records[recordId];
    if (existing) {
      if (
        existing.sourceChatKey !== safeString(record.chatKey).trim() ||
        existing.messageId !== messageId
      ) {
        throw new Error("chat_key_migration_resolved_ledger_collision");
      }
      return;
    }
    const resolution = resolutions[index];
    const botId = safeString(resolution.botId).trim();
    if (
      !legacy ||
      !botId ||
      safeString(record.platform).trim() !== legacy.platform ||
      safeString(record.chatId).trim() !== legacy.chatId
    ) {
      unresolvedReasons.push(resolution.reason || "invalid_identity");
      return;
    }
    nextLedger.records[recordId] = {
      sourceChatKey: safeString(record.chatKey).trim(),
      messageId,
      canonicalChatKey: composeCanonicalChatKeyValue(
        legacy.platform,
        botId,
        legacy.chatId,
      ),
      botId,
      resolvedAt: nowIso(),
    };
    addedLedgerEntries += 1;
  });
  if (addedLedgerEntries) {
    // Freeze each accepted historical identity before mutating SQLite. A
    // failed insert can then retry the same identity instead of reinterpreting
    // later evidence and creating a second canonical copy.
    writeJsonAtomic(resolvedChatKeyLedgerPath(agentDir), nextLedger);
  }

  const nextSequence = new Map<string, number>();
  let resolvedRecords = 0;
  for (const record of archivedRecords) {
    const entry = nextLedger.records[resolvedChatKeyLedgerRecordId(record)];
    if (!entry) continue;
    const legacy = parseLegacyUnqualifiedChatKeyValue(record.chatKey);
    const expectedChatKey = legacy
      ? composeCanonicalChatKeyValue(
          legacy.platform,
          entry.botId,
          legacy.chatId,
        )
      : "";
    if (
      !legacy ||
      entry.canonicalChatKey !== expectedChatKey ||
      safeString(record.platform).trim() !== legacy.platform ||
      safeString(record.chatId).trim() !== legacy.chatId
    ) {
      throw new Error("chat_key_migration_invalid_resolved_ledger_entry");
    }
    const exists = db
      .prepare(
        `SELECT 1 FROM messages WHERE chat_key = ? AND message_id = ? LIMIT 1`,
      )
      .get(entry.canonicalChatKey, entry.messageId);
    insertLegacyMessage(
      db,
      {
        ...record,
        recordKey: hashKey(`${entry.canonicalChatKey}\n${entry.messageId}`),
        chatKey: entry.canonicalChatKey,
        botId: entry.botId,
        platform: legacy.platform,
        chatId: legacy.chatId,
      },
      nextSequence,
    );
    if (!exists) resolvedRecords += 1;
  }
  return {
    resolvedRecords,
    unresolvedRecords: unresolvedReasons.length,
    unresolvedRecordReasons: unresolvedReasonCounts(unresolvedReasons),
  };
}

export function readLegacyControlMigrationPreservedSummary(
  db: BetterSqlite3.Database,
): PreservedLegacyRecordSummary {
  const value = safeString(
    (
      db
        .prepare(`SELECT value FROM schema_meta WHERE key = ?`)
        .get(MIGRATION_PRESERVED_KEY) as any
    )?.value,
  ).trim();
  if (!value) return emptyPreservedLegacyRecordSummary();
  try {
    const parsed = JSON.parse(value);
    if (
      parsed?.version !== 1 ||
      !Number.isInteger(parsed.total) ||
      parsed.total < 0 ||
      !parsed.reasons ||
      typeof parsed.reasons !== "object" ||
      Array.isArray(parsed.reasons) ||
      Object.entries(parsed.reasons).some(
        ([reason, count]) =>
          !reason || !Number.isInteger(count) || Number(count) < 1,
      ) ||
      (Object.values(parsed.reasons) as unknown[]).reduce<number>(
        (total, count) => total + Number(count),
        0,
      ) !== parsed.total
    ) {
      throw new Error("invalid preserved summary");
    }
    return parsed as PreservedLegacyRecordSummary;
  } catch (error: any) {
    throw new Error(
      `chat_legacy_migration_invalid_preserved_summary:${safeString(error?.message || error)}`,
    );
  }
}

export function migrateLegacyChatControlData(
  agentDirInput: string,
  db: BetterSqlite3.Database,
) {
  const agentDir = path.resolve(agentDirInput);
  let state = readMigrationState(db);
  if (!state) {
    // Import rows and rename every legacy authority path under one SQLite
    // transaction. If the process dies between filesystem renames, SQLite
    // rolls back and the next open imports from the source/archive union.
    db.transaction(() => {
      if (readMigrationState(db)) return;
      const sourceFingerprint = legacyControlSourceFingerprint(agentDir);
      const preservedRecords = importLegacyControlData(agentDir, db);
      if (legacyControlSourceFingerprint(agentDir) !== sourceFingerprint) {
        throw new Error("chat_legacy_migration_source_changed_during_import");
      }
      archiveLegacyControlData(agentDir);
      if (legacyControlSourceFingerprint(agentDir) !== sourceFingerprint) {
        throw new Error("chat_legacy_migration_archive_changed");
      }
      db.prepare(
        `INSERT INTO schema_meta (key, value) VALUES (?, ?), (?, ?), (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(
        MIGRATION_KEY,
        COMPLETE,
        MIGRATION_SOURCE_FINGERPRINT_KEY,
        sourceFingerprint,
        MIGRATION_PRESERVED_KEY,
        JSON.stringify(preservedRecords),
      );
    }).immediate();
    state = readMigrationState(db);
  }
  if (state === COMPLETE) {
    const expectedFingerprint = safeString(
      (
        db
          .prepare(`SELECT value FROM schema_meta WHERE key = ?`)
          .get(MIGRATION_SOURCE_FINGERPRINT_KEY) as any
      )?.value,
    ).trim();
    if (!expectedFingerprint) {
      throw new Error("chat_legacy_migration_source_recreated");
    }
    if (legacyControlSourceFingerprint(agentDir) !== expectedFingerprint) {
      throw new Error("chat_legacy_migration_source_changed");
    }
  } else {
    throw new Error(`chat_legacy_migration_unknown_state:${state}`);
  }
}
