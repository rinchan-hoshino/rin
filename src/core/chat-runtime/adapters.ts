import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Lexer } from "marked";
import WebSocket from "ws";

import { EditableTextMessageGroup } from "./editable-text-message-group.js";
import {
  applyInboundRecoveryResult,
  InboundRecoveryGate,
  recoverInboundHeads,
} from "./inbound-recovery.js";
import { composeChatKeyForBot } from "../chat/support.js";
import { getWorkingReactionFrame } from "../chat/transport.js";
import {
  createRinHttpTransport,
  discardRinHttpResponseBody,
  type RinHttpTransport,
} from "../http/transport.js";
import { formatRinTodoChecklistMarkdownContent } from "../rin-lib/todo-state.js";
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
  partialChatDeliveryError,
  prependChatQuoteNode,
  prepareOutboundNodes,
  readBinaryFromNode,
  renderMarkdownFromNodes,
  randomWorkingText,
  renderPlainTextFromNodes,
  renderRichDeliveryFallback,
  resolveChatRuntimeWorkingCopy,
  safeString,
  sleep,
  splitPlainText,
  stripMentionTokens,
} from "./common.js";

function sanitizeCacheScope(value: unknown, fallback: string) {
  return (
    safeString(value)
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "_") || fallback
  );
}

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const DISCORD_INTERACTION_RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE = 4;
const DISCORD_MESSAGE_FLAG_EPHEMERAL = 1 << 6;
const DISCORD_MAX_TEXT_LENGTH = 2000;
export const DISCORD_REST_REQUEST_TIMEOUT_MS = 60_000;
export const DISCORD_REST_RETRIES = 1;
const SLACK_MAX_TEXT_LENGTH = 40000;

export function createDiscordRestRequestStrategy(
  transport: RinHttpTransport = createRinHttpTransport({
    reconstructFormData: true,
  }),
) {
  return {
    makeRequest: transport.fetch,
    close: transport.close,
  };
}

export function createDiscordClientOptions(
  Discord: any,
  restRequest: ReturnType<typeof createDiscordRestRequestStrategy>,
) {
  return {
    intents: [
      Discord.GatewayIntentBits.Guilds,
      Discord.GatewayIntentBits.GuildMessages,
      Discord.GatewayIntentBits.DirectMessages,
      Discord.GatewayIntentBits.MessageContent,
    ].filter(Boolean),
    partials: [Discord.Partials.Channel].filter(Boolean),
    rest: {
      timeout: DISCORD_REST_REQUEST_TIMEOUT_MS,
      retries: DISCORD_REST_RETRIES,
      makeRequest: restRequest.makeRequest,
    },
  };
}

function compareDiscordMessageIds(left: unknown, right: unknown) {
  const leftId = safeString(left).trim();
  const rightId = safeString(right).trim();
  if (/^\d+$/.test(leftId) && /^\d+$/.test(rightId)) {
    const leftValue = BigInt(leftId);
    const rightValue = BigInt(rightId);
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  }
  return leftId.localeCompare(rightId);
}

function isOutboundMediaNodeType(type: string) {
  return ["image", "file", "video", "audio", "sticker"].includes(type);
}

const SLACK_REACTION_NAMES: Record<string, string> = {
  "🤔": "thinking_face",
  "🔥": "fire",
};

