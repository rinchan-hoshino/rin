import WebSocket from "ws";
import { WORKING_REACTION_EMOJI } from "../chat/transport.js";
import {
  compactObject,
  confirmedChatDeliveryError,
  createPrefixedLogger,
  emitBotStatus,
  ensureExtension,
  ensureFileName,
  flattenNodes,
  normalizeNode,
  partialChatDeliveryError,
  prependChatQuoteNode,
  prepareOutboundNodes,
  readBinaryFromNode,
  renderMarkdownFromNodes,
  renderPlainTextFromNodes,
  renderRichDeliveryFallback,
  richFallbackDeliveryError,
  resolveChatRuntimeWorkingCopy,
  safeString,
  sleep,
} from "./common.js";
import type { ChatRuntimeApp } from "./app.js";

function toSnakeCase(value: string) {
  return safeString(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

function parseOneBotReplyQuoteId(data: Record<string, any>) {
  return safeString(data?.id || data?.message_id || "").trim();
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

export function formatOneBotActionFailureMessage(payload: any) {
  return oneBotFailureText(payload) || "onebot_action_failed";
}

export function oneBotActionRejectedError(payload: any) {
  const error: any = confirmedChatDeliveryError(
    new Error(formatOneBotActionFailureMessage(payload)),
  );
  error.oneBotActionRejected = true;
  return error;
}

function oneBotNodesContainMedia(nodes: any[]): boolean {
  return flattenNodes(nodes).some((node) => {
    const type = safeString(node?.type).trim().toLowerCase();
    if (
      [
        "image",
        "audio",
        "voice",
        "record",
        "video",
        "file",
        "sticker",
      ].includes(type)
    ) {
      return true;
    }
    return (
      Array.isArray(node?.children) && oneBotNodesContainMedia(node.children)
    );
  });
}

export class OneBotAdapter {
  private readonly app: ChatRuntimeApp;
  private readonly config: Record<string, any>;
  private readonly logger: any;
  private ws: WebSocket | null = null;
  private loopPromise: Promise<void> | null = null;
  private stopped = false;
  private nextEchoId = 1;
  private readonly workingReactions = new Map<string, string>();
  private workingText: string;
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
    _dataDir: string,
    config: Record<string, any>,
    logger: any,
  ) {
    this.app = app;
    this.config = config;
    this.logger = createPrefixedLogger("chat-runtime:onebot", logger);
    this.workingText = resolveChatRuntimeWorkingCopy().workingText;
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
          getGroupMemberList: (groupId: string | number) =>
            this.callAction("get_group_member_list", {
              group_id: Number(groupId),
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

  setWorkingText(text: string) {
    this.workingText =
      safeString(text).trim() || resolveChatRuntimeWorkingCopy().workingText;
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
        emitBotStatus(this.app, this.bot, 1);
        await new Promise<void>((resolve) => {
          this.ws?.once("close", () => resolve());
        });
      } catch (error: any) {
        if (!this.stopped) {
          const detail =
            safeString(error?.message || error).trim() || "connect_failed";
          this.logger.warn(`connect failed err=${detail}`);
        }
      } finally {
        emitBotStatus(this.app, this.bot, 0);
        this.rejectPending(new Error("onebot_disconnected"));
        const ws = this.ws;
        this.ws = null;
        try {
          ws?.close();
        } catch {}
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
        pending.reject(oneBotActionRejectedError(payload));
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
      this.pending.set(echo, { resolve, reject, timer });
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

  private async normalizeOutboundMedia(node: any, _type: "image" | "file") {
    const payload = await readBinaryFromNode(node);
    if (!payload) return "";
    if (payload.url) return payload.url;
    return `base64://${payload.data.toString("base64")}`;
  }

  private async renderOutboundNode(node: any) {
    const type = safeString(node?.type).toLowerCase();
    const attrs =
      node?.attrs && typeof node.attrs === "object" ? node.attrs : {};
    if (type === "quote") {
      const id = safeString(attrs.id).trim();
      return id ? [{ type: "reply", data: { id } }] : [];
    }
    if (type === "text") {
      const text = safeString(attrs.content);
      return text ? [{ type: "text", data: { text } }] : [];
    }
    if (type === "markdown" || type === "md" || type === "html") {
      const text = renderPlainTextFromNodes([node]);
      return text ? [{ type: "text", data: { text } }] : [];
    }
    if (type === "at") {
      const qq = safeString(attrs.id).trim();
      return qq ? [{ type: "at", data: { qq } }] : [];
    }
    if (type === "br") return [{ type: "text", data: { text: "\n" } }];
    if (type === "image") {
      const file = await this.normalizeOutboundMedia(node, "image");
      return file ? [{ type: "image", data: { file } }] : [];
    }
    if (type === "audio" || type === "voice" || type === "record") {
      const file = await this.normalizeOutboundMedia(node, "file");
      return file ? [{ type: "record", data: { file } }] : [];
    }
    if (type === "video") {
      const file = await this.normalizeOutboundMedia(node, "file");
      return file ? [{ type: "video", data: { file } }] : [];
    }
    if (type === "file" || type === "sticker") {
      const file = await this.normalizeOutboundMedia(node, "file");
      return file ? [{ type: "file", data: { file } }] : [];
    }
    const children = Array.isArray(node?.children) ? node.children : [];
    return children.length ? await this.renderOutboundMessage(children) : [];
  }

  private async renderOutboundMessage(nodes: any[]) {
    const segments: Array<{ type: string; data: Record<string, string> }> = [];
    for (const node of nodes) {
      try {
        segments.push(...(await this.renderOutboundNode(node)));
      } catch (error: any) {
        this.logger.warn(
          `rich message segment failed err=${safeString(error?.message || error)}`,
        );
        const fallback = renderRichDeliveryFallback([node]);
        if (!fallback) throw error;
        segments.push({ type: "text", data: { text: fallback } });
      }
    }
    return segments;
  }

  private sendMessage(chatId: string, content: any, _options?: any) {
    let resolveDispatched: () => void = () => {};
    let rejectDispatched: (error: unknown) => void = () => {};
    let dispatchExposed = false;
    const dispatched = new Promise<void>((resolve, reject) => {
      resolveDispatched = resolve;
      rejectDispatched = reject;
    });
    void dispatched.catch(() => {});
    const task = (async () => {
      try {
        const { work, replyToMessageId } = prepareOutboundNodes(content);
        const isFileNode = (node: any) =>
          safeString(node?.type).trim().toLowerCase() === "file";
        const fragments: Array<
          { kind: "message"; nodes: any[] } | { kind: "file"; node: any }
        > = [];
        for (const node of work) {
          if (isFileNode(node)) {
            fragments.push({ kind: "file", node });
            continue;
          }
          const previous = fragments.at(-1);
          if (previous?.kind === "message") {
            previous.nodes.push(node);
          } else {
            fragments.push({ kind: "message", nodes: [node] });
          }
        }
        const isPrivate = safeString(chatId).startsWith("private:");
        const targetId = Number(
          safeString(chatId)
            .replace(/^private:/, "")
            .trim(),
        );
        const messageAction = isPrivate ? "send_private_msg" : "send_group_msg";
        const exposeDispatch = (actionTask: any) => {
          if (dispatchExposed) return;
          dispatchExposed = true;
          if (actionTask?.dispatched) {
            void actionTask.dispatched.then(
              resolveDispatched,
              rejectDispatched,
            );
          } else {
            resolveDispatched();
          }
        };
        const call = async (action: string, params: Record<string, any>) => {
          const actionTask: any = this.callAction(
            action,
            withOneBotActionTimeoutParam(action, params),
          );
          exposeDispatch(actionTask);
          return await actionTask;
        };
        const sendSegments = async (
          message: Array<{ type: string; data: Record<string, string> }>,
        ) => {
          const params = isPrivate
            ? {
                user_id: targetId,
                message,
              }
            : {
                group_id: targetId,
                message,
              };
          const data: any = await call(messageAction, params);
          const messageId = safeString(data?.message_id || data).trim();
          if (!messageId) throw new Error("onebot_send_message_empty_result");
          return messageId;
        };
        const delivered: string[] = [];
        let replyAttached = false;
        const takeReply = () => {
          if (replyAttached || !replyToMessageId) return [];
          replyAttached = true;
          return [{ type: "reply", data: { id: replyToMessageId } }];
        };
        for (const fragment of fragments) {
          if (fragment.kind === "message") {
            const message = await this.renderOutboundMessage(fragment.nodes);
            if (!message.length) continue;
            const reply = takeReply();
            try {
              delivered.push(await sendSegments([...reply, ...message]));
              continue;
            } catch (error: any) {
              let deliveryError = error;
              if (
                error?.oneBotActionRejected &&
                oneBotNodesContainMedia(fragment.nodes)
              ) {
                const fallback = renderRichDeliveryFallback(fragment.nodes);
                if (fallback) {
                  this.logger.warn(
                    `rich message send failed; falling back to plain text err=${safeString(error?.message || error)}`,
                  );
                  try {
                    delivered.push(
                      await sendSegments([
                        ...reply,
                        { type: "text", data: { text: fallback } },
                      ]),
                    );
                    continue;
                  } catch (fallbackError) {
                    deliveryError = richFallbackDeliveryError(
                      error,
                      fallbackError,
                    );
                  }
                }
              }
              if (delivered.length) {
                throw partialChatDeliveryError(deliveryError, delivered);
              }
              throw deliveryError;
            }
          }
          let uploadError: unknown;
          try {
            const payload = await readBinaryFromNode(fragment.node);
            if (!payload) throw new Error("onebot_file_source_empty");
            const attrs =
              fragment.node?.attrs && typeof fragment.node.attrs === "object"
                ? fragment.node.attrs
                : {};
            const requestedName = ensureExtension(
              ensureFileName(
                safeString(attrs.name).trim() || payload.name,
                "file",
              ),
              payload.mimeType,
            );
            const source = payload.url
              ? payload.url
              : `base64://${payload.data.toString("base64")}`;
            const uploadAction = isPrivate
              ? "upload_private_file"
              : "upload_group_file";
            const uploadParams = isPrivate
              ? {
                  user_id: targetId,
                  file: source,
                  name: requestedName,
                  upload_file: true,
                }
              : {
                  group_id: targetId,
                  file: source,
                  name: requestedName,
                  upload_file: true,
                };
            const data: any = await call(uploadAction, uploadParams);
            const fileId = safeString(
              data?.file_id || data?.message_id || data,
            ).trim();
            if (!fileId) throw new Error("onebot_upload_file_empty_result");
            delivered.push(fileId);
            continue;
          } catch (error) {
            uploadError = error;
          }
          const fallback = renderRichDeliveryFallback([fragment.node]);
          if (fallback) {
            this.logger.warn(
              `file upload failed; falling back to plain text err=${safeString((uploadError as any)?.message || uploadError)}`,
            );
            try {
              delivered.push(
                await sendSegments([
                  ...takeReply(),
                  { type: "text", data: { text: fallback } },
                ]),
              );
              continue;
            } catch (fallbackError) {
              uploadError = richFallbackDeliveryError(
                uploadError,
                fallbackError,
              );
            }
          }
          if (delivered.length) {
            throw partialChatDeliveryError(uploadError, delivered);
          }
          throw uploadError;
        }
        if (!delivered.length) throw new Error("onebot_send_message_empty");
        return delivered;
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
    const message = [
      ...(replyToMessageId
        ? [{ type: "reply", data: { id: replyToMessageId } }]
        : []),
      { type: "text", data: { text: this.workingText } },
    ];
    await this.callAction("send_private_msg", {
      user_id: targetId,
      message,
    });
    return true;
  }

  async tickGroupWorkingReaction(context: any) {
    const chatId = safeString(context?.chatId).trim();
    const messageId = safeString(context?.messageId).trim();
    if (!isOneBotGroupChatId(chatId) || !messageId) return false;
    if (context?.workingStarted === false) return true;
    const key = `${chatId}:${messageId}`;
    if (this.workingReactions.has(key)) return true;
    await this.createReaction(chatId, messageId, WORKING_REACTION_EMOJI);
    this.workingReactions.set(key, WORKING_REACTION_EMOJI);
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
    let quoteMessageId = "";
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
        quoteMessageId = parseOneBotReplyQuoteId(data);
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
    const canonicalElements = prependChatQuoteNode(elements, quoteMessageId);
    return {
      platform: "onebot",
      selfId: selfId || undefined,
      bot: this.bot,
      messageId: safeString(payload?.message_id).trim(),
      providerCursor:
        safeString(payload?.message_seq || payload?.message_id).trim() ||
        undefined,
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
      elements: canonicalElements,
    };
  }
}
