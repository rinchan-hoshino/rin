import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import { Api as GrammyApi, InputFile } from "grammy";
import { Agent as UndiciAgent } from "undici";
import WebSocket from "ws";

import { getWorkingReactionFrame } from "../chat/transport.js";
import { enqueueChatInboxItem } from "../chat/inbox.js";
import { getChatId, pickMessageId } from "../chat/chat-helpers.js";
import {
  getChatBridgeAdapterSpec,
  type ChatBridgeBuiltInAdapterKey,
} from "../chat-bridge/adapters.js";
import { composeChatKeyForBot } from "../chat/support.js";
import {
  compactObject,
  createPrefixedLogger,
  editableWorkingText,
  emitBotStatus,
  ensureDir,
  ensureExtension,
  ensureFileName,
  fileUrl,
  isEditableProgressDeliveryKind,
  normalizeNode,
  prepareOutboundNodes,
  randomWorkingText,
  readBinaryFromNode,
  renderMarkdownFromNodes,
  renderPlainTextFromNodes,
  renderRichDeliveryErrorPlaceholder,
  renderTelegramHtmlFromNodes,
  resolveChatRuntimeWorkingCopy,
  safeString,
  sleep,
  splitPlainText,
  stageChatMediaFromNode,
} from "./common.js";
import { EditableTextMessageGroup } from "./editable-text-message-group.js";