function createTypingWorkingIndicator(getBot: () => any) {
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

function createReactionWorkingIndicator(platform: string, getBot: () => any) {
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

const LARK_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const LARK_MAX_FILE_BYTES = 30 * 1024 * 1024;
const LARK_RESOURCE_DOWNLOAD_TIMEOUT_MS = 30_000;

type LarkFileType = "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream";

function larkFileType(name: string, mimeType: string): LarkFileType {
  const extension = path.extname(safeString(name).trim()).toLowerCase();
  const mime = safeString(mimeType).trim().toLowerCase();
  if (extension === ".opus" || mime === "audio/opus") return "opus";
  if (extension === ".mp4" || mime === "video/mp4") return "mp4";
  if (extension === ".pdf" || mime === "application/pdf") return "pdf";
  if ([".doc", ".docx"].includes(extension)) return "doc";
  if ([".xls", ".xlsx"].includes(extension)) return "xls";
  if ([".ppt", ".pptx"].includes(extension)) return "ppt";
  return "stream";
}

const LARK_REACTION_TYPES: Record<string, string> = {
  "🤔": "THINKING",
  "🔥": "Fire",
};

function escapeLarkTagText(text: string) {
  return safeString(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeLarkTagAttr(text: string) {
  return escapeLarkTagText(text).replace(/"/g, "&quot;");
}

function normalizeLarkMarkdownListBlocks(text: string) {
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

function larkPostStyle(styles: string[]) {
  return styles.length ? { style: [...new Set(styles)] } : {};
}

function renderLarkInlineElements(
  tokens: any[],
  styles: string[] = [],
): any[] | null {
  const elements: any[] = [];
  const inlineTokens = Array.isArray(tokens) ? tokens : [];
  for (let index = 0; index < inlineTokens.length; index += 1) {
    const token = inlineTokens[index];
    const type = safeString(token?.type).trim();
    if (type === "text" || type === "escape") {
      elements.push({
        tag: "text",
        text: safeString(token?.text),
        ...larkPostStyle(styles),
      });
      continue;
    }
    if (type === "strong" || type === "em" || type === "del") {
      const style =
        type === "strong" ? "bold" : type === "em" ? "italic" : "lineThrough";
      const nested = renderLarkInlineElements(token?.tokens, [
        ...styles,
        style,
      ]);
      if (!nested) return null;
      elements.push(...nested);
      continue;
    }
    if (type === "link") {
      const href = safeString(token?.href).trim();
      if (!href) return null;
      const nested = renderLarkInlineElements(token?.tokens, styles);
      if (!nested?.length || nested.some((element) => element.tag !== "text")) {
        return null;
      }
      elements.push(
        ...nested.map((element) => ({
          tag: "a",
          text: element.text,
          href,
          ...(element.style ? { style: element.style } : {}),
        })),
      );
      continue;
    }
    if (type === "br") {
      elements.push({ tag: "text", text: "\n", ...larkPostStyle(styles) });
      continue;
    }
    if (type === "html") {
      const match = safeString(token?.raw).match(/^<at\s+user_id="([^"]+)">$/);
      if (!match) return null;
      const nextToken = inlineTokens[index + 1];
      const followingToken = inlineTokens[index + 2];
      const closeIndex =
        safeString(nextToken?.raw) === "</at>"
          ? index + 1
          : safeString(nextToken?.type) === "text" &&
              safeString(followingToken?.raw) === "</at>"
            ? index + 2
            : -1;
      if (closeIndex < 0) return null;
      elements.push({
        tag: "at",
        user_id: match[1],
        ...larkPostStyle(styles),
      });
      index = closeIndex;
      continue;
    }
    return null;
  }
  return elements;
}

function renderLarkPostBlock(token: any): any[] {
  const type = safeString(token?.type).trim();
  if (type === "paragraph" || type === "text") {
    const inline = renderLarkInlineElements(token?.tokens);
    if (inline?.length) return inline;
  }
  if (type === "heading") {
    const inline = renderLarkInlineElements(token?.tokens, ["bold"]);
    if (inline?.length) return inline;
  }
  if (type === "code") {
    const language = safeString(token?.lang).trim().split(/\s+/)[0];
    return [
      {
        tag: "code_block",
        ...(language ? { language } : {}),
        text: safeString(token?.text),
      },
    ];
  }
  if (type === "hr") return [{ tag: "hr" }];
  return [{ tag: "md", text: safeString(token?.raw) }];
}

function renderLarkPostContent(text: string) {
  const source = safeString(text).replace(/\r\n?/g, "\n");
  try {
    const tokens = Lexer.lex(source, { gfm: true }) as any[];
    const content: any[][] = [];
    let pendingBlank = false;
    let previousRaw = "";
    for (const token of tokens) {
      if (safeString(token?.type).trim() === "space") {
        pendingBlank = true;
        continue;
      }
      if (content.length && (pendingBlank || /\n{2,}$/.test(previousRaw))) {
        content.push([{ tag: "text", text: "\n" }]);
      }
      const row = renderLarkPostBlock(token);
      if (row.length) content.push(row);
      previousRaw = safeString(token?.raw);
      pendingBlank = false;
    }
    return content.length ? content : [[{ tag: "text", text: source }]];
  } catch {
    return [[{ tag: "md", text: source }]];
  }
}

function assertLarkApiSuccess(result: any) {
  const code = Number(result?.code);
  if (Number.isFinite(code) && code !== 0) {
    throw new Error(
      `lark_api_error:${code}:${safeString(result?.msg || result?.message || "unknown")}`,
    );
  }
}

function toSlackReactionName(emoji: string) {
  const value = safeString(emoji).trim();
  return SLACK_REACTION_NAMES[value] || value.replace(/^:+|:+$/g, "");
}

function escapeSlackMrkdwn(text: string) {
  return safeString(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncateSlackPlainText(text: string, maxLength: number) {
  const chars = Array.from(safeString(text).replace(/\s+/g, " ").trim());
  if (chars.length <= maxLength) return chars.join("");
  return `${chars
    .slice(0, Math.max(1, maxLength - 1))
    .join("")
    .trimEnd()}…`;
}

function todoNodeItems(node: any) {
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

function todoNodeTitle(node: any) {
  const attrs = node?.attrs && typeof node.attrs === "object" ? node.attrs : {};
  return safeString(attrs.title).trim() || "Todo";
}

function todoFallbackText(
  title: string,
  items: Array<{ text: string; done: boolean }>,
) {
  return [title, formatRinTodoChecklistMarkdownContent(items)]
    .filter(Boolean)
    .join("\n");
}

function toLarkReactionType(emoji: string) {
  const value = safeString(emoji).trim();
  return LARK_REACTION_TYPES[value] || value;
}

function collectionValues(value: any) {
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

function permissionSetHasFlag(value: any, name: string, bit: bigint) {
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

function permissionSetHasViewChannel(value: any) {
  return permissionSetHasFlag(value, "ViewChannel", 1024n);
}

function permissionSetHasAdministrator(value: any) {
  return permissionSetHasFlag(value, "Administrator", 8n);
}

function isManagedBotRole(role: any) {
  return (
    Boolean(role?.managed) &&
    Boolean(safeString(role?.tags?.botId || role?.tags?.bot_id || "").trim())
  );
}

function isOwnerHumanUserOrBot(member: any, ownerIds: Set<string>) {
  const user = member?.user || member;
  const userId = safeString(
    user?.id || user?.userId || member?.id || member?.userId || "",
  ).trim();
  if (!userId) return false;
  if (ownerIds.has(userId)) return true;
  return Boolean(user?.bot || member?.bot);
}

function memberListHasOnlyOwnerHumanUsers(
  members: any[],
  ownerIds: Set<string>,
) {
  return (
    members.length > 0 &&
    members.every((member) => isOwnerHumanUserOrBot(member, ownerIds))
  );
}

function discordChannelDisplayName(channel: any) {
  return safeString(channel?.name || channel?.rawName || "").trim();
}

function findDiscordChannelById(collection: any, channelId: string) {
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

function resolveDiscordParentChannel(channel: any) {
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

function formatDiscordChannelPathName(
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

function hasUnboundedDiscordAdministratorBypass(
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

export class DiscordAdapter {
  private readonly app: any;
  private readonly config: Record<string, any>;
  private readonly logger: any;
  private readonly cacheDir: string;
  private readonly editableWorking: EditableTextMessageGroup;
  private readonly inboundGate = new InboundRecoveryGate<any>();
  private client: any = null;
  private restRequest: ReturnType<
    typeof createDiscordRestRequestStrategy
  > | null = null;
  readonly bot: any;

  constructor(
    app: any,
    dataDir: string,
    config: Record<string, any>,
    logger: any,
  ) {
    this.app = app;
    this.config = config;
    this.logger = createPrefixedLogger("chat-runtime:discord", logger);
    this.cacheDir = path.join(dataDir, "chat", "runtime-cache", "discord");
    ensureDir(this.cacheDir);
    const internal: any = {
      client: null,
      rest: null,
      fetchChannel: async (channelId: string) =>
        await this.fetchChannel(channelId),
      fetchGuild: async (guildId: string) =>
        await this.client?.guilds?.fetch?.(guildId),
      fetchGuildMember: async (guildId: string, userId: string) => {
        const guild = await this.client?.guilds?.fetch?.(guildId);
        return await guild?.members?.fetch?.(userId);
      },
      sendTyping: async (channelId: string) => {
        const channel = await this.fetchChannel(channelId);
        return await channel?.sendTyping?.();
      },
      createReaction: async (
        channelId: string,
        messageId: string,
        emoji: string,
      ) => {
        const message = await this.fetchMessage(channelId, messageId);
        return await message?.react?.(emoji);
      },
      deleteOwnReaction: async (
        channelId: string,
        messageId: string,
        emoji: string,
      ) => {
        const message = await this.fetchMessage(channelId, messageId);
        const reaction = message?.reactions?.cache?.find?.(
          (item: any) => item?.emoji?.name === emoji,
        );
        return await reaction?.users?.remove?.(
          safeString(this.bot?.selfId).trim(),
        );
      },
      editMessage: async (
        channelId: string,
        messageId: string,
        payload: any,
      ) => {
        const message = await this.fetchMessage(channelId, messageId);
        return await message?.edit?.(payload);
      },
      deleteMessage: async (channelId: string, messageId: string) => {
        const channel = await this.fetchChannel(channelId);
        return await channel?.messages?.delete?.(messageId);
      },
      setApplicationCommands: async (payload: any) =>
        await this.setApplicationCommands(payload),
      hasOnlyOwnerUsers: async (channelId: string, ownerUserIds: string[]) =>
        await this.hasOnlyOwnerUsers(channelId, ownerUserIds),
    };
    this.editableWorking = new EditableTextMessageGroup({
      cacheDir: this.cacheDir,
      cacheScope: sanitizeCacheScope(config?.token, "default"),
      maxTextLength: DISCORD_MAX_TEXT_LENGTH,
      agentDir: app?.agentDir,
      sendText: async ({ chatId, text, replyToMessageId }) => {
        const channel = await this.fetchChannel(chatId);
        if (!channel?.send)
          throw new Error(`discord_channel_not_sendable:${chatId}`);
        return await this.sendTextChunk(channel, { text, replyToMessageId });
      },
      editText: async ({ chatId, messageId, text }) => {
        const edited = await internal.editMessage(chatId, messageId, {
          content: text,
        });
        return safeString(edited?.id || messageId).trim();
      },
      deleteMessage: async ({ chatId, messageId }) =>
        await internal.deleteMessage(chatId, messageId),
    });
    this.bot = {
      platform: "discord",
      selfId: "",
      status: 0,
      workingIndicators: [
        this.editableWorking.indicator(),
        createReactionWorkingIndicator("discord", () => this.bot),
        createTypingWorkingIndicator(() => this.bot),
      ],
      user: {},
      internal,
      sendMessage: async (chatId: string, content: any, options?: any) =>
        await this.sendMessage(chatId, content, options),
      createReaction: async (
        chatId: string,
        messageId: string,
        emoji: string,
      ) => await internal.createReaction(chatId, messageId, emoji),
      deleteReaction: async (
        chatId: string,
        messageId: string,
        emoji: string,
      ) => await internal.deleteOwnReaction(chatId, messageId, emoji),
      getGuildMember: async (chatId: string, userId: string) => {
        const channel = await this.fetchChannel(chatId);
        const member = await channel?.guild?.members?.fetch?.(userId);
        if (typeof channel?.permissionsFor === "function") {
          const permissions = channel.permissionsFor(member);
          if (!permissionSetHasViewChannel(permissions)) return null;
        }
        return member;
      },
      hasOnlyOwnerUsers: async (chatId: string, ownerUserIds: string[]) =>
        await this.hasOnlyOwnerUsers(chatId, ownerUserIds),
    };
    this.app.register(this, this.bot);
  }

  private async fetchChannel(channelId: string) {
    return await this.client?.channels?.fetch?.(channelId);
  }

  private async fetchMessage(channelId: string, messageId: string) {
    const channel = await this.fetchChannel(channelId);
    return await channel?.messages?.fetch?.(messageId);
  }

  private discordCommandGuildIds(value: unknown) {
    const rawItems = Array.isArray(value)
      ? value
      : safeString(value)
          .split(",")
          .map((item) => item.trim());
    return rawItems.map((item) => safeString(item).trim()).filter(Boolean);
  }

  private discordApplicationId() {
    return safeString(
      this.bot?.selfId ||
        this.client?.application?.id ||
        this.client?.user?.id ||
        "",
    ).trim();
  }

  private discordApplicationCommandsRoute(guildId = "") {
    const applicationId = this.discordApplicationId();
    if (!applicationId) return "";
    const encodedApplicationId = encodeURIComponent(applicationId);
    const encodedGuildId = encodeURIComponent(safeString(guildId).trim());
    return encodedGuildId
      ? `/applications/${encodedApplicationId}/guilds/${encodedGuildId}/commands`
      : `/applications/${encodedApplicationId}/commands`;
  }

  private async setApplicationCommands(payload: any) {
    const commands = Array.isArray(payload?.commands) ? payload.commands : [];
    const guildIds = this.discordCommandGuildIds(
      payload?.guildIds ??
        this.config?.commandGuildIds ??
        this.config?.applicationCommandGuildIds,
    );
    const setCommands = this.client?.application?.commands?.set;
    if (typeof setCommands === "function") {
      if (guildIds.length) {
        for (const guildId of guildIds) {
          await setCommands.call(
            this.client.application.commands,
            commands,
            guildId,
          );
        }
        return true;
      }
      await setCommands.call(this.client.application.commands, commands);
      return true;
    }

    const rest = this.client?.rest || this.bot?.internal?.rest;
    if (typeof rest?.put !== "function") return false;
    const routes = guildIds.length
      ? guildIds.map((guildId) => this.discordApplicationCommandsRoute(guildId))
      : [this.discordApplicationCommandsRoute()];
    const validRoutes = routes.filter(Boolean);
    if (!validRoutes.length) return false;
    for (const route of validRoutes) {
      await rest.put(route, { body: commands });
    }
    return true;
  }

  private cachedChannelMembersForOwnerOnlyCheck(channel: any) {
    const channelMembers = collectionValues(channel?.members);
    if (channelMembers.length) return channelMembers;
    return collectionValues(channel?.guild?.members?.cache);
  }

  private async hasOnlyOwnerUsers(channelId: string, ownerUserIds: string[]) {
    const channel = await this.fetchChannel(channelId);
    const ownerIds = new Set(
      (Array.isArray(ownerUserIds) ? ownerUserIds : [])
        .map((id) => safeString(id).trim())
        .filter(Boolean),
    );
    if (!channel || !ownerIds.size) return false;
    const guild = channel?.guild;
    const selfId = safeString(this.bot?.selfId).trim();
    const everyoneRoleId = safeString(
      guild?.roles?.everyone?.id || guild?.id || "",
    ).trim();
    const overwrites = collectionValues(channel?.permissionOverwrites);
    const cachedMembers = this.cachedChannelMembersForOwnerOnlyCheck(channel);
    if (memberListHasOnlyOwnerHumanUsers(cachedMembers, ownerIds)) return true;
    if (!everyoneRoleId || !overwrites.length) return false;
    if (
      hasUnboundedDiscordAdministratorBypass(
        guild,
        ownerIds,
        selfId,
        everyoneRoleId,
      )
    ) {
      return false;
    }

    const everyoneOverwrite = overwrites.find(
      (overwrite) => safeString(overwrite?.id).trim() === everyoneRoleId,
    );
    if (!permissionSetHasViewChannel(everyoneOverwrite?.deny)) return false;

    for (const overwrite of overwrites) {
      if (!permissionSetHasViewChannel(overwrite?.allow)) continue;
      const id = safeString(overwrite?.id).trim();
      if (!id || id === everyoneRoleId) return false;
      if (id === selfId || ownerIds.has(id)) continue;
      const role = collectionValues(guild?.roles).find(
        (item: any) => safeString(item?.id).trim() === id,
      );
      if (isManagedBotRole(role)) continue;
      try {
        const member = await guild?.members?.fetch?.(id);
        if (isOwnerHumanUserOrBot(member, ownerIds)) continue;
      } catch {}
      return false;
    }
    return true;
  }

  private mergeDiscordRecoveryMessages(recovered: any[], buffered: any[]) {
    const messages = new Map<string, any>();
    for (const message of [...recovered, ...buffered]) {
      const messageId = safeString(message?.id).trim();
      if (messageId) messages.set(messageId, message);
    }
    return [...messages.values()].sort((left, right) =>
      compareDiscordMessageIds(left?.id, right?.id),
    );
  }

  private async fetchDiscordMessagesAfter(
    channel: any,
    initialMessageId: string,
  ) {
    const recovered: any[] = [];
    let cursor = initialMessageId;
    for (;;) {
      const response = await channel?.messages?.fetch?.({
        after: cursor,
        limit: 100,
      });
      const page = collectionValues(response)
        .filter((message) => compareDiscordMessageIds(message?.id, cursor) > 0)
        .sort((left, right) => compareDiscordMessageIds(left?.id, right?.id));
      if (!page.length) break;
      recovered.push(...page);
      const nextCursor = safeString(page.at(-1)?.id).trim();
      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }
    return recovered;
  }

  private discordInboundChatId(message: any) {
    return safeString(message?.channelId || message?.channel?.id).trim();
  }

  private async releaseDiscordIngress(messages: any[]) {
    for (const message of messages) await this.handleMessage(message);
  }

  private async releaseDiscordReadyChats(chatIds: string[]) {
    const botId = safeString(this.bot?.selfId).trim();
    const chats = chatIds.map((chatId) => ({
      chatId,
      chatKey: composeChatKeyForBot(this.app, "discord", chatId, botId),
    }));
    for (const { chatKey } of chats) {
      if (chatKey) this.app?.beginInboundRecoveryChat?.(chatKey);
    }
    for (const { chatId, chatKey } of chats) {
      await this.finishDiscordRecovery(chatId, []);
      if (chatKey) this.app?.completeInboundRecoveryChat?.(chatKey);
    }
  }

  private async recoverDiscordMessages(onConfigured?: () => void) {
    const agentDir = safeString(this.app?.agentDir).trim();
    const botId = safeString(this.bot?.selfId).trim();
    if (!agentDir || !botId) {
      await this.releaseDiscordReadyChats(this.inboundGate.configure([]));
      onConfigured?.();
      return;
    }
    const result = await recoverInboundHeads(
      agentDir,
      "discord",
      botId,
      async (head) => {
        const channel = await this.fetchChannel(head.chatId);
        if (!channel?.messages?.fetch) {
          throw new Error("Discord message history is unavailable");
        }
        return await this.fetchDiscordMessagesAfter(channel, head.messageId);
      },
      {
        concurrency: 4,
        onHeads: async (heads) => {
          for (const head of heads) {
            this.app?.beginInboundRecoveryChat?.(head.chatKey);
          }
          this.bot.inboundRecovery = heads.length
            ? {
                status: "recovering",
                pending: heads.map((head) => head.chatKey),
              }
            : { status: "ready" };
          await this.releaseDiscordReadyChats(
            this.inboundGate.configure(heads.map((head) => head.chatId)),
          );
          onConfigured?.();
        },
        onHeadSettled: async (outcome) => {
          await this.finishDiscordRecovery(
            outcome.head.chatId,
            outcome.recovered,
          );
          this.app?.completeInboundRecoveryChat?.(outcome.head.chatKey);
        },
      },
    );
    applyInboundRecoveryResult(this.bot, this.logger, result);
  }

  private async finishDiscordRecovery(chatId: string, recovered: any[]) {
    let nextRecovered = recovered;
    for (;;) {
      const buffered = this.inboundGate.drain(chatId);
      const messages = this.mergeDiscordRecoveryMessages(
        nextRecovered,
        buffered,
      );
      nextRecovered = [];
      const handledMessages = new Set<any>();
      const handledMessageIds = new Set<string>();
      try {
        for (const message of messages) {
          await this.handleMessage(message);
          handledMessages.add(message);
          const messageId = safeString(message?.id).trim();
          if (messageId) handledMessageIds.add(messageId);
        }
      } catch (error) {
        this.inboundGate.prepend(
          chatId,
          buffered.filter((message) => {
            const messageId = safeString(message?.id).trim();
            return (
              !handledMessages.has(message) &&
              (!messageId || !handledMessageIds.has(messageId))
            );
          }),
        );
        throw error;
      }
      if (!this.inboundGate.hasPending(chatId)) break;
    }
    this.inboundGate.open(chatId);
  }

  async start() {
    const token = safeString(this.config?.token).trim();
    if (!token) throw new Error("discord_token_required");
    const Discord: any = await import("discord.js");
    this.restRequest = createDiscordRestRequestStrategy();
    this.client = new Discord.Client(
      createDiscordClientOptions(Discord, this.restRequest),
    );
    this.bot.internal.client = this.client;
    this.bot.internal.rest = this.client.rest;

    this.inboundGate.begin();
    let resolveReady: () => void = () => {};
    let rejectReady: (error: unknown) => void = () => {};
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.client.once(Discord.Events.ClientReady, (client: any) => {
      void (async () => {
        this.bot.selfId = safeString(client?.user?.id).trim();
        this.bot.user = {
          id: this.bot.selfId,
          userId: this.bot.selfId,
          name:
            safeString(client?.user?.globalName).trim() ||
            safeString(client?.user?.username).trim() ||
            undefined,
          username: safeString(client?.user?.username).trim() || undefined,
          nick:
            safeString(client?.user?.globalName).trim() ||
            safeString(client?.user?.username).trim() ||
            undefined,
        };
        await this.recoverDiscordMessages(() => {
          emitBotStatus(this.app, this.bot, 1);
        });
        resolveReady();
      })().catch(rejectReady);
    });

    this.client.on(Discord.Events.MessageCreate, (message: any) => {
      if (
        this.inboundGate.buffer(this.discordInboundChatId(message), message)
      ) {
        return;
      }
      void this.handleMessage(message).catch((error: any) => {
        this.logger?.warn?.(
          `message handling failed err=${safeString(error?.message || error)}`,
        );
      });
    });

    this.client.on(Discord.Events.InteractionCreate, (interaction: any) => {
      void this.handleInteraction(interaction).catch((error: any) => {
        this.logger?.warn?.(
          `interaction handling failed err=${safeString(error?.message || error)}`,
        );
      });
    });

    this.client.on(Discord.Events.ShardDisconnect, () => {
      emitBotStatus(this.app, this.bot, 0);
    });
    this.client.on(Discord.Events.Error, (error: any) => {
      this.logger?.warn?.(
        `client error err=${safeString(error?.message || error)}`,
      );
    });

    await this.client.login(token);
    try {
      await ready;
    } catch (error: any) {
      this.bot.inboundRecovery = {
        status: "degraded",
        failures: [
          safeString(error?.message || error).trim() || "catch_up_failed",
        ],
      };
      await this.closeClient();
      throw error;
    }
  }

  private async closeClient() {
    try {
      await this.client?.destroy?.();
    } catch {}
    try {
      await this.restRequest?.close();
    } catch {}
    this.client = null;
    this.restRequest = null;
  }

  async stop() {
    await this.closeClient();
    emitBotStatus(this.app, this.bot, 0);
  }

  private renderOutboundText(nodes: any[]) {
    return renderMarkdownFromNodes(nodes, {
      includeMedia: false,
      renderAt(attrs) {
        const id = safeString(attrs.id).trim();
        return id ? `<@${id}>` : safeString(attrs.name).trim();
      },
    });
  }

  private async readOutboundFile(node: any) {
    const payload = await readBinaryFromNode(node);
    if (!payload) return null;
    if (payload.url) return payload.url;
    return {
      attachment: payload.data,
      name: payload.name,
    };
  }

  private async sendTextChunk(
    channel: any,
    input: { text: string; replyToMessageId?: string },
  ) {
    const delivered: string[] = [];
    for (const textChunk of splitPlainText(
      input.text,
      DISCORD_MAX_TEXT_LENGTH,
    )) {
      const sent = await channel.send(
        compactObject({
          content: textChunk,
          reply:
            input.replyToMessageId && !delivered.length
              ? {
                  messageReference: input.replyToMessageId,
                  failIfNotExists: false,
                }
              : undefined,
        }),
      );
      const messageId = safeString(sent?.id).trim();
      if (messageId) delivered.push(messageId);
    }
    return delivered;
  }

  private async sendMediaChunk(
    channel: any,
    input: { node: any; replyToMessageId?: string },
  ) {
    const file = await this.readOutboundFile(input.node);
    if (!file) return [] as string[];
    const sent = await channel.send(
      compactObject({
        files: [file],
        reply: input.replyToMessageId
          ? {
              messageReference: input.replyToMessageId,
              failIfNotExists: false,
            }
          : undefined,
      }),
    );
    return [safeString(sent?.id).trim()].filter(Boolean);
  }

  private async sendMessage(
    chatId: string,
    content: any,
    options: Record<string, any> = {},
  ) {
    const channel = await this.fetchChannel(chatId);
    if (!channel?.send)
      throw new Error(`discord_channel_not_sendable:${chatId}`);
    const deliveryKind = safeString(options?.deliveryKind).trim() || "final";
    const isFinalDelivery = deliveryKind === "final";
    const { work, replyToMessageId } = prepareOutboundNodes(content);
    const delivered: string[] = [];
    const failures: unknown[] = [];
    let cursor = 0;
    let firstReply = replyToMessageId;
    let finalizedWorkingMessage = false;
    const ensureFinalProgressCleared = async () => {
      if (!isFinalDelivery || finalizedWorkingMessage) return;
      await this.editableWorking.deleteProgress(chatId, replyToMessageId);
      finalizedWorkingMessage = true;
    };
    const recordFailure = async (error: unknown, nodes: any[]) => {
      this.logger.warn(
        `rich message segment failed err=${safeString((error as any)?.message || error)}`,
      );
      const fallback = renderRichDeliveryFallback(nodes);
      if (!fallback) {
        failures.push(error);
        return;
      }
      try {
        await ensureFinalProgressCleared();
        const fallbackIds = await this.sendTextChunk(channel, {
          text: fallback,
          replyToMessageId: firstReply,
        });
        if (!fallbackIds.length) {
          failures.push(error);
          return;
        }
        delivered.push(...fallbackIds);
        firstReply = undefined;
      } catch (fallbackError: any) {
        failures.push(error);
        this.logger.warn(
          `rich fallback delivery failed err=${safeString(fallbackError?.message || fallbackError)}`,
        );
      }
    };
    while (cursor < work.length) {
      const type = safeString(work[cursor]?.type).toLowerCase();
      let chunkIds: string[] = [];
      if (isOutboundMediaNodeType(type)) {
        try {
          await ensureFinalProgressCleared();
          chunkIds = await this.sendMediaChunk(channel, {
            node: work[cursor],
            replyToMessageId: firstReply,
          });
        } catch (error) {
          await recordFailure(error, [work[cursor]]);
        }
        cursor += 1;
      } else {
        const textNodes: any[] = [];
        while (cursor < work.length) {
          const textType = safeString(work[cursor]?.type).toLowerCase();
          if (isOutboundMediaNodeType(textType)) break;
          textNodes.push(work[cursor]);
          cursor += 1;
        }
        let text = "";
        try {
          text = this.renderOutboundText(textNodes);
        } catch (error) {
          await recordFailure(error, textNodes);
        }
        try {
          const coalesceWithWorkingMessage = Boolean(
            options?.coalesceWithWorkingMessage,
          );
          const shouldEditWorkingMessage =
            delivered.length === 0 &&
            coalesceWithWorkingMessage &&
            isEditableProgressDeliveryKind(deliveryKind);
          let textChunkIds: string[] = [];
          if (shouldEditWorkingMessage) {
            textChunkIds = await this.editableWorking.updateText({
              chatId,
              text,
              replyToMessageId: firstReply,
              finalize: false,
              kind:
                deliveryKind === "passive_notice"
                  ? "todo"
                  : deliveryKind === "interim"
                    ? "interim"
                    : undefined,
            });
          } else {
            await ensureFinalProgressCleared();
            textChunkIds = await this.sendTextChunk(channel, {
              text,
              replyToMessageId: firstReply,
            });
          }
          delivered.push(...textChunkIds);
          if (textChunkIds.length) firstReply = undefined;
        } catch (error) {
          await recordFailure(error, textNodes);
        }
      }
      delivered.push(...chunkIds);
      if (chunkIds.length) firstReply = undefined;
    }
    if (isFinalDelivery && !finalizedWorkingMessage) {
      await this.editableWorking.deleteProgress(chatId, replyToMessageId);
    }
    if (failures.length) {
      if (delivered.length) {
        throw partialChatDeliveryError(failures[0], delivered);
      }
      throw failures[0];
    }
    if (delivered.length) return delivered;
    throw new Error("discord_send_message_empty_result");
  }

  private async acknowledgeInteraction(interaction: any) {
    if (interaction?.deferred || interaction?.replied) return;
    const interactionId = safeString(interaction?.id).trim();
    const interactionToken = safeString(interaction?.token).trim();
    const responseBody = {
      type: DISCORD_INTERACTION_RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: randomWorkingText(
          resolveChatRuntimeWorkingCopy(this.app?.agentDir).frames,
        ),
        flags: DISCORD_MESSAGE_FLAG_EPHEMERAL,
      },
    };
    if (interactionId && interactionToken && this.restRequest) {
      try {
        const response = await this.restRequest.makeRequest(
          `${DISCORD_API_BASE_URL}/interactions/${encodeURIComponent(interactionId)}/${encodeURIComponent(interactionToken)}/callback`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(responseBody),
          },
        );
        try {
          if (response.ok) return;
          const detail = safeString(await response.text()).trim();
          this.logger.warn(
            `interaction acknowledge failed status=${response.status}${detail ? ` err=${detail}` : ""}`,
          );
          return;
        } finally {
          await discardRinHttpResponseBody(response);
        }
      } catch (error: any) {
        this.logger.warn(
          `interaction acknowledge direct callback failed err=${safeString(error?.message || error)}`,
        );
      }
    }
    if (interaction?.deferred || interaction?.replied) return;
    if (typeof interaction?.reply !== "function") return;
    try {
      await interaction.reply(responseBody.data);
    } catch (error: any) {
      this.logger.warn(
        `interaction acknowledge failed err=${safeString(error?.message || error)}`,
      );
    }
  }

  private discordInteractionCommandLine(interaction: any) {
    const commandName = safeString(interaction?.commandName)
      .trim()
      .toLowerCase();
    if (!commandName) return "";
    let input = "";
    try {
      input = safeString(interaction?.options?.getString?.("input")).trim();
    } catch {}
    return `/${commandName}${input ? ` ${input}` : ""}`;
  }

  private async handleInteraction(interaction: any) {
    if (!interaction?.isChatInputCommand?.()) return;
    const userId = safeString(interaction?.user?.id).trim();
    if (!userId || userId === safeString(this.bot?.selfId).trim()) return;
    if (Boolean(interaction?.user?.bot)) return;
    const commandLine = this.discordInteractionCommandLine(interaction);
    if (!commandLine) return;
    await this.acknowledgeInteraction(interaction);
    const channelId = safeString(interaction?.channelId).trim();
    const guildId = safeString(interaction?.guildId || "").trim();
    const rawChannelName = safeString(interaction?.channel?.name || "").trim();
    const guildName = safeString(interaction?.guild?.name || "").trim();
    const chatName =
      formatDiscordChannelPathName(interaction?.channel, guildName) ||
      rawChannelName;
    const displayName =
      safeString(interaction?.member?.displayName).trim() ||
      safeString(interaction?.user?.globalName).trim() ||
      safeString(interaction?.user?.username).trim() ||
      undefined;
    this.app.emit("message", {
      platform: "discord",
      selfId: safeString(this.bot?.selfId).trim() || undefined,
      bot: this.bot,
      messageId: safeString(interaction?.id).trim(),
      timestamp: Number(interaction?.createdTimestamp) || Date.now(),
      userId,
      author: {
        userId,
        name: displayName,
        nick: displayName,
        username: safeString(interaction?.user?.username).trim() || undefined,
      },
      user: {
        id: userId,
        userId,
        name: displayName,
        nick: displayName,
        username: safeString(interaction?.user?.username).trim() || undefined,
      },
      channelId,
      chatName: chatName || undefined,
      channelPathName: chatName || undefined,
      channelName: rawChannelName || undefined,
      guildId: guildId || undefined,
      guildName: guildName || undefined,
      isDirect: !guildId,
      content: commandLine,
      stripped: {
        appel: true,
        content: commandLine,
      },
      elements: [normalizeNode("text", { content: commandLine })],
    });
  }

  private async handleMessage(message: any) {
    if (
      !message ||
      safeString(message?.author?.id).trim() ===
        safeString(this.bot?.selfId).trim()
    ) {
      return;
    }
    if (Boolean(message?.author?.bot)) return;
    const userId = safeString(message?.author?.id).trim();
    if (!userId) return;
    const isDirect = !safeString(message?.guildId).trim();
    const rawChannelName = safeString(message?.channel?.name || "").trim();
    const guildName = safeString(
      message?.guild?.name || message?.channel?.guild?.name || "",
    ).trim();
    const chatName =
      formatDiscordChannelPathName(message?.channel, guildName) ||
      rawChannelName;
    const mentionSelf = Boolean(
      message?.mentions?.users?.has?.(safeString(this.bot?.selfId).trim()),
    );
    const rawText = safeString(message?.content || "").trim();
    const strippedContent = mentionSelf
      ? stripMentionTokens(rawText, [
          `<@${safeString(this.bot?.selfId).trim()}>`,
          `<@!${safeString(this.bot?.selfId).trim()}>`,
        ])
      : rawText;
    const elements: any[] = [];
    if (strippedContent) {
      elements.push(normalizeNode("text", { content: strippedContent }));
    }
    for (const attachment of message?.attachments?.values?.() || []) {
      const url = safeString(
        attachment?.url || attachment?.proxyURL || "",
      ).trim();
      if (!url) continue;
      const mimeType = safeString(attachment?.contentType || "").trim();
      elements.push(
        normalizeNode(
          isImageMimeType(mimeType) || isImageName(attachment?.name)
            ? "image"
            : "file",
          compactObject({
            src: url,
            mime: mimeType || undefined,
            mimeType: mimeType || undefined,
            name: safeString(attachment?.name).trim() || undefined,
          }),
        ),
      );
    }
    const canonicalElements = prependChatQuoteNode(
      elements,
      message?.reference?.messageId,
    );
    this.app.emit("message", {
      platform: "discord",
      selfId: safeString(this.bot?.selfId).trim() || undefined,
      bot: this.bot,
      messageId: safeString(message?.id).trim(),
      timestamp: Number(message?.createdTimestamp) || Date.now(),
      userId,
      author: {
        userId,
        name:
          safeString(message?.member?.displayName).trim() ||
          safeString(message?.author?.globalName).trim() ||
          safeString(message?.author?.username).trim() ||
          undefined,
        nick:
          safeString(message?.member?.displayName).trim() ||
          safeString(message?.author?.globalName).trim() ||
          safeString(message?.author?.username).trim() ||
          undefined,
        username: safeString(message?.author?.username).trim() || undefined,
      },
      user: {
        id: userId,
        userId,
        name:
          safeString(message?.member?.displayName).trim() ||
          safeString(message?.author?.globalName).trim() ||
          safeString(message?.author?.username).trim() ||
          undefined,
        nick:
          safeString(message?.member?.displayName).trim() ||
          safeString(message?.author?.globalName).trim() ||
          safeString(message?.author?.username).trim() ||
          undefined,
        username: safeString(message?.author?.username).trim() || undefined,
      },
      channelId: safeString(message?.channelId).trim(),
      chatName: chatName || undefined,
      channelPathName: chatName || undefined,
      channelName: rawChannelName || undefined,
      guildId: safeString(message?.guildId || "").trim() || undefined,
      guildName: guildName || undefined,
      isDirect,
      content: rawText,
      stripped: {
        appel: mentionSelf,
        content: strippedContent,
      },
      elements: canonicalElements,
    });
  }
}

export class SlackAdapter {
  private readonly app: any;
  private readonly config: Record<string, any>;
  private readonly logger: any;
  private readonly cacheDir: string;
  private readonly editableWorking: EditableTextMessageGroup;
  private readonly httpTransport = createRinHttpTransport();
  private web: any = null;
  private socket: any = null;
  readonly bot: any;

  constructor(
    app: any,
    dataDir: string,
    config: Record<string, any>,
    logger: any,
  ) {
    this.app = app;
    this.config = config;
    this.logger = createPrefixedLogger("chat-runtime:slack", logger);
    this.cacheDir = path.join(dataDir, "chat", "runtime-cache", "slack");
    ensureDir(this.cacheDir);
    const internal: any = {
      web: null,
      socket: null,
      apiCall: async (method: string, options?: any) =>
        await this.web?.apiCall?.(method, options || {}),
      postMessage: async (options: any) =>
        await this.web?.chat?.postMessage?.(options),
      updateMessage: async (options: any) =>
        await this.web?.chat?.update?.(options),
      deleteMessage: async (options: any) =>
        await this.web?.chat?.delete?.(options),
      conversationsInfo: async (options: any) =>
        await this.web?.conversations?.info?.(options),
      conversationsMembers: async (options: any) =>
        await this.web?.conversations?.members?.(options),
      reactionsAdd: async (options: any) =>
        await this.web?.reactions?.add?.(options),
      reactionsRemove: async (options: any) =>
        await this.web?.reactions?.remove?.(options),
      filesUploadV2: async (options: any) =>
        await this.web?.files?.uploadV2?.(options),
    };
    this.editableWorking = new EditableTextMessageGroup({
      cacheDir: this.cacheDir,
      cacheScope: sanitizeCacheScope(
        config?.botToken || config?.token,
        "default",
      ),
      maxTextLength: SLACK_MAX_TEXT_LENGTH,
      agentDir: app?.agentDir,
      repeatReplyToMessageId: true,
      sendText: async ({ chatId, text, replyToMessageId }) =>
        await this.postText(chatId, text, replyToMessageId),
      editText: async ({ chatId, messageId, text }) => {
        const updated = await internal.updateMessage({
          channel: chatId,
          ts: messageId,
          text,
        });
        return safeString(updated?.ts || messageId).trim();
      },
      deleteMessage: async ({ chatId, messageId }) =>
        await internal.deleteMessage({ channel: chatId, ts: messageId }),
    });
    this.bot = {
      platform: "slack",
      selfId: "",
      status: 0,
      workingIndicators: [
        this.editableWorking.indicator(),
        createReactionWorkingIndicator("slack", () => this.bot),
        createTypingWorkingIndicator(() => this.bot),
      ],
      user: {},
      internal,
      sendMessage: async (chatId: string, content: any, options?: any) =>
        await this.sendMessage(chatId, content, options),
      createReaction: async (
        chatId: string,
        messageId: string,
        emoji: string,
      ) => await this.createReaction(chatId, messageId, emoji),
      deleteReaction: async (
        chatId: string,
        messageId: string,
        emoji: string,
      ) => await this.deleteReaction(chatId, messageId, emoji),
    };
    this.app.register(this, this.bot);
  }

  async start() {
    const botToken = safeString(this.config?.botToken).trim();
    const appToken = safeString(this.config?.token).trim();
    if (!botToken) throw new Error("slack_bot_token_required");
    if (!appToken) throw new Error("slack_app_token_required");
    const SlackSocketMode: any = await import("@slack/socket-mode");
    const SlackWebApi: any = await import("@slack/web-api");
    this.web = new SlackWebApi.WebClient(botToken);
    this.socket = new SlackSocketMode.SocketModeClient({ appToken });
    this.bot.internal.web = this.web;
    this.bot.internal.socket = this.socket;

    const auth = await this.web.auth.test();
    this.bot.selfId = safeString(auth?.user_id).trim();
    this.bot.user = {
      id: this.bot.selfId,
      userId: this.bot.selfId,
      name: safeString(auth?.user).trim() || undefined,
      username: safeString(auth?.user).trim() || undefined,
      nick: safeString(auth?.user).trim() || undefined,
    };

    this.socket.on("connected", () => {
      emitBotStatus(this.app, this.bot, 1);
    });
    this.socket.on("disconnected", () => {
      emitBotStatus(this.app, this.bot, 0);
    });
    this.socket.on("error", (error: any) => {
      this.logger?.warn?.(
        `socket error err=${safeString(error?.message || error)}`,
      );
    });
    this.socket.on("slack_event", (envelope: any) => {
      void this.handleSlackEvent(envelope).catch((error: any) => {
        this.logger?.warn?.(
          `event handling failed type=${safeString(envelope?.type || "") || "unknown"} err=${safeString(error?.message || error)}`,
        );
      });
    });

    this.bot.inboundRecovery = {
      status: "ready",
      mode: "native-ack-retry",
    };
    await this.socket.start();
    emitBotStatus(this.app, this.bot, 1);
  }

  async stop() {
    try {
      await this.socket?.disconnect?.();
    } catch {}
    try {
      await this.httpTransport.close();
    } catch {}
    this.socket = null;
    this.web = null;
    emitBotStatus(this.app, this.bot, 0);
  }

  private async cacheSlackFile(file: any) {
    const url = safeString(
      file?.url_private_download ||
        file?.url_private ||
        file?.permalink_public ||
        "",
    ).trim();
    if (!url) return null;
    const mimeType = safeString(file?.mimetype || "").trim();
    const name = ensureExtension(
      ensureFileName(
        safeString(file?.name).trim() ||
          `slack-${safeString(file?.id).trim() || Date.now()}`,
      ),
      mimeType,
    );
    const fullPath = path.join(this.cacheDir, `${Date.now()}-${name}`);
    await downloadToFile(
      fullPath,
      url,
      {
        Authorization: `Bearer ${safeString(this.config?.botToken).trim()}`,
      },
      this.httpTransport,
    );
    return { path: fullPath, name, mimeType };
  }

  async createReaction(chatId: string, messageId: string, emoji: string) {
    const name = toSlackReactionName(emoji);
    if (!name) throw new Error("slack_reaction_emoji_required");
    await this.web.reactions.add({
      channel: chatId,
      timestamp: messageId,
      name,
    });
    return true;
  }

  async deleteReaction(chatId: string, messageId: string, emoji: string) {
    const name = toSlackReactionName(emoji);
    if (!name) throw new Error("slack_reaction_emoji_required");
    await this.web.reactions.remove({
      channel: chatId,
      timestamp: messageId,
      name,
    });
    return true;
  }

  private renderOutboundText(nodes: any[]) {
    return renderMarkdownFromNodes(nodes, {
      includeMedia: false,
      renderAt(attrs) {
        const id = safeString(attrs.id).trim();
        return id ? `<@${id}>` : safeString(attrs.name).trim();
      },
    });
  }

  private async postText(
    chatId: string,
    text: string,
    replyToMessageId?: string,
  ) {
    const delivered: string[] = [];
    for (const textChunk of splitPlainText(text, SLACK_MAX_TEXT_LENGTH)) {
      const sent = await this.web.chat.postMessage(
        compactObject({
          channel: chatId,
          text: textChunk,
          thread_ts: replyToMessageId || undefined,
        }),
      );
      const ts = safeString(sent?.ts).trim();
      if (ts) delivered.push(ts);
    }
    return delivered;
  }

  private buildTodoBlocks(node: any) {
    const items = todoNodeItems(node);
    if (!items.length) return null;
    const title = todoNodeTitle(node);
    const blocks: any[] = [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*${escapeSlackMrkdwn(title)}*` },
      },
    ];
    for (let offset = 0; offset < items.length; offset += 10) {
      const chunk = items.slice(offset, offset + 10);
      const options = chunk.map((item, index) => ({
        text: {
          type: "plain_text",
          text: truncateSlackPlainText(item.text, 75),
          emoji: true,
        },
        value: `todo_${offset + index}`,
      }));
      const initialOptions = options.filter(
        (_option, index) => chunk[index]?.done,
      );
      blocks.push({
        type: "actions",
        elements: [
          compactObject({
            type: "checkboxes",
            action_id: `rin_todo_${offset / 10}`,
            options,
            initial_options: initialOptions.length ? initialOptions : undefined,
          }),
        ],
      });
    }
    return { blocks, text: todoFallbackText(title, items) };
  }

  private async postTodo(chatId: string, node: any, replyToMessageId?: string) {
    const payload = this.buildTodoBlocks(node);
    if (!payload) return [] as string[];
    const sent = await this.web.chat.postMessage(
      compactObject({
        channel: chatId,
        text: payload.text,
        blocks: payload.blocks,
        thread_ts: replyToMessageId || undefined,
      }),
    );
    const ts = safeString(sent?.ts).trim();
    return ts ? [ts] : [];
  }

  private async uploadFile(
    chatId: string,
    payload: { data: Buffer; name: string },
    replyToMessageId?: string,
  ) {
    const uploaded = await this.web.files.uploadV2(
      compactObject({
        channel_id: chatId,
        file: payload.data,
        filename: payload.name,
        thread_ts: replyToMessageId || undefined,
      }),
    );
    return safeString(
      uploaded?.files?.[0]?.id || uploaded?.file?.id || "",
    ).trim();
  }

  private async sendMedia(
    chatId: string,
    node: any,
    replyToMessageId?: string,
  ) {
    const payload = await readBinaryFromNode(node);
    if (!payload) return [] as string[];
    if (payload.url) {
      return await this.postText(chatId, payload.url, replyToMessageId);
    }
    const fileId = await this.uploadFile(
      chatId,
      { data: payload.data, name: payload.name },
      replyToMessageId,
    );
    return fileId ? [fileId] : [];
  }

  private async sendMessage(
    chatId: string,
    content: any,
    options: Record<string, any> = {},
  ) {
    const deliveryKind = safeString(options?.deliveryKind).trim() || "final";
    const isFinalDelivery = deliveryKind === "final";
    const { work, replyToMessageId } = prepareOutboundNodes(content);
    const delivered: string[] = [];
    const failures: unknown[] = [];
    let cursor = 0;
    let finalizedWorkingMessage = false;
    const ensureFinalProgressCleared = async () => {
      if (!isFinalDelivery || finalizedWorkingMessage) return;
      await this.editableWorking.deleteProgress(chatId, replyToMessageId);
      finalizedWorkingMessage = true;
    };
    const recordFailure = async (error: unknown, nodes: any[]) => {
      this.logger.warn(
        `rich message segment failed err=${safeString((error as any)?.message || error)}`,
      );
      const fallback = renderRichDeliveryFallback(nodes);
      if (!fallback) {
        failures.push(error);
        return;
      }
      try {
        await ensureFinalProgressCleared();
        const fallbackIds = await this.postText(
          chatId,
          fallback,
          replyToMessageId,
        );
        if (!fallbackIds.length) {
          failures.push(error);
          return;
        }
        delivered.push(...fallbackIds);
      } catch (fallbackError: any) {
        failures.push(error);
        this.logger.warn(
          `rich fallback delivery failed err=${safeString(fallbackError?.message || fallbackError)}`,
        );
      }
    };
    while (cursor < work.length) {
      const type = safeString(work[cursor]?.type).toLowerCase();
      let messageIds: string[] = [];
      if (type === "todo" || type === "checklist") {
        try {
          const coalesceWithWorkingMessage = Boolean(
            options?.coalesceWithWorkingMessage,
          );
          if (
            coalesceWithWorkingMessage &&
            delivered.length === 0 &&
            isEditableProgressDeliveryKind(deliveryKind)
          ) {
            messageIds = await this.editableWorking.updateText({
              chatId,
              text: renderPlainTextFromNodes([work[cursor]]),
              replyToMessageId,
              finalize: false,
              kind: "todo",
            });
          } else {
            await ensureFinalProgressCleared();
            messageIds = await this.postTodo(
              chatId,
              work[cursor],
              replyToMessageId,
            );
          }
        } catch (error) {
          await recordFailure(error, [work[cursor]]);
        }
        cursor += 1;
      } else if (isOutboundMediaNodeType(type)) {
        try {
          await ensureFinalProgressCleared();
          messageIds = await this.sendMedia(
            chatId,
            work[cursor],
            replyToMessageId,
          );
        } catch (error) {
          await recordFailure(error, [work[cursor]]);
        }
        cursor += 1;
      } else {
        const textNodes: any[] = [];
        while (cursor < work.length) {
          const textType = safeString(work[cursor]?.type).toLowerCase();
          if (
            isOutboundMediaNodeType(textType) ||
            textType === "todo" ||
            textType === "checklist"
          )
            break;
          textNodes.push(work[cursor]);
          cursor += 1;
        }
        try {
          const text = this.renderOutboundText(textNodes);
          const coalesceWithWorkingMessage = Boolean(
            options?.coalesceWithWorkingMessage,
          );
          const shouldEditWorkingMessage =
            delivered.length === 0 &&
            coalesceWithWorkingMessage &&
            isEditableProgressDeliveryKind(deliveryKind);
          if (shouldEditWorkingMessage) {
            messageIds = await this.editableWorking.updateText({
              chatId,
              text,
              replyToMessageId,
              finalize: false,
              kind:
                deliveryKind === "passive_notice"
                  ? "todo"
                  : deliveryKind === "interim"
                    ? "interim"
                    : undefined,
            });
          } else {
            await ensureFinalProgressCleared();
            messageIds = await this.postText(chatId, text, replyToMessageId);
          }
        } catch (error) {
          await recordFailure(error, textNodes);
        }
      }
      delivered.push(...messageIds);
    }
    if (isFinalDelivery && !finalizedWorkingMessage) {
      await this.editableWorking.deleteProgress(chatId, replyToMessageId);
    }
    if (failures.length) {
      if (delivered.length)
        throw partialChatDeliveryError(failures[0], delivered);
      throw failures[0];
    }
    if (delivered.length) return delivered;
    throw new Error("slack_send_message_empty");
  }

  private async handleSlackEvent(envelope: any) {
    const ack = envelope?.ack;
    if (safeString(envelope?.type).trim() !== "events_api") return;
    const eventType = safeString(envelope?.body?.event?.type || "").trim();
    if (eventType !== "message") return;
    const body =
      envelope?.body && typeof envelope.body === "object" ? envelope.body : {};
    const event =
      body?.event && typeof body.event === "object" ? body.event : {};
    if (
      safeString(event?.subtype).trim() &&
      safeString(event?.subtype).trim() !== "file_share"
    ) {
      return;
    }
    if (safeString(event?.user).trim() === safeString(this.bot?.selfId).trim())
      return;
    if (!safeString(event?.user).trim()) return;
    const rawText = safeString(event?.text || "").trim();
    const mentionToken = `<@${safeString(this.bot?.selfId).trim()}>`;
    const mentionSelf = Boolean(mentionToken && rawText.includes(mentionToken));
    const strippedContent = mentionSelf
      ? stripMentionTokens(rawText, [mentionToken])
      : rawText;
    const isDirect = safeString(event?.channel).startsWith("D");
    const elements: any[] = [];
    if (strippedContent) {
      elements.push(normalizeNode("text", { content: strippedContent }));
    }
    const files = Array.isArray(event?.files) ? event.files : [];
    for (const file of files) {
      try {
        const cached = await this.cacheSlackFile(file);
        if (!cached) continue;
        elements.push(
          normalizeNode(
            isImageMimeType(cached.mimeType) || isImageName(cached.name)
              ? "image"
              : "file",
            compactObject({
              src: fileUrl(cached.path),
              mime: cached.mimeType || undefined,
              mimeType: cached.mimeType || undefined,
              name: cached.name,
            }),
          ),
        );
      } catch {}
    }
    const canonicalElements = prependChatQuoteNode(elements, event?.thread_ts);
    const userInfo = await this.web.users
      .info({ user: event.user })
      .catch(() => null);
    const user = userInfo?.user || {};
    this.app.emit("message", {
      platform: "slack",
      selfId: safeString(this.bot?.selfId).trim() || undefined,
      bot: this.bot,
      messageId: safeString(event?.ts || "").trim(),
      timestamp: Number.isFinite(Number.parseFloat(safeString(event?.ts || "")))
        ? Math.round(Number.parseFloat(safeString(event.ts)) * 1000)
        : Date.now(),
      userId: safeString(event?.user).trim(),
      author: {
        userId: safeString(event?.user).trim(),
        name:
          safeString(user?.real_name).trim() ||
          safeString(user?.profile?.display_name).trim() ||
          safeString(user?.name).trim() ||
          undefined,
        nick:
          safeString(user?.profile?.display_name).trim() ||
          safeString(user?.real_name).trim() ||
          safeString(user?.name).trim() ||
          undefined,
        username: safeString(user?.name).trim() || undefined,
      },
      user: {
        id: safeString(event?.user).trim(),
        userId: safeString(event?.user).trim(),
        name:
          safeString(user?.real_name).trim() ||
          safeString(user?.profile?.display_name).trim() ||
          safeString(user?.name).trim() ||
          undefined,
        nick:
          safeString(user?.profile?.display_name).trim() ||
          safeString(user?.real_name).trim() ||
          safeString(user?.name).trim() ||
          undefined,
        username: safeString(user?.name).trim() || undefined,
      },
      channelId: safeString(event?.channel).trim(),
      guildId: !isDirect
        ? safeString(
            body?.team_id || body?.authorizations?.[0]?.team_id || "",
          ).trim() || undefined
        : undefined,
      guildName: undefined,
      isDirect,
      content: rawText,
      stripped: {
        appel: mentionSelf,
        content: strippedContent,
      },
      elements: canonicalElements,
    });
    if (typeof ack === "function") {
      await ack();
    }
  }
}

export class LarkAdapter {
  private readonly app: any;
  private readonly config: Record<string, any>;
  private readonly logger: any;
  private readonly cacheDir: string;
  private readonly httpTransport = createRinHttpTransport();
  private client: any = null;
  private wsClient: any = null;
  private readonly inboundGate = new InboundRecoveryGate<{
    data: any;
    resolve: () => void;
    reject: (error: unknown) => void;
  }>();
  readonly bot: any;

  constructor(
    app: any,
    dataDir: string,
    config: Record<string, any>,
    logger: any,
  ) {
    this.app = app;
    this.config = config;
    this.logger = createPrefixedLogger("chat-runtime:lark", logger);
    this.cacheDir = path.join(dataDir, "chat", "runtime-cache", "lark");
    ensureDir(this.cacheDir);
    const internal: any = {
      client: null,
      wsClient: null,
      createMessage: async (options: any) =>
        await this.client?.im?.message?.create?.(options),
      getMessage: async (options: any) =>
        await this.client?.im?.message?.get?.(options),
      getChat: async (options: any) =>
        await this.client?.im?.chat?.get?.(options),
      createReaction: async (options: any) =>
        await this.client?.im?.messageReaction?.create?.(options),
      deleteReaction: async (options: any) =>
        await this.client?.im?.messageReaction?.delete?.(options),
      listReactions: async (options: any) =>
        await this.client?.im?.messageReaction?.list?.(options),
      listChatMembers: async (options: any) =>
        await this.client?.im?.chatMembers?.get?.(options),
      getMessageResource: async (options: any) =>
        await this.client?.im?.messageResource?.get?.(options),
      getUser: async (options: any) =>
        await this.client?.contact?.user?.get?.(options),
    };
    this.bot = {
      platform: "lark",
      selfId: "",
      status: 0,
      workingIndicators: [
        createReactionWorkingIndicator("lark", () => this.bot),
        createTypingWorkingIndicator(() => this.bot),
      ],
      user: {},
      internal,
      sendMessage: async (chatId: string, content: any, options?: any) =>
        await this.sendMessage(chatId, content, options),
      getGuildMemberCount: async (chatId: string) =>
        await this.getGuildMemberCount(chatId),
      createReaction: async (
        chatId: string,
        messageId: string,
        emoji: string,
      ) => await this.createReaction(chatId, messageId, emoji),
      deleteReaction: async (
        chatId: string,
        messageId: string,
        emoji: string,
      ) => await this.deleteReaction(chatId, messageId, emoji),
    };
    this.app.register(this, this.bot);
  }

  async start() {
    const appId = safeString(this.config?.appId).trim();
    const appSecret = safeString(this.config?.appSecret).trim();
    if (!appId) throw new Error("lark_app_id_required");
    if (!appSecret) throw new Error("lark_app_secret_required");
    const Lark: any = await import("@larksuiteoapi/node-sdk");
    const domain =
      safeString(this.config?.platform).trim() === "lark"
        ? Lark.Domain.Lark
        : Lark.Domain.Feishu;
    this.client = new Lark.Client({
      appId,
      appSecret,
      domain,
    });
    this.wsClient = new Lark.WSClient({
      appId,
      appSecret,
      domain,
      loggerLevel: Lark.LoggerLevel.info,
    });
    this.bot.internal.client = this.client;
    this.bot.internal.wsClient = this.wsClient;
    this.bot.selfId = appId;
    this.bot.user = {
      id: appId,
      userId: appId,
      name: appId,
      username: appId,
      nick: appId,
    };
    this.inboundGate.begin();
    await this.wsClient.start({
      eventDispatcher: new Lark.EventDispatcher({}).register({
        "im.message.receive_v1": async (data: any) => {
          try {
            const chatId = this.larkInboundChatId(data);
            if (this.inboundGate.isBuffering(chatId)) {
              await new Promise<void>((resolve, reject) => {
                if (
                  !this.inboundGate.buffer(chatId, { data, resolve, reject })
                ) {
                  void this.handleMessage(data).then(resolve, reject);
                }
              });
              return;
            }
            await this.handleMessage(data);
          } catch (error: any) {
            this.logger?.warn?.(
              `message handling failed err=${safeString(error?.message || error)}`,
            );
            throw error;
          }
        },
      }),
    });
    const recoveryRetryDelaysMs = [250, 1000];
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.recoverLarkMessages(() => {
          emitBotStatus(this.app, this.bot, 1);
        });
        break;
      } catch (error: any) {
        const detail =
          safeString(error?.message || error).trim() || "catch_up_failed";
        this.bot.inboundRecovery = {
          status: "degraded",
          failures: [detail],
        };
        this.logger?.warn?.(
          `inbound recovery handling failed attempt=${attempt + 1} err=${detail}`,
        );
        const retryDelayMs = recoveryRetryDelaysMs[attempt];
        if (retryDelayMs === undefined) {
          emitBotStatus(this.app, this.bot, 1);
          break;
        }
        await sleep(retryDelayMs);
        this.inboundGate.begin();
      }
    }
  }

  async stop() {
    try {
      this.wsClient?.close?.({ force: true });
    } catch {}
    try {
      await this.httpTransport.close();
    } catch {}
    this.wsClient = null;
    this.client = null;
    emitBotStatus(this.app, this.bot, 0);
  }

  private wrapLarkHistoryMessage(message: any) {
    const sender =
      message?.sender && typeof message.sender === "object"
        ? message.sender
        : {};
    const senderId = safeString(sender?.id).trim();
    const senderIdType = safeString(sender?.id_type).trim();
    return {
      message: {
        ...message,
        message_type:
          safeString(message?.message_type || message?.msg_type).trim() ||
          undefined,
        content:
          safeString(message?.content || message?.body?.content).trim() ||
          undefined,
      },
      sender: {
        ...sender,
        sender_id:
          sender?.sender_id && typeof sender.sender_id === "object"
            ? sender.sender_id
            : compactObject({
                open_id: senderIdType === "open_id" ? senderId : undefined,
                user_id: senderIdType === "user_id" ? senderId : undefined,
                union_id: senderIdType === "union_id" ? senderId : undefined,
              }),
      },
    };
  }

  private async fetchLarkMessagesAfter(head: {
    chatKey: string;
    chatId: string;
    messageId: string;
    platformTimestamp: number;
  }) {
    const recovered: any[] = [];
    let pageToken = "";
    let foundCursor = false;
    for (;;) {
      const response = await this.client?.im?.message?.list?.({
        params: compactObject({
          container_id_type: "chat",
          container_id: head.chatId,
          start_time: String(
            Math.max(0, Math.floor(head.platformTimestamp / 1000) - 1),
          ),
          sort_type: "ByCreateTimeAsc",
          page_size: 50,
          page_token: pageToken || undefined,
        }),
      });
      assertLarkApiSuccess(response);
      const data =
        response?.data && typeof response.data === "object"
          ? response.data
          : response;
      const items = Array.isArray(data?.items) ? data.items : [];
      for (const item of items) {
        const messageId = safeString(item?.message_id).trim();
        if (!foundCursor) {
          if (messageId === head.messageId) foundCursor = true;
          continue;
        }
        recovered.push(this.wrapLarkHistoryMessage(item));
      }
      const nextToken = safeString(data?.page_token).trim();
      if (!data?.has_more || !nextToken || nextToken === pageToken) break;
      pageToken = nextToken;
    }
    if (!foundCursor) {
      throw new Error(
        `Lark message history did not return recovery cursor ${head.messageId}`,
      );
    }
    return recovered;
  }

  private larkInboundChatId(data: any) {
    return safeString(data?.message?.chat_id).trim();
  }

  private async releaseLarkReadyChats(chatIds: string[]) {
    const botId = safeString(this.bot?.selfId).trim();
    const chats = chatIds.map((chatId) => ({
      chatId,
      chatKey: composeChatKeyForBot(this.app, "lark", chatId, botId),
    }));
    for (const { chatKey } of chats) {
      if (chatKey) this.app?.beginInboundRecoveryChat?.(chatKey);
    }
    for (const { chatId, chatKey } of chats) {
      await this.finishLarkRecovery(chatId, []);
      if (chatKey) this.app?.completeInboundRecoveryChat?.(chatKey);
    }
  }

  private async recoverLarkMessages(onConfigured?: () => void) {
    const agentDir = safeString(this.app?.agentDir).trim();
    const botId = safeString(this.bot?.selfId).trim();
    if (!agentDir || !botId) {
      await this.releaseLarkReadyChats(this.inboundGate.configure([]));
      onConfigured?.();
      return;
    }
    const result = await recoverInboundHeads(
      agentDir,
      "lark",
      botId,
      async (head) => await this.fetchLarkMessagesAfter(head),
      {
        concurrency: 4,
        onHeads: async (heads) => {
          for (const head of heads) {
            this.app?.beginInboundRecoveryChat?.(head.chatKey);
          }
          this.bot.inboundRecovery = heads.length
            ? {
                status: "recovering",
                pending: heads.map((head) => head.chatKey),
              }
            : { status: "ready" };
          await this.releaseLarkReadyChats(
            this.inboundGate.configure(heads.map((head) => head.chatId)),
          );
          onConfigured?.();
        },
        onHeadSettled: async (outcome) => {
          await this.finishLarkRecovery(outcome.head.chatId, outcome.recovered);
          this.app?.completeInboundRecoveryChat?.(outcome.head.chatKey);
        },
      },
    );
    applyInboundRecoveryResult(this.bot, this.logger, result);
  }

  private mergeLarkRecoveryMessages(
    recovered: any[],
    buffered: Array<{
      data: any;
      resolve: () => void;
      reject: (error: unknown) => void;
    }>,
  ) {
    const messages = new Map<
      string,
      {
        data: any;
        sourceOrder: number;
        index: number;
        waiters: Array<{
          resolve: () => void;
          reject: (error: unknown) => void;
        }>;
      }
    >();
    for (const [index, data] of recovered.entries()) {
      const messageId = safeString(data?.message?.message_id).trim();
      if (messageId) {
        messages.set(messageId, {
          data,
          sourceOrder: 0,
          index,
          waiters: [],
        });
      }
    }
    for (const [index, entry] of buffered.entries()) {
      const messageId =
        safeString(entry.data?.message?.message_id).trim() ||
        `buffered:${index}`;
      const current = messages.get(messageId);
      if (current) {
        current.data = entry.data;
        current.waiters.push({
          resolve: entry.resolve,
          reject: entry.reject,
        });
        continue;
      }
      messages.set(messageId, {
        data: entry.data,
        sourceOrder: 1,
        index,
        waiters: [{ resolve: entry.resolve, reject: entry.reject }],
      });
    }
    return [...messages.values()].sort((left, right) => {
      const leftTime = Number(left.data?.message?.create_time || 0);
      const rightTime = Number(right.data?.message?.create_time || 0);
      return (
        leftTime - rightTime ||
        left.sourceOrder - right.sourceOrder ||
        left.index - right.index
      );
    });
  }

  private async finishLarkRecovery(chatId: string, recovered: any[]) {
    let nextRecovered = recovered;
    for (;;) {
      const buffered = this.inboundGate.drain(chatId);
      const messages = this.mergeLarkRecoveryMessages(nextRecovered, buffered);
      nextRecovered = [];
      const handledMessageIds = new Set<string>();
      for (let index = 0; index < messages.length; index += 1) {
        const entry = messages[index];
        try {
          await this.handleMessage(entry.data);
          const messageId = safeString(entry.data?.message?.message_id).trim();
          if (messageId) handledMessageIds.add(messageId);
          for (const waiter of entry.waiters) waiter.resolve();
        } catch (error) {
          for (const pending of messages.slice(index)) {
            for (const waiter of pending.waiters) waiter.reject(error);
          }
          this.inboundGate.prepend(
            chatId,
            buffered.filter(
              (pending) =>
                !handledMessageIds.has(
                  safeString(pending.data?.message?.message_id).trim(),
                ),
            ),
          );
          throw error;
        }
      }
      if (!this.inboundGate.hasPending(chatId)) break;
    }
    this.inboundGate.open(chatId);
  }

  private parseMessageContent(raw: string) {
    const text = safeString(raw).trim();
    if (!text) return { text: "", mentions: [] as any[] };
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "string")
        return { text: parsed, mentions: [] as any[] };
      return {
        text: safeString(parsed?.text || parsed?.content || "").trim() || text,
        mentions: Array.isArray(parsed?.mentions) ? parsed.mentions : [],
      };
    } catch {
      return { text, mentions: [] as any[] };
    }
  }

  private parsePostContentNodes(parsed: any) {
    const root = parsed?.zh_cn || parsed?.en_us || parsed;
    const lines = Array.isArray(root?.content) ? root.content : [];
    const nodes: any[] = [];
    for (const line of lines) {
      const parts = Array.isArray(line) ? line : [];
      for (const part of parts) {
        const tag = safeString(part?.tag).trim().toLowerCase();
        if (tag === "at") {
          nodes.push(
            normalizeNode(
              "at",
              compactObject({
                id: safeString(part?.user_id || part?.id).trim() || undefined,
                name:
                  safeString(part?.user_name || part?.name).trim() || undefined,
              }),
            ),
          );
          continue;
        }
        if (tag === "img" || tag === "image") {
          const src = safeString(part?.image_key || part?.src).trim();
          nodes.push(
            normalizeNode(
              "image",
              compactObject({
                src: src || undefined,
                name:
                  safeString(part?.alt || part?.image_key).trim() || undefined,
              }),
            ),
          );
          continue;
        }
        const text = safeString(part?.text || part?.href || "");
        if (text) {
          nodes.push(
            normalizeNode(tag === "md" ? "markdown" : "text", {
              content: text,
            }),
          );
        }
      }
      if (parts.length) nodes.push(normalizeNode("br"));
    }
    if (nodes.at(-1)?.type === "br") nodes.pop();
    return nodes;
  }

  private parseLarkMessageContentNodes(
    msgType: string,
    rawContent: string,
    mentions: any[] = [],
  ) {
    const type = safeString(msgType).trim().toLowerCase();
    const raw = safeString(rawContent).trim();
    let parsed: any = undefined;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {}
    }
    if (type === "post") return this.parsePostContentNodes(parsed);
    if (type === "image") {
      const src = safeString(parsed?.image_key || parsed?.key || raw).trim();
      return [normalizeNode("image", compactObject({ src }))];
    }
    if (type === "file") {
      const src = safeString(parsed?.file_key || parsed?.key || raw).trim();
      const name = safeString(parsed?.file_name || parsed?.name).trim();
      return [normalizeNode("file", compactObject({ src, name }))];
    }
    const parsedText = this.parseMessageContent(raw);
    const nodes: any[] = [];
    const mentionByKey = new Map<string, any>();
    for (const mention of mentions) {
      const key = safeString(mention?.key).trim();
      if (key) mentionByKey.set(key, mention);
    }
    const pattern = /(@_[a-zA-Z0-9_-]+)/g;
    let cursor = 0;
    for (const match of parsedText.text.matchAll(pattern)) {
      const index = typeof match.index === "number" ? match.index : cursor;
      const before = parsedText.text.slice(cursor, index);
      if (before) nodes.push(normalizeNode("text", { content: before }));
      cursor = index + safeString(match[0]).length;
      const mention = mentionByKey.get(safeString(match[1]).trim());
      if (mention) {
        nodes.push(
          normalizeNode(
            "at",
            compactObject({
              id:
                safeString(mention?.id || mention?.open_id).trim() || undefined,
              name: safeString(mention?.name).trim() || undefined,
            }),
          ),
        );
      } else {
        nodes.push(normalizeNode("text", { content: safeString(match[0]) }));
      }
    }
    const tail = parsedText.text.slice(cursor);
    if (tail) nodes.push(normalizeNode("text", { content: tail }));
    return nodes.length
      ? nodes
      : raw
        ? [normalizeNode("text", { content: raw })]
        : [];
  }

  private pickLarkMessageItems(response: any) {
    const candidates = [response?.data?.items, response?.items];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) return candidate;
    }
    return [] as any[];
  }

  private larkForwardSenderName(message: any) {
    const sender =
      message?.sender && typeof message.sender === "object"
        ? message.sender
        : {};
    return (
      safeString(sender?.id).trim() ||
      safeString(sender?.sender_id?.open_id).trim() ||
      safeString(sender?.sender_id?.user_id).trim() ||
      safeString(message?.message_id).trim() ||
      "unknown"
    );
  }

  private async buildLarkForwardNode(message: any) {
    const id = safeString(message?.message_id).trim();
    let items: any[] = [];
    if (id) {
      try {
        const response = await this.client?.im?.message?.get?.({
          path: { message_id: id },
          params: { user_id_type: "open_id" },
        });
        items = this.pickLarkMessageItems(response);
      } catch (error: any) {
        this.logger?.warn?.(
          `get lark merged forward failed id=${id} err=${safeString(error?.message || error)}`,
        );
      }
    }
    const children: any[] = [];
    for (const item of items) {
      if (safeString(item?.message_id).trim() === id) continue;
      const body = item?.body && typeof item.body === "object" ? item.body : {};
      const nodes = this.parseLarkMessageContentNodes(
        safeString(item?.msg_type).trim(),
        safeString(body?.content || item?.content || ""),
        Array.isArray(item?.mentions) ? item.mentions : [],
      );
      const rendered = renderMarkdownFromNodes(nodes).trim();
      children.push(
        normalizeNode("text", {
          content: `${this.larkForwardSenderName(item)}: ${rendered || "[unsupported message]"}\n`,
        }),
      );
    }
    return normalizeNode(
      "forward",
      compactObject({
        id,
        title: "merged forward",
        count: children.length ? String(children.length) : undefined,
      }),
      children,
    );
  }

  private async cacheLarkMessageResource(
    messageId: string,
    fileKey: string,
    resourceType: "image" | "file",
    rawName = "",
  ) {
    if (!messageId || !fileKey) return null;
    const response = await this.client?.im?.messageResource?.get?.({
      path: { message_id: messageId, file_key: fileKey },
      params: { type: resourceType },
    });
    if (!response || typeof response.writeFile !== "function") return null;
    const mimeType = safeString(
      response.headers?.["content-type"] ||
        response.headers?.["Content-Type"] ||
        "",
    )
      .split(";", 1)[0]
      .trim();
    const name = ensureExtension(
      ensureFileName(rawName || `${resourceType}-${fileKey}`),
      mimeType,
    );
    const fullPath = path.join(this.cacheDir, `${Date.now()}-${name}`);
    await response.writeFile(fullPath);
    return { path: fullPath, name, mimeType };
  }

  private async resolveLarkMessageResources(messageId: string, nodes: any[]) {
    const resolved: any[] = [];
    for (const node of nodes) {
      const type = safeString(node?.type).trim().toLowerCase();
      if (type !== "image" && type !== "file") {
        resolved.push(node);
        continue;
      }
      const attrs =
        node?.attrs && typeof node.attrs === "object" ? node.attrs : {};
      const src = safeString(
        attrs.src || attrs.url || attrs.file || attrs.path || "",
      ).trim();
      if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src)) {
        resolved.push(node);
        continue;
      }
      const resourceType = type === "image" ? "image" : "file";
      try {
        const cached = await this.cacheLarkMessageResource(
          messageId,
          src,
          resourceType,
          safeString(attrs.name || attrs.file || src).trim(),
        );
        if (cached) {
          resolved.push(
            normalizeNode(
              type,
              compactObject({
                ...attrs,
                src: fileUrl(cached.path),
                file: cached.name,
                name: cached.name,
                mime: cached.mimeType || undefined,
                mimeType: cached.mimeType || undefined,
              }),
            ),
          );
          continue;
        }
      } catch (error: any) {
        this.logger?.warn?.(
          `get lark message resource failed id=${messageId} key=${src} type=${resourceType} err=${safeString(error?.message || error)}`,
        );
      }
      resolved.push(
        normalizeNode(
          type,
          compactObject({ ...attrs, src: undefined, file: undefined }),
        ),
      );
    }
    return resolved;
  }

  private async getGuildMemberCount(chatId: string) {
    const nextChatId = safeString(chatId).trim();
    if (!nextChatId) return 0;
    const response = await this.client?.im?.chat?.get?.({
      path: { chat_id: nextChatId },
      params: { user_id_type: "open_id" },
    });
    const data =
      response?.data && typeof response.data === "object"
        ? response.data
        : response && typeof response === "object"
          ? response
          : {};
    const userCount = Number(data?.user_count ?? data?.userCount ?? 0);
    const botCount = Number(data?.bot_count ?? data?.botCount ?? 1);
    if (!Number.isFinite(userCount) || userCount <= 0) return 0;
    return userCount + (Number.isFinite(botCount) ? botCount : 1);
  }

  async createReaction(_chatId: string, messageId: string, emoji: string) {
    const emojiType = toLarkReactionType(emoji);
    if (!emojiType) throw new Error("lark_reaction_emoji_required");
    await this.client.im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emojiType } },
    });
    return true;
  }

  async deleteReaction(_chatId: string, messageId: string, emoji: string) {
    const emojiType = toLarkReactionType(emoji);
    if (!emojiType) throw new Error("lark_reaction_emoji_required");
    const listed = await this.client.im.messageReaction.list({
      path: { message_id: messageId },
      params: { reaction_type: emojiType, page_size: 50 },
    });
    const items = Array.isArray(listed?.data?.items) ? listed.data.items : [];
    const reaction =
      items.find(
        (item: any) =>
          safeString(item?.reaction_type?.emoji_type).trim() === emojiType &&
          safeString(item?.operator?.operator_type).trim() === "app",
      ) || items[0];
    const reactionId = safeString(reaction?.reaction_id).trim();
    if (!reactionId) return false;
    await this.client.im.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    });
    return true;
  }

  private renderOutboundText(nodes: any[]) {
    return normalizeLarkMarkdownListBlocks(
      renderMarkdownFromNodes(nodes, {
        renderAt(attrs) {
          const id = safeString(attrs.id).trim();
          const name = safeString(attrs.name).trim();
          return id
            ? `<at user_id="${escapeLarkTagAttr(id)}">${escapeLarkTagText(name)}</at>`
            : name;
        },
      }),
    );
  }

  private buildPostData(text: string) {
    return {
      msg_type: "post",
      content: JSON.stringify({
        zh_cn: {
          content: renderLarkPostContent(text),
        },
      }),
    };
  }

  private async sendData(
    chatId: string,
    data: Record<string, any>,
    replyToMessageId?: string,
  ) {
    const result = replyToMessageId
      ? await this.client.im.message.reply({
          path: { message_id: replyToMessageId },
          data,
        })
      : await this.client.im.message.create({
          params: {
            receive_id_type: "chat_id",
          },
          data: {
            receive_id: chatId,
            ...data,
          },
        });
    assertLarkApiSuccess(result);
    return [
      safeString(result?.data?.message_id || result?.message_id || "").trim(),
    ].filter(Boolean);
  }

  private async sendPostText(
    chatId: string,
    text: string,
    replyToMessageId?: string,
  ) {
    if (!text) throw new Error("lark_send_message_empty");
    return await this.sendData(
      chatId,
      this.buildPostData(text),
      replyToMessageId,
    );
  }

  private async sendPlainText(
    chatId: string,
    text: string,
    replyToMessageId?: string,
  ) {
    if (!text) throw new Error("lark_send_message_empty");
    return await this.sendData(
      chatId,
      {
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
      replyToMessageId,
    );
  }

  private assertLarkResourceSize(
    data: Buffer,
    label: "Lark image" | "Lark file",
    maxBytes: number,
    limitText: string,
  ) {
    if (!data.length) throw new Error(`${label} content is empty`);
    if (data.length > maxBytes) {
      throw new Error(`${label} exceeds the ${limitText} upload limit`);
    }
  }

  private assertLarkImageSize(image: Buffer) {
    this.assertLarkResourceSize(
      image,
      "Lark image",
      LARK_MAX_IMAGE_BYTES,
      "10 MB",
    );
  }

  private assertLarkFileSize(file: Buffer) {
    this.assertLarkResourceSize(
      file,
      "Lark file",
      LARK_MAX_FILE_BYTES,
      "30 MB",
    );
  }

  private async downloadLarkResource(
    url: string,
    label: "Lark image" | "Lark file",
    maxBytes: number,
    limitText: string,
  ) {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, LARK_RESOURCE_DOWNLOAD_TIMEOUT_MS);
    timeout.unref?.();
    let response: any;
    try {
      response = await this.httpTransport.fetch(url, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          `Failed to download ${label} (HTTP ${response.status})`,
        );
      }
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        controller.abort();
        throw new Error(`${label} exceeds the ${limitText} upload limit`);
      }
      if (!response.body) throw new Error(`${label} content is empty`);
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          controller.abort();
          throw new Error(`${label} exceeds the ${limitText} upload limit`);
        }
        chunks.push(Buffer.from(value));
      }
      const data = Buffer.concat(chunks, size);
      this.assertLarkResourceSize(data, label, maxBytes, limitText);
      return data;
    } catch (error: any) {
      const message = safeString(error?.message || error).trim();
      if (
        message.startsWith(`${label} `) ||
        message.startsWith(`Failed to download ${label}`)
      ) {
        throw error;
      }
      if (timedOut) {
        throw new Error(`${label} download timed out after 30 seconds`);
      }
      throw new Error(
        `Failed to download ${label}: ${message || "network error"}`,
      );
    } finally {
      clearTimeout(timeout);
      await discardRinHttpResponseBody(response);
    }
  }

  private async downloadLarkImage(url: string) {
    return await this.downloadLarkResource(
      url,
      "Lark image",
      LARK_MAX_IMAGE_BYTES,
      "10 MB",
    );
  }

  private async downloadLarkFile(url: string) {
    return await this.downloadLarkResource(
      url,
      "Lark file",
      LARK_MAX_FILE_BYTES,
      "30 MB",
    );
  }

  private async assertLarkLocalResourceSourceSize(
    node: any,
    label: "Lark image" | "Lark file",
    maxBytes: number,
    limitText: string,
  ) {
    const attrs =
      node?.attrs && typeof node.attrs === "object" ? node.attrs : {};
    if (Buffer.isBuffer(attrs.data)) {
      this.assertLarkResourceSize(attrs.data, label, maxBytes, limitText);
      return;
    }
    const src = safeString(attrs.src || attrs.url || "").trim();
    if (!src || /^https?:\/\//i.test(src)) return;
    const filePath = src.startsWith("file://")
      ? fileURLToPath(src)
      : path.resolve(src);
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.size > maxBytes) {
        throw new Error(`${label} exceeds the ${limitText} upload limit`);
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  private async assertLarkLocalImageSourceSize(node: any) {
    await this.assertLarkLocalResourceSourceSize(
      node,
      "Lark image",
      LARK_MAX_IMAGE_BYTES,
      "10 MB",
    );
  }

  private async assertLarkLocalFileSourceSize(node: any) {
    await this.assertLarkLocalResourceSourceSize(
      node,
      "Lark file",
      LARK_MAX_FILE_BYTES,
      "30 MB",
    );
  }

  private async sendImage(
    chatId: string,
    node: any,
    replyToMessageId?: string,
  ) {
    await this.assertLarkLocalImageSourceSize(node);
    const payload = await readBinaryFromNode(node);
    if (!payload) throw new Error("Lark image content is empty");
    const image = payload.data
      ? payload.data
      : payload.url
        ? await this.downloadLarkImage(payload.url)
        : Buffer.alloc(0);
    this.assertLarkImageSize(image);
    const uploaded = await this.client.im.image.create({
      data: { image_type: "message", image },
    });
    const imageKey = safeString(
      uploaded?.image_key || uploaded?.data?.image_key || "",
    ).trim();
    if (!imageKey) throw new Error("Lark image upload returned no image key");
    return await this.sendData(
      chatId,
      {
        msg_type: "image",
        content: JSON.stringify({ image_key: imageKey }),
      },
      replyToMessageId,
    );
  }

  private async sendFile(chatId: string, node: any, replyToMessageId?: string) {
    await this.assertLarkLocalFileSourceSize(node);
    const payload = await readBinaryFromNode(node);
    if (!payload) throw new Error("Lark file content is empty");
    const file = payload.data
      ? payload.data
      : payload.url
        ? await this.downloadLarkFile(payload.url)
        : Buffer.alloc(0);
    this.assertLarkFileSize(file);
    const uploaded = await this.client.im.file.create({
      data: {
        file_type: larkFileType(payload.name, payload.mimeType),
        file_name: payload.name,
        file,
      },
    });
    assertLarkApiSuccess(uploaded);
    const fileKey = safeString(
      uploaded?.file_key || uploaded?.data?.file_key || "",
    ).trim();
    if (!fileKey) throw new Error("Lark file upload returned no file key");
    return await this.sendData(
      chatId,
      {
        msg_type: "file",
        content: JSON.stringify({ file_key: fileKey }),
      },
      replyToMessageId,
    );
  }

  private async sendMessage(
    chatId: string,
    content: any,
    _options: Record<string, any> = {},
  ) {
    const { work, replyToMessageId } = prepareOutboundNodes(content);
    if (!work.length) throw new Error("lark_send_message_empty");
    const delivered: string[] = [];
    const failures: unknown[] = [];
    const recordFailure = async (error: unknown, nodes: any[]) => {
      this.logger.warn(
        `rich message segment failed err=${safeString((error as any)?.message || error)}`,
      );
      const fallback = renderRichDeliveryFallback(nodes);
      if (!fallback) {
        failures.push(error);
        return;
      }
      try {
        const fallbackIds = await this.sendPlainText(
          chatId,
          fallback,
          replyToMessageId,
        );
        if (!fallbackIds.length) {
          failures.push(error);
          return;
        }
        delivered.push(...fallbackIds);
      } catch (fallbackError: any) {
        failures.push(error);
        this.logger.warn(
          `rich fallback delivery failed err=${safeString(fallbackError?.message || fallbackError)}`,
        );
      }
    };
    let cursor = 0;
    while (cursor < work.length) {
      const type = safeString(work[cursor]?.type).trim().toLowerCase();
      let messageIds: string[] = [];
      if (type === "image" || type === "file") {
        try {
          messageIds =
            type === "image"
              ? await this.sendImage(chatId, work[cursor], replyToMessageId)
              : await this.sendFile(chatId, work[cursor], replyToMessageId);
        } catch (error) {
          await recordFailure(error, [work[cursor]]);
        }
        cursor += 1;
      } else {
        const textNodes: any[] = [];
        while (cursor < work.length) {
          const textType = safeString(work[cursor]?.type).trim().toLowerCase();
          if (textType === "image" || textType === "file") break;
          textNodes.push(work[cursor]);
          cursor += 1;
        }
        try {
          const text = this.renderOutboundText(textNodes);
          if (text) {
            messageIds = await this.sendPostText(
              chatId,
              text,
              replyToMessageId,
            );
          }
        } catch (error) {
          await recordFailure(error, textNodes);
        }
      }
      delivered.push(...messageIds);
    }
    if (failures.length) {
      if (delivered.length)
        throw partialChatDeliveryError(failures[0], delivered);
      throw failures[0];
    }
    if (delivered.length) return delivered;
    throw new Error("lark_send_message_empty");
  }

  private async handleMessage(data: any) {
    const message =
      data?.message && typeof data.message === "object" ? data.message : {};
    const sender =
      data?.sender && typeof data.sender === "object" ? data.sender : {};
    const senderType = safeString(sender?.sender_type).trim().toLowerCase();
    if (senderType === "app" || senderType === "bot") return;
    const senderId = safeString(
      sender?.sender_id?.open_id ||
        sender?.sender_id?.user_id ||
        sender?.sender_id?.union_id ||
        sender?.id ||
        (typeof sender?.sender_id === "string" ? sender.sender_id : ""),
    ).trim();
    if (!senderId) return;
    const msgType = safeString(
      message?.message_type || message?.msg_type || "",
    ).trim();
    const parsed = this.parseMessageContent(safeString(message?.content || ""));
    const mentions = Array.isArray(message?.mentions)
      ? message.mentions
      : parsed.mentions;
    const mentionSelf = mentions.some((item: any) => {
      const key = safeString(
        item?.key || item?.id || item?.open_id || "",
      ).trim();
      return key && key === safeString(this.bot?.selfId).trim();
    });
    const isForward = msgType === "merge_forward";
    const rawElements = isForward
      ? [await this.buildLarkForwardNode(message)]
      : this.parseLarkMessageContentNodes(
          msgType,
          safeString(message?.content || ""),
          mentions,
        );
    const elements = isForward
      ? rawElements
      : await this.resolveLarkMessageResources(
          safeString(message?.message_id || "").trim(),
          rawElements,
        );
    const renderedContent = renderPlainTextFromNodes(elements).trim();
    const strippedContent = isForward
      ? renderedContent
      : renderedContent || parsed.text;
    const isDirect =
      safeString(message?.chat_type || "")
        .trim()
        .toLowerCase() === "p2p";
    const nickname =
      safeString(sender?.sender_type).trim() === "user"
        ? safeString(sender?.sender_id?.open_id || "").trim()
        : undefined;
    const canonicalElements = prependChatQuoteNode(
      elements,
      message?.parent_id,
    );
    this.app.emit("message", {
      platform: "lark",
      selfId: safeString(this.bot?.selfId).trim() || undefined,
      bot: this.bot,
      messageId: safeString(message?.message_id || "").trim(),
      timestamp: Number.isFinite(Number(safeString(message?.create_time || "")))
        ? Number(safeString(message.create_time))
        : Date.now(),
      userId: senderId,
      author: {
        userId: senderId,
        name: nickname,
        nick: nickname,
      },
      user: {
        id: senderId,
        userId: senderId,
        name: nickname,
        nick: nickname,
      },
      channelId: safeString(message?.chat_id || "").trim(),
      guildId: !isDirect
        ? safeString(message?.chat_id || "").trim() || undefined
        : undefined,
      guildName: undefined,
      isDirect,
      content: strippedContent,
      stripped: {
        appel: mentionSelf,
        content: strippedContent,
      },
      elements: canonicalElements,
    });
  }
}

export class MinecraftAdapter {
  private readonly app: any;
  private readonly config: Record<string, any>;
  private readonly logger: any;
  private ws: WebSocket | null = null;
  private loopPromise: Promise<void> | null = null;
  private stopped = false;
  private nextEchoId = 1;
  private readonly pending = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (error: unknown) => void;
      timer: NodeJS.Timeout;
    }
  >();
  readonly bot: any;

  constructor(
    app: any,
    _dataDir: string,
    config: Record<string, any>,
    logger: any,
  ) {
    this.app = app;
    this.config = config;
    this.logger = createPrefixedLogger("chat-runtime:minecraft", logger);
    const internal: any = {
      ws: null,
      broadcast: async (message: string) =>
        await this.callApi("broadcast", {
          message: [{ text: safeString(message) }],
        }),
      sendPrivateMessage: async (nickname: string, message: string) =>
        await this.callApi("send_private_msg", {
          nickname,
          message: [{ text: safeString(message) }],
        }),
      sendRconCommand: async (command: string) =>
        await this.callApi("send_rcon_command", { command }),
      title: async (nickname: string, title: string, subtitle = "") =>
        await this.callApi("title", {
          nickname,
          title,
          subtitle,
        }),
      actionBar: async (nickname: string, text: string) =>
        await this.callApi("action_bar", {
          nickname,
          text,
        }),
    };
    this.bot = {
      platform: "minecraft",
      selfId: safeString(config?.selfId).trim() || "minecraft",
      status: 0,
      workingIndicators: [
        createReactionWorkingIndicator("minecraft", () => this.bot),
        createTypingWorkingIndicator(() => this.bot),
      ],
      user: {},
      internal,
      sendMessage: async (chatId: string, content: any) =>
        await this.sendMessage(chatId, content),
    };
    this.app.register(this, this.bot);
  }

  async start() {
    if (this.loopPromise) return;
    this.stopped = false;
    this.loopPromise = this.runLoop();
  }

  async stop() {
    this.stopped = true;
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
    try {
      await this.loopPromise;
    } catch {}
    this.loopPromise = null;
    emitBotStatus(this.app, this.bot, 0);
  }

  private async runLoop() {
    while (!this.stopped) {
      try {
        await this.connect();
        await new Promise<void>((resolve) => {
          this.ws?.once("close", () => resolve());
        });
      } catch (error: any) {
        if (!this.stopped) {
          this.logger?.warn?.(
            `connect failed err=${safeString(error?.message || error)}`,
          );
        }
      } finally {
        this.rejectPending(new Error("minecraft_disconnected"));
        this.ws = null;
        this.bot.internal.ws = null;
        emitBotStatus(this.app, this.bot, 0);
      }
      if (!this.stopped) await sleep(3000);
    }
  }

  private async connect() {
    const url = safeString(this.config?.url || this.config?.endpoint).trim();
    if (!url) throw new Error("minecraft_url_required");
    await new Promise<void>((resolve, reject) => {
      const headers: Record<string, string> = {
        "x-self-name":
          safeString(this.config?.serverName).trim() ||
          safeString(this.bot?.selfId).trim() ||
          "minecraft",
      };
      const token = safeString(
        this.config?.token || this.config?.accessToken,
      ).trim();
      if (token) headers.Authorization = `Bearer ${token}`;
      const ws = new WebSocket(url, { headers });
      let settled = false;
      ws.once("open", () => {
        settled = true;
        this.ws = ws;
        this.bot.internal.ws = ws;
        this.bot.inboundRecovery = {
          status: "degraded",
          failures: ["provider_replay_unsupported"],
        };
        this.logger.warn(
          "inbound recovery degraded: QueQiao does not expose a durable replay/history action",
        );
        emitBotStatus(this.app, this.bot, 1);
        resolve();
      });
      ws.once("error", (error) => {
        if (!settled) reject(error);
      });
      ws.on("message", (buffer) => {
        void this.handleSocketMessage(buffer.toString("utf8"));
      });
    });
  }

  private rejectPending(error: Error) {
    for (const [echo, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(echo);
    }
  }

  private async callApi(api: string, data: any) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("minecraft_not_connected");
    }
    const echo = `rin-minecraft-${Date.now()}-${this.nextEchoId++}`;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`minecraft_api_timeout:${api}`));
      }, 15000);
      this.pending.set(echo, { resolve, reject, timer });
      ws.send(JSON.stringify({ api, data, echo }));
    });
  }

  private async handleSocketMessage(text: string) {
    let payload: any;
    try {
      payload = JSON.parse(text);
    } catch {
      return;
    }
    const echo = safeString(payload?.echo).trim();
    if (echo && this.pending.has(echo)) {
      const pending = this.pending.get(echo)!;
      clearTimeout(pending.timer);
      this.pending.delete(echo);
      if (safeString(payload?.status).trim() === "SUCCESS") {
        pending.resolve(payload);
      } else {
        pending.reject(
          new Error(safeString(payload?.message || "minecraft_api_failed")),
        );
      }
      return;
    }
    const eventName = safeString(payload?.event_name).trim();
    if (!eventName) return;
    const session = this.buildSession(payload);
    if (session) this.app.emit("message", session);
  }

  private async sendMessage(chatId: string, content: any) {
    const { work } = prepareOutboundNodes(content);
    const text = renderPlainTextFromNodes(work, {
      renderAt(attrs) {
        return `@${safeString(attrs.name || attrs.id).trim()}`;
      },
    });
    if (!text) throw new Error("minecraft_send_message_empty");
    const target = safeString(chatId).trim();
    if (target.startsWith("private:")) {
      const nickname = target.slice("private:".length);
      const result: any = await this.callApi("send_private_msg", {
        nickname,
        message: [{ text }],
      });
      return [
        safeString(result?.echo || result?.message_id || Date.now()).trim(),
      ];
    }
    const result: any = await this.callApi("broadcast", {
      message: [{ text }],
    });
    return [
      safeString(result?.echo || result?.message_id || Date.now()).trim(),
    ];
  }

  private buildSession(payload: any) {
    const eventName = safeString(payload?.event_name).trim();
    if (eventName !== "PlayerChatEvent" && eventName !== "PlayerCommandEvent") {
      return null;
    }
    const player =
      payload?.player && typeof payload.player === "object"
        ? payload.player
        : {};
    const userId =
      safeString(player?.uuid || player?.nickname || "").trim() || undefined;
    if (!userId) return null;
    const rawText =
      safeString(payload?.message || payload?.command || "").trim() ||
      undefined;
    const selfToken = safeString(this.bot?.selfId).trim();
    const mentionSelf = Boolean(
      rawText && selfToken && rawText.includes(`@${selfToken}`),
    );
    const strippedContent = mentionSelf
      ? stripMentionTokens(rawText, [`@${selfToken}`])
      : rawText;
    return {
      platform: "minecraft",
      selfId: safeString(this.bot?.selfId).trim() || undefined,
      bot: this.bot,
      messageId: safeString(
        payload?.message_id || payload?.timestamp || Date.now(),
      ).trim(),
      timestamp: Number.isFinite(Number(payload?.timestamp))
        ? Number(payload.timestamp) * 1000
        : Date.now(),
      userId,
      author: {
        userId,
        name: safeString(player?.nickname).trim() || undefined,
        nick: safeString(player?.nickname).trim() || undefined,
      },
      user: {
        id: userId,
        userId,
        name: safeString(player?.nickname).trim() || undefined,
        nick: safeString(player?.nickname).trim() || undefined,
      },
      channelId:
        safeString(payload?.server_name || "minecraft").trim() || "minecraft",
      channelName: safeString(payload?.server_name || "").trim() || undefined,
      guildId: safeString(payload?.server_name || "").trim() || undefined,
      guildName: safeString(payload?.server_name || "").trim() || undefined,
      isDirect: false,
      content: rawText,
      stripped: {
        appel: mentionSelf,
        content: strippedContent,
      },
      elements: strippedContent
        ? [normalizeNode("text", { content: strippedContent })]
        : [],
    };
  }
}
