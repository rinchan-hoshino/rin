import fs from "node:fs";
import path from "node:path";

import { isJsonRecord } from "../json-utils.js";

export type ChatCommandResponses = {
  abort: string;
  new: string;
  newCancelled: string;
  compact: string;
  reload: string;
};

export const DEFAULT_CHAT_COMMAND_RESPONSES: ChatCommandResponses = {
  abort: "Aborted current operation.",
  new: "Started a new session.",
  newCancelled: "Session switch cancelled.",
  compact: "Compacted session.",
  reload: "Reloaded extensions, prompts, skills, and themes.",
};

export function resolveChatCommandResponses(
  configured?: unknown,
): ChatCommandResponses {
  const source = isJsonRecord(configured) ? configured : {};
  return Object.fromEntries(
    Object.entries(DEFAULT_CHAT_COMMAND_RESPONSES).map(([key, fallback]) => {
      const value = source[key];
      return [
        key,
        typeof value === "string" && value.trim() ? value : fallback,
      ];
    }),
  ) as ChatCommandResponses;
}

export function chatCommandResponsesPath(agentDir: string) {
  return path.join(
    String(agentDir || "").trim(),
    "chat-command-responses.json",
  );
}

export function readChatCommandResponses(agentDir: string) {
  const root = String(agentDir || "").trim();
  if (!root) return resolveChatCommandResponses();
  try {
    const configured = JSON.parse(
      fs.readFileSync(chatCommandResponsesPath(root), "utf8"),
    );
    return resolveChatCommandResponses(configured);
  } catch {
    return resolveChatCommandResponses();
  }
}
