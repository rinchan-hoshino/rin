import fs from "node:fs";
import path from "node:path";

import { ensureExtension, ensureFileName, fileNameFromUrl } from "./support.js";
import { ensureDir } from "../platform/fs.js";
import {
  findChatMessageByChatAndId,
  listChatMessages,
  listChatMessagesByReplyTo,
  saveChatMessage,
  updateChatMessage,
} from "./message-store.js";
import {
  buildInboundStoredChatMessageInput,
  pickReplyToMessageId,
  pickUserId,
} from "./inbound-normalization.js";
import {
  extractExistingFilePaths as extractExistingFilePathsFromText,
  extractImageParts as extractStructuredImageParts,
  extractMessageText,
} from "../message-content.js";
import { safeString } from "../text-utils.js";
import {
  resolveStoredSessionFile,
  toStoredSessionFile,
} from "../session/ref.js";

export type SavedAttachment = {
  kind: "image" | "file";
  path: string;
  name: string;
  mimeType?: string;
};

export type InboundAttachmentFailure = {
  type: string;
  kind: "image" | "file";
  reason: "unresolved_resource" | "fetch_failed";
  resource?: string;
  detail?: string;
};

export type ChatState = {
  chatKey: string;
  sessionFile?: string;
  chatType?: "private" | "group";
  pendingSteeredDeliveryTargets?: Array<{
    incomingMessageId?: string;
    replyToMessageId?: string;
    text?: string;
    submittedText?: string;
  }>;
};

export const CHAT_WORKING_NOTICE_TEXT = "Working...";
export const CHAT_INTERIM_REPLY_PREFIX = "··· ";

export type ChatPromptRestoreInput = {
  text: string;
  attachments: SavedAttachment[];
  startedAt: number;
};

export type ChatBridgePromptMeta = {
  source: "chat-bridge";
  sentAt?: number;
  chatKey?: string;
  chatName?: string;
  chatType?: "private" | "group";
  userId?: string;
  nickname?: string;
  groupNickname?: string;
  identity?: string;
  replyToMessageId?: string;
  attachedFiles?: Array<{ name?: string; path?: string }>;
};

export { ensureDir, safeString };
export {
  directLike,
  elementsToText,
  ensureSessionElements,
  getChatId,
  getChatType,
  mentionLike,
  pickChatName,
  pickMessageId,
  pickReplyToMessageId,
  pickSenderGroupNickname,
  pickSenderNickname,
  pickUserId,
  summarizeQuote,
} from "./inbound-normalization.js";

function isMediaElementType(type: string) {
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
  ].includes(type);
}

export function hasMediaElements(elements: any[]) {
  if (!Array.isArray(elements) || !elements.length) return false;
  return elements.some((element) =>
    isMediaElementType(safeString(element?.type || "").toLowerCase()),
  );
}

export function extractTextFromContent(
  content: any,
  { includeThinking = false }: { includeThinking?: boolean } = {},
) {
  return extractMessageText(content, { includeThinking, trim: true });
}

export function extractImageParts(content: any) {
  return extractStructuredImageParts(content);
}

export function extractExistingFilePaths(text: string) {
  return extractExistingFilePathsFromText(text);
}

export function persistInboundMessage(
  agentDir: string,
  session: any,
  elements: any[],
  identity: any,
  trustOf: (identity: any, platform: string, userId: string) => string,
) {
  const platform = safeString(session?.platform || "").trim();
  const userId = pickUserId(session);
  const normalized = buildInboundStoredChatMessageInput(session, elements, {
    trust: trustOf(identity, platform, userId),
  });
  return normalized ? saveChatMessage(agentDir, normalized) : null;
}

export function lookupReplyMessage(
  agentDir: string,
  chatKey: string,
  replyToMessageId: string,
) {
  const nextChatKey = safeString(chatKey).trim();
  const nextReplyToMessageId = safeString(replyToMessageId).trim();
  if (!nextChatKey || !nextReplyToMessageId) return null;
  return (
    findChatMessageByChatAndId(agentDir, nextChatKey, nextReplyToMessageId) ||
    null
  );
}

