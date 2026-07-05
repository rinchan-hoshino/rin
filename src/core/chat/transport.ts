import fs from "node:fs";
import path from "node:path";
import { pathToFileURL as toFileUrl } from "node:url";

import type { ImageContent } from "@earendil-works/pi-ai";
import {
  base64_to_image as base64ToPhotonImage,
  resize as resizePhotonImage,
  SamplingFilter,
  type PhotonImage,
} from "@silvia-odwyer/photon-node";

import type {
  ChatMessagePart,
  ChatOutboxPayload,
} from "../rin-lib/chat-outbox.js";
import { formatRinTodoChecklistCharacterContent } from "../rin-lib/todo-state.js";
import {
  findBot,
  inferChatType,
  isPrivateChat,
  parseChatKey,
} from "./support.js";
import { appendChatLog } from "./chat-log.js";
import {
  findChatMessageByChatAndId,
  saveChatMessage,
} from "./message-store.js";
import { nowIso } from "../time-utils.js";
import type {
  ChatPromptRestoreInput,
  SavedAttachment,
} from "./chat-helpers.js";
import {
  ensureDir,
  extractTextFromContent,
  safeString,
} from "./chat-helpers.js";
import {
  normalizeSessionRef,
  resolveStoredSessionFile,
} from "../session/ref.js";

const DEFAULT_WORKING_REACTION_FRAMES = ["🤔", "🔥"] as const;
const ONEBOT_WORKING_REACTION_FRAMES = ["🤔", "🔥"] as const;
const CHAT_PRESENTATION_TIMEOUT_MS = 2500;
const MODEL_IMAGE_MAX_BYTES = 1_250_000;
const MODEL_IMAGE_MAX_EDGE = 1600;
const MODEL_IMAGE_MIN_EDGE = 512;
const MODEL_IMAGE_JPEG_QUALITIES = [82, 72, 62, 52, 42] as const;

type ModelImageCompressionOptions = {
  maxBytes?: number;
  maxEdge?: number;
  minEdge?: number;
  force?: boolean;
};

async function withPresentationTimeout<T>(
  run: () => Promise<T>,
  fallback: T,
  timeoutMs = CHAT_PRESENTATION_TIMEOUT_MS,
) {
  return await Promise.race([
    run().catch(() => fallback),
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(fallback), Math.max(1, timeoutMs));
    }),
  ]);
}

export function getWorkingReactionFrame(platform: string, index: number) {
  const frames =
    safeString(platform).trim() === "onebot"
      ? ONEBOT_WORKING_REACTION_FRAMES
      : DEFAULT_WORKING_REACTION_FRAMES;
  const size = frames.length;
  if (!size) return "";
  const nextIndex = Number.isFinite(index)
    ? Math.abs(Math.floor(index)) % size
    : 0;
  return frames[nextIndex] || frames[0] || "";
}

function pickCreateReaction(bot: any) {
  if (typeof bot?.createReaction === "function") {
    return bot.createReaction.bind(bot);
  }
  if (typeof bot?.internal?.createReaction === "function") {
    return bot.internal.createReaction.bind(bot.internal);
  }
  return null;
}

function pickDeleteReaction(bot: any) {
  if (typeof bot?.deleteReaction === "function") {
    return bot.deleteReaction.bind(bot);
  }
  if (typeof bot?.internal?.deleteReaction === "function") {
    return bot.internal.deleteReaction.bind(bot.internal);
  }
  if (typeof bot?.internal?.deleteOwnReaction === "function") {
    return bot.internal.deleteOwnReaction.bind(bot.internal);
  }
  return null;
}

export async function sendTyping(app: any, chatKey: string, h: any) {
  const target = tryResolveChatTarget(app, chatKey);
  if (!target) return false;
  const { parsed, bot } = target;
  if (typeof bot?.internal?.sendChatAction === "function") {
    const sent = await withPresentationTimeout(async () => {
      await bot.internal.sendChatAction({
        chat_id: parsed.chatId,
        action: "typing",
      });
      return true;
    }, false);
    if (sent) return true;
  }
  if (typeof bot?.internal?.sendTyping === "function") {
    const sent = await withPresentationTimeout(async () => {
      await bot.internal.sendTyping(parsed.chatId);
      return true;
    }, false);
    if (sent) return true;
  }
  return false;
}

