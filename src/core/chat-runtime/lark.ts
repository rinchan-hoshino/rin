import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Lexer } from "marked";
import {
  applyInboundRecoveryResult,
  InboundRecoveryGate,
  recoverInboundHeads,
} from "./inbound-recovery.js";
import { composeChatKeyForBot } from "../chat/support.js";
import {
  createRinHttpTransport,
  discardRinHttpResponseBody,
} from "../http/transport.js";
import {
  compactObject,
  confirmedChatDeliveryError,
  createPrefixedLogger,
  emitBotStatus,
  ensureDir,
  ensureExtension,
  ensureFileName,
  fileUrl,
  normalizeNode,
  partialChatDeliveryError,
  prependChatQuoteNode,
  prepareOutboundNodes,
  readBinaryFromNode,
  renderMarkdownFromNodes,
  renderPlainTextFromNodes,
  renderRichDeliveryFallback,
  richFallbackDeliveryError,
  safeString,
  sleep,
  createTypingWorkingIndicator,
  createReactionWorkingIndicator,
} from "./common.js";

const LARK_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const LARK_MAX_FILE_BYTES = 30 * 1024 * 1024;

const LARK_RESOURCE_DOWNLOAD_TIMEOUT_MS = 30_000;

type LarkFileType = "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream";

function larkFileType(name: string, mimeType: string): LarkFileType {
  const extension = path.extname(safeString(name).trim()).toLowerCase();
  const mime = safeString(mimeType).trim().toLowerCase();
  if (extension === ".opus" || mime === "audio/opus") return "opus";
  if (extension === ".mp4" || mime === "video/mp4") return "mp4";
  if (extension === ".pdf" || mime === "application/pdf") return "pdf";
  if ([".doc", ".docx"].includes(extension)) return "doc";
  if ([".xls", ".xlsx"].includes(extension)) return "xls";
  if ([".ppt", ".pptx"].includes(extension)) return "ppt";
  return "stream";
}

const LARK_REACTION_TYPES: Record<string, string> = {
  "🤔": "THINKING",
  "🔥": "Fire",
  "⏳": "Hourglass",
};

function escapeLarkTagText(text: string) {
  return safeString(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeLarkTagAttr(text: string) {
  return escapeLarkTagText(text).replace(/"/g, "&quot;");
}

function normalizeLarkMarkdownListBlocks(text: string) {
  const lines = safeString(text).replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let inFence = false;
  let previousWasList = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const blank = !line.trim();
    const listItem = !inFence && /^\s{0,3}(?:[-*+]\s+|\d+[.)]\s+)/.test(line);
    if (!inFence && previousWasList && !blank && !listItem) {
      const last = out[out.length - 1];
      if (last !== undefined && last.trim()) out.push("");
    }
    out.push(line);
    previousWasList = !inFence && listItem;
    if (blank) previousWasList = false;
  }
  return out.join("\n");
}

function larkPostStyle(styles: string[]) {
  return styles.length ? { style: [...new Set(styles)] } : {};
}

function renderLarkInlineElements(
  tokens: any[],
  styles: string[] = [],
): any[] | null {
  const elements: any[] = [];
  const inlineTokens = Array.isArray(tokens) ? tokens : [];
  for (let index = 0; index < inlineTokens.length; index += 1) {
    const token = inlineTokens[index];
    const type = safeString(token?.type).trim();
    if (type === "text" || type === "escape") {
      elements.push({
        tag: "text",
        text: safeString(token?.text),
        ...larkPostStyle(styles),
      });
      continue;
    }
    if (type === "strong" || type === "em" || type === "del") {
      const style =
        type === "strong" ? "bold" : type === "em" ? "italic" : "lineThrough";
      const nested = renderLarkInlineElements(token?.tokens, [
        ...styles,
        style,
      ]);
      if (!nested) return null;
      elements.push(...nested);
      continue;
    }
    if (type === "link") {
      const href = safeString(token?.href).trim();
      if (!href) return null;
      const nested = renderLarkInlineElements(token?.tokens, styles);
      if (!nested?.length || nested.some((element) => element.tag !== "text")) {
        return null;
      }
      elements.push(
        ...nested.map((element) => ({
          tag: "a",
          text: element.text,
          href,
          ...(element.style ? { style: element.style } : {}),
        })),
      );
      continue;
    }
    if (type === "br") {
      elements.push({ tag: "text", text: "\n", ...larkPostStyle(styles) });
      continue;
    }
    if (type === "html") {
      const match = safeString(token?.raw).match(/^<at\s+user_id="([^"]+)">$/);
      if (!match) return null;
      const nextToken = inlineTokens[index + 1];
      const followingToken = inlineTokens[index + 2];
      const closeIndex =
        safeString(nextToken?.raw) === "</at>"
          ? index + 1
          : safeString(nextToken?.type) === "text" &&
              safeString(followingToken?.raw) === "</at>"
            ? index + 2
            : -1;
      if (closeIndex < 0) return null;
      elements.push({
        tag: "at",
        user_id: match[1],
        ...larkPostStyle(styles),
      });
      index = closeIndex;
      continue;
    }
    return null;
  }
  return elements;
}