export function toSnakeCase(value: string) {
  return safeString(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

export function isTelegramMediaNodeType(type: string) {
  return ["image", "file", "video", "audio", "sticker"].includes(type);
}

export function telegramMediaMethod(type: string) {
  if (type === "image") return { method: "sendPhoto", field: "photo" };
  if (type === "video") return { method: "sendVideo", field: "video" };
  if (type === "audio") return { method: "sendAudio", field: "audio" };
  if (type === "sticker") return { method: "sendSticker", field: "sticker" };
  return { method: "sendDocument", field: "document" };
}

export const TELEGRAM_CHAT_THREAD_MARKER = "?thread=";

export function encodeTelegramThreadId(threadId: unknown) {
  return encodeURIComponent(safeString(threadId).trim());
}

export function decodeTelegramThreadId(threadId: unknown) {
  try {
    return decodeURIComponent(safeString(threadId).trim());
  } catch {
    return safeString(threadId).trim();
  }
}

export function splitTelegramChatThread(
  chatId: unknown,
  explicitThreadId: unknown = "",
) {
  let nextChatId = safeString(chatId).trim();
  let messageThreadId = safeString(explicitThreadId).trim();
  const markerIndex = nextChatId.lastIndexOf(TELEGRAM_CHAT_THREAD_MARKER);
  if (markerIndex >= 0) {
    if (!messageThreadId) {
      messageThreadId = decodeTelegramThreadId(
        nextChatId.slice(markerIndex + TELEGRAM_CHAT_THREAD_MARKER.length),
      );
    }
    nextChatId = nextChatId.slice(0, markerIndex);
  }
  return {
    chatId: nextChatId,
    messageThreadId,
    scopedChatId: messageThreadId
      ? `${nextChatId}${TELEGRAM_CHAT_THREAD_MARKER}${encodeTelegramThreadId(messageThreadId)}`
      : nextChatId,
  };
}

export function telegramThreadPayload(messageThreadId: unknown) {
  const text = safeString(messageThreadId).trim();
  if (!text) return {};
  const numeric = Number(text);
  return { message_thread_id: Number.isFinite(numeric) ? numeric : text };
}

export function isTextLikeNode(node: any) {
  const type = safeString(node?.type).toLowerCase();
  return (
    type === "text" ||
    type === "markdown" ||
    type === "md" ||
    type === "html" ||
    type === "at" ||
    type === "br" ||
    type === "p" ||
    type === "paragraph"
  );
}

export function displayNameFromTelegramUser(user: any) {
  return (
    safeString(user?.username).trim() ||
    [safeString(user?.first_name).trim(), safeString(user?.last_name).trim()]
      .filter(Boolean)
      .join(" ")
      .trim()
  );
}

export function parseTelegramReplyQuote(message: any) {
  const reply = message?.reply_to_message;
  if (!reply || typeof reply !== "object") return undefined;
  const userId = safeString(reply?.from?.id || "").trim() || undefined;
  const nickname = displayNameFromTelegramUser(reply?.from) || undefined;
  const content =
    safeString(reply?.text || reply?.caption || "").trim() || undefined;
  const messageId = safeString(reply?.message_id || "").trim() || undefined;
  if (!messageId && !userId && !nickname && !content) return undefined;
  return { messageId, userId, nickname, content };
}

export function parseOneBotReplyQuote(data: Record<string, any>) {
  const messageId =
    safeString(data?.id || data?.message_id || "").trim() || undefined;
  if (!messageId) return undefined;
  return { messageId };
}

export function pickOneBotForwardId(data: Record<string, any>) {
  return safeString(data?.id || data?.resid || data?.file || "").trim();
}

export function oneBotForwardNodeAuthor(data: Record<string, any>) {
  const userId = safeString(
    data?.user_id || data?.uin || data?.qq || "",
  ).trim();
  const nickname = safeString(
    data?.nickname || data?.name || data?.nick || data?.sender?.nickname || "",
  ).trim();
  if (nickname && userId) return `${nickname}(${userId})`;
  return nickname || userId || "unknown";
}

export function oneBotForwardNodeText(content: unknown): string {
  const segments = parseOneBotSegments(content);
  return renderMarkdownFromNodes(
    segments.map((segment) => {
      const type = safeString(segment.type).toLowerCase();
      const data =
        segment.data && typeof segment.data === "object" ? segment.data : {};
      if (type === "text")
        return normalizeNode("text", { content: data?.text });
      if (type === "at") {
        const id = safeString(data?.qq || data?.id || "").trim();
        return normalizeNode("at", {
          id,
          name: safeString(data?.name).trim() || id,
        });
      }
      if (type === "image" || type === "img") {
        return normalizeNode("image", {
          src: safeString(data?.url || data?.file).trim(),
          name: safeString(data?.file).trim() || undefined,
        });
      }
      if (
        [
          "file",
          "video",
          "record",
          "audio",
          "voice",
          "sticker",
          "face",
          "mface",
        ].includes(type)
      ) {
        const nodeType =
          type === "record" || type === "voice"
            ? "audio"
            : type === "face" || type === "mface"
              ? "sticker"
              : type;
        return normalizeNode(nodeType, {
          src: safeString(data?.url || data?.file).trim() || undefined,
          id: safeString(data?.id || data?.qq).trim() || undefined,
          name:
            safeString(data?.name || data?.file || data?.text).trim() ||
            undefined,
        });
      }
      if (type === "forward") {
        const id = pickOneBotForwardId(data);
        return normalizeNode("text", {
          content: id ? `[merged forward:${id}]` : "[merged forward]",
        });
      }
      return normalizeNode("text", {
        content: renderPlainTextFromNodes([normalizeNode(type, data)]),
      });
    }),
  );
}

export function oneBotForwardMessages(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const record = value as any;
    if (Array.isArray(record.messages)) return record.messages;
    if (Array.isArray(record.data?.messages)) return record.data.messages;
    if (Array.isArray(record.content)) return record.content;
    if (Array.isArray(record.data?.content)) return record.data.content;
  }
  return [];
}

export function parseOneBotSegments(input: unknown) {
  if (Array.isArray(input)) {
    return input
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        return {
          type: safeString((item as any).type).trim(),
          data:
            (item as any).data && typeof (item as any).data === "object"
              ? { ...(item as any).data }
              : {},
        };
      })
      .filter(Boolean) as Array<{ type: string; data: Record<string, any> }>;
  }
  const text = safeString(input);
  if (!text) return [] as Array<{ type: string; data: Record<string, any> }>;
  const segments: Array<{ type: string; data: Record<string, any> }> = [];
  const pattern = /\[CQ:([^,\]]+)((?:,[^\]]*)?)\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) {
      segments.push({
        type: "text",
        data: { text: text.slice(lastIndex, match.index) },
      });
    }
    const type = safeString(match[1]).trim();
    const rawArgs = safeString(match[2]).replace(/^,/, "");
    const data: Record<string, any> = {};
    if (rawArgs) {
      for (const part of rawArgs.split(",")) {
        const [key, ...rest] = part.split("=");
        data[safeString(key).trim()] = rest.join("=");
      }
    }
    segments.push({ type, data });
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) {
    segments.push({ type: "text", data: { text: text.slice(lastIndex) } });
  }
  return segments;
}

