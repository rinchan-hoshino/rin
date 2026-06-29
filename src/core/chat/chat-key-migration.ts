import { cloneJson, isJsonRecord } from "../json-utils.js";
import { safeString } from "../text-utils.js";

type BotIdMap = Record<string, string>;

type SettingsRewriteResult = {
  settings: any;
  rewritten: Record<string, string>;
  unresolved: string[];
  conflicts: Record<string, string[]>;
};

function normalizePlatform(value: unknown) {
  return safeString(value).trim();
}

function normalizeBotId(value: unknown) {
  return safeString(value).trim();
}

function addInferredBotId(out: BotIdMap, platform: string, botId: string) {
  const nextPlatform = normalizePlatform(platform);
  const nextBotId = normalizeBotId(botId);
  if (!nextPlatform || !nextBotId) return;
  if (!out[nextPlatform]) out[nextPlatform] = nextBotId;
}

function decodeBase64UrlText(value: string) {
  const raw = safeString(value).trim();
  if (!raw) return "";
  try {
    const padded = `${raw}${"=".repeat((4 - (raw.length % 4)) % 4)}`;
    return Buffer.from(padded, "base64url").toString("utf8").trim();
  } catch {
    return "";
  }
}

function inferTelegramBotId(config: Record<string, any>) {
  const explicit = normalizeBotId(config.selfId || config.botId || config.id);
  if (explicit) return explicit;
  return safeString(config.token).trim().split(":")[0] || "";
}

function inferDiscordBotId(config: Record<string, any>) {
  const explicit = normalizeBotId(
    config.selfId || config.botId || config.clientId || config.id,
  );
  if (explicit) return explicit;
  const firstTokenPart = safeString(config.token).trim().split(".")[0] || "";
  const decoded = decodeBase64UrlText(firstTokenPart);
  return /^\d+$/.test(decoded) ? decoded : "";
}

function inferBotIdForPlatform(platform: string, config: Record<string, any>) {
  const explicit = normalizeBotId(
    config.selfId || config.botId || config.botUserId || config.userId,
  );
  if (explicit) return explicit;
  switch (platform) {
    case "telegram":
      return inferTelegramBotId(config);
    case "discord":
      return inferDiscordBotId(config);
    case "onebot":
    case "minecraft":
      return normalizeBotId(config.selfId || config.botId || config.id);
    case "qq":
      return normalizeBotId(config.selfId || config.botId || config.id);
    case "lark":
      return normalizeBotId(config.selfId || config.botId || config.appId);
    case "slack":
      return normalizeBotId(config.selfId || config.botId || config.botUserId);
    default:
      return normalizeBotId(config.selfId || config.botId || config.id);
  }
}

function looksLikeSingleAdapterConfig(value: unknown) {
  if (!isJsonRecord(value)) return false;
  const singleKeys = new Set([
    "name",
    "enabled",
    "endpoint",
    "selfId",
    "token",
    "protocol",
    "slash",
    "owners",
    "ownerUserIds",
    "botId",
    "clientId",
    "id",
    "appId",
    "botUserId",
    "userId",
  ]);
  const keys = Object.keys(value);
  if (!keys.length) return true;
  if (keys.some((key) => singleKeys.has(key))) return true;
  return keys.some((key) => !isJsonRecord(value[key]));
}

function collectAdapterConfigs(value: unknown): Record<string, any>[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is Record<string, any> =>
      isJsonRecord(item),
    );
  }
  if (looksLikeSingleAdapterConfig(value)) {
    return isJsonRecord(value) ? [value] : [];
  }
  if (!isJsonRecord(value)) return [];
  return Object.values(value).filter((item): item is Record<string, any> =>
    isJsonRecord(item),
  );
}

export function inferChatBotIdsFromSettings(settings: unknown): BotIdMap {
  const chat = isJsonRecord((settings as any)?.chat)
    ? (settings as any).chat
    : {};
  const out: BotIdMap = {};
  for (const [platform, value] of Object.entries(chat)) {
    if (
      platform === "byChatKey" ||
      platform === "turnPolicy" ||
      platform === "quietMode"
    ) {
      continue;
    }
    for (const config of collectAdapterConfigs(value)) {
      addInferredBotId(out, platform, inferBotIdForPlatform(platform, config));
    }
  }
  return Object.fromEntries(
    Object.entries(out).sort(([a], [b]) => a.localeCompare(b)),
  );
}

export function parseLegacyUnqualifiedChatKey(chatKey: string) {
  const match = safeString(chatKey)
    .trim()
    .match(/^([^/:]+):(.+)$/);
  if (!match) return null;
  const platform = normalizePlatform(match[1]);
  const chatId = safeString(match[2]).trim();
  if (!platform || !chatId) return null;
  return { platform, chatId };
}

function parseCanonicalChatKey(chatKey: string) {
  const match = safeString(chatKey)
    .trim()
    .match(/^([^/:]+)\/([^:]+):(.+)$/);
  if (!match) return null;
  const platform = normalizePlatform(match[1]);
  const botId = normalizeBotId(match[2]);
  const chatId = safeString(match[3]).trim();
  if (!platform || !botId || !chatId) return null;
  return { platform, botId, chatId };
}

function composeCanonicalChatKey(
  platform: string,
  botId: string,
  chatId: string,
) {
  const nextPlatform = normalizePlatform(platform);
  const nextBotId = normalizeBotId(botId);
  const nextChatId = safeString(chatId).trim();
  if (!nextPlatform || !nextBotId || !nextChatId) return "";
  return `${nextPlatform}/${nextBotId}:${nextChatId}`;
}

export function canonicalizeStoredChatKey(
  chatKey: string,
  botIds: BotIdMap,
): string {
  const current = safeString(chatKey).trim();
  const parsed = parseCanonicalChatKey(current);
  if (parsed) {
    return composeCanonicalChatKey(
      parsed.platform,
      parsed.botId,
      parsed.chatId,
    );
  }
  const legacy = parseLegacyUnqualifiedChatKey(current);
  if (!legacy) return "";
  return composeCanonicalChatKey(
    legacy.platform,
    botIds[legacy.platform],
    legacy.chatId,
  );
}

export function rewriteSettingsChatKeys(
  settings: unknown,
  botIds: BotIdMap = inferChatBotIdsFromSettings(settings),
): SettingsRewriteResult {
  const next = cloneJson(isJsonRecord(settings) ? settings : {});
  if (!isJsonRecord(next.chat)) {
    return { settings: next, rewritten: {}, unresolved: [], conflicts: {} };
  }
  if (!isJsonRecord(next.chat.byChatKey)) {
    return { settings: next, rewritten: {}, unresolved: [], conflicts: {} };
  }

  const rewritten: Record<string, string> = {};
  const unresolved: string[] = [];
  const conflicts: Record<string, string[]> = {};
  const output: Record<string, any> = {};
  for (const [key, value] of Object.entries(next.chat.byChatKey)) {
    const canonical = canonicalizeStoredChatKey(key, botIds);
    if (!canonical) {
      unresolved.push(key);
      output[key] = value;
      continue;
    }
    if (canonical !== key) rewritten[key] = canonical;
    if (Object.prototype.hasOwnProperty.call(output, canonical)) {
      conflicts[canonical] ||= [];
      conflicts[canonical].push(key);
      if (isJsonRecord(output[canonical]) && isJsonRecord(value)) {
        output[canonical] = { ...value, ...output[canonical] };
      }
      continue;
    }
    output[canonical] = value;
  }
  next.chat.byChatKey = output;
  return { settings: next, rewritten, unresolved, conflicts };
}
