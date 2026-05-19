import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_RIN_FRONTEND_COMMAND_RESPONSES,
  resolveRinFrontendCommandResponses,
  type RinFrontendCommandResponses,
} from "../rin-frontend-sdk/command-responses.js";

export type ChatCommandResponses = RinFrontendCommandResponses;

export const DEFAULT_CHAT_COMMAND_RESPONSES =
  DEFAULT_RIN_FRONTEND_COMMAND_RESPONSES;

export const resolveChatCommandResponses = resolveRinFrontendCommandResponses;

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
