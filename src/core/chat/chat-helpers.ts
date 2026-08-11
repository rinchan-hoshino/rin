import fs from "node:fs";
import path from "node:path";

import { ensureExtension, ensureFileName, fileNameFromUrl } from "./support.js";
import {
  createRinHttpTransport,
  discardRinHttpResponseBody,
  type RinHttpTransport,
} from "../http/transport.js";
import { ensureDir } from "../platform/fs.js";
import {
  findChatMessageByChatAndId,
  saveInboundChatMessage,
  updateChatMessage,
  upsertChatMessage,
} from "./message-store.js";
import { openChatDatabase } from "./database.js";
import {
  buildInboundStoredChatMessageInput,
  pickReplyToMessageId,
  pickUserId,
} from "./inbound-normalization.js";
import {
  extractImageParts as extractStructuredImageParts,
  extractMessageText,
  normalizeMessageText,
} from "../message-content.js";
import { safeString } from "../text-utils.js";
import { renderChatNodesMarkdown } from "./rich-text.js";
import {
  resolveStoredSessionFile,
  toStoredSessionFile,
} from "../session/ref.js";

export type SavedAttachment = {
  kind: "image" | "file";
  path: string;
  name: string;
  mimeType?: string;
  sourceMediaIndex?: number;
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
};

export const CHAT_WORKING_NOTICE_TEXT = "Working...";

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
  renderInboundMessageText,
  pickSenderGroupNickname,
  pickSenderNickname,
  pickUserId,
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

export function enrichInboundMessageMetadata(
  agentDir: string,
  session: any,
  elements: any[],
  identity: any,
  trustOf: (identity: any, platform: string, userId: string) => string,
  options: { chatKey?: string } = {},
) {
  const platform = safeString(session?.platform || "").trim();
  const userId = pickUserId(session);
  const normalized = buildInboundStoredChatMessageInput(session, elements, {
    trust: trustOf(identity, platform, userId),
    chatKey: options.chatKey,
  });
  if (!normalized) return null;
  const existing = findChatMessageByChatAndId(
    agentDir,
    normalized.chatKey,
    normalized.messageId,
  );
  if (!existing) return null;
  updateChatMessage(agentDir, normalized.chatKey, normalized.messageId, {
    platform: existing.platform || normalized.platform,
    botId: existing.botId || normalized.botId,
    chatId: existing.chatId || normalized.chatId,
    chatThreadId: existing.chatThreadId || normalized.chatThreadId,
    messageThreadId: existing.messageThreadId || normalized.messageThreadId,
    chatType: existing.chatType || normalized.chatType,
    userId: existing.userId || normalized.userId,
    nickname: existing.nickname || normalized.nickname,
    chatName: existing.chatName || normalized.chatName,
    trust: existing.trust || normalized.trust,
  });
  return existing;
}

