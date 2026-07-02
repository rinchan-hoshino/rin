import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import {
  type ChatMessageStoreLayout,
  type ChatMessageStoreRoot,
  chatScopedDatePath,
  getChatMessageStoreLayout,
  sanitizePathSegment,
} from "./message-store-layout.js";
import { normalizeLocalDateOnly } from "./date.js";
import { parseChatKey, readJsonFile, writeJsonFile } from "./support.js";
import { normalizeSessionRef, toStoredSessionFile } from "../session/ref.js";
import { safeString } from "../text-utils.js";

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
  lastReceivedAt?: string;
  duplicateCount?: number;
  updatedAt?: string;
  chatKey: string;
  platform: string;
  botId?: string;
  chatId: string;
  chatType?: "private" | "group";
  receivedAt: string;
  platformTimestamp?: number;
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

function dedupeStrings(values: Iterable<unknown>) {
  return [
    ...new Set(
      [...values].map((item) => safeString(item).trim()).filter(Boolean),
    ),
  ];
}

function sameStringLists(
  left: string[] | null | undefined,
  right: string[] | null | undefined,
) {
  const nextLeft = left || [];
  const nextRight = right || [];
  return (
    nextLeft.length === nextRight.length &&
    nextLeft.every((item, index) => item === nextRight[index])
  );
}

function messageStoreLayout(agentDir: string) {
  return getChatMessageStoreLayout(agentDir);
}

export function chatMessageStoreDir(agentDir: string) {
  return messageStoreLayout(agentDir).storeDir;
}

export function chatMessageLogDir(agentDir: string) {
  return messageStoreLayout(agentDir).logDir;
}

export function chatMessageLogPath(
  agentDir: string,
  chatKey: string,
  date: string,
) {
  const layout = messageStoreLayout(agentDir);
  return chatScopedDatePath(layout.logDir, chatKey, date, ".txt");
}

function refsPath(indexesRoot: string, messageId: string) {
  const key = hashKey(messageId);
  return path.join(
    indexesRoot,
    "by-message-id",
    key.slice(0, 2),
    `${key}.json`,
  );
}

function normalizeRefs(value: unknown) {
  return dedupeStrings(Array.isArray(value) ? value : []);
}

function readRefs(indexesRoot: string, messageId: string) {
  const stored = readJsonFile<string[] | null>(
    refsPath(indexesRoot, messageId),
    null,
  );
  return stored === null ? null : normalizeRefs(stored);
}

