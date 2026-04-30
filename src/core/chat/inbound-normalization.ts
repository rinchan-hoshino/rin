import {
  normalizeElementSummary,
  normalizeStoredChatMessageText,
  type StoredChatMessage,
} from "./message-store.js";
import { composeChatKey } from "./support.js";
import { normalizeMessageText } from "../message-content.js";
import { renderChatNodesMarkdown } from "./rich-text.js";
import { cloneJsonIfObject } from "../json-utils.js";
import { safeString } from "../text-utils.js";

export type ChatInboxRouting = {
  chatType: "private" | "group";
  isDirect: boolean;
  mentionLike: boolean;
  text?: string;
  userId?: string;
  nickname?: string;
  chatName?: string;
  replyToMessageId?: string;
};

function normalizeMentionToken(value: unknown) {
  return safeString(value).trim().replace(/^@+/, "").toLowerCase();
}

function normalizePlatformTimestamp(value: unknown) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export function pickUserId(session: any) {
  return safeString(session?.userId || session?.author?.userId || "").trim();
}

export function directLike(session: any) {
  return (
    Boolean(session?.isDirect) ||
    !safeString(session?.guildId || "").trim() ||
    safeString(session?.channelId || "").startsWith("private:")
  );
}

export function ensureSessionElements(session: any) {
  if (Array.isArray(session?.elements) && session.elements.length) {
    return session.elements;
  }
  const stripped = safeString(session?.stripped?.content || "").trim();
  if (stripped) return [{ type: "text", attrs: { content: stripped } }];
  const raw = safeString(session?.content || "").trim();
  if (raw) return [{ type: "text", attrs: { content: raw } }];
  return [] as any[];
}

function collectSelfMentionTokens(session: any) {
  return new Set(
    [
      session?.selfId,
      session?.bot?.selfId,
      session?.username,
      session?.user?.username,
      session?.bot?.username,
      session?.bot?.name,
      session?.bot?.user?.name,
      session?.bot?.user?.username,
      session?.bot?.nick,
      session?.bot?.user?.nick,
    ]
      .map(normalizeMentionToken)
      .filter(Boolean),
  );
}

function isSelfMention(attrs: Record<string, any>, selfTokens: Set<string>) {
  const id = normalizeMentionToken(attrs.id);
  const name = normalizeMentionToken(attrs.name);
  return Boolean((id && selfTokens.has(id)) || (name && selfTokens.has(name)));
}

export function mentionLike(session: any) {
  if (Boolean(session?.stripped?.appel)) return true;
  const elements = ensureSessionElements(session);
  const atElements = elements.filter(
    (element) => safeString(element?.type).toLowerCase() === "at",
  );
  if (!atElements.length) return false;

  const selfTokens = collectSelfMentionTokens(session);

  for (const element of atElements) {
    if (isSelfMention(element?.attrs || {}, selfTokens)) return true;
  }

  return false;
}

export function elementsToText(elements: any) {
  return normalizeMessageText(renderChatNodesMarkdown(elements));
}

function isRichAttachmentElement(element: any) {
  return [
    "img",
    "image",
    "file",
    "video",
    "audio",
    "voice",
    "sticker",
    "record",
    "face",
    "mface",
  ].includes(safeString(element?.type).trim().toLowerCase());
}

function sessionElementsToText(session: any, elements: any[]) {
  const normalizedElements = Array.isArray(elements) ? elements : [];
  const richAttachments = normalizedElements.filter(isRichAttachmentElement);
  const textElements = normalizedElements.filter(
    (element) => !isRichAttachmentElement(element),
  );
  const selfTokens = collectSelfMentionTokens(session);
  const baseText = normalizeMessageText(
    renderChatNodesMarkdown(textElements, {
      renderAt(attrs) {
        if (isSelfMention(attrs, selfTokens)) return "";
        const id = safeString(attrs.id).trim();
        const name = safeString(attrs.name).trim() || id;
        return id ? `[@${name}](at:${id})` : name ? `@${name}` : "";
      },
    }),
  );
  const fallbackText = normalizeMessageText(session?.stripped?.content || "");
  const richText = richAttachments.length
    ? elementsToText(richAttachments)
    : "";
  return normalizeMessageText(
    [baseText || fallbackText, richText].filter(Boolean).join("\n"),
  );
}

export function pickSenderNickname(session: any) {
  const values = [
    session?.author?.nick,
    session?.author?.name,
    session?.author?.nickname,
    session?.author?.username,
    session?.username,
    session?.user?.nick,
    session?.user?.name,
    session?.user?.nickname,
    session?.user?.username,
  ];
  for (const value of values) {
    const text = safeString(value).trim();
    if (text) return text;
  }
  return "";
}

export function pickChatName(session: any) {
  const values = [
    session?.channel?.name,
    session?.channelName,
    session?.guild?.name,
    session?.guildName,
  ];
  for (const value of values) {
    const text = safeString(value).trim();
    if (text) return text;
  }
  return "";
}

export function pickMessageId(session: any) {
  return safeString(session?.messageId || "").trim();
}

