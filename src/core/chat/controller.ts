import path from "node:path";

import prettyMilliseconds from "pretty-ms";

import {
  RinDaemonFrontendClient,
  RinFrontendTurnDriver,
  applyFrontendBuiltinCommandText,
  frontendCommandNameFromLine,
  getRinNonInteractiveCommandInteractionPolicy,
  type RinFrontendTurnClient,
} from "../rin-frontend-sdk/index.js";
import {
  injectPromptContextHeader,
  type PromptContextMeta,
} from "../chat-bridge/prompt-context.js";
import { MANAGED_CHAT_SESSION_LEAF } from "../session/managed-paths.js";
import { nowIso } from "../time-utils.js";
import {
  readChatCommandResponses,
  resolveChatCommandResponses,
  type ChatCommandResponses,
} from "./command-responses.js";
import {
  missingSessionFileError,
  normalizeSessionRef,
  resolveStoredSessionFile,
  sessionFileExists,
  toStoredSessionFile,
} from "../session/ref.js";
import {
  chatStatePath,
  findBot,
  parseChatKey,
  readJsonFile,
  writeJsonFile,
} from "./support.js";
import {
  CHAT_INTERIM_REPLY_PREFIX,
  ChatState,
  SavedAttachment,
  markProcessedChatMessage,
  safeString,
} from "./chat-helpers.js";
import { listChatMessages } from "./message-store.js";
import { restorePromptParts, sendOutboxPayload } from "./transport.js";
import {
  formatChatRuntimeErrorForUser,
  isTransientChatRuntimeError,
} from "./runtime-errors.js";

const INTERIM_PREFIX = CHAT_INTERIM_REPLY_PREFIX;
const WORKING_REACTION_INTERVAL_MS = 30_000;

type ChatTurnMeta = {
  incomingMessageId?: string;
  replyToMessageId?: string;
  workingNoticeSent?: boolean;
  startedAt: number;
};

type ChatTextDelivery = {
  type: "text_delivery";
  chatKey: string;
  deliveryKind?: "final" | "interim" | "passive_notice";
  text: string;
  replyToMessageId?: string;
  sessionFile?: string;
  sessionBinding?: "conversation";
};

function formatPromptForChatContext(
  text: string,
  promptMeta?: PromptContextMeta,
) {
  return injectPromptContextHeader(promptMeta, text);
}

type WorkingIndicatorKind = "polling" | "marker";

type WorkingIndicator = {
  type?: string;
  kind?: string;
  name?: string;
  tick?: (context: Record<string, any>) => Promise<unknown> | unknown;
  end?: (context: Record<string, any>) => Promise<unknown> | unknown;
  start?: (context: Record<string, any>) => Promise<unknown> | unknown;
  onTick?: (context: Record<string, any>) => Promise<unknown> | unknown;
  onEnd?: (context: Record<string, any>) => Promise<unknown> | unknown;
  onStart?: (context: Record<string, any>) => Promise<unknown> | unknown;
};

function workingIndicatorKind(indicator: WorkingIndicator) {
  const kind = safeString(indicator?.type || indicator?.kind).trim();
  return kind === "polling" || kind === "marker" ? kind : "";
}

function normalizeWorkingIndicators(value: unknown): WorkingIndicator[] {
  const raw = Array.isArray(value) ? value : [];
  return raw.filter(
    (indicator): indicator is WorkingIndicator =>
      indicator &&
      typeof indicator === "object" &&
      Boolean(workingIndicatorKind(indicator as WorkingIndicator)),
  );
}

