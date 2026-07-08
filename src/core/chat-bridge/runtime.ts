import path from "node:path";

import { chatDataPath } from "../data-layout.js";
import {
  enqueueChatOutboxPayload,
  readChatOutboxItemById,
  type ChatMessagePart,
} from "../rin-lib/chat-outbox.js";
import { formatLocalDateOnly } from "../chat/date.js";
import { readChatLog } from "../chat/chat-log.js";
import { normalizeChatMessageLookup } from "../chat/message-store.js";
import {
  findBot,
  inferChatType,
  loadIdentity,
  parseChatKey,
  setIdentityTrust,
  trustOf,
} from "../chat/support.js";
import { appendJsonLineSync } from "../platform/fs.js";
import { drainChatOutbox } from "../chat/boot.js";
import { readSessionMetadata } from "../session/metadata.js";
import { serializeBridgeValue } from "./eval.js";
import { nowIso } from "../time-utils.js";
import { safeString } from "../text-utils.js";

function normalizeMessageParts(input: unknown): ChatMessagePart[] {
  if (typeof input === "string") {
    return input ? [{ type: "text", text: input }] : [];
  }
  if (Array.isArray(input)) {
    return input
      .map((item) => normalizeSinglePart(item))
      .filter(Boolean) as ChatMessagePart[];
  }
  const raw = input as any;
  if (Array.isArray(raw?.parts)) return normalizeMessageParts(raw.parts);
  const single = normalizeSinglePart(raw);
  return single ? [single] : [];
}

function normalizeSinglePart(input: any): ChatMessagePart | null {
  const type = safeString(input?.type).trim();
  if (type === "text") {
    return { type: "text", text: safeString(input?.text) };
  }
  if (type === "markdown") {
    return { type, text: safeString(input?.text ?? input?.content) };
  }
  if (type === "at") {
    const id = safeString(input?.id).trim();
    if (!id) throw new Error("chat_bridge_at_id_required");
    return {
      type: "at",
      id,
      name: safeString(input?.name).trim() || undefined,
    };
  }
  if (type === "quote") {
    return { type: "quote", id: safeString(input?.id).trim() };
  }
  if (type === "image") {
    return {
      type: "image",
      path: safeString(input?.path).trim() || undefined,
      url: safeString(input?.url).trim() || undefined,
      mimeType: safeString(input?.mimeType).trim() || undefined,
    };
  }
  if (type === "file") {
    return {
      type: "file",
      path: safeString(input?.path).trim() || undefined,
      url: safeString(input?.url).trim() || undefined,
      name: safeString(input?.name).trim() || undefined,
      mimeType: safeString(input?.mimeType).trim() || undefined,
    };
  }
  if (type === "video" || type === "audio" || type === "sticker") {
    return {
      type,
      path: safeString(input?.path).trim() || undefined,
      url: safeString(input?.url).trim() || undefined,
      name: safeString(input?.name).trim() || undefined,
      mimeType: safeString(input?.mimeType).trim() || undefined,
    };
  }
  if (safeString(input?.text)) {
    return { type: "text", text: safeString(input.text) };
  }
  return null;
}

function prependQuote(
  parts: ChatMessagePart[],
  replyToMessageId = "",
): ChatMessagePart[] {
  const nextReplyToMessageId = safeString(replyToMessageId).trim();
  if (!nextReplyToMessageId) return parts;
  if (parts.some((item) => item.type === "quote")) return parts;
  return [{ type: "quote", id: nextReplyToMessageId }, ...parts];
}

function createMethodFacade(
  target: any,
  options: {
    safeFields?: string[];
    allowedMethods?: string[] | null;
  } = {},
) {
  const safeFieldSet = new Set(options.safeFields || []);
  const allowedMethodSet = Array.isArray(options.allowedMethods)
    ? new Set(options.allowedMethods)
    : null;
  return new Proxy(
    {},
    {
      get(_obj, prop) {
        if (prop === Symbol.toStringTag) return "ChatBridgeFacade";
        if (typeof prop !== "string") return undefined;
        if (safeFieldSet.has(prop)) return target?.[prop];
        if (allowedMethodSet && !allowedMethodSet.has(prop)) return undefined;
        const value = target?.[prop];
        if (typeof value !== "function") return undefined;
        return (...args: unknown[]) => value.apply(target, args);
      },
      has(_obj, prop) {
        if (typeof prop !== "string") return false;
        if (safeFieldSet.has(prop)) return true;
        if (allowedMethodSet && !allowedMethodSet.has(prop)) return false;
        return typeof target?.[prop] === "function";
      },
      ownKeys() {
        return [];
      },
      getOwnPropertyDescriptor() {
        return {
          enumerable: false,
          configurable: true,
        };
      },
    },
  );
}

function createNullHelpers(useChat: (chatKey: string) => any) {
  return {
    currentChatKey: undefined,
    useChat,
    send() {
      throw new Error(
        "chat_bridge_chat_required: use helpers.useChat(chatKey)",
      );
    },
    reply() {
      throw new Error(
        "chat_bridge_chat_required: use helpers.useChat(chatKey)",
      );
    },
    serialize(value: unknown) {
      return serializeBridgeValue(value);
    },
  };
}

function auditDir(agentDir: string) {
  return chatDataPath(agentDir, "eval");
}

