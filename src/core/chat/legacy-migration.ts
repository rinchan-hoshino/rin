import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type BetterSqlite3 from "better-sqlite3";

import { chatDataPath } from "../data-layout.js";
import { safeString } from "../text-utils.js";
import { getChatMessageStoreLayout } from "./message-store-layout.js";
import { validateChatOutboxPayloadParts } from "./outbox-payload-validation.js";

const MIGRATION_KEY = "legacy_control_migration";
const MIGRATION_SOURCE_FINGERPRINT_KEY =
  "legacy_control_migration_source_fingerprint";
const COMPLETE = "complete_v1";

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
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
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
) {
  for (const filePath of collectJsonFiles(inboxRoot)) {
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
  }
}

function normalizeLegacyOutboxState(value: unknown) {
  const state = safeString(value).trim();
  return state === "sending" || state === "delivered" || state === "failed"
    ? state
    : "queued";
}

function importLegacyOutbox(db: BetterSqlite3.Database, outboxRoot: string) {
  let fallbackSequence = Number(
    (
      db
        .prepare(`SELECT COALESCE(MAX(sequence), 0) AS value FROM outbox`)
        .get() as any
    )?.value || 0,
  );
  for (const filePath of collectJsonFiles(outboxRoot)) {
    const item = readLegacyJson(filePath);
    const payload =
      item?.payload && typeof item.payload === "object" ? item.payload : item;
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
      requireLocalFiles: legacyState === "queued" || legacyState === "sending",
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
      normalizeOptionalLegacyTimestamp(item?.updatedAt, "outbox.updatedAt") ||
      createdAt;
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
      const raw = readLegacyJson(filePath);
      const record = normalizeLegacyMessage(raw);
      const key = JSON.stringify([record.chatKey, record.messageId]);
      if (storedMessageKeys.has(key)) continue;
      storedMessageKeys.add(key);
      messageEntries.push({ filePath, raw });
    }
  }
  for (const inboxRoot of inboxRoots) {
    for (const filePath of collectJsonFiles(inboxRoot)) {
      const raw = legacyInboxToMessage(readLegacyJson(filePath));
      const record = normalizeLegacyMessage(raw);
      const key = JSON.stringify([record.chatKey, record.messageId]);
      if (storedMessageKeys.has(key)) continue;
      storedMessageKeys.add(key);
      messageEntries.push({ filePath, raw });
    }
  }
  for (const raw of sortLegacyMessagesInTimelineOrder(messageEntries)) {
    insertLegacyMessage(db, raw, nextSequence);
  }
  for (const inboxRoot of inboxRoots) {
    importLegacyInbox(db, inboxRoot, nextSequence);
  }
  for (const outboxRoot of outboxRoots) {
    importLegacyOutbox(db, outboxRoot);
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
      importLegacyControlData(agentDir, db);
      if (legacyControlSourceFingerprint(agentDir) !== sourceFingerprint) {
        throw new Error("chat_legacy_migration_source_changed_during_import");
      }
      archiveLegacyControlData(agentDir);
      if (legacyControlSourceFingerprint(agentDir) !== sourceFingerprint) {
        throw new Error("chat_legacy_migration_archive_changed");
      }
      db.prepare(
        `INSERT INTO schema_meta (key, value) VALUES (?, ?), (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(
        MIGRATION_KEY,
        COMPLETE,
        MIGRATION_SOURCE_FINGERPRINT_KEY,
        sourceFingerprint,
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
    if (
      !expectedFingerprint ||
      legacyControlArchiveGroups(agentDir).some((group) =>
        fs.existsSync(group.source),
      )
    ) {
      throw new Error("chat_legacy_migration_source_recreated");
    }
  } else {
    throw new Error(`chat_legacy_migration_unknown_state:${state}`);
  }
}