function renderLarkPostBlock(token: any): any[] {
  const type = safeString(token?.type).trim();
  if (type === "paragraph" || type === "text") {
    const inline = renderLarkInlineElements(token?.tokens);
    if (inline?.length) return inline;
  }
  if (type === "heading") {
    const inline = renderLarkInlineElements(token?.tokens, ["bold"]);
    if (inline?.length) return inline;
  }
  if (type === "code") {
    const language = safeString(token?.lang).trim().split(/\s+/)[0];
    return [
      {
        tag: "code_block",
        ...(language ? { language } : {}),
        text: safeString(token?.text),
      },
    ];
  }
  if (type === "hr") return [{ tag: "hr" }];
  return [{ tag: "md", text: safeString(token?.raw) }];
}

function renderLarkPostContent(text: string) {
  const source = safeString(text).replace(/\r\n?/g, "\n");
  try {
    const tokens = Lexer.lex(source, { gfm: true }) as any[];
    const content: any[][] = [];
    let pendingBlank = false;
    let previousRaw = "";
    for (const token of tokens) {
      if (safeString(token?.type).trim() === "space") {
        pendingBlank = true;
        continue;
      }
      if (content.length && (pendingBlank || /\n{2,}$/.test(previousRaw))) {
        content.push([{ tag: "text", text: "\n" }]);
      }
      const row = renderLarkPostBlock(token);
      if (row.length) content.push(row);
      previousRaw = safeString(token?.raw);
      pendingBlank = false;
    }
    return content.length ? content : [[{ tag: "text", text: source }]];
  } catch {
    return [[{ tag: "md", text: source }]];
  }
}

function assertLarkApiSuccess(result: any) {
  const code = Number(result?.code);
  if (Number.isFinite(code) && code !== 0) {
    throw new Error(
      `lark_api_error:${code}:${safeString(result?.msg || result?.message || "unknown")}`,
    );
  }
}

function larkMentionTargetId(mention: any) {
  const nestedId =
    mention?.id && typeof mention.id === "object" ? mention.id : {};
  return safeString(
    nestedId.open_id ||
      nestedId.user_id ||
      nestedId.union_id ||
      (typeof mention?.id === "string" ? mention.id : "") ||
      mention?.open_id ||
      mention?.user_id ||
      mention?.union_id ||
      "",
  ).trim();
}

function toLarkReactionType(emoji: string) {
  const value = safeString(emoji).trim();
  return LARK_REACTION_TYPES[value] || value;
}

export class LarkAdapter {
  private readonly app: any;
  private readonly config: Record<string, any>;
  private readonly logger: any;
  private readonly cacheDir: string;
  private readonly httpTransport = createRinHttpTransport();
  private client: any = null;
  private wsClient: any = null;
  private botOpenId = "";
  private readonly inboundGate = new InboundRecoveryGate<{
    data: any;
    resolve: () => void;
    reject: (error: unknown) => void;
  }>();
  readonly bot: any;

