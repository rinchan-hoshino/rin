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
      workingIndicators: [
        createReactionWorkingIndicator("qq", () => this.bot),
        createTypingWorkingIndicator(() => this.bot),
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
