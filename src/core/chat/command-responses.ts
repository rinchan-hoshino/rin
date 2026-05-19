import { readRinI18nCatalog, type RinI18nCatalog } from "../i18n.js";
import {
  DEFAULT_RIN_FRONTEND_COMMAND_RESPONSES,
  resolveRinFrontendCommandResponses,
  type RinFrontendCommandResponses,
} from "../rin-frontend-sdk/command-responses.js";

export type ChatCommandResponses = RinFrontendCommandResponses;

export const DEFAULT_CHAT_COMMAND_RESPONSES =
  DEFAULT_RIN_FRONTEND_COMMAND_RESPONSES;

export const resolveChatCommandResponses = resolveRinFrontendCommandResponses;

const CHAT_COMMAND_RESPONSE_I18N_IDS = {
  abort: "chat.commandResponses.abort",
  new: "chat.commandResponses.new",
  newCancelled: "chat.commandResponses.newCancelled",
  compact: "chat.commandResponses.compact",
  reload: "chat.commandResponses.reload",
} satisfies Record<keyof RinFrontendCommandResponses, string>;

function chatCommandResponsesFromI18nCatalog(catalog: RinI18nCatalog) {
  return Object.fromEntries(
    Object.entries(CHAT_COMMAND_RESPONSE_I18N_IDS).map(([key, messageId]) => [
      key,
      catalog[messageId],
    ]),
  ) as Partial<RinFrontendCommandResponses>;
}

export function readChatCommandResponses(agentDir: string) {
  const root = String(agentDir || "").trim();
  if (!root) return resolveChatCommandResponses();
  return resolveChatCommandResponses(
    chatCommandResponsesFromI18nCatalog(readRinI18nCatalog(root)),
  );
}