export function persistInboundMessage(
  agentDir: string,
  session: any,
  elements: any[],
  identity: any,
  trustOf: (identity: any, platform: string, userId: string) => string,
  options: { chatKey?: string; mergeDuplicate?: boolean } = {},
) {
  const platform = safeString(session?.platform || "").trim();
  const userId = pickUserId(session);
  const normalized = buildInboundStoredChatMessageInput(session, elements, {
    trust: trustOf(identity, platform, userId),
    chatKey: options.chatKey,
  });
  if (!normalized) return null;
  return options.mergeDuplicate === false
    ? { record: upsertChatMessage(agentDir, normalized) }
    : saveInboundChatMessage(agentDir, normalized);
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

export function pickUnsessionedOwnQuoteText(input: {
  senderUserId: string;
  linked?: any;
  linkedSessionFile?: string;
}) {
  if (safeString(input.linkedSessionFile).trim()) return null;
  const senderUserId = safeString(input.senderUserId).trim();
  const linked = input.linked;
  if (
    !senderUserId ||
    linked?.role !== "user" ||
    safeString(linked?.userId).trim() !== senderUserId
  ) {
    return null;
  }
  return safeString(
    linked?.text ?? linked?.strippedContent ?? linked?.rawContent,
  );
}

export function prependQuoteTextToPromptBody(text: string, quoteText: string) {
  const body = safeString(text);
  const quoteBody = safeString(quoteText);
  if (!quoteBody) return body;
  if (!body) return quoteBody;
  return `${quoteBody}\n\n${body}`;
}

function isSubstantiveAssistantChatMessage(record: any) {
  return record?.role === "assistant" && isSubstantiveAssistantDelivery(record);
}

export function isReplyToLatestAssistantMessage(
  agentDir: string,
  chatKey: string,
  replyToMessageId: string,
) {
  const replied = lookupReplyMessage(agentDir, chatKey, replyToMessageId);
  if (!replied || !isSubstantiveAssistantChatMessage(replied)) return false;
  const latest = openChatDatabase(agentDir)
    .prepare(
      `SELECT message_id FROM messages
       WHERE chat_key = ? AND role = 'assistant'
         AND delivery_kind IN ('final', 'generic')
       ORDER BY received_at DESC, record_key DESC LIMIT 1`,
    )
    .get(chatKey) as any;
  return (
    safeString(latest?.message_id).trim() ===
    safeString(replied.messageId).trim()
  );
}

function isSubstantiveAssistantDelivery(item: { deliveryKind?: string }) {
  const deliveryKind = safeString(item.deliveryKind).trim();
  return deliveryKind === "final" || deliveryKind === "generic";
}

export function hasDeliveredAssistantReplyForMessage(
  agentDir: string,
  chatKey: string,
  messageId: string,
) {
  return Boolean(
    openChatDatabase(agentDir)
      .prepare(
        `SELECT 1 FROM messages
         WHERE chat_key = ? AND role = 'assistant'
           AND reply_to_message_id = ? AND processed_at IS NOT NULL
           AND delivery_kind IN ('final', 'generic')
         LIMIT 1`,
      )
      .get(chatKey, messageId),
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

export function hasLaterNewSessionBoundary(
  agentDir: string,
  chatKey: string,
  messageId: string,
) {
  const nextChatKey = safeString(chatKey).trim();
  const nextMessageId = safeString(messageId).trim();
  if (!nextChatKey || !nextMessageId) return false;
  return Boolean(
    openChatDatabase(agentDir)
      .prepare(
        `SELECT 1
         FROM messages AS later
         JOIN messages AS original
           ON original.chat_key = later.chat_key
          AND original.message_id = ?
         WHERE later.chat_key = ? AND later.role = 'user'
           AND later.sequence > original.sequence
           AND later.processed_at IS NOT NULL
           AND (
             LOWER(TRIM(COALESCE(later.text, later.raw_content, ''))) = '/new'
             OR LOWER(TRIM(COALESCE(later.text, later.raw_content, ''))) LIKE '/new %'
           )
         LIMIT 1`,
      )
      .get(nextMessageId, nextChatKey),
  );
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

function localAttachmentPath(filePath: string) {
  return path.resolve(filePath);
}

function mediaElementName(element: any) {
  const attrs =
    element?.attrs && typeof element.attrs === "object" ? element.attrs : {};
  return safeString(
    attrs.name || attrs.file || attrs.fileName || attrs.title || "",
  ).trim();
}

function findSavedAttachmentIndex(
  attachments: SavedAttachment[],
  kind: SavedAttachment["kind"],
  name: string,
  sourceMediaIndex: number,
) {
  const bySourceMediaIndex = attachments.findIndex(
    (item) =>
      item?.kind === kind &&
      typeof item.sourceMediaIndex === "number" &&
      item.sourceMediaIndex === sourceMediaIndex,
  );
  if (bySourceMediaIndex >= 0) return bySourceMediaIndex;
  if (name) {
    return attachments.findIndex(
      (item) => item?.kind === kind && item?.name === name,
    );
  }
  return -1;
}

export function renderPromptTextWithSavedAttachments(
  elements: any[],
  attachments: SavedAttachment[],
) {
  const attachmentQueue = (
    Array.isArray(attachments) ? attachments : []
  ).slice();
  let mediaIndex = 0;
  const nextElements = (Array.isArray(elements) ? elements : []).map(
    (element) => {
      const type = safeString(element?.type || "").toLowerCase();
      const kind = mediaKindFromElementType(type);
      if (!kind) return element;
      mediaIndex += 1;
      const attachmentIndex = findSavedAttachmentIndex(
        attachmentQueue,
        kind,
        mediaElementName(element),
        mediaIndex,
      );
      if (attachmentIndex < 0) return element;
      const [attachment] = attachmentQueue.splice(attachmentIndex, 1);
      if (!attachment?.path) return element;
      return {
        ...element,
        attrs: {
          ...(element?.attrs && typeof element.attrs === "object"
            ? element.attrs
            : {}),
          src: localAttachmentPath(attachment.path),
          file: attachment.name,
          name: attachment.name,
          mimeType: attachment.mimeType,
        },
      };
    },
  );
  return normalizeMessageText(renderChatNodesMarkdown(nextElements));
}

export async function extractInboundAttachments(
  elements: any[],
  chatDir: string,
  httpTransport?: RinHttpTransport,
) {
  const dir = path.join(chatDir, "inbound");
  ensureDir(dir);
  const attachments: SavedAttachment[] = [];
  const failures: InboundAttachmentFailure[] = [];
  const requestTransport = httpTransport || createRinHttpTransport();
  let index = 0;

  try {
    for (const element of elements) {
      const type = safeString(element?.type || "").toLowerCase();
      const attrs =
        element?.attrs && typeof element.attrs === "object"
          ? element.attrs
          : {};
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
        let response: any;
        try {
          response = await requestTransport.fetch(src);
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
        try {
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
        } finally {
          await discardRinHttpResponseBody(response);
        }
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
        sourceMediaIndex: index,
      });
    }

    return { attachments, failures };
  } finally {
    if (!httpTransport) await requestTransport.close();
  }
}
