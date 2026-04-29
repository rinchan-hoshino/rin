import fs from "node:fs";
import path from "node:path";

import prettyMilliseconds from "pretty-ms";

import type { RpcFrontendClient } from "../rin-tui/frontend-surface.js";
import { ChatFrontendDriver } from "../rin-tui/chat-frontend-driver.js";
import {
  injectPromptContextHeader,
  type PromptContextMeta,
} from "../chat-bridge/prompt-context.js";
import {
  resolveStoredSessionFile,
  toStoredSessionFile,
} from "../session/ref.js";
import { normalizeSessionRef } from "../session/ref.js";
import {
  chatStatePath,
  findBot,
  isPrivateChat,
  parseChatKey,
  readJsonFile,
  writeJsonFile,
} from "./support.js";
import {
  CHAT_WORKING_NOTICE_TEXT,
  ChatState,
  SavedAttachment,
  markProcessedChatMessage,
  safeString,
} from "./chat-helpers.js";
import {
  clearWorkingReaction as clearWorkingReactionTick,
  restorePromptParts,
  rotateWorkingReaction,
  sendOutboxPayload,
  sendTyping,
} from "./transport.js";
import { isTransientChatRuntimeError } from "./runtime-errors.js";

const WORKING_REACTION_FRAME_INTERVAL_MS = 30_000;
const INTERIM_PREFIX = "··· ";

type ChatTurnMeta = {
  incomingMessageId?: string;
  replyToMessageId?: string;
  workingNoticeSent?: boolean;
  startedAt: number;
};

type ChatTextDelivery = {
  type: "text_delivery";
  chatKey: string;
  text: string;
  replyToMessageId?: string;
  sessionFile?: string;
};

function commandNameFromCommandLine(commandLine: string) {
  const trimmed = safeString(commandLine).trim();
  if (!trimmed.startsWith("/")) return "";
  const commandPart = trimmed.slice(1).trim();
  if (!commandPart) return "";
  return safeString(commandPart.split(/\s+/, 1)[0]).trim();
}

function hasWorkingTypingCapability(bot: any) {
  return Boolean(
    typeof bot?.internal?.sendChatAction === "function" ||
    typeof bot?.internal?.sendTyping === "function",
  );
}

function hasWorkingReactionCapability(
  bot: any,
  parsed: { platform: string; chatId: string },
) {
  if (parsed.platform === "onebot" && isPrivateChat(parsed)) return false;
  if (parsed.platform === "qq" && !parsed.chatId.startsWith("channel:")) {
    return false;
  }
  return Boolean(
    typeof bot?.internal?.setMessageReaction === "function" ||
    typeof bot?.createReaction === "function" ||
    typeof bot?.internal?.createReaction === "function",
  );
}

