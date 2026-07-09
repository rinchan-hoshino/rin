import crypto from "node:crypto";
import path from "node:path";

import {
  RinDaemonFrontendClient,
  RinFrontendTurnDriver,
  applyFrontendBuiltinCommandText,
  chatFrontendIdentity,
  frontendCommandNameFromLine,
  getRinNonInteractiveCommandInteractionPolicy,
  type RinFrontendIdentity,
  type RinFrontendTurnClient,
} from "../rin-frontend-sdk/index.js";
import {
  injectPromptContextHeader,
  type PromptContextMeta,
} from "../rin-frontend-sdk/prompt-context.js";
import { MANAGED_CHAT_SESSION_LEAF } from "../session/managed-paths.js";
import { nowIso } from "../time-utils.js";
import type { RinToolStartupOptions } from "../rin-lib/tool-options.js";
import {
  formatRinTodoChecklistCharacterContent,
  formatRinTodoChecklistMarkdownContent,
  normalizeRinTodoItems,
  type RinTodoItem,
} from "../rin-lib/todo-state.js";
import type { RinPiPassthroughOptions } from "../rin-lib/pi-passthrough.js";
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
import {
  enqueueChatOutboxPayload,
  readChatOutboxItemById,
  type ChatMessagePart,
} from "../rin-lib/chat-outbox.js";
import { drainChatOutbox } from "./boot.js";
import { listChatMessages } from "./message-store.js";
import { restorePromptParts } from "./transport.js";
import { formatRuntimeErrorForChat } from "../rin-lib/user-facing-errors.js";
import { resolveChatQuietModeEnabled } from "./settings.js";

const INTERIM_PREFIX = CHAT_INTERIM_REPLY_PREFIX;
const WORKING_REACTION_INTERVAL_MS = 30_000;

type ChatDeliveryOutcome = {
  messageIds: string[];
  accepted: boolean;
  settled: boolean;
};

function chatDeliveryOutcome(
  messageIds: string[] = [],
  options: { accepted?: boolean; settled?: boolean } = {},
): ChatDeliveryOutcome {
  return {
    messageIds,
    accepted: options.accepted !== false,
    settled: options.settled !== false,
  };
}

const PLATFORM_TYPING_POLL_INTERVAL_MS: Record<string, number> = {
  // Telegram Bot API sendChatAction expires after 5 seconds.
  telegram: 4_000,
  // Discord typing indicators expire after 10 seconds.
  discord: 9_000,
};
const DEFAULT_TYPING_POLL_INTERVAL_MS = WORKING_REACTION_INTERVAL_MS;

function detachedControllerStatePath(dataDir: string, chatKey: string) {
  return path.join(
    dataDir,
    "chat",
    "session-state",
    "detached",
    sha256Hex(chatKey).slice(0, 16),
    "state.json",
  );
}

function statePathForControllerKey(dataDir: string, chatKey: string) {
  return parseChatKey(chatKey)
    ? chatStatePath(dataDir, chatKey)
    : detachedControllerStatePath(dataDir, chatKey);
}