export async function sendReaction(
  app: any,
  chatKey: string,
  messageId: string,
  emoji: string,
) {
  const target = tryResolveChatTarget(app, chatKey);
  if (!target) return false;
  const { parsed, bot } = target;
  const nextEmoji = safeString(emoji).trim();
  const nextMessageId = safeString(messageId).trim();
  if (!nextEmoji || !nextMessageId) return false;
  if (parsed.platform === "onebot" && isPrivateChat(parsed)) return false;

  if (
    parsed.platform !== "onebot" &&
    typeof bot?.internal?.setMessageReaction === "function"
  ) {
    return await withPresentationTimeout(async () => {
      await bot.internal.setMessageReaction({
        chat_id: parsed.chatId,
        message_id: Number(nextMessageId),
        reaction: [{ type: "emoji", emoji: nextEmoji }],
      });
      return true;
    }, false);
  }

  const createReaction = pickCreateReaction(bot);
  if (!createReaction) return false;
  return await withPresentationTimeout(async () => {
    await createReaction(parsed.chatId, nextMessageId, nextEmoji);
    return true;
  }, false);
}

export async function rotateWorkingReaction(
  app: any,
  chatKey: string,
  messageId: string,
  frameIndex: number,
  previousEmoji = "",
) {
  const target = tryResolveChatTarget(app, chatKey);
  if (!target) return previousEmoji || "";
  const { parsed, bot } = target;
  const nextEmoji = getWorkingReactionFrame(parsed.platform, frameIndex);
  if (!nextEmoji) return previousEmoji || "";
  if (previousEmoji && previousEmoji === nextEmoji) {
    return previousEmoji;
  }

  if (
    parsed.platform !== "onebot" &&
    typeof bot?.internal?.setMessageReaction === "function"
  ) {
    return await withPresentationTimeout(async () => {
      await bot.internal.setMessageReaction({
        chat_id: parsed.chatId,
        message_id: Number(messageId),
        reaction: [{ type: "emoji", emoji: nextEmoji }],
      });
      return nextEmoji;
    }, previousEmoji || "");
  }

  if (parsed.platform === "onebot" && isPrivateChat(parsed)) {
    return previousEmoji || "";
  }

  const createReaction = pickCreateReaction(bot);
  if (!createReaction) {
    return previousEmoji || "";
  }
  const deleteReaction = pickDeleteReaction(bot);
  const deletePrevious =
    previousEmoji && previousEmoji !== nextEmoji && deleteReaction;
  let previousDeleted = false;
  if (deletePrevious) {
    await withPresentationTimeout(async () => {
      await deleteReaction(
        parsed.chatId,
        messageId,
        previousEmoji,
        safeString(bot?.selfId).trim() || undefined,
      );
      previousDeleted = true;
      return true;
    }, false);
  }
  const created = await withPresentationTimeout(async () => {
    await createReaction(parsed.chatId, messageId, nextEmoji);
    return nextEmoji;
  }, "");
  if (created) return created;
  if (previousDeleted && previousEmoji) {
    return await withPresentationTimeout(async () => {
      await createReaction(parsed.chatId, messageId, previousEmoji);
      return previousEmoji;
    }, previousEmoji);
  }
  return previousEmoji || "";
}

export async function clearWorkingReaction(
  app: any,
  chatKey: string,
  messageId: string,
  emoji: string,
) {
  const target = tryResolveChatTarget(app, chatKey);
  if (!target) return false;
  const { parsed, bot } = target;
  const nextEmoji = safeString(emoji).trim();
  if (!nextEmoji) return false;
  if (parsed.platform === "onebot" && isPrivateChat(parsed)) return false;

  const deleteReaction = pickDeleteReaction(bot);
  if (deleteReaction) {
    const deleted = await withPresentationTimeout(async () => {
      await deleteReaction(
        parsed.chatId,
        messageId,
        nextEmoji,
        safeString(bot?.selfId).trim() || undefined,
      );
      return true;
    }, false);
    if (deleted) return true;
  }

  if (
    parsed.platform !== "onebot" &&
    typeof bot?.internal?.setMessageReaction === "function"
  ) {
    return await withPresentationTimeout(async () => {
      await bot.internal.setMessageReaction({
        chat_id: parsed.chatId,
        message_id: Number(messageId),
        reaction: [],
      });
      return true;
    }, false);
  }

  const fallbackDeleteReaction = pickDeleteReaction(bot);
  if (!fallbackDeleteReaction) return false;
  return await withPresentationTimeout(async () => {
    await fallbackDeleteReaction(
      parsed.chatId,
      messageId,
      nextEmoji,
      safeString(bot?.selfId).trim() || undefined,
    );
    return true;
  }, false);
}

