import type { StoredChatMessage } from "./message-store.js";
import { safeString } from "../text-utils.js";

export const BOT_QUALIFIED_CHAT_PLATFORMS = new Set([
  "telegram",
  "onebot",
  "discord",
  "lark",
  "slack",
]);

export type LegacyChatKeyResolutionSource =
  | "persisted"
  | "reply"
  | "session"
  | "neighbor";

export type LegacyChatKeyRecordResolution = {
  botId?: string;
  source?: LegacyChatKeyResolutionSource;
  reason?:
    | "invalid_identity"
    | "reply_conflict"
    | "session_conflict"
    | "neighbor_conflict"
    | "unresolved";
};

function normalize(value: unknown) {
  return safeString(value).trim();
}

export function parseLegacyUnqualifiedChatKeyValue(chatKey: string) {
  const match = normalize(chatKey).match(/^([^/:]+):(.+)$/);
  if (!match) return null;
  const platform = normalize(match[1]);
  const chatId = normalize(match[2]);
  if (!platform || !chatId) return null;
  return { platform, chatId };
}

export function parseCanonicalChatKeyValue(chatKey: string) {
  const match = normalize(chatKey).match(/^([^/:]+)\/([^:]+):(.+)$/);
  if (!match) return null;
  const platform = normalize(match[1]);
  const botId = normalize(match[2]);
  const chatId = normalize(match[3]);
  if (!platform || !botId || !chatId) return null;
  return { platform, botId, chatId };
}

export function composeCanonicalChatKeyValue(
  platform: string,
  botId: string,
  chatId: string,
) {
  const nextPlatform = normalize(platform);
  const nextBotId = normalize(botId);
  const nextChatId = normalize(chatId);
  if (!nextPlatform || !nextBotId || !nextChatId) return "";
  return `${nextPlatform}/${nextBotId}:${nextChatId}`;
}

type RecordIdentity = {
  platform: string;
  chatId: string;
  botId?: string;
  legacy: boolean;
  activeLegacy: boolean;
};

function recordIdentity(record: StoredChatMessage): RecordIdentity | null {
  const chatKey = normalize(record.chatKey);
  const legacy = parseLegacyUnqualifiedChatKeyValue(chatKey);
  const canonical = parseCanonicalChatKeyValue(chatKey);
  if (!legacy && !canonical) return null;
  const parsed = legacy || canonical!;
  const platform = normalize(record.platform) || parsed.platform;
  const chatId = normalize(record.chatId) || parsed.chatId;
  const persistedBotId = normalize(record.botId);
  const canonicalBotId = canonical?.botId || "";
  if (
    platform !== parsed.platform ||
    chatId !== parsed.chatId ||
    (canonicalBotId && persistedBotId && canonicalBotId !== persistedBotId)
  ) {
    return null;
  }
  return {
    platform,
    chatId,
    botId: canonicalBotId || persistedBotId || undefined,
    legacy: Boolean(legacy),
    activeLegacy: Boolean(
      legacy && BOT_QUALIFIED_CHAT_PLATFORMS.has(legacy.platform),
    ),
  };
}

function conversationKey(
  identity: Pick<RecordIdentity, "platform" | "chatId">,
) {
  return `${identity.platform}\u0000${identity.chatId}`;
}

function uniqueResolvedBotIds(
  indexes: Iterable<number>,
  identities: Array<RecordIdentity | null>,
  resolutions: LegacyChatKeyRecordResolution[],
  expected: RecordIdentity,
) {
  const botIds = new Set<string>();
  for (const index of indexes) {
    const identity = identities[index];
    const botId = normalize(resolutions[index]?.botId);
    if (
      identity &&
      identity.platform === expected.platform &&
      identity.chatId === expected.chatId &&
      botId
    ) {
      botIds.add(botId);
    }
  }
  return botIds;
}

function resolveSingleEvidence(
  resolution: LegacyChatKeyRecordResolution,
  botIds: Set<string>,
  source: LegacyChatKeyResolutionSource,
  conflictReason: "reply_conflict" | "session_conflict" | "neighbor_conflict",
) {
  if (botIds.size > 1) {
    delete resolution.botId;
    delete resolution.source;
    resolution.reason = conflictReason;
    return false;
  }
  const [botId] = botIds;
  if (!botId) return false;
  resolution.botId = botId;
  resolution.source = source;
  delete resolution.reason;
  return true;
}

function recordTimestamp(record: StoredChatMessage) {
  const parsed = Date.parse(
    normalize(record.receivedAt || record.processedAt || record.acceptedAt),
  );
  return Number.isFinite(parsed) ? parsed : null;
}

