import path from "node:path";

import WebSocket from "ws";

import { getWorkingReactionFrame } from "../chat/transport.js";
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
  isImageMimeType,
  isImageName,
  normalizeNode,
  prepareOutboundNodes,
  readBinaryFromNode,
  renderMarkdownFromNodes,
  renderPlainTextFromNodes,
  renderRichDeliveryErrorPlaceholder,
  safeString,
  sleep,
  splitPlainText,
  stripMentionTokens,
} from "./common.js";

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const DISCORD_INTERACTION_RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE = 4;
const DISCORD_MESSAGE_FLAG_EPHEMERAL = 1 << 6;
const DISCORD_MAX_TEXT_LENGTH = 2000;
const SLACK_MAX_TEXT_LENGTH = 40000;

function isOutboundMediaNodeType(type: string) {
  return ["image", "file", "video", "audio", "sticker"].includes(type);
}

const SLACK_REACTION_NAMES: Record<string, string> = {
  "🤔": "thinking_face",
  "🔥": "fire",
};

function createPollingWorkingIndicator(platform: string, getBot: () => any) {
  const reactions = new Map<string, string>();
  return {
    type: "polling",
    async tick(context: any) {
      const bot = getBot();
      const chatId = safeString(context?.chatId).trim();
      if (!chatId) return false;
      let sent = false;
      if (typeof bot?.internal?.sendChatAction === "function") {
        const result = await bot.internal.sendChatAction({
          chat_id: chatId,
          action: "typing",
        });
        sent = result !== false;
      } else if (typeof bot?.internal?.sendTyping === "function") {
        const result = await bot.internal.sendTyping(chatId);
        sent = result !== false;
      }
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

const QQ_REACTION_EMOJI_IDS: Record<string, string> = {
  "🤔": "212",
  "🔥": "128293",
};

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

function toQqReactionPayload(messageId: string, emoji: string) {
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
  private client: any = null;
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
      deleteMessage: async (channelId: string, messageId: string) => {
        const channel = await this.fetchChannel(channelId);
        return await channel?.messages?.delete?.(messageId);
      },
      setApplicationCommands: async (payload: any) =>
        await this.setApplicationCommands(payload),
      hasOnlyOwnerUsers: async (channelId: string, ownerUserIds: string[]) =>
        await this.hasOnlyOwnerUsers(channelId, ownerUserIds),
    };
    this.bot = {
      platform: "discord",
      selfId: "",
      status: 0,
      workingIndicators: [
        createPollingWorkingIndicator("discord", () => this.bot),
      ],
      user: {},
      internal,
      sendMessage: async (chatId: string, content: any) =>
        await this.sendMessage(chatId, content),
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

  async start() {
    const token = safeString(this.config?.token).trim();
    if (!token) throw new Error("discord_token_required");
    const Discord: any = await import("discord.js");
    const intents = [
      Discord.GatewayIntentBits.Guilds,
      Discord.GatewayIntentBits.GuildMessages,
      Discord.GatewayIntentBits.DirectMessages,
      Discord.GatewayIntentBits.MessageContent,
    ].filter(Boolean);
    this.client = new Discord.Client({
      intents,
      partials: [Discord.Partials.Channel].filter(Boolean),
    });
    this.bot.internal.client = this.client;
    this.bot.internal.rest = this.client.rest;

    this.client.on(Discord.Events.ClientReady, (client: any) => {
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
      emitBotStatus(this.app, this.bot, 1);
    });

    this.client.on(Discord.Events.MessageCreate, (message: any) => {
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
  }

  async stop() {
    try {
      await this.client?.destroy?.();
    } catch {}
    this.client = null;
    emitBotStatus(this.app, this.bot, 0);
  }

  private renderOutboundText(nodes: any[]) {
    return renderPlainTextFromNodes(nodes, {
      includeMedia: false,
      markdown: "preserve",
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

  private async sendMessage(chatId: string, content: any) {
    const channel = await this.fetchChannel(chatId);
    if (!channel?.send)
      throw new Error(`discord_channel_not_sendable:${chatId}`);
    const { work, replyToMessageId } = prepareOutboundNodes(content);
    const delivered: string[] = [];
    const failures: unknown[] = [];
    let cursor = 0;
    let firstReply = replyToMessageId;
    const recordFailure = async (error: unknown, placeholder: string) => {
      failures.push(error);
      this.logger.warn(
        `rich message segment failed err=${safeString((error as any)?.message || error)}`,
      );
      if (!placeholder) return;
      try {
        const placeholderIds = await this.sendTextChunk(channel, {
          text: placeholder,
          replyToMessageId: firstReply,
        });
        delivered.push(...placeholderIds);
        if (placeholderIds.length) firstReply = undefined;
      } catch (placeholderError: any) {
        this.logger.warn(
          `rich failure placeholder failed err=${safeString(placeholderError?.message || placeholderError)}`,
        );
      }
    };
    while (cursor < work.length) {
      const type = safeString(work[cursor]?.type).toLowerCase();
      let chunkIds: string[] = [];
      if (isOutboundMediaNodeType(type)) {
        try {
          chunkIds = await this.sendMediaChunk(channel, {
            node: work[cursor],
            replyToMessageId: firstReply,
          });
        } catch (error) {
          await recordFailure(error, renderRichDeliveryErrorPlaceholder(error));
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
          await recordFailure(error, renderRichDeliveryErrorPlaceholder(error));
        }
        for (const textChunk of splitPlainText(text, DISCORD_MAX_TEXT_LENGTH)) {
          try {
            const textChunkIds = await this.sendTextChunk(channel, {
              text: textChunk,
              replyToMessageId: firstReply,
            });
            delivered.push(...textChunkIds);
            if (textChunkIds.length) firstReply = undefined;
          } catch (error) {
            await recordFailure(
              error,
              renderRichDeliveryErrorPlaceholder(error),
            );
          }
        }
      }
      delivered.push(...chunkIds);
      if (chunkIds.length) firstReply = undefined;
    }
    if (delivered.length) return delivered;
    if (failures.length) throw failures[0];
    throw new Error("discord_send_message_empty_result");
  }

  private async acknowledgeInteraction(interaction: any) {
    if (interaction?.deferred || interaction?.replied) return;
    const interactionId = safeString(interaction?.id).trim();
    const interactionToken = safeString(interaction?.token).trim();
    const responseBody = {
      type: DISCORD_INTERACTION_RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: "Working...",
        flags: DISCORD_MESSAGE_FLAG_EPHEMERAL,
      },
    };
    if (interactionId && interactionToken && typeof fetch === "function") {
      try {
        const response = await fetch(
          `${DISCORD_API_BASE_URL}/interactions/${encodeURIComponent(interactionId)}/${encodeURIComponent(interactionToken)}/callback`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(responseBody),
          },
        );
        if (response.ok) return;
        const detail = safeString(await response.text()).trim();
        this.logger.warn(
          `interaction acknowledge failed status=${response.status}${detail ? ` err=${detail}` : ""}`,
        );
        return;
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
    void this.acknowledgeInteraction(interaction);
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
      elements,
      quote: safeString(message?.reference?.messageId || "").trim()
        ? { messageId: safeString(message.reference.messageId).trim() }
        : undefined,
    });
  }
}

export class SlackAdapter {
  private readonly app: any;
  private readonly config: Record<string, any>;
  private readonly logger: any;
  private readonly cacheDir: string;
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
    this.bot = {
      platform: "slack",
      selfId: "",
      status: 0,
      workingIndicators: [
        createPollingWorkingIndicator("slack", () => this.bot),
      ],
      user: {},
      internal,
      sendMessage: async (chatId: string, content: any) =>
        await this.sendMessage(chatId, content),
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

    await this.socket.start();
    emitBotStatus(this.app, this.bot, 1);
  }

  async stop() {
    try {
      await this.socket?.disconnect?.();
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
    await downloadToFile(fullPath, url, {
      Authorization: `Bearer ${safeString(this.config?.botToken).trim()}`,
    });
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
    return renderPlainTextFromNodes(nodes, {
      includeMedia: false,
      markdown: "preserve",
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

  private async sendMessage(chatId: string, content: any) {
    const { work, replyToMessageId } = prepareOutboundNodes(content);
    const delivered: string[] = [];
    const failures: unknown[] = [];
    let cursor = 0;
    const recordFailure = async (error: unknown, placeholder: string) => {
      failures.push(error);
      this.logger.warn(
        `rich message segment failed err=${safeString((error as any)?.message || error)}`,
      );
      if (!placeholder) return;
      try {
        delivered.push(
          ...(await this.postText(chatId, placeholder, replyToMessageId)),
        );
      } catch (placeholderError: any) {
        this.logger.warn(
          `rich failure placeholder failed err=${safeString(placeholderError?.message || placeholderError)}`,
        );
      }
    };
    while (cursor < work.length) {
      const type = safeString(work[cursor]?.type).toLowerCase();
      let messageIds: string[] = [];
      if (type === "todo" || type === "checklist") {
        try {
          messageIds = await this.postTodo(
            chatId,
            work[cursor],
            replyToMessageId,
          );
        } catch (error) {
          await recordFailure(error, renderRichDeliveryErrorPlaceholder(error));
        }
        cursor += 1;
      } else if (isOutboundMediaNodeType(type)) {
        try {
          messageIds = await this.sendMedia(
            chatId,
            work[cursor],
            replyToMessageId,
          );
        } catch (error) {
          await recordFailure(error, renderRichDeliveryErrorPlaceholder(error));
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
          messageIds = await this.postText(chatId, text, replyToMessageId);
        } catch (error) {
          await recordFailure(error, renderRichDeliveryErrorPlaceholder(error));
        }
      }
      delivered.push(...messageIds);
    }
    if (delivered.length) return delivered;
    if (failures.length) throw failures[0];
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
      elements,
      quote: safeString(event?.thread_ts || "").trim()
        ? { messageId: safeString(event.thread_ts).trim() }
        : undefined,
    });
    if (typeof ack === "function") {
      await ack();
    }
  }
}

export class QQAdapter {
  private readonly app: any;
  private readonly config: Record<string, any>;
  private readonly logger: any;
  private openapi: any = null;
  private wsClient: any = null;
  readonly bot: any;

  constructor(
    app: any,
    _dataDir: string,
    config: Record<string, any>,
    logger: any,
  ) {
    this.app = app;
    this.config = config;
    this.logger = createPrefixedLogger("chat-runtime:qq", logger);
    const internal: any = {
      openapi: null,
      wsClient: null,
      request: async (options: any) => await this.openapi?.request?.(options),
      getGuild: async (guildId: string) =>
        await this.openapi?.guildApi?.guild?.(guildId),
      getChannel: async (channelId: string) =>
        await this.openapi?.channelApi?.channel?.(channelId),
      getMessage: async (channelId: string, messageId: string) =>
        await this.openapi?.messageApi?.message?.(channelId, messageId),
      postMessage: async (channelId: string, message: any) =>
        await this.openapi?.messageApi?.postMessage?.(channelId, message),
      deleteMessage: async (
        channelId: string,
        messageId: string,
        hideTip = false,
      ) =>
        await this.openapi?.messageApi?.deleteMessage?.(
          channelId,
          messageId,
          hideTip,
        ),
      postReaction: async (channelId: string, reaction: any) =>
        await this.openapi?.reactionApi?.postReaction?.(channelId, reaction),
      deleteReaction: async (channelId: string, reaction: any) =>
        await this.openapi?.reactionApi?.deleteReaction?.(channelId, reaction),
      postC2CMessage: async (openid: string, message: any) =>
        await this.openapi?.request?.({
          method: "POST",
          url: "/v2/users/:openid/messages",
          rest: { openid },
          data: message,
        }),
      postGroupMessage: async (groupOpenid: string, message: any) =>
        await this.openapi?.request?.({
          method: "POST",
          url: "/v2/groups/:group_openid/messages",
          rest: { group_openid: groupOpenid },
          data: message,
        }),
    };
    this.bot = {
      platform: "qq",
      selfId: "",
      status: 0,
      workingIndicators: [createPollingWorkingIndicator("qq", () => this.bot)],
      user: {},
      internal,
      sendMessage: async (chatId: string, content: any) =>
        await this.sendMessage(chatId, content),
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
    const appID = safeString(this.config?.id).trim();
    const token = safeString(this.config?.token).trim();
    if (!appID) throw new Error("qq_app_id_required");
    if (!token) throw new Error("qq_token_required");
    const QQ: any = await import("qq-guild-bot");
    const sandbox = Boolean(this.config?.sandbox);
    const intents = Array.isArray(this.config?.intents)
      ? this.config.intents
      : safeString(this.config?.type).trim() === "private"
        ? ["GROUP_AND_C2C_EVENT"]
        : [
            "PUBLIC_GUILD_MESSAGES",
            "DIRECT_MESSAGE",
            "GUILDS",
            "GUILD_MEMBERS",
          ];
    this.openapi = QQ.createOpenAPI({ appID, token, sandbox });
    this.wsClient = QQ.createWebsocket({ appID, token, sandbox, intents });
    this.bot.internal.openapi = this.openapi;
    this.bot.internal.wsClient = this.wsClient;

    this.wsClient.on("READY", (data: any) => {
      const user = data?.msg?.user || data?.user || {};
      this.bot.selfId = safeString(user?.id || "").trim();
      this.bot.user = {
        id: this.bot.selfId,
        userId: this.bot.selfId,
        name: safeString(user?.username || "").trim() || undefined,
        username: safeString(user?.username || "").trim() || undefined,
        nick: safeString(user?.username || "").trim() || undefined,
      };
      emitBotStatus(this.app, this.bot, 1);
    });
    this.wsClient.on("ERROR", (error: any) => {
      this.logger?.warn?.(
        `ws error err=${safeString(error?.message || error)}`,
      );
    });
    for (const eventName of [
      "PUBLIC_GUILD_MESSAGES",
      "DIRECT_MESSAGE",
      "GROUP_AND_C2C_EVENT",
      "GUILD_MESSAGES",
    ]) {
      this.wsClient.on(eventName, (payload: any) => {
        void this.handleIncomingEvent(payload).catch((error: any) => {
          this.logger?.warn?.(
            `event handling failed event=${eventName} err=${safeString(error?.message || error)}`,
          );
        });
      });
    }
    emitBotStatus(this.app, this.bot, 1);
  }

  async stop() {
    try {
      this.wsClient?.disconnect?.();
    } catch {}
    this.wsClient = null;
    this.openapi = null;
    emitBotStatus(this.app, this.bot, 0);
  }

  private buildTextMessage(text: string, replyToMessageId?: string) {
    return compactObject({
      content: text,
      msg_type: 0,
      message_reference: replyToMessageId
        ? { message_id: replyToMessageId }
        : undefined,
      msg_id: replyToMessageId || undefined,
      msg_seq: replyToMessageId ? 1 : undefined,
    });
  }

  private reactionChannelId(chatId: string) {
    const target = safeString(chatId).trim();
    return target.startsWith("channel:") ? target.slice("channel:".length) : "";
  }

  async createReaction(chatId: string, messageId: string, emoji: string) {
    const channelId = this.reactionChannelId(chatId);
    if (!channelId) throw new Error("qq_reaction_requires_channel_chat");
    await this.bot.internal.postReaction(
      channelId,
      toQqReactionPayload(messageId, emoji),
    );
    return true;
  }

  async deleteReaction(chatId: string, messageId: string, emoji: string) {
    const channelId = this.reactionChannelId(chatId);
    if (!channelId) throw new Error("qq_reaction_requires_channel_chat");
    await this.bot.internal.deleteReaction(
      channelId,
      toQqReactionPayload(messageId, emoji),
    );
    return true;
  }

  private async sendMessage(chatId: string, content: any) {
    const { work, replyToMessageId } = prepareOutboundNodes(content);
    const text = renderPlainTextFromNodes(work, {
      renderAt(attrs) {
        const id = safeString(attrs.id).trim();
        return id ? `<@${id}>` : safeString(attrs.name).trim();
      },
    });
    if (!text) throw new Error("qq_send_message_empty");
    const target = safeString(chatId).trim();
    if (target.startsWith("channel:")) {
      const channelId = target.slice("channel:".length);
      const result = await this.openapi.messageApi.postMessage(
        channelId,
        this.buildTextMessage(text, replyToMessageId),
      );
      return [safeString(result?.data?.id || result?.id).trim()].filter(
        Boolean,
      );
    }
    if (target.startsWith("dm:")) {
      const guildId = target.slice("dm:".length);
      const result = await this.openapi.directMessageApi.postDirectMessage(
        guildId,
        this.buildTextMessage(text, replyToMessageId),
      );
      return [safeString(result?.data?.id || result?.id).trim()].filter(
        Boolean,
      );
    }
    if (target.startsWith("group:")) {
      const groupOpenid = target.slice("group:".length);
      const result = await this.bot.internal.postGroupMessage(
        groupOpenid,
        this.buildTextMessage(text, replyToMessageId),
      );
      return [safeString(result?.data?.id || result?.id).trim()].filter(
        Boolean,
      );
    }
    if (target.startsWith("private:c2c:")) {
      const openid = target.slice("private:c2c:".length);
      const result = await this.bot.internal.postC2CMessage(
        openid,
        this.buildTextMessage(text, replyToMessageId),
      );
      return [safeString(result?.data?.id || result?.id).trim()].filter(
        Boolean,
      );
    }
    const result = await this.openapi.messageApi.postMessage(
      target,
      this.buildTextMessage(text, replyToMessageId),
    );
    return [safeString(result?.data?.id || result?.id).trim()].filter(Boolean);
  }

  private async handleIncomingEvent(payload: any) {
    const eventType = safeString(payload?.eventType || payload?.t || "").trim();
    const msg =
      payload?.msg && typeof payload.msg === "object"
        ? payload.msg
        : payload?.d || {};
    if (!eventType || !msg) return;
    let channelId = "";
    let guildId = "";
    let guildName = "";
    let isDirect = false;
    let mentionSelf = false;
    const rawText = safeString(msg?.content || "").trim();
    const userId = safeString(
      msg?.author?.id ||
        msg?.author?.member_openid ||
        msg?.author?.user_openid ||
        msg?.author?.openid ||
        msg?.openid ||
        "",
    ).trim();
    if (!userId || userId === safeString(this.bot?.selfId).trim()) return;

    if (
      eventType === "AT_MESSAGE_CREATE" ||
      eventType === "PUBLIC_GUILD_MESSAGES" ||
      eventType === "MESSAGE_CREATE"
    ) {
      channelId = `channel:${safeString(msg?.channel_id).trim()}`;
      guildId = safeString(msg?.guild_id).trim();
      guildName = safeString(msg?.guild_name || "").trim() || undefined;
      mentionSelf = true;
    } else if (
      eventType === "DIRECT_MESSAGE_CREATE" ||
      eventType === "DIRECT_MESSAGE"
    ) {
      channelId = `dm:${safeString(msg?.guild_id).trim()}`;
      isDirect = true;
    } else if (eventType === "GROUP_AT_MESSAGE_CREATE") {
      channelId = `group:${safeString(msg?.group_openid || msg?.group_id).trim()}`;
      guildId = safeString(msg?.group_openid || msg?.group_id).trim();
      guildName = safeString(msg?.group_name || "").trim() || undefined;
      mentionSelf = true;
    } else if (eventType === "C2C_MESSAGE_CREATE") {
      channelId = `private:c2c:${safeString(msg?.author?.user_openid || msg?.openid || userId).trim()}`;
      isDirect = true;
    } else {
      return;
    }

    const mentionToken = `<@!${safeString(this.bot?.selfId).trim()}>`;
    const strippedContent = mentionSelf
      ? stripMentionTokens(rawText, [
          mentionToken,
          `<@${safeString(this.bot?.selfId).trim()}>`,
        ])
      : rawText;
    const groupNickname = !isDirect
      ? safeString(msg?.member?.nick || "").trim() || undefined
      : undefined;
    const nickname =
      safeString(msg?.author?.username || msg?.author?.nick || "").trim() ||
      undefined;
    const displayName = groupNickname || nickname;
    const elements: any[] = [];
    if (strippedContent) {
      elements.push(normalizeNode("text", { content: strippedContent }));
    }
    this.app.emit("message", {
      platform: "qq",
      selfId: safeString(this.bot?.selfId).trim() || undefined,
      bot: this.bot,
      messageId: safeString(
        msg?.id || msg?.message_id || payload?.eventId || "",
      ).trim(),
      timestamp: Number.isFinite(
        Number(Date.parse(safeString(msg?.timestamp || ""))),
      )
        ? Date.parse(safeString(msg?.timestamp))
        : Date.now(),
      userId,
      author: {
        userId,
        name: displayName,
        nick: displayName,
        nickname,
        groupNickname,
        username: nickname,
      },
      user: {
        id: userId,
        userId,
        name: displayName,
        nick: displayName,
        nickname,
        groupNickname,
        username: nickname,
      },
      channelId,
      guildId: guildId || undefined,
      guildName: guildName || undefined,
      isDirect,
      content: rawText,
      stripped: {
        appel: mentionSelf,
        content: strippedContent,
      },
      elements,
      quote: safeString(msg?.message_reference?.message_id || "").trim()
        ? { messageId: safeString(msg.message_reference.message_id).trim() }
        : undefined,
    });
  }
}

export class LarkAdapter {
  private readonly app: any;
  private readonly config: Record<string, any>;
  private readonly logger: any;
  private readonly cacheDir: string;
  private client: any = null;
  private wsClient: any = null;
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
        createPollingWorkingIndicator("lark", () => this.bot),
      ],
      user: {},
      internal,
      sendMessage: async (chatId: string, content: any) =>
        await this.sendMessage(chatId, content),
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
    await this.wsClient.start({
      eventDispatcher: new Lark.EventDispatcher({}).register({
        "im.message.receive_v1": (data: any) => {
          void this.handleMessage(data).catch((error: any) => {
            this.logger?.warn?.(
              `message handling failed err=${safeString(error?.message || error)}`,
            );
          });
        },
      }),
    });
    emitBotStatus(this.app, this.bot, 1);
  }

  async stop() {
    try {
      this.wsClient?.close?.({ force: true });
    } catch {}
    this.wsClient = null;
    this.client = null;
    emitBotStatus(this.app, this.bot, 0);
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

  private async sendMessage(chatId: string, content: any) {
    const { work, replyToMessageId } = prepareOutboundNodes(content);
    const text = normalizeLarkMarkdownListBlocks(
      renderMarkdownFromNodes(work, {
        preserveLineIndentation: true,
        renderAt(attrs) {
          const id = safeString(attrs.id).trim();
          const name = safeString(attrs.name).trim();
          return id
            ? `<at user_id="${escapeLarkTagAttr(id)}">${escapeLarkTagText(name)}</at>`
            : name;
        },
      }),
    );
    if (!text) throw new Error("lark_send_message_empty");
    const data = {
      msg_type: "post",
      content: JSON.stringify({
        zh_cn: {
          content: [[{ tag: "md", text }]],
        },
      }),
    };
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
    return [
      safeString(result?.data?.message_id || result?.message_id || "").trim(),
    ].filter(Boolean);
  }

  private async handleMessage(data: any) {
    const message =
      data?.message && typeof data.message === "object" ? data.message : {};
    const sender =
      data?.sender && typeof data.sender === "object" ? data.sender : {};
    const senderId = safeString(
      sender?.sender_id?.open_id ||
        sender?.sender_id?.user_id ||
        sender?.sender_id ||
        "",
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
      elements,
      quote: safeString(message?.parent_id || "").trim()
        ? { messageId: safeString(message.parent_id).trim() }
        : undefined,
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
        createPollingWorkingIndicator("minecraft", () => this.bot),
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
