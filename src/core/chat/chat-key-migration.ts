import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { cloneJson, isJsonRecord } from "../json-utils.js";
import { writeJsonAtomic } from "../platform/fs.js";
import { nowIso } from "../time-utils.js";
import { safeString } from "../text-utils.js";
import { normalizeLocalDateOnly } from "./date.js";
import {
  buildChatMessageRecordKey,
  storedChatMessageTimestamp,
  type StoredChatMessage,
} from "./message-store.js";
import {
  chatScopedDatePath,
  getChatMessageStoreLayout,
  sanitizePathSegment,
  type ChatMessageStoreLayout,
} from "./message-store-layout.js";

type BotIdMap = Record<string, string>;

const BOT_QUALIFIED_CHAT_PLATFORMS = new Set([
  "telegram",
  "onebot",
  "discord",
  "lark",
  "slack",
  "minecraft",
]);

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
  // Before bot-qualified keys, only the first registered bot used the
  // unqualified platform:chatId shape; later bots were already qualified.
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
  if (!legacy || !BOT_QUALIFIED_CHAT_PLATFORMS.has(legacy.platform)) return "";
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
  const canonicalSources = new Set<string>();
  for (const [key, value] of Object.entries(next.chat.byChatKey)) {
    const canonical = canonicalizeStoredChatKey(key, botIds);
    if (!canonical) {
      unresolved.push(key);
      output[key] = value;
      continue;
    }
    const sourceIsCanonical = canonical === key;
    if (!sourceIsCanonical) rewritten[key] = canonical;
    if (Object.prototype.hasOwnProperty.call(output, canonical)) {
      conflicts[canonical] ||= [];
      conflicts[canonical].push(key);
      if (isJsonRecord(output[canonical]) && isJsonRecord(value)) {
        output[canonical] = sourceIsCanonical
          ? { ...output[canonical], ...value }
          : canonicalSources.has(canonical)
            ? { ...value, ...output[canonical] }
            : { ...output[canonical], ...value };
      }
      if (sourceIsCanonical) canonicalSources.add(canonical);
      continue;
    }
    output[canonical] = value;
    if (sourceIsCanonical) canonicalSources.add(canonical);
  }
  next.chat.byChatKey = output;
  return { settings: next, rewritten, unresolved, conflicts };
}

const CHAT_KEY_MIGRATION_ID = "chat-key-v1";

type StoredRecordFile = {
  filePath: string;
  record: StoredChatMessage;
};

function listStoredRecordFiles(recordsDir: string) {
  const output: StoredRecordFile[] = [];
  const visit = (dir: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const record = JSON.parse(
          fs.readFileSync(filePath, "utf8"),
        ) as StoredChatMessage;
        if (
          safeString(record?.recordKey).trim() &&
          safeString(record?.messageId).trim()
        ) {
          output.push({ filePath, record });
        }
      } catch {}
    }
  };
  visit(recordsDir);
  return output.sort((left, right) =>
    left.filePath.localeCompare(right.filePath),
  );
}

function storedRecordPath(recordsDir: string, recordKey: string) {
  return path.join(recordsDir, recordKey.slice(0, 2), `${recordKey}.json`);
}

function preferRicherString(current: unknown, legacy: unknown) {
  const currentText = safeString(current);
  const legacyText = safeString(legacy);
  if (!currentText.trim()) return legacyText.trim() ? legacyText : undefined;
  if (!legacyText.trim()) return currentText;
  return legacyText.length > currentText.length ? legacyText : currentText;
}

function preferRicherElements(current: unknown, legacy: unknown) {
  const currentElements = Array.isArray(current) ? current : [];
  const legacyElements = Array.isArray(legacy) ? legacy : [];
  if (!currentElements.length) return legacyElements.length ? legacy : current;
  if (!legacyElements.length) return current;
  return legacyElements.length > currentElements.length ? legacy : current;
}

function mergeMigratedRecord(
  current: StoredChatMessage,
  legacy: StoredChatMessage,
  chatKey: string,
  recordKey: string,
) {
  const next: StoredChatMessage = {
    ...legacy,
    ...current,
    version: 1,
    recordKey,
    messageId: current.messageId,
    chatKey,
    platform: current.platform || legacy.platform,
    botId: current.botId || legacy.botId,
    chatId: current.chatId || legacy.chatId,
    role: current.role || legacy.role,
    receivedAt: current.receivedAt || legacy.receivedAt,
    acceptedAt: current.acceptedAt || legacy.acceptedAt,
    processedAt: current.processedAt || legacy.processedAt,
    sessionFile: current.sessionFile || legacy.sessionFile,
    lastReceivedAt: current.lastReceivedAt || legacy.lastReceivedAt,
    updatedAt: current.updatedAt || legacy.updatedAt,
  };
  next.text = preferRicherString(current.text, legacy.text);
  next.rawContent = preferRicherString(current.rawContent, legacy.rawContent);
  next.strippedContent = preferRicherString(
    current.strippedContent,
    legacy.strippedContent,
  );
  next.elements = preferRicherElements(
    current.elements,
    legacy.elements,
  ) as StoredChatMessage["elements"];
  next.quote = current.quote || legacy.quote;
  if (
    current.duplicateCount !== undefined ||
    legacy.duplicateCount !== undefined
  ) {
    next.duplicateCount = Math.max(
      0,
      Number(current.duplicateCount || 0),
      Number(legacy.duplicateCount || 0),
    );
  }
  return next;
}