function firstTimestampAtOrAfter(timestamps: number[], target: number) {
  let low = 0;
  let high = timestamps.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (timestamps[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function firstTimestampAfter(timestamps: number[], target: number) {
  let low = 0;
  let high = timestamps.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (timestamps[middle] <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function resolveLegacyChatKeyRecordBotIds(
  records: StoredChatMessage[],
): LegacyChatKeyRecordResolution[] {
  const identities = records.map(recordIdentity);
  const resolutions = records.map<LegacyChatKeyRecordResolution>(
    (record, index) => {
      const identity = identities[index];
      if (!identity) {
        return parseLegacyUnqualifiedChatKeyValue(record.chatKey)
          ? { reason: "invalid_identity" }
          : {};
      }
      if (!identity.botId) return {};
      return {
        botId: identity.botId,
        source: identity.legacy ? "persisted" : undefined,
      };
    },
  );
  const unresolvedIndexes = () =>
    identities
      .map((identity, index) => ({ identity, index }))
      .filter(
        (item) => item.identity?.activeLegacy && !resolutions[item.index].botId,
      );

  const messageIndexes = new Map<string, number[]>();
  records.forEach((record, index) => {
    const messageId = normalize(record.messageId);
    if (!messageId) return;
    const indexes = messageIndexes.get(messageId) || [];
    indexes.push(index);
    messageIndexes.set(messageId, indexes);
  });
  const sessionIndexes = new Map<string, number[]>();
  records.forEach((record, index) => {
    const identity = identities[index];
    if (!identity) return;
    for (const [kind, value] of [
      ["file", record.sessionFile],
      ["id", record.sessionId],
    ] as const) {
      const normalized = normalize(value);
      if (!normalized) continue;
      const key = `${conversationKey(identity)}\u0000${kind}\u0000${normalized}`;
      const indexes = sessionIndexes.get(key) || [];
      indexes.push(index);
      sessionIndexes.set(key, indexes);
    }
  });
  // Session evidence is collected only from persisted/canonical anchors. This
  // avoids amplifying one inferred identity across an entire historical
  // session. Reply evidence then uses those stable session results and can
  // override a weaker session inference without iterative full-record scans.
  const directResolutions = resolutions.map((resolution) => ({
    botId: resolution.botId,
  }));
  const sessionBotIds = new Map<string, Set<string>>();
  for (const [key, indexes] of sessionIndexes) {
    const botIds = new Set<string>();
    for (const index of indexes) {
      const botId = normalize(directResolutions[index].botId);
      if (botId) botIds.add(botId);
    }
    sessionBotIds.set(key, botIds);
  }
  for (const { identity, index } of unresolvedIndexes()) {
    if (!identity || resolutions[index].reason) continue;
    const botIds = new Set<string>();
    for (const [kind, value] of [
      ["file", records[index].sessionFile],
      ["id", records[index].sessionId],
    ] as const) {
      const normalized = normalize(value);
      if (!normalized) continue;
      const key = `${conversationKey(identity)}\u0000${kind}\u0000${normalized}`;
      for (const botId of sessionBotIds.get(key) || []) botIds.add(botId);
    }
    resolveSingleEvidence(
      resolutions[index],
      botIds,
      "session",
      "session_conflict",
    );
  }
  const replyEvidenceResolutions = resolutions.map((resolution) => ({
    ...resolution,
  }));
  for (const { identity, index } of identities.map((identity, index) => ({
    identity,
    index,
  }))) {
    if (!identity?.activeLegacy || resolutions[index].source === "persisted") {
      continue;
    }
    const replyToMessageId = normalize(records[index].replyToMessageId);
    if (!replyToMessageId) continue;
    const botIds = uniqueResolvedBotIds(
      messageIndexes.get(replyToMessageId) || [],
      identities,
      replyEvidenceResolutions,
      identity,
    );
    resolveSingleEvidence(
      resolutions[index],
      botIds,
      "reply",
      "reply_conflict",
    );
  }

  const timelines = new Map<string, number[]>();
  identities.forEach((identity, index) => {
    if (!identity) return;
    const key = conversationKey(identity);
    const indexes = timelines.get(key) || [];
    indexes.push(index);
    timelines.set(key, indexes);
  });
  for (const indexes of timelines.values()) {
    const botIdsByTimestamp = new Map<number, Set<string>>();
    for (const index of indexes) {
      const timestamp = recordTimestamp(records[index]);
      const botId = normalize(resolutions[index].botId);
      if (
        timestamp === null ||
        !botId ||
        resolutions[index].source === "neighbor"
      ) {
        continue;
      }
      const botIds = botIdsByTimestamp.get(timestamp) || new Set<string>();
      botIds.add(botId);
      botIdsByTimestamp.set(timestamp, botIds);
    }
    const anchorTimestamps = [...botIdsByTimestamp.keys()].sort(
      (left, right) => left - right,
    );
    for (const index of indexes) {
      const identity = identities[index];
      const timestamp = recordTimestamp(records[index]);
      if (
        !identity?.activeLegacy ||
        resolutions[index].botId ||
        resolutions[index].reason ||
        timestamp === null ||
        botIdsByTimestamp.has(timestamp)
      ) {
        continue;
      }
      const botIds = new Set<string>();
      const previousPosition =
        firstTimestampAtOrAfter(anchorTimestamps, timestamp) - 1;
      const nextPosition = firstTimestampAfter(anchorTimestamps, timestamp);
      if (previousPosition >= 0) {
        for (const botId of botIdsByTimestamp.get(
          anchorTimestamps[previousPosition],
        ) || []) {
          botIds.add(botId);
        }
      }
      if (nextPosition < anchorTimestamps.length) {
        for (const botId of botIdsByTimestamp.get(
          anchorTimestamps[nextPosition],
        ) || []) {
          botIds.add(botId);
        }
      }
      resolveSingleEvidence(
        resolutions[index],
        botIds,
        "neighbor",
        "neighbor_conflict",
      );
    }
  }

  for (const { index } of unresolvedIndexes()) {
    resolutions[index].reason ||= "unresolved";
  }
  return resolutions;
}
