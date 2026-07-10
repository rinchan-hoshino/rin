import {
  chatMessageLogPath,
  getChatMessage,
  listChatMessagesByChatAndDate,
  normalizeStoredChatMessageRole,
  projectStoredChatMessageToChatLog,
  upsertChatMessage,
  type StoredChatMessage,
} from "./message-store.js";
import { inferChatType, parseChatKey } from "./support.js";
import { nowIso } from "../time-utils.js";
import { safeString } from "../text-utils.js";
import { normalizeSessionRef } from "../session/ref.js";

export type ChatLogEntry = {
  version: 1;
  timestamp: string;
  chatKey: string;
  role: "user" | "assistant";
  text: string;
  messageId?: string;
  replyToMessageId?: string;
  sessionFile?: string;
  userId?: string;
  nickname?: string;
};

function storedMessageToChatLogEntry(
  record: StoredChatMessage,
): ChatLogEntry | null {
  const projected = projectStoredChatMessageToChatLog(record);
  if (!projected) return null;
  return {
    version: 1,
    chatKey: record.chatKey,
    ...projected,
  };
}

function buildStoredMessageFromChatLogEntry(
  input: Omit<ChatLogEntry, "version">,
): Omit<StoredChatMessage, "version" | "recordKey"> | null {
  const chatKey = safeString(input.chatKey).trim();
  const parsed = parseChatKey(chatKey);
  if (!parsed) throw new Error(`invalid_chatKey:${chatKey}`);
  const role = normalizeStoredChatMessageRole(input.role);
  const text = safeString(input.text).trim();
  const messageId = safeString(input.messageId).trim();
  const timestamp = safeString(input.timestamp || nowIso()).trim();
  if (!role || !text || !messageId) return null;
  const session = normalizeSessionRef(input);
  return {
    messageId,
    role,
    replyToMessageId: safeString(input.replyToMessageId).trim() || undefined,
    sessionFile: session.sessionFile,
    processedAt: role === "assistant" ? timestamp : undefined,
    chatKey,
    platform: parsed.platform,
    botId: parsed.botId || undefined,
    chatId: parsed.chatId,
    chatType: inferChatType(parsed),
    receivedAt: timestamp,
    userId: safeString(input.userId).trim() || undefined,
    nickname: safeString(input.nickname).trim() || undefined,
    text,
    rawContent: text,
    strippedContent: text,
  };
}

export {
  chatMessageLogDir as chatLogDir,
  chatMessageLogPath as chatLogPath,
} from "./message-store.js";

export function appendChatLog(
  agentDir: string,
  input: Omit<ChatLogEntry, "version">,
) {
  const normalized = buildStoredMessageFromChatLogEntry(input);
  if (!normalized) return null;
  const existing = getChatMessage(
    agentDir,
    normalized.chatKey,
    normalized.messageId,
  );
  if (existing?.receivedAt) normalized.receivedAt = existing.receivedAt;
  const entry = storedMessageToChatLogEntry(
    upsertChatMessage(agentDir, normalized),
  );
  if (!entry) return null;
  return {
    entry,
    filePath: chatMessageLogPath(agentDir, entry.chatKey, entry.timestamp),
  };
}

export function readChatLog(agentDir: string, chatKey: string, date: string) {
  const filePath = chatMessageLogPath(agentDir, chatKey, date);
  const entries = listChatMessagesByChatAndDate(agentDir, chatKey, date)
    .map((record) => storedMessageToChatLogEntry(record))
    .filter((item): item is ChatLogEntry => Boolean(item));
  return { filePath, entries };
}

export function formatChatLog(entries: ChatLogEntry[]) {
  return entries
    .map((entry) => {
      const stamp = safeString(entry.timestamp).trim();
      const role = safeString(entry.role).trim() || "unknown";
      const nick = safeString(entry.nickname).trim();
      const label = role === "user" ? nick || "user" : "assistant";
      return `[${stamp}] ${label}: ${safeString(entry.text).trim()}`;
    })
    .join("\n");
}
