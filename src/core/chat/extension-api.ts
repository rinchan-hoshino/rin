import type { RinDaemonChatAPI } from "../rin-extension-api.js";
import { createDaemonSessionRef } from "../session/extension-api.js";
import { openChatDatabase, readChatSessionBinding } from "./database.js";

export function createDaemonChatAPI(input: {
  agentDir: string;
}): RinDaemonChatAPI {
  return {
    async listKeys(filter = {}) {
      const platform = String(filter.platform || "").trim();
      const accountIds = new Set(
        (filter.accountIds || [])
          .map((value) => String(value || "").trim())
          .filter(Boolean),
      );
      const rows = openChatDatabase(input.agentDir)
        .prepare("SELECT chat_key FROM chat_state ORDER BY chat_key ASC")
        .all() as Array<{ chat_key?: unknown }>;
      return rows
        .map((row) => String(row.chat_key || "").trim())
        .filter((chatKey) => {
          const match = /^([^/]+)\/([^:]+):/.exec(chatKey);
          if (!match) return false;
          if (platform && match[1] !== platform) return false;
          return accountIds.size === 0 || accountIds.has(match[2]);
        });
    },
    async getSessionBindings(chatKeys) {
      return chatKeys.map((chatKey) =>
        createDaemonSessionRef(
          input.agentDir,
          readChatSessionBinding(input.agentDir, String(chatKey || "").trim()),
        ),
      );
    },
  };
}