function summarizePromptText(text: string, limit = 80) {
  const value = safeString(text).replace(/\s+/g, " ").trim();
  if (!value) return "";
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

function shouldResetDriverOnTransientTurnError(
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

function resolveComparableSessionFile(agentDir: string, sessionFile: unknown) {
  const value = safeString(sessionFile).trim();
  if (!value) return "";
  return resolveStoredSessionFile(agentDir, value) || value;
}

function sameSessionFile(agentDir: string, left: unknown, right: unknown) {
  const resolvedLeft = resolveComparableSessionFile(agentDir, left);
  const resolvedRight = resolveComparableSessionFile(agentDir, right);
  return Boolean(
    resolvedLeft && resolvedRight && resolvedLeft === resolvedRight,
  );
}

export class ChatController {
  app: any;
  chatKey: string;
  dataDir: string;
  agentDir: string;
  statePath: string;
  state: ChatState;
  driver: RinFrontendTurnDriver;
  frontendClientFactory?: () => RinFrontendTurnClient;
  turnQueue: Promise<void> = Promise.resolve();
  logger: any;
  h: any;
  deliveryEnabled: boolean;
  affectChatBinding: boolean;
  workingReactionEmoji = "";
  workingReactionTick = 0;
  lastWorkingReactionAt = 0;
  activeWorkingIndicators: WorkingIndicator[] = [];
  workingIndicatorTick = 0;
  currentTurn: ChatTurnMeta | null = null;
  activeCommandTurnInput: {
    incomingMessageId?: string;
    replyToMessageId?: string;
  } | null = null;
  backendAcceptedIncomingMessageId = "";
  stagedDelivery: ChatTextDelivery | null = null;
  awaitingTurnSettle = false;
  turnAbortRequested = false;
  sleepAfterIdleMs = 0;
  lastActivityAt = Date.now();
  commandResponses?: ChatCommandResponses;

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
      frontendClientFactory?: () => RinFrontendTurnClient;
      sleepAfterIdleMs?: number;
      commandResponses?: Partial<ChatCommandResponses>;
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
    this.sleepAfterIdleMs = Math.max(0, Number(deps.sleepAfterIdleMs || 0));
    this.frontendClientFactory = deps.frontendClientFactory;
    this.commandResponses = deps.commandResponses
      ? resolveChatCommandResponses(deps.commandResponses)
      : undefined;
    if (!this.state.chatKey) this.state.chatKey = chatKey;
    this.driver = new RinFrontendTurnDriver({
      clientFactory:
        deps.frontendClientFactory || (() => new RinDaemonFrontendClient()),
      promptSource: "chat-bridge",
      commandResponses: this.getCommandResponses(),
      selfImproveNoticeSessionFiles: () =>
        this.selfImproveNoticeSessionFilesForChat(),
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

  get frontendPhase() {
    return this.driver.frontendPhase;
  }

  async connect(options: { restoreSession?: boolean } = {}) {
    const restoreSessionFile =
      options.restoreSession === false ? "" : this.getRecoverableSessionFile();
    await this.driver.connect({ restoreSessionFile });
    if (this.affectChatBinding && restoreSessionFile) {
      this.updateStoredSessionFile(
        this.driver.currentSessionFile(),
        restoreSessionFile,
      );
      this.saveState();
    }
  }

  dispose() {
    this.lastActivityAt = Date.now();
    void this.clearWorkingReaction().catch(() => {});
    this.currentTurn = null;
    this.activeCommandTurnInput = null;
    this.backendAcceptedIncomingMessageId = "";
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
    if (this.state.chatType === "private" || this.state.chatType === "group") {
      nextState.chatType = this.state.chatType;
    }
    this.state = nextState;
    writeJsonFile(this.statePath, nextState);
  }

  async clearProcessingState() {
    this.awaitingTurnSettle = false;
    this.turnAbortRequested = false;
    this.stagedDelivery = null;
    await this.clearWorkingReaction().catch(() => {});
    this.currentTurn = null;
    this.activeCommandTurnInput = null;
    this.backendAcceptedIncomingMessageId = "";
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

  hasBackendAcceptedInboundMessage(messageId?: string) {
    const nextMessageId = safeString(messageId || "").trim();
    if (!nextMessageId) return false;
    return this.backendAcceptedIncomingMessageId === nextMessageId;
  }

  hasActiveTurn() {
    return (
      this.frontendPhase === "sending" ||
      this.frontendPhase === "working" ||
      this.awaitingTurnSettle ||
      this.driver.hasActiveTurn()
    );
  }

  canSteerActiveTurn() {
    if (this.turnAbortRequested) return false;
    return this.driver.canSteerActiveTurn();
  }

  private setCurrentTurn(input: {
    incomingMessageId?: string;
    replyToMessageId?: string;
  }) {
    const nextIncomingMessageId =
      safeString(input.incomingMessageId || "").trim() || undefined;
    const nextReplyToMessageId =
      safeString(input.replyToMessageId || "").trim() || undefined;
    this.currentTurn = {
      startedAt: Date.now(),
      incomingMessageId: nextIncomingMessageId,
      replyToMessageId: nextReplyToMessageId,
      workingNoticeSent: false,
    };
    this.backendAcceptedIncomingMessageId = "";
  }

  private currentTurnMatches(messageId?: string) {
    const current = this.currentIncomingMessageId();
    const target = safeString(messageId || "").trim();
    return !current || !target || current === target;
  }

  private clearCurrentTurnFor(messageId?: string) {
    if (!this.currentTurnMatches(messageId)) return;
    this.clearCurrentTurn();
  }

  private async clearWorkingReactionFor(messageId?: string) {
    if (!this.currentTurnMatches(messageId)) return false;
    return await this.clearWorkingReaction().catch(() => false);
  }

  private clearCurrentTurn() {
    this.currentTurn = null;
    this.backendAcceptedIncomingMessageId = "";
  }

  private setActiveCommandTurnInput(input: {
    incomingMessageId?: string;
    replyToMessageId?: string;
  }) {
    this.activeCommandTurnInput = {
      incomingMessageId:
        safeString(input.incomingMessageId || "").trim() || undefined,
      replyToMessageId:
        safeString(input.replyToMessageId || "").trim() || undefined,
    };
  }

  private clearActiveCommandTurnInput() {
    this.activeCommandTurnInput = null;
  }

  private ensureVisibleCommandTurn() {
    if (this.currentTurn || !this.activeCommandTurnInput) return false;
    this.setCurrentTurn(this.activeCommandTurnInput);
    this.awaitingTurnSettle = true;
    return true;
  }

  private workingIndicatorContext(extra: Record<string, any> = {}) {
    const parsed = parseChatKey(this.chatKey);
    return {
      chatKey: this.chatKey,
      platform: parsed?.platform || "",
      botId: parsed?.botId || "",
      chatId: parsed?.chatId || "",
      messageId: this.currentIncomingMessageId() || undefined,
      replyToMessageId: this.currentReplyToMessageId() || undefined,
      tick: this.workingIndicatorTick,
      ...extra,
    };
  }

  private getWorkingIndicators() {
    const parsed = parseChatKey(this.chatKey);
    if (!parsed) return [];
    const bot = findBot(this.app, parsed.platform, parsed.botId);
    const context = this.workingIndicatorContext({
      platform: parsed.platform,
      botId: parsed.botId,
      chatId: parsed.chatId,
    });
    const value =
      typeof bot?.getWorkingIndicators === "function"
        ? bot.getWorkingIndicators(context)
        : bot?.workingIndicators;
    return normalizeWorkingIndicators(value);
  }

  private callWorkingIndicator(
    indicator: WorkingIndicator,
    eventName: "start" | "tick" | "end",
    context: Record<string, any>,
  ) {
    const handler =
      eventName === "start"
        ? indicator.start || indicator.onStart
        : eventName === "tick"
          ? indicator.tick || indicator.onTick
          : indicator.end || indicator.onEnd;
    if (typeof handler !== "function") return Promise.resolve(false);
    return Promise.resolve(handler.call(indicator, context));
  }

  async clearWorkingReaction() {
    const indicators = this.activeWorkingIndicators.length
      ? this.activeWorkingIndicators
      : this.getWorkingIndicators();
    this.activeWorkingIndicators = [];
    this.workingReactionEmoji = "";
    this.workingReactionTick = 0;
    this.lastWorkingReactionAt = 0;
    this.workingIndicatorTick = 0;
    const context = this.workingIndicatorContext({ event: "end" });
    const results = await Promise.all(
      indicators.map((indicator) =>
        this.callWorkingIndicator(indicator, "end", context).catch(() => false),
      ),
    );
    return results.some(Boolean);
  }

  private getWorkingIndicatorPolicy() {
    const indicators = this.getWorkingIndicators();
    return {
      polling: indicators.some(
        (indicator) => workingIndicatorKind(indicator) === "polling",
      ),
      marker: indicators.some(
        (indicator) => workingIndicatorKind(indicator) === "marker",
      ),
    };
  }

  private async startWorkingMarker() {
    if (!this.deliveryEnabled) return false;
    const indicators = this.getWorkingIndicators();
    this.activeWorkingIndicators = indicators;
    const context = this.workingIndicatorContext({ event: "start" });
    const results = await Promise.all(
      indicators
        .filter((indicator) => workingIndicatorKind(indicator) === "marker")
        .map((indicator) =>
          this.callWorkingIndicator(indicator, "start", context).catch(
            () => false,
          ),
        ),
    );
    return results.some(Boolean);
  }

  private async beginVisibleProcessingTurn(input: {
    incomingMessageId?: string;
    replyToMessageId?: string;
  }) {
    const previousIncomingMessageId = this.currentIncomingMessageId();
    const nextIncomingMessageId = safeString(
      input.incomingMessageId || "",
    ).trim();
    if (
      previousIncomingMessageId &&
      nextIncomingMessageId &&
      previousIncomingMessageId !== nextIncomingMessageId
    ) {
      await this.clearWorkingReaction().catch(() => {});
    }
    this.setCurrentTurn(input);
    this.awaitingTurnSettle = true;
    const marker = this.startWorkingMarker().catch(() => false);
    const poll = this.pollTyping().catch(() => false);
    await Promise.race([
      Promise.all([marker, poll]),
      new Promise((resolve) => setImmediate(resolve)),
    ]);
  }

  private buildStatusText() {
    const lines = [`Status: ${this.frontendPhase}`, `Chat: ${this.chatKey}`];
    const policy = this.getWorkingIndicatorPolicy();
    const indicators = [
      policy.polling ? "polling" : "",
      policy.marker ? "marker" : "",
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
    this.markProcessedMessage(incomingMessageId, false);
    if (!this.deliveryEnabled) return { handled: true, text, local: true };
    await sendOutboxPayload(
      this.app,
      this.agentDir,
      {
        type: "text_delivery",
        chatKey: this.chatKey,
        text,
        replyToMessageId: safeString(replyToMessageId).trim() || undefined,
        createdAt: nowIso(),
      },
      this.h,
    );
    return { handled: true, text, local: true };
  }

  async pollTyping() {
    if (!this.deliveryEnabled) return false;
    if (!this.driver.hasWorkerActiveTurn()) {
      await this.clearWorkingReaction().catch(() => {});
      return false;
    }
    const indicators = this.activeWorkingIndicators.length
      ? this.activeWorkingIndicators
      : this.getWorkingIndicators();
    this.activeWorkingIndicators = indicators;
    const now = Date.now();
    const messageId = this.currentIncomingMessageId();
    const reactionDue =
      Boolean(messageId) &&
      (this.lastWorkingReactionAt <= 0 ||
        now - this.lastWorkingReactionAt >= WORKING_REACTION_INTERVAL_MS);
    const context = this.workingIndicatorContext({
      event: "tick",
      tick: this.workingIndicatorTick,
      reactionDue,
      reactionTick: this.workingReactionTick,
      reactionIntervalMs: WORKING_REACTION_INTERVAL_MS,
    });
    const results = await Promise.all(
      indicators
        .filter((indicator) => workingIndicatorKind(indicator) === "polling")
        .map((indicator) =>
          this.callWorkingIndicator(indicator, "tick", context).catch(
            () => false,
          ),
        ),
    );
    this.workingIndicatorTick += 1;
    if (reactionDue) {
      this.lastWorkingReactionAt = now;
      this.workingReactionTick += 1;
    }
    return results.some(Boolean);
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

  private getCommandResponses() {
    return this.commandResponses || readChatCommandResponses(this.agentDir);
  }

  private localizeBuiltinCommandResult(commandName: string, data: any) {
    return applyFrontendBuiltinCommandText(
      commandName,
      data,
      this.getCommandResponses(),
      { preferConfiguredText: true },
    );
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

  private assertRestoredTurnStayedOnSession(
    restoreSessionFile: string,
    resultSessionFile: unknown,
  ) {
    if (!restoreSessionFile) return;
    if (sameSessionFile(this.agentDir, restoreSessionFile, resultSessionFile)) {
      return;
    }
    throw new Error("chat_restored_session_mismatch");
  }

  private resolveSessionFileForUse(sessionFile?: string) {
    return (
      resolveStoredSessionFile(this.agentDir, sessionFile) ||
      safeString(sessionFile).trim()
    );
  }

  private getRecoverableSessionFile() {
    const wanted = this.resolveSessionFileForUse(this.state.sessionFile);
    if (!wanted) return "";
    if (sessionFileExists(wanted)) return wanted;
    this.state.sessionFile = undefined;
    this.saveState();
    return "";
  }

  private managedSessionLeafForFreshChat() {
    return this.currentSessionFile() ? undefined : MANAGED_CHAT_SESSION_LEAF;
  }

  private selfImproveNoticeSessionFilesForChat() {
    if (this.chatTypeForNoticeScope() === "private") return undefined;
    const files = new Set<string>();
    for (const candidate of [this.state.sessionFile]) {
      const resolved = this.resolveSessionFileForUse(candidate);
      if (resolved) files.add(resolved);
    }
    for (const item of listChatMessages(this.agentDir)) {
      if (item.chatKey !== this.chatKey) continue;
      const resolved = this.resolveSessionFileForUse(item.sessionFile);
      if (resolved) files.add(resolved);
    }
    return [...files];
  }

  private chatTypeForNoticeScope() {
    if (this.state.chatType === "private" || this.state.chatType === "group") {
      return this.state.chatType;
    }
    const stored = listChatMessages(this.agentDir)
      .filter((item) => item.chatKey === this.chatKey)
      .sort((left, right) =>
        safeString(right.receivedAt).localeCompare(safeString(left.receivedAt)),
      )
      .find((item) => item.chatType === "private" || item.chatType === "group");
    return stored?.chatType || "group";
  }

  private rememberPromptChatType(promptMeta?: PromptContextMeta) {
    const chatType = safeString((promptMeta as any)?.chatType).trim();
    if (chatType === "private" || chatType === "group") {
      this.state.chatType = chatType;
    }
  }

  private markAcceptedMessage(messageId?: string) {
    if (!this.affectChatBinding) return;
    const nextMessageId = safeString(messageId || "").trim();
    if (!nextMessageId) return;
    const acceptedAt = nowIso();
    const sessionFile = this.currentSessionFile();
    if (!sessionFile) return;
    const storedSessionFile = this.updateStoredSessionFile(sessionFile);
    this.saveState();
    markProcessedChatMessage(this.agentDir, this.chatKey, nextMessageId, {
      sessionFile: storedSessionFile || sessionFile,
      acceptedAt,
    });
  }

  private markProcessedMessage(messageId?: string, bindSession = true) {
    const nextMessageId = safeString(messageId || "").trim();
    if (!nextMessageId) return;
    markProcessedChatMessage(this.agentDir, this.chatKey, nextMessageId, {
      ...(bindSession ? { sessionFile: this.currentSessionFile() } : {}),
      acceptedAt: nowIso(),
      processedAt: nowIso(),
    });
  }

  private buildAssistantDelivery(input: {
    text?: string;
    replyToMessageId?: string;
    sessionFile?: string;
    bindSession?: boolean;
  }): ChatTextDelivery {
    const text = safeString(
      input.text ?? this.driver.latestAssistantText,
    ).trim();
    if (!text) throw new Error("chat_final_assistant_text_missing");
    return {
      type: "text_delivery",
      chatKey: this.chatKey,
      deliveryKind: "final",
      text,
      replyToMessageId:
        safeString(input.replyToMessageId || "").trim() || undefined,
      ...(input.bindSession === false
        ? {}
        : {
            sessionFile: toStoredSessionFile(
              this.agentDir,
              input.sessionFile || this.currentSessionFile(),
            ),
            sessionBinding: "conversation" as const,
          }),
    };
  }

  private stageAssistantDelivery(input: {
    text?: string;
    replyToMessageId?: string;
    sessionFile?: string;
    bindSession?: boolean;
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
        createdAt: nowIso(),
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
    bindSession?: boolean;
  }) {
    const bindSession = input.bindSession !== false && this.affectChatBinding;
    const text = this.stageAssistantDelivery({ ...input, bindSession });
    await this.commitPendingDelivery(input.clearProcessing);
    this.markProcessedMessage(input.incomingMessageId, bindSession);
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
          createdAt: nowIso(),
          chatKey: this.chatKey,
          deliveryKind: "interim",
          text: `${INTERIM_PREFIX}${trimmed}`,
          replyToMessageId: replyToMessageId || undefined,
          ...(this.affectChatBinding
            ? {
                sessionFile: this.currentSessionFile(),
                sessionBinding: "conversation" as const,
              }
            : {}),
        },
        this.h,
      );
      this.markAcceptedMessage(incomingMessageId);
      return true;
    } catch {
      return false;
    }
  }

  private async deliverPassiveNotice(text: string) {
    const trimmed = safeString(text).trim();
    if (!trimmed) return false;
    if (!this.deliveryEnabled) return true;
    try {
      await sendOutboxPayload(
        this.app,
        this.agentDir,
        {
          type: "text_delivery",
          createdAt: nowIso(),
          chatKey: this.chatKey,
          deliveryKind: "passive_notice",
          text: trimmed,
        },
        this.h,
      );
      return true;
    } catch {
      return false;
    }
  }

  private async deliverCompactionStartNotice(text: string) {
    const trimmed = safeString(text).trim();
    if (!trimmed) return false;
    if (!this.deliveryEnabled) return true;
    try {
      const messageIds = await sendOutboxPayload(
        this.app,
        this.agentDir,
        {
          type: "text_delivery",
          createdAt: nowIso(),
          chatKey: this.chatKey,
          deliveryKind: "passive_notice",
          text: trimmed,
        },
        this.h,
      );
      const messageId = safeString(messageIds?.[0]).trim();
      if (messageId) {
        this.setCurrentTurn({
          incomingMessageId: messageId,
          replyToMessageId: this.currentReplyToMessageId() || undefined,
        });
        const marker = this.startWorkingMarker().catch(() => false);
        const poll = this.pollTyping().catch(() => false);
        await Promise.race([
          Promise.all([marker, poll]),
          new Promise((resolve) => setImmediate(resolve)),
        ]);
      }
      return true;
    } catch {
      return false;
    }
  }

  async terminateSession() {
    this.lastActivityAt = Date.now();
    const wanted = this.getRecoverableSessionFile();
    if (wanted) await this.connect({ restoreSession: true });
    await this.driver.terminateSession();
    this.driver.dispose();
  }

  async sleepIfIdle() {
    if (!this.sleepAfterIdleMs || !this.driver.hasClient()) return false;
    if (this.hasActiveTurn()) return false;
    if (Date.now() - this.lastActivityAt < this.sleepAfterIdleMs) return false;
    this.driver.dispose();
    return true;
  }

  async resumeSessionFile(sessionFile: string) {
    const wanted = safeString(sessionFile).trim();
    if (!wanted) {
      return {
        changed: false,
        sessionId: this.currentSessionId() || undefined,
      };
    }
    if (!sessionFileExists(wanted)) throw missingSessionFileError(wanted);
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
    _sessionFile = "",
    promptMeta?: PromptContextMeta,
  ) {
    this.rememberPromptChatType(promptMeta);
    const commandName = frontendCommandNameFromLine(commandLine);
    const hadActiveTurn = this.hasActiveTurn();
    const abortingActiveTurn = commandName === "abort" && hadActiveTurn;
    if (abortingActiveTurn) {
      this.lastActivityAt = Date.now();
      try {
        this.turnAbortRequested = true;
        const data: any = {
          ...this.driver.interruptActiveTurnLikeTui(),
          text: this.getCommandResponses().abort,
        };
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
          bindSession: false,
        });
        return {
          handled: true,
          text,
          sessionId: data?.sessionId,
          sessionFile: this.currentSessionFile() || data?.sessionFile,
        };
      } finally {
        this.awaitingTurnSettle = false;
        this.turnAbortRequested = false;
        await this.clearWorkingReaction().catch(() => {});
        this.clearCurrentTurn();
        this.stagedDelivery = null;
        this.saveState();
      }
    }
    if (commandName === "status") {
      return await this.runLocalStatusCommand(
        replyToMessageId,
        incomingMessageId,
      );
    }
    const commandPolicy =
      getRinNonInteractiveCommandInteractionPolicy(commandName);
    const skipSessionRecovery = commandPolicy.skipSessionRecovery;
    // Slash commands are controls; reply-bound session files belong to prompt turns only.
    const explicitSessionFile = "";
    const restoreSessionFile = skipSessionRecovery
      ? ""
      : this.getRecoverableSessionFile();
    const managedSessionLeaf =
      commandName === "new"
        ? MANAGED_CHAT_SESSION_LEAF
        : !restoreSessionFile
          ? this.managedSessionLeafForFreshChat()
          : undefined;
    this.lastActivityAt = Date.now();
    this.setActiveCommandTurnInput({ incomingMessageId, replyToMessageId });
    await this.connect({ restoreSession: !skipSessionRecovery });
    if (commandPolicy.acceptInboundBeforeExecution) {
      this.markAcceptedMessage(incomingMessageId);
    }
    try {
      let data: any = await this.driver.runCommand(commandLine, {
        skipSessionRecovery,
        restoreSessionFile,
        sessionFile: explicitSessionFile,
        managedSessionLeaf,
      });
      this.updateStoredSessionFile(
        data?.sessionFile,
        this.driver.currentSessionFile(),
      );
      this.saveState();
      data = this.localizeBuiltinCommandResult(commandName, data);

      const text = safeString(data?.text || "").trim();
      if (!text) throw new Error("chat_command_text_missing");
      data = { ...data, text };
      await this.deliverAssistantReply({
        text,
        replyToMessageId: replyToMessageId || undefined,
        incomingMessageId,
        sessionFile: data?.sessionFile,
        clearProcessing: true,
        bindSession: false,
      });
      return data;
    } catch (error: any) {
      if (!isTransientChatRuntimeError(error)) {
        const errorMessage =
          safeString(error?.message || error).trim() || "chat_command_failed";
        await this.deliverAssistantReply({
          text: formatChatRuntimeErrorForUser(errorMessage),
          replyToMessageId: replyToMessageId || undefined,
          incomingMessageId,
          clearProcessing: true,
          bindSession: false,
        });
      }
      throw error;
    } finally {
      this.awaitingTurnSettle = false;
      await this.clearWorkingReaction().catch(() => {});
      this.clearCurrentTurn();
      this.clearActiveCommandTurnInput();
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
      managedSessionLeaf?: string;
    },
    mode: "prompt" | "steer" = "prompt",
  ) {
    this.rememberPromptChatType(input.promptMeta);
    this.lastActivityAt = Date.now();
    if (mode === "steer" && this.canSteerActiveTurn()) {
      await this.beginVisibleProcessingTurn({
        incomingMessageId: input.incomingMessageId,
        replyToMessageId: input.replyToMessageId,
      });
      const { sessionFile: rawWantedSessionFile } = normalizeSessionRef(input);
      const wantedSessionFile =
        this.resolveSessionFileForUse(rawWantedSessionFile);
      if (wantedSessionFile && !sessionFileExists(wantedSessionFile)) {
        throw missingSessionFileError(wantedSessionFile);
      }
      const restoreSessionFile =
        wantedSessionFile || this.getRecoverableSessionFile();
      const managedSessionLeaf =
        !wantedSessionFile && !restoreSessionFile
          ? safeString(input.managedSessionLeaf).trim() ||
            this.managedSessionLeafForFreshChat()
          : undefined;
      await this.connect();
      const { text, images } = await restorePromptParts({
        text: input.text,
        attachments: input.attachments,
        startedAt: Date.now(),
      });
      const result = await this.driver.runTurn({
        text: formatPromptForChatContext(text, input.promptMeta),
        images,
        sessionFile: wantedSessionFile,
        restoreSessionFile,
        managedSessionLeaf,
        resetModelOptionsFromSettings: true,
        promptContext: input.promptMeta,
        source: "chat-bridge",
        streamingBehavior: "steer",
      });
      this.assertRestoredTurnStayedOnSession(
        restoreSessionFile,
        result.sessionFile || this.driver.currentSessionFile(),
      );
      this.updateStoredSessionFile(
        result.sessionFile,
        this.driver.currentSessionFile(),
      );
      this.saveState();
      if (result.steered) {
        this.backendAcceptedIncomingMessageId = this.currentIncomingMessageId();
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
      const { sessionFile: rawWantedSessionFile } = normalizeSessionRef(input);
      const wantedSessionFile =
        this.resolveSessionFileForUse(rawWantedSessionFile);
      if (wantedSessionFile && !sessionFileExists(wantedSessionFile)) {
        throw missingSessionFileError(wantedSessionFile);
      }
      const restoreSessionFile =
        wantedSessionFile || this.getRecoverableSessionFile();
      const managedSessionLeaf =
        !wantedSessionFile && !restoreSessionFile
          ? safeString(input.managedSessionLeaf).trim() ||
            this.managedSessionLeafForFreshChat()
          : undefined;
      await this.connect();
      const { text, images } = await restorePromptParts({
        text: input.text,
        attachments: input.attachments,
        startedAt: Date.now(),
      });
      await this.beginVisibleProcessingTurn({
        incomingMessageId: input.incomingMessageId,
        replyToMessageId: input.replyToMessageId,
      });
      try {
        const result = await this.driver.runTurn({
          text: formatPromptForChatContext(text, input.promptMeta),
          images,
          sessionFile: wantedSessionFile,
          restoreSessionFile,
          managedSessionLeaf,
          resetModelOptionsFromSettings: true,
          promptContext: input.promptMeta,
          source: "chat-bridge",
        });
        this.assertRestoredTurnStayedOnSession(
          restoreSessionFile,
          result.sessionFile || this.driver.currentSessionFile(),
        );
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
          const abortedSession = normalizeSessionRef(error);
          this.markProcessedMessage(input.incomingMessageId, false);
          await this.clearWorkingReactionFor(input.incomingMessageId);
          this.clearCurrentTurnFor(input.incomingMessageId);
          if (this.currentTurnMatches(input.incomingMessageId)) {
            this.stagedDelivery = null;
          }
          this.saveState();
          return {
            aborted: true,
            sessionId:
              abortedSession.sessionId || this.currentSessionId() || undefined,
            sessionFile:
              abortedSession.sessionFile || this.currentSessionFile(),
          };
        }
        const errorSession = normalizeSessionRef(error as any);
        const transientSessionFailure = shouldResetDriverOnTransientTurnError(
          error,
          {
            wantedSessionFile,
            restoreSessionFile,
          },
        );
        if (transientSessionFailure) {
          this.driver.dispose();
        } else if (errorMessage !== "chat_restored_session_mismatch") {
          const errorSessionFile = this.updateStoredSessionFile(
            errorSession.sessionFile,
            this.driver.currentSessionFile(),
          );
          if (errorSession.sessionFile && errorMessage) {
            await this.deliverAssistantReply({
              text: formatChatRuntimeErrorForUser(errorMessage),
              replyToMessageId: input.replyToMessageId,
              incomingMessageId: input.incomingMessageId,
              sessionFile: errorSessionFile || this.currentSessionFile(),
              clearProcessing: true,
            });
          }
        }
        await this.clearWorkingReactionFor(input.incomingMessageId);
        this.clearCurrentTurnFor(input.incomingMessageId);
        if (this.currentTurnMatches(input.incomingMessageId)) {
          this.stagedDelivery = null;
        }
        this.saveState();
        throw error;
      } finally {
        if (this.currentTurnMatches(input.incomingMessageId)) {
          this.awaitingTurnSettle = false;
          this.turnAbortRequested = false;
        }
      }
    });
  }

  async housekeep() {
    await this.pollTyping().catch(() => {});
    await this.sleepIfIdle().catch(() => false);
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
          const createdCommandTurn = this.ensureVisibleCommandTurn();
          this.markAcceptedMessage(this.currentIncomingMessageId());
          if (createdCommandTurn) await this.pollTyping().catch(() => false);
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
        this.backendAcceptedIncomingMessageId = this.currentIncomingMessageId();
        this.markAcceptedMessage(this.backendAcceptedIncomingMessageId);
        return;
      case "passive_notice":
        await this.deliverPassiveNotice(event.text);
        return;
      case "compaction_start_notice":
        await this.deliverCompactionStartNotice(event.text);
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
