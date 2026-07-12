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

export class LarkAdapter {
  private readonly app: any;
  private readonly config: Record<string, any>;
  private readonly logger: any;
  private readonly cacheDir: string;
  private readonly editableWorking: EditableTextMessageGroup;
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
      updateMessage: async (options: any) =>
        await this.client?.im?.message?.update?.(options),
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
    this.editableWorking = new EditableTextMessageGroup({
      cacheDir: this.cacheDir,
      cacheScope: sanitizeCacheScope(config?.appId, "default"),
      maxTextLength: 30_000,
      agentDir: app?.agentDir,
      sendText: async ({ chatId, text, replyToMessageId }) =>
        await this.sendPostText(chatId, text, replyToMessageId),
      editText: async ({ messageId, text }) => {
        const result = await internal.updateMessage({
          path: { message_id: messageId },
          data: this.buildPostData(text),
        });
        return safeString(
          result?.data?.message_id || result?.message_id || messageId,
        ).trim();
      },
      deleteMessage: async ({ messageId }) =>
        await this.client?.im?.message?.delete?.({
          path: { message_id: messageId },
        }),
    });
    this.bot = {
      platform: "lark",
      selfId: "",
      status: 0,
      workingIndicators: [
        this.editableWorking.indicator(),
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

  private renderOutboundText(nodes: any[]) {
    return normalizeLarkMarkdownListBlocks(
      renderMarkdownFromNodes(nodes, {
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
  }

  private buildPostData(text: string) {
    return {
      msg_type: "post",
      content: JSON.stringify({
        zh_cn: {
          content: [[{ tag: "md", text }]],
        },
      }),
    };
  }

  private async sendPostText(
    chatId: string,
    text: string,
    replyToMessageId?: string,
  ) {
    if (!text) throw new Error("lark_send_message_empty");
    const data = this.buildPostData(text);
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

  private async sendMessage(
    chatId: string,
    content: any,
    options: Record<string, any> = {},
  ) {
    const deliveryKind = safeString(options?.deliveryKind).trim() || "final";
    const isFinalDelivery = deliveryKind === "final";
    const { work, replyToMessageId } = prepareOutboundNodes(content);
    const text = this.renderOutboundText(work);
    if (!text) throw new Error("lark_send_message_empty");
    const coalesceWithWorkingMessage = Boolean(
      options?.coalesceWithWorkingMessage,
    );
    if (isFinalDelivery) {
      await this.editableWorking.deleteProgress(chatId, replyToMessageId);
      return await this.sendPostText(chatId, text, replyToMessageId);
    }
    if (
      coalesceWithWorkingMessage &&
      isEditableProgressDeliveryKind(deliveryKind)
    ) {
      return await this.editableWorking.updateText({
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
    }
    return await this.sendPostText(chatId, text, replyToMessageId);
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
