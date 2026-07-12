import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import { Api as GrammyApi, InputFile } from "grammy";
import { Agent as UndiciAgent } from "undici";
import WebSocket from "ws";

import { getWorkingReactionFrame } from "../../chat/transport.js";
import { enqueueChatInboxItem } from "../../chat/inbox.js";
import { getChatId, pickMessageId } from "../../chat/chat-helpers.js";
import {
  getChatBridgeAdapterSpec,
  type ChatBridgeBuiltInAdapterKey,
} from "../../chat-bridge/adapters.js";
import { composeChatKeyForBot } from "../../chat/support.js";
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
} from "../common.js";
import { EditableTextMessageGroup } from "../editable-text-message-group.js";

import {
  ChatRuntimeApp,
  toSnakeCase,
  isTelegramMediaNodeType,
  telegramMediaMethod,
  TELEGRAM_CHAT_THREAD_MARKER,
  encodeTelegramThreadId,
  decodeTelegramThreadId,
  splitTelegramChatThread,
  telegramThreadPayload,
  isTextLikeNode,
  displayNameFromTelegramUser,
  parseTelegramReplyQuote,
  parseOneBotReplyQuote,
  pickOneBotForwardId,
  oneBotForwardNodeAuthor,
  oneBotForwardNodeText,
  oneBotForwardMessages,
  renderOneBotForwardContent,
  TELEGRAM_MAX_TEXT_LENGTH,
  TELEGRAM_MAX_CAPTION_LENGTH,
  isTelegramPhotoDimensionError,
  createNodeBuilder,
  partialChatDeliveryError,
} from "../runtime-app.js";

export const TELEGRAM_ZERO_PAYLOAD_METHODS = new Set([
  "getMe",
  "getWebhookInfo",
  "getForumTopicIconStickers",
  "getAvailableGifts",
  "logOut",
  "close",
  "getMyStarBalance",
  "removeMyProfilePhoto",
]);

