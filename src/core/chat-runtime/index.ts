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
  isEditableWorkingText,
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

const TELEGRAM_CHAT_THREAD_MARKER = "?thread=";

function encodeTelegramThreadId(threadId: unknown) {
  return encodeURIComponent(safeString(threadId).trim());
}

function decodeTelegramThreadId(threadId: unknown) {
  try {
    return decodeURIComponent(safeString(threadId).trim());
  } catch {
    return safeString(threadId).trim();
  }
}

function splitTelegramChatThread(
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

function telegramThreadPayload(messageThreadId: unknown) {
  const text = safeString(messageThreadId).trim();
  if (!text) return {};
  const numeric = Number(text);
  return { message_thread_id: Number.isFinite(numeric) ? numeric : text };
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

function pickOneBotForwardId(data: Record<string, any>) {
  return safeString(data?.id || data?.resid || data?.file || "").trim();
}

function oneBotForwardNodeAuthor(data: Record<string, any>) {
  const userId = safeString(
    data?.user_id || data?.uin || data?.qq || "",
  ).trim();
  const nickname = safeString(
    data?.nickname || data?.name || data?.nick || data?.sender?.nickname || "",
  ).trim();
  if (nickname && userId) return `${nickname}(${userId})`;
  return nickname || userId || "unknown";
}

function oneBotForwardNodeText(content: unknown): string {
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

function oneBotForwardMessages(value: unknown): any[] {
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

const TELEGRAM_MAX_TEXT_LENGTH = 4096;
const TELEGRAM_MAX_CAPTION_LENGTH = 1024;

function isTelegramPhotoDimensionError(error: unknown) {
  return /\bPHOTO_INVALID_DIMENSIONS\b/i.test(
    safeString((error as any)?.message || error),
  );
}

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

function partialChatDeliveryError(error: unknown, delivered: string[]) {
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

const TELEGRAM_ZERO_PAYLOAD_METHODS = new Set([
  "getMe",
  "getWebhookInfo",
  "getForumTopicIconStickers",
  "getAvailableGifts",
  "logOut",
  "close",
  "getMyStarBalance",
  "removeMyProfilePhoto",
]);

function translateAbortSignal(signal: any) {
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

class TelegramAdapter {
  private readonly app: ChatRuntimeApp;
  private readonly config: Record<string, any>;
  private readonly logger: any;
  private readonly workingCopy: ReturnType<
    typeof resolveChatRuntimeWorkingCopy
  >;
  private readonly cacheDir: string;
  private readonly cursorPath: string;
  private pollAbort: AbortController | null = null;
  private running = false;
  private pollPromise: Promise<void> | null = null;
  private nextOffset = 0;
  private readonly pollDispatcher = new UndiciAgent({ connections: 1 });
  private readonly apiDispatcher = new UndiciAgent({ connections: 8 });
  private readonly pollApi: GrammyApi;
  private readonly api: GrammyApi;
  private readonly workingReactions = new Map<string, string>();
  private readonly workingMessages = new Map<string, string>();
  private readonly workingMessageTexts = new Map<string, string>();
  private readonly workingMessageKinds = new Map<string, string>();
  private readonly workingMessageOperations = new Map<
    string,
    Promise<unknown>
  >();
  private readonly workingMessageFinalizing = new Set<string>();
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
    this.workingCopy = resolveChatRuntimeWorkingCopy(app?.agentDir);
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

  private async withWorkingMessageOperation<T>(
    key: string,
    operation: () => Promise<T>,
  ) {
    const previous =
      this.workingMessageOperations.get(key) || Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    this.workingMessageOperations.set(key, run);
    try {
      return await run;
    } finally {
      if (this.workingMessageOperations.get(key) === run) {
        this.workingMessageOperations.delete(key);
      }
    }
  }

  private workingMessageKey(chatId: string, messageId: string) {
    return `${chatId}:${safeString(messageId).trim() || "chat"}`;
  }

  private workingMessageStatePath(key: string) {
    const fileName = ensureFileName(
      `${safeString(key).trim()}.json`,
      "working-message.json",
    );
    return path.join(
      this.cacheDir,
      "working-messages",
      this.botCacheKey,
      fileName,
    );
  }

  private readPersistedWorkingMessage(key: string): {
    messageId: string;
    messageIds: string[];
    text: string;
    textChunks: string[];
    kind: string;
  } | null {
    const nextKey = safeString(key).trim();
    if (!nextKey) return null;
    try {
      const record = JSON.parse(
        fs.readFileSync(this.workingMessageStatePath(nextKey), "utf8"),
      );
      const messageIds = (
        Array.isArray(record?.messageIds)
          ? record.messageIds
          : [record?.messageId]
      )
        .map((item: unknown) => safeString(item).trim())
        .filter(Boolean);
      if (!messageIds.length) return null;
      const textChunks = (
        Array.isArray(record?.textChunks) ? record.textChunks : [record?.text]
      ).map((item: unknown) => safeString(item));
      const text = textChunks.length
        ? textChunks.join("")
        : safeString(record?.text);
      return {
        messageId: messageIds[0] || "",
        messageIds,
        text,
        textChunks: textChunks.length ? textChunks : [text],
        kind: safeString(record?.kind).trim(),
      };
    } catch {
      return null;
    }
  }

  private writePersistedWorkingMessage(
    key: string,
    messageIds: string[],
    textChunks: string[],
    kind = "",
  ) {
    const nextKey = safeString(key).trim();
    const nextMessageIds = messageIds
      .map((item) => safeString(item).trim())
      .filter(Boolean);
    if (!nextKey || !nextMessageIds.length) return;
    const nextTextChunks = textChunks.map((item) => safeString(item));
    const statePath = this.workingMessageStatePath(nextKey);
    ensureDir(path.dirname(statePath));
    fs.writeFileSync(
      statePath,
      JSON.stringify(
        {
          key: nextKey,
          messageId: nextMessageIds[0],
          messageIds: nextMessageIds,
          text: nextTextChunks.join(""),
          textChunks: nextTextChunks,
          kind: safeString(kind).trim(),
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  }

  private deletePersistedWorkingMessage(key: string) {
    const nextKey = safeString(key).trim();
    if (!nextKey) return;
    try {
      fs.rmSync(this.workingMessageStatePath(nextKey), { force: true });
    } catch {}
  }

  private rememberWorkingMessageGroup(
    key: string,
    messageIds: string[],
    textChunks: string[],
    kind = "",
  ) {
    const nextMessageIds = messageIds
      .map((item) => safeString(item).trim())
      .filter(Boolean);
    if (!nextMessageIds.length) {
      this.clearWorkingMessage(key);
      return;
    }
    const nextKind = safeString(kind).trim();
    const text = textChunks.map((item) => safeString(item)).join("");
    this.workingMessages.set(key, nextMessageIds[0] || "");
    this.workingMessageTexts.set(key, text);
    this.workingMessageKinds.set(key, nextKind);
    this.writePersistedWorkingMessage(
      key,
      nextMessageIds,
      textChunks,
      nextKind,
    );
  }

  private rememberWorkingMessage(
    key: string,
    messageId: string,
    text: string,
    kind = "",
  ) {
    this.rememberWorkingMessageGroup(key, [messageId], [text], kind);
  }

  private clearWorkingMessage(key: string) {
    this.workingMessages.delete(key);
    this.workingMessageTexts.delete(key);
    this.workingMessageKinds.delete(key);
    this.deletePersistedWorkingMessage(key);
  }

  private markWorkingMessageFinalizing(key: string) {
    this.workingMessageFinalizing.add(key);
    setTimeout(
      () => this.workingMessageFinalizing.delete(key),
      30_000,
    ).unref?.();
  }

  private isRecoverableWorkingMessageEditError(error: unknown) {
    const message = safeString((error as any)?.message || error).trim();
    return /message to edit not found|message can't be edited|message identifier is not specified/i.test(
      message,
    );
  }

  private isWorkingIndicatorText(text: string) {
    const value = safeString(text).trim();
    if (!value) return false;
    const copy =
      this.workingCopy || resolveChatRuntimeWorkingCopy(this.app?.agentDir);
    return copy.progressTexts.includes(value) || isEditableWorkingText(value);
  }

  private async deleteVisibleWorkingMessage(chatId: string) {
    const target = splitTelegramChatThread(chatId);
    const key = this.workingMessageKey(target.scopedChatId, "chat");
    const persisted = this.readPersistedWorkingMessage(key);
    const messageIds = persisted?.messageIds?.length
      ? persisted.messageIds
      : [this.workingMessages.get(key) || ""].filter(Boolean);
    const kind = safeString(
      persisted?.kind || this.workingMessageKinds.get(key) || "",
    ).trim();
    const text = safeString(
      persisted?.text || this.workingMessageTexts.get(key) || "",
    );
    const isProgressArtifact =
      kind === "todo" ||
      kind === "interim" ||
      ((!kind || kind === "working") && this.isWorkingIndicatorText(text));
    if (!messageIds.length || !isProgressArtifact) {
      return false;
    }
    for (const messageId of messageIds) {
      try {
        await this.callApi("deleteMessage", {
          chat_id: target.chatId,
          message_id: Number(messageId),
        });
      } catch {}
    }
    this.clearWorkingMessage(key);
    return true;
  }

  private resolveWorkingMessageIds(
    chatId: string,
    preferredMessageId?: string,
    keyOverride = "",
  ) {
    const overrideKey = safeString(keyOverride).trim();
    const defaultKey = this.workingMessageKey(chatId, "chat");
    const keys = (
      overrideKey && overrideKey !== defaultKey
        ? [overrideKey]
        : [
            defaultKey,
            preferredMessageId
              ? this.workingMessageKey(chatId, preferredMessageId)
              : "",
          ]
    ).filter(Boolean);
    for (const key of keys) {
      const persisted = this.readPersistedWorkingMessage(key);
      if (persisted?.messageIds?.length) {
        this.workingMessages.set(key, persisted.messageId);
        this.workingMessageTexts.set(key, persisted.text);
        this.workingMessageKinds.set(key, persisted.kind);
        return persisted.messageIds;
      }
      const direct = this.workingMessages.get(key) || "";
      if (direct) return [safeString(direct).trim()].filter(Boolean);
    }
    return [];
  }

  private async updateWorkingMessage(input: {
    chatId?: string;
    text?: string;
    replyToMessageId?: string;
    preferredMessageId?: string;
    messageId?: string;
    parseMode?: string;
    finalize?: boolean;
    key?: string;
    kind?: string;
  }) {
    const ids = await this.updateWorkingMessageGroup({
      ...input,
      textChunks: [safeString(input?.text)],
    });
    return ids[0] || "";
  }

  private async updateWorkingMessageGroup(input: {
    chatId?: string;
    textChunks?: string[];
    replyToMessageId?: string;
    preferredMessageId?: string;
    messageIds?: string[];
    parseMode?: string;
    finalize?: boolean;
    key?: string;
    kind?: string;
  }) {
    const chatId = safeString(input?.chatId).trim();
    const textChunks = (input?.textChunks || [])
      .map((item) => safeString(item))
      .filter(Boolean);
    if (!chatId || !textChunks.length) return [] as string[];
    const key =
      safeString(input?.key).trim() || this.workingMessageKey(chatId, "chat");
    const parseMode = safeString(input?.parseMode).trim() || undefined;
    const replyToMessageId =
      safeString(input?.replyToMessageId).trim() || undefined;
    const preferredMessageId = safeString(input?.preferredMessageId).trim();
    const finalize = Boolean(input?.finalize);
    const kind =
      safeString(input?.kind).trim() || (finalize ? "final" : "working");
    return await this.withWorkingMessageOperation(key, async () => {
      if (!finalize && this.workingMessageFinalizing.has(key)) {
        return [this.workingMessages.get(key) || ""].filter(Boolean);
      }
      const persisted = this.readPersistedWorkingMessage(key);
      if (!finalize && kind === "working") {
        const currentMessageId = safeString(
          this.workingMessages.get(key) || persisted?.messageId || "",
        ).trim();
        const currentKind = safeString(
          this.workingMessageKinds.get(key) || persisted?.kind || "",
        ).trim();
        const currentText = safeString(
          this.workingMessageTexts.get(key) || persisted?.text || "",
        );
        if (currentMessageId && currentKind && currentKind !== "working") {
          return [currentMessageId];
        }
        if (
          currentMessageId &&
          currentText &&
          !this.isWorkingIndicatorText(currentText)
        ) {
          return [currentMessageId];
        }
      }
      const existingMessageIds = (
        input?.messageIds?.length
          ? input.messageIds
          : this.resolveWorkingMessageIds(chatId, preferredMessageId, key)
      )
        .map((item) => safeString(item).trim())
        .filter(Boolean);
      if (
        !finalize &&
        existingMessageIds.length &&
        (this.workingMessageTexts.get(key) || persisted?.text || "") ===
          textChunks.join("")
      ) {
        return existingMessageIds;
      }
      const delivered: string[] = [];
      let firstReply = replyToMessageId;
      let editFailed = false;
      let editedExistingCount = 0;
      for (let index = 0; index < textChunks.length; index += 1) {
        const text = textChunks[index] || "";
        const existingMessageId = existingMessageIds[index] || "";
        if (existingMessageId && !editFailed) {
          try {
            const editedId =
              safeString(
                await this.editText(chatId, existingMessageId, text, parseMode),
              ).trim() || existingMessageId;
            delivered.push(editedId);
            editedExistingCount += 1;
            firstReply = undefined;
            continue;
          } catch (error) {
            if (!this.isRecoverableWorkingMessageEditError(error)) throw error;
            editFailed = true;
          }
        }
        const sentId = safeString(
          await this.sendText(chatId, text, firstReply, parseMode),
        ).trim();
        if (sentId) delivered.push(sentId);
        firstReply = undefined;
      }
      const surplusStart = editFailed ? editedExistingCount : delivered.length;
      for (const surplusId of existingMessageIds.slice(surplusStart)) {
        try {
          const target = splitTelegramChatThread(chatId);
          await this.callApi("deleteMessage", {
            chat_id: target.chatId,
            message_id: Number(surplusId),
          });
        } catch {}
      }
      if (!delivered.length) return [] as string[];
      if (finalize) {
        this.clearWorkingMessage(key);
        this.markWorkingMessageFinalizing(key);
      } else {
        this.rememberWorkingMessageGroup(key, delivered, textChunks, kind);
      }
      return delivered;
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
      await this.deleteVisibleWorkingMessage(deliveryChatId);
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
            delivered.length === 0 && !isFinalDelivery;
          const messageIds = shouldEditWorkingMessage
            ? await this.updateWorkingMessageGroup({
                chatId: deliveryChatId,
                textChunks,
                replyToMessageId: firstReply,
                preferredMessageId: firstReply,
                parseMode: "HTML",
                finalize: false,
                // Working indicators and coalesced todo notices share the chat key
                // so in-progress updates still edit one Telegram message group.
                // Final replies delete that progress artifact and send fresh messages.
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
    return editableWorkingText(context?.tick, this.workingCopy.frames);
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
    if (safeString(context?.todoNoticeText).trim()) return true;
    const sourceMessageId = safeString(context?.messageId).trim();
    const replyToMessageId = safeString(
      context?.replyToMessageId || sourceMessageId,
    ).trim();
    const key = this.workingMessageKey(chatId, "chat");
    const persisted = this.readPersistedWorkingMessage(key);
    const currentKind = safeString(
      persisted?.kind || this.workingMessageKinds.get(key) || "",
    ).trim();
    if (currentKind && currentKind !== "working") return true;
    const currentText = safeString(
      persisted?.text || this.workingMessageTexts.get(key) || "",
    );
    if (currentText && !this.isWorkingIndicatorText(currentText)) return true;
    await this.updateWorkingMessage({
      chatId,
      text: this.workingMessageText(context),
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
  // cross-client "chin-resting" QQ face instead.
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

export const ONEBOT_MEDIA_CACHE_RELATIVE_DIR = path.join(
  "chat-media",
  "onebot",
);
export const ONEBOT_MEDIA_DOCKER_MOUNT_PATH =
  "$HOME/.rin/data/chat-media/onebot";
export const ONEBOT_MEDIA_DOCKER_VOLUME_HINT = `-v "${ONEBOT_MEDIA_DOCKER_MOUNT_PATH}:${ONEBOT_MEDIA_DOCKER_MOUNT_PATH}:ro"`;
export const ONEBOT_ACTION_TIMEOUT_MS = 20_000;
export const ONEBOT_MEDIA_ACTION_TIMEOUT_MS = 10 * 60_000 + 5_000;

function isOneBotTimeoutParamAction(action: string) {
  return /^(send_private_msg|send_group_msg|send_msg|upload_private_file|upload_group_file)$/.test(
    safeString(action).trim(),
  );
}

function oneBotParamsText(params: any) {
  if (!params || typeof params !== "object") return safeString(params);
  const parts = [safeString(params.message), safeString(params.file)];
  try {
    parts.push(JSON.stringify(params));
  } catch {}
  return parts.join("\n");
}

function oneBotParamsReferenceMedia(action: string, params: any) {
  if (/^upload_(?:private|group)_file$/.test(safeString(action).trim())) {
    return true;
  }
  return /\[CQ:(?:image|video|record|file)\b|file:\/\/|"type"\s*:\s*"(?:image|video|audio|record|file|sticker)"/i.test(
    oneBotParamsText(params),
  );
}

export function oneBotActionTimeoutMs(action: string, params?: any) {
  if (
    isOneBotTimeoutParamAction(action) &&
    oneBotParamsReferenceMedia(action, params)
  ) {
    return ONEBOT_MEDIA_ACTION_TIMEOUT_MS;
  }
  return ONEBOT_ACTION_TIMEOUT_MS;
}

export function withOneBotActionTimeoutParam(action: string, params?: any) {
  const nextParams =
    params && typeof params === "object" && !Array.isArray(params)
      ? { ...params }
      : {};
  const existingTimeout = Number((nextParams as any).timeout);
  if (
    (!Number.isFinite(existingTimeout) || existingTimeout <= 0) &&
    isOneBotTimeoutParamAction(action)
  ) {
    (nextParams as any).timeout = oneBotActionTimeoutMs(action, nextParams);
  }
  return nextParams;
}

function oneBotFailureText(payload: any) {
  return safeString(
    payload?.wording ||
      payload?.msg ||
      payload?.message ||
      "onebot_action_failed",
  );
}

function isOneBotLocalMediaVisibilityFailure(
  payload: any,
  action: string,
  params: any,
) {
  if (!isOneBotTimeoutParamAction(action)) return false;
  const message = oneBotFailureText(payload);
  return /ENOENT|file:\/\/|no such file|not found|rich[- ]?media/i.test(
    message,
  );
}

export const ONEBOT_LOCAL_MEDIA_VISIBILITY_HINT =
  "OneBot/NapCat cannot read Rin's local media file. If NapCat runs in Docker, mount the media directory read-only:";

export function formatOneBotActionFailureMessage(
  payload: any,
  action = "",
  params?: any,
) {
  const message = oneBotFailureText(payload) || "onebot_action_failed";
  if (!isOneBotLocalMediaVisibilityFailure(payload, action, params)) {
    return message;
  }
  if (message.includes(ONEBOT_LOCAL_MEDIA_VISIBILITY_HINT)) {
    return message;
  }
  return [
    message,
    ONEBOT_LOCAL_MEDIA_VISIBILITY_HINT,
    ONEBOT_MEDIA_DOCKER_VOLUME_HINT,
  ].join("\n");
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
  private readonly workingReactions = new Map<string, string>();
  private readonly pending = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (error: unknown) => void;
      timer: NodeJS.Timeout;
      action: string;
      params: any;
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
    this.cacheDir = path.join(dataDir, ONEBOT_MEDIA_CACHE_RELATIVE_DIR);
    ensureDir(this.cacheDir);
    this.bot = {
      platform: "onebot",
      selfId: safeString(config?.selfId).trim(),
      status: 0,
      getWorkingIndicators: (context: any) =>
        this.getWorkingIndicators(context),
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
      sendMessage: (chatId: string, content: any, options?: any) =>
        this.sendMessage(chatId, content, options),
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
            formatOneBotActionFailureMessage(
              payload,
              pending.action,
              pending.params,
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

  private callAction(action: string, params?: any) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("onebot_not_connected");
    }
    const echo = `rin-${Date.now()}-${this.nextEchoId++}`;
    const actionParams = withOneBotActionTimeoutParam(action, params);
    const timeoutMs = oneBotActionTimeoutMs(action, actionParams);
    let resolveDispatched: () => void = () => {};
    let rejectDispatched: (error: unknown) => void = () => {};
    const dispatched = new Promise<void>((resolve, reject) => {
      resolveDispatched = resolve;
      rejectDispatched = reject;
    });
    void dispatched.catch(() => {});
    const actionPayload = JSON.stringify({
      action,
      params: actionParams,
      echo,
    });
    const task = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`onebot_action_timeout:${action}`));
      }, timeoutMs);
      this.pending.set(echo, {
        resolve,
        reject,
        timer,
        action,
        params: actionParams,
      });
      try {
        ws.send(actionPayload, (error?: Error) => {
          if (error) {
            clearTimeout(timer);
            this.pending.delete(echo);
            rejectDispatched(error);
            reject(error);
            return;
          }
          resolveDispatched();
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(echo);
        rejectDispatched(error);
        reject(error);
      }
    }) as Promise<any> & { dispatched?: Promise<void> };
    task.dispatched = dispatched;
    return task;
  }

  private async normalizeOutboundMedia(node: any, type: "image" | "file") {
    const staged = await stageChatMediaFromNode(node, {
      cacheDir: this.cacheDir,
      consumerDir: this.cacheDir,
      fallbackMimeType:
        type === "image" ? "image/png" : "application/octet-stream",
      fallbackName: `${type}-${Date.now()}`,
      type,
    });
    return safeString(staged?.src).trim();
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

  private sendMessage(chatId: string, content: any, _options?: any) {
    let resolveDispatched: () => void = () => {};
    let rejectDispatched: (error: unknown) => void = () => {};
    const dispatched = new Promise<void>((resolve, reject) => {
      resolveDispatched = resolve;
      rejectDispatched = reject;
    });
    void dispatched.catch(() => {});
    const task = (async () => {
      try {
        const { nodes } = prepareOutboundNodes(content);
        const message = await this.renderOutboundMessage(nodes);
        if (!message) throw new Error("onebot_send_message_empty");
        const isPrivate = safeString(chatId).startsWith("private:");
        const targetId = Number(
          safeString(chatId)
            .replace(/^private:/, "")
            .trim(),
        );
        const action = isPrivate ? "send_private_msg" : "send_group_msg";
        const params = isPrivate
          ? {
              user_id: targetId,
              message,
              auto_escape: false,
            }
          : {
              group_id: targetId,
              message,
              auto_escape: false,
            };
        const actionTask: any = this.callAction(
          action,
          withOneBotActionTimeoutParam(action, params),
        );
        if (actionTask?.dispatched) {
          void actionTask.dispatched.then(resolveDispatched, rejectDispatched);
        } else {
          resolveDispatched();
        }
        const data: any = await actionTask;
        const messageId = safeString(data?.message_id || data).trim();
        if (!messageId) throw new Error("onebot_send_message_empty_result");
        return [messageId];
      } catch (error) {
        rejectDispatched(error);
        throw error;
      }
    })() as Promise<string[]> & { dispatched?: Promise<void> };
    task.dispatched = dispatched;
    return task;
  }

  getWorkingIndicators(context: any) {
    const chatId = safeString(context?.chatId).trim();
    if (chatId.startsWith("private:")) {
      return [
        {
          type: "marker",
          presentation: "message",
          start: async (startContext: any) =>
            await this.startPrivateWorkingNotice(startContext),
        },
      ];
    }
    return [
      {
        type: "polling",
        presentation: "reaction",
        tick: async (tickContext: any) =>
          await this.tickGroupWorkingReaction(tickContext),
        end: async (endContext: any) =>
          await this.endGroupWorkingReaction(endContext),
      },
    ];
  }

  async startPrivateWorkingNotice(context: any) {
    const chatId = safeString(context?.chatId).trim();
    if (!chatId.startsWith("private:")) return false;
    const targetId = Number(chatId.replace(/^private:/, "").trim());
    if (!Number.isFinite(targetId) || targetId <= 0) return false;
    const replyToMessageId = safeString(
      context?.replyToMessageId || context?.messageId,
    ).trim();
    const reply = replyToMessageId
      ? `[CQ:reply,id=${escapeOneBotText(replyToMessageId)}]`
      : "";
    await this.callAction("send_private_msg", {
      user_id: targetId,
      message: `${reply}${escapeOneBotText(
        randomWorkingText(
          resolveChatRuntimeWorkingCopy(this.app?.agentDir).frames,
        ),
      )}`,
      auto_escape: false,
    });
    return true;
  }

  async tickGroupWorkingReaction(context: any) {
    const chatId = safeString(context?.chatId).trim();
    const messageId = safeString(context?.messageId).trim();
    if (!isOneBotGroupChatId(chatId) || !messageId) return false;
    if (context?.reactionDue === false) return true;
    const key = `${chatId}:${messageId}`;
    const previousEmoji = this.workingReactions.get(key) || "";
    const nextEmoji = getWorkingReactionFrame(
      "onebot",
      Number(context?.reactionTick ?? context?.tick ?? 0),
    );
    if (!nextEmoji || previousEmoji === nextEmoji) return true;
    if (previousEmoji)
      await this.deleteReaction(chatId, messageId, previousEmoji);
    await this.createReaction(chatId, messageId, nextEmoji);
    this.workingReactions.set(key, nextEmoji);
    return true;
  }

  async endGroupWorkingReaction(context: any) {
    const chatId = safeString(context?.chatId).trim();
    const messageId = safeString(context?.messageId).trim();
    if (!isOneBotGroupChatId(chatId)) return false;
    const prefix = `${chatId}:`;
    const entries = messageId
      ? [
          [
            `${chatId}:${messageId}`,
            this.workingReactions.get(`${chatId}:${messageId}`) || "",
          ],
        ]
      : [...this.workingReactions.entries()].filter(([key]) =>
          key.startsWith(prefix),
        );
    let deletedAny = false;
    for (const [key, emoji] of entries) {
      const targetMessageId = key.slice(prefix.length);
      if (!targetMessageId || !emoji) {
        this.workingReactions.delete(key);
        continue;
      }
      await this.deleteReaction(chatId, targetMessageId, emoji);
      this.workingReactions.delete(key);
      deletedAny = true;
    }
    return deletedAny;
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

  private normalizeInboundSegmentNodes(segments: unknown) {
    const nodes: any[] = [];
    for (const segment of parseOneBotSegments(segments)) {
      const type = safeString(segment.type).toLowerCase();
      const data =
        segment.data && typeof segment.data === "object" ? segment.data : {};
      if (type === "text") {
        const text = safeString(data?.text || "");
        if (text) nodes.push(normalizeNode("text", { content: text }));
        continue;
      }
      if (type === "at") {
        const id = safeString(data?.qq || data?.id || "").trim();
        const name = safeString(data?.name || "").trim() || undefined;
        nodes.push(normalizeNode("at", compactObject({ id, name })));
        continue;
      }
      if (type === "image" || type === "img") {
        const src = safeString(data?.url || data?.file || "").trim();
        if (src) {
          nodes.push(
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
        nodes.push(
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
      if (type === "forward") {
        const id = safeString(data?.id || data?.resid || "").trim();
        nodes.push(
          normalizeNode(
            "forward",
            compactObject({
              id,
              title: safeString(data?.title || data?.name).trim() || undefined,
            }),
          ),
        );
      }
    }
    return nodes;
  }

  private pickOneBotForwardMessages(data: any, response?: any) {
    const candidates = [
      data?.messages,
      data?.content,
      data?.message,
      response?.messages,
      response?.content,
      response?.message,
    ];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) return candidate;
      if (candidate && typeof candidate === "object") {
        if (Array.isArray(candidate.messages)) return candidate.messages;
        if (Array.isArray(candidate.content)) return candidate.content;
      }
    }
    return [] as any[];
  }

  private async buildOneBotForwardNode(data: Record<string, any>) {
    const id = safeString(data?.id || data?.resid || data?.file || "").trim();
    let response: any = undefined;
    if (id) {
      try {
        response = await this.callAction("get_forward_msg", { id });
      } catch (error: any) {
        this.logger.warn(
          `get_forward_msg failed id=${id} err=${safeString(error?.message || error)}`,
        );
      }
    }
    const messages = this.pickOneBotForwardMessages(data, response);
    const children: any[] = [];
    for (const message of messages) {
      const data =
        message?.data && typeof message.data === "object"
          ? message.data
          : message;
      const sender =
        data?.sender && typeof data.sender === "object" ? data.sender : {};
      const userId = safeString(
        sender?.user_id || data?.user_id || data?.uin || data?.qq || "",
      ).trim();
      const nickname = safeString(
        sender?.card ||
          sender?.nickname ||
          sender?.nick ||
          sender?.name ||
          data?.nickname ||
          data?.name ||
          data?.nick ||
          "",
      ).trim();
      const name =
        nickname && userId
          ? `${nickname}(${userId})`
          : nickname || userId || "unknown";
      const nodes = this.normalizeInboundSegmentNodes(
        data?.content ?? data?.message ?? data?.raw_message ?? "",
      );
      const body = renderMarkdownFromNodes(nodes).trim();
      children.push(
        normalizeNode("text", {
          content: `${name}: ${body.replace(/\n/g, "\n  ") || "[unsupported message]"}\n`,
        }),
      );
    }
    return normalizeNode(
      "forward",
      compactObject({
        id,
        title: safeString(data?.title || data?.name).trim() || undefined,
        count: messages.length ? String(messages.length) : undefined,
      }),
      children,
    );
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
    let hasSemanticForward = false;
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
        continue;
      }
      if (type === "forward") {
        elements.push(await this.buildOneBotForwardNode(data));
        hasSemanticForward = true;
        continue;
      }
    }
    const renderedContent = renderPlainTextFromNodes(elements);
    const content = safeString(
      hasSemanticForward
        ? renderedContent
        : payload?.raw_message || renderedContent,
    ).trim();
    const strippedContent = textParts.join("").trim() || content;
    const sender =
      payload?.sender && typeof payload.sender === "object"
        ? payload.sender
        : {};
    const groupNickname = !isDirect
      ? safeString(sender?.card).trim() || undefined
      : undefined;
    const nickname =
      safeString(sender?.nickname).trim() ||
      safeString(sender?.nick).trim() ||
      undefined;
    const displayName = groupNickname || nickname;
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
        name: displayName,
        nick: displayName,
        nickname,
        groupNickname,
        card: groupNickname,
      },
      user: {
        userId,
        id: userId,
        name: displayName,
        nick: displayName,
        nickname,
        groupNickname,
        card: groupNickname,
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

export type ChatRuntimeExternalAdapterProviderInput = {
  app: ChatRuntimeApp;
  agentDir?: string;
  dataDir: string;
  runtimeRoot?: string;
  h?: any;
  key: string;
  name: string;
  packageName?: string;
  config: Record<string, any>;
  logger?: any;
};

export type ChatRuntimeExternalAdapterProviderResult = void | {
  adapter?: any;
  bot?: any;
};

export type ChatRuntimeExternalAdapterProvider =
  | ((
      input: ChatRuntimeExternalAdapterProviderInput,
    ) =>
      | ChatRuntimeExternalAdapterProviderResult
      | Promise<ChatRuntimeExternalAdapterProviderResult>)
  | {
      createAdapter(
        input: ChatRuntimeExternalAdapterProviderInput,
      ):
        | ChatRuntimeExternalAdapterProviderResult
        | Promise<ChatRuntimeExternalAdapterProviderResult>;
    };

export type ChatRuntimeExternalAdapterEntry = {
  key: string;
  name: string;
  packageName?: string;
  config: Record<string, any>;
  provider: ChatRuntimeExternalAdapterProvider;
};

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

type ChatRuntimeAdapterInstantiationInput = {
  dataDir: string;
  adapterEntries: Array<{
    key: string;
    name: string;
    config: Record<string, any>;
  }>;
  logger?: any;
};

function instantiateBuiltInChatRuntimeAdapter(
  app: ChatRuntimeApp,
  input: ChatRuntimeAdapterInstantiationInput,
  entry: ChatRuntimeAdapterInstantiationInput["adapterEntries"][number],
) {
  const adapterSpec = getChatBridgeAdapterSpec(entry.key);
  const Adapter = adapterSpec
    ? BUILT_IN_CHAT_RUNTIME_ADAPTER_FACTORIES[adapterSpec.key]
    : undefined;
  if (!Adapter) {
    input.logger?.warn?.(
      `chat runtime adapter not implemented key=${entry.key} name=${entry.name}`,
    );
    return false;
  }
  new Adapter(app, input.dataDir, entry.config, input.logger);
  return true;
}

export function instantiateBuiltInChatRuntimeAdapters(
  app: ChatRuntimeApp,
  input: ChatRuntimeAdapterInstantiationInput,
) {
  const created: Array<{ key: string; name: string }> = [];
  for (const entry of input.adapterEntries) {
    try {
      if (instantiateBuiltInChatRuntimeAdapter(app, input, entry)) {
        created.push({ key: entry.key, name: entry.name });
      }
    } catch (error: any) {
      input.logger?.warn?.(
        `chat runtime adapter init failed key=${entry.key} name=${entry.name} err=${safeString(error?.message || error)}`,
      );
    }
  }
  return created;
}

async function instantiateExternalChatRuntimeAdapter(
  app: ChatRuntimeApp,
  input: {
    agentDir?: string;
    dataDir: string;
    runtimeRoot?: string;
    h?: any;
    logger?: any;
  },
  entry: ChatRuntimeExternalAdapterEntry,
) {
  const botCountBefore = app.bots.length;
  const provider: any = entry.provider;
  const createAdapter =
    typeof provider === "function" ? provider : provider?.createAdapter;
  if (typeof createAdapter !== "function") {
    throw new Error("external_chat_adapter_missing_createAdapter");
  }
  const result = await createAdapter({
    app,
    agentDir: input.agentDir,
    dataDir: input.dataDir,
    runtimeRoot: input.runtimeRoot,
    h: input.h,
    key: entry.key,
    name: entry.name,
    packageName: entry.packageName,
    config: entry.config,
    logger: input.logger,
  });
  if (result && (result.adapter || result.bot)) {
    if (!result.adapter || !result.bot) {
      throw new Error("external_chat_adapter_return_requires_adapter_and_bot");
    }
    app.register(result.adapter, result.bot);
  } else if (result && typeof result === "object") {
    throw new Error("external_chat_adapter_return_requires_adapter_and_bot");
  }
  if (app.bots.length <= botCountBefore) {
    throw new Error("external_chat_adapter_did_not_register_bot");
  }
}

export async function instantiateExternalChatRuntimeAdapters(
  app: ChatRuntimeApp,
  input: {
    agentDir?: string;
    dataDir: string;
    runtimeRoot?: string;
    h?: any;
    adapterEntries: ChatRuntimeExternalAdapterEntry[];
    logger?: any;
  },
) {
  const created: Array<{ key: string; name: string }> = [];
  for (const entry of input.adapterEntries) {
    try {
      await instantiateExternalChatRuntimeAdapter(app, input, entry);
      created.push({ key: entry.key, name: entry.name });
    } catch (error: any) {
      input.logger?.warn?.(
        `external chat runtime adapter init failed key=${entry.key} name=${entry.name} err=${safeString(error?.message || error)}`,
      );
    }
  }
  return created;
}

export async function instantiateChatRuntimeAdapters(
  app: ChatRuntimeApp,
  input: ChatRuntimeAdapterInstantiationInput,
) {
  const created: Array<{ key: string; name: string }> = [];
  for (const entry of input.adapterEntries) {
    try {
      if (instantiateBuiltInChatRuntimeAdapter(app, input, entry)) {
        created.push({ key: entry.key, name: entry.name });
      }
    } catch (error: any) {
      input.logger?.warn?.(
        `chat runtime adapter init failed key=${entry.key} name=${entry.name} err=${safeString(error?.message || error)}`,
      );
    }
  }
  return created;
}