export function lookupReplySession(
  agentDir: string,
  chatKey: string,
  replyToMessageId: string,
) {
  const linked = lookupReplyMessage(agentDir, chatKey, replyToMessageId);
  if (!linked) return null;
  return {
    linked,
    sessionFile: resolveStoredSessionFile(agentDir, linked.sessionFile),
  };
}

function pickQuoteSenderUserId(quote: any) {
  return safeString(
    quote?.userId ||
      quote?.user?.id ||
      quote?.author?.userId ||
      quote?.author?.id ||
      "",
  ).trim();
}

function pickQuoteContent(quote: any, linked: any) {
  return safeString(
    quote?.content ||
      quote?.message?.content ||
      linked?.text ||
      linked?.strippedContent ||
      linked?.rawContent ||
      "",
  ).trim();
}

export function pickUnsessionedOwnQuoteText(input: {
  session: any;
  linked?: any;
  linkedSessionFile?: string;
}) {
  const replyToMessageId = pickReplyToMessageId(input.session);
  if (!replyToMessageId || safeString(input.linkedSessionFile).trim()) {
    return "";
  }
  const senderUserId = pickUserId(input.session);
  if (!senderUserId) return "";
  const quote = input.session?.quote;
  const quoteUserId =
    pickQuoteSenderUserId(quote) || safeString(input.linked?.userId).trim();
  if (quoteUserId !== senderUserId) return "";
  return pickQuoteContent(quote, input.linked);
}

export function prependQuoteTextToPromptBody(text: string, quoteText: string) {
  const body = safeString(text).trim();
  const quoteBody = safeString(quoteText).trim();
  if (!quoteBody) return body;
  if (!body) return quoteBody;
  return `${quoteBody}\n\n${body}`;
}

function chatMessageSortTime(record: any) {
  return Date.parse(safeString(record?.receivedAt || record?.processedAt)) || 0;
}

function compareChatMessageOrder(left: any, right: any) {
  const leftTime = chatMessageSortTime(left);
  const rightTime = chatMessageSortTime(right);
  if (leftTime !== rightTime) return leftTime - rightTime;
  return safeString(left?.recordKey).localeCompare(
    safeString(right?.recordKey),
  );
}

function isSubstantiveAssistantChatMessage(record: any) {
  return (
    record?.role === "assistant" &&
    isSubstantiveAssistantChatText(record.text || record.rawContent)
  );
}

export function isReplyToLatestAssistantMessage(
  agentDir: string,
  chatKey: string,
  replyToMessageId: string,
) {
  const replied = lookupReplyMessage(agentDir, chatKey, replyToMessageId);
  if (!replied || !isSubstantiveAssistantChatMessage(replied)) return false;
  let latest: any = null;
  for (const item of listChatMessages(agentDir)) {
    if (item.chatKey !== chatKey || !isSubstantiveAssistantChatMessage(item)) {
      continue;
    }
    if (!latest || compareChatMessageOrder(latest, item) < 0) latest = item;
  }
  return (
    safeString(latest?.messageId).trim() ===
    safeString(replied.messageId).trim()
  );
}

function isSubstantiveAssistantChatText(text: unknown) {
  const value = safeString(text).trim();
  return Boolean(
    value &&
    value !== CHAT_WORKING_NOTICE_TEXT &&
    value !== CHAT_INTERIM_REPLY_PREFIX.trim() &&
    !value.startsWith(CHAT_INTERIM_REPLY_PREFIX),
  );
}

export function hasDeliveredAssistantReplyForMessage(
  agentDir: string,
  chatKey: string,
  messageId: string,
) {
  return listChatMessagesByReplyTo(agentDir, chatKey, messageId).some(
    (item) =>
      item.role === "assistant" &&
      isSubstantiveAssistantChatText(item.text || item.rawContent) &&
      Boolean(safeString(item.processedAt).trim()),
  );
}

