import { EventEmitter } from "node:events";
import path from "node:path";
import { enqueueChatInboxItem } from "../chat/inbox.js";
import { getChatId, pickMessageId } from "../chat/chat-helpers.js";
import { composeChatKeyForBot } from "../chat/support.js";
import { emitBotStatus, safeString } from "./common.js";

export type ChatRuntimeAdapterStatus = {
  platform: string;
  selfId: string;
  status: "registered" | "starting" | "ready" | "degraded" | "stopped";
  error?: string;
};

type RegisteredChatRuntimeAdapter = {
  adapter: any;
  bot: any;
  status: ChatRuntimeAdapterStatus["status"];
  error?: string;
};

export class ChatRuntimeApp extends EventEmitter {
  bots: any[] = [];
  private readonly adapters = new Set<any>();
  private readonly adapterEntries = new Map<
    any,
    RegisteredChatRuntimeAdapter
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

  register(adapter: any, bot: any) {
    if (bot) this.bots.push(bot);
    if (adapter) {
      this.adapters.add(adapter);
      this.adapterEntries.set(adapter, {
        adapter,
        bot,
        status: "registered",
      });
    }
  }

  setWorkingText(text: string) {
    for (const adapter of this.adapters) {
      if (typeof adapter?.setWorkingText === "function") {
        adapter.setWorkingText(text);
      }
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

  registerAdapterFailure(
    identity: { platform?: string; selfId?: string },
    error: unknown,
  ) {
    const entry: RegisteredChatRuntimeAdapter = {
      adapter: null,
      bot: identity,
      status: "degraded",
      error:
        safeString((error as any)?.message || error).trim() ||
        "adapter_init_failed",
    };
    this.adapterEntries.set(entry, entry);
    this.emit("adapter-start-failed", {
      platform: safeString(identity.platform).trim() || "unknown",
      selfId: safeString(identity.selfId).trim(),
      status: "degraded",
      error: entry.error,
    } satisfies ChatRuntimeAdapterStatus);
  }

  getAdapterStatuses(): ChatRuntimeAdapterStatus[] {
    return [...this.adapterEntries.values()].map((entry) => ({
      platform: safeString(entry.bot?.platform).trim() || "unknown",
      selfId: safeString(entry.bot?.selfId).trim(),
      status: entry.status,
      ...(entry.error ? { error: entry.error } : {}),
    }));
  }

  async start() {
    for (const entry of this.adapterEntries.values()) {
      const { adapter, bot } = entry;
      if (!adapter) continue;
      entry.status = "starting";
      delete entry.error;
      try {
        if (typeof adapter?.start === "function") {
          await adapter.start();
        }
        entry.status = "ready";
      } catch (error: any) {
        entry.status = "degraded";
        entry.error =
          safeString(error?.message || error).trim() || "adapter_start_failed";
        if (bot) emitBotStatus(this, bot, 0);
        try {
          await adapter?.stop?.();
        } catch {}
        this.emit("adapter-start-failed", {
          platform: safeString(bot?.platform).trim() || "unknown",
          selfId: safeString(bot?.selfId).trim(),
          status: "degraded",
          error: entry.error,
        } satisfies ChatRuntimeAdapterStatus);
      }
    }
  }

  async stop() {
    const entries = [...this.adapterEntries.values()].reverse();
    for (const entry of entries) {
      try {
        await entry.adapter?.stop?.();
      } catch (error: any) {
        entry.error =
          safeString(error?.message || error).trim() || "adapter_stop_failed";
        this.emit("adapter-stop-failed", {
          platform: safeString(entry.bot?.platform).trim() || "unknown",
          selfId: safeString(entry.bot?.selfId).trim(),
          status: "degraded",
          error: entry.error,
        } satisfies ChatRuntimeAdapterStatus);
      } finally {
        if (entry.status !== "degraded") entry.status = "stopped";
      }
    }
  }
}

export function createChatRuntimeApp(agentDir?: string) {
  return new ChatRuntimeApp(agentDir);
}
