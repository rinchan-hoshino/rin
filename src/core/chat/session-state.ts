import fs from "node:fs";

import type {
  RinChatSessionState,
  RinDaemonChatAPI,
} from "../rin-extension-api.js";
import { loadRinSessionManagerModule } from "../rin-lib/loader.js";
import { resolveStoredSessionFile } from "../session/ref.js";
import { openChatDatabase, readChatSessionBinding } from "./database.js";
import { buildChatSessionStatus } from "./status.js";

export async function resolveChatSessionStates(input: {
  chatKeys: readonly string[];
  readBinding: (chatKey: string) => string | undefined;
  isSessionExecuting: (sessionFile: string) => boolean;
  readSessionHasConversation: (sessionFile: string) => Promise<boolean>;
}): Promise<Record<string, RinChatSessionState>> {
  const states = await Promise.all(
    input.chatKeys.map(async (chatKey) => {
      const sessionFile = input.readBinding(chatKey);
      if (!sessionFile) return [chatKey, "idle"] as const;
      if (input.isSessionExecuting(sessionFile)) {
        return [chatKey, "executing"] as const;
      }
      const hasConversation =
        await input.readSessionHasConversation(sessionFile);
      return [chatKey, hasConversation ? "waiting" : "idle"] as const;
    }),
  );
  return Object.fromEntries(states);
}

type ConversationCacheEntry = {
  fingerprint: string;
  hasConversation: boolean;
};

export class ChatSessionConversationReader {
  readonly #cache = new Map<string, ConversationCacheEntry>();

  async hasConversation(sessionFile: string): Promise<boolean> {
    let stats: fs.Stats;
    try {
      stats = fs.statSync(sessionFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.#cache.delete(sessionFile);
      return false;
    }
    const fingerprint = [
      stats.dev,
      stats.ino,
      stats.size,
      stats.mtimeMs,
      stats.ctimeMs,
    ].join(":");
    const cached = this.#cache.get(sessionFile);
    if (cached?.fingerprint === fingerprint) return cached.hasConversation;

    const { SessionManager } = await loadRinSessionManagerModule();
    const hasConversation =
      SessionManager.open(sessionFile).buildSessionContext().messages.length >
      0;
    if (this.#cache.size >= 1024) this.#cache.clear();
    this.#cache.set(sessionFile, { fingerprint, hasConversation });
    return hasConversation;
  }
}

export function createDaemonChatAPI(input: {
  agentDir: string;
  getActivity: () => unknown;
  conversationReader?: ChatSessionConversationReader;
}): RinDaemonChatAPI {
  const reader =
    input.conversationReader || new ChatSessionConversationReader();
  return {
    async listKeys(filter = {}) {
      const platform = String(filter.platform || "").trim();
      const accountIds = new Set(
        (filter.accountIds || []).map((value) => String(value).trim()),
      );
      const rows = openChatDatabase(input.agentDir)
        .prepare("SELECT chat_key FROM chat_state ORDER BY chat_key")
        .all() as Array<{ chat_key?: unknown }>;
      return rows
        .map((row) => String(row.chat_key || "").trim())
        .filter((chatKey) => {
          const match = /^([^/]+)\/([^:]+):/.exec(chatKey);
          if (!match) return false;
          if (platform && match[1] !== platform) return false;
          return accountIds.size === 0 || accountIds.has(match[2]!);
        });
    },
    async getSessionStates(chatKeys) {
      const activity = input.getActivity();
      return await resolveChatSessionStates({
        chatKeys,
        readBinding: (chatKey) =>
          resolveStoredSessionFile(
            input.agentDir,
            readChatSessionBinding(input.agentDir, chatKey),
          ),
        isSessionExecuting: (sessionFile) => {
          const session = buildChatSessionStatus({
            agentDir: input.agentDir,
            daemonReachable: true,
            sessionFile,
            localTurnActive: false,
            activity,
          }).session;
          return session === "working" || session === "compacting";
        },
        readSessionHasConversation: (sessionFile) =>
          reader.hasConversation(sessionFile),
      });
    },
  };
}
