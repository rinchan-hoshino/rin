import { isJsonRecord } from "../json-utils.js";

export type ChatTurnPolicyMode = "start_on_message" | "record_only";

export type ChatTurnPolicyResolution = {
  mode: ChatTurnPolicyMode;
  wakeTaskId?: string;
};

const DEFAULT_CHAT_TURN_POLICY: ChatTurnPolicyMode = "start_on_message";

function normalizeChatTurnPolicyMode(value: unknown): ChatTurnPolicyMode {
  return value === "record_only" ? "record_only" : DEFAULT_CHAT_TURN_POLICY;
}

function normalizeWakeTaskId(value: unknown) {
  const taskId = String(value || "").trim();
  return taskId || undefined;
}

function normalizeChatTurnPolicyResolution(
  value: unknown,
): ChatTurnPolicyResolution {
  if (isJsonRecord(value)) {
    const mode = normalizeChatTurnPolicyMode(value.mode);
    const wakeTaskId =
      mode === "record_only"
        ? normalizeWakeTaskId(value.wakeTaskId)
        : undefined;
    return wakeTaskId ? { mode, wakeTaskId } : { mode };
  }
  return { mode: normalizeChatTurnPolicyMode(value) };
}

export function getStoredChatConfigRoot(settings: any): Record<string, any> {
  return isJsonRecord(settings?.chat) ? settings.chat : {};
}

export function resolveChatTurnPolicy(
  settings: any,
  chatKey: string,
): ChatTurnPolicyResolution {
  const turnPolicy = getStoredChatConfigRoot(settings).turnPolicy;
  if (!isJsonRecord(turnPolicy)) return { mode: DEFAULT_CHAT_TURN_POLICY };
  const byChatKey = isJsonRecord(turnPolicy.byChatKey)
    ? turnPolicy.byChatKey
    : {};
  const normalizedChatKey = String(chatKey || "").trim();
  if (
    normalizedChatKey &&
    Object.prototype.hasOwnProperty.call(byChatKey, normalizedChatKey)
  ) {
    return normalizeChatTurnPolicyResolution(byChatKey[normalizedChatKey]);
  }
  return normalizeChatTurnPolicyResolution(turnPolicy.default);
}

export function resolveChatTurnPolicyMode(
  settings: any,
  chatKey: string,
): ChatTurnPolicyMode {
  return resolveChatTurnPolicy(settings, chatKey).mode;
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
