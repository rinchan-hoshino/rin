import { isJsonRecord } from "../json-utils.js";

export type ChatTurnPolicyMode = "start_on_message" | "record_only";

const DEFAULT_CHAT_TURN_POLICY: ChatTurnPolicyMode = "start_on_message";

function normalizeChatTurnPolicyMode(value: unknown): ChatTurnPolicyMode {
  return value === "record_only" ? "record_only" : DEFAULT_CHAT_TURN_POLICY;
}

function normalizeChatQuietModeEnabled(value: unknown) {
  if (isJsonRecord(value)) {
    if (value.enabled !== undefined) return Boolean(value.enabled);
    if (value.quiet !== undefined) return Boolean(value.quiet);
    if (value.mode !== undefined) return value.mode === "quiet";
  }
  return value === true || value === "quiet";
}

export function getStoredChatConfigRoot(settings: any): Record<string, any> {
  return isJsonRecord(settings?.chat) ? settings.chat : {};
}

function resolvePerChatConfig(settings: any, chatKey: string) {
  const byChatKey = getStoredChatConfigRoot(settings).byChatKey;
  if (!isJsonRecord(byChatKey)) return undefined;
  const normalizedChatKey = String(chatKey || "").trim();
  if (
    !normalizedChatKey ||
    !Object.prototype.hasOwnProperty.call(byChatKey, normalizedChatKey)
  ) {
    return undefined;
  }
  const entry = byChatKey[normalizedChatKey];
  return isJsonRecord(entry) ? entry : undefined;
}

export function resolveChatTurnPolicyMode(
  settings: any,
  chatKey: string,
): ChatTurnPolicyMode {
  const perChat = resolvePerChatConfig(settings, chatKey);
  if (perChat?.turnPolicy !== undefined) {
    const value = perChat.turnPolicy;
    return normalizeChatTurnPolicyMode(
      isJsonRecord(value) ? value.mode : value,
    );
  }
  const turnPolicy = getStoredChatConfigRoot(settings).turnPolicy;
  return isJsonRecord(turnPolicy)
    ? normalizeChatTurnPolicyMode(turnPolicy.default)
    : DEFAULT_CHAT_TURN_POLICY;
}

export type ChatModelOptions = {
  model?: string;
  thinkingLevel?: string;
};

function normalizeNonBlankString(value: unknown) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text || undefined;
}

export function resolveChatQuietModeEnabled(settings: any, chatKey: string) {
  const perChat = resolvePerChatConfig(settings, chatKey);
  if (perChat?.quietMode !== undefined) {
    return normalizeChatQuietModeEnabled(perChat.quietMode);
  }
  const quietMode = getStoredChatConfigRoot(settings).quietMode;
  return isJsonRecord(quietMode)
    ? normalizeChatQuietModeEnabled(quietMode.default)
    : false;
}

export function resolveChatModelOptions(
  settings: any,
  chatKey: string,
): ChatModelOptions {
  const perChat = resolvePerChatConfig(settings, chatKey);
  if (!perChat) return {};
  return {
    model: normalizeNonBlankString(perChat.model),
    thinkingLevel: normalizeNonBlankString(perChat.thinkingLevel),
  };
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
