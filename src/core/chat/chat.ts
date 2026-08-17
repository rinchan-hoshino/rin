import { EventEmitter } from "node:events";
import path from "node:path";
import type {
  RinChatPlatform,
  RinChatPlatformBot,
  RinExtensionLogger,
} from "../rin-extension-api.js";
import { DiscordPlatform } from "./platform/discord.js";
import { TelegramPlatform } from "./platform/telegram.js";
import { enqueueChatInboxItem } from "./inbox.js";
import { getChatId, pickMessageId } from "./chat-helpers.js";
import { composeChatKeyForBot } from "./support.js";
import { compactObject, normalizeNode, safeString } from "./platform/common.js";

export type ChatPlatformStatus = {
  platform: string;
  selfId: string;
  status: "registered" | "starting" | "ready" | "degraded" | "stopped";
  error?: string;
};

type RegisteredChatPlatform = {
  platform: RinChatPlatform;
  bot: RinChatPlatformBot;
  status: ChatPlatformStatus["status"];
  error?: string;
};

export class Chat extends EventEmitter {
  bots: RinChatPlatformBot[] = [];
  private readonly platforms = new Set<RinChatPlatform>();
  private readonly platformEntries = new Map<
    RinChatPlatform,
    RegisteredChatPlatform
  >();
  private readonly inboundRecoveryChats = new Set<string>();
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
    const messageThreadId = safeString(
      session?.messageThreadId ||
        session?.chatThreadId ||
        session?.[platform]?.message?.message_thread_id ||
        "",
    ).trim();
    const chatKey = messageThreadId
      ? `${baseChatKey}?thread=${encodeURIComponent(messageThreadId)}`
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

  addPlatform(platform: RinChatPlatform) {
    if (!platform?.bot || !safeString(platform.bot.platform).trim()) {
      return false;
    }
    this.bots.push(platform.bot);
    this.platforms.add(platform);
    this.platformEntries.set(platform, {
      platform,
      bot: platform.bot,
      status: "registered",
    });
    return true;
  }

  updateStatus(bot: RinChatPlatformBot, status: number) {
    bot.status = status;
    this.emit("bot-status-updated", bot);
  }

  setWorkingText(text: string) {
    for (const platform of this.platforms) {
      platform.setWorkingText?.(text);
    }
  }

  beginInboundRecoveryChat(chatKey: string) {
    const normalized = safeString(chatKey).trim();
    if (normalized) this.inboundRecoveryChats.add(normalized);
  }

  completeInboundRecoveryChat(chatKey: string) {
    const normalized = safeString(chatKey).trim();
    if (!normalized || !this.inboundRecoveryChats.delete(normalized)) return;
    this.emit("inbound-recovery-chat-ready", { chatKey: normalized });
  }

  isInboundRecoveryChat(chatKey: string) {
    return this.inboundRecoveryChats.has(safeString(chatKey).trim());
  }

  registerPlatformFailure(
    identity: { platform?: string; selfId?: string },
    error: unknown,
  ) {
    const bot = {
      platform: safeString(identity.platform).trim() || "unknown",
      selfId: safeString(identity.selfId).trim(),
      status: 0,
      async sendMessage() {
        return [];
      },
    } satisfies RinChatPlatformBot;
    const failedPlatform: RinChatPlatform = {
      bot,
      start() {},
      stop() {},
    };
    const entry: RegisteredChatPlatform = {
      platform: failedPlatform,
      bot,
      status: "degraded",
      error:
        safeString((error as any)?.message || error).trim() ||
        "platform_init_failed",
    };
    this.platformEntries.set(failedPlatform, entry);
    this.emit("adapter-start-failed", {
      platform: safeString(identity.platform).trim() || "unknown",
      selfId: safeString(identity.selfId).trim(),
      status: "degraded",
      error: entry.error,
    } satisfies ChatPlatformStatus);
  }