export function isInboundChatMessageProcessed(
  agentDir: string,
  chatKey: string,
  messageId: string,
) {
  const nextChatKey = safeString(chatKey).trim();
  const nextMessageId = safeString(messageId).trim();
  if (!nextChatKey || !nextMessageId) return false;
  return Boolean(
    safeString(
      findChatMessageByChatAndId(agentDir, nextChatKey, nextMessageId)
        ?.processedAt || "",
    ).trim(),
  );
}

export function isInboundChatMessageAccepted(
  agentDir: string,
  chatKey: string,
  messageId: string,
) {
  const nextChatKey = safeString(chatKey).trim();
  const nextMessageId = safeString(messageId).trim();
  if (!nextChatKey || !nextMessageId) return false;
  return Boolean(
    safeString(
      findChatMessageByChatAndId(agentDir, nextChatKey, nextMessageId)
        ?.acceptedAt || "",
    ).trim(),
  );
}

function commandNameFromStoredText(text: unknown) {
  const value = safeString(text).trim();
  if (!value.startsWith("/")) return "";
  const name = value.slice(1).split(/\s+/, 1)[0]?.trim().toLowerCase() || "";
  return /^[a-z][a-z0-9_-]*$/.test(name) ? name : "";
}

export function hasLaterNewSessionBoundary(
  agentDir: string,
  chatKey: string,
  messageId: string,
) {
  const nextChatKey = safeString(chatKey).trim();
  const nextMessageId = safeString(messageId).trim();
  if (!nextChatKey || !nextMessageId) return false;
  const original = findChatMessageByChatAndId(
    agentDir,
    nextChatKey,
    nextMessageId,
  );
  const originalTime = chatMessageSortTime(original);
  if (!original || !originalTime) return false;
  return listChatMessages(agentDir).some((item) => {
    if (item.chatKey !== nextChatKey) return false;
    if (item.role !== "user") return false;
    if (safeString(item.messageId).trim() === nextMessageId) return false;
    if (!safeString(item.processedAt).trim()) return false;
    if (compareChatMessageOrder(original, item) >= 0) return false;
    return commandNameFromStoredText(item.text || item.rawContent) === "new";
  });
}

export function hasInboundChatMessageReplyBoundary(
  agentDir: string,
  chatKey: string,
  messageId: string,
) {
  return (
    isInboundChatMessageProcessed(agentDir, chatKey, messageId) ||
    hasDeliveredAssistantReplyForMessage(agentDir, chatKey, messageId) ||
    hasLaterNewSessionBoundary(agentDir, chatKey, messageId)
  );
}

export function markProcessedChatMessage(
  agentDir: string,
  chatKey: string,
  messageId: string,
  update: Record<string, unknown>,
) {
  const normalized = { ...update };
  if (Object.prototype.hasOwnProperty.call(normalized, "sessionFile")) {
    normalized.sessionFile = toStoredSessionFile(
      agentDir,
      normalized.sessionFile,
    );
  }
  if (Object.prototype.hasOwnProperty.call(normalized, "sessionId")) {
    delete normalized.sessionId;
  }
  updateChatMessage(agentDir, chatKey, messageId, normalized);
}

export async function persistImageParts(
  chatDir: string,
  images: Array<{ data: string; mimeType: string }>,
  prefix: string,
) {
  const dir = path.join(chatDir, "outbound");
  ensureDir(dir);
  const out: SavedAttachment[] = [];
  let index = 0;
  for (const image of images) {
    index += 1;
    const fileName = ensureExtension(`${prefix}-${index}`, image.mimeType);
    const filePath = path.join(dir, fileName);
    await fs.promises.writeFile(filePath, Buffer.from(image.data, "base64"));
    out.push({
      kind: "image",
      path: filePath,
      name: fileName,
      mimeType: image.mimeType,
    });
  }
  return out;
}

function mediaKindFromElementType(type: string): SavedAttachment["kind"] | "" {
  if (!isMediaElementType(type)) return "";
  return type === "image" || type === "img" ? "image" : "file";
}