function formatNoBotError(parsed: { platform: string; botId: string }) {
  return `no_bot_for_platform:${parsed.platform}${parsed.botId ? `/${parsed.botId}` : ""}`;
}

function tryResolveChatTarget(app: any, chatKey: string) {
  const parsed = parseChatKey(chatKey);
  if (!parsed) return null;
  const bot = findBot(app, parsed.platform, parsed.botId);
  if (!bot) return null;
  return { parsed, bot };
}

function requireChatTarget(app: any, chatKey: string) {
  const parsed = parseChatKey(chatKey);
  if (!parsed) throw new Error(`invalid_chatKey:${chatKey}`);
  const bot = findBot(app, parsed.platform, parsed.botId);
  if (!bot) throw new Error(formatNoBotError(parsed));
  return { parsed, bot };
}

function withReplyQuote(h: any, replyToMessageId: string, nodes: any[]) {
  const nextReplyToMessageId = safeString(replyToMessageId).trim();
  return nextReplyToMessageId
    ? [h.quote(nextReplyToMessageId), ...nodes]
    : nodes;
}

function markdownNode(h: any, text: string) {
  if (typeof h?.markdown === "function") return h.markdown(text);
  return typeof h === "function"
    ? h("markdown", { content: text })
    : { type: "markdown", attrs: { content: text } };
}

function sendChatNodes(
  app: any,
  chatKey: string,
  nodes: any[],
  options: Record<string, any> = {},
) {
  const { parsed, bot } = requireChatTarget(app, chatKey);
  return sendBotMessage(bot, parsed.chatId, nodes, options);
}

const CHAT_OUTBOX_ASYNC_PLATFORMS = new Set([
  "discord",
  "lark",
  "onebot",
  "slack",
  "telegram",
]);

export function chatOutboxPayloadUsesAsyncDispatch(
  payload: Pick<ChatOutboxPayload, "chatKey"> | undefined,
) {
  const parsed = parseChatKey(safeString(payload?.chatKey));
  return !!parsed && CHAT_OUTBOX_ASYNC_PLATFORMS.has(parsed.platform);
}

function normalizeOutboxChatKey(chatKey: string) {
  const nextChatKey = safeString(chatKey).trim();
  if (!nextChatKey) throw new Error("invalid_chatKey:");
  return nextChatKey;
}

function normalizeOutboxText(text: string) {
  const nextText = safeString(text).trim();
  if (!nextText) throw new Error("chat_outbox_empty_message");
  return nextText;
}

function normalizeDeliveredMessageIds(result: unknown) {
  if (!Array.isArray(result) || !result.length) {
    throw new Error("chat_send_message_empty_result");
  }
  const messageIds = result
    .map((item) => safeString(item).trim())
    .filter(Boolean);
  if (!messageIds.length) {
    throw new Error("chat_send_message_empty_result");
  }
  return messageIds;
}

type ChatDeliveryPromise<T> = Promise<T> & { dispatched?: Promise<void> };

function attachChatDeliveryDispatch<T>(
  task: Promise<T>,
  dispatched?: Promise<void>,
): ChatDeliveryPromise<T> {
  const delivery = task as ChatDeliveryPromise<T>;
  if (dispatched) {
    void dispatched.catch(() => {});
    delivery.dispatched = dispatched;
  }
  return delivery;
}

