import fs from "node:fs";
import path from "node:path";

import WebSocket from "ws";

import { EditableTextMessageGroup } from "../editable-text-message-group.js";
import { getWorkingReactionFrame } from "../../chat/transport.js";
import { formatRinTodoChecklistMarkdownContent } from "../../rin-lib/todo-state.js";
import {
  compactObject,
  createPrefixedLogger,
  downloadToFile,
  emitBotStatus,
  ensureDir,
  ensureExtension,
  ensureFileName,
  fileUrl,
  isEditableProgressDeliveryKind,
  isImageMimeType,
  isImageName,
  normalizeNode,
  prepareOutboundNodes,
  readBinaryFromNode,
  renderMarkdownFromNodes,
  randomWorkingText,
  renderPlainTextFromNodes,
  renderRichDeliveryErrorPlaceholder,
  resolveChatRuntimeWorkingCopy,
  safeString,
  sleep,
  splitPlainText,
  stripMentionTokens,
} from "../common.js";

export function sanitizeCacheScope(value: unknown, fallback: string) {
  return (
    safeString(value)
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "_") || fallback
  );
}

export const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
export const DISCORD_INTERACTION_RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE = 4;
export const DISCORD_MESSAGE_FLAG_EPHEMERAL = 1 << 6;
export const DISCORD_MAX_TEXT_LENGTH = 2000;
export const SLACK_MAX_TEXT_LENGTH = 40000;

export function isOutboundMediaNodeType(type: string) {
  return ["image", "file", "video", "audio", "sticker"].includes(type);
}

export const SLACK_REACTION_NAMES: Record<string, string> = {
  "🤔": "thinking_face",
  "🔥": "fire",
};

export function createTypingWorkingIndicator(getBot: () => any) {
  return {
    type: "polling",
    presentation: "typing",
    async tick(context: any) {
      const bot = getBot();
      const chatId = safeString(context?.chatId).trim();
      if (!chatId) return false;
      if (typeof bot?.internal?.sendChatAction === "function") {
        const result = await bot.internal.sendChatAction({
          chat_id: chatId,
          action: "typing",
        });
        return result !== false;
      }
      if (typeof bot?.internal?.sendTyping === "function") {
        const result = await bot.internal.sendTyping(chatId);
        return result !== false;
      }
      return false;
    },
  };
}

export function createReactionWorkingIndicator(
  platform: string,
  getBot: () => any,
) {
  const reactions = new Map<string, string>();
  return {
    type: "polling",
    presentation: "reaction",
    async tick(context: any) {
      const bot = getBot();
      const chatId = safeString(context?.chatId).trim();
      if (!chatId) return false;
      let sent = false;
      const messageId = safeString(context?.messageId).trim();
      const createReaction =
        typeof bot?.createReaction === "function"
          ? bot.createReaction.bind(bot)
          : typeof bot?.internal?.createReaction === "function"
            ? bot.internal.createReaction.bind(bot.internal)
            : null;
      const deleteReaction =
        typeof bot?.deleteReaction === "function"
          ? bot.deleteReaction.bind(bot)
          : typeof bot?.internal?.deleteOwnReaction === "function"
            ? bot.internal.deleteOwnReaction.bind(bot.internal)
            : typeof bot?.internal?.deleteReaction === "function"
              ? bot.internal.deleteReaction.bind(bot.internal)
              : null;
      if (messageId && createReaction && context?.reactionDue !== false) {
        const key = `${chatId}:${messageId}`;
        const previousEmoji = reactions.get(key) || "";
        const nextEmoji = getWorkingReactionFrame(
          platform,
          Number(context?.reactionTick ?? context?.tick ?? 0),
        );
        if (nextEmoji && previousEmoji !== nextEmoji) {
          if (previousEmoji && deleteReaction) {
            await deleteReaction(
              chatId,
              messageId,
              previousEmoji,
              safeString(bot?.selfId).trim() || undefined,
            );
          }
          await createReaction(chatId, messageId, nextEmoji);
          reactions.set(key, nextEmoji);
          sent = true;
        }
      }
      return sent;
    },
    async end(context: any) {
      const bot = getBot();
      const chatId = safeString(context?.chatId).trim();
      const messageId = safeString(context?.messageId).trim();
      if (!chatId) return false;
      const deleteReaction =
        typeof bot?.deleteReaction === "function"
          ? bot.deleteReaction.bind(bot)
          : typeof bot?.internal?.deleteOwnReaction === "function"
            ? bot.internal.deleteOwnReaction.bind(bot.internal)
            : typeof bot?.internal?.deleteReaction === "function"
              ? bot.internal.deleteReaction.bind(bot.internal)
              : null;
      if (!deleteReaction) return false;
      const prefix = `${chatId}:`;
      const entries = messageId
        ? [
            [
              `${chatId}:${messageId}`,
              reactions.get(`${chatId}:${messageId}`) || "",
            ],
          ]
        : [...reactions.entries()].filter(([key]) => key.startsWith(prefix));
      let deletedAny = false;
      for (const [key, emoji] of entries) {
        const targetMessageId = key.slice(prefix.length);
        if (!targetMessageId || !emoji) {
          reactions.delete(key);
          continue;
        }
        await deleteReaction(
          chatId,
          targetMessageId,
          emoji,
          safeString(bot?.selfId).trim() || undefined,
        );
        reactions.delete(key);
        deletedAny = true;
      }
      return deletedAny;
    },
  };
}

