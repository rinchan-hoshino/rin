import path from "node:path";
import { EditableTextMessageGroup } from "./editable-text-message-group.js";
import {
  applyInboundRecoveryResult,
  deleteInboundRecoveryHead,
  InboundRecoveryGate,
  recoverInboundHeads,
} from "../inbound-recovery.js";
import { composeChatKeyForBot } from "../support.js";
import {
  createRinHttpTransport,
  discardRinHttpResponseBody,
  type RinHttpTransport,
} from "../../http/transport.js";
import {
  compactObject,
  createPrefixedLogger,
  emitBotStatus,
  ensureDir,
  isEditableProgressDeliveryKind,
  isImageMimeType,
  isImageName,
  normalizeNode,
  partialChatDeliveryError,
  prependChatQuoteNode,
  prepareOutboundNodes,
  readBinaryFromNode,
  renderMarkdownFromNodes,
  renderRichDeliveryFallback,
  resolveChatWorkingCopy,
  richFallbackDeliveryError,
  safeString,
  splitPlainText,
  stripMentionTokens,
  sanitizeCacheScope,
  markProviderRejection,
  isOutboundMediaNodeType,
  createTypingWorkingIndicator,
  createReactionWorkingIndicator,
} from "./common.js";

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

const DISCORD_INTERACTION_RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE = 4;

const DISCORD_MESSAGE_FLAG_EPHEMERAL = 1 << 6;

const DISCORD_MAX_TEXT_LENGTH = 2000;

export const DISCORD_REST_REQUEST_TIMEOUT_MS = 60_000;

export const DISCORD_REST_RETRIES = 1;

function isDiscordProviderRejection(error: unknown) {
  return /^DiscordAPIError(?:\[|$)/.test(
    safeString((error as any)?.name).trim(),
  );
}

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

function isPresentDiscordMember(member: any) {
  return Boolean(member?.user || member?.id || member?.userId);
}

type DiscordChat = {
  agentDir?: string;
  emit(event: string, ...args: unknown[]): boolean;
  beginInboundRecoveryChat?(chatKey: string): void;
  completeInboundRecoveryChat?(chatKey: string): void;
};

export class DiscordPlatform {
  private readonly app: DiscordChat;
  private readonly config: Record<string, any>;
  private readonly logger: any;
  private readonly cacheDir: string;
  private readonly editableWorking: EditableTextMessageGroup;
  private readonly inboundGate = new InboundRecoveryGate<any>();
  private readonly deletedChannelIds = new Set<string>();
  private workingText = resolveChatWorkingCopy().workingText;
  private client: any = null;
  private restRequest: ReturnType<
    typeof createDiscordRestRequestStrategy
  > | null = null;
  readonly bot: any;

  constructor(
    app: DiscordChat,
    dataDir: string,
    config: Record<string, any>,
    logger: any,
  ) {
    this.app = app;
    this.config = config;
    this.logger = createPrefixedLogger("chat:discord", logger);
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
    };
    this.editableWorking = new EditableTextMessageGroup({
      cacheDir: this.cacheDir,
      cacheScope: sanitizeCacheScope(config?.token, "default"),
      maxTextLength: DISCORD_MAX_TEXT_LENGTH,
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
      outboxMediaSendTimeoutMs: 180_000,
      outboxUsesDispatchSignal: true,
      workingIndicators: [
        this.editableWorking.indicator(),
        createReactionWorkingIndicator(() => this.bot),
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
      isChatMember: async (chatId: string, userId: string) =>
        isPresentDiscordMember(await this.bot.getGuildMember(chatId, userId)),
    };
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

  private async handleMessageUnlessDeleted(message: any) {
    const channelId = this.discordInboundChatId(message);
    if (this.deletedChannelIds.has(channelId)) return;
    try {
      await this.handleMessage(message);
    } finally {
      if (this.deletedChannelIds.has(channelId)) {
        this.deleteDiscordInboundRecoveryHead(channelId);
      }
    }
  }

  private async releaseDiscordIngress(messages: any[]) {
    for (const message of messages) {
      await this.handleMessageUnlessDeleted(message);
    }
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
        try {
          const channel = await this.fetchChannel(head.chatId);
          if (!channel?.messages?.fetch) {
            throw new Error("Discord message history is unavailable");
          }
          return await this.fetchDiscordMessagesAfter(channel, head.messageId);
        } catch (error: any) {
          if (Number(error?.code ?? error?.rawError?.code) !== 10003) {
            throw error;
          }
          this.retireDeletedDiscordChannel(head.chatId);
          return [];
        }
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

  private deleteDiscordInboundRecoveryHead(channelId: string) {
    const botId = safeString(this.bot?.selfId).trim();
    if (!channelId || !botId) return 0;
    const chatKey = composeChatKeyForBot(this.app, "discord", channelId, botId);
    return deleteInboundRecoveryHead(
      this.app.agentDir,
      "discord",
      botId,
      chatKey,
    );
  }

  private retireDeletedDiscordChannel(channelId: string) {
    const normalized = safeString(channelId).trim();
    if (!normalized) return;
    this.deletedChannelIds.add(normalized);
    const deleted = this.deleteDiscordInboundRecoveryHead(normalized);
    if (deleted > 0) {
      this.logger?.info?.(
        `discarded inbound recovery head for deleted Discord channel ${normalized}`,
      );
    }
  }

  private handleChannelDelete(channel: any) {
    this.retireDeletedDiscordChannel(channel?.id);
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
          await this.handleMessageUnlessDeleted(message);
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

  setWorkingText(text: string) {
    this.workingText =
      safeString(text).trim() || resolveChatWorkingCopy().workingText;
    this.editableWorking.setWorkingText(this.workingText);
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
      void this.handleMessageUnlessDeleted(message).catch((error: any) => {
        this.logger?.warn?.(
          `message handling failed err=${safeString(error?.message || error)}`,
        );
      });
    });

    this.client.on(Discord.Events.ChannelDelete, (channel: any) => {
      try {
        this.handleChannelDelete(channel);
      } catch (error: any) {
        this.logger?.warn?.(
          `Discord channel deletion cleanup failed err=${safeString(error?.message || error)}`,
        );
      }
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
      let sent: any;
      try {
        sent = await channel.send(
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
      } catch (error) {
        throw markProviderRejection(error, isDiscordProviderRejection);
      }
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
    let sent: any;
    try {
      sent = await channel.send(
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
    } catch (error) {
      throw markProviderRejection(error, isDiscordProviderRejection);
    }
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
          failures.push(
            richFallbackDeliveryError(
              error,
              new Error("discord_rich_fallback_empty_result"),
            ),
          );
          return;
        }
        delivered.push(...fallbackIds);
        firstReply = undefined;
      } catch (fallbackError: any) {
        failures.push(richFallbackDeliveryError(error, fallbackError));
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
              exclusive: options?.exclusiveProgressMessage === true,
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
          failures.push(error);
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
        content: this.workingText,
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
