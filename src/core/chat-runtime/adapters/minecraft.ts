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
