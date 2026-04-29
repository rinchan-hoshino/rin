import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import WebSocket from "ws";

import { enqueueChatInboxItem } from "../chat/inbox.js";
import { getChatId, pickMessageId } from "../chat/chat-helpers.js";
import {
  getChatBridgeAdapterSpec,
  type ChatBridgeBuiltInAdapterKey,
} from "../chat-bridge/adapters.js";
import { composeChatKey } from "../chat/support.js";
import {
  compactObject,
  createPrefixedLogger,
  emitBotStatus,
  ensureDir,
  ensureExtension,
  ensureFileName,
  fileUrl,
  normalizeNode,
  prepareOutboundNodes,
  readBinaryFromNode,
  renderPlainTextFromNodes,
  renderTelegramHtmlFromNodes,
  safeString,
  sleep,
  splitPlainText,
} from "./common.js";
import {
  DiscordAdapter,
  LarkAdapter,
  MinecraftAdapter,
  QQAdapter,
  SlackAdapter,
} from "./extra-adapters.js";

function toSnakeCase(value: string) {
  return safeString(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

function isTelegramMediaNodeType(type: string) {
  return ["image", "file", "video", "audio", "sticker"].includes(type);
}

function telegramMediaMethod(type: string) {
  if (type === "image") return { method: "sendPhoto", field: "photo" };
  if (type === "video") return { method: "sendVideo", field: "video" };
  if (type === "audio") return { method: "sendAudio", field: "audio" };
  if (type === "sticker") return { method: "sendSticker", field: "sticker" };
  return { method: "sendDocument", field: "document" };
}

function isTextLikeNode(node: any) {
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

function displayNameFromTelegramUser(user: any) {
  return (
    safeString(user?.username).trim() ||
    [safeString(user?.first_name).trim(), safeString(user?.last_name).trim()]
      .filter(Boolean)
      .join(" ")
      .trim()
  );
}

function parseTelegramReplyQuote(message: any) {
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

function parseOneBotReplyQuote(data: Record<string, any>) {
  const messageId =
    safeString(data?.id || data?.message_id || "").trim() || undefined;
  if (!messageId) return undefined;
  return { messageId };
}

const TELEGRAM_MAX_TEXT_LENGTH = 4096;
const TELEGRAM_MAX_CAPTION_LENGTH = 1024;

function createNodeBuilder() {
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
    const chatKey = composeChatKey(platform, chatId, botId);
    if (!chatKey) return;
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

class TelegramAdapter {
  private readonly app: ChatRuntimeApp;
  private readonly config: Record<string, any>;
  private readonly logger: any;
  private readonly cacheDir: string;
  private readonly cursorPath: string;
  private pollAbort: AbortController | null = null;
  private running = false;
  private pollPromise: Promise<void> | null = null;
  private nextOffset = 0;
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
    this.cacheDir = path.join(dataDir, "chat-runtime-cache", "telegram");
    const cursorKey =
      safeString(config?.token)
        .trim()
        .split(":")[0]
        ?.replace(/[^A-Za-z0-9._-]+/g, "_") || "default";
    this.cursorPath = path.join(
      dataDir,
      "chat-runtime-state",
      "telegram",
      cursorKey,
      "cursor.json",
    );
    ensureDir(this.cacheDir);
    this.bot = {
      platform: "telegram",
      selfId: "",
      status: 0,
      username: "",
      name: "",
      user: {},
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
      sendMessage: async (chatId: string, content: any) =>
        await this.sendMessage(chatId, content),
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

  private apiUrl(method: string) {
    return `https://api.telegram.org/bot${safeString(this.config?.token).trim()}/${method}`;
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

  private async callApi(method: string, payload?: any, signal?: AbortSignal) {
    const response = await fetch(this.apiUrl(method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload || {}),
      signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body?.ok) {
      const detail = safeString(
        body?.description || response.statusText || method,
      ).trim();
      throw new Error(detail || `telegram_api_failed:${method}`);
    }
    return body.result;
  }

  private async callMultipart(method: string, build: (form: FormData) => void) {
    const form = new FormData();
    build(form);
    const response = await fetch(this.apiUrl(method), {
      method: "POST",
      body: form,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body?.ok) {
      const detail = safeString(
        body?.description || response.statusText || method,
      ).trim();
      throw new Error(detail || `telegram_api_failed:${method}`);
    }
    return body.result;
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
    const response = await fetch(this.fileUrl(filePath));
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
  ) {
    const payload = compactObject({
      chat_id: chatId,
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
          chat_id: chatId,
          text: renderPlainTextFromNodes([
            { type: "html", attrs: { content: text } },
          ]),
          reply_to_message_id: replyToMessageId,
        }),
      );
      return safeString(result?.message_id).trim();
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
  ) {
    const payload = await readBinaryFromNode(node);
    if (!payload) {
      throw new Error(`telegram_media_source_missing:${field}`);
    }
    if (payload.url) {
      const result = await this.callApi(
        method,
        compactObject({
          chat_id: chatId,
          [field]: payload.url,
          caption: caption || undefined,
          parse_mode: safeString(parseMode).trim() || undefined,
          reply_to_message_id: replyToMessageId,
        }),
      );
      return safeString(result?.message_id).trim();
    }
    const result = await this.callMultipart(method, (form) => {
      form.append("chat_id", safeString(chatId));
      if (caption) form.append("caption", caption);
      if (parseMode) form.append("parse_mode", safeString(parseMode));
      if (replyToMessageId)
        form.append("reply_to_message_id", safeString(replyToMessageId));
      form.append(
        field,
        new Blob([payload.data], {
          type: safeString(payload.mimeType).trim() || undefined,
        }),
        payload.name,
      );
    });
    return safeString(result?.message_id).trim();
  }

  async sendMessage(chatId: string, content: any) {
    const { work, replyToMessageId } = prepareOutboundNodes(content);
    const delivered: string[] = [];
    let cursor = 0;
    let firstReply = replyToMessageId;
    while (cursor < work.length) {
      const node = work[cursor];
      const type = safeString(node?.type).toLowerCase();
      if (isTelegramMediaNodeType(type)) {
        const captionNodes: any[] = [];
        let nextCursor = cursor + 1;
        while (nextCursor < work.length && isTextLikeNode(work[nextCursor])) {
          captionNodes.push(work[nextCursor]);
          nextCursor += 1;
        }
        const renderedCaption = renderTelegramHtmlFromNodes(captionNodes);
        const captionChunks = splitPlainText(
          renderedCaption,
          TELEGRAM_MAX_CAPTION_LENGTH,
        );
        const media = telegramMediaMethod(type);
        const caption = type === "sticker" ? "" : captionChunks[0] || "";
        const messageId = await this.sendBinaryMessage(
          media.method as any,
          media.field as any,
          chatId,
          node,
          caption,
          firstReply,
          caption ? "HTML" : undefined,
        );
        if (messageId) delivered.push(messageId);
        firstReply = undefined;
        const spillCaptionChunks =
          type === "sticker" ? captionChunks : captionChunks.slice(1);
        for (const extraCaptionChunk of spillCaptionChunks) {
          const extraMessageId = await this.sendText(
            chatId,
            extraCaptionChunk,
            firstReply,
            "HTML",
          );
          if (extraMessageId) delivered.push(extraMessageId);
        }
        cursor = nextCursor;
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
      const text = renderTelegramHtmlFromNodes(textNodes);
      for (const textChunk of splitPlainText(text, TELEGRAM_MAX_TEXT_LENGTH)) {
        const messageId = await this.sendText(
          chatId,
          textChunk,
          firstReply,
          "HTML",
        );
        if (messageId) delivered.push(messageId);
        firstReply = undefined;
      }
      cursor = nextCursor;
    }
    if (!delivered.length) {
      throw new Error("telegram_send_message_empty");
    }
    return delivered;
  }

  async createReaction(chatId: string, messageId: string, emoji: string) {
    await this.callApi("setMessageReaction", {
      chat_id: chatId,
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
    await this.callApi("setMessageReaction", {
      chat_id: chatId,
      message_id: Number(messageId),
      reaction: [],
    });
    return true;
  }
}

function parseOneBotSegments(input: unknown) {
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

function escapeOneBotText(value: string) {
  return safeString(value)
    .replace(/&/g, "&amp;")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;")
    .replace(/,/g, "&#44;");
}

const NAPCAT_ONEBOT_EMOJI_ID_OVERRIDES: Record<string, string> = {
  "🌘": "75",
  "🌗": "74",
  "🌖": "127881",
  "🌕": "128293",
  "👍": "128077",
  "🔥": "128293",
  "🎉": "127881",
  "🌹": "127801",
  "👀": "128064",
  // NapCat routes <=3-digit reaction IDs as QQ system faces. QQ desktop does
  // not render the Unicode 🤔 code point as a visible reaction, so use the
  // cross-client /托腮 face instead.
  "🤔": "212",
};

function toOneBotReactionEmojiId(value: string) {
  const emoji = safeString(value).trim();
  if (!emoji) return "";
  const mapped = NAPCAT_ONEBOT_EMOJI_ID_OVERRIDES[emoji];
  if (mapped) return mapped;
  const [first] = Array.from(emoji);
  if (!first) return "";
  const codePoint = first.codePointAt(0);
  return Number.isFinite(codePoint) ? String(codePoint) : "";
}

function isOneBotGroupChatId(chatId: string) {
  const value = safeString(chatId).trim();
  return Boolean(value) && !value.startsWith("private:");
}

class OneBotAdapter {
  private readonly app: ChatRuntimeApp;
  private readonly config: Record<string, any>;
  private readonly logger: any;
  private readonly cacheDir: string;
  private ws: WebSocket | null = null;
  private loopPromise: Promise<void> | null = null;
  private stopped = false;
  private nextEchoId = 1;
  private readonly pending = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (error: unknown) => void;
      timer: NodeJS.Timeout;
    }
  >();
  readonly bot: any;

  constructor(
    app: ChatRuntimeApp,
    dataDir: string,
    config: Record<string, any>,
    logger: any,
  ) {
    this.app = app;
    this.config = config;
    this.logger = createPrefixedLogger("chat-runtime:onebot", logger);
    this.cacheDir = path.join(dataDir, "chat-runtime-cache", "onebot");
    ensureDir(this.cacheDir);
    this.bot = {
      platform: "onebot",
      selfId: safeString(config?.selfId).trim(),
      status: 0,
      internal: new Proxy(
        {
          callAction: (action: string, params?: any) =>
            this.callAction(action, params),
          getGroupInfo: (groupId: string | number, noCache = false) =>
            this.callAction("get_group_info", {
              group_id: Number(groupId),
              no_cache: Boolean(noCache),
            }),
          getGroupMemberInfo: (
            groupId: string | number,
            userId: string | number,
            noCache = false,
          ) =>
            this.callAction("get_group_member_info", {
              group_id: Number(groupId),
              user_id: Number(userId),
              no_cache: Boolean(noCache),
            }),
          getMsg: (messageId: string | number) =>
            this.callAction("get_msg", { message_id: Number(messageId) }),
          sendGroupMsg: (
            groupId: string | number,
            message: any,
            autoEscape = false,
          ) =>
            this.callAction("send_group_msg", {
              group_id: Number(groupId),
              message,
              auto_escape: Boolean(autoEscape),
            }),
          sendPrivateMsg: (
            userId: string | number,
            message: any,
            autoEscape = false,
          ) =>
            this.callAction("send_private_msg", {
              user_id: Number(userId),
              message,
              auto_escape: Boolean(autoEscape),
            }),
          setMessageReaction: async (payload: any) => {
            const chatId = safeString(
              payload?.chat_id || payload?.chatId,
            ).trim();
            if (chatId && !isOneBotGroupChatId(chatId)) {
              throw new Error("onebot_reaction_requires_group_chat");
            }
            const reactions = Array.isArray(payload?.reaction)
              ? payload.reaction
              : [];
            const emoji = safeString(
              reactions.find((item) => item && typeof item === "object")
                ?.emoji ||
                payload?.emoji ||
                payload?.emoji_id ||
                "",
            ).trim();
            const emojiId = toOneBotReactionEmojiId(emoji);
            if (!emojiId) {
              throw new Error("onebot_reaction_emoji_unsupported");
            }
            return await this.callAction("set_msg_emoji_like", {
              message_id: Number(payload?.message_id),
              emoji_id: emojiId,
              set:
                reactions.length > 0
                  ? true
                  : payload?.set === false
                    ? false
                    : undefined,
            });
          },
        },
        {
          get: (target, property) => {
            if (typeof property !== "string") return undefined;
            if (property in target) return (target as any)[property];
            return async (...args: any[]) => {
              if (!args.length)
                return await this.callAction(toSnakeCase(property), {});
              if (args.length === 1 && args[0] && typeof args[0] === "object") {
                return await this.callAction(toSnakeCase(property), args[0]);
              }
              throw new Error(
                `unsupported_onebot_internal_signature:${property}`,
              );
            };
          },
        },
      ),
      sendMessage: async (chatId: string, content: any) =>
        await this.sendMessage(chatId, content),
      createReaction: async (
        chatId: string,
        messageId: string,
        emoji: string,
      ) => await this.createReaction(chatId, messageId, emoji),
      deleteReaction: async (
        chatId: string,
        messageId: string,
        emoji?: string,
        _userId?: string,
      ) => await this.deleteReaction(chatId, messageId, emoji),
    };
    this.app.register(this, this.bot);
  }

  async start() {
    if (this.loopPromise) return;
    this.stopped = false;
    this.loopPromise = this.runLoop();
  }

  async stop() {
    this.stopped = true;
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
    try {
      await this.loopPromise;
    } catch {}
    this.loopPromise = null;
    emitBotStatus(this.app, this.bot, 0);
  }

  private async runLoop() {
    while (!this.stopped) {
      try {
        await this.connect();
        await new Promise<void>((resolve) => {
          this.ws?.once("close", () => resolve());
        });
      } catch (error: any) {
        if (!this.stopped) {
          this.logger.warn(
            `connect failed err=${safeString(error?.message || error)}`,
          );
        }
      } finally {
        emitBotStatus(this.app, this.bot, 0);
        this.rejectPending(new Error("onebot_disconnected"));
        this.ws = null;
      }
      if (!this.stopped) {
        await sleep(3000);
      }
    }
  }

  private async connect() {
    const endpoint = safeString(this.config?.endpoint).trim();
    const protocol = safeString(this.config?.protocol).trim() || "ws";
    if (protocol !== "ws") {
      throw new Error(`unsupported_onebot_protocol:${protocol}`);
    }
    if (!endpoint) throw new Error("onebot_endpoint_required");
    await new Promise<void>((resolve, reject) => {
      const headers: Record<string, string> = {};
      const token = safeString(this.config?.token).trim();
      if (token) headers.Authorization = `Bearer ${token}`;
      const ws = new WebSocket(endpoint, { headers });
      let settled = false;
      ws.once("open", () => {
        settled = true;
        this.ws = ws;
        resolve();
      });
      ws.once("error", (error) => {
        if (!settled) reject(error);
      });
      ws.on("message", (buffer) => {
        void this.handleSocketMessage(buffer.toString("utf8"));
      });
      ws.on("close", () => {
        emitBotStatus(this.app, this.bot, 0);
      });
    });
    emitBotStatus(this.app, this.bot, 1);
    try {
      const login: any = await this.callAction("get_login_info", {});
      const selfId = safeString(
        login?.user_id || login?.userId || this.bot.selfId,
      ).trim();
      if (selfId) this.bot.selfId = selfId;
    } catch {}
  }

  private rejectPending(error: Error) {
    for (const [echo, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(echo);
    }
  }

  private async handleSocketMessage(text: string) {
    let payload: any;
    try {
      payload = JSON.parse(text);
    } catch {
      return;
    }
    const echo = safeString(payload?.echo).trim();
    if (echo && this.pending.has(echo)) {
      const pending = this.pending.get(echo)!;
      clearTimeout(pending.timer);
      this.pending.delete(echo);
      if (
        safeString(payload?.status).trim() === "failed" ||
        Number(payload?.retcode) < 0
      ) {
        pending.reject(
          new Error(
            safeString(
              payload?.wording ||
                payload?.msg ||
                payload?.message ||
                "onebot_action_failed",
            ),
          ),
        );
        return;
      }
      pending.resolve(payload?.data);
      return;
    }
    const selfId = safeString(payload?.self_id).trim();
    if (selfId && !safeString(this.bot?.selfId).trim()) {
      this.bot.selfId = selfId;
    }
    if (safeString(payload?.post_type).trim() === "message") {
      const session = await this.buildSession(payload);
      if (session) this.app.emit("message", session);
    }
  }

  private async callAction(action: string, params?: any) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("onebot_not_connected");
    }
    const echo = `rin-${Date.now()}-${this.nextEchoId++}`;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`onebot_action_timeout:${action}`));
      }, 20000);
      this.pending.set(echo, { resolve, reject, timer });
      ws.send(
        JSON.stringify({
          action,
          params: params && typeof params === "object" ? params : {},
          echo,
        }),
      );
    });
  }

  private async cacheBinary(
    data: Buffer,
    mimeType: string,
    fallbackName: string,
  ) {
    const fileName = ensureExtension(ensureFileName(fallbackName), mimeType);
    const fullPath = path.join(this.cacheDir, `${Date.now()}-${fileName}`);
    await fs.promises.writeFile(fullPath, data);
    return fullPath;
  }

  private async normalizeOutboundMedia(node: any, type: "image" | "file") {
    const payload = await readBinaryFromNode(node);
    if (!payload) return "";
    if (payload.url) {
      return payload.url;
    }
    const saved = await this.cacheBinary(
      payload.data,
      safeString(payload.mimeType).trim() ||
        (type === "image" ? "image/png" : "application/octet-stream"),
      payload.name || `${type}-${Date.now()}`,
    );
    return fileUrl(saved);
  }

  private async renderOutboundMessage(nodes: any[]) {
    const parts: string[] = [];
    for (const node of nodes) {
      const type = safeString(node?.type).toLowerCase();
      const attrs =
        node?.attrs && typeof node.attrs === "object" ? node.attrs : {};
      if (type === "quote") {
        const id = safeString(attrs.id).trim();
        if (id) parts.push(`[CQ:reply,id=${escapeOneBotText(id)}]`);
        continue;
      }
      if (type === "text") {
        parts.push(escapeOneBotText(safeString(attrs.content)));
        continue;
      }
      if (type === "markdown" || type === "md" || type === "html") {
        parts.push(escapeOneBotText(renderPlainTextFromNodes([node])));
        continue;
      }
      if (type === "at") {
        const id = safeString(attrs.id).trim();
        if (id) parts.push(`[CQ:at,qq=${escapeOneBotText(id)}]`);
        continue;
      }
      if (type === "br") {
        parts.push("\n");
        continue;
      }
      if (type === "image") {
        const media = await this.normalizeOutboundMedia(node, "image");
        if (media) parts.push(`[CQ:image,file=${escapeOneBotText(media)}]`);
        continue;
      }
      if (type === "audio" || type === "voice" || type === "record") {
        const media = await this.normalizeOutboundMedia(node, "file");
        if (media) parts.push(`[CQ:record,file=${escapeOneBotText(media)}]`);
        continue;
      }
      if (type === "video") {
        const media = await this.normalizeOutboundMedia(node, "file");
        if (media) parts.push(`[CQ:video,file=${escapeOneBotText(media)}]`);
        continue;
      }
      if (type === "file" || type === "sticker") {
        const media = await this.normalizeOutboundMedia(node, "file");
        if (media) parts.push(`[CQ:file,file=${escapeOneBotText(media)}]`);
        continue;
      }
      const children = Array.isArray(node?.children) ? node.children : [];
      if (children.length) {
        parts.push(await this.renderOutboundMessage(children));
      }
    }
    return parts.join("");
  }

  private async sendMessage(chatId: string, content: any) {
    const { nodes } = prepareOutboundNodes(content);
    const message = await this.renderOutboundMessage(nodes);
    if (!message) throw new Error("onebot_send_message_empty");
    const isPrivate = safeString(chatId).startsWith("private:");
    const targetId = Number(
      safeString(chatId)
        .replace(/^private:/, "")
        .trim(),
    );
    const data: any = isPrivate
      ? await this.callAction("send_private_msg", {
          user_id: targetId,
          message,
          auto_escape: false,
        })
      : await this.callAction("send_group_msg", {
          group_id: targetId,
          message,
          auto_escape: false,
        });
    const messageId = safeString(data?.message_id || data).trim();
    if (!messageId) throw new Error("onebot_send_message_empty_result");
    return [messageId];
  }

  async createReaction(chatId: string, messageId: string, emoji: string) {
    if (!isOneBotGroupChatId(chatId)) {
      throw new Error("onebot_reaction_requires_group_chat");
    }
    const emojiId = toOneBotReactionEmojiId(emoji);
    if (!emojiId) throw new Error("onebot_reaction_emoji_unsupported");
    await this.callAction("set_msg_emoji_like", {
      message_id: Number(messageId),
      emoji_id: emojiId,
      set: true,
    });
    return true;
  }

  async deleteReaction(chatId: string, messageId: string, emoji?: string) {
    if (!isOneBotGroupChatId(chatId)) {
      throw new Error("onebot_reaction_requires_group_chat");
    }
    const emojiId = toOneBotReactionEmojiId(safeString(emoji).trim());
    if (!emojiId) throw new Error("onebot_reaction_emoji_unsupported");
    await this.callAction("set_msg_emoji_like", {
      message_id: Number(messageId),
      emoji_id: emojiId,
      set: false,
    });
    return true;
  }

  private async buildSession(payload: any) {
    const messageType = safeString(payload?.message_type).trim();
    const selfId = safeString(payload?.self_id || this.bot.selfId).trim();
    if (selfId && !this.bot.selfId) this.bot.selfId = selfId;
    const userId = safeString(payload?.user_id).trim();
    if (selfId && userId && userId === selfId) return null;
    const groupId = safeString(payload?.group_id).trim();
    const isDirect = messageType !== "group";
    const channelId = isDirect ? `private:${userId}` : groupId;
    const segments = parseOneBotSegments(
      payload?.message ?? payload?.raw_message ?? "",
    );
    const elements: any[] = [];
    const textParts: string[] = [];
    let mentionSelf = false;
    let quote: any = undefined;
    for (const segment of segments) {
      const type = safeString(segment.type).toLowerCase();
      const data =
        segment.data && typeof segment.data === "object" ? segment.data : {};
      if (type === "text") {
        const text = safeString(data?.text || "");
        if (text) {
          textParts.push(text);
          elements.push(normalizeNode("text", { content: text }));
        }
        continue;
      }
      if (type === "at") {
        const id = safeString(data?.qq || data?.id || "").trim();
        const name = safeString(data?.name || "").trim() || undefined;
        elements.push(normalizeNode("at", compactObject({ id, name })));
        if (selfId && id === selfId) mentionSelf = true;
        continue;
      }
      if (type === "image" || type === "img") {
        const src = safeString(data?.url || data?.file || "").trim();
        if (src) {
          elements.push(
            normalizeNode(
              "image",
              compactObject({
                src,
                name: safeString(data?.file).trim() || undefined,
              }),
            ),
          );
        }
        continue;
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
        const src = safeString(data?.url || data?.file || "").trim();
        elements.push(
          normalizeNode(
            nodeType,
            compactObject({
              src: src || undefined,
              id: safeString(data?.id || data?.qq).trim() || undefined,
              name:
                safeString(data?.name || data?.file || data?.text).trim() ||
                undefined,
            }),
          ),
        );
        continue;
      }
      if (type === "reply") {
        quote = parseOneBotReplyQuote(data);
      }
    }
    const content = safeString(
      payload?.raw_message || renderPlainTextFromNodes(elements),
    ).trim();
    const strippedContent = textParts.join("").trim() || content;
    const sender =
      payload?.sender && typeof payload.sender === "object"
        ? payload.sender
        : {};
    const nickname =
      safeString(sender?.card).trim() ||
      safeString(sender?.nickname).trim() ||
      safeString(sender?.nick).trim() ||
      undefined;
    return {
      platform: "onebot",
      selfId: selfId || undefined,
      bot: this.bot,
      messageId: safeString(payload?.message_id).trim(),
      timestamp: Number.isFinite(Number(payload?.time))
        ? Number(payload.time) * 1000
        : Date.now(),
      userId,
      author: {
        userId,
        name: nickname,
        nick: nickname,
      },
      user: {
        userId,
        id: userId,
        name: nickname,
        nick: nickname,
      },
      channelId,
      channelName: !isDirect
        ? safeString(sender?.title).trim() || undefined
        : undefined,
      guildId: !isDirect ? groupId : undefined,
      guildName: !isDirect
        ? safeString(sender?.title).trim() || undefined
        : undefined,
      isDirect,
      content,
      stripped: {
        appel: mentionSelf,
        content: strippedContent,
      },
      elements,
      quote,
    };
  }
}

type BuiltInChatRuntimeAdapterConstructor = new (
  app: ChatRuntimeApp,
  dataDir: string,
  config: Record<string, any>,
  logger: any,
) => any;

const BUILT_IN_CHAT_RUNTIME_ADAPTER_FACTORIES: Record<
  ChatBridgeBuiltInAdapterKey,
  BuiltInChatRuntimeAdapterConstructor
> = {
  telegram: TelegramAdapter,
  onebot: OneBotAdapter,
  qq: QQAdapter,
  lark: LarkAdapter,
  discord: DiscordAdapter,
  slack: SlackAdapter,
  minecraft: MinecraftAdapter,
};

export function createChatRuntimeApp(agentDir?: string) {
  return new ChatRuntimeApp(agentDir);
}

export function createChatRuntimeH() {
  return createNodeBuilder();
}

export function instantiateBuiltInChatRuntimeAdapters(
  app: ChatRuntimeApp,
  input: {
    dataDir: string;
    settings: any;
    adapterEntries: Array<{
      key: string;
      name: string;
      config: Record<string, any>;
    }>;
    logger?: any;
  },
) {
  const created: Array<{ key: string; name: string }> = [];
  for (const entry of input.adapterEntries) {
    const adapterSpec = getChatBridgeAdapterSpec(entry.key);
    const Adapter = adapterSpec
      ? BUILT_IN_CHAT_RUNTIME_ADAPTER_FACTORIES[adapterSpec.key]
      : undefined;
    if (!Adapter) {
      input.logger?.warn?.(
        `chat runtime adapter not implemented key=${entry.key} name=${entry.name}`,
      );
      continue;
    }
    try {
      new Adapter(app, input.dataDir, entry.config, input.logger);
      created.push({ key: entry.key, name: entry.name });
    } catch (error: any) {
      input.logger?.warn?.(
        `chat runtime adapter init failed key=${entry.key} name=${entry.name} err=${safeString(error?.message || error)}`,
      );
    }
  }
  return created;
}
