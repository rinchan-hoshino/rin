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
  parseOneBotSegments,
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

export function escapeOneBotText(value: string) {
  return safeString(value)
    .replace(/&/g, "&amp;")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;")
    .replace(/,/g, "&#44;");
}

export const NAPCAT_ONEBOT_EMOJI_ID_OVERRIDES: Record<string, string> = {
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

export function toOneBotReactionEmojiId(value: string) {
  const emoji = safeString(value).trim();
  if (!emoji) return "";
  const mapped = NAPCAT_ONEBOT_EMOJI_ID_OVERRIDES[emoji];
  if (mapped) return mapped;
  const [first] = Array.from(emoji);
  if (!first) return "";
  const codePoint = first.codePointAt(0);
  return Number.isFinite(codePoint) ? String(codePoint) : "";
}

export function isOneBotGroupChatId(chatId: string) {
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

export function isOneBotTimeoutParamAction(action: string) {
  return /^(send_private_msg|send_group_msg|send_msg|upload_private_file|upload_group_file)$/.test(
    safeString(action).trim(),
  );
}

export function oneBotParamsText(params: any) {
  if (!params || typeof params !== "object") return safeString(params);
  const parts = [safeString(params.message), safeString(params.file)];
  try {
    parts.push(JSON.stringify(params));
  } catch {}
  return parts.join("\n");
}

export function oneBotParamsReferenceMedia(action: string, params: any) {
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

export function oneBotFailureText(payload: any) {
  return safeString(
    payload?.wording ||
      payload?.msg ||
      payload?.message ||
      "onebot_action_failed",
  );
}

export function isOneBotLocalMediaVisibilityFailure(
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

export class OneBotAdapter {
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
