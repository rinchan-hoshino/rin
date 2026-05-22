import { isJsonRecord } from "../json-utils.js";

export type ChatTurnPolicyMode = "start_on_message" | "record_only";

const DEFAULT_CHAT_TURN_POLICY: ChatTurnPolicyMode = "start_on_message";

function normalizeChatTurnPolicyMode(value: unknown): ChatTurnPolicyMode {
  return value === "record_only" ? "record_only" : DEFAULT_CHAT_TURN_POLICY;
}

export function getStoredChatConfigRoot(settings: any): Record<string, any> {
  return isJsonRecord(settings?.chat) ? settings.chat : {};
}

export function resolveChatTurnPolicyMode(
  settings: any,
  chatKey: string,
): ChatTurnPolicyMode {
  const turnPolicy = getStoredChatConfigRoot(settings).turnPolicy;
  if (!isJsonRecord(turnPolicy)) return DEFAULT_CHAT_TURN_POLICY;
  const byChatKey = isJsonRecord(turnPolicy.byChatKey)
    ? turnPolicy.byChatKey
    : {};
  const normalizedChatKey = String(chatKey || "").trim();
  if (
    normalizedChatKey &&
    Object.prototype.hasOwnProperty.call(byChatKey, normalizedChatKey)
  ) {
    return normalizeChatTurnPolicyMode(byChatKey[normalizedChatKey]);
  }
  return normalizeChatTurnPolicyMode(turnPolicy.default);
}

export function dropLegacyChatSettings(settings: any) {
  const normalized = isJsonRecord(settings) ? settings : {};
  if (normalized.koishi !== undefined) delete normalized.koishi;
  return normalized;
}

export function normalizeStoredChatSettings(
  settings: any,
  options: { ensureChat?: boolean } = {},
) {
  const normalized = dropLegacyChatSettings(
    isJsonRecord(settings) ? settings : {},
  );
  if (options.ensureChat && !isJsonRecord(normalized.chat)) {
    normalized.chat = {};
  }
  return normalized;
}