function hashKey(value: string) {
  return createHash("sha1").update(value).digest("hex");
}

function messageRefsPath(indexesDir: string, messageId: string) {
  const key = hashKey(messageId);
  return path.join(indexesDir, "by-message-id", key.slice(0, 2), `${key}.json`);
}

function readStringList(filePath: string, field?: string) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const list = field && isJsonRecord(value) ? value[field] : value;
    return Array.isArray(list)
      ? [
          ...new Set(
            list.map((item) => safeString(item).trim()).filter(Boolean),
          ),
        ]
      : [];
  } catch {
    return [];
  }
}

function pruneEmptyParents(startDir: string, stopDir: string) {
  let current = path.resolve(startDir);
  const stop = path.resolve(stopDir);
  while (current !== stop && current.startsWith(`${stop}${path.sep}`)) {
    try {
      if (fs.readdirSync(current).length) break;
      fs.rmdirSync(current);
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}

function updateRecordKeyIndex(
  filePath: string,
  oldRecordKey: string,
  newRecordKey: string,
  indexesRoot: string,
) {
  const recordKeys = readStringList(filePath, "recordKeys").filter(
    (item) => item !== oldRecordKey,
  );
  if (!recordKeys.includes(newRecordKey)) recordKeys.push(newRecordKey);
  writeJsonAtomic(filePath, { version: 1, recordKeys });
  pruneEmptyParents(path.dirname(filePath), indexesRoot);
}

function removeRecordKeyIndex(
  filePath: string,
  recordKey: string,
  indexesRoot: string,
) {
  if (!fs.existsSync(filePath)) return;
  const recordKeys = readStringList(filePath, "recordKeys").filter(
    (item) => item !== recordKey,
  );
  if (recordKeys.length) {
    writeJsonAtomic(filePath, { version: 1, recordKeys });
    return;
  }
  fs.rmSync(filePath, { force: true });
  pruneEmptyParents(path.dirname(filePath), indexesRoot);
}

function legacyChatDateIndexPath(
  layout: ChatMessageStoreLayout,
  platform: string,
  chatId: string,
  date: string,
) {
  return path.join(
    layout.primaryRoot.indexesDir,
    "by-chat-date",
    sanitizePathSegment(platform, "platform"),
    sanitizePathSegment(chatId, "chat"),
    `${date}.json`,
  );
}

function updateMigratedRecordIndexes(
  layout: ChatMessageStoreLayout,
  candidate: StoredRecordFile & {
    chatKey: string;
    recordKey: string;
    targetPath: string;
  },
  migrated: StoredChatMessage,
) {
  const messageId = safeString(migrated.messageId).trim();
  const refsPath = messageRefsPath(layout.primaryRoot.indexesDir, messageId);
  const oldRelativePath = path.relative(
    layout.primaryRoot.storeDir,
    candidate.filePath,
  );
  const newRelativePath = path.relative(
    layout.primaryRoot.storeDir,
    candidate.targetPath,
  );
  const refs = readStringList(refsPath)
    .map((item) => (item === oldRelativePath ? newRelativePath : item))
    .filter((item, index, values) => values.indexOf(item) === index);
  if (!refs.includes(newRelativePath)) refs.push(newRelativePath);
  writeJsonAtomic(refsPath, refs);

  const legacyDate = normalizeLocalDateOnly(
    storedChatMessageTimestamp(candidate.record),
  );
  if (legacyDate) {
    removeRecordKeyIndex(
      legacyChatDateIndexPath(
        layout,
        safeString(candidate.record.platform).trim(),
        safeString(candidate.record.chatId).trim(),
        legacyDate,
      ),
      candidate.record.recordKey,
      layout.primaryRoot.indexesDir,
    );
  }
  const migratedDate = normalizeLocalDateOnly(
    storedChatMessageTimestamp(migrated),
  );
  if (migratedDate) {
    updateRecordKeyIndex(
      chatScopedDatePath(
        path.join(layout.primaryRoot.indexesDir, "by-chat-date"),
        migrated.chatKey,
        migratedDate,
        ".json",
      ),
      candidate.record.recordKey,
      migrated.recordKey,
      layout.primaryRoot.indexesDir,
    );
  }
}

function migrateLegacyMessageRecords(agentDir: string) {
  const layout = getChatMessageStoreLayout(agentDir);
  const candidates: Array<
    StoredRecordFile & {
      chatKey: string;
      recordKey: string;
      targetPath: string;
    }
  > = [];
  const unresolved: string[] = [];
  for (const item of listStoredRecordFiles(layout.primaryRoot.recordsDir)) {
    const legacy = parseLegacyUnqualifiedChatKey(item.record.chatKey);
    if (!legacy || !BOT_QUALIFIED_CHAT_PLATFORMS.has(legacy.platform)) continue;
    const platform = safeString(item.record.platform).trim();
    const botId = safeString(item.record.botId).trim();
    const chatId = safeString(item.record.chatId).trim();
    if (!botId) continue;
    if (legacy.platform !== platform || legacy.chatId !== chatId) {
      unresolved.push(item.filePath);
      continue;
    }
    const chatKey = composeCanonicalChatKey(platform, botId, chatId);
    const recordKey = buildChatMessageRecordKey(
      chatKey,
      safeString(item.record.messageId).trim(),
    );
    candidates.push({
      ...item,
      chatKey,
      recordKey,
      targetPath: storedRecordPath(layout.primaryRoot.recordsDir, recordKey),
    });
  }
  if (unresolved.length) {
    throw new Error(
      `chat_key_migration_unresolved_records:${unresolved.length}`,
    );
  }

  let mergedRecords = 0;
  for (const candidate of candidates) {
    let current: StoredChatMessage | null = null;
    try {
      current = JSON.parse(
        fs.readFileSync(candidate.targetPath, "utf8"),
      ) as StoredChatMessage;
    } catch {}
    const migrated: StoredChatMessage = current
      ? mergeMigratedRecord(
          current,
          candidate.record,
          candidate.chatKey,
          candidate.recordKey,
        )
      : {
          ...candidate.record,
          version: 1,
          recordKey: candidate.recordKey,
          chatKey: candidate.chatKey,
        };
    if (current) mergedRecords += 1;
    writeJsonAtomic(candidate.targetPath, migrated);
    updateMigratedRecordIndexes(layout, candidate, migrated);
    const legacyDate = normalizeLocalDateOnly(
      storedChatMessageTimestamp(candidate.record),
    );
    if (legacyDate) {
      const legacyLogPath = path.join(
        layout.primaryRoot.logDir,
        sanitizePathSegment(candidate.record.platform, "platform"),
        sanitizePathSegment(candidate.record.chatId, "chat"),
        `${legacyDate}.txt`,
      );
      fs.rmSync(legacyLogPath, { force: true });
      pruneEmptyParents(path.dirname(legacyLogPath), layout.primaryRoot.logDir);
    }
    if (
      path.resolve(candidate.filePath) !== path.resolve(candidate.targetPath)
    ) {
      fs.rmSync(candidate.filePath, { force: true });
    }
  }
  return { migratedRecords: candidates.length, mergedRecords };
}

function chatKeyMigrationMarkerPath(agentDir: string) {
  return path.join(
    path.resolve(agentDir),
    "data",
    "migrations",
    `${CHAT_KEY_MIGRATION_ID}.json`,
  );
}

export function migrateLegacyChatKeys(
  agentDir: string,
  settingsPath: string,
  settings: unknown,
) {
  const markerPath = chatKeyMigrationMarkerPath(agentDir);
  if (fs.existsSync(markerPath)) {
    return {
      id: CHAT_KEY_MIGRATION_ID,
      markerPath,
      alreadyApplied: true,
      migratedRecords: 0,
      mergedRecords: 0,
      settings,
    };
  }

  const rewrittenSettings = rewriteSettingsChatKeys(settings);
  const unresolvedActiveSettings = rewrittenSettings.unresolved.filter(
    (key) => {
      const legacy = parseLegacyUnqualifiedChatKey(key);
      return Boolean(
        legacy && BOT_QUALIFIED_CHAT_PLATFORMS.has(legacy.platform),
      );
    },
  );
  if (unresolvedActiveSettings.length) {
    throw new Error(
      `chat_key_migration_unresolved_settings:${unresolvedActiveSettings.length}`,
    );
  }
  const records = migrateLegacyMessageRecords(agentDir);
  if (
    Object.keys(rewrittenSettings.rewritten).length ||
    Object.keys(rewrittenSettings.conflicts).length
  ) {
    writeJsonAtomic(settingsPath, rewrittenSettings.settings);
  }
  writeJsonAtomic(markerPath, {
    id: CHAT_KEY_MIGRATION_ID,
    appliedAt: nowIso(),
    migratedSettings: Object.keys(rewrittenSettings.rewritten).length,
    migratedRecords: records.migratedRecords,
    mergedRecords: records.mergedRecords,
  });
  return {
    id: CHAT_KEY_MIGRATION_ID,
    markerPath,
    alreadyApplied: false,
    ...records,
    settings: rewrittenSettings.settings,
  };
}
