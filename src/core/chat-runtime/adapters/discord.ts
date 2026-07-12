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

import {
  sanitizeCacheScope,
  DISCORD_API_BASE_URL,
  DISCORD_INTERACTION_RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE,
  DISCORD_MESSAGE_FLAG_EPHEMERAL,
  DISCORD_MAX_TEXT_LENGTH,
  SLACK_MAX_TEXT_LENGTH,
  isOutboundMediaNodeType,
  SLACK_REACTION_NAMES,
  createTypingWorkingIndicator,
  createReactionWorkingIndicator,
  LARK_REACTION_TYPES,
  escapeLarkTagText,
  escapeLarkTagAttr,
  normalizeLarkMarkdownListBlocks,
  QQ_REACTION_EMOJI_IDS,
  toSlackReactionName,
  escapeSlackMrkdwn,
  truncateSlackPlainText,
  todoNodeItems,
  todoNodeTitle,
  todoFallbackText,
  toLarkReactionType,
  toQqReactionPayload,
  collectionValues,
  permissionSetHasFlag,
  permissionSetHasViewChannel,
  permissionSetHasAdministrator,
  isManagedBotRole,
  isOwnerHumanUserOrBot,
  memberListHasOnlyOwnerHumanUsers,
  discordChannelDisplayName,
  findDiscordChannelById,
  resolveDiscordParentChannel,
  formatDiscordChannelPathName,
  hasUnboundedDiscordAdministratorBypass,
} from "./helpers.js";

export class DiscordAdapter {
  private readonly app: any;
  private readonly config: Record<string, any>;
  private readonly logger: any;
  private readonly cacheDir: string;
  private readonly editableWorking: EditableTextMessageGroup;
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
    const recordFailure = async (error: unknown, placeholder: string) => {
      failures.push(error);
      this.logger.warn(
        `rich message segment failed err=${safeString((error as any)?.message || error)}`,
      );
      if (!placeholder) return;
      try {
        await ensureFinalProgressCleared();
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
          await ensureFinalProgressCleared();
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
          await recordFailure(error, renderRichDeliveryErrorPlaceholder(error));
        }
      }
      delivered.push(...chunkIds);
      if (chunkIds.length) firstReply = undefined;
    }
    if (isFinalDelivery && !finalizedWorkingMessage) {
      await this.editableWorking.deleteProgress(chatId, replyToMessageId);
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
        content: randomWorkingText(
          resolveChatRuntimeWorkingCopy(this.app?.agentDir).frames,
        ),
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
