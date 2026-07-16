import { openChatDatabase } from "../chat/database.js";
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
  const rows = openChatDatabase(agentDir)
    .prepare(
      `SELECT chat_key, chat_id, message_id, platform_timestamp,
              received_at, provider_cursor
       FROM inbound_heads
       WHERE platform = ? AND bot_id = ?
       ORDER BY chat_key`,
    )
    .all(nextPlatform, nextBotId) as any[];
  return rows
    .map((row) => {
      const chatKey = safeString(row.chat_key).trim();
      const chatId = safeString(row.chat_id).trim();
      const messageId = safeString(row.message_id).trim();
      if (
        !chatKey ||
        !chatId ||
        !messageId ||
        chatKey !== composeChatKey(nextPlatform, chatId, nextBotId)
      ) {
        return null;
      }
      const platformTimestamp = recoveryTimestamp({
        platformTimestamp: row.platform_timestamp,
        receivedAt: row.received_at,
      });
      const providerCursor = safeString(row.provider_cursor).trim();
      return {
        chatKey,
        chatId,
        messageId,
        platformTimestamp,
        ...(providerCursor ? { providerCursor } : {}),
      };
    })
    .filter((item): item is InboundRecoveryHead => Boolean(item));
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