function sha256Hex(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

type ChatTurnTarget = {
  incomingMessageId?: string;
  replyToMessageId?: string;
  text?: string;
  submittedText?: string;
};

type ChatTurnMeta = ChatTurnTarget & {
  workingNoticeSent?: boolean;
  startedAt: number;
  ackIncomingMessageId?: string;
  ackReplyToMessageId?: string;
};

type ChatAssistantDelivery = {
  chatKey: string;
  deliveryKind?: "final" | "interim" | "passive_notice";
  parts: ChatMessagePart[];
  replyToMessageId?: string;
  coalesceWithWorkingMessage?: boolean;
  sessionFile?: string;
  sessionBinding?: "conversation";
};

type TodoNoticeRenderMode = "native" | "markdown" | "characters";

const NATIVE_TODO_NOTICE_PLATFORMS = new Set(["slack"]);
const MARKDOWN_TODO_NOTICE_PLATFORMS = new Set([
  "discord",
  "feishu",
  "lark",
  "telegram",
]);

function todoNoticeRenderModeForChatKey(chatKey: string): TodoNoticeRenderMode {
  const parsed = parseChatKey(chatKey);
  const platform = safeString(parsed?.platform).trim().toLowerCase();
  if (NATIVE_TODO_NOTICE_PLATFORMS.has(platform)) return "native";
  if (MARKDOWN_TODO_NOTICE_PLATFORMS.has(platform)) return "markdown";
  return "characters";
}

function formatTodoNoticeText(
  todos: ReadonlyArray<Pick<RinTodoItem, "text" | "done">>,
  error?: string,
  mode: Exclude<TodoNoticeRenderMode, "native"> = "characters",
) {
  const body =
    mode === "markdown"
      ? formatRinTodoChecklistMarkdownContent(todos)
      : formatRinTodoChecklistCharacterContent(todos);
  const errorText = safeString(error).trim();
  return errorText ? `Error: ${errorText}\n${body}` : body;
}

function formatPromptForChatContext(
  text: string,
  promptMeta?: PromptContextMeta,
) {
  return injectPromptContextHeader(promptMeta, text);
}

type WorkingIndicatorKind = "polling" | "marker";
type WorkingIndicatorPresentation =
  | "typing"
  | "editable-message"
  | "reaction"
  | "message"
  | "legacy";

type WorkingIndicator = {
  type?: string;
  kind?: string;
  name?: string;
  presentation?: string;
  capability?: string;
  priority?: number;
  tick?: (context: Record<string, any>) => Promise<unknown> | unknown;
  end?: (context: Record<string, any>) => Promise<unknown> | unknown;
  start?: (context: Record<string, any>) => Promise<unknown> | unknown;
  onTick?: (context: Record<string, any>) => Promise<unknown> | unknown;
  onEnd?: (context: Record<string, any>) => Promise<unknown> | unknown;
  onStart?: (context: Record<string, any>) => Promise<unknown> | unknown;
};

const WORKING_PRESENTATION_PRIORITY: Record<
  WorkingIndicatorPresentation,
  number
> = {
  typing: -1,
  "editable-message": 300,
  reaction: 200,
  message: 100,
  legacy: 0,
};

function workingIndicatorKind(indicator: WorkingIndicator) {
  const kind = safeString(indicator?.type || indicator?.kind).trim();
  return kind === "polling" || kind === "marker" ? kind : "";
}

function workingIndicatorPresentation(
  indicator: WorkingIndicator,
): WorkingIndicatorPresentation {
  const value = safeString(
    indicator?.presentation || indicator?.capability,
  ).trim();
  if (
    value === "typing" ||
    value === "editable-message" ||
    value === "reaction" ||
    value === "message"
  ) {
    return value;
  }
  return "legacy";
}

function workingIndicatorPriority(indicator: WorkingIndicator) {
  const explicit = Number(indicator?.priority);
  if (Number.isFinite(explicit)) return explicit;
  return WORKING_PRESENTATION_PRIORITY[workingIndicatorPresentation(indicator)];
}

function pickVisibleWorkingIndicator(indicators: WorkingIndicator[]) {
  const visible = indicators.filter(
    (indicator) => workingIndicatorPresentation(indicator) !== "typing",
  );
  if (!visible.length) return null;
  const typed = visible.filter(
    (indicator) => workingIndicatorPresentation(indicator) !== "legacy",
  );
  const candidates = typed.length ? typed : visible;
  return candidates.reduce((best, indicator) =>
    workingIndicatorPriority(indicator) > workingIndicatorPriority(best)
      ? indicator
      : best,
  );
}

function selectWorkingIndicatorsForKind(
  indicators: WorkingIndicator[],
  kind: WorkingIndicatorKind,
) {
  const selected: WorkingIndicator[] = indicators.filter(
    (indicator) =>
      workingIndicatorKind(indicator) === kind &&
      workingIndicatorPresentation(indicator) === "typing",
  );
  const visible = pickVisibleWorkingIndicator(indicators);
  if (visible && workingIndicatorKind(visible) === kind) selected.push(visible);
  return selected;
}

function selectWorkingIndicatorsForEnd(indicators: WorkingIndicator[]) {
  const visible = pickVisibleWorkingIndicator(indicators);
  return visible ? [visible] : [];
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

function normalizeChatTurnTarget(input: unknown): ChatTurnTarget | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const incomingMessageId = safeString(record.incomingMessageId).trim();
  const replyToMessageId =
    safeString(record.replyToMessageId).trim() || incomingMessageId;
  const text = safeString(record.text).trim();
  const submittedText = safeString(record.submittedText).trim();
  if (!incomingMessageId && !replyToMessageId && !text && !submittedText) {
    return null;
  }
  return {
    incomingMessageId: incomingMessageId || undefined,
    replyToMessageId: replyToMessageId || undefined,
    text: text || undefined,
    submittedText: submittedText || undefined,
  };
}

function normalizeChatTurnTargets(input: unknown): ChatTurnTarget[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => normalizeChatTurnTarget(item))
    .filter((item): item is ChatTurnTarget => Boolean(item));
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
  affectChatBinding: boolean;
  workingReactionEmoji = "";
  workingReactionTick = 0;
  lastWorkingReactionAt = 0;
  lastWorkingIndicatorAt = 0;
  activeWorkingIndicators: WorkingIndicator[] = [];
  workingIndicatorTick = 0;
  currentTurn: ChatTurnMeta | null = null;
  compactionTurn: ChatTurnMeta | null = null;
  compactionWorkingIndicators: WorkingIndicator[] = [];
  compactionReactionTick = 0;
  lastCompactionReactionAt = 0;
  lastCompactionIndicatorAt = 0;
  compactionIndicatorTick = 0;
  activeCommandTurnInput: ChatTurnTarget | null = null;
  pendingSteeredDeliveryTargets: ChatTurnTarget[] = [];
  backendAcceptedIncomingMessageId = "";
  stagedDelivery: ChatAssistantDelivery | null = null;
  pendingPassiveNotices: string[] = [];
  latestTodoNoticeText = "";
  awaitingTurnSettle = false;
  externalWorkingVisible = false;
  turnAbortRequested = false;
  turnAbortGeneration = 0;
  sleepAfterIdleMs = 0;
  lastActivityAt = Date.now();
  commandResponses?: ChatCommandResponses;
  quietModeOverride?: boolean;

  constructor(
    app: any,
    dataDir: string,
    chatKey: string,
    deps: {
      logger: any;
      h: any;
      affectChatBinding?: boolean;
      statePath?: string;
      frontendClientFactory?: () => RinFrontendTurnClient;
      sleepAfterIdleMs?: number;
      commandResponses?: Partial<ChatCommandResponses>;
      frontendIdentity?: RinFrontendIdentity;
      useChatFrontendIdentity?: boolean;
    },
  ) {
    this.app = app;
    this.chatKey = chatKey;
    this.dataDir = dataDir;
    this.agentDir = path.resolve(dataDir, "..");
    this.affectChatBinding = deps.affectChatBinding !== false;
    this.statePath =
      deps.statePath || statePathForControllerKey(dataDir, chatKey);
    this.state = readJsonFile<ChatState>(this.statePath, { chatKey });
    this.pendingSteeredDeliveryTargets = normalizeChatTurnTargets(
      this.state.pendingSteeredDeliveryTargets,
    );
    this.logger = deps.logger;
    this.h = deps.h;
    this.sleepAfterIdleMs = Math.max(0, Number(deps.sleepAfterIdleMs || 0));
    this.frontendClientFactory = deps.frontendClientFactory;
    this.commandResponses = deps.commandResponses
      ? resolveChatCommandResponses(deps.commandResponses)
      : undefined;
    if (!this.state.chatKey) this.state.chatKey = chatKey;
    const frontendIdentity =
      deps.frontendIdentity ||
      (deps.useChatFrontendIdentity === false
        ? undefined
        : chatFrontendIdentity(chatKey));
    this.driver = new RinFrontendTurnDriver({
      clientFactory:
        deps.frontendClientFactory ||
        (() =>
          new RinDaemonFrontendClient({
            frontendIdentity,
          })),
      promptSource: "chat-bridge",
      commandResponses: this.getCommandResponses(),
      frontendIdentity,
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
    void this.clearCompactionWorkingReaction().catch(() => {});
    this.currentTurn = null;
    this.compactionTurn = null;
    this.compactionWorkingIndicators = [];
    this.activeCommandTurnInput = null;
    this.pendingSteeredDeliveryTargets = [];
    this.backendAcceptedIncomingMessageId = "";
    this.stagedDelivery = null;
    this.awaitingTurnSettle = false;
    this.externalWorkingVisible = false;
    this.turnAbortRequested = false;
    this.turnAbortGeneration = 0;
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
    const pendingSteeredDeliveryTargets = normalizeChatTurnTargets(
      this.pendingSteeredDeliveryTargets,
    );
    if (pendingSteeredDeliveryTargets.length) {
      nextState.pendingSteeredDeliveryTargets = pendingSteeredDeliveryTargets;
    }
    this.state = nextState;
    writeJsonFile(this.statePath, nextState);
  }

  async clearProcessingState() {
    this.awaitingTurnSettle = false;
    this.externalWorkingVisible = false;
    this.turnAbortRequested = false;
    this.turnAbortGeneration += 1;
    this.stagedDelivery = null;
    await this.clearWorkingReaction().catch(() => {});
    await this.clearCompactionWorkingReaction().catch(() => {});
    this.currentTurn = null;
    this.compactionTurn = null;
    this.compactionWorkingIndicators = [];
    this.activeCommandTurnInput = null;
    this.pendingSteeredDeliveryTargets = [];
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
      this.frontendPhase === "working" ||
      this.awaitingTurnSettle ||
      this.driver.hasActiveTurn()
    );
  }

  canSteerActiveTurn() {
    if (this.turnAbortRequested) return false;
    return typeof this.driver.canSteerActiveTurn === "function"
      ? this.driver.canSteerActiveTurn()
      : false;
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

  private hasCurrentTurnMatching(messageId?: string) {
    return Boolean(this.currentTurn) && this.currentTurnMatches(messageId);
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

  private rememberPendingSteeredDeliveryTarget(input: ChatTurnTarget) {
    const incomingMessageId = safeString(input.incomingMessageId || "").trim();
    const replyToMessageId =
      safeString(input.replyToMessageId || "").trim() || incomingMessageId;
    if (!incomingMessageId && !replyToMessageId) return;
    this.pendingSteeredDeliveryTargets.push({
      incomingMessageId: incomingMessageId || undefined,
      replyToMessageId: replyToMessageId || undefined,
      text: safeString(input.text || "").trim() || undefined,
      submittedText: safeString(input.submittedText || "").trim() || undefined,
    });
    this.saveState();
  }

  hasPendingSteeredDeliveryTarget(messageId?: string) {
    const nextMessageId = safeString(messageId || "").trim();
    if (!nextMessageId) return false;
    return this.pendingSteeredDeliveryTargets.some(
      (target) =>
        safeString(target.incomingMessageId || "").trim() === nextMessageId,
    );
  }

  ownsInboundMessage(messageId?: string) {
    return (
      this.claimsInboundMessage(messageId) ||
      this.hasBackendAcceptedInboundMessage(messageId) ||
      this.hasPendingSteeredDeliveryTarget(messageId)
    );
  }

  private async activatePendingSteeredDeliveryTarget(startedText?: string) {
    const text = safeString(startedText || "").trim();
    if (!text || !this.pendingSteeredDeliveryTargets.length) return false;
    const index = this.pendingSteeredDeliveryTargets.findIndex((target) => {
      const raw = safeString(target.text || "").trim();
      const submitted = safeString(target.submittedText || "").trim();
      return Boolean(
        (submitted && submitted === text) || (raw && raw === text),
      );
    });
    if (index < 0) return false;
    const [target] = this.pendingSteeredDeliveryTargets.splice(index, 1);
    this.saveState();
    await this.beginVisibleProcessingTurn({
      incomingMessageId: target?.incomingMessageId,
      replyToMessageId: target?.replyToMessageId,
    });
    this.markProcessedMessage(target?.incomingMessageId);
    return true;
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
      todoNoticeText: this.latestTodoNoticeText || undefined,
      ...extra,
    };
  }

  private compactionWorkingIndicatorContext(extra: Record<string, any> = {}) {
    return this.workingIndicatorContext({
      messageId: this.compactionTurn?.incomingMessageId || undefined,
      replyToMessageId: this.compactionTurn?.replyToMessageId || undefined,
      tick: this.compactionIndicatorTick,
      ...extra,
    });
  }

  private canDeliverReplies() {
    const parsed = parseChatKey(this.chatKey);
    if (!parsed) return false;
    return Boolean(findBot(this.app, parsed.platform, parsed.botId));
  }

  private typingPollIntervalMs() {
    const platform = parseChatKey(this.chatKey)?.platform.toLowerCase() || "";
    return (
      PLATFORM_TYPING_POLL_INTERVAL_MS[platform] ||
      DEFAULT_TYPING_POLL_INTERVAL_MS
    );
  }

  private isTypingPollDue(lastPolledAt: number, now = Date.now()) {
    return (
      lastPolledAt <= 0 || now - lastPolledAt >= this.typingPollIntervalMs()
    );
  }

  private isQuietModeEnabled() {
    if (this.quietModeOverride !== undefined) return this.quietModeOverride;
    return resolveChatQuietModeEnabled(
      readJsonFile(path.join(this.agentDir, "settings.json"), {}),
      this.chatKey,
    );
  }

  private async runDriverTurnWithQuietMode(
    quietMode: unknown,
    input: Parameters<RinFrontendTurnDriver["runTurn"]>[0],
  ) {
    const previousQuietModeOverride = this.quietModeOverride;
    if (quietMode !== undefined) this.quietModeOverride = Boolean(quietMode);
    try {
      return await this.driver.runTurn(input);
    } finally {
      this.quietModeOverride = previousQuietModeOverride;
    }
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

  async clearWorkingReaction(options: { preserveTodoNotice?: boolean } = {}) {
    const indicators = this.activeWorkingIndicators.length
      ? this.activeWorkingIndicators
      : this.getWorkingIndicators();
    const todoNoticeText = this.latestTodoNoticeText;
    this.activeWorkingIndicators = [];
    this.workingReactionEmoji = "";
    this.workingReactionTick = 0;
    this.lastWorkingReactionAt = 0;
    this.lastWorkingIndicatorAt = 0;
    this.workingIndicatorTick = 0;
    if (!options.preserveTodoNotice) this.latestTodoNoticeText = "";
    const context = this.workingIndicatorContext({
      event: "end",
      todoNoticeText: todoNoticeText || undefined,
    });
    const results = await Promise.all(
      selectWorkingIndicatorsForEnd(indicators).map((indicator) =>
        this.callWorkingIndicator(indicator, "end", context).catch(() => false),
      ),
    );
    return results.some(Boolean);
  }

  private getWorkingIndicatorPolicy() {
    const indicators = this.getWorkingIndicators();
    return {
      polling: selectWorkingIndicatorsForKind(indicators, "polling").length > 0,
      marker: selectWorkingIndicatorsForKind(indicators, "marker").length > 0,
    };
  }

  private async startWorkingMarker(indicators = this.getWorkingIndicators()) {
    if (!this.canDeliverReplies()) return false;
    const selected = selectWorkingIndicatorsForKind(indicators, "marker");
    this.activeWorkingIndicators = selected;
    const context = this.workingIndicatorContext({ event: "start" });
    const results = await Promise.all(
      selected.map((indicator) =>
        this.callWorkingIndicator(indicator, "start", context).catch(
          () => false,
        ),
      ),
    );
    return results.some(Boolean);
  }

  private async clearCompactionWorkingReaction() {
    const indicators = this.compactionWorkingIndicators.length
      ? this.compactionWorkingIndicators
      : this.getWorkingIndicators();
    this.compactionWorkingIndicators = [];
    this.compactionReactionTick = 0;
    this.lastCompactionReactionAt = 0;
    this.lastCompactionIndicatorAt = 0;
    this.compactionIndicatorTick = 0;
    const context = this.compactionWorkingIndicatorContext({ event: "end" });
    const results = await Promise.all(
      selectWorkingIndicatorsForEnd(indicators).map((indicator) =>
        this.callWorkingIndicator(indicator, "end", context).catch(() => false),
      ),
    );
    return results.some(Boolean);
  }

  private async startCompactionWorkingMarker() {
    if (!this.canDeliverReplies()) return false;
    const indicators = this.getWorkingIndicators();
    const selected = selectWorkingIndicatorsForKind(indicators, "marker");
    this.compactionWorkingIndicators = selected;
    const context = this.compactionWorkingIndicatorContext({ event: "start" });
    const results = await Promise.all(
      selected.map((indicator) =>
        this.callWorkingIndicator(indicator, "start", context).catch(
          () => false,
        ),
      ),
    );
    return results.some(Boolean);
  }

  private async pollCompactionTyping() {
    if (!this.canDeliverReplies() || !this.compactionTurn) return false;
    const indicators = this.getWorkingIndicators();
    const now = Date.now();
    if (!this.isTypingPollDue(this.lastCompactionIndicatorAt, now)) {
      return false;
    }
    const messageId = safeString(
      this.compactionTurn.incomingMessageId || "",
    ).trim();
    const reactionDue =
      Boolean(messageId) &&
      (this.lastCompactionReactionAt <= 0 ||
        now - this.lastCompactionReactionAt >= WORKING_REACTION_INTERVAL_MS);
    const context = this.compactionWorkingIndicatorContext({
      event: "tick",
      tick: this.compactionIndicatorTick,
      reactionDue,
      reactionTick: this.compactionReactionTick,
      reactionIntervalMs: WORKING_REACTION_INTERVAL_MS,
    });
    const selected = selectWorkingIndicatorsForKind(indicators, "polling");
    if (
      selected.some(
        (indicator) => workingIndicatorPresentation(indicator) !== "typing",
      ) ||
      !this.compactionWorkingIndicators.length
    ) {
      this.compactionWorkingIndicators = selected;
    }
    const results = await Promise.all(
      selected.map((indicator) =>
        this.callWorkingIndicator(indicator, "tick", context).catch(
          () => false,
        ),
      ),
    );
    this.lastCompactionIndicatorAt = now;
    this.compactionIndicatorTick += 1;
    if (reactionDue) {
      this.lastCompactionReactionAt = now;
      this.compactionReactionTick += 1;
    }
    return results.some(Boolean);
  }

  private async startEditableWorkingNotice(
    indicators = this.getWorkingIndicators(),
  ) {
    if (!this.canDeliverReplies()) return false;
    const selected = selectWorkingIndicatorsForKind(indicators, "polling");
    const editable = selected.find(
      (indicator) =>
        workingIndicatorPresentation(indicator) === "editable-message",
    );
    if (!editable) return false;
    this.activeWorkingIndicators = selected;
    const messageId = this.currentIncomingMessageId();
    const context = this.workingIndicatorContext({
      event: "tick",
      tick: 0,
      reactionDue: Boolean(messageId),
      reactionTick: this.workingReactionTick,
      reactionIntervalMs: WORKING_REACTION_INTERVAL_MS,
    });
    const result = await this.callWorkingIndicator(editable, "tick", context);
    this.lastWorkingIndicatorAt = Date.now();
    this.workingIndicatorTick += 1;
    if (messageId) {
      this.lastWorkingReactionAt = this.lastWorkingIndicatorAt;
      this.workingReactionTick += 1;
    }
    return Boolean(result);
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
    this.latestTodoNoticeText = "";
    this.awaitingTurnSettle = true;
    const indicators = this.getWorkingIndicators();
    const editableStarted = await this.startEditableWorkingNotice(
      indicators,
    ).catch(() => false);
    if (editableStarted) {
      // Subsequent animation ticks still use the normal chat polling path.
      // Do not poll synchronously here: before the driver marks the turn active,
      // pollTyping can classify the just-created Working notice as stale.
      return;
    }
    const marker = this.startWorkingMarker(indicators).catch(() => false);
    const poll = this.pollTyping().catch(() => false);
    await Promise.race([
      Promise.all([marker, poll]),
      new Promise((resolve) => setImmediate(resolve)),
    ]);
  }

  private currentDeliveryTarget(input: {
    incomingMessageId?: string;
    replyToMessageId?: string;
  }) {
    return {
      incomingMessageId:
        this.currentIncomingMessageId() ||
        safeString(input.incomingMessageId || "").trim() ||
        undefined,
      replyToMessageId:
        this.currentReplyToMessageId() ||
        safeString(input.replyToMessageId || "").trim() ||
        undefined,
    };
  }

  private markOriginalProcessedIfRetargeted(
    originalIncomingMessageId: unknown,
    targetIncomingMessageId: unknown,
    bindSession = true,
  ) {
    const original = safeString(originalIncomingMessageId).trim();
    const target = safeString(targetIncomingMessageId).trim();
    if (!original || !target || original === target) return;
    this.markProcessedMessage(original, bindSession);
  }

  private async finishSupersededRecoveredTurn(
    input: { incomingMessageId?: string },
    result: any,
  ) {
    this.markProcessedMessage(input.incomingMessageId);
    await this.clearWorkingReactionFor(input.incomingMessageId);
    this.clearCurrentTurnFor(input.incomingMessageId);
    this.awaitingTurnSettle = false;
    return {
      superseded: true,
      steered: false,
      sessionId:
        safeString(result?.sessionId || this.currentSessionId()).trim() ||
        undefined,
      sessionFile:
        safeString(result?.sessionFile || this.currentSessionFile()).trim() ||
        undefined,
    };
  }

  private shouldShowTypingIndicator() {
    if (!this.currentTurn) return false;
    if (this.stagedDelivery) return true;
    if (this.externalWorkingVisible && this.awaitingTurnSettle) return true;
    if (typeof this.driver.hasVisibleChatWorkingTurn === "function") {
      return this.driver.hasVisibleChatWorkingTurn();
    }
    return this.driver.hasWorkerActiveTurn();
  }

  async pollTyping() {
    if (!this.canDeliverReplies()) return false;
    if (!this.shouldShowTypingIndicator()) {
      await this.clearWorkingReaction().catch(() => {});
      return false;
    }
    const indicators = this.getWorkingIndicators();
    const now = Date.now();
    if (!this.isTypingPollDue(this.lastWorkingIndicatorAt, now)) {
      return false;
    }
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
    const selected = selectWorkingIndicatorsForKind(indicators, "polling");
    if (
      selected.some(
        (indicator) => workingIndicatorPresentation(indicator) !== "typing",
      ) ||
      !this.activeWorkingIndicators.length
    ) {
      this.activeWorkingIndicators = selected;
    }
    const results = await Promise.all(
      selected.map((indicator) =>
        this.callWorkingIndicator(indicator, "tick", context).catch(
          () => false,
        ),
      ),
    );
    this.lastWorkingIndicatorAt = now;
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

  private currentConversationSessionPayload() {
    if (!this.affectChatBinding) return {};
    const sessionFile = this.currentSessionFile();
    return {
      ...(sessionFile ? { sessionFile } : {}),
      sessionBinding: "conversation" as const,
    };
  }

  private buildAssistantDelivery(input: {
    text?: string;
    parts?: ChatMessagePart[];
    replyToMessageId?: string;
    sessionFile?: string;
    bindSession?: boolean;
  }): ChatAssistantDelivery {
    const text = safeString(
      input.text ?? this.driver.latestAssistantText,
    ).trim();
    const parts = Array.isArray(input.parts) ? input.parts.filter(Boolean) : [];
    if (!text && !parts.length) {
      throw new Error("chat_final_assistant_text_missing");
    }
    const sessionPayload =
      input.bindSession === false
        ? {}
        : {
            sessionFile: toStoredSessionFile(
              this.agentDir,
              input.sessionFile || this.currentSessionFile(),
            ),
            sessionBinding: "conversation" as const,
          };
    const replyToMessageId = safeString(input.replyToMessageId || "").trim();
    return {
      chatKey: this.chatKey,
      deliveryKind: "final",
      replyToMessageId: replyToMessageId || undefined,
      parts: [
        ...(replyToMessageId
          ? [{ type: "quote" as const, id: replyToMessageId }]
          : []),
        ...(parts.length ? parts : [{ type: "text" as const, text }]),
      ],
      ...sessionPayload,
    };
  }

  private stageAssistantDelivery(input: {
    text?: string;
    parts?: ChatMessagePart[];
    replyToMessageId?: string;
    sessionFile?: string;
    bindSession?: boolean;
  }) {
    const text = safeString(
      input.text ?? this.driver.latestAssistantText,
    ).trim();
    this.stagedDelivery = this.buildAssistantDelivery(input);
    return text;
  }

  private async waitForOutboxDelivery(
    id: string,
    timeoutMs?: number,
  ): Promise<string[] | null> {
    const hasDeadline = Number.isFinite(timeoutMs);
    const deadline = hasDeadline
      ? Date.now() + Math.max(1, Number(timeoutMs))
      : 0;
    while (!hasDeadline || Date.now() <= deadline) {
      const current = readChatOutboxItemById(this.agentDir, id)?.item;
      if (current?.status === "delivered") return current.deliveryResult || [];
      if (current?.status === "failed") {
        throw new Error(current.lastError || "chat_outbox_delivery_failed");
      }
      const lastError = safeString(current?.lastError).trim();
      if (lastError && !/^chat_outbox_delivery_pending$/.test(lastError)) {
        throw new Error(lastError);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return null;
  }

  private shouldSuppressQuietDelivery(deliveryKind: string) {
    return this.isQuietModeEnabled() && deliveryKind !== "final";
  }

  private async enqueueAndDrainDelivery(
    payload: any,
    options: {
      id?: string;
      idempotencyKey?: string;
      deliveryKind?:
        | "final"
        | "interim"
        | "passive_notice"
        | "error"
        | "command_ack"
        | "generic";
      postDelivery?: any;
      coalesceWithWorkingMessage?: boolean;
      requireDelivery?: boolean;
      waitForDeliveryMs?: number;
      waitUntilDeliverySettled?: boolean;
    } = {},
  ) {
    const idempotencyKey = safeString(options.idempotencyKey).trim();
    const id =
      safeString(options.id).trim() ||
      (idempotencyKey
        ? `dedupe-${sha256Hex(idempotencyKey)}`
        : `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`);
    const deliveryKind = safeString(options.deliveryKind).trim();
    const normalizedPayload =
      (deliveryKind === "final" ||
        deliveryKind === "interim" ||
        deliveryKind === "passive_notice") &&
      !payload.deliveryKind
        ? { ...payload, deliveryKind }
        : payload;
    const effectiveDeliveryKind = safeString(
      normalizedPayload?.deliveryKind || deliveryKind,
    ).trim();
    if (this.shouldSuppressQuietDelivery(effectiveDeliveryKind)) {
      return chatDeliveryOutcome([], { accepted: false });
    }
    enqueueChatOutboxPayload(this.agentDir, normalizedPayload, {
      ...options,
      id,
    });
    const results = await drainChatOutbox(
      this.app,
      this.agentDir,
      this.h,
      this.logger,
      {
        chatKey: safeString(normalizedPayload?.chatKey).trim(),
        itemId: id,
      },
    );
    const own = Array.isArray(results)
      ? results.find((item: any) => item?.id === id)
      : null;
    if (own && own.status !== "delivered") {
      if (own.status === "dispatched") {
        const deliveryResult = options.waitUntilDeliverySettled
          ? await this.waitForOutboxDelivery(id)
          : Number.isFinite(options.waitForDeliveryMs)
            ? await this.waitForOutboxDelivery(id, options.waitForDeliveryMs)
            : null;
        if (deliveryResult) return chatDeliveryOutcome(deliveryResult);
        const current = readChatOutboxItemById(this.agentDir, id)?.item;
        if (
          (current?.status === "queued" || current?.status === "sending") &&
          /^chat_outbox_delivery_pending$/.test(
            safeString(current.lastError).trim(),
          )
        ) {
          return chatDeliveryOutcome([], { settled: false });
        }
        if (options.requireDelivery)
          throw new Error("chat_outbox_delivery_pending");
        return chatDeliveryOutcome([]);
      }
      const errorMessage =
        safeString((own as any).error).trim() || "chat_outbox_delivery_pending";
      if (/^chat_outbox_delivery_timeout:/.test(errorMessage)) {
        return chatDeliveryOutcome((own as any)?.deliveryResult || []);
      }
      throw new Error(errorMessage);
    }
    if (!own && idempotencyKey) {
      const current = readChatOutboxItemById(this.agentDir, id)?.item;
      if (current?.status === "delivered") {
        return chatDeliveryOutcome(current.deliveryResult || []);
      }
      if (current?.status === "failed") {
        throw new Error(current.lastError || "chat_outbox_delivery_failed");
      }
      if (current?.status === "queued" || current?.status === "sending") {
        return chatDeliveryOutcome([], { settled: false });
      }
    }
    return chatDeliveryOutcome((own as any)?.deliveryResult || []);
  }

  private async commitPendingDelivery(
    clearProcessing = false,
    postDelivery?: any,
    deliveryOptions: { id?: string; idempotencyKey?: string } = {},
  ) {
    const pending = this.stagedDelivery;
    if (!pending) return chatDeliveryOutcome([], { accepted: false });
    if (!this.canDeliverReplies()) {
      this.stagedDelivery = null;
      if (clearProcessing) {
        await this.clearWorkingReaction().catch(() => {});
        this.currentTurn = null;
      }
      return chatDeliveryOutcome([], { accepted: false });
    }
    const deliveryPayload = {
      ...pending,
      createdAt: nowIso(),
    };
    const outcome = await this.enqueueAndDrainDelivery(deliveryPayload, {
      deliveryKind: "final",
      postDelivery,
      requireDelivery: true,
      waitUntilDeliverySettled: true,
      ...deliveryOptions,
    });
    this.stagedDelivery = null;
    if (clearProcessing) {
      await this.clearWorkingReaction().catch(() => {});
      this.currentTurn = null;
    }
    return outcome;
  }

  private async deliverAssistantReply(input: {
    text?: string;
    parts?: ChatMessagePart[];
    replyToMessageId?: string;
    incomingMessageId?: string;
    sessionFile?: string;
    clearProcessing?: boolean;
    bindSession?: boolean;
  }) {
    const bindSession = input.bindSession !== false && this.affectChatBinding;
    const text = this.stageAssistantDelivery({ ...input, bindSession });
    const incomingMessageId = safeString(input.incomingMessageId).trim();
    const replyToMessageId = safeString(
      input.replyToMessageId || input.incomingMessageId,
    ).trim();
    const idempotencyKey = incomingMessageId
      ? JSON.stringify([
          "final",
          this.chatKey,
          incomingMessageId,
          replyToMessageId,
          sha256Hex(JSON.stringify({ text, parts: input.parts || [] })),
        ])
      : "";
    const id = idempotencyKey ? `final-${sha256Hex(idempotencyKey)}` : "";
    const delivery = await this.commitPendingDelivery(
      input.clearProcessing,
      {
        markProcessed: {
          chatKey: this.chatKey,
          messageId: input.incomingMessageId,
          sessionFile: bindSession
            ? input.sessionFile || this.currentSessionFile()
            : undefined,
          bindSession,
        },
      },
      { id, idempotencyKey },
    );
    if (delivery?.settled !== false) {
      this.markProcessedMessage(input.incomingMessageId, bindSession);
    }
    return text;
  }

  private async deliverAssistantInterim(text: string) {
    const trimmed = safeString(text).trim();
    if (!trimmed) return false;
    if (!this.canDeliverReplies()) return true;
    const incomingMessageId = this.currentIncomingMessageId();
    const replyToMessageId = this.currentReplyToMessageId();
    try {
      await this.enqueueAndDrainDelivery(
        {
          createdAt: nowIso(),
          chatKey: this.chatKey,
          deliveryKind: "interim",
          replyToMessageId: replyToMessageId || undefined,
          parts: [{ type: "text", text: `${INTERIM_PREFIX}${trimmed}` }],
          coalesceWithWorkingMessage: true,
          ...this.currentConversationSessionPayload(),
        },
        { deliveryKind: "interim" },
      );
      this.markAcceptedMessage(incomingMessageId);
      return true;
    } catch {
      return false;
    }
  }

  private shouldDeferPassiveNotice() {
    return (
      this.hasActiveTurn() ||
      this.awaitingTurnSettle ||
      Boolean(this.stagedDelivery)
    );
  }

  private async sendPassiveNoticeNow(
    text: string,
    options: {
      postDelivery?: any;
      id?: string;
      idempotencyKey?: string;
      waitForDeliveryMs?: number;
      waitUntilDeliverySettled?: boolean;
      requireDelivery?: boolean;
      coalesceWithWorkingMessage?: boolean;
      replyToMessageId?: string;
    } = {},
  ) {
    const trimmed = safeString(text).trim();
    if (!trimmed) return false;
    if (!this.canDeliverReplies()) return true;
    const replyToMessageId =
      safeString(options.replyToMessageId).trim() ||
      this.currentReplyToMessageId() ||
      undefined;
    try {
      await this.enqueueAndDrainDelivery(
        {
          createdAt: nowIso(),
          chatKey: this.chatKey,
          replyToMessageId,
          parts: [{ type: "text", text: trimmed }],
          ...(options.coalesceWithWorkingMessage
            ? { coalesceWithWorkingMessage: true }
            : {}),
          ...this.currentConversationSessionPayload(),
        },
        { deliveryKind: "passive_notice", ...options },
      );
      return true;
    } catch {
      return false;
    }
  }

  private async sendTodoPassiveNoticeNow(event: any) {
    const todos = normalizeRinTodoItems(event?.todoItems);
    if (!todos?.length) {
      this.latestTodoNoticeText = safeString(event?.text).trim();
      return await this.sendPassiveNoticeNow(event?.text);
    }
    if (!this.canDeliverReplies()) return true;

    const error = safeString(event?.todoError).trim();
    const mode = todoNoticeRenderModeForChatKey(this.chatKey);
    const noticeText = formatTodoNoticeText(
      todos,
      error,
      mode === "native" ? "characters" : mode,
    );
    this.latestTodoNoticeText = noticeText;
    const todoDeliveryOptions = {
      waitUntilDeliverySettled: true,
      requireDelivery: true,
      coalesceWithWorkingMessage: true,
    };
    if (mode !== "native") {
      return await this.sendPassiveNoticeNow(noticeText, todoDeliveryOptions);
    }

    try {
      await this.enqueueAndDrainDelivery(
        {
          createdAt: nowIso(),
          chatKey: this.chatKey,
          deliveryKind: "passive_notice",
          replyToMessageId: this.currentReplyToMessageId() || undefined,
          coalesceWithWorkingMessage: true,
          parts: [
            ...(error
              ? [{ type: "text" as const, text: `Error: ${error}` }]
              : []),
            {
              type: "todo" as const,
              title: "Todo",
              items: todos.map((todo) => ({
                text: todo.text,
                done: todo.done,
              })),
            },
          ],
          ...this.currentConversationSessionPayload(),
        },
        { deliveryKind: "passive_notice", ...todoDeliveryOptions },
      );
      return true;
    } catch {
      return false;
    }
  }

  private async deliverPassiveNotice(text: string) {
    const trimmed = safeString(text).trim();
    if (!trimmed) return false;
    if (this.shouldSuppressQuietDelivery("passive_notice")) return true;
    if (this.shouldDeferPassiveNotice()) {
      this.pendingPassiveNotices.push(trimmed);
      return true;
    }
    return await this.sendPassiveNoticeNow(trimmed);
  }

  private flushPendingPassiveNotices(_quietMode?: unknown) {
    // Passive notices are progress/status artifacts for the active turn. Once the
    // canonical final is ready, they must not appear as fresh chat messages after
    // the final; any visible progress has already been coalesced into the
    // editable working message and will be cleared by final delivery.
    this.pendingPassiveNotices = [];
  }

  private async finishCompactionNotice() {
    await this.clearCompactionWorkingReaction().catch(() => false);
    this.compactionTurn = null;
  }

  private compactionAckTarget() {
    const incomingMessageId = safeString(
      this.compactionTurn?.ackIncomingMessageId || "",
    ).trim();
    if (!incomingMessageId) return null;
    const replyToMessageId =
      safeString(this.compactionTurn?.ackReplyToMessageId || "").trim() ||
      incomingMessageId;
    return { incomingMessageId, replyToMessageId };
  }

  private async deliverCompactionEndNotice(text: string) {
    const ackTarget = this.compactionAckTarget();
    const coalesceReplyToMessageId = safeString(
      this.compactionTurn?.replyToMessageId || "",
    ).trim();
    const shouldCoalesce = Boolean(this.compactionTurn || this.currentTurn);
    const idempotencyKey = ackTarget
      ? JSON.stringify([
          "compaction_end_ack",
          this.chatKey,
          ackTarget.incomingMessageId,
          ackTarget.replyToMessageId,
          sha256Hex(safeString(text).trim()),
        ])
      : "";
    const delivered = await this.sendPassiveNoticeNow(text, {
      ...(shouldCoalesce
        ? {
            coalesceWithWorkingMessage: true,
            ...(coalesceReplyToMessageId
              ? { replyToMessageId: coalesceReplyToMessageId }
              : {}),
          }
        : {}),
      ...(ackTarget
        ? {
            postDelivery: {
              markProcessed: {
                chatKey: this.chatKey,
                messageId: ackTarget.incomingMessageId,
                bindSession: false,
              },
            },
            id: `compaction-final-${sha256Hex(idempotencyKey)}`,
            idempotencyKey,
            waitForDeliveryMs: 1000,
          }
        : {}),
    });
    await this.finishCompactionNotice();
    return delivered;
  }

  private async deliverCompactionStartNotice(text: string) {
    const trimmed = safeString(text).trim();
    if (!trimmed) return false;
    if (!this.canDeliverReplies()) return true;
    const ackIncomingMessageId = safeString(
      this.activeCommandTurnInput?.incomingMessageId || "",
    ).trim();
    const ackReplyToMessageId =
      safeString(this.activeCommandTurnInput?.replyToMessageId || "").trim() ||
      ackIncomingMessageId;
    const coalesceReplyToMessageId =
      this.currentReplyToMessageId() || ackReplyToMessageId || undefined;
    try {
      const delivery = await this.enqueueAndDrainDelivery(
        {
          createdAt: nowIso(),
          chatKey: this.chatKey,
          deliveryKind: "passive_notice",
          coalesceWithWorkingMessage: true,
          replyToMessageId: coalesceReplyToMessageId,
          parts: [{ type: "text", text: trimmed }],
          ...this.currentConversationSessionPayload(),
        },
        {
          deliveryKind: "passive_notice",
          coalesceWithWorkingMessage: true,
          waitForDeliveryMs: 1000,
        },
      );
      const messageId = safeString(delivery.messageIds[0]).trim();
      if (messageId) {
        this.compactionTurn = {
          startedAt: Date.now(),
          incomingMessageId: messageId,
          replyToMessageId: coalesceReplyToMessageId || messageId,
          workingNoticeSent: false,
          ackIncomingMessageId: ackIncomingMessageId || undefined,
          ackReplyToMessageId: ackReplyToMessageId || undefined,
        };
        const marker = this.startCompactionWorkingMarker().catch(() => false);
        const poll = this.pollCompactionTyping().catch(() => false);
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

  async shutdownSession() {
    this.lastActivityAt = Date.now();
    const wanted = this.getRecoverableSessionFile();
    if (wanted) await this.connect({ restoreSession: true });
    await this.driver.shutdownSession();
    this.currentTurn = null;
    this.compactionTurn = null;
    this.compactionWorkingIndicators = [];
    this.activeCommandTurnInput = null;
    this.pendingSteeredDeliveryTargets = [];
    this.backendAcceptedIncomingMessageId = "";
    this.stagedDelivery = null;
    this.awaitingTurnSettle = false;
    this.externalWorkingVisible = false;
    this.turnAbortRequested = false;
    this.turnAbortGeneration = 0;
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
    const commandPolicy =
      getRinNonInteractiveCommandInteractionPolicy(commandLine);
    const hadActiveTurn = this.hasActiveTurn();
    const abortingActiveTurn =
      commandPolicy.activeTurnHandling === "abort" && hadActiveTurn;
    const interruptingActiveTurn =
      commandPolicy.activeTurnHandling === "interrupt_then_run" &&
      hadActiveTurn;
    if (abortingActiveTurn) {
      this.lastActivityAt = Date.now();
      try {
        this.turnAbortGeneration += 1;
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
        this.pendingSteeredDeliveryTargets = [];
        this.stagedDelivery = null;
        this.saveState();
      }
    }
    const skipSessionRecovery = commandPolicy.skipSessionRecovery;
    // Slash commands are controls; reply-bound session files belong to prompt turns only.
    const explicitSessionFile = "";
    const restoreSessionFile = skipSessionRecovery
      ? ""
      : this.getRecoverableSessionFile();
    const managedSessionLeaf =
      commandPolicy.skipSessionRecovery && commandName === "new"
        ? MANAGED_CHAT_SESSION_LEAF
        : !restoreSessionFile
          ? this.managedSessionLeafForFreshChat()
          : undefined;
    this.lastActivityAt = Date.now();
    if (interruptingActiveTurn) {
      this.turnAbortGeneration += 1;
      this.turnAbortRequested = true;
    }
    this.setActiveCommandTurnInput({ incomingMessageId, replyToMessageId });
    try {
      if (interruptingActiveTurn) {
        await this.connect({ restoreSession: true });
        this.driver.interruptActiveTurnLikeTui();
      }
      await this.connect({ restoreSession: !skipSessionRecovery });
      if (commandPolicy.acceptInboundBeforeExecution) {
        this.markAcceptedMessage(incomingMessageId);
      }

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

      if (commandName === "compact") {
        const text = safeString(data?.text || "").trim();
        return text ? { ...data, text } : data;
      }

      const text = safeString(data?.text || "").trim();
      const parts = Array.isArray(data?.parts)
        ? (data.parts.filter(Boolean) as ChatMessagePart[])
        : [];
      if (!text && !parts.length) throw new Error("chat_command_text_missing");
      data = { ...data, text, ...(parts.length ? { parts } : {}) };
      await this.deliverAssistantReply({
        text,
        parts,
        replyToMessageId: replyToMessageId || undefined,
        incomingMessageId,
        sessionFile: data?.sessionFile,
        clearProcessing: true,
        bindSession: false,
      });
      return data;
    } catch (error: any) {
      const errorMessage =
        safeString(error?.message || error).trim() || "chat_command_failed";
      await this.deliverAssistantReply({
        text: formatRuntimeErrorForChat(errorMessage),
        replyToMessageId: replyToMessageId || undefined,
        incomingMessageId,
        clearProcessing: true,
        bindSession: false,
      });
      throw error;
    } finally {
      this.awaitingTurnSettle = false;
      if (interruptingActiveTurn) this.turnAbortRequested = false;
      await this.clearWorkingReaction().catch(() => {});
      this.clearCurrentTurn();
      if (interruptingActiveTurn) this.pendingSteeredDeliveryTargets = [];
      this.clearActiveCommandTurnInput();
      this.stagedDelivery = null;
      this.saveState();
    }
  }

  async beginExternalWorking() {
    this.externalWorkingVisible = true;
    await this.beginVisibleProcessingTurn({});
  }

  async endExternalWorking() {
    this.externalWorkingVisible = false;
    if (this.driver.hasVisibleChatWorkingTurn()) return;
    this.awaitingTurnSettle = false;
    await this.clearWorkingReaction().catch(() => {});
    this.clearCurrentTurn();
  }

  async runTurn(
    input: RinToolStartupOptions &
      Pick<RinPiPassthroughOptions, "piStartupOptions"> & {
        text: string;
        attachments: SavedAttachment[];
        replyToMessageId?: string;
        incomingMessageId?: string;
        sessionFile?: string;
        sessionName?: string;
        promptMeta?: PromptContextMeta;
        model?: string;
        thinkingLevel?: string;
        managedSessionLeaf?: string;
        createSessionFileIfMissing?: boolean;
        deliverFinal?: boolean;
        disabledRinCapabilities?: string[];
        quietMode?: boolean;
      },
    mode: "prompt" | "steer" = "prompt",
  ) {
    this.rememberPromptChatType(input.promptMeta);
    this.lastActivityAt = Date.now();
    const deliverFinal = input.deliverFinal !== false;
    if (this.canSteerActiveTurn()) {
      const { sessionFile: rawWantedSessionFile } = normalizeSessionRef(input);
      const wantedSessionFile =
        this.resolveSessionFileForUse(rawWantedSessionFile);
      if (
        wantedSessionFile &&
        !input.createSessionFileIfMissing &&
        !sessionFileExists(wantedSessionFile)
      ) {
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
      const submittedText = formatPromptForChatContext(text, input.promptMeta);
      const result = await this.runDriverTurnWithQuietMode(input.quietMode, {
        text: submittedText,
        images,
        sessionFile: wantedSessionFile,
        restoreSessionFile,
        managedSessionLeaf,
        createSessionFileIfMissing: input.createSessionFileIfMissing,
        sessionName: input.sessionName,
        tools: input.tools,
        excludeTools: input.excludeTools,
        noTools: input.noTools,
        disabledRinCapabilities: input.disabledRinCapabilities,
        piStartupOptions: input.piStartupOptions,
        resetModelOptionsFromSettings: true,
        model: input.model,
        thinkingLevel: input.thinkingLevel,
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
      if (result.superseded) {
        return await this.finishSupersededRecoveredTurn(input, result);
      }
      if (result.steered) {
        if (deliverFinal) {
          this.rememberPendingSteeredDeliveryTarget({
            incomingMessageId: input.incomingMessageId,
            replyToMessageId: input.replyToMessageId,
            text,
            submittedText,
          });
        }
        this.backendAcceptedIncomingMessageId = safeString(
          input.incomingMessageId || "",
        ).trim();
        this.markAcceptedMessage(input.incomingMessageId);
        return {
          steered: true,
          sessionId: this.currentSessionId() || undefined,
          sessionFile: this.currentSessionFile(),
        };
      }
      if (deliverFinal) {
        await this.beginVisibleProcessingTurn({
          incomingMessageId: input.incomingMessageId,
          replyToMessageId: input.replyToMessageId,
        });
        const deliveryTarget = this.currentDeliveryTarget(input);
        await this.deliverAssistantReply({
          text: result.finalText,
          replyToMessageId: deliveryTarget.replyToMessageId,
          sessionFile: result.sessionFile,
          incomingMessageId: deliveryTarget.incomingMessageId,
          clearProcessing: true,
        });
        this.markOriginalProcessedIfRetargeted(
          input.incomingMessageId,
          deliveryTarget.incomingMessageId,
        );
        this.awaitingTurnSettle = false;
        await new Promise((resolve) => setImmediate(resolve));
        await this.flushPendingPassiveNotices(input.quietMode);
      }
      return {
        finalText: result.finalText,
        result: result.result,
        sessionId: this.currentSessionId() || undefined,
        sessionFile: this.currentSessionFile(),
      };
    }

    return await this.runExclusiveTurn(async () => {
      const turnAbortGeneration = this.turnAbortGeneration;
      const { sessionFile: rawWantedSessionFile } = normalizeSessionRef(input);
      const wantedSessionFile =
        this.resolveSessionFileForUse(rawWantedSessionFile);
      if (
        wantedSessionFile &&
        !input.createSessionFileIfMissing &&
        !sessionFileExists(wantedSessionFile)
      ) {
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
      if (deliverFinal) {
        await this.beginVisibleProcessingTurn({
          incomingMessageId: input.incomingMessageId,
          replyToMessageId: input.replyToMessageId,
        });
      }
      try {
        if (this.turnAbortGeneration !== turnAbortGeneration) {
          throw new Error("chat_turn_aborted");
        }
        const submittedText = formatPromptForChatContext(
          text,
          input.promptMeta,
        );
        const result = await this.runDriverTurnWithQuietMode(input.quietMode, {
          text: submittedText,
          images,
          sessionFile: wantedSessionFile,
          restoreSessionFile,
          managedSessionLeaf,
          createSessionFileIfMissing: input.createSessionFileIfMissing,
          sessionName: input.sessionName,
          tools: input.tools,
          excludeTools: input.excludeTools,
          noTools: input.noTools,
          disabledRinCapabilities: input.disabledRinCapabilities,
          piStartupOptions: input.piStartupOptions,
          resetModelOptionsFromSettings: true,
          model: input.model,
          thinkingLevel: input.thinkingLevel,
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
        if (result.superseded) {
          return await this.finishSupersededRecoveredTurn(input, result);
        }
        if (result.steered) {
          if (deliverFinal) {
            this.rememberPendingSteeredDeliveryTarget({
              incomingMessageId: input.incomingMessageId,
              replyToMessageId: input.replyToMessageId,
              text,
              submittedText,
            });
          }
          this.backendAcceptedIncomingMessageId = safeString(
            input.incomingMessageId || "",
          ).trim();
          this.markAcceptedMessage(input.incomingMessageId);
          return {
            steered: true,
            sessionId: this.currentSessionId() || undefined,
            sessionFile: this.currentSessionFile(),
          };
        }
        if (deliverFinal) {
          const deliveryTarget = this.currentDeliveryTarget(input);
          await this.deliverAssistantReply({
            text: result.finalText,
            replyToMessageId: deliveryTarget.replyToMessageId,
            sessionFile: result.sessionFile,
            incomingMessageId: deliveryTarget.incomingMessageId,
            clearProcessing: true,
          });
          this.markOriginalProcessedIfRetargeted(
            input.incomingMessageId,
            deliveryTarget.incomingMessageId,
          );
          this.awaitingTurnSettle = false;
          await new Promise((resolve) => setImmediate(resolve));
          await this.flushPendingPassiveNotices(input.quietMode);
        }
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
          const ownsCurrentTurn = this.hasCurrentTurnMatching(
            input.incomingMessageId,
          );
          const abortedSession = normalizeSessionRef(error);
          this.markProcessedMessage(input.incomingMessageId, false);
          await this.clearWorkingReactionFor(input.incomingMessageId);
          this.clearCurrentTurnFor(input.incomingMessageId);
          if (ownsCurrentTurn) {
            this.awaitingTurnSettle = false;
            this.turnAbortRequested = false;
            this.pendingSteeredDeliveryTargets = [];
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
        if (errorMessage !== "chat_restored_session_mismatch") {
          const errorSessionFile = this.updateStoredSessionFile(
            errorSession.sessionFile,
            this.driver.currentSessionFile(),
          );
          if (errorSession.sessionFile && errorMessage) {
            const deliveryTarget = this.currentDeliveryTarget(input);
            await this.deliverAssistantReply({
              text: formatRuntimeErrorForChat(errorMessage),
              replyToMessageId: deliveryTarget.replyToMessageId,
              incomingMessageId: deliveryTarget.incomingMessageId,
              sessionFile: errorSessionFile || this.currentSessionFile(),
              clearProcessing: true,
            });
            this.markOriginalProcessedIfRetargeted(
              input.incomingMessageId,
              deliveryTarget.incomingMessageId,
            );
            this.awaitingTurnSettle = false;
          }
        }
        const ownsCurrentTurn = this.hasCurrentTurnMatching(
          input.incomingMessageId,
        );
        await this.clearWorkingReactionFor(input.incomingMessageId);
        this.clearCurrentTurnFor(input.incomingMessageId);
        if (ownsCurrentTurn) {
          this.awaitingTurnSettle = false;
          this.turnAbortRequested = false;
          this.pendingSteeredDeliveryTargets = [];
          this.stagedDelivery = null;
        }
        this.saveState();
        throw error;
      } finally {
        if (this.hasCurrentTurnMatching(input.incomingMessageId)) {
          this.awaitingTurnSettle = false;
          this.turnAbortRequested = false;
        }
      }
    });
  }

  async housekeep() {
    await this.pollTyping().catch(() => {});
    await this.pollCompactionTyping().catch(() => {});
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
        if (event.phase === "working") {
          if (this.driver.hasExplicitWorkingVisible()) {
            this.externalWorkingVisible = true;
          }
          const createdCommandTurn = this.ensureVisibleCommandTurn();
          this.markAcceptedMessage(this.currentIncomingMessageId());
          if (createdCommandTurn) await this.pollTyping().catch(() => false);
        }
        if (event.phase === "idle") {
          this.externalWorkingVisible = false;
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
      case "user_message_start":
        await this.activatePendingSteeredDeliveryTarget(event.text);
        return;
      case "passive_notice":
        if (event.noticeKind === "compaction_end") {
          await this.deliverCompactionEndNotice(event.text);
          return;
        }
        if (event.noticeKind === "todo" && event.deferDuringTurn === false) {
          await this.sendTodoPassiveNoticeNow(event);
          return;
        }
        if (event.deferDuringTurn === false) {
          await this.sendPassiveNoticeNow(event.text);
          return;
        }
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
