import {
  normalizeElementSummary,
  normalizeStoredChatMessageText,
  type StoredChatMessage,
} from "./message-store.js";
import { composeChatKey } from "./support.js";
import { normalizeMessageText } from "../message-content.js";
import {
  extractChatQuoteMessageId,
  renderChatNodesMarkdown,
} from "./rich-text.js";
import { cloneJsonIfObject } from "../json-utils.js";
import { nowIso } from "../time-utils.js";
import { safeString } from "../text-utils.js";

export type ChatInboxRouting = {
  chatType: "private" | "group";
  isDirect: boolean;
  mentionLike: boolean;
  text?: string;
  userId?: string;
  nickname?: string;
  chatName?: string;
  messageThreadId?: string;
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
  let elements: any[] = [];
  if (Array.isArray(session?.elements) && session.elements.length) {
    elements = session.elements;
  } else {
    const stripped = safeString(session?.stripped?.content || "").trim();
    const raw = safeString(session?.content || "").trim();
    const text = stripped || raw;
    if (text) elements = [{ type: "text", attrs: { content: text } }];
  }
  return elements.filter(Boolean);
}

function collectSelfMentionTokens(session: any) {
  return new Set(
    [
      session?.selfId,
      session?.bot?.selfId,
      session?.username,
      session?.user?.username,
      session?.botUsername,
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

export function renderInboundMessageText(session: any, elements: any[]) {
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

function pickFirstTrimmed(values: unknown[]) {
  for (const value of values) {
    const text = safeString(value).trim();
    if (text) return text;
  }
  return "";
}

export function pickSenderGroupNickname(session: any) {
  return pickFirstTrimmed([
    session?.author?.groupNickname,
    session?.author?.card,
    session?.user?.groupNickname,
    session?.user?.card,
  ]);
}

export function pickSenderNickname(session: any) {
  return pickFirstTrimmed([
    session?.author?.nickname,
    session?.author?.username,
    session?.username,
    session?.user?.nickname,
    session?.user?.username,
    session?.author?.nick,
    session?.author?.name,
    session?.user?.nick,
    session?.user?.name,
  ]);
}

export function pickChatName(session: any) {
  const values = [
    session?.chatName,
    session?.channelPathName,
    session?.channelPath,
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

export function pickReplyToMessageId(elements: any[]) {
  return extractChatQuoteMessageId(elements) || "";
}

function legacyQuoteMessageId(quote: any) {
  if (!quote || typeof quote !== "object") return "";
  return safeString(quote?.messageId || quote?.id || "").trim();
}

export function migrateLegacyQuoteToElements(quote: any, elements: any[]) {
  const nodes = Array.isArray(elements) ? elements.filter(Boolean) : [];
  if (extractChatQuoteMessageId(nodes)) return nodes;
  const id = legacyQuoteMessageId(quote);
  if (!id) return nodes;
  return [
    { type: "quote", attrs: { id }, children: [] },
    ...(nodes.length ? [{ type: "br", attrs: {}, children: [] }] : []),
    ...nodes,
  ];
}

export function getChatId(session: any) {
  const channelId = safeString(session?.channelId || "").trim();
  if (channelId) return channelId;
  const userId = pickUserId(session);
  if (!userId) return "";
  return userId;
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
    messageThreadId:
      safeString(session?.messageThreadId || session?.chatThreadId).trim() ||
      undefined,
    chatThreadId:
      safeString(session?.chatThreadId || session?.messageThreadId).trim() ||
      undefined,
    isTopicMessage:
      typeof session?.isTopicMessage === "boolean"
        ? session.isTopicMessage
        : undefined,
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
    botUsername:
      safeString(session?.botUsername || session?.bot?.username).trim() ||
      undefined,
    author: cloneJsonIfObject(session?.author),
    user: cloneJsonIfObject(session?.user),
    channel: cloneJsonIfObject(session?.channel),
    guild: cloneJsonIfObject(session?.guild),
  };
}

export function buildChatInboxRouting(
  session: any,
  elements: any[],
): ChatInboxRouting {
  const normalizedElements = Array.isArray(elements)
    ? elements.filter(Boolean)
    : [];
  return {
    chatType: getChatType(session),
    isDirect: directLike(session),
    mentionLike: mentionLike(session),
    text: renderInboundMessageText(session, normalizedElements) || undefined,
    userId: pickUserId(session) || undefined,
    nickname: pickSenderNickname(session) || undefined,
    chatName: pickChatName(session) || undefined,
    messageThreadId:
      safeString(session?.messageThreadId || session?.chatThreadId).trim() ||
      undefined,
    replyToMessageId: pickReplyToMessageId(normalizedElements) || undefined,
  };
}

export function buildInboundStoredChatMessageInput(
  session: any,
  elements: any[],
  options: { receivedAt?: string; trust?: string; chatKey?: string } = {},
): Omit<StoredChatMessage, "version" | "recordKey"> | null {
  const platform = safeString(session?.platform || "").trim();
  const botId = safeString(
    session?.selfId || session?.bot?.selfId || "",
  ).trim();
  const chatId = getChatId(session);
  const chatKey =
    safeString(options.chatKey).trim() ||
    composeChatKey(platform, chatId, botId);
  const messageId = pickMessageId(session);
  if (!chatKey || !messageId) return null;
  const userId = pickUserId(session);
  const receivedAt = safeString(options.receivedAt).trim() || nowIso();
  const trust = safeString(options.trust).trim() || undefined;
  const normalizedElements = Array.isArray(elements)
    ? elements.filter(Boolean)
    : [];
  return {
    messageId,
    role: "user",
    replyToMessageId: pickReplyToMessageId(normalizedElements) || undefined,
    chatKey,
    platform,
    botId: botId || undefined,
    chatId,
    chatThreadId:
      safeString(session?.chatThreadId || session?.messageThreadId).trim() ||
      undefined,
    messageThreadId:
      safeString(session?.messageThreadId || session?.chatThreadId).trim() ||
      undefined,
    chatType: getChatType(session),
    receivedAt,
    platformTimestamp: normalizePlatformTimestamp(session?.timestamp),
    providerCursor: safeString(session?.providerCursor).trim() || undefined,
    userId: userId || undefined,
    nickname: pickSenderNickname(session) || undefined,
    chatName: pickChatName(session) || undefined,
    trust,
    text: renderInboundMessageText(session, normalizedElements) || undefined,
    rawContent: safeString(session?.content || "").trim() || undefined,
    strippedContent:
      safeString(session?.stripped?.content || "").trim() || undefined,
    elements: normalizeElementSummary(normalizedElements),
  };
}

export function buildInboundChatLogInput(
  session: any,
  elements: any[],
  options: { timestamp?: string; chatKey?: string } = {},
) {
  const inbound = buildInboundStoredChatMessageInput(session, elements, {
    receivedAt: options.timestamp,
    chatKey: options.chatKey,
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