export function pickReplyToMessageId(session: any) {
  return safeString(
    session?.quote?.messageId || session?.quote?.id || "",
  ).trim();
}

export function summarizeQuote(session: any) {
  const quote = session?.quote;
  if (!quote || typeof quote !== "object") return undefined;
  const messageId =
    safeString(quote?.messageId || quote?.id || "").trim() || undefined;
  const userId =
    safeString(
      quote?.user?.id || quote?.author?.userId || quote?.author?.id || "",
    ).trim() || undefined;
  const nickname =
    safeString(
      quote?.user?.name || quote?.author?.name || quote?.author?.nick || "",
    ).trim() || undefined;
  const content =
    safeString(quote?.content || quote?.message?.content || "").trim() ||
    undefined;
  if (!messageId && !userId && !nickname && !content) return undefined;
  return { messageId, userId, nickname, content };
}

export function getChatId(session: any) {
  const channelId = safeString(session?.channelId || "").trim();
  if (channelId) return channelId;
  const userId = pickUserId(session);
  if (!userId) return "";
  return safeString(session?.platform) === "onebot"
    ? `private:${userId}`
    : userId;
}

export function getChatType(session: any): "private" | "group" {
  return directLike(session) ? "private" : "group";
}

export function serializeChatInboxSession(session: any) {
  return {
    platform: safeString(session?.platform).trim() || undefined,
    selfId:
      safeString(session?.selfId || session?.bot?.selfId).trim() || undefined,
    channelId: safeString(session?.channelId).trim() || undefined,
    guildId: safeString(session?.guildId).trim() || undefined,
    userId: pickUserId(session) || undefined,
    messageId: pickMessageId(session) || undefined,
    timestamp: normalizePlatformTimestamp(session?.timestamp),
    content: safeString(session?.content).trim() || undefined,
    stripped:
      session?.stripped && typeof session.stripped === "object"
        ? {
            content: safeString(session.stripped.content).trim() || undefined,
          }
        : undefined,
    username: safeString(session?.username).trim() || undefined,
    author: cloneJsonIfObject(session?.author),
    user: cloneJsonIfObject(session?.user),
    channel: cloneJsonIfObject(session?.channel),
    guild: cloneJsonIfObject(session?.guild),
    quote: cloneJsonIfObject(session?.quote),
  };
}

export function buildChatInboxRouting(
  session: any,
  elements: any[],
): ChatInboxRouting {
  return {
    chatType: getChatType(session),
    isDirect: directLike(session),
    mentionLike: mentionLike(session),
    text: sessionElementsToText(session, elements) || undefined,
    userId: pickUserId(session) || undefined,
    nickname: pickSenderNickname(session) || undefined,
    chatName: pickChatName(session) || undefined,
    replyToMessageId: pickReplyToMessageId(session) || undefined,
  };
}

export function buildInboundStoredChatMessageInput(
  session: any,
  elements: any[],
  options: { receivedAt?: string; trust?: string } = {},
): Omit<StoredChatMessage, "version" | "recordKey"> | null {
  const platform = safeString(session?.platform || "").trim();
  const botId = safeString(
    session?.selfId || session?.bot?.selfId || "",
  ).trim();
  const chatId = getChatId(session);
  const chatKey = composeChatKey(platform, chatId, botId);
  const messageId = pickMessageId(session);
  if (!chatKey || !messageId) return null;
  const userId = pickUserId(session);
  const receivedAt =
    safeString(options.receivedAt).trim() || new Date().toISOString();
  const trust = safeString(options.trust).trim() || undefined;
  return {
    messageId,
    role: "user",
    replyToMessageId: pickReplyToMessageId(session) || undefined,
    chatKey,
    platform,
    botId: botId || undefined,
    chatId,
    chatType: getChatType(session),
    receivedAt,
    platformTimestamp: normalizePlatformTimestamp(session?.timestamp),
    userId: userId || undefined,
    nickname: pickSenderNickname(session) || undefined,
    chatName: pickChatName(session) || undefined,
    trust,
    text: sessionElementsToText(session, elements) || undefined,
    rawContent: safeString(session?.content || "").trim() || undefined,
    strippedContent:
      safeString(session?.stripped?.content || "").trim() || undefined,
    elements: normalizeElementSummary(elements),
    quote: summarizeQuote(session),
  };
}

export function buildInboundChatLogInput(
  session: any,
  elements: any[],
  options: { timestamp?: string } = {},
) {
  const inbound = buildInboundStoredChatMessageInput(session, elements, {
    receivedAt: options.timestamp,
  });
  if (!inbound) return null;
  const text = normalizeStoredChatMessageText(inbound);
  if (!text) return null;
  return {
    timestamp: safeString(options.timestamp).trim() || inbound.receivedAt,
    chatKey: inbound.chatKey,
    role: "user" as const,
    text,
    messageId: inbound.messageId || undefined,
    replyToMessageId: inbound.replyToMessageId,
    userId: inbound.userId,
    nickname: inbound.nickname,
  };
}