  constructor(
    app: any,
    dataDir: string,
    config: Record<string, any>,
    logger: any,
  ) {
    this.app = app;
    this.config = config;
    this.logger = createPrefixedLogger("chat-runtime:lark", logger);
    this.cacheDir = path.join(dataDir, "chat", "runtime-cache", "lark");
    ensureDir(this.cacheDir);
    const internal: any = {
      client: null,
      wsClient: null,
      createMessage: async (options: any) =>
        await this.client?.im?.message?.create?.(options),
      getMessage: async (options: any) =>
        await this.client?.im?.message?.get?.(options),
      getChat: async (options: any) =>
        await this.client?.im?.chat?.get?.(options),
      createReaction: async (options: any) =>
        await this.client?.im?.messageReaction?.create?.(options),
      deleteReaction: async (options: any) =>
        await this.client?.im?.messageReaction?.delete?.(options),
      listReactions: async (options: any) =>
        await this.client?.im?.messageReaction?.list?.(options),
      listChatMembers: async (options: any) =>
        await this.client?.im?.chatMembers?.get?.(options),
      getMessageResource: async (options: any) =>
        await this.client?.im?.messageResource?.get?.(options),
      getUser: async (options: any) =>
        await this.client?.contact?.user?.get?.(options),
    };
    this.bot = {
      platform: "lark",
      selfId: "",
      status: 0,
      workingIndicators: [
        createReactionWorkingIndicator(() => this.bot),
        createTypingWorkingIndicator(() => this.bot),
      ],
      user: {},
      internal,
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
        emoji: string,
      ) => await this.deleteReaction(chatId, messageId, emoji),
    };
    this.app.register(this, this.bot);
  }

  async start() {
    const appId = safeString(this.config?.appId).trim();
    const appSecret = safeString(this.config?.appSecret).trim();
    if (!appId) throw new Error("lark_app_id_required");
    if (!appSecret) throw new Error("lark_app_secret_required");
    const Lark: any = await import("@larksuiteoapi/node-sdk");
    const domain =
      safeString(this.config?.platform).trim() === "lark"
        ? Lark.Domain.Lark
        : Lark.Domain.Feishu;
    this.client = new Lark.Client({
      appId,
      appSecret,
      domain,
    });
    const identityResponse = await this.client.request({
      url: "/open-apis/bot/v3/info",
      method: "GET",
    });
    assertLarkApiSuccess(identityResponse);
    const botInfo =
      identityResponse?.bot && typeof identityResponse.bot === "object"
        ? identityResponse.bot
        : identityResponse?.data?.bot &&
            typeof identityResponse.data.bot === "object"
          ? identityResponse.data.bot
          : {};
    const botOpenId = safeString(botInfo?.open_id || botInfo?.openId).trim();
    if (!botOpenId) {
      throw new Error("Lark bot identity response is missing open_id");
    }
    const botName =
      safeString(botInfo?.app_name || botInfo?.appName).trim() || appId;
    this.wsClient = new Lark.WSClient({
      appId,
      appSecret,
      domain,
      loggerLevel: Lark.LoggerLevel.info,
    });
    this.bot.internal.client = this.client;
    this.bot.internal.wsClient = this.wsClient;
    this.botOpenId = botOpenId;
    this.bot.selfId = appId;
    this.bot.user = {
      name: botName,
      username: botName,
      nick: botName,
    };
    this.inboundGate.begin();
    await this.wsClient.start({
      eventDispatcher: new Lark.EventDispatcher({}).register({
        "im.message.receive_v1": async (data: any) => {
          try {
            const chatId = this.larkInboundChatId(data);
            if (this.inboundGate.isBuffering(chatId)) {
              await new Promise<void>((resolve, reject) => {
                if (
                  !this.inboundGate.buffer(chatId, { data, resolve, reject })
                ) {
                  void this.handleMessage(data).then(resolve, reject);
                }
              });
              return;
            }
            await this.handleMessage(data);
          } catch (error: any) {
            this.logger?.warn?.(
              `message handling failed err=${safeString(error?.message || error)}`,
            );
            throw error;
          }
        },
      }),
    });
    const recoveryRetryDelaysMs = [250, 1000];
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.recoverLarkMessages(() => {
          emitBotStatus(this.app, this.bot, 1);
        });
        break;
      } catch (error: any) {
        const detail =
          safeString(error?.message || error).trim() || "catch_up_failed";
        this.bot.inboundRecovery = {
          status: "degraded",
          failures: [detail],
        };
        this.logger?.warn?.(
          `inbound recovery handling failed attempt=${attempt + 1} err=${detail}`,
        );
        const retryDelayMs = recoveryRetryDelaysMs[attempt];
        if (retryDelayMs === undefined) {
          emitBotStatus(this.app, this.bot, 1);
          break;
        }
        await sleep(retryDelayMs);
        this.inboundGate.begin();
      }
    }
  }

  async stop() {
    try {
      this.wsClient?.close?.({ force: true });
    } catch {}
    try {
      await this.httpTransport.close();
    } catch {}
    this.wsClient = null;
    this.client = null;
    this.botOpenId = "";
    emitBotStatus(this.app, this.bot, 0);
  }

  private wrapLarkHistoryMessage(message: any) {
    const sender =
      message?.sender && typeof message.sender === "object"
        ? message.sender
        : {};
    const senderId = safeString(sender?.id).trim();
    const senderIdType = safeString(sender?.id_type).trim();
    return {
      message: {
        ...message,
        message_type:
          safeString(message?.message_type || message?.msg_type).trim() ||
          undefined,
        content:
          safeString(message?.content || message?.body?.content).trim() ||
          undefined,
      },
      sender: {
        ...sender,
        sender_id:
          sender?.sender_id && typeof sender.sender_id === "object"
            ? sender.sender_id
            : compactObject({
                open_id: senderIdType === "open_id" ? senderId : undefined,
                user_id: senderIdType === "user_id" ? senderId : undefined,
                union_id: senderIdType === "union_id" ? senderId : undefined,
              }),
      },
    };
  }

  private async fetchLarkMessagesAfter(head: {
    chatKey: string;
    chatId: string;
    messageId: string;
    platformTimestamp: number;
  }) {
    const recovered: any[] = [];
    let pageToken = "";
    let foundCursor = false;
    for (;;) {
      const response = await this.client?.im?.message?.list?.({
        params: compactObject({
          container_id_type: "chat",
          container_id: head.chatId,
          start_time: String(
            Math.max(0, Math.floor(head.platformTimestamp / 1000) - 1),
          ),
          sort_type: "ByCreateTimeAsc",
          page_size: 50,
          page_token: pageToken || undefined,
        }),
      });
      assertLarkApiSuccess(response);
      const data =
        response?.data && typeof response.data === "object"
          ? response.data
          : response;
      const items = Array.isArray(data?.items) ? data.items : [];
      for (const item of items) {
        const messageId = safeString(item?.message_id).trim();
        if (!foundCursor) {
          if (messageId === head.messageId) foundCursor = true;
          continue;
        }
        recovered.push(this.wrapLarkHistoryMessage(item));
      }
      const nextToken = safeString(data?.page_token).trim();
      if (!data?.has_more || !nextToken || nextToken === pageToken) break;
      pageToken = nextToken;
    }
    if (!foundCursor) {
      throw new Error(
        `Lark message history did not return recovery cursor ${head.messageId}`,
      );
    }
    return recovered;
  }

  private larkInboundChatId(data: any) {
    return safeString(data?.message?.chat_id).trim();
  }

  private async releaseLarkReadyChats(chatIds: string[]) {
    const botId = safeString(this.bot?.selfId).trim();
    const chats = chatIds.map((chatId) => ({
      chatId,
      chatKey: composeChatKeyForBot(this.app, "lark", chatId, botId),
    }));
    for (const { chatKey } of chats) {
      if (chatKey) this.app?.beginInboundRecoveryChat?.(chatKey);
    }
    for (const { chatId, chatKey } of chats) {
      await this.finishLarkRecovery(chatId, []);
      if (chatKey) this.app?.completeInboundRecoveryChat?.(chatKey);
    }
  }

  private async recoverLarkMessages(onConfigured?: () => void) {
    const agentDir = safeString(this.app?.agentDir).trim();
    const botId = safeString(this.bot?.selfId).trim();
    if (!agentDir || !botId) {
      await this.releaseLarkReadyChats(this.inboundGate.configure([]));
      onConfigured?.();
      return;
    }
    const result = await recoverInboundHeads(
      agentDir,
      "lark",
      botId,
      async (head) => await this.fetchLarkMessagesAfter(head),
      {
        concurrency: 4,
        onHeads: async (heads) => {
          for (const head of heads) {
            this.app?.beginInboundRecoveryChat?.(head.chatKey);
          }
          this.bot.inboundRecovery = heads.length
            ? {
                status: "recovering",
                pending: heads.map((head) => head.chatKey),
              }
            : { status: "ready" };
          await this.releaseLarkReadyChats(
            this.inboundGate.configure(heads.map((head) => head.chatId)),
          );
          onConfigured?.();
        },
        onHeadSettled: async (outcome) => {
          await this.finishLarkRecovery(outcome.head.chatId, outcome.recovered);
          this.app?.completeInboundRecoveryChat?.(outcome.head.chatKey);
        },
      },
    );
    applyInboundRecoveryResult(this.bot, this.logger, result);
  }

  private mergeLarkRecoveryMessages(
    recovered: any[],
    buffered: Array<{
      data: any;
      resolve: () => void;
      reject: (error: unknown) => void;
    }>,
  ) {
    const messages = new Map<
      string,
      {
        data: any;
        sourceOrder: number;
        index: number;
        waiters: Array<{
          resolve: () => void;
          reject: (error: unknown) => void;
        }>;
      }
    >();
    for (const [index, data] of recovered.entries()) {
      const messageId = safeString(data?.message?.message_id).trim();
      if (messageId) {
        messages.set(messageId, {
          data,
          sourceOrder: 0,
          index,
          waiters: [],
        });
      }
    }
    for (const [index, entry] of buffered.entries()) {
      const messageId =
        safeString(entry.data?.message?.message_id).trim() ||
        `buffered:${index}`;
      const current = messages.get(messageId);
      if (current) {
        current.data = entry.data;
        current.waiters.push({
          resolve: entry.resolve,
          reject: entry.reject,
        });
        continue;
      }
      messages.set(messageId, {
        data: entry.data,
        sourceOrder: 1,
        index,
        waiters: [{ resolve: entry.resolve, reject: entry.reject }],
      });
    }
    return [...messages.values()].sort((left, right) => {
      const leftTime = Number(left.data?.message?.create_time || 0);
      const rightTime = Number(right.data?.message?.create_time || 0);
      return (
        leftTime - rightTime ||
        left.sourceOrder - right.sourceOrder ||
        left.index - right.index
      );
    });
  }

  private async finishLarkRecovery(chatId: string, recovered: any[]) {
    let nextRecovered = recovered;
    for (;;) {
      const buffered = this.inboundGate.drain(chatId);
      const messages = this.mergeLarkRecoveryMessages(nextRecovered, buffered);
      nextRecovered = [];
      const handledMessageIds = new Set<string>();
      for (let index = 0; index < messages.length; index += 1) {
        const entry = messages[index];
        try {
          await this.handleMessage(entry.data);
          const messageId = safeString(entry.data?.message?.message_id).trim();
          if (messageId) handledMessageIds.add(messageId);
          for (const waiter of entry.waiters) waiter.resolve();
        } catch (error) {
          for (const pending of messages.slice(index)) {
            for (const waiter of pending.waiters) waiter.reject(error);
          }
          this.inboundGate.prepend(
            chatId,
            buffered.filter(
              (pending) =>
                !handledMessageIds.has(
                  safeString(pending.data?.message?.message_id).trim(),
                ),
            ),
          );
          throw error;
        }
      }
      if (!this.inboundGate.hasPending(chatId)) break;
    }
    this.inboundGate.open(chatId);
  }

  private parseMessageContent(raw: string) {
    const text = safeString(raw).trim();
    if (!text) return { text: "", mentions: [] as any[] };
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "string")
        return { text: parsed, mentions: [] as any[] };
      return {
        text: safeString(parsed?.text || parsed?.content || "").trim() || text,
        mentions: Array.isArray(parsed?.mentions) ? parsed.mentions : [],
      };
    } catch {
      return { text, mentions: [] as any[] };
    }
  }

  private parsePostContentNodes(parsed: any) {
    const root = parsed?.zh_cn || parsed?.en_us || parsed;
    const lines = Array.isArray(root?.content) ? root.content : [];
    const nodes: any[] = [];
    for (const line of lines) {
      const parts = Array.isArray(line) ? line : [];
      for (const part of parts) {
        const tag = safeString(part?.tag).trim().toLowerCase();
        if (tag === "at") {
          nodes.push(
            normalizeNode(
              "at",
              compactObject({
                id: larkMentionTargetId(part) || undefined,
                name:
                  safeString(part?.user_name || part?.name).trim() || undefined,
              }),
            ),
          );
          continue;
        }
        if (tag === "img" || tag === "image") {
          const src = safeString(part?.image_key || part?.src).trim();
          nodes.push(
            normalizeNode(
              "image",
              compactObject({
                src: src || undefined,
                name:
                  safeString(part?.alt || part?.image_key).trim() || undefined,
              }),
            ),
          );
          continue;
        }
        if (tag === "media") {
          const src = safeString(part?.file_key || part?.src).trim();
          nodes.push(
            normalizeNode(
              "video",
              compactObject({
                src: src || undefined,
                name:
                  safeString(part?.file_name || part?.name).trim() || undefined,
                cover:
                  safeString(part?.image_key || part?.cover).trim() ||
                  undefined,
                duration: part?.duration,
              }),
            ),
          );
          continue;
        }
        const text = safeString(part?.text || part?.href || "");
        if (text) {
          nodes.push(
            normalizeNode(tag === "md" ? "markdown" : "text", {
              content: text,
            }),
          );
        }
      }
      if (parts.length) nodes.push(normalizeNode("br"));
    }
    if (nodes.at(-1)?.type === "br") nodes.pop();
    return nodes;
  }

  private parseLarkMessageContentNodes(
    msgType: string,
    rawContent: string,
    mentions: any[] = [],
  ) {
    const type = safeString(msgType).trim().toLowerCase();
    const raw = safeString(rawContent).trim();
    let parsed: any = undefined;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {}
    }
    if (type === "post") return this.parsePostContentNodes(parsed);
    if (type === "image") {
      const src = safeString(parsed?.image_key || parsed?.key || raw).trim();
      return [normalizeNode("image", compactObject({ src }))];
    }
    if (type === "file") {
      const src = safeString(parsed?.file_key || parsed?.key || raw).trim();
      const name = safeString(parsed?.file_name || parsed?.name).trim();
      return [normalizeNode("file", compactObject({ src, name }))];
    }
    if (type === "audio") {
      const src = safeString(parsed?.file_key || parsed?.key || raw).trim();
      const name = safeString(parsed?.file_name || parsed?.name).trim();
      return [
        normalizeNode(
          "audio",
          compactObject({ src, name, duration: parsed?.duration }),
        ),
      ];
    }
    if (type === "media" || type === "video") {
      const src = safeString(parsed?.file_key || parsed?.key || raw).trim();
      const name = safeString(parsed?.file_name || parsed?.name).trim();
      const cover = safeString(parsed?.image_key || parsed?.cover).trim();
      return [
        normalizeNode(
          "video",
          compactObject({ src, name, cover, duration: parsed?.duration }),
        ),
      ];
    }
    if (type === "sticker") {
      const src = safeString(parsed?.file_key || parsed?.key || raw).trim();
      return [normalizeNode("sticker", compactObject({ src }))];
    }
    const parsedText = this.parseMessageContent(raw);
    const nodes: any[] = [];
    const mentionByKey = new Map<string, any>();
    for (const mention of mentions) {
      const key = safeString(mention?.key).trim();
      if (key) mentionByKey.set(key, mention);
    }
    const pattern = /(@_[a-zA-Z0-9_-]+)/g;
    let cursor = 0;
    for (const match of parsedText.text.matchAll(pattern)) {
      const index = typeof match.index === "number" ? match.index : cursor;
      const before = parsedText.text.slice(cursor, index);
      if (before) nodes.push(normalizeNode("text", { content: before }));
      cursor = index + safeString(match[0]).length;
      const mention = mentionByKey.get(safeString(match[1]).trim());
      if (mention) {
        nodes.push(
          normalizeNode(
            "at",
            compactObject({
              id: larkMentionTargetId(mention) || undefined,
              name: safeString(mention?.name).trim() || undefined,
            }),
          ),
        );
      } else {
        nodes.push(normalizeNode("text", { content: safeString(match[0]) }));
      }
    }
    const tail = parsedText.text.slice(cursor);
    if (tail) nodes.push(normalizeNode("text", { content: tail }));
    return nodes.length
      ? nodes
      : raw
        ? [normalizeNode("text", { content: raw })]
        : [];
  }

  private pickLarkMessageItems(response: any) {
    const candidates = [response?.data?.items, response?.items];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) return candidate;
    }
    return [] as any[];
  }

  private larkForwardSenderName(message: any) {
    const sender =
      message?.sender && typeof message.sender === "object"
        ? message.sender
        : {};
    return (
      safeString(sender?.id).trim() ||
      safeString(sender?.sender_id?.open_id).trim() ||
      safeString(sender?.sender_id?.user_id).trim() ||
      safeString(message?.message_id).trim() ||
      "unknown"
    );
  }

  private async buildLarkForwardNode(message: any) {
    const id = safeString(message?.message_id).trim();
    let items: any[] = [];
    if (id) {
      try {
        const response = await this.client?.im?.message?.get?.({
          path: { message_id: id },
          params: { user_id_type: "open_id" },
        });
        assertLarkApiSuccess(response);
        items = this.pickLarkMessageItems(response);
      } catch (error: any) {
        this.logger?.warn?.(
          `get lark merged forward failed id=${id} err=${safeString(error?.message || error)}`,
        );
      }
    }
    const children: any[] = [];
    for (const item of items) {
      if (safeString(item?.message_id).trim() === id) continue;
      const body = item?.body && typeof item.body === "object" ? item.body : {};
      const nodes = this.parseLarkMessageContentNodes(
        safeString(item?.msg_type).trim(),
        safeString(body?.content || item?.content || ""),
        Array.isArray(item?.mentions) ? item.mentions : [],
      );
      const rendered = renderMarkdownFromNodes(nodes).trim();
      children.push(
        normalizeNode("text", {
          content: `${this.larkForwardSenderName(item)}: ${rendered || "[unsupported message]"}\n`,
        }),
      );
    }
    return normalizeNode(
      "forward",
      compactObject({
        id,
        title: "merged forward",
        count: children.length ? String(children.length) : undefined,
      }),
      children,
    );
  }

  private async cacheLarkMessageResource(
    messageId: string,
    fileKey: string,
    resourceType: "image" | "file",
    rawName = "",
  ) {
    if (!messageId || !fileKey) return null;
    const response = await this.client?.im?.messageResource?.get?.({
      path: { message_id: messageId, file_key: fileKey },
      params: { type: resourceType },
    });
    assertLarkApiSuccess(response);
    if (!response || typeof response.writeFile !== "function") return null;
    const mimeType = safeString(
      response.headers?.["content-type"] ||
        response.headers?.["Content-Type"] ||
        "",
    )
      .split(";", 1)[0]
      .trim();
    const name = ensureExtension(
      ensureFileName(rawName || `${resourceType}-${fileKey}`),
      mimeType,
    );
    const fullPath = path.join(this.cacheDir, `${Date.now()}-${name}`);
    await response.writeFile(fullPath);
    return { path: fullPath, name, mimeType };
  }

  private async resolveLarkMessageResources(messageId: string, nodes: any[]) {
    const resolved: any[] = [];
    for (const node of nodes) {
      const type = safeString(node?.type).trim().toLowerCase();
      if (!["image", "file", "audio", "video"].includes(type)) {
        resolved.push(node);
        continue;
      }
      const attrs =
        node?.attrs && typeof node.attrs === "object" ? node.attrs : {};
      const src = safeString(
        attrs.src || attrs.url || attrs.file || attrs.path || "",
      ).trim();
      if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src)) {
        resolved.push(node);
        continue;
      }
      const resourceType = type === "image" ? "image" : "file";
      try {
        const cached = await this.cacheLarkMessageResource(
          messageId,
          src,
          resourceType,
          safeString(attrs.name || attrs.file || src).trim(),
        );
        if (cached) {
          resolved.push(
            normalizeNode(
              type,
              compactObject({
                ...attrs,
                src: fileUrl(cached.path),
                file: cached.name,
                name: cached.name,
                mime: cached.mimeType || undefined,
                mimeType: cached.mimeType || undefined,
              }),
            ),
          );
          continue;
        }
      } catch (error: any) {
        this.logger?.warn?.(
          `get lark message resource failed id=${messageId} key=${src} type=${resourceType} err=${safeString(error?.message || error)}`,
        );
      }
      resolved.push(
        normalizeNode(
          type,
          compactObject({ ...attrs, src: undefined, file: undefined }),
        ),
      );
    }
    return resolved;
  }

  async createReaction(_chatId: string, messageId: string, emoji: string) {
    const emojiType = toLarkReactionType(emoji);
    if (!emojiType) throw new Error("lark_reaction_emoji_required");
    const result = await this.client.im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emojiType } },
    });
    assertLarkApiSuccess(result);
    return true;
  }

  async deleteReaction(_chatId: string, messageId: string, emoji: string) {
    const emojiType = toLarkReactionType(emoji);
    if (!emojiType) throw new Error("lark_reaction_emoji_required");
    const listed = await this.client.im.messageReaction.list({
      path: { message_id: messageId },
      params: { reaction_type: emojiType, page_size: 50 },
    });
    assertLarkApiSuccess(listed);
    const items = Array.isArray(listed?.data?.items) ? listed.data.items : [];
    const reaction =
      items.find(
        (item: any) =>
          safeString(item?.reaction_type?.emoji_type).trim() === emojiType &&
          safeString(item?.operator?.operator_type).trim() === "app",
      ) || items[0];
    const reactionId = safeString(reaction?.reaction_id).trim();
    if (!reactionId) return false;
    const result = await this.client.im.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    });
    assertLarkApiSuccess(result);
    return true;
  }

  private renderOutboundText(nodes: any[]) {
    return normalizeLarkMarkdownListBlocks(
      renderMarkdownFromNodes(nodes, {
        renderAt(attrs) {
          const id = safeString(attrs.id).trim();
          const name = safeString(attrs.name).trim();
          return id
            ? `<at user_id="${escapeLarkTagAttr(id)}">${escapeLarkTagText(name)}</at>`
            : name;
        },
      }),
    );
  }

  private buildPostData(text: string) {
    return {
      msg_type: "post",
      content: JSON.stringify({
        zh_cn: {
          content: renderLarkPostContent(text),
        },
      }),
    };
  }

  private async sendData(
    chatId: string,
    data: Record<string, any>,
    replyToMessageId?: string,
  ) {
    const result = replyToMessageId
      ? await this.client.im.message.reply({
          path: { message_id: replyToMessageId },
          data,
        })
      : await this.client.im.message.create({
          params: {
            receive_id_type: "chat_id",
          },
          data: {
            receive_id: chatId,
            ...data,
          },
        });
    try {
      assertLarkApiSuccess(result);
    } catch (error) {
      throw confirmedChatDeliveryError(error);
    }
    return [
      safeString(result?.data?.message_id || result?.message_id || "").trim(),
    ].filter(Boolean);
  }

  private async sendPostText(
    chatId: string,
    text: string,
    replyToMessageId?: string,
  ) {
    if (!text) throw new Error("lark_send_message_empty");
    return await this.sendData(
      chatId,
      this.buildPostData(text),
      replyToMessageId,
    );
  }

  private async sendPlainText(
    chatId: string,
    text: string,
    replyToMessageId?: string,
  ) {
    if (!text) throw new Error("lark_send_message_empty");
    return await this.sendData(
      chatId,
      {
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
      replyToMessageId,
    );
  }

  private assertLarkResourceSize(
    data: Buffer,
    label: "Lark image" | "Lark file",
    maxBytes: number,
    limitText: string,
  ) {
    if (!data.length) throw new Error(`${label} content is empty`);
    if (data.length > maxBytes) {
      throw new Error(`${label} exceeds the ${limitText} upload limit`);
    }
  }

  private assertLarkImageSize(image: Buffer) {
    this.assertLarkResourceSize(
      image,
      "Lark image",
      LARK_MAX_IMAGE_BYTES,
      "10 MB",
    );
  }

  private assertLarkFileSize(file: Buffer) {
    this.assertLarkResourceSize(
      file,
      "Lark file",
      LARK_MAX_FILE_BYTES,
      "30 MB",
    );
  }

  private async downloadLarkResource(
    url: string,
    label: "Lark image" | "Lark file",
    maxBytes: number,
    limitText: string,
  ) {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, LARK_RESOURCE_DOWNLOAD_TIMEOUT_MS);
    timeout.unref?.();
    let response: any;
    try {
      response = await this.httpTransport.fetch(url, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          `Failed to download ${label} (HTTP ${response.status})`,
        );
      }
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        controller.abort();
        throw new Error(`${label} exceeds the ${limitText} upload limit`);
      }
      if (!response.body) throw new Error(`${label} content is empty`);
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          controller.abort();
          throw new Error(`${label} exceeds the ${limitText} upload limit`);
        }
        chunks.push(Buffer.from(value));
      }
      const data = Buffer.concat(chunks, size);
      this.assertLarkResourceSize(data, label, maxBytes, limitText);
      return data;
    } catch (error: any) {
      const message = safeString(error?.message || error).trim();
      if (
        message.startsWith(`${label} `) ||
        message.startsWith(`Failed to download ${label}`)
      ) {
        throw error;
      }
      if (timedOut) {
        throw new Error(`${label} download timed out after 30 seconds`);
      }
      throw new Error(
        `Failed to download ${label}: ${message || "network error"}`,
      );
    } finally {
      clearTimeout(timeout);
      await discardRinHttpResponseBody(response);
    }
  }

  private async downloadLarkImage(url: string) {
    return await this.downloadLarkResource(
      url,
      "Lark image",
      LARK_MAX_IMAGE_BYTES,
      "10 MB",
    );
  }

  private async downloadLarkFile(url: string) {
    return await this.downloadLarkResource(
      url,
      "Lark file",
      LARK_MAX_FILE_BYTES,
      "30 MB",
    );
  }

  private async assertLarkLocalResourceSourceSize(
    node: any,
    label: "Lark image" | "Lark file",
    maxBytes: number,
    limitText: string,
  ) {
    const attrs =
      node?.attrs && typeof node.attrs === "object" ? node.attrs : {};
    if (Buffer.isBuffer(attrs.data)) {
      this.assertLarkResourceSize(attrs.data, label, maxBytes, limitText);
      return;
    }
    const src = safeString(attrs.src || attrs.url || "").trim();
    if (!src || /^https?:\/\//i.test(src)) return;
    const filePath = src.startsWith("file://")
      ? fileURLToPath(src)
      : path.resolve(src);
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.size > maxBytes) {
        throw new Error(`${label} exceeds the ${limitText} upload limit`);
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  private async assertLarkLocalImageSourceSize(node: any) {
    await this.assertLarkLocalResourceSourceSize(
      node,
      "Lark image",
      LARK_MAX_IMAGE_BYTES,
      "10 MB",
    );
  }

  private async assertLarkLocalFileSourceSize(node: any) {
    await this.assertLarkLocalResourceSourceSize(
      node,
      "Lark file",
      LARK_MAX_FILE_BYTES,
      "30 MB",
    );
  }

  private async sendImage(
    chatId: string,
    node: any,
    replyToMessageId?: string,
  ) {
    await this.assertLarkLocalImageSourceSize(node);
    const payload = await readBinaryFromNode(node);
    if (!payload) throw new Error("Lark image content is empty");
    const image = payload.data
      ? payload.data
      : payload.url
        ? await this.downloadLarkImage(payload.url)
        : Buffer.alloc(0);
    this.assertLarkImageSize(image);
    const uploaded = await this.client.im.image.create({
      data: { image_type: "message", image },
    });
    assertLarkApiSuccess(uploaded);
    const imageKey = safeString(
      uploaded?.image_key || uploaded?.data?.image_key || "",
    ).trim();
    if (!imageKey) throw new Error("Lark image upload returned no image key");
    return await this.sendData(
      chatId,
      {
        msg_type: "image",
        content: JSON.stringify({ image_key: imageKey }),
      },
      replyToMessageId,
    );
  }

  private async sendFile(chatId: string, node: any, replyToMessageId?: string) {
    await this.assertLarkLocalFileSourceSize(node);
    const payload = await readBinaryFromNode(node);
    if (!payload) throw new Error("Lark file content is empty");
    const file = payload.data
      ? payload.data
      : payload.url
        ? await this.downloadLarkFile(payload.url)
        : Buffer.alloc(0);
    this.assertLarkFileSize(file);
    const uploaded = await this.client.im.file.create({
      data: {
        file_type: larkFileType(payload.name, payload.mimeType),
        file_name: payload.name,
        file,
      },
    });
    assertLarkApiSuccess(uploaded);
    const fileKey = safeString(
      uploaded?.file_key || uploaded?.data?.file_key || "",
    ).trim();
    if (!fileKey) throw new Error("Lark file upload returned no file key");
    return await this.sendData(
      chatId,
      {
        msg_type: "file",
        content: JSON.stringify({ file_key: fileKey }),
      },
      replyToMessageId,
    );
  }

  private async sendMessage(
    chatId: string,
    content: any,
    _options: Record<string, any> = {},
  ) {
    const { work, replyToMessageId } = prepareOutboundNodes(content);
    if (!work.length) throw new Error("lark_send_message_empty");
    const delivered: string[] = [];
    const failures: unknown[] = [];
    const recordFailure = async (error: unknown, nodes: any[]) => {
      this.logger.warn(
        `rich message segment failed err=${safeString((error as any)?.message || error)}`,
      );
      const fallback = renderRichDeliveryFallback(nodes);
      if (!fallback) {
        failures.push(error);
        return;
      }
      try {
        const fallbackIds = await this.sendPlainText(
          chatId,
          fallback,
          replyToMessageId,
        );
        if (!fallbackIds.length) {
          failures.push(
            richFallbackDeliveryError(
              error,
              new Error("lark_rich_fallback_empty_result"),
            ),
          );
          return;
        }
        delivered.push(...fallbackIds);
      } catch (fallbackError: any) {
        failures.push(richFallbackDeliveryError(error, fallbackError));
        this.logger.warn(
          `rich fallback delivery failed err=${safeString(fallbackError?.message || fallbackError)}`,
        );
      }
    };
    let cursor = 0;
    while (cursor < work.length) {
      const type = safeString(work[cursor]?.type).trim().toLowerCase();
      let messageIds: string[] = [];
      if (type === "image" || type === "file") {
        try {
          messageIds =
            type === "image"
              ? await this.sendImage(chatId, work[cursor], replyToMessageId)
              : await this.sendFile(chatId, work[cursor], replyToMessageId);
        } catch (error) {
          await recordFailure(error, [work[cursor]]);
        }
        cursor += 1;
      } else {
        const textNodes: any[] = [];
        while (cursor < work.length) {
          const textType = safeString(work[cursor]?.type).trim().toLowerCase();
          if (textType === "image" || textType === "file") break;
          textNodes.push(work[cursor]);
          cursor += 1;
        }
        try {
          const text = this.renderOutboundText(textNodes);
          if (text) {
            messageIds = await this.sendPostText(
              chatId,
              text,
              replyToMessageId,
            );
          }
        } catch (error) {
          await recordFailure(error, textNodes);
        }
      }
      delivered.push(...messageIds);
    }
    if (failures.length) {
      if (delivered.length)
        throw partialChatDeliveryError(failures[0], delivered);
      throw failures[0];
    }
    if (delivered.length) return delivered;
    throw new Error("lark_send_message_empty");
  }

  private async handleMessage(data: any) {
    const message =
      data?.message && typeof data.message === "object" ? data.message : {};
    const sender =
      data?.sender && typeof data.sender === "object" ? data.sender : {};
    const senderType = safeString(sender?.sender_type).trim().toLowerCase();
    if (senderType === "app" || senderType === "bot") return;
    const senderId = safeString(
      sender?.sender_id?.open_id ||
        sender?.sender_id?.user_id ||
        sender?.sender_id?.union_id ||
        sender?.id ||
        (typeof sender?.sender_id === "string" ? sender.sender_id : ""),
    ).trim();
    if (!senderId) return;
    const msgType = safeString(
      message?.message_type || message?.msg_type || "",
    ).trim();
    const parsed = this.parseMessageContent(safeString(message?.content || ""));
    const mentions = Array.isArray(message?.mentions)
      ? message.mentions
      : parsed.mentions;
    const mentionSelf = mentions.some(
      (item: any) =>
        Boolean(this.botOpenId) && larkMentionTargetId(item) === this.botOpenId,
    );
    const isForward = msgType === "merge_forward";
    const rawElements = isForward
      ? [await this.buildLarkForwardNode(message)]
      : this.parseLarkMessageContentNodes(
          msgType,
          safeString(message?.content || ""),
          mentions,
        );
    const elements = isForward
      ? rawElements
      : await this.resolveLarkMessageResources(
          safeString(message?.message_id || "").trim(),
          rawElements,
        );
    const renderedContent = renderPlainTextFromNodes(elements).trim();
    const strippedContent = isForward
      ? renderedContent
      : renderedContent || parsed.text;
    const isDirect =
      safeString(message?.chat_type || "")
        .trim()
        .toLowerCase() === "p2p";
    const nickname =
      safeString(sender?.sender_type).trim() === "user"
        ? safeString(sender?.sender_id?.open_id || "").trim()
        : undefined;
    const canonicalElements = prependChatQuoteNode(
      elements,
      message?.parent_id,
    );
    this.app.emit("message", {
      platform: "lark",
      selfId: safeString(this.bot?.selfId).trim() || undefined,
      bot: this.bot,
      messageId: safeString(message?.message_id || "").trim(),
      timestamp: Number.isFinite(Number(safeString(message?.create_time || "")))
        ? Number(safeString(message.create_time))
        : Date.now(),
      userId: senderId,
      author: {
        userId: senderId,
        name: nickname,
        nick: nickname,
      },
      user: {
        id: senderId,
        userId: senderId,
        name: nickname,
        nick: nickname,
      },
      channelId: safeString(message?.chat_id || "").trim(),
      guildId: !isDirect
        ? safeString(message?.chat_id || "").trim() || undefined
        : undefined,
      guildName: undefined,
      isDirect,
      content: strippedContent,
      stripped: {
        appel: mentionSelf,
        content: strippedContent,
      },
      elements: canonicalElements,
    });
  }
}