function summarizePromptText(text: string, limit = 80) {
  const value = safeString(text).replace(/\s+/g, " ").trim();
  if (!value) return "";
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

function shouldReleaseStoredSessionOnTransientTurnError(
  error: unknown,
  options: {
    wantedSessionFile?: string;
    restoreSessionFile?: string;
  },
) {
  if (safeString(options.wantedSessionFile).trim()) return false;
  if (!safeString(options.restoreSessionFile).trim()) return false;
  const message = safeString((error as any)?.message || error).trim();
  return /rin_timeout:(?:prompt|get_session_snapshot|select_session)\b|rin_no_attached_session\b/.test(
    message,
  );
}

export class ChatController {
  app: any;
  chatKey: string;
  dataDir: string;
  agentDir: string;
  statePath: string;
  state: ChatState;
  driver: ChatFrontendDriver;
  turnQueue: Promise<void> = Promise.resolve();
  logger: any;
  h: any;
  deliveryEnabled: boolean;
  affectChatBinding: boolean;
  workingReactionEmoji = "";
  workingReactionTick = 0;
  lastWorkingReactionAt = 0;
  currentTurn: ChatTurnMeta | null = null;
  stagedDelivery: ChatTextDelivery | null = null;
  awaitingTurnSettle = false;
  turnAbortRequested = false;

  constructor(
    app: any,
    dataDir: string,
    chatKey: string,
    deps: {
      logger: any;
      h: any;
      deliveryEnabled?: boolean;
      affectChatBinding?: boolean;
      statePath?: string;
      frontendClientFactory?: () => RpcFrontendClient;
    },
  ) {
    this.app = app;
    this.chatKey = chatKey;
    this.dataDir = dataDir;
    this.agentDir = path.resolve(dataDir, "..");
    this.deliveryEnabled = deps.deliveryEnabled !== false;
    this.affectChatBinding = deps.affectChatBinding !== false;
    this.statePath = deps.statePath || chatStatePath(dataDir, chatKey);
    this.state = readJsonFile<ChatState>(this.statePath, { chatKey });
    this.logger = deps.logger;
    this.h = deps.h;
    if (!this.state.chatKey) this.state.chatKey = chatKey;
    this.driver = new ChatFrontendDriver({
      clientFactory: deps.frontendClientFactory,
    });
    this.driver.subscribe((event) => {
      void this.handleFrontendEvent(event).catch(() => {});
    });
  }

  get client() {
    return this.driver.client;
  }

  set client(value) {
    this.driver.client = value;
  }

  get session() {
    return this.driver.session;
  }

  set session(value) {
    this.driver.session = value;
  }

  get frontendPhase() {
    return this.driver.frontendPhase;
  }

  async connect(options: { restoreSession?: boolean } = {}) {
    await this.driver.connect({
      restoreSessionFile:
        options.restoreSession === false
          ? ""
          : this.getRecoverableSessionFile(),
    });
    if (this.driver.currentSessionFile()) {
      this.updateStoredSessionFile(this.driver.currentSessionFile());
      this.saveState();
    }
  }

  dispose() {
    void this.clearWorkingReaction().catch(() => {});
    this.currentTurn = null;
    this.stagedDelivery = null;
    this.awaitingTurnSettle = false;
    this.turnAbortRequested = false;
    this.driver.dispose();
  }

  private saveState() {
    const nextState: ChatState = { chatKey: this.chatKey };
    const storedSessionFile = toStoredSessionFile(
      this.agentDir,
      this.state.sessionFile,
    );
    if (storedSessionFile) nextState.sessionFile = storedSessionFile;
    this.state = nextState;
    writeJsonFile(this.statePath, nextState);
  }

  async clearProcessingState() {
    this.awaitingTurnSettle = false;
    this.turnAbortRequested = false;
    this.stagedDelivery = null;
    await this.clearWorkingReaction().catch(() => {});
    this.currentTurn = null;
    this.saveState();
  }

  private currentIncomingMessageId() {
    return safeString(this.currentTurn?.incomingMessageId || "").trim();
  }

  private currentReplyToMessageId() {
    return safeString(
      this.currentTurn?.replyToMessageId ||
        this.currentTurn?.incomingMessageId ||
        "",
    ).trim();
  }

  claimsInboundMessage(messageId?: string) {
    const nextMessageId = safeString(messageId || "").trim();
    if (!nextMessageId) return false;
    return this.currentIncomingMessageId() === nextMessageId;
  }

  hasActiveTurn() {
    return (
      this.frontendPhase === "sending" ||
      this.frontendPhase === "working" ||
      this.awaitingTurnSettle ||
      Boolean(this.session?.isStreaming)
    );
  }

  canSteerActiveTurn() {
    if (this.turnAbortRequested) return false;
    return Boolean(this.driver.liveTurn || this.session?.isStreaming);
  }

  private setCurrentTurn(input: {
    incomingMessageId?: string;
    replyToMessageId?: string;
  }) {
    const nextIncomingMessageId =
      safeString(input.incomingMessageId || "").trim() || undefined;
    const nextReplyToMessageId =
      safeString(input.replyToMessageId || "").trim() || undefined;
    const previousIncomingMessageId = this.currentIncomingMessageId();
    if (
      previousIncomingMessageId &&
      nextIncomingMessageId &&
      previousIncomingMessageId !== nextIncomingMessageId
    ) {
      void this.clearWorkingReaction().catch(() => {});
    }
    this.currentTurn = {
      startedAt: Date.now(),
      incomingMessageId: nextIncomingMessageId,
      replyToMessageId: nextReplyToMessageId,
      workingNoticeSent: false,
    };
  }

  private clearCurrentTurn() {
    this.currentTurn = null;
  }

  async clearWorkingReaction() {
    const messageId = this.currentIncomingMessageId();
    const emoji = safeString(this.workingReactionEmoji).trim();
    this.workingReactionEmoji = "";
    this.workingReactionTick = 0;
    this.lastWorkingReactionAt = 0;
    if (!messageId || !emoji) return false;
    return await clearWorkingReactionTick(
      this.app,
      this.chatKey,
      messageId,
      emoji,
    );
  }

  private getWorkingIndicatorPolicy() {
    const parsed = parseChatKey(this.chatKey);
    if (!parsed) {
      return { typing: false, reaction: false, notice: false };
    }
    const bot = findBot(this.app, parsed.platform, parsed.botId);
    const typing = hasWorkingTypingCapability(bot);
    const reaction = hasWorkingReactionCapability(bot, parsed);
    return {
      typing,
      reaction,
      notice: !typing && !reaction,
    };
  }

  private shouldRefreshWorkingReaction() {
    return (
      !safeString(this.workingReactionEmoji).trim() ||
      Date.now() - this.lastWorkingReactionAt >=
        WORKING_REACTION_FRAME_INTERVAL_MS
    );
  }

  private async sendWorkingNotice() {
    if (!this.deliveryEnabled) return false;
    const currentTurn = this.currentTurn;
    if (!currentTurn || currentTurn.workingNoticeSent) return false;
    currentTurn.workingNoticeSent = true;
    const replyToMessageId = this.currentReplyToMessageId() || undefined;
    try {
      await sendOutboxPayload(
        this.app,
        this.agentDir,
        {
          type: "text_delivery",
          chatKey: this.chatKey,
          text: CHAT_WORKING_NOTICE_TEXT,
          replyToMessageId,
          sessionFile: this.currentSessionFile(),
          createdAt: new Date().toISOString(),
        },
        this.h,
      );
    } catch (error) {
      if (this.currentTurn === currentTurn) {
        currentTurn.workingNoticeSent = false;
      }
      throw error;
    }
    return true;
  }

  private buildStatusText() {
    const lines = [`Status: ${this.frontendPhase}`, `Chat: ${this.chatKey}`];
    const policy = this.getWorkingIndicatorPolicy();
    const indicators = [
      policy.typing ? "typing" : "",
      policy.reaction ? "reaction" : "",
      policy.notice ? "notice" : "",
    ].filter(Boolean);
    lines.push(`Indicators: ${indicators.join(", ") || "none"}`);

    const sessionFile = this.currentSessionFile();
    if (sessionFile) lines.push(`Session file: ${sessionFile}`);

    const currentTurn = this.currentTurn;
    if (currentTurn?.startedAt) {
      lines.push(
        `Since: ${prettyMilliseconds(
          Math.max(0, Date.now() - currentTurn.startedAt),
          {
            secondsDecimalDigits: 0,
            unitCount: 2,
          },
        )}`,
      );
    }
    const replyToMessageId = this.currentReplyToMessageId();
    if (replyToMessageId) lines.push(`Reply target: ${replyToMessageId}`);
    const promptPreview = summarizePromptText(
      this.driver.latestAssistantText || "",
    );
    if (promptPreview) lines.push(`Latest: ${promptPreview}`);
    return lines.join("\n");
  }

  private async runLocalStatusCommand(
    replyToMessageId = "",
    incomingMessageId = "",
  ) {
    const text = this.buildStatusText();
    this.markProcessedMessage(incomingMessageId);
    if (!this.deliveryEnabled) return { handled: true, text, local: true };
    await sendOutboxPayload(
      this.app,
      this.agentDir,
      {
        type: "text_delivery",
        chatKey: this.chatKey,
        text,
        replyToMessageId: safeString(replyToMessageId).trim() || undefined,
        sessionFile: this.currentSessionFile(),
        createdAt: new Date().toISOString(),
      },
      this.h,
    );
    return { handled: true, text, local: true };
  }

  async pollTyping() {
    if (!this.deliveryEnabled) return false;
    if (!this.hasActiveTurn()) {
      await this.clearWorkingReaction().catch(() => {});
      return false;
    }
    const policy = this.getWorkingIndicatorPolicy();
    let sent = false;
    if (policy.typing) {
      sent = (await sendTyping(this.app, this.chatKey, this.h)) || sent;
    }
    const messageId = this.currentIncomingMessageId();
    if (policy.reaction && messageId && this.shouldRefreshWorkingReaction()) {
      const previousEmoji = this.workingReactionEmoji;
      const nextEmoji = await rotateWorkingReaction(
        this.app,
        this.chatKey,
        messageId,
        this.workingReactionTick,
        previousEmoji,
      );
      if (nextEmoji) {
        sent = true;
        this.workingReactionEmoji = nextEmoji;
        this.lastWorkingReactionAt = Date.now();
        if (nextEmoji !== previousEmoji) {
          this.workingReactionTick += 1;
        }
      }
    }
    if (policy.notice) {
      sent = (await this.sendWorkingNotice().catch(() => false)) || sent;
    }
    return sent;
  }

  private async runExclusiveTurn<T>(run: () => Promise<T>) {
    const previous = this.turnQueue;
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.turnQueue = previous.then(() => slot);
    await previous;
    try {
      return await run();
    } finally {
      release();
    }
  }

  currentSessionId() {
    return this.driver.currentSessionId();
  }

  private currentSessionFile() {
    const live = this.driver.currentSessionFile();
    if (live) return live;
    return resolveStoredSessionFile(this.agentDir, this.state.sessionFile);
  }

  private pickStoredValue(...candidates: unknown[]) {
    for (const candidate of candidates) {
      const value = safeString(candidate).trim();
      if (value) return value;
    }
    return undefined;
  }

  private updateStoredSessionFile(...candidates: unknown[]) {
    const picked = this.pickStoredValue(...candidates, this.state.sessionFile);
    this.state.sessionFile = toStoredSessionFile(this.agentDir, picked);
    return this.state.sessionFile;
  }

  private getRecoverableSessionFile() {
    const wanted = resolveStoredSessionFile(
      this.agentDir,
      this.state.sessionFile,
    );
    if (!wanted) return "";
    if (fs.existsSync(wanted)) return wanted;
    delete this.state.sessionFile;
    this.saveState();
    return "";
  }

  private markAcceptedMessage(messageId?: string) {
    const nextMessageId = safeString(messageId || "").trim();
    if (!nextMessageId) return;
    const acceptedAt = new Date().toISOString();
    const sessionFile = this.currentSessionFile();
    if (!sessionFile) return;
    markProcessedChatMessage(this.agentDir, this.chatKey, nextMessageId, {
      sessionFile,
      acceptedAt,
    });
  }

  private markProcessedMessage(messageId?: string) {
    const nextMessageId = safeString(messageId || "").trim();
    if (!nextMessageId) return;
    markProcessedChatMessage(this.agentDir, this.chatKey, nextMessageId, {
      sessionFile: this.currentSessionFile(),
      acceptedAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
    });
  }

  private buildAssistantDelivery(input: {
    text?: string;
    replyToMessageId?: string;
    sessionFile?: string;
  }): ChatTextDelivery {
    const text = safeString(
      input.text ?? this.driver.latestAssistantText,
    ).trim();
    if (!text) throw new Error("chat_final_assistant_text_missing");
    return {
      type: "text_delivery",
      chatKey: this.chatKey,
      text,
      replyToMessageId:
        safeString(input.replyToMessageId || "").trim() || undefined,
      sessionFile: toStoredSessionFile(
        this.agentDir,
        input.sessionFile || this.currentSessionFile(),
      ),
    };
  }

  private stageAssistantDelivery(input: {
    text?: string;
    replyToMessageId?: string;
    sessionFile?: string;
  }) {
    const text = safeString(
      input.text ?? this.driver.latestAssistantText,
    ).trim();
    if (!text) throw new Error("chat_final_assistant_text_missing");
    this.stagedDelivery = this.buildAssistantDelivery(input);
    return text;
  }

  private async commitPendingDelivery(clearProcessing = false) {
    const pending = this.stagedDelivery;
    if (!pending) return;
    if (!this.deliveryEnabled) {
      this.stagedDelivery = null;
      if (clearProcessing) {
        await this.clearWorkingReaction().catch(() => {});
        this.currentTurn = null;
      }
      return;
    }
    await sendOutboxPayload(
      this.app,
      this.agentDir,
      {
        ...pending,
        createdAt: new Date().toISOString(),
      },
      this.h,
    );
    this.stagedDelivery = null;
    if (clearProcessing) {
      await this.clearWorkingReaction().catch(() => {});
      this.currentTurn = null;
    }
  }

  private async deliverAssistantReply(input: {
    text?: string;
    replyToMessageId?: string;
    incomingMessageId?: string;
    sessionFile?: string;
    clearProcessing?: boolean;
  }) {
    const text = this.stageAssistantDelivery(input);
    this.markProcessedMessage(input.incomingMessageId);
    await this.commitPendingDelivery(input.clearProcessing);
    return text;
  }

  private async deliverAssistantInterim(text: string) {
    const trimmed = safeString(text).trim();
    if (!trimmed) return false;
    if (!this.deliveryEnabled) return true;
    const incomingMessageId = this.currentIncomingMessageId();
    const replyToMessageId = this.currentReplyToMessageId();
    try {
      await sendOutboxPayload(
        this.app,
        this.agentDir,
        {
          type: "text_delivery",
          createdAt: new Date().toISOString(),
          chatKey: this.chatKey,
          text: `${INTERIM_PREFIX}${trimmed}`,
          replyToMessageId: replyToMessageId || undefined,
          sessionFile: this.currentSessionFile(),
        },
        this.h,
      );
      this.markProcessedMessage(incomingMessageId);
      return true;
    } catch {
      return false;
    }
  }

  async resumeSessionFile(sessionFile: string) {
    const wanted = safeString(sessionFile).trim();
    if (!wanted) {
      return {
        changed: false,
        sessionId: this.currentSessionId() || undefined,
      };
    }
    if (!fs.existsSync(wanted)) {
      delete this.state.sessionFile;
      this.saveState();
      return {
        changed: false,
        sessionId: this.currentSessionId() || undefined,
      };
    }
    const result = await this.driver.resumeSessionFile(wanted);
    this.updateStoredSessionFile(result?.sessionFile, wanted);
    this.saveState();
    return result;
  }

  startLiveTurn() {
    this.awaitingTurnSettle = true;
    let resolve!: (value: any) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<any>((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });
    return {
      promise,
      resolve: (value: any) => {
        this.awaitingTurnSettle = false;
        resolve(value);
      },
      reject: (error: Error) => {
        this.awaitingTurnSettle = false;
        reject(error);
      },
    };
  }

  async runCommand(
    commandLine: string,
    replyToMessageId = "",
    incomingMessageId = "",
    sessionFile = "",
  ) {
    const commandName = commandNameFromCommandLine(commandLine);
    const abortingActiveTurn = commandName === "abort" && this.hasActiveTurn();
    if (abortingActiveTurn) {
      this.turnAbortRequested = true;
      const data = this.driver.interruptActiveTurnLikeTui();
      this.updateStoredSessionFile(
        data?.sessionFile,
        this.driver.currentSessionFile(),
      );
      this.saveState();
      await this.deliverAssistantReply({
        text: "Aborted current operation.",
        replyToMessageId: replyToMessageId || undefined,
        incomingMessageId,
        sessionFile: data?.sessionFile,
        clearProcessing: false,
      });
      return {
        handled: true,
        text: "Aborted current operation.",
        sessionId: data?.sessionId,
        sessionFile: this.currentSessionFile() || data?.sessionFile,
      };
    }
    if (commandName === "status") {
      return await this.runLocalStatusCommand(
        replyToMessageId,
        incomingMessageId,
      );
    }
    const skipSessionRecovery = commandName === "new";
    await this.connect({ restoreSession: !skipSessionRecovery });
    this.setCurrentTurn({
      incomingMessageId: incomingMessageId || undefined,
      replyToMessageId: replyToMessageId || undefined,
    });
    try {
      const data: any = await this.driver.runCommand(commandLine, {
        skipSessionRecovery,
        restoreSessionFile: skipSessionRecovery
          ? ""
          : this.getRecoverableSessionFile(),
        sessionFile,
      });
      this.updateStoredSessionFile(
        data?.sessionFile,
        this.driver.currentSessionFile(),
      );
      this.saveState();
      const text = safeString(data?.text || "").trim();
      if (!text) throw new Error("chat_command_text_missing");
      await this.deliverAssistantReply({
        text,
        replyToMessageId: replyToMessageId || undefined,
        incomingMessageId,
        sessionFile: data?.sessionFile,
        clearProcessing: true,
      });
      return data;
    } catch (error: any) {
      if (!isTransientChatRuntimeError(error)) {
        const errorMessage =
          safeString(error?.message || error).trim() || "chat_command_failed";
        await this.deliverAssistantReply({
          text: errorMessage,
          replyToMessageId: replyToMessageId || undefined,
          incomingMessageId,
          clearProcessing: true,
        });
      }
      throw error;
    } finally {
      this.awaitingTurnSettle = false;
      await this.clearWorkingReaction().catch(() => {});
      this.clearCurrentTurn();
      this.stagedDelivery = null;
      this.saveState();
    }
  }

  async runTurn(
    input: {
      text: string;
      attachments: SavedAttachment[];
      replyToMessageId?: string;
      incomingMessageId?: string;
      sessionFile?: string;
      promptMeta?: PromptContextMeta;
      model?: string;
      thinkingLevel?: string;
    },
    mode: "prompt" | "steer" = "prompt",
  ) {
    if (mode === "steer" && this.canSteerActiveTurn()) {
      const { sessionFile: wantedSessionFile } = normalizeSessionRef(input);
      const restoreSessionFile =
        wantedSessionFile || this.getRecoverableSessionFile();
      await this.connect();
      const { text, images } = await restorePromptParts({
        text: input.text,
        attachments: input.attachments,
        startedAt: Date.now(),
      });
      const promptText = injectPromptContextHeader(input.promptMeta, text);
      const result = await this.driver.runTurn({
        text: promptText,
        images,
        sessionFile: wantedSessionFile,
        restoreSessionFile,
        model: input.model,
        thinkingLevel: input.thinkingLevel,
      });
      this.updateStoredSessionFile(
        result.sessionFile,
        this.driver.currentSessionFile(),
      );
      this.saveState();
      if (result.steered) {
        this.markAcceptedMessage(input.incomingMessageId);
        return {
          steered: true,
          sessionId: this.currentSessionId() || undefined,
          sessionFile: this.currentSessionFile(),
        };
      }
      await this.deliverAssistantReply({
        text: result.finalText,
        replyToMessageId: input.replyToMessageId,
        sessionFile: result.sessionFile,
        incomingMessageId: input.incomingMessageId,
      });
      return {
        finalText: result.finalText,
        result: result.result,
        sessionId: this.currentSessionId() || undefined,
        sessionFile: this.currentSessionFile(),
      };
    }

    return await this.runExclusiveTurn(async () => {
      const { sessionFile: wantedSessionFile } = normalizeSessionRef(input);
      const restoreSessionFile =
        wantedSessionFile || this.getRecoverableSessionFile();
      await this.connect();
      const { text, images } = await restorePromptParts({
        text: input.text,
        attachments: input.attachments,
        startedAt: Date.now(),
      });
      this.setCurrentTurn({
        incomingMessageId: input.incomingMessageId,
        replyToMessageId: input.replyToMessageId,
      });
      this.awaitingTurnSettle = true;
      void this.pollTyping().catch(() => {});
      try {
        const promptText = injectPromptContextHeader(input.promptMeta, text);
        const result = await this.driver.runTurn({
          text: promptText,
          images,
          sessionFile: wantedSessionFile,
          restoreSessionFile,
          model: input.model,
          thinkingLevel: input.thinkingLevel,
        });
        this.updateStoredSessionFile(
          result.sessionFile,
          this.driver.currentSessionFile(),
        );
        this.saveState();
        if (result.steered) {
          this.markAcceptedMessage(input.incomingMessageId);
          return {
            steered: true,
            sessionId: this.currentSessionId() || undefined,
            sessionFile: this.currentSessionFile(),
          };
        }
        await this.deliverAssistantReply({
          text: result.finalText,
          replyToMessageId: input.replyToMessageId,
          sessionFile: result.sessionFile,
          incomingMessageId: input.incomingMessageId,
          clearProcessing: true,
        });
        this.clearCurrentTurn();
        return {
          finalText: result.finalText,
          result: result.result,
          sessionId: this.currentSessionId() || undefined,
          sessionFile: this.currentSessionFile(),
        };
      } catch (error) {
        const errorMessage = safeString(
          (error as any)?.message || error,
        ).trim();
        if (errorMessage === "chat_turn_aborted") {
          this.markProcessedMessage(input.incomingMessageId);
          await this.clearWorkingReaction().catch(() => {});
          this.clearCurrentTurn();
          this.stagedDelivery = null;
          this.saveState();
          return {
            aborted: true,
            sessionId: this.currentSessionId() || undefined,
            sessionFile: this.currentSessionFile(),
          };
        }
        if (
          shouldReleaseStoredSessionOnTransientTurnError(error, {
            wantedSessionFile,
            restoreSessionFile,
          })
        ) {
          delete this.state.sessionFile;
          this.driver.dispose();
        }
        await this.clearWorkingReaction().catch(() => {});
        this.clearCurrentTurn();
        this.stagedDelivery = null;
        this.saveState();
        throw error;
      } finally {
        this.awaitingTurnSettle = false;
        this.turnAbortRequested = false;
      }
    });
  }

  async housekeep() {
    await this.pollTyping().catch(() => {});
  }

  async recoverIfNeeded() {
    return;
  }

  async handleClientEvent(event: any) {
    await this.driver.handleClientEvent(event);
  }

  async handleSessionEvent(event: any) {
    await this.driver.handleClientEvent(event);
  }

  private async handleFrontendEvent(event: any) {
    if (!event || typeof event !== "object") return;
    switch (event.type) {
      case "frontend_status":
        if (event.phase === "sending" || event.phase === "working") {
          this.markAcceptedMessage(this.currentIncomingMessageId());
        }
        if (
          event.phase === "idle" &&
          !this.awaitingTurnSettle &&
          !this.stagedDelivery
        ) {
          await this.clearWorkingReaction().catch(() => {});
          this.clearCurrentTurn();
        }
        return;
      case "turn_accepted":
        this.markAcceptedMessage(this.currentIncomingMessageId());
        return;
      case "assistant_interim":
        await this.deliverAssistantInterim(event.text);
        return;
    }
  }
}

export function loadChatSettings(settingsPath: string) {
  const settings: any = readJsonFile(settingsPath, {}) || {};
  if (settings.enableSkillCommands == null) settings.enableSkillCommands = true;
  return settings;
}