export const LARK_REACTION_TYPES: Record<string, string> = {
  "🤔": "THINKING",
  "🔥": "Fire",
};

export function escapeLarkTagText(text: string) {
  return safeString(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeLarkTagAttr(text: string) {
  return escapeLarkTagText(text).replace(/"/g, "&quot;");
}

export function normalizeLarkMarkdownListBlocks(text: string) {
  const lines = safeString(text).replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let inFence = false;
  let previousWasList = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const blank = !line.trim();
    const listItem = !inFence && /^\s{0,3}(?:[-*+]\s+|\d+[.)]\s+)/.test(line);
    if (!inFence && previousWasList && !blank && !listItem) {
      const last = out[out.length - 1];
      if (last !== undefined && last.trim()) out.push("");
    }
    out.push(line);
    previousWasList = !inFence && listItem;
    if (blank) previousWasList = false;
  }
  return out.join("\n");
}

export const QQ_REACTION_EMOJI_IDS: Record<string, string> = {
  "🤔": "212",
  "🔥": "128293",
};

export function toSlackReactionName(emoji: string) {
  const value = safeString(emoji).trim();
  return SLACK_REACTION_NAMES[value] || value.replace(/^:+|:+$/g, "");
}

export function escapeSlackMrkdwn(text: string) {
  return safeString(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function truncateSlackPlainText(text: string, maxLength: number) {
  const chars = Array.from(safeString(text).replace(/\s+/g, " ").trim());
  if (chars.length <= maxLength) return chars.join("");
  return `${chars
    .slice(0, Math.max(1, maxLength - 1))
    .join("")
    .trimEnd()}…`;
}

export function todoNodeItems(node: any) {
  const attrs = node?.attrs && typeof node.attrs === "object" ? node.attrs : {};
  const rawItems = Array.isArray(attrs.items)
    ? attrs.items
    : Array.isArray(attrs.todos)
      ? attrs.todos
      : [];
  return rawItems
    .map((item: any) => {
      const value = item && typeof item === "object" ? item : null;
      if (!value) return null;
      const text = safeString(value.text).replace(/\s+/g, " ").trim();
      if (!text) return null;
      return { text, done: Boolean(value.done) };
    })
    .filter(Boolean) as Array<{ text: string; done: boolean }>;
}

export function todoNodeTitle(node: any) {
  const attrs = node?.attrs && typeof node.attrs === "object" ? node.attrs : {};
  return safeString(attrs.title).trim() || "Todo";
}

export function todoFallbackText(
  title: string,
  items: Array<{ text: string; done: boolean }>,
) {
  return [title, formatRinTodoChecklistMarkdownContent(items)]
    .filter(Boolean)
    .join("\n");
}

export function toLarkReactionType(emoji: string) {
  const value = safeString(emoji).trim();
  return LARK_REACTION_TYPES[value] || value;
}

export function toQqReactionPayload(messageId: string, emoji: string) {
  const value = safeString(emoji).trim();
  const [first] = Array.from(value);
  const codePoint = first?.codePointAt(0);
  return {
    message_id: safeString(messageId).trim(),
    emoji_type: 1,
    emoji_id:
      QQ_REACTION_EMOJI_IDS[value] ||
      (Number.isFinite(codePoint) ? String(codePoint) : value),
  };
}

export function collectionValues(value: any) {
  if (!value) return [] as any[];
  if (Array.isArray(value)) return value;
  if (value instanceof Map) return Array.from(value.values());
  if (value?.cache) return collectionValues(value.cache);
  if (typeof value?.values === "function") {
    try {
      return Array.from(value.values());
    } catch {}
  }
  return [] as any[];
}

export function permissionSetHasFlag(value: any, name: string, bit: bigint) {
  if (!value) return false;
  try {
    if (typeof value?.has === "function" && value.has(name)) return true;
  } catch {}
  try {
    if (typeof value?.has === "function" && value.has(bit)) return true;
  } catch {}
  try {
    const raw = value?.bitfield ?? value;
    const bits = typeof raw === "bigint" ? raw : BigInt(raw);
    return (bits & bit) === bit;
  } catch {}
  return false;
}

export function permissionSetHasViewChannel(value: any) {
  return permissionSetHasFlag(value, "ViewChannel", 1024n);
}

export function permissionSetHasAdministrator(value: any) {
  return permissionSetHasFlag(value, "Administrator", 8n);
}

export function isManagedBotRole(role: any) {
  return (
    Boolean(role?.managed) &&
    Boolean(safeString(role?.tags?.botId || role?.tags?.bot_id || "").trim())
  );
}

export function isOwnerHumanUserOrBot(member: any, ownerIds: Set<string>) {
  const user = member?.user || member;
  const userId = safeString(
    user?.id || user?.userId || member?.id || member?.userId || "",
  ).trim();
  if (!userId) return false;
  if (ownerIds.has(userId)) return true;
  return Boolean(user?.bot || member?.bot);
}

export function memberListHasOnlyOwnerHumanUsers(
  members: any[],
  ownerIds: Set<string>,
) {
  return (
    members.length > 0 &&
    members.every((member) => isOwnerHumanUserOrBot(member, ownerIds))
  );
}

export function discordChannelDisplayName(channel: any) {
  return safeString(channel?.name || channel?.rawName || "").trim();
}

export function findDiscordChannelById(collection: any, channelId: string) {
  const id = safeString(channelId).trim();
  if (!id || !collection) return null;
  try {
    const found = collection?.get?.(id);
    if (found) return found;
  } catch {}
  return (
    collectionValues(collection).find(
      (item: any) => safeString(item?.id).trim() === id,
    ) || null
  );
}

export function resolveDiscordParentChannel(channel: any) {
  if (!channel || typeof channel !== "object") return null;
  if (channel.parent && typeof channel.parent === "object") {
    return channel.parent;
  }
  const parentId = safeString(channel?.parentId || channel?.parent_id).trim();
  if (!parentId) return null;
  return (
    findDiscordChannelById(channel?.guild?.channels?.cache, parentId) ||
    findDiscordChannelById(channel?.guild?.channels, parentId)
  );
}

export function formatDiscordChannelPathName(
  channel: any,
  fallbackGuildName: unknown = "",
) {
  if (!channel || typeof channel !== "object") return "";
  const chain: string[] = [];
  const seen = new Set<string>();
  let current = channel;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const id = safeString(current?.id || current?.channelId || "").trim();
    if (id) {
      if (seen.has(id)) break;
      seen.add(id);
    }
    const name = discordChannelDisplayName(current);
    if (name) chain.push(name);
    current = resolveDiscordParentChannel(current);
  }
  const guildName =
    safeString(fallbackGuildName).trim() ||
    safeString(channel?.guild?.name || "").trim();
  const parts = [guildName, ...chain.reverse()]
    .map((part) => safeString(part).trim())
    .filter(Boolean)
    .filter((part, index, values) => index === 0 || part !== values[index - 1]);
  return parts.join(" / ");
}

export function hasUnboundedDiscordAdministratorBypass(
  guild: any,
  ownerIds: Set<string>,
  selfId: string,
  everyoneRoleId: string,
) {
  const guildOwnerId = safeString(
    guild?.ownerId || guild?.ownerID || "",
  ).trim();
  if (!guildOwnerId) return true;
  if (guildOwnerId !== selfId && !ownerIds.has(guildOwnerId)) return true;
  for (const role of collectionValues(guild?.roles)) {
    const roleId = safeString(role?.id).trim();
    if (!permissionSetHasAdministrator(role?.permissions)) continue;
    if (roleId && roleId !== everyoneRoleId && isManagedBotRole(role)) {
      continue;
    }
    return true;
  }
  return false;
}