  getPlatformStatuses(): ChatPlatformStatus[] {
    return [...this.platformEntries.values()].map((entry) => ({
      platform: safeString(entry.bot?.platform).trim() || "unknown",
      selfId: safeString(entry.bot?.selfId).trim(),
      status: entry.status,
      ...(entry.error ? { error: entry.error } : {}),
    }));
  }

  async start() {
    for (const entry of this.platformEntries.values()) {
      if (entry.status === "degraded") continue;
      const { platform, bot } = entry;
      entry.status = "starting";
      delete entry.error;
      try {
        await platform.start();
        entry.status = "ready";
      } catch (error: any) {
        entry.status = "degraded";
        entry.error =
          safeString(error?.message || error).trim() || "platform_start_failed";
        this.updateStatus(bot, 0);
        try {
          await platform.stop();
        } catch {}
        this.emit("adapter-start-failed", {
          platform: safeString(bot.platform).trim() || "unknown",
          selfId: safeString(bot.selfId).trim(),
          status: "degraded",
          error: entry.error,
        } satisfies ChatPlatformStatus);
      }
    }
  }

  async stop() {
    const entries = [...this.platformEntries.values()].reverse();
    for (const entry of entries) {
      try {
        await entry.platform.stop();
      } catch (error: any) {
        entry.error =
          safeString(error?.message || error).trim() || "platform_stop_failed";
        this.emit("adapter-stop-failed", {
          platform: safeString(entry.bot.platform).trim() || "unknown",
          selfId: safeString(entry.bot.selfId).trim(),
          status: "degraded",
          error: entry.error,
        } satisfies ChatPlatformStatus);
      } finally {
        if (entry.status !== "degraded") entry.status = "stopped";
      }
    }
  }
}

export function createChat(agentDir?: string) {
  return new Chat(agentDir);
}

export function addBuiltInPlatforms(
  chat: Chat,
  options: {
    dataDir: string;
    entries: Array<{
      platform: "telegram" | "discord";
      name: string;
      config: Record<string, unknown>;
    }>;
    logger?: RinExtensionLogger;
  },
) {
  const platforms: RinChatPlatform[] = [];
  for (const entry of options.entries) {
    try {
      const platform =
        entry.platform === "telegram"
          ? new TelegramPlatform(
              chat,
              options.dataDir,
              entry.config,
              options.logger,
            )
          : new DiscordPlatform(
              chat,
              options.dataDir,
              entry.config,
              options.logger,
            );
      chat.addPlatform(platform);
      platforms.push(platform);
    } catch (error) {
      chat.registerPlatformFailure(
        { platform: entry.platform, selfId: entry.name },
        error,
      );
    }
  }
  return platforms;
}

export function createChatNodes() {
  const h: any = (
    type: string,
    attrs?: Record<string, unknown>,
    ...children: unknown[]
  ) => normalizeNode(type, attrs, children);
  h.text = (content: unknown) =>
    normalizeNode("text", { content: safeString(content) });
  h.quote = (id: unknown) => normalizeNode("quote", { id: safeString(id) });
  h.at = (id: unknown, attrs?: Record<string, unknown>) =>
    normalizeNode(
      "at",
      compactObject({ ...(attrs || {}), id: safeString(id) }),
    );
  h.image = (src: unknown) => normalizeNode("image", { src: safeString(src) });
  h.markdown = (content: unknown) =>
    normalizeNode("markdown", { content: safeString(content) });
  h.html = (content: unknown) =>
    normalizeNode("html", { content: safeString(content) });
  h.file = (
    value: unknown,
    mimeType?: string,
    attrs?: Record<string, unknown>,
  ) => {
    const base = compactObject({
      ...(attrs || {}),
      mimeType: safeString(mimeType).trim() || undefined,
    });
    if (Buffer.isBuffer(value)) {
      return normalizeNode("file", { ...base, data: value });
    }
    return normalizeNode("file", { ...base, src: safeString(value) });
  };
  return h;
}
