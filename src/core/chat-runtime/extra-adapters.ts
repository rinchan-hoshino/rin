import path from "node:path";

import WebSocket from "ws";

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
  safeString,
  sleep,
  splitPlainText,
  stripMentionTokens,
} from "./common.js";

const DISCORD_MAX_TEXT_LENGTH = 2000;
const SLACK_MAX_TEXT_LENGTH = 40000;

const SLACK_REACTION_NAMES: Record<string, string> = {
  "🤔": "thinking_face",
  "🔥": "fire",
};

const LARK_REACTION_TYPES: Record<string, string> = {
  "🤔": "THINKING",
  "🔥": "FIRE",
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

const QQ_REACTION_EMOJI_IDS: Record<string, string> = {
  "🤔": "212",
  "🔥": "128293",
};

function toSlackReactionName(emoji: string) {
  const value = safeString(emoji).trim();
  return SLACK_REACTION_NAMES[value] || value.replace(/^:+|:+$/g, "");
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
    this.cacheDir = path.join(dataDir, "chat-runtime-cache", "discord");
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
    };
    this.bot = {
      platform: "discord",
      selfId: "",
      status: 0,
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

  private async sendMessage(chatId: string, content: any) {
    const channel = await this.fetchChannel(chatId);
    if (!channel?.send)
      throw new Error(`discord_channel_not_sendable:${chatId}`);
    const { work, replyToMessageId } = prepareOutboundNodes(content);
    const text = renderPlainTextFromNodes(work, {
      includeMedia: false,
      markdown: "preserve",
      renderAt(attrs) {
        const id = safeString(attrs.id).trim();
        return id ? `<@${id}>` : safeString(attrs.name).trim();
      },
    });
    const files: any[] = [];
    for (const node of work) {
      const type = safeString(node?.type).toLowerCase();
      if (!["image", "file", "video", "audio", "sticker"].includes(type))
        continue;
      const payload = await readBinaryFromNode(node);
      if (!payload) continue;
      if (payload.url) {
        files.push(payload.url);
        continue;
      }
      files.push({
        attachment: payload.data,
        name: payload.name,
      });
    }
    const delivered: string[] = [];
    const textChunks = splitPlainText(text, DISCORD_MAX_TEXT_LENGTH);
    if (!textChunks.length && !files.length) {
      throw new Error("discord_send_message_empty");
    }
    const chunkQueue = textChunks.length ? textChunks : [""];
    let remainingFiles: any[] | undefined = files.length ? files : undefined;
    let firstReply = replyToMessageId;
    for (const textChunk of chunkQueue) {
      if (!textChunk && !remainingFiles?.length) continue;
      const sent = await channel.send(
        compactObject({
          content: textChunk || undefined,
          files: remainingFiles?.length ? remainingFiles : undefined,
          reply: firstReply
            ? {
                messageReference: firstReply,
                failIfNotExists: false,
              }
            : undefined,
        }),
      );
      const messageId = safeString(sent?.id).trim();
      if (messageId) delivered.push(messageId);
      remainingFiles = undefined;
      firstReply = undefined;
    }
    if (!delivered.length) throw new Error("discord_send_message_empty_result");
    return delivered;
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
      channelName: safeString(message?.channel?.name || "").trim() || undefined,
      guildId: safeString(message?.guildId || "").trim() || undefined,
      guildName: safeString(message?.guild?.name || "").trim() || undefined,
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
    this.cacheDir = path.join(dataDir, "chat-runtime-cache", "slack");
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

  private async sendMessage(chatId: string, content: any) {
    const { work, replyToMessageId } = prepareOutboundNodes(content);
    const text = renderPlainTextFromNodes(work, {
      includeMedia: false,
      markdown: "preserve",
      renderAt(attrs) {
        const id = safeString(attrs.id).trim();
        return id ? `<@${id}>` : safeString(attrs.name).trim();
      },
    });
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
    for (const node of work) {
      const type = safeString(node?.type).toLowerCase();
      if (!["image", "file", "video", "audio", "sticker"].includes(type))
        continue;
      const payload = await readBinaryFromNode(node);
      if (!payload) continue;
      if (payload.url) {
        const sent = await this.web.chat.postMessage(
          compactObject({
            channel: chatId,
            text: payload.url,
            thread_ts: replyToMessageId || undefined,
          }),
        );
        const ts = safeString(sent?.ts).trim();
        if (ts) delivered.push(ts);
        continue;
      }
      const uploaded = await this.web.files.uploadV2(
        compactObject({
          channel_id: chatId,
          file: payload.data,
          filename: payload.name,
          initial_comment: undefined,
          thread_ts: replyToMessageId || undefined,
        }),
      );
      const fileId = safeString(
        uploaded?.files?.[0]?.id || uploaded?.file?.id || "",
      ).trim();
      if (fileId) delivered.push(fileId);
    }
    if (!delivered.length) throw new Error("slack_send_message_empty");
    return delivered;
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
  private client: any = null;
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
    this.logger = createPrefixedLogger("chat-runtime:lark", logger);
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
      getUser: async (options: any) =>
        await this.client?.contact?.user?.get?.(options),
    };
    this.bot = {
      platform: "lark",
      selfId: "",
      status: 0,
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
        "im.message.receive_v1": async (data: any) => {
          await this.handleMessage(data);
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
    const { work } = prepareOutboundNodes(content);
    const text = renderMarkdownFromNodes(work, {
      renderAt(attrs) {
        const id = safeString(attrs.id).trim();
        const name = safeString(attrs.name).trim();
        return id
          ? `<at user_id="${escapeLarkTagAttr(id)}">${escapeLarkTagText(name)}</at>`
          : name;
      },
    });
    if (!text) throw new Error("lark_send_message_empty");
    const result = await this.client.im.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: chatId,
        msg_type: "post",
        content: JSON.stringify({
          zh_cn: {
            content: [[{ tag: "md", text }]],
          },
        }),
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
    const parsed = this.parseMessageContent(safeString(message?.content || ""));
    const mentionSelf = (
      Array.isArray(message?.mentions) ? message.mentions : parsed.mentions
    ).some((item: any) => {
      const key = safeString(
        item?.key || item?.id || item?.open_id || "",
      ).trim();
      return key && key === safeString(this.bot?.selfId).trim();
    });
    const strippedContent = parsed.text;
    const isDirect =
      safeString(message?.chat_type || "")
        .trim()
        .toLowerCase() === "p2p";
    const nickname =
      safeString(sender?.sender_type).trim() === "user"
        ? safeString(sender?.sender_id?.open_id || "").trim()
        : undefined;
    const elements: any[] = [];
    if (strippedContent) {
      elements.push(normalizeNode("text", { content: strippedContent }));
    }
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
      content: parsed.text,
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