function pushInboundAttachmentFailure(
  failures: InboundAttachmentFailure[],
  failure: InboundAttachmentFailure,
) {
  failures.push({
    ...failure,
    type: failure.type || "unknown",
  });
}

export function buildInboundAttachmentNotice(
  failures: InboundAttachmentFailure[],
) {
  if (!Array.isArray(failures) || !failures.length) return "";
  let unresolved = 0;
  let fetchFailed = 0;
  for (const failure of failures) {
    if (failure?.reason === "unresolved_resource") unresolved += 1;
    if (failure?.reason === "fetch_failed") fetchFailed += 1;
  }
  const parts: string[] = [];
  if (unresolved)
    parts.push(
      `${unresolved} media element${unresolved === 1 ? " was" : "s were"} present, but the chat bridge runtime did not resolve a downloadable resource`,
    );
  if (fetchFailed)
    parts.push(
      `${fetchFailed} media resource${fetchFailed === 1 ? "" : "s"} could not be fetched`,
    );
  return `Note: the incoming message included media that could not be attached for the agent because ${parts.join(" and ")}.`;
}

export async function extractInboundAttachments(
  elements: any[],
  chatDir: string,
) {
  const dir = path.join(chatDir, "inbound");
  ensureDir(dir);
  const attachments: SavedAttachment[] = [];
  const failures: InboundAttachmentFailure[] = [];
  let index = 0;

  for (const element of elements) {
    const type = safeString(element?.type || "").toLowerCase();
    const attrs =
      element?.attrs && typeof element.attrs === "object" ? element.attrs : {};
    const kind = mediaKindFromElementType(type);
    if (!kind) continue;
    const src = safeString(
      attrs.src || attrs.url || attrs.file || attrs.path || "",
    ).trim();
    if (!src) {
      pushInboundAttachmentFailure(failures, {
        type,
        kind,
        reason: "unresolved_resource",
      });
      continue;
    }

    index += 1;
    let arrayBuffer: ArrayBuffer;
    let mimeType = "";
    if (src.startsWith("file://")) {
      try {
        const filePath = new URL(src);
        const buffer = await fs.promises.readFile(filePath);
        arrayBuffer = buffer.buffer.slice(
          buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength,
        );
        mimeType = safeString(attrs.mime || attrs.mimeType || "")
          .split(";", 1)[0]
          .trim();
      } catch (error: any) {
        pushInboundAttachmentFailure(failures, {
          type,
          kind,
          reason: "fetch_failed",
          resource: src,
          detail: safeString(error?.message || error).trim() || undefined,
        });
        continue;
      }
    } else {
      let response: Response;
      try {
        response = await fetch(src);
      } catch (error: any) {
        pushInboundAttachmentFailure(failures, {
          type,
          kind,
          reason: "fetch_failed",
          resource: src,
          detail: safeString(error?.message || error).trim() || undefined,
        });
        continue;
      }
      if (!response.ok) {
        pushInboundAttachmentFailure(failures, {
          type,
          kind,
          reason: "fetch_failed",
          resource: src,
          detail: `http_${response.status}`,
        });
        continue;
      }
      arrayBuffer = await response.arrayBuffer();
      mimeType = safeString(
        response.headers.get("content-type") ||
          attrs.mime ||
          attrs.mimeType ||
          "",
      )
        .split(";", 1)[0]
        .trim();
    }
    const rawName =
      safeString(
        attrs.file ||
          attrs.title ||
          attrs.name ||
          fileNameFromUrl(src, `${kind}-${index}`),
      ).trim() || `${kind}-${index}`;
    const fileName = ensureExtension(
      ensureFileName(rawName, `${kind}-${index}`),
      mimeType,
    );
    const filePath = path.join(dir, `${Date.now()}-${index}-${fileName}`);
    await fs.promises.writeFile(filePath, Buffer.from(arrayBuffer));
    attachments.push({
      kind,
      path: filePath,
      name: fileName,
      mimeType,
    });
  }

  return { attachments, failures };
}