async function waitForOutboxDelivery(
  agentDir: string,
  id: string,
  timeoutMs = 1000,
) {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  while (Date.now() <= deadline) {
    const current = readChatOutboxItemById(agentDir, id)?.item;
    if (current?.status === "delivered") return current.deliveryResult || [];
    if (current?.status === "failed") {
      throw new Error(current.lastError || "chat_outbox_delivery_failed");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
}

export function appendChatBridgeAudit(
  agentDir: string,
  entry: Record<string, unknown>,
) {
  const day = formatLocalDateOnly();
  const filePath = path.join(auditDir(agentDir), `${day}.jsonl`);
  appendJsonLineSync(filePath, entry);
  return filePath;
}

export function createChatBridgeRuntime(options: {
  app: any;
  agentDir: string;
  dataDir: string;
  currentChatKey?: string;
  h: any;
  requestId?: string;
  sessionId?: string;
  sessionFile?: string;
}) {
  const currentChatKey = safeString(options.currentChatKey).trim() || undefined;
  const requestId = safeString(options.requestId).trim() || undefined;
  const session = readSessionMetadata(options);
  const sessionId = session.sessionId || undefined;
  const sessionFile = session.sessionFile || undefined;
  const scopeCache = new Map<string, any>();

  const buildScope = (targetChatKey: string) => {
    const chatKey = safeString(targetChatKey).trim();
    const parsed = parseChatKey(chatKey);
    if (!parsed) throw new Error(`invalid_chatKey:${chatKey || "missing"}`);
    const bot = findBot(options.app, parsed.platform, parsed.botId);
    if (!bot) {
      throw new Error(
        `no_bot_for_platform:${parsed.platform}${parsed.botId ? `/${parsed.botId}` : ""}`,
      );
    }
    const currentChat = Object.freeze({
      chatKey,
      platform: parsed.platform,
      botId: parsed.botId,
      chatId: parsed.chatId,
      chatType: inferChatType(parsed),
      requestId,
      sessionId,
      sessionFile,
    });

    const deliver = async (input: unknown, replyToMessageId = "") => {
      const parts = prependQuote(
        normalizeMessageParts(input),
        safeString(replyToMessageId).trim(),
      );
      if (!parts.length) throw new Error("chat_bridge_send_empty");
      const id = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`;
      enqueueChatOutboxPayload(
        options.agentDir,
        {
          createdAt: nowIso(),
          requestId,
          chatKey,
          sessionId,
          sessionFile,
          parts,
        },
        { id, deliveryKind: "generic" },
      );
      const results = await drainChatOutbox(
        options.app,
        options.agentDir,
        options.h,
        { warn() {} },
        { chatKey, itemId: id },
      );
      const deliveryResult = Array.isArray(results)
        ? results.flatMap((item: any) => item?.deliveryResult || [])
        : [];
      if (deliveryResult.length) return deliveryResult;
      return (await waitForOutboxDelivery(options.agentDir, id)) || [];
    };

    const scope: any = {
      chat: currentChat,
      bot: createMethodFacade(bot, {
        safeFields: ["platform", "selfId", "status"],
        allowedMethods: ["sendMessage"],
      }),
      internal: createMethodFacade(bot.internal || {}, {
        safeFields: [
          "client",
          "rest",
          "web",
          "socket",
          "openapi",
          "wsClient",
          "ws",
        ],
        allowedMethods: null,
      }),
      h: options.h,
      store: {
        getMessage(messageId: string, nextChatKey?: string) {
          return normalizeChatMessageLookup(
            options.agentDir,
            safeString(messageId).trim(),
            safeString(nextChatKey).trim() || chatKey,
          );
        },
        listLog(date?: string, nextChatKey?: string) {
          const nextDate = safeString(date).trim() || formatLocalDateOnly();
          return readChatLog(
            options.agentDir,
            safeString(nextChatKey).trim() || chatKey,
            nextDate,
          );
        },
      },
      identity: {
        getTrust(userId: string, platform?: string) {
          const identity = loadIdentity(options.dataDir);
          return trustOf(
            identity,
            safeString(platform).trim() || parsed.platform,
            safeString(userId).trim(),
          );
        },
        setTrust(input: {
          userId: string;
          trust: "OWNER" | "TRUSTED" | "OTHER";
          platform?: string;
          name?: string;
        }) {
          return setIdentityTrust({
            dataDir: options.dataDir,
            platform: safeString(input?.platform).trim() || parsed.platform,
            userId: safeString(input?.userId).trim(),
            trust: safeString(input?.trust).trim() as
              | "OWNER"
              | "TRUSTED"
              | "OTHER",
            name: safeString(input?.name).trim() || undefined,
          });
        },
      },
    };

    scope.helpers = {
      currentChatKey: chatKey,
      useChat(nextChatKey: string) {
        return getScope(nextChatKey);
      },
      send(input: unknown) {
        return deliver(input);
      },
      reply(replyToMessageId: string, input: unknown) {
        return deliver(input, replyToMessageId);
      },
      serialize(value: unknown) {
        return serializeBridgeValue(value);
      },
    };
    return scope;
  };

  const getScope = (chatKey: string) => {
    const nextChatKey = safeString(chatKey).trim();
    if (!nextChatKey) throw new Error("chat_bridge_chat_required");
    let scope = scopeCache.get(nextChatKey);
    if (!scope) {
      scope = buildScope(nextChatKey);
      scopeCache.set(nextChatKey, scope);
    }
    return scope;
  };

  const currentScope = currentChatKey ? getScope(currentChatKey) : null;
  return {
    chat: currentScope?.chat || null,
    bot: currentScope?.bot,
    internal: currentScope?.internal,
    h: options.h,
    store: currentScope?.store,
    identity: currentScope?.identity,
    helpers: currentScope?.helpers || createNullHelpers(getScope),
  };
}