export function renderOneBotForwardContent(value: unknown) {
  const lines: string[] = [];
  for (const item of oneBotForwardMessages(value)) {
    const data = item?.data && typeof item.data === "object" ? item.data : item;
    const text = oneBotForwardNodeText(
      data?.content ?? data?.message ?? data?.raw_message ?? "",
    );
    const author = oneBotForwardNodeAuthor(data || {});
    if (!text && author === "unknown") continue;
    lines.push(
      text
        ? `${author}: ${text.replace(/\n/g, "\n  ")}`
        : `${author}: [empty message]`,
    );
  }
  return lines.length ? `[merged forward]\n${lines.join("\n")}` : "";
}

export const TELEGRAM_MAX_TEXT_LENGTH = 4096;
export const TELEGRAM_MAX_CAPTION_LENGTH = 1024;

export function isTelegramPhotoDimensionError(error: unknown) {
  return /\bPHOTO_INVALID_DIMENSIONS\b/i.test(
    safeString((error as any)?.message || error),
  );
}

export function createNodeBuilder() {
  const h: any = (
    type: string,
    attrs?: Record<string, any>,
    ...children: any[]
  ) => normalizeNode(type, attrs, children);
  h.text = (content: unknown) =>
    normalizeNode("text", { content: safeString(content) });
  h.quote = (id: unknown) => normalizeNode("quote", { id: safeString(id) });
  h.at = (id: unknown, attrs?: Record<string, any>) =>
    normalizeNode(
      "at",
      compactObject({ ...(attrs || {}), id: safeString(id) }),
    );
  h.image = (src: unknown) => normalizeNode("image", { src: safeString(src) });
  h.markdown = (content: unknown) =>
    normalizeNode("markdown", { content: safeString(content) });
  h.html = (content: unknown) =>
    normalizeNode("html", { content: safeString(content) });
  h.file = (value: unknown, mimeType?: string, attrs?: Record<string, any>) => {
    const base = compactObject({
      ...(attrs || {}),
      mimeType: safeString(mimeType).trim() || undefined,
    });
    if (Buffer.isBuffer(value))
      return normalizeNode("file", { ...base, data: value });
    return normalizeNode("file", { ...base, src: safeString(value) });
  };
  return h;
}

export function partialChatDeliveryError(error: unknown, delivered: string[]) {
  const message = safeString((error as any)?.message || error) || "send_failed";
  const next = new Error(`chat_delivery_partial:${message}`) as Error & {
    deliveredMessageIds?: string[];
    partialDelivery?: boolean;
  };
  next.deliveredMessageIds = [...delivered];
  next.partialDelivery = true;
  return next;
}

export class ChatRuntimeApp extends EventEmitter {
  bots: any[] = [];
  private readonly adapters = new Set<any>();
  readonly agentDir?: string;

  constructor(agentDir?: string) {
    super();
    this.agentDir = agentDir ? path.resolve(agentDir) : undefined;
  }

  private persistInboundSession(session: any) {
    const nextAgentDir = safeString(this.agentDir).trim();
    const platform = safeString(session?.platform).trim();
    const botId = safeString(session?.selfId || session?.bot?.selfId).trim();
    const chatId = getChatId(session);
    const messageId = pickMessageId(session);
    if (!nextAgentDir || !platform || !botId || !chatId || !messageId) {
      return;
    }
    const baseChatKey = composeChatKeyForBot(this, platform, chatId, botId);
    if (!baseChatKey) return;
    const messageThreadId =
      platform === "telegram"
        ? safeString(
            session?.messageThreadId ||
              session?.chatThreadId ||
              session?.telegram?.message?.message_thread_id ||
              "",
          ).trim()
        : "";
    const chatKey = messageThreadId
      ? `${baseChatKey}${TELEGRAM_CHAT_THREAD_MARKER}${encodeTelegramThreadId(messageThreadId)}`
      : baseChatKey;
    const elements = Array.isArray(session?.elements) ? session.elements : [];
    enqueueChatInboxItem(nextAgentDir, {
      chatKey,
      messageId,
      session,
      elements,
    });
  }

  emit(eventName: string | symbol, ...args: any[]): boolean {
    if (eventName === "message" && args.length > 0) {
      this.persistInboundSession(args[0]);
    }
    return super.emit(eventName, ...args);
  }

  register(adapter: any, bot: any) {
    if (bot) this.bots.push(bot);
    if (adapter) this.adapters.add(adapter);
  }

  async start() {
    for (const adapter of this.adapters) {
      if (typeof adapter?.start === "function") {
        await adapter.start();
      }
    }
  }

  async stop() {
    const adapters = [...this.adapters].reverse();
    for (const adapter of adapters) {
      if (typeof adapter?.stop === "function") {
        await adapter.stop();
      }
    }
  }
}
