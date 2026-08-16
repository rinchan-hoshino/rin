import fs from "node:fs";
import path from "node:path";
import { EditableTextMessageGroup } from "./editable-text-message-group.js";
import {
  createRinHttpTransport,
  discardRinHttpResponseBody,
  type RinHttpTransport,
} from "../http/transport.js";
import { formatRinTodoChecklistMarkdownContent } from "../rin-lib/todo-state.js";
import {
  compactObject,
  createPrefixedLogger,
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
  renderPlainTextFromNodes,
  renderRichDeliveryFallback,
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

async function downloadToFile(
  filePath: string,
  url: string,
  headers?: Record<string, string>,
  transport?: RinHttpTransport,
) {
  const requestTransport = transport || createRinHttpTransport();
  try {
    const response = await requestTransport.fetch(url, { headers });
    try {
      if (!response.ok) {
        throw new Error(`download_failed:${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      await fs.promises.writeFile(filePath, buffer);
      return buffer;
    } finally {
      await discardRinHttpResponseBody(response);
    }
  } finally {
    if (!transport) await requestTransport.close();
  }
}

const SLACK_MAX_TEXT_LENGTH = 40000;

function isSlackProviderRejection(error: unknown) {
  return (
    safeString((error as any)?.code).trim() === "slack_webapi_platform_error"
  );
}

const SLACK_REACTION_NAMES: Record<string, string> = {
  "🤔": "thinking_face",
  "🔥": "fire",
  "⏳": "hourglass_flowing_sand",
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
      ) => await this.createReaction(chatId, messageId, emoji),
      deleteReaction: async (
        chatId: string,
        messageId: string,
        emoji: string,
      ) => await this.deleteReaction(chatId, messageId, emoji),
    };
    this.app.register(this, this.bot);
  }

  setWorkingText(text: string) {
    this.editableWorking.setWorkingText(text);
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
      let sent: any;
      try {
        sent = await this.web.chat.postMessage(
          compactObject({
            channel: chatId,
            text: textChunk,
            thread_ts: replyToMessageId || undefined,
          }),
        );
      } catch (error) {
        throw markProviderRejection(error, isSlackProviderRejection);
      }
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
    let sent: any;
    try {
      sent = await this.web.chat.postMessage(
        compactObject({
          channel: chatId,
          text: payload.text,
          blocks: payload.blocks,
          thread_ts: replyToMessageId || undefined,
        }),
      );
    } catch (error) {
      throw markProviderRejection(error, isSlackProviderRejection);
    }
    const ts = safeString(sent?.ts).trim();
    return ts ? [ts] : [];
  }

  private async uploadFile(
    chatId: string,
    payload: { data: Buffer; name: string },
    replyToMessageId?: string,
  ) {
    let uploaded: any;
    try {
      uploaded = await this.web.files.uploadV2(
        compactObject({
          channel_id: chatId,
          file: payload.data,
          filename: payload.name,
          thread_ts: replyToMessageId || undefined,
        }),
      );
    } catch (error) {
      throw markProviderRejection(error, isSlackProviderRejection);
    }
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
          failures.push(
            richFallbackDeliveryError(
              error,
              new Error("slack_rich_fallback_empty_result"),
            ),
          );
          return;
        }
        delivered.push(...fallbackIds);
      } catch (fallbackError: any) {
        failures.push(richFallbackDeliveryError(error, fallbackError));
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