export function getChatDeliveryDispatchPromise(
  task: unknown,
): Promise<void> | undefined {
  const dispatched = (task as any)?.dispatched;
  return dispatched && typeof dispatched.then === "function"
    ? dispatched
    : undefined;
}

export function getChatOutboxDispatchPromise(
  payload: ChatOutboxPayload,
  task: unknown,
): Promise<void> | undefined {
  if (!chatOutboxPayloadUsesAsyncDispatch(payload)) return undefined;
  return getChatDeliveryDispatchPromise(task);
}

function sendBotMessage(
  bot: any,
  chatId: string,
  content: any,
  options: Record<string, any> = {},
) {
  const raw = bot.sendMessage(chatId, content, options);
  return attachChatDeliveryDispatch(
    Promise.resolve(raw).then((result) => normalizeDeliveredMessageIds(result)),
    getChatDeliveryDispatchPromise(raw),
  );
}

function resolveSessionContext(
  agentDir: string,
  chatKey: string,
  replyToMessageId = "",
  explicit: { sessionFile?: string } = {},
) {
  const explicitSessionFile = resolveStoredSessionFile(
    agentDir,
    explicit.sessionFile,
  );
  if (explicitSessionFile) return { sessionFile: explicitSessionFile };
  const nextReplyToMessageId = safeString(replyToMessageId).trim();
  if (!nextReplyToMessageId) return {};
  const linked = findChatMessageByChatAndId(
    agentDir,
    chatKey,
    nextReplyToMessageId,
  );
  return {
    sessionFile: resolveStoredSessionFile(agentDir, linked?.sessionFile),
  };
}

type DeliveredAssistantRecordInput = {
  chatKey: string;
  deliveryResult: string[];
  text?: string;
  rawContent?: string;
  replyToMessageId?: string;
  sessionFile?: string;
  sessionBinding?: "conversation";
};

export function recordDeliveredAssistantMessages(
  agentDir: string,
  input: DeliveredAssistantRecordInput,
) {
  const chatKey = safeString(input.chatKey).trim();
  if (!chatKey) return [] as string[];
  const parsed = parseChatKey(chatKey);
  if (!parsed) return [] as string[];
  const messageIds = Array.isArray(input.deliveryResult)
    ? input.deliveryResult
        .map((item) => safeString(item).trim())
        .filter(Boolean)
    : [];
  if (!messageIds.length) return [] as string[];

  const bodyText = safeString(input.text).trim();
  const rawContent =
    safeString(input.rawContent).trim() || bodyText || undefined;
  const session =
    input.sessionBinding === "conversation"
      ? resolveSessionContext(
          agentDir,
          chatKey,
          safeString(input.replyToMessageId).trim(),
          {
            sessionFile: input.sessionFile,
          },
        )
      : {};
  const now = nowIso();

  for (const messageId of messageIds) {
    saveChatMessage(agentDir, {
      messageId,
      role: "assistant",
      replyToMessageId: safeString(input.replyToMessageId).trim() || undefined,
      sessionFile: session.sessionFile,
      processedAt: now,
      chatKey,
      platform: parsed.platform,
      botId: parsed.botId || undefined,
      chatId: parsed.chatId,
      chatType: inferChatType(parsed),
      receivedAt: now,
      text: bodyText || undefined,
      rawContent,
      strippedContent: bodyText || undefined,
    });
  }

  return messageIds;
}

type FinalizeDeliveredAssistantInput = DeliveredAssistantRecordInput & {
  logText?: string;
};

function finalizeDeliveredAssistantOutput(
  agentDir: string,
  input: FinalizeDeliveredAssistantInput,
) {
  const chatKey = safeString(input.chatKey).trim();
  if (!chatKey) return [] as string[];
  const replyToMessageId =
    safeString(input.replyToMessageId).trim() || undefined;
  const session =
    input.sessionBinding === "conversation"
      ? normalizeSessionRef({
          sessionFile: input.sessionFile,
        })
      : { sessionFile: undefined };
  const logText = safeString(input.logText).trim();

  if (logText) {
    appendChatLog(agentDir, {
      timestamp: nowIso(),
      chatKey,
      role: "assistant",
      text: logText,
      replyToMessageId,
      sessionFile: session.sessionFile,
    });
  }

  return recordDeliveredAssistantMessages(agentDir, {
    chatKey,
    deliveryResult: input.deliveryResult,
    text: input.text,
    rawContent: input.rawContent,
    replyToMessageId,
    sessionFile: session.sessionFile,
    sessionBinding: input.sessionBinding,
  });
}