function findInStoreRoots<T>(
  roots: ChatMessageStoreRoot[],
  read: (root: ChatMessageStoreRoot) => T | null | undefined,
) {
  for (const root of roots) {
    const value = read(root);
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

function collectStoreRootValues<T>(
  roots: ChatMessageStoreRoot[],
  read: (root: ChatMessageStoreRoot) => T[] | null | undefined,
) {
  const out: T[] = [];
  for (const root of roots) {
    const current = read(root);
    if (current?.length) out.push(...current);
  }
  return out;
}

function readMergedStoreRootStrings(
  layout: ChatMessageStoreLayout,
  read: (root: ChatMessageStoreRoot) => string[] | null | undefined,
) {
  const primary = read(layout.primaryRoot);
  const fallback = collectStoreRootValues(
    primary === null || primary === undefined
      ? layout.readRoots
      : layout.readRoots.slice(1),
    read,
  );
  if (primary === null || primary === undefined) {
    return fallback.length ? dedupeStrings(fallback) : null;
  }
  return dedupeStrings([...primary, ...fallback]);
}

function readPrimaryRefs(layout: ChatMessageStoreLayout, messageId: string) {
  return readRefs(layout.primaryRoot.indexesDir, messageId);
}

function readMessageRefs(layout: ChatMessageStoreLayout, messageId: string) {
  const nextMessageId = safeString(messageId).trim();
  if (!nextMessageId) return [];
  return (
    readMergedStoreRootStrings(layout, (root) =>
      readRefs(root.indexesDir, nextMessageId),
    ) || []
  );
}

function writeMessageRefs(
  layout: ChatMessageStoreLayout,
  messageId: string,
  refs: string[],
) {
  const nextRefs = normalizeRefs(refs);
  if (sameStringLists(readPrimaryRefs(layout, messageId), nextRefs)) return;
  writeJsonFile(refsPath(layout.primaryRoot.indexesDir, messageId), nextRefs);
}

function syncMessageRefs(
  layout: ChatMessageStoreLayout,
  messageId: string,
  relativePath: string,
) {
  const nextRelativePath = safeString(relativePath).trim();
  if (!nextRelativePath) return;
  writeMessageRefs(layout, messageId, [
    ...readMessageRefs(layout, messageId),
    nextRelativePath,
  ]);
}

function recordPath(recordsRoot: string, recordKey: string) {
  return path.join(recordsRoot, recordKey.slice(0, 2), `${recordKey}.json`);
}

type StoredChatDateIndex = {
  version: 1;
  recordKeys: string[];
};

function chatDateIndexPath(indexesRoot: string, chatKey: string, date: string) {
  return chatScopedDatePath(
    path.join(indexesRoot, "by-chat-date"),
    chatKey,
    date,
    ".json",
  );
}

function normalizeRecordKeys(value: unknown) {
  const list = Array.isArray(value)
    ? value
    : Array.isArray((value as StoredChatDateIndex | null)?.recordKeys)
      ? (value as StoredChatDateIndex).recordKeys
      : [];
  return dedupeStrings(list);
}

function readChatDateIndexEntry(
  indexesRoot: string,
  chatKey: string,
  date: string,
) {
  const stored = readJsonFile<StoredChatDateIndex | string[] | null>(
    chatDateIndexPath(indexesRoot, chatKey, date),
    null,
  );
  return stored === null ? null : normalizeRecordKeys(stored);
}

function readChatDateIndex(
  layout: ChatMessageStoreLayout,
  chatKey: string,
  date: string,
) {
  return readMergedStoreRootStrings(layout, (root) =>
    readChatDateIndexEntry(root.indexesDir, chatKey, date),
  );
}

function writeChatDateIndex(
  layout: ChatMessageStoreLayout,
  chatKey: string,
  date: string,
  recordKeys: string[],
) {
  const nextRecordKeys = normalizeRecordKeys(recordKeys);
  const currentPrimary = readChatDateIndexEntry(
    layout.primaryRoot.indexesDir,
    chatKey,
    date,
  );
  if (
    currentPrimary !== null &&
    sameStringLists(currentPrimary, nextRecordKeys)
  ) {
    return;
  }
  writeJsonFile(
    chatDateIndexPath(layout.primaryRoot.indexesDir, chatKey, date),
    {
      version: 1,
      recordKeys: nextRecordKeys,
    } satisfies StoredChatDateIndex,
  );
}

function updateChatDateIndexRecord(
  layout: ChatMessageStoreLayout,
  chatKey: string,
  date: string,
  recordKey: string,
  action: "add" | "remove",
) {
  const nextDate = normalizeLocalDateOnly(date);
  const nextRecordKey = safeString(recordKey).trim();
  if (!nextDate || !nextRecordKey) return;
  const current = readChatDateIndex(layout, chatKey, nextDate) || [];
  const nextRecordKeys =
    action === "remove"
      ? current.filter((item) => item !== nextRecordKey)
      : [...current, nextRecordKey];
  if (action === "remove" && current.length === 0) return;
  writeChatDateIndex(layout, chatKey, nextDate, nextRecordKeys);
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

function storedMessageDate(
  record:
    | Pick<StoredChatMessage, "receivedAt" | "processedAt">
    | null
    | undefined,
) {
  return normalizeLocalDateOnly(storedChatMessageTimestamp(record));
}

function sortChatMessages(messages: StoredChatMessage[]) {
  return [...messages].sort((a, b) => {
    const left = Date.parse(storedChatMessageTimestamp(a)) || 0;
    const right = Date.parse(storedChatMessageTimestamp(b)) || 0;
    if (left !== right) return left - right;
    return a.recordKey.localeCompare(b.recordKey);
  });
}

function uniqueChatMessages(messages: StoredChatMessage[]) {
  const out = new Map<string, StoredChatMessage>();
  for (const item of messages) {
    if (!item?.recordKey || out.has(item.recordKey)) continue;
    out.set(item.recordKey, item);
  }
  return [...out.values()];
}

function readStoredChatMessage(filePath: string) {
  const item = readJsonFile<StoredChatMessage | null>(filePath, null);
  return item && safeString(item.messageId).trim() ? item : null;
}

function findChatMessageByRecordKey(
  layout: ChatMessageStoreLayout,
  recordKey: string,
) {
  const nextRecordKey = safeString(recordKey).trim();
  if (!nextRecordKey) return null;
  return findInStoreRoots(layout.readRoots, (root) =>
    readStoredChatMessage(recordPath(root.recordsDir, nextRecordKey)),
  );
}

function findChatMessageByRelativePath(
  layout: ChatMessageStoreLayout,
  relativePath: string,
) {
  const nextRelativePath = safeString(relativePath).trim();
  if (!nextRelativePath) return null;
  return findInStoreRoots(layout.readRoots, (root) =>
    readStoredChatMessage(path.join(root.storeDir, nextRelativePath)),
  );
}

function readChatMessagesByRecordKeys(
  layout: ChatMessageStoreLayout,
  recordKeys: string[],
) {
  return uniqueChatMessages(
    normalizeRecordKeys(recordKeys)
      .map((recordKey) => findChatMessageByRecordKey(layout, recordKey))
      .filter((item): item is StoredChatMessage => Boolean(item)),
  );
}

function syncChatDateIndex(
  layout: ChatMessageStoreLayout,
  record: StoredChatMessage,
  previousDate?: string,
) {
  const nextChatKey = safeString(record.chatKey).trim();
  const nextDate = storedMessageDate(record);
  if (!nextChatKey || !record.recordKey) return;
  if (previousDate && previousDate !== nextDate) {
    updateChatDateIndexRecord(
      layout,
      nextChatKey,
      previousDate,
      record.recordKey,
      "remove",
    );
  }
  updateChatDateIndexRecord(
    layout,
    nextChatKey,
    nextDate,
    record.recordKey,
    "add",
  );
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

function normalizeStoredSessionFields<T extends Record<string, any>>(
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

function persistChatMessageRecord(
  layout: ChatMessageStoreLayout,
  record: StoredChatMessage,
  previousDate?: string,
) {
  const filePath = recordPath(layout.primaryRoot.recordsDir, record.recordKey);
  writeJsonFile(filePath, record);
  syncMessageRefs(
    layout,
    record.messageId,
    path.relative(layout.primaryRoot.storeDir, filePath),
  );
  syncChatDateIndex(layout, record, previousDate);
  return filePath;
}

function getChatMessagesByMessageIdWithLayout(
  layout: ChatMessageStoreLayout,
  messageId: string,
) {
  const nextMessageId = safeString(messageId).trim();
  if (!nextMessageId) return [] as StoredChatMessage[];
  return uniqueChatMessages(
    readMessageRefs(layout, nextMessageId)
      .map((relativePath) =>
        findChatMessageByRelativePath(layout, relativePath),
      )
      .filter((item): item is StoredChatMessage => Boolean(item)),
  );
}

function getChatMessageWithLayout(
  layout: ChatMessageStoreLayout,
  chatKey: string,
  messageId: string,
) {
  return findChatMessageByRecordKey(
    layout,
    buildChatMessageRecordKey(chatKey, messageId),
  );
}

function findChatMessageByChatAndIdWithLayout(
  layout: ChatMessageStoreLayout,
  chatKey: string,
  messageId: string,
) {
  const direct = getChatMessageWithLayout(layout, chatKey, messageId);
  if (direct) return direct;
  return (
    getChatMessagesByMessageIdWithLayout(layout, messageId).find(
      (item) => item.chatKey === chatKey,
    ) || null
  );
}

function listChatMessagesWithLayout(layout: ChatMessageStoreLayout) {
  const out = new Map<string, StoredChatMessage>();
  const visit = (dir: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const item = readStoredChatMessage(filePath);
      if (item && !out.has(item.recordKey)) out.set(item.recordKey, item);
    }
  };
  for (const root of layout.readRoots) {
    visit(root.recordsDir);
  }
  return [...out.values()];
}

function saveChatMessageWithLayout(
  layout: ChatMessageStoreLayout,
  input: Omit<StoredChatMessage, "version" | "recordKey">,
) {
  const record = buildStoredChatMessage(input);
  const previous = getChatMessageWithLayout(
    layout,
    record.chatKey,
    record.messageId,
  );
  const filePath = persistChatMessageRecord(
    layout,
    record,
    storedMessageDate(previous),
  );
  return { record, filePath };
}

function updateChatMessageWithLayout(
  layout: ChatMessageStoreLayout,
  chatKey: string,
  messageId: string,
  patch: Partial<StoredChatMessage>,
) {
  const current = getChatMessageWithLayout(layout, chatKey, messageId);
  if (!current) return null;
  const previousDate = storedMessageDate(current);
  const next: StoredChatMessage = {
    ...current,
    ...patch,
    version: 1,
    recordKey: current.recordKey,
    chatKey: current.chatKey,
    messageId: current.messageId,
    role: normalizeStoredChatMessageRole(patch.role) || current.role,
    platform: current.platform,
    chatId: current.chatId,
  };
  persistChatMessageRecord(layout, next, previousDate);
  return next;
}

export function saveChatMessage(
  agentDir: string,
  input: Omit<StoredChatMessage, "version" | "recordKey">,
) {
  return saveChatMessageWithLayout(
    messageStoreLayout(agentDir),
    normalizeStoredSessionFields(agentDir, input),
  );
}

export function saveInboundChatMessage(
  agentDir: string,
  input: Omit<StoredChatMessage, "version" | "recordKey">,
) {
  const layout = messageStoreLayout(agentDir);
  const normalized = buildStoredChatMessage(
    normalizeStoredSessionFields(agentDir, input),
  );
  const existing = findChatMessageByChatAndIdWithLayout(
    layout,
    normalized.chatKey,
    normalized.messageId,
  );
  if (!existing) {
    return saveChatMessageWithLayout(
      layout,
      toStoredChatMessageInput(normalized),
    );
  }
  const next = mergeDuplicateInboundChatMessage(existing, normalized);
  const filePath = persistChatMessageRecord(
    layout,
    next,
    storedMessageDate(existing),
  );
  return { record: next, filePath };
}

export function upsertChatMessage(
  agentDir: string,
  input: Omit<StoredChatMessage, "version" | "recordKey">,
) {
  const layout = messageStoreLayout(agentDir);
  const normalized = buildStoredChatMessage(
    normalizeStoredSessionFields(agentDir, input),
  );
  const existing = findChatMessageByChatAndIdWithLayout(
    layout,
    normalized.chatKey,
    normalized.messageId,
  );
  if (!existing) {
    return saveChatMessageWithLayout(
      layout,
      toStoredChatMessageInput(normalized),
    ).record;
  }
  return (
    updateChatMessageWithLayout(
      layout,
      normalized.chatKey,
      normalized.messageId,
      definedStoredChatMessagePatch(toStoredChatMessageInput(normalized)),
    ) || existing
  );
}

export function getChatMessagesByMessageId(
  agentDir: string,
  messageId: string,
) {
  return getChatMessagesByMessageIdWithLayout(
    messageStoreLayout(agentDir),
    messageId,
  );
}

export function getChatMessage(
  agentDir: string,
  chatKey: string,
  messageId: string,
) {
  return getChatMessageWithLayout(
    messageStoreLayout(agentDir),
    chatKey,
    messageId,
  );
}

export function updateChatMessage(
  agentDir: string,
  chatKey: string,
  messageId: string,
  patch: Partial<StoredChatMessage>,
) {
  return updateChatMessageWithLayout(
    messageStoreLayout(agentDir),
    chatKey,
    messageId,
    normalizeStoredSessionFields(agentDir, patch),
  );
}

export function findChatMessageByChatAndId(
  agentDir: string,
  chatKey: string,
  messageId: string,
) {
  return findChatMessageByChatAndIdWithLayout(
    messageStoreLayout(agentDir),
    chatKey,
    messageId,
  );
}

export function listChatMessages(agentDir: string) {
  return listChatMessagesWithLayout(messageStoreLayout(agentDir));
}

export function listChatMessagesByReplyTo(
  agentDir: string,
  chatKey: string,
  replyToMessageId: string,
) {
  const nextChatKey = safeString(chatKey).trim();
  const nextReplyToMessageId = safeString(replyToMessageId).trim();
  if (!nextChatKey || !nextReplyToMessageId) return [] as StoredChatMessage[];
  return listChatMessagesWithLayout(messageStoreLayout(agentDir)).filter(
    (item) =>
      item.chatKey === nextChatKey &&
      safeString(item.replyToMessageId).trim() === nextReplyToMessageId,
  );
}

export function listChatMessagesByChatAndDate(
  agentDir: string,
  chatKey: string,
  date: string,
) {
  const layout = messageStoreLayout(agentDir);
  const nextChatKey = safeString(chatKey).trim();
  const nextDate = normalizeLocalDateOnly(date);
  if (!nextChatKey || !nextDate) return [];

  const indexedRecordKeys = readChatDateIndex(layout, nextChatKey, nextDate);
  if (indexedRecordKeys) {
    const records = sortChatMessages(
      readChatMessagesByRecordKeys(layout, indexedRecordKeys).filter(
        (item) =>
          item.chatKey === nextChatKey && storedMessageDate(item) === nextDate,
      ),
    );
    writeChatDateIndex(
      layout,
      nextChatKey,
      nextDate,
      records.map((item) => item.recordKey),
    );
    return records;
  }

  const records = sortChatMessages(
    listChatMessagesWithLayout(layout).filter(
      (item) =>
        item.chatKey === nextChatKey && storedMessageDate(item) === nextDate,
    ),
  );
  writeChatDateIndex(
    layout,
    nextChatKey,
    nextDate,
    records.map((item) => item.recordKey),
  );
  return records;
}

export function normalizeChatMessageLookup(
  agentDir: string,
  messageId: string,
  chatKey?: string,
) {
  const layout = messageStoreLayout(agentDir);
  const nextChatKey = safeString(chatKey).trim();
  const matches = nextChatKey
    ? (() => {
        const found = findChatMessageByChatAndIdWithLayout(
          layout,
          nextChatKey,
          messageId,
        );
        return found ? [found] : [];
      })()
    : getChatMessagesByMessageIdWithLayout(layout, messageId);

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