export function translateAbortSignal(signal: any) {
  if (!signal || typeof signal.addEventListener !== "function") {
    return undefined;
  }
  const controller = new AbortController();
  if (signal.aborted) {
    controller.abort();
  } else {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

export class TelegramAdapter {
  private readonly app: ChatRuntimeApp;
  private readonly config: Record<string, any>;
  private readonly logger: any;
  private readonly cacheDir: string;
  private readonly cursorPath: string;
  private readonly editableWorking: EditableTextMessageGroup;
  private pollAbort: AbortController | null = null;
  private running = false;
  private pollPromise: Promise<void> | null = null;
  private nextOffset = 0;
  private readonly pollDispatcher = new UndiciAgent({ connections: 1 });
  private readonly apiDispatcher = new UndiciAgent({ connections: 8 });
  private readonly pollApi: GrammyApi;
  private readonly api: GrammyApi;
  private readonly workingReactions = new Map<string, string>();
  private readonly botCacheKey: string;
  readonly bot: any;

  constructor(
    app: ChatRuntimeApp,
    dataDir: string,
    config: Record<string, any>,
    logger: any,
  ) {
    this.app = app;
    this.config = config;
    this.logger = createPrefixedLogger("chat-runtime:telegram", logger);
    this.cacheDir = path.join(dataDir, "chat", "runtime-cache", "telegram");
    this.botCacheKey =
      safeString(config?.token)
        .trim()
        .split(":")[0]
        ?.replace(/[^A-Za-z0-9._-]+/g, "_") || "default";
    this.cursorPath = path.join(
      dataDir,
      "chat",
      "runtime-state",
      "telegram",
      this.botCacheKey,
      "cursor.json",
    );
    ensureDir(this.cacheDir);
    this.pollApi = this.createApi(this.pollDispatcher);
    this.api = this.createApi(this.apiDispatcher);
    this.editableWorking = new EditableTextMessageGroup({
      cacheDir: this.cacheDir,
      cacheScope: this.botCacheKey,
      maxTextLength: 4096,
      agentDir: app?.agentDir,
      chunkText: (text) => this.telegramTextChunks(text),
      sendText: async ({ chatId, text, replyToMessageId }) =>
        await this.sendText(chatId, text, replyToMessageId, "HTML"),
      editText: async ({ chatId, messageId, text }) =>
        await this.editText(chatId, messageId, text, "HTML"),
      deleteMessage: async ({ chatId, messageId }) => {
        const target = splitTelegramChatThread(chatId);
        await this.callApi("deleteMessage", {
          chat_id: target.chatId,
          message_id: Number(messageId),
        });
      },
      isRecoverableEditError: (error) =>
        this.isRecoverableWorkingMessageEditError(error),
    });
    this.bot = {
      platform: "telegram",
      selfId: "",
      status: 0,
      username: "",
      name: "",
      user: {},
      workingIndicators: [
        {
          type: "polling",
          presentation: "editable-message",
          tick: async (context: any) =>
            await this.tickWorkingIndicator(context),
          end: async (context: any) => await this.endWorkingIndicator(context),
        },
        {
          type: "polling",
          presentation: "typing",
          tick: async (context: any) => await this.tickTypingIndicator(context),
        },
      ],
      internal: new Proxy(
        {
          callApi: (method: string, payload?: any) =>
            this.callApi(method, payload),
        },
        {
          get: (target, property) => {
            if (typeof property !== "string") return undefined;
            if (property in target) return (target as any)[property];
            return async (payload?: any) => this.callApi(property, payload);
          },
        },
      ),
      sendMessage: async (chatId: string, content: any, options?: any) =>
        await this.sendMessage(chatId, content, options),
      createReaction: async (
        chatId: string,
        messageId: string,
        emoji: string,
      ) => await this.createReaction(chatId, messageId, emoji),
      deleteReaction: async (
        chatId: string,
        messageId: string,
        emoji?: string,
        userId?: string,
      ) => await this.deleteReaction(chatId, messageId, emoji, userId),
      getGuild: async (chatId: string) =>
        await this.callApi("getChat", { chat_id: chatId }),
      getGuildMember: async (chatId: string, userId: string) =>
        await this.callApi("getChatMember", {
          chat_id: chatId,
          user_id: userId,
        }),
    };
    this.app.register(this, this.bot);
  }

  async start() {
    if (this.running) return;
    const token = safeString(this.config?.token).trim();
    if (!token) throw new Error("telegram_token_required");
    this.running = true;
    await this.bootstrap();
    this.pollPromise = this.pollLoop();
  }

  async stop() {
    this.running = false;
    this.pollAbort?.abort();
    this.pollAbort = null;
    try {
      await this.pollPromise;
    } catch {}
    this.pollPromise = null;
    emitBotStatus(this.app, this.bot, 0);
  }

  private fileUrl(filePath: string) {
    return `https://api.telegram.org/file/bot${safeString(this.config?.token).trim()}/${filePath}`;
  }

  private loadCursor() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.cursorPath, "utf8"));
      const nextOffset = Number(raw?.nextOffset);
      if (Number.isFinite(nextOffset) && nextOffset > 0) {
        this.nextOffset = nextOffset;
      }
    } catch {}
  }

  private saveCursor() {
    try {
      ensureDir(path.dirname(this.cursorPath));
      fs.writeFileSync(
        this.cursorPath,
        `${JSON.stringify({ nextOffset: this.nextOffset }, null, 2)}\n`,
        "utf8",
      );
    } catch {}
  }

  private async bootstrap() {
    this.loadCursor();
    try {
      await this.callApi("deleteWebhook", { drop_pending_updates: false });
    } catch {}
    const me = await this.callApi("getMe", {});
    const selfId = safeString(me?.id).trim();
    this.bot.selfId = selfId;
    this.bot.username = safeString(me?.username).trim();
    this.bot.name = displayNameFromTelegramUser(me);
    this.bot.user = {
      id: selfId,
      userId: selfId,
      username: this.bot.username,
      name: this.bot.name,
      nick: this.bot.name,
    };
    emitBotStatus(this.app, this.bot, 1);
  }

  private createApi(dispatcher: UndiciAgent) {
    return new GrammyApi(safeString(this.config?.token).trim(), {
      fetch: ((url: any, init?: any) =>
        fetch(url, {
          ...(init || {}),
          signal: translateAbortSignal(init?.signal),
          dispatcher,
          duplex: init?.body ? "half" : undefined,
        } as any)) as any,
    });
  }

  private async callApi(method: string, payload?: any, signal?: AbortSignal) {
    const client = method === "getUpdates" ? this.pollApi : this.api;
    const fn = (client.raw as any)[method];
    if (typeof fn !== "function") {
      throw new Error(`telegram_api_method_missing:${method}`);
    }
    if (TELEGRAM_ZERO_PAYLOAD_METHODS.has(method)) {
      return await fn(signal);
    }
    return await fn(payload || {}, signal);
  }

  private async pollLoop() {
    while (this.running) {
      const abort = new AbortController();
      this.pollAbort = abort;
      try {
        const updates = await this.callApi(
          "getUpdates",
          {
            offset: this.nextOffset,
            timeout: 25,
            allowed_updates: [
              "message",
              "edited_message",
              "channel_post",
              "edited_channel_post",
            ],
          },
          abort.signal,
        );
        for (const update of Array.isArray(updates) ? updates : []) {
          const updateId = Number(update?.update_id);
          await this.handleUpdate(update);
          if (Number.isFinite(updateId)) {
            this.nextOffset = Math.max(this.nextOffset, updateId + 1);
            this.saveCursor();
          }
        }
      } catch (error: any) {
        if (!this.running) break;
        const detail = safeString(error?.message || error).trim();
        if (detail && detail !== "This operation was aborted") {
          this.logger.warn(`poll failed err=${detail}`);
        }
        await sleep(3000);
      } finally {
        if (this.pollAbort === abort) this.pollAbort = null;
      }
    }
  }

  private parseMention(content: string, entities: any[]) {
    const username = safeString(this.bot?.username).trim().replace(/^@+/, "");
    const selfId = safeString(this.bot?.selfId).trim();
    if (!content) return { appel: false, content: "" };
    const removeRanges: Array<{ start: number; end: number }> = [];
    let appel = false;
    for (const entity of entities) {
      const type = safeString(entity?.type).trim();
      const offset = Number(entity?.offset);
      const length = Number(entity?.length);
      if (!Number.isFinite(offset) || !Number.isFinite(length) || length <= 0)
        continue;
      const text = content.slice(offset, offset + length);
      if (type === "mention") {
        const mention = text.trim().replace(/^@+/, "").toLowerCase();
        if (username && mention === username.toLowerCase()) {
          appel = true;
          removeRanges.push({ start: offset, end: offset + length });
        }
      }
      if (type === "text_mention") {
        const userId = safeString(entity?.user?.id).trim();
        if (selfId && userId === selfId) {
          appel = true;
          removeRanges.push({ start: offset, end: offset + length });
        }
      }
    }
    if (!appel) return { appel: false, content: content.trim() };
    const sorted = removeRanges.sort((a, b) => a.start - b.start);
    let cursor = 0;
    let stripped = "";
    for (const range of sorted) {
      stripped += content.slice(cursor, range.start);
      cursor = range.end;
    }
    stripped += content.slice(cursor);
    return {
      appel: true,
      content: stripped.replace(/^[\s,:，\-—]+/, "").trim() || content.trim(),
    };
  }

  private async cacheFile(options: {
    fileId: string;
    uniqueId?: string;
    mimeType?: string;
    name?: string;
  }) {
    const file = await this.callApi("getFile", { file_id: options.fileId });
    const filePath = safeString(file?.file_path).trim();
    if (!filePath) return null;
    const response = await fetch(this.fileUrl(filePath), {
      dispatcher: this.apiDispatcher,
    } as any);
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    const originalName = ensureFileName(
      options.name || path.basename(filePath),
      "telegram-file",
    );
    const finalName = ensureExtension(
      originalName,
      safeString(options.mimeType).trim(),
    );
    const stamp = `${Date.now()}-${safeString(
      options.uniqueId || options.fileId,
    )
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .slice(0, 80)}`;
    const fullPath = path.join(this.cacheDir, `${stamp}-${finalName}`);
    await fs.promises.writeFile(fullPath, buffer);
    return {
      path: fullPath,
      mimeType: safeString(options.mimeType).trim() || undefined,
      name: finalName,
    };
  }

  private async buildElements(message: any, strippedContent: string) {
    const elements: any[] = [];
    if (strippedContent) {
      elements.push(normalizeNode("text", { content: strippedContent }));
    }
    const photos = Array.isArray(message?.photo) ? message.photo : [];
    if (photos.length) {
      const photo = photos[photos.length - 1];
      const cached = await this.cacheFile({
        fileId: safeString(photo?.file_id).trim(),
        uniqueId: safeString(photo?.file_unique_id).trim(),
        mimeType: "image/jpeg",
        name: `telegram-photo-${safeString(message?.message_id).trim() || "message"}.jpg`,
      });
      if (cached) {
        elements.push(
          normalizeNode("image", {
            src: fileUrl(cached.path),
            mime: cached.mimeType,
            mimeType: cached.mimeType,
            name: cached.name,
          }),
        );
      }
    }
    const mediaCandidates = [
      { source: message?.sticker, type: "sticker", fallbackMime: "image/webp" },
      { source: message?.video, type: "video", fallbackMime: "video/mp4" },
      { source: message?.animation, type: "video", fallbackMime: "video/mp4" },
      { source: message?.audio, type: "audio", fallbackMime: "audio/mpeg" },
      { source: message?.voice, type: "audio", fallbackMime: "audio/ogg" },
      {
        source: message?.document,
        type: "file",
        fallbackMime: "application/octet-stream",
      },
    ];
    for (const candidate of mediaCandidates) {
      const media = candidate.source;
      if (!media || typeof media !== "object") continue;
      const mimeType =
        safeString(media?.mime_type).trim() || candidate.fallbackMime;
      const cached = await this.cacheFile({
        fileId: safeString(media?.file_id).trim(),
        uniqueId: safeString(media?.file_unique_id).trim(),
        mimeType,
        name:
          safeString(media?.file_name).trim() ||
          safeString(media?.emoji).trim() ||
          undefined,
      });
      if (!cached) continue;
      const nodeType =
        candidate.type === "file" && mimeType.startsWith("image/")
          ? "image"
          : candidate.type;
      elements.push(
        normalizeNode(nodeType, {
          src: fileUrl(cached.path),
          mime: cached.mimeType,
          mimeType: cached.mimeType,
          name: cached.name,
        }),
      );
    }
    return elements;
  }

  private async buildSession(update: any, message: any) {
    const chat =
      message?.chat && typeof message.chat === "object" ? message.chat : {};
    const author =
      message?.from && typeof message.from === "object" ? message.from : {};
    const chatType = safeString(chat?.type).trim();
    const isDirect = chatType === "private";
    const content = safeString(message?.text || message?.caption || "").trim();
    const entities = Array.isArray(message?.entities)
      ? message.entities
      : Array.isArray(message?.caption_entities)
        ? message.caption_entities
        : [];
    const mention = this.parseMention(content, entities);
    const strippedContent = mention.content || content;
    const elements = await this.buildElements(message, strippedContent);
    const userId = safeString(author?.id).trim();
    const name = displayNameFromTelegramUser(author);
    const chatId = safeString(chat?.id).trim();
    const messageThreadId = safeString(message?.message_thread_id).trim();
    return {
      platform: "telegram",
      selfId: safeString(this.bot?.selfId).trim(),
      bot: this.bot,
      messageId: safeString(message?.message_id).trim(),
      timestamp: Number.isFinite(Number(message?.date))
        ? Number(message.date) * 1000
        : Date.now(),
      userId,
      author: {
        userId,
        name,
        nick: name,
        username: safeString(author?.username).trim() || undefined,
      },
      user: {
        userId,
        id: userId,
        name,
        nick: name,
        username: safeString(author?.username).trim() || undefined,
      },
      channelId: chatId,
      messageThreadId: messageThreadId || undefined,
      chatThreadId: messageThreadId || undefined,
      isTopicMessage: Boolean(message?.is_topic_message),
      channelName: !isDirect
        ? safeString(chat?.title).trim() || undefined
        : undefined,
      guildId: !isDirect ? chatId : undefined,
      guildName: !isDirect
        ? safeString(chat?.title).trim() || undefined
        : undefined,
      isDirect,
      content,
      stripped: {
        appel: mention.appel,
        content: strippedContent,
      },
      elements,
      quote: parseTelegramReplyQuote(message),
      telegram: update,
    };
  }

  private async handleUpdate(update: any) {
    const message =
      update?.message ||
      update?.edited_message ||
      update?.channel_post ||
      update?.edited_channel_post;
    if (!message || typeof message !== "object") return;
    const session = await this.buildSession(update, message);
    if (!safeString(session?.messageId).trim()) return;
    this.app.emit("message", session);
  }

  private async sendText(
    chatId: string,
    text: string,
    replyToMessageId?: string,
    parseMode?: string,
    options: { messageThreadId?: unknown; threadId?: unknown } = {},
  ) {
    const target = splitTelegramChatThread(
      chatId,
      options?.messageThreadId || options?.threadId,
    );
    const payload = compactObject({
      chat_id: target.chatId,
      ...telegramThreadPayload(target.messageThreadId),
      text,
      parse_mode: safeString(parseMode).trim() || undefined,
      reply_to_message_id: replyToMessageId,
    });
    try {
      const result = await this.callApi("sendMessage", payload);
      return safeString(result?.message_id).trim();
    } catch (error) {
      if (!payload.parse_mode) throw error;
      const result = await this.callApi(
        "sendMessage",
        compactObject({
          chat_id: target.chatId,
          ...telegramThreadPayload(target.messageThreadId),
          text: renderPlainTextFromNodes([
            { type: "html", attrs: { content: text } },
          ]),
          reply_to_message_id: replyToMessageId,
        }),
      );
      return safeString(result?.message_id).trim();
    }
  }

  private async editText(
    chatId: string,
    messageId: string,
    text: string,
    parseMode?: string,
  ) {
    const target = splitTelegramChatThread(chatId);
    const payload = compactObject({
      chat_id: target.chatId,
      message_id: Number(messageId),
      text,
      parse_mode: safeString(parseMode).trim() || undefined,
    });
    try {
      await this.callApi("editMessageText", payload);
      return safeString(messageId).trim();
    } catch (error) {
      if (
        /message is not modified/i.test(
          safeString((error as any)?.message || error),
        )
      ) {
        return safeString(messageId).trim();
      }
      if (!payload.parse_mode) throw error;
      await this.callApi(
        "editMessageText",
        compactObject({
          chat_id: target.chatId,
          message_id: Number(messageId),
          text: renderPlainTextFromNodes([
            { type: "html", attrs: { content: text } },
          ]),
        }),
      );
      return safeString(messageId).trim();
    }
  }

  private async sendBinaryMessage(
    method:
      | "sendPhoto"
      | "sendDocument"
      | "sendVideo"
      | "sendAudio"
      | "sendSticker",
    field: "photo" | "document" | "video" | "audio" | "sticker",
    chatId: string,
    node: any,
    caption: string,
    replyToMessageId?: string,
    parseMode?: string,
    options: { messageThreadId?: unknown; threadId?: unknown } = {},
  ) {
    const target = splitTelegramChatThread(
      chatId,
      options?.messageThreadId || options?.threadId,
    );
    const payload = await readBinaryFromNode(node);
    if (!payload) {
      throw new Error(`telegram_media_source_missing:${field}`);
    }
    const sendPayload = async (
      nextMethod: typeof method,
      nextField: typeof field,
    ) => {
      if (payload.url) {
        const result = await this.callApi(
          nextMethod,
          compactObject({
            chat_id: target.chatId,
            ...telegramThreadPayload(target.messageThreadId),
            [nextField]: payload.url,
            caption: caption || undefined,
            parse_mode: safeString(parseMode).trim() || undefined,
            reply_to_message_id: replyToMessageId,
          }),
        );
        return safeString(result?.message_id).trim();
      }
      const result = await this.callApi(
        nextMethod,
        compactObject({
          chat_id: target.chatId,
          ...telegramThreadPayload(target.messageThreadId),
          [nextField]: new InputFile(payload.data, payload.name),
          caption: caption || undefined,
          parse_mode: safeString(parseMode).trim() || undefined,
          reply_to_message_id: replyToMessageId,
        }),
      );
      return safeString(result?.message_id).trim();
    };

    try {
      return await sendPayload(method, field);
    } catch (error) {
      if (method === "sendPhoto" && isTelegramPhotoDimensionError(error)) {
        return sendPayload("sendDocument", "document");
      }
      throw error;
    }
  }

  private async sendFailurePlaceholder(
    chatId: string,
    placeholder: string,
    replyToMessageId?: string,
  ) {
    if (!placeholder) return "";
    try {
      return await this.sendText(chatId, placeholder, replyToMessageId);
    } catch (placeholderError: any) {
      this.logger.warn(
        `rich failure placeholder failed err=${safeString(placeholderError?.message || placeholderError)}`,
      );
      return "";
    }
  }

  private telegramTextChunks(text: string) {
    return splitPlainText(text, TELEGRAM_MAX_TEXT_LENGTH).filter(Boolean);
  }

  private workingMessageKey(chatId: string, messageId: string) {
    return `${chatId}:${safeString(messageId).trim() || "chat"}`;
  }

  private isRecoverableWorkingMessageEditError(error: unknown) {
    const message = safeString((error as any)?.message || error).trim();
    return /message to edit not found|message can't be edited|message identifier is not specified/i.test(
      message,
    );
  }

  private async deleteVisibleWorkingMessage(
    chatId: string,
    markFinalizing = false,
  ) {
    const target = splitTelegramChatThread(chatId);
    return await this.editableWorking.deleteProgress(
      target.scopedChatId,
      undefined,
      this.workingMessageKey(target.scopedChatId, "chat"),
      { markFinalizing },
    );
  }

  private async updateWorkingMessage(input: {
    chatId?: string;
    text?: string;
    replyToMessageId?: string;
    key?: string;
    kind?: string;
    todoText?: string;
  }) {
    const todoText = safeString(input?.todoText).trim();
    const ids = await this.editableWorking.updateText({
      chatId: safeString(input?.chatId).trim(),
      text: safeString(input?.text),
      replyToMessageId: safeString(input?.replyToMessageId).trim() || undefined,
      key: safeString(input?.key).trim() || undefined,
      kind: safeString(input?.kind).trim() || undefined,
      todoTextChunks: todoText
        ? [renderTelegramHtmlFromNodes([{ type: "markdown", text: todoText }])]
        : [],
    });
    return ids[0] || "";
  }

  private async updateWorkingMessageGroup(input: {
    chatId?: string;
    textChunks?: string[];
    replyToMessageId?: string;
    key?: string;
    kind?: string;
  }) {
    return await this.editableWorking.updateText({
      chatId: safeString(input?.chatId).trim(),
      textChunks: (input?.textChunks || []).map((item) => safeString(item)),
      replyToMessageId: safeString(input?.replyToMessageId).trim() || undefined,
      key: safeString(input?.key).trim() || undefined,
      kind: safeString(input?.kind).trim() || undefined,
    });
  }

  async sendMessage(
    chatId: string,
    content: any,
    options: Record<string, any> = {},
  ) {
    const target = splitTelegramChatThread(
      chatId,
      options?.messageThreadId || options?.threadId,
    );
    const deliveryChatId = target.scopedChatId || chatId;
    const deliveryKind = safeString(options?.deliveryKind).trim() || "final";
    const isFinalDelivery = deliveryKind === "final";
    const { work, replyToMessageId } = prepareOutboundNodes(content);
    const delivered: string[] = [];
    const failures: unknown[] = [];
    let cursor = 0;
    let firstReply = replyToMessageId;
    let finalizedWorkingMessage = false;
    const ensureFinalProgressCleared = async () => {
      if (!isFinalDelivery || finalizedWorkingMessage) return;
      await this.deleteVisibleWorkingMessage(deliveryChatId, true);
      finalizedWorkingMessage = true;
    };
    const recordFailure = async (error: unknown, placeholder: string) => {
      failures.push(error);
      this.logger.warn(
        `rich message segment failed err=${safeString((error as any)?.message || error)}`,
      );
      await ensureFinalProgressCleared();
      const placeholderId = await this.sendFailurePlaceholder(
        deliveryChatId,
        placeholder,
        firstReply,
      );
      if (placeholderId) {
        delivered.push(placeholderId);
        firstReply = undefined;
      }
    };

    while (cursor < work.length) {
      const node = work[cursor];
      const type = safeString(node?.type).toLowerCase();
      if (isTelegramMediaNodeType(type)) {
        const media = telegramMediaMethod(type);
        try {
          await ensureFinalProgressCleared();
          const messageId = await this.sendBinaryMessage(
            media.method as any,
            media.field as any,
            deliveryChatId,
            node,
            "",
            firstReply,
          );
          if (messageId) delivered.push(messageId);
          firstReply = undefined;
        } catch (error) {
          await recordFailure(error, renderRichDeliveryErrorPlaceholder(error));
        }
        cursor += 1;
        continue;
      }
      const textNodes: any[] = [];
      let nextCursor = cursor;
      while (nextCursor < work.length) {
        const candidate = work[nextCursor];
        const candidateType = safeString(candidate?.type).toLowerCase();
        if (isTelegramMediaNodeType(candidateType)) break;
        textNodes.push(candidate);
        nextCursor += 1;
      }
      let text = "";
      try {
        text = renderTelegramHtmlFromNodes(textNodes);
      } catch (error) {
        await recordFailure(error, renderRichDeliveryErrorPlaceholder(error));
      }
      const textChunks = this.telegramTextChunks(text);
      if (textChunks.length) {
        try {
          const coalesceWithWorkingMessage = Boolean(
            options?.coalesceWithWorkingMessage,
          );
          const deliveryKey =
            deliveryKind === "passive_notice"
              ? this.workingMessageKey(
                  deliveryChatId,
                  coalesceWithWorkingMessage ? "chat" : "passive_notice",
                )
              : this.workingMessageKey(deliveryChatId, "chat");
          const shouldEditWorkingMessage =
            delivered.length === 0 &&
            isEditableProgressDeliveryKind(deliveryKind);
          const messageIds = shouldEditWorkingMessage
            ? await this.updateWorkingMessageGroup({
                chatId: deliveryChatId,
                textChunks,
                replyToMessageId: firstReply,
                // Working indicators, interim text, and coalesced todo notices
                // share one editable Telegram message with three regions:
                // working, content, then optional todo. Final replies clear that
                // progress artifact and are delivered as fresh messages.
                // Non-coalesced passive notices stay isolated on the passive_notice key.
                key: deliveryKey,
                kind:
                  deliveryKind === "passive_notice"
                    ? "todo"
                    : deliveryKind === "interim"
                      ? "interim"
                      : undefined,
              })
            : [];
          if (shouldEditWorkingMessage) {
            delivered.push(...messageIds);
            if (isFinalDelivery) finalizedWorkingMessage = true;
          } else {
            await ensureFinalProgressCleared();
            for (const textChunk of textChunks) {
              const messageId = await this.sendText(
                deliveryChatId,
                textChunk,
                firstReply,
                "HTML",
              );
              if (messageId) delivered.push(messageId);
              firstReply = undefined;
            }
          }
          firstReply = undefined;
        } catch (error) {
          await recordFailure(error, renderRichDeliveryErrorPlaceholder(error));
        }
      }
      cursor = nextCursor;
    }
    if (isFinalDelivery && !finalizedWorkingMessage) {
      await this.deleteVisibleWorkingMessage(deliveryChatId);
    }
    if (delivered.length) return delivered;
    if (failures.length) throw failures[0];
    throw new Error("telegram_send_message_empty");
  }

  private workingMessageText(context: any) {
    const copy = resolveChatRuntimeWorkingCopy(this.app?.agentDir);
    return editableWorkingText(context?.tick, copy.frames);
  }

  async tickTypingIndicator(context: any) {
    const target = splitTelegramChatThread(
      context?.chatId,
      context?.messageThreadId || context?.threadId,
    );
    if (!target.chatId) return false;
    await this.callApi("sendChatAction", {
      chat_id: target.chatId,
      ...telegramThreadPayload(target.messageThreadId),
      action: "typing",
    });
    return true;
  }

  async tickWorkingIndicator(context: any) {
    const target = splitTelegramChatThread(
      context?.chatId,
      context?.messageThreadId || context?.threadId,
    );
    const chatId = target.scopedChatId;
    if (!target.chatId) return false;
    const sourceMessageId = safeString(context?.messageId).trim();
    const replyToMessageId = safeString(
      context?.replyToMessageId || sourceMessageId,
    ).trim();
    const key = this.workingMessageKey(chatId, "chat");
    await this.updateWorkingMessage({
      chatId,
      text: renderTelegramHtmlFromNodes([
        { type: "text", text: this.workingMessageText(context) },
      ]),
      todoText: context?.todoNoticeText,
      replyToMessageId: replyToMessageId || undefined,
      // This is the same key used by coalesced todo notices and final replies.
      key,
      kind: "working",
    });
    return true;
  }

  async endWorkingIndicator(context: any) {
    const target = splitTelegramChatThread(
      context?.chatId,
      context?.messageThreadId || context?.threadId,
    );
    if (!target.chatId) return false;
    return await this.deleteVisibleWorkingMessage(target.scopedChatId);
  }

  async createReaction(chatId: string, messageId: string, emoji: string) {
    const target = splitTelegramChatThread(chatId);
    await this.callApi("setMessageReaction", {
      chat_id: target.chatId,
      message_id: Number(messageId),
      reaction: [{ type: "emoji", emoji }],
    });
    return true;
  }

  async deleteReaction(
    chatId: string,
    messageId: string,
    _emoji?: string,
    _userId?: string,
  ) {
    const target = splitTelegramChatThread(chatId);
    await this.callApi("setMessageReaction", {
      chat_id: target.chatId,
      message_id: Number(messageId),
      reaction: [],
    });
    return true;
  }
}
