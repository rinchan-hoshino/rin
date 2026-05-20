import { safeString } from "../text-utils.js";

export function getHeartbeatChatWhitelist(settings: unknown): Set<string> {
  const root =
    settings && typeof settings === "object" ? (settings as any) : {};
  const chats = Array.isArray(root?.chat?.heartbeat?.chats)
    ? root.chat.heartbeat.chats
    : [];
  return new Set(
    chats.map((item: unknown) => safeString(item).trim()).filter(Boolean),
  );
}

export function isHeartbeatChatEnabled(settings: unknown, chatKey: string) {
  const key = safeString(chatKey).trim();
  return Boolean(key && getHeartbeatChatWhitelist(settings).has(key));
}