function localAssetUrl(filePath: string) {
  return toFileUrl(path.resolve(filePath)).href;
}

function summarizeOutgoingParts(parts: ChatMessagePart[]) {
  return parts
    .map((part) => {
      if (part.type === "text" || part.type === "markdown")
        return safeString(part.text).trim();
      if (part.type === "at")
        return `[@] ${safeString(part.name).trim() || safeString(part.id).trim()}`;
      if (part.type === "quote")
        return `[#quote] ${safeString(part.id).trim()}`;
      if (part.type === "image")
        return `[#image] ${safeString(part.path).trim() || safeString(part.url).trim()}`;
      if (part.type === "todo")
        return formatRinTodoChecklistCharacterContent(
          (part.items || []).map((item) => ({
            text: item.text,
            done: Boolean(item.done),
          })),
        );
      return `[#${part.type}] ${safeString((part as any).name).trim() || safeString((part as any).path).trim() || safeString((part as any).url).trim()}`;
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export function sendText(
  app: any,
  chatKey: string,
  text: string,
  h: any,
  replyToMessageId = "",
  options: Record<string, any> = {},
) {
  return sendChatNodes(
    app,
    chatKey,
    withReplyQuote(h, replyToMessageId, [markdownNode(h, safeString(text))]),
    options,
  );
}

export async function sendImageFile(
  app: any,
  chatKey: string,
  filePath: string,
  h: any,
  mimeType = "image/png",
  replyToMessageId = "",
) {
  return await sendChatNodes(
    app,
    chatKey,
    withReplyQuote(h, replyToMessageId, [
      h("image", {
        src: localAssetUrl(filePath),
        mimeType,
      }),
    ]),
  );
}

export async function sendGenericFile(
  app: any,
  chatKey: string,
  filePath: string,
  h: any,
  name?: string,
  replyToMessageId = "",
) {
  return await sendChatNodes(
    app,
    chatKey,
    withReplyQuote(h, replyToMessageId, [
      h("file", {
        src: localAssetUrl(filePath),
        name: name || path.basename(filePath),
      }),
    ]),
  );
}

export async function messagePartToNode(part: ChatMessagePart, h: any) {
  if (part.type === "text") return markdownNode(h, safeString(part.text));
  if (part.type === "markdown") return markdownNode(h, part.text);
  if (part.type === "at") {
    const id = safeString(part.id).trim();
    if (!id) throw new Error("chat_outbox_invalid_part:at");
    return h.at(id, part.name ? { name: part.name } : undefined);
  }
  if (part.type === "quote") return h.quote(part.id);
  if (part.type === "todo") {
    return {
      type: "todo",
      attrs: {
        title: safeString(part.title).trim() || undefined,
        items: (Array.isArray(part.items) ? part.items : [])
          .map((item) => ({
            text: safeString(item?.text).trim(),
            done: Boolean(item?.done),
          }))
          .filter((item) => item.text),
      },
      children: [],
    };
  }
  if (["image", "video", "audio", "sticker"].includes(part.type)) {
    const localPath = safeString((part as any).path).trim();
    const remoteUrl = safeString((part as any).url).trim();
    if (!localPath && !remoteUrl) {
      throw new Error(`chat_outbox_invalid_part:${part.type}`);
    }
    const attrs = {
      src: localPath ? localAssetUrl(localPath) : remoteUrl,
      mimeType:
        safeString((part as any).mimeType).trim() ||
        (part.type === "image" ? "image/png" : undefined),
      name: safeString((part as any).name).trim() || undefined,
    };
    return h(part.type, attrs);
  }
  const filePart = part as Extract<ChatMessagePart, { type: "file" }>;
  const localPath = safeString(filePart.path).trim();
  const remoteUrl = safeString(filePart.url).trim();
  const name =
    safeString(filePart.name).trim() ||
    (localPath ? path.basename(localPath) : undefined);
  if (!localPath && !remoteUrl) {
    throw new Error("chat_outbox_invalid_part:file");
  }
  return h.file(
    localPath ? localAssetUrl(localPath) : remoteUrl,
    safeString(filePart.mimeType).trim() || undefined,
    name ? { name } : undefined,
  );
}

function buildPartsDeliveryRecord(rawParts: ChatMessagePart[]) {
  const quotePart = rawParts.find((part) => part.type === "quote") as
    | { type: "quote"; id: string }
    | undefined;
  const replyToMessageId = safeString(quotePart?.id).trim() || undefined;
  const logText = rawParts
    .map((part) => {
      if (part.type === "text" || part.type === "markdown") {
        return safeString((part as any).text).trim();
      }
      if (part.type === "todo") {
        return formatRinTodoChecklistCharacterContent(
          (part.items || []).map((item) => ({
            text: item.text,
            done: Boolean(item.done),
          })),
        );
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
  const summary = summarizeOutgoingParts(rawParts);
  return {
    replyToMessageId,
    logText,
    text: logText || summary || undefined,
    rawContent: summary || logText || undefined,
  };
}

export function sendOutboxPayload(
  app: any,
  agentDir: string,
  payload: ChatOutboxPayload,
  h: any,
  outboxId = "",
) {
  if (payload?.type === "text_delivery") {
    try {
      const chatKey = normalizeOutboxChatKey(payload.chatKey);
      const text = normalizeOutboxText(payload.text);
      const replyToMessageId = safeString(payload.replyToMessageId).trim();
      const session =
        payload.sessionBinding === "conversation"
          ? normalizeSessionRef(payload)
          : { sessionFile: undefined };
      const deliveryKind = safeString(payload.deliveryKind).trim() || "final";
      const delivery = sendText(app, chatKey, text, h, replyToMessageId, {
        deliveryKind,
        ...(payload.coalesceWithWorkingMessage
          ? { coalesceWithWorkingMessage: true }
          : {}),
        ...(outboxId ? { outboxId } : {}),
      });
      return attachChatDeliveryDispatch(
        delivery.then((deliveryResult) =>
          finalizeDeliveredAssistantOutput(agentDir, {
            chatKey,
            deliveryResult,
            logText: text,
            text,
            rawContent: text,
            replyToMessageId,
            sessionFile: session.sessionFile,
            sessionBinding: payload.sessionBinding,
          }),
        ),
        chatOutboxPayloadUsesAsyncDispatch(payload)
          ? Promise.resolve()
          : undefined,
      );
    } catch (error) {
      return Promise.reject(error) as ChatDeliveryPromise<string[]>;
    }
  }
  if (payload?.type !== "parts_delivery")
    return Promise.resolve([] as string[]);
  const chatKey = normalizeOutboxChatKey(payload.chatKey);
  const session =
    payload.sessionBinding === "conversation"
      ? normalizeSessionRef(payload)
      : { sessionFile: undefined };
  const rawParts = Array.isArray(payload.parts)
    ? payload.parts.filter(Boolean)
    : [];
  let resolveDispatched: () => void = () => {};
  let rejectDispatched: (error: unknown) => void = () => {};
  const dispatched = new Promise<void>((resolve, reject) => {
    resolveDispatched = resolve;
    rejectDispatched = reject;
  });
  const delivery = (async () => {
    try {
      if (!rawParts.length) throw new Error("chat_outbox_empty_message");
      const nodes = (
        await Promise.all(rawParts.map((part) => messagePartToNode(part, h)))
      ).filter(Boolean);
      if (!nodes.length) throw new Error("chat_outbox_empty_message");

      const chatDelivery = sendChatNodes(app, chatKey, nodes, {
        deliveryKind: safeString(payload.deliveryKind).trim() || "final",
        ...(payload.coalesceWithWorkingMessage
          ? { coalesceWithWorkingMessage: true }
          : {}),
        ...(outboxId ? { outboxId } : {}),
      });
      resolveDispatched();
      const deliveryResult = await chatDelivery;

      return finalizeDeliveredAssistantOutput(agentDir, {
        chatKey,
        deliveryResult,
        sessionFile: session.sessionFile,
        sessionBinding: payload.sessionBinding,
        ...buildPartsDeliveryRecord(rawParts),
      });
    } catch (error) {
      rejectDispatched(error);
      throw error;
    }
  })();
  return attachChatDeliveryDispatch(
    delivery,
    chatOutboxPayloadUsesAsyncDispatch(payload) ? dispatched : undefined,
  );
}

export function buildPromptText(text: string, _attachments: SavedAttachment[]) {
  return text;
}

function normalizePositiveInteger(value: unknown, fallback: number) {
  const next = Number(value);
  if (!Number.isFinite(next) || next <= 0) return fallback;
  return Math.floor(next);
}

function dimensionsForMaxEdge(width: number, height: number, maxEdge: number) {
  const longEdge = Math.max(width, height);
  if (!longEdge || longEdge <= maxEdge) return { width, height };
  const scale = maxEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function jpegBytesFor(image: PhotonImage, quality: number) {
  return Buffer.from(image.get_bytes_jpeg(quality));
}

function maybeKeepBestCandidate(
  best: Buffer | null,
  candidate: Buffer,
  originalSize: number,
) {
  if (candidate.length >= originalSize) return best;
  if (!best || candidate.length < best.length) return candidate;
  return best;
}

export function compressImageForModelPayload(
  data: Buffer,
  options: ModelImageCompressionOptions = {},
) {
  const maxBytes = normalizePositiveInteger(
    options.maxBytes,
    MODEL_IMAGE_MAX_BYTES,
  );
  if (!options.force && data.length <= maxBytes) {
    return { data, mimeType: "" };
  }

  const maxEdge = normalizePositiveInteger(
    options.maxEdge,
    MODEL_IMAGE_MAX_EDGE,
  );
  const minEdge = Math.min(
    maxEdge,
    normalizePositiveInteger(options.minEdge, MODEL_IMAGE_MIN_EDGE),
  );
  let source: PhotonImage | null = null;
  let best: Buffer | null = null;

  try {
    source = base64ToPhotonImage(data.toString("base64"));
    const sourceWidth = source.get_width();
    const sourceHeight = source.get_height();
    const sourceLongEdge = Math.max(sourceWidth, sourceHeight);
    let targetLongEdge = Math.min(sourceLongEdge, maxEdge);

    while (targetLongEdge >= minEdge) {
      const target = dimensionsForMaxEdge(
        sourceWidth,
        sourceHeight,
        targetLongEdge,
      );
      const resized =
        target.width === sourceWidth && target.height === sourceHeight
          ? source
          : resizePhotonImage(
              source,
              target.width,
              target.height,
              SamplingFilter.Lanczos3,
            );

      try {
        for (const quality of MODEL_IMAGE_JPEG_QUALITIES) {
          const candidate = jpegBytesFor(resized, quality);
          best = maybeKeepBestCandidate(best, candidate, data.length);
          if (candidate.length <= maxBytes) {
            return { data: candidate, mimeType: "image/jpeg" };
          }
        }
      } finally {
        if (resized !== source) resized.free();
      }

      const nextLongEdge = Math.floor(targetLongEdge * 0.75);
      if (nextLongEdge >= targetLongEdge) break;
      targetLongEdge = nextLongEdge;
    }
  } catch {
    return { data, mimeType: "" };
  } finally {
    source?.free();
  }

  if (best) return { data: best, mimeType: "image/jpeg" };
  return { data, mimeType: "" };
}

export async function attachmentToImageContent(
  filePath: string,
  mimeType = "image/png",
  options: ModelImageCompressionOptions = {},
): Promise<ImageContent> {
  const data = await fs.promises.readFile(filePath);
  const compressed = compressImageForModelPayload(data, options);
  return {
    type: "image",
    data: compressed.data.toString("base64"),
    mimeType: compressed.mimeType || mimeType,
  };
}

export async function restorePromptParts(processing: ChatPromptRestoreInput) {
  const attachments = (processing.attachments || []).filter(
    (item) => item && fs.existsSync(item.path),
  );
  const text = buildPromptText(processing.text, attachments);
  return { text, images: [], attachments };
}
