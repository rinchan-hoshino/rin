import { listChatMessages } from "../chat/message-store.js";
import { composeChatKey } from "../chat/support.js";
import { safeString } from "../text-utils.js";

export type InboundRecoveryHead = {
  chatKey: string;
  chatId: string;
  messageId: string;
  platformTimestamp: number;
  providerCursor?: string;
};

export class InboundRecoveryGate<T> {
  private buffering = false;
  private items: T[] = [];

  begin() {
    this.buffering = true;
  }

  buffer(item: T) {
    if (!this.buffering) return false;
    this.items.push(item);
    return true;
  }

  drain() {
    return this.items.splice(0);
  }

  prepend(items: T[]) {
    if (items.length) this.items.unshift(...items);
  }

  hasPending() {
    return this.items.length > 0;
  }

  open() {
    if (this.items.length) {
      throw new Error("Inbound recovery gate still has buffered messages");
    }
    this.buffering = false;
  }

  isBuffering() {
    return this.buffering;
  }
}

function compareRecoveryMessageIds(left: unknown, right: unknown) {
  const leftId = safeString(left).trim();
  const rightId = safeString(right).trim();
  if (/^\d+$/.test(leftId) && /^\d+$/.test(rightId)) {
    const leftValue = BigInt(leftId);
    const rightValue = BigInt(rightId);
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  }
  return leftId.localeCompare(rightId);
}

function recoveryTimestamp(record: any) {
  const platformTimestamp = Number(record?.platformTimestamp);
  if (Number.isFinite(platformTimestamp) && platformTimestamp > 0) {
    return platformTimestamp;
  }
  const receivedAt = Date.parse(safeString(record?.receivedAt).trim());
  return Number.isFinite(receivedAt) ? receivedAt : 0;
}

export function listInboundRecoveryHeads(
  agentDir: string,
  platform: string,
  botId: string,
): InboundRecoveryHead[] {
  const nextPlatform = safeString(platform).trim();
  const nextBotId = safeString(botId).trim();
  if (!nextPlatform || !nextBotId) return [];
  const heads = new Map<string, InboundRecoveryHead>();
  for (const record of listChatMessages(agentDir)) {
    if (record.role !== "user") continue;
    if (safeString(record.platform).trim() !== nextPlatform) continue;
    if (safeString(record.botId).trim() !== nextBotId) continue;
    const chatKey = safeString(record.chatKey).trim();
    const chatId = safeString(record.chatId).trim();
    const messageId = safeString(record.messageId).trim();
    if (
      !chatKey ||
      !chatId ||
      !messageId ||
      chatKey !== composeChatKey(nextPlatform, chatId, nextBotId)
    ) {
      continue;
    }
    const platformTimestamp = recoveryTimestamp(record);
    const current = heads.get(chatKey);
    if (
      current &&
      (current.platformTimestamp > platformTimestamp ||
        (current.platformTimestamp === platformTimestamp &&
          compareRecoveryMessageIds(current.messageId, messageId) >= 0))
    ) {
      continue;
    }
    const providerCursor = safeString(record.providerCursor).trim();
    heads.set(chatKey, {
      chatKey,
      chatId,
      messageId,
      platformTimestamp,
      ...(providerCursor ? { providerCursor } : {}),
    });
  }
  return [...heads.values()].sort((left, right) =>
    left.chatKey.localeCompare(right.chatKey),
  );
}

function sessionIdentity(session: any) {
  const platform = safeString(session?.platform).trim();
  const botId = safeString(session?.selfId || session?.bot?.selfId).trim();
  const chatId = safeString(
    session?.channelId || session?.chatId || session?.guildId,
  ).trim();
  const messageId = safeString(
    session?.messageId || session?.id || session?.eventId,
  ).trim();
  return platform && botId && chatId && messageId
    ? `${platform}\u0000${botId}\u0000${chatId}\u0000${messageId}`
    : "";
}

function sessionTimestamp(session: any) {
  const timestamp = Number(session?.timestamp);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

export function mergeInboundRecoverySessions(
  recovered: any[],
  bufferedLive: any[],
) {
  const entries = [
    ...(Array.isArray(recovered) ? recovered : []).map((session, index) => ({
      session,
      timestamp: sessionTimestamp(session),
      sourceOrder: 0,
      index,
    })),
    ...(Array.isArray(bufferedLive) ? bufferedLive : []).map(
      (session, index) => ({
        session,
        timestamp: sessionTimestamp(session),
        sourceOrder: 1,
        index,
      }),
    ),
  ];
  const deduped = new Map<string, (typeof entries)[number]>();
  const anonymous: typeof entries = [];
  for (const entry of entries) {
    const identity = sessionIdentity(entry.session);
    if (!identity) {
      anonymous.push(entry);
      continue;
    }
    const current = deduped.get(identity);
    if (!current) {
      deduped.set(identity, entry);
      continue;
    }
    if (entry.sourceOrder > current.sourceOrder) {
      current.session = entry.session;
    }
  }
  return [...deduped.values(), ...anonymous]
    .sort(
      (left, right) =>
        left.timestamp - right.timestamp ||
        left.sourceOrder - right.sourceOrder ||
        left.index - right.index,
    )
    .map((entry) => entry.session);
}
