import crypto from "node:crypto";
import path from "node:path";

import {
  RinDaemonFrontendClient,
  RinFrontendTurnDriver,
  chatFrontendIdentity,
  frontendCommandNameFromLine,
  getRinNonInteractiveCommandInteractionPolicy,
  RIN_EMPTY_AGENT_RESPONSE_ERROR,
  type RinFrontendEventHandlingFailure,
  type RinFrontendIdentity,
  type RinFrontendTurnClient,
  type RinChatDeliveryContext,
} from "../rin-frontend-sdk/index.js";
import type { PromptContextMeta } from "../rin-lib/prompt-context.js";
import { MANAGED_CHAT_SESSION_LEAF } from "../session/managed-paths.js";
import { nowIso } from "../time-utils.js";
import type { RinToolStartupOptions } from "../rin-lib/tool-options.js";
import type { RinPiPassthroughOptions } from "../rin-lib/pi-passthrough.js";
import {
  applyChatBuiltinCommandText,
  resolveChatCommandResponses,
  type ChatCommandResponses,
} from "./command-responses.js";
import {
  firstSessionValue,
  missingSessionFileError,
  normalizeSessionRef,
  resolveSessionFileForUse,
  resolveStoredSessionFile,
  sessionFileExists,
  sessionFilesMatch,
  toStoredSessionFile,
} from "../session/ref.js";
import {
  chatStatePath,
  findBot,
  parseChatKey,
  readJsonFileOrDefault,
  writeJsonFile,
} from "./support.js";
import {
  ChatState,
  SavedAttachment,
  markProcessedChatMessage,
  safeString,
} from "./chat-helpers.js";
import type {
  ChatMessagePart,
  ChatOutboxTurnFence,
} from "../rin-lib/chat-outbox-contract.js";
import {
  enqueueChatOutboxPayload,
  getActiveChatOutboxTurnFence,
  isChatOutboxTurnFenceActive,
  readChatOutboxItemById,
  waitForChatOutboxDelivery,
} from "./outbox.js";
import { applyPostDelivery, drainChatOutbox } from "./boot.js";
import {
  formatChatErrorDelivery,
  formatChatErrorParts,
  hashChatErrorDeliveryContent,
} from "./error-presentation.js";
import { assistantDeliveryParts } from "./terminal-delivery.js";
import {
  buildChatAssistantDelivery,
  conversationSessionPayload,
  withChatQuotePart,
  type ChatAssistantDelivery,
} from "./delivery-presentation.js";
import {
  advanceChatGeneration,
  markChatMessageAcceptedWithFence,
  openChatDatabase,
  readChatSessionBinding,
  readLatestJoinedChatPresentation,
  writeChatSessionBinding,
  writeChatSessionBindingWithFence,
} from "./database.js";
import {
  clearReaction,
  restorePromptParts,
  sendReaction,
  validateChatOutboxPayloadForDispatch,
  WAITING_REACTION_EMOJI,
} from "./transport.js";
import { resolveChatQuietModeEnabled } from "./settings.js";
import { projectChatExtensionUiRequest } from "./extension-ui.js";
import {
  chatDeliveryOutcome,
  normalizeAssistantSummaryText,
  presentInterimText,
  shouldDeferPassiveNotice,
  shouldSuppressQuietDelivery,
  type ChatDeliveryOutcome,
} from "./delivery-policy.js";
import { presentTodoNotice } from "./todo-presentation.js";
import { readTodoSnapshotFromSessionFile } from "../rin-lib/todo-state.js";
import {
  findEditableWorkingIndicator,
  isWorkingIndicatorPollDue,
  normalizeWorkingIndicators,
  selectTypingIndicatorsForKind,
  selectVisibleWorkingIndicatorsForKind,
  selectWorkingIndicatorsForEnd,
  selectWorkingIndicatorsForKind,
  workingIndicatorPolicy,
  workingIndicatorPresentation,
  type WorkingIndicator,
} from "./working-indicator-policy.js";

const TYPING_FAILURE_WARNING_INTERVAL_MS = 30_000;

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
  requestTag?: string;
  commandName?: string;
  outboxTurnFence?: ChatOutboxTurnFence;
};

type ChatCommandTurnInput = Readonly<ChatTurnTarget>;

type PendingTurnPresentation = ChatTurnTarget & {
  backendAccepted: boolean;
  joinedOwnerTurnId?: string;
  sessionFile?: string;
};

type ChatTurnMeta = ChatTurnTarget & {
  workingNoticeSent?: boolean;
  startedAt: number;
  receivedAtMs?: number;
  frontendReadyAt?: number;
  startupTimingLogged?: boolean;
};

export class ChatController {
  app: any;
  chatKey: string;
  dataDir: string;
  agentDir: string;
  statePath: string;
  state: ChatState;
  driver: RinFrontendTurnDriver;
  frontendClientFactory?: () => RinFrontendTurnClient;
  logger: any;
  h: any;
  affectChatBinding: boolean;
  linkDeliveriesToSession: boolean;
  private readonly waitingReactionsByRequestTag = new Map<string, string>();
  private readonly waitingReactionCreatesByRequestTag = new Map<
    string,
    Promise<boolean>
  >();
  private readonly waitingReactionClearsByRequestTag = new Map<
    string,
    Promise<boolean>
  >();
  private readonly startedReactionRequestTags = new Set<string>();
  private readonly deferredWorkingReactionRequestTags = new Set<string>();
  lastWorkingIndicatorAt = 0;
  lastTypingIndicatorAt = 0;
  lastTypingFailureWarningAt = 0;
  activeWorkingIndicators: WorkingIndicator[] = [];
  workingIndicatorTick = 0;
  currentTurn: ChatTurnMeta | null = null;
  private presentationIncomingMessageId = "";
  private presentationReplyToMessageId = "";
  compactionTurn: ChatTurnMeta | null = null;
  compactionWorkingIndicators: WorkingIndicator[] = [];
  editableCompactionStatusText = "";
  editableCompactionRestorePending = false;
  lastCompactionIndicatorAt = 0;
  lastCompactionTypingIndicatorAt = 0;
  compactionIndicatorTick = 0;
  activeCommandTurnInput: ChatCommandTurnInput | null = null;
  private collectingCommandUi = false;
  private commandUiMessages: string[] = [];
  private commandUiParts: ChatMessagePart[] = [];
  backendAcceptedIncomingMessageId = "";
  private pendingTurnPresentations = new Map<string, PendingTurnPresentation>();
  stagedDelivery: ChatAssistantDelivery | null = null;
  pendingPassiveNotices: string[] = [];
  latestTodoNoticeText = "";
  todoFallbackOwner = "";
  todoFallbackHash = "";
  todoFallbackRevision = 0;
  todoDeliveryQueue: Promise<void> = Promise.resolve();
  latestAssistantSummaryText = "";
  awaitingTurnSettle = false;
  sleepAfterIdleMs = 0;
  lastActivityAt = Date.now();
  commandResponses: {
    baseline: ChatCommandResponses;
    current: ChatCommandResponses;
  };
  onWorkingMessage?: (message: string) => void;
  quietModeOverride?: boolean;

  constructor(
    app: any,
    dataDir: string,
    chatKey: string,
    deps: {
      logger: any;
      h: any;
      affectChatBinding?: boolean;
      linkDeliveriesToSession?: boolean;
      statePath?: string;
      frontendClientFactory?: () => RinFrontendTurnClient;
      sleepAfterIdleMs?: number;
      commandResponses?: Partial<ChatCommandResponses>;
      frontendIdentity?: RinFrontendIdentity;
      useChatFrontendIdentity?: boolean;
      onWorkingMessage?: (message: string) => void;
    },
  ) {
    this.app = app;
    this.chatKey = chatKey;
    this.dataDir = dataDir;
    this.agentDir = path.resolve(dataDir, "..");
    this.affectChatBinding = deps.affectChatBinding !== false;
    this.linkDeliveriesToSession =
      deps.linkDeliveriesToSession ?? this.affectChatBinding;
    this.statePath =
      deps.statePath || statePathForControllerKey(dataDir, chatKey);
    this.state = readJsonFileOrDefault<ChatState>(this.statePath, { chatKey });
    const persistedChatKey = safeString(this.state.chatKey).trim();
    if (persistedChatKey && persistedChatKey !== chatKey) {
      this.state = { chatKey };
    }
    if (this.affectChatBinding && parseChatKey(chatKey)) {
      this.state.sessionFile =
        readChatSessionBinding(this.agentDir, chatKey) || undefined;
    }
    // Unconfirmed submissions are transport-local. Durable ownership remains
    // in the SQLite transport ledger and is never reconstructed from controller JSON.
    this.logger = deps.logger;
    this.h = deps.h;
    this.sleepAfterIdleMs = Math.max(0, Number(deps.sleepAfterIdleMs || 0));
    this.frontendClientFactory = deps.frontendClientFactory;
    const commandResponseBaseline = resolveChatCommandResponses(
      deps.commandResponses,
    );
    this.commandResponses = {
      baseline: commandResponseBaseline,
      current: commandResponseBaseline,
    };
    this.onWorkingMessage = deps.onWorkingMessage;
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
      onEventHandlingError: (failure) =>
        this.reportFrontendEventHandlingFailure(failure),
    });
    this.driver.subscribe(async (event) => {
      await this.handleFrontendEvent(event);
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

  async connect(
    options: {
      restoreSession?: boolean;
      restoreSessionFile?: string;
      recoverTerminals?: boolean;
    } = {},
  ) {
    const restoreSessionFile =
      options.restoreSession === false
        ? ""
        : options.restoreSessionFile !== undefined
          ? resolveSessionFileForUse(this.agentDir, options.restoreSessionFile)
          : this.getRecoverableSessionFile();
    const connected = await this.driver.connect({ restoreSessionFile });
    if (this.affectChatBinding && restoreSessionFile) {
      this.updateStoredSessionFile(
        this.driver.currentSessionFile(),
        restoreSessionFile,
      );
      this.saveState();
    }
    if (connected && options.recoverTerminals !== false) {
      await this.driver.recoverUnacknowledgedChatTerminals(this.chatKey);
    }
    return connected;
  }

  dispose() {
    this.lastActivityAt = Date.now();
    void this.clearWorkingReaction().catch(() => {});
    void this.clearCompactionWorkingReaction().catch(() => {});
    void this.clearAllWaitingReactions().catch(() => {});
    this.currentTurn = null;
    this.presentationIncomingMessageId = "";
    this.presentationReplyToMessageId = "";
    this.compactionTurn = null;
    this.compactionWorkingIndicators = [];
    this.activeCommandTurnInput = null;
    this.startedReactionRequestTags.clear();
    this.deferredWorkingReactionRequestTags.clear();
    this.backendAcceptedIncomingMessageId = "";
    this.stagedDelivery = null;
    this.awaitingTurnSettle = false;
    this.pendingTurnPresentations.clear();
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
    this.stagedDelivery = null;
    await this.clearWorkingReaction().catch(() => {});
    await this.clearCompactionWorkingReaction().catch(() => {});
    await this.clearAllWaitingReactions().catch(() => {});
    this.currentTurn = null;
    this.presentationIncomingMessageId = "";
    this.presentationReplyToMessageId = "";
    this.compactionTurn = null;
    this.compactionWorkingIndicators = [];
    this.activeCommandTurnInput = null;
    this.startedReactionRequestTags.clear();
    this.deferredWorkingReactionRequestTags.clear();
    this.backendAcceptedIncomingMessageId = "";
    this.pendingTurnPresentations.clear();
    this.saveState();
  }

  private currentIncomingMessageId() {
    return safeString(this.currentTurn?.incomingMessageId || "").trim();
  }

  private currentPresentationIncomingMessageId() {
    return safeString(
      this.presentationIncomingMessageId ||
        this.currentTurn?.incomingMessageId ||
        "",
    ).trim();
  }

  private pendingIncomingMessageId(requestTag: string) {
    return (
      safeString(
        this.pendingTurnPresentations.get(requestTag)?.incomingMessageId,
      ).trim() || this.currentPresentationIncomingMessageId()
    );
  }

  private async showWaitingReaction(requestTagValue: string) {
    const requestTag = safeString(requestTagValue).trim();
    if (
      !requestTag ||
      this.startedReactionRequestTags.has(requestTag) ||
      this.waitingReactionCreatesByRequestTag.has(requestTag) ||
      this.waitingReactionsByRequestTag.has(requestTag)
    ) {
      return false;
    }
    const messageId = this.pendingIncomingMessageId(requestTag);
    if (!messageId) return false;
    const create = (async () => {
      await this.clearReactionWorkingIndicatorFor(messageId);
      if (this.startedReactionRequestTags.has(requestTag)) return false;
      const sent = await sendReaction(
        this.app,
        this.chatKey,
        messageId,
        WAITING_REACTION_EMOJI,
      ).catch(() => false);
      if (sent) this.waitingReactionsByRequestTag.set(requestTag, messageId);
      return sent;
    })();
    this.waitingReactionCreatesByRequestTag.set(requestTag, create);
    try {
      return await create;
    } finally {
      if (this.waitingReactionCreatesByRequestTag.get(requestTag) === create) {
        this.waitingReactionCreatesByRequestTag.delete(requestTag);
      }
    }
  }

  private async clearWaitingReaction(requestTagValue: string) {
    const requestTag = safeString(requestTagValue).trim();
    if (!requestTag) return false;
    const pendingClear = this.waitingReactionClearsByRequestTag.get(requestTag);
    if (pendingClear) return await pendingClear;
    const pendingCreate =
      this.waitingReactionCreatesByRequestTag.get(requestTag);
    if (pendingCreate) {
      const created = await pendingCreate.catch(() => false);
      if (!created && !this.waitingReactionsByRequestTag.has(requestTag)) {
        return true;
      }
    }
    const messageId = this.waitingReactionsByRequestTag.get(requestTag);
    if (!messageId) return false;
    const clear = clearReaction(
      this.app,
      this.chatKey,
      messageId,
      WAITING_REACTION_EMOJI,
    ).catch(() => false);
    this.waitingReactionClearsByRequestTag.set(requestTag, clear);
    let cleared = false;
    try {
      cleared = await clear;
      return cleared;
    } finally {
      if (this.waitingReactionClearsByRequestTag.get(requestTag) === clear) {
        this.waitingReactionClearsByRequestTag.delete(requestTag);
        if (
          cleared &&
          this.waitingReactionsByRequestTag.get(requestTag) === messageId
        ) {
          this.waitingReactionsByRequestTag.delete(requestTag);
        }
      }
    }
  }

  private async clearAllWaitingReactions(
    options: { startDeferredWorking?: boolean } = {},
  ) {
    const requestTags = [
      ...new Set([
        ...this.waitingReactionCreatesByRequestTag.keys(),
        ...this.waitingReactionsByRequestTag.keys(),
      ]),
    ];
    const results = await Promise.all(
      requestTags.map(async (requestTag) => ({
        requestTag,
        cleared: await this.clearWaitingReaction(requestTag),
      })),
    );
    if (options.startDeferredWorking) {
      for (const result of results) {
        if (result.cleared) {
          await this.startDeferredWorkingReaction(result.requestTag);
        }
      }
    }
    return results.some((result) => result.cleared);
  }

  private async startDeferredWorkingReaction(requestTagValue: string) {
    const requestTag = safeString(requestTagValue).trim();
    if (
      !requestTag ||
      !this.deferredWorkingReactionRequestTags.has(requestTag) ||
      !this.startedReactionRequestTags.has(requestTag) ||
      safeString(this.currentTurn?.requestTag).trim() !== requestTag
    ) {
      return false;
    }
    this.deferredWorkingReactionRequestTags.delete(requestTag);
    return await this.startBackendAcceptedWorkingReaction();
  }

  private async startBackendAcceptedWorkingReaction() {
    if (!this.canDeliverReplies() || !this.currentIncomingMessageId()) {
      return false;
    }
    const indicators = selectVisibleWorkingIndicatorsForKind(
      this.getWorkingIndicators(),
      "polling",
    ).filter(
      (indicator) => workingIndicatorPresentation(indicator) === "reaction",
    );
    if (!indicators.length) return false;
    const context = this.workingIndicatorContext({
      event: "tick",
      workingStarted: true,
    });
    const results = await this.pollWorkingIndicators(
      indicators,
      context,
      Date.now(),
    );
    return results.some(Boolean);
  }

  private currentReplyToMessageId() {
    return safeString(
      this.presentationReplyToMessageId ||
        this.presentationIncomingMessageId ||
        this.currentTurn?.replyToMessageId ||
        this.currentTurn?.incomingMessageId ||
        "",
    ).trim();
  }

  private requestTagForInboundMessage(
    messageId?: string,
    fence?: ChatOutboxTurnFence,
  ) {
    const normalizedMessageId = safeString(messageId).trim();
    if (!normalizedMessageId) return "";
    return `chat-inbox-${sha256Hex(
      JSON.stringify([this.chatKey, normalizedMessageId, fence?.turnId || ""]),
    )}`;
  }

  private joinedOwnerTurnIdForRequestTag(requestTag: string) {
    const normalizedRequestTag = safeString(requestTag).trim();
    if (!normalizedRequestTag) return "";
    const rows = openChatDatabase(this.agentDir)
      .prepare(
        `SELECT record_key, message_id FROM messages
         WHERE chat_key = ? AND message_id IS NOT NULL`,
      )
      .all(this.chatKey) as Array<{
      record_key?: string;
      message_id?: string;
    }>;
    const matching = rows.filter((row) => {
      const turnId = safeString(row.record_key).trim();
      const messageId = safeString(row.message_id).trim();
      return (
        turnId &&
        messageId &&
        `chat-inbox-${sha256Hex(
          JSON.stringify([this.chatKey, messageId, turnId]),
        )}` === normalizedRequestTag
      );
    });
    return matching.length === 1
      ? safeString(matching[0]?.record_key).trim()
      : "";
  }

  private authoritativeTerminalEvent(
    event: {
      requestTag?: string;
      chatDeliveryContext?: RinChatDeliveryContext;
      terminalRecord?: {
        terminalId: string;
        state: "complete" | "error" | "interrupted";
        terminalAt?: string;
      };
    },
    terminalKind: "complete" | "error",
  ) {
    const context = event.chatDeliveryContext;
    const requestTag = safeString(event.requestTag).trim();
    const terminalId = safeString(event.terminalRecord?.terminalId).trim();
    const terminalState = safeString(event.terminalRecord?.state).trim();
    if (!context || !requestTag || !terminalId) {
      throw new Error("chat_terminal_record_missing");
    }
    if (
      context.chatKey !== this.chatKey ||
      !safeString(context.turnId).trim() ||
      !safeString(context.messageId).trim() ||
      (terminalKind === "complete" && terminalState !== "complete") ||
      (terminalKind === "error" &&
        terminalState !== "error" &&
        terminalState !== "interrupted")
    ) {
      throw new Error("chat_terminal_delivery_mismatch");
    }
    return event;
  }

  private terminalDeliveryTarget(context: RinChatDeliveryContext) {
    const joined = readLatestJoinedChatPresentation(
      this.agentDir,
      context.turnId,
    );
    const messageId =
      joined?.chatKey === context.chatKey
        ? safeString(joined.messageId).trim() || context.messageId
        : context.messageId;
    return {
      incomingMessageId: messageId,
      replyToMessageId: messageId,
      outboxTurnFence: undefined,
    };
  }

  private currentPresentationForTerminal(
    context: RinChatDeliveryContext,
  ): ChatTurnMeta | null {
    const turn = this.currentTurn;
    if (
      !turn ||
      safeString(turn.outboxTurnFence?.turnId).trim() !== context.turnId ||
      safeString(turn.incomingMessageId).trim() !== context.messageId
    ) {
      return null;
    }
    return turn;
  }

  private acceptsScopedTurnEvent(requestTag?: string) {
    if (!this.currentTurn?.outboxTurnFence) return true;
    const actual = safeString(requestTag).trim();
    if (!actual) return true;
    const expected = safeString(this.currentTurn.requestTag).trim();
    if (expected && expected === actual) return true;
    return Boolean(this.pendingTurnPresentations.get(actual)?.backendAccepted);
  }

  private acceptsOwnedProgressEvent(requestTag?: string) {
    if (!this.currentTurn) return false;
    const actual = safeString(requestTag).trim();
    if (!actual) return true;
    const expected = safeString(this.currentTurn.requestTag).trim();
    if (expected && expected === actual) return true;
    return Boolean(this.pendingTurnPresentations.get(actual)?.backendAccepted);
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
    return this.awaitingTurnSettle || this.driver.hasActiveTurn();
  }

  getChatSessionStatusSnapshot() {
    return {
      sessionFile: this.currentSessionFile(),
      localTurnActive: this.hasActiveTurn(),
    };
  }

  private setCurrentTurn(input: {
    incomingMessageId?: string;
    replyToMessageId?: string;
    receivedAt?: string;
    requestTag?: string;
    outboxTurnFence?: ChatOutboxTurnFence;
  }) {
    this.latestTodoNoticeText = "";
    this.latestAssistantSummaryText = "";
    this.editableCompactionStatusText = "";
    const nextIncomingMessageId =
      safeString(input.incomingMessageId || "").trim() || undefined;
    const nextReplyToMessageId =
      safeString(input.replyToMessageId || "").trim() || undefined;
    const receivedAtMs = Date.parse(safeString(input.receivedAt).trim());
    this.currentTurn = {
      startedAt: Date.now(),
      incomingMessageId: nextIncomingMessageId,
      replyToMessageId: nextReplyToMessageId,
      ...(Number.isFinite(receivedAtMs) ? { receivedAtMs } : {}),
      requestTag: safeString(input.requestTag).trim() || undefined,
      outboxTurnFence: input.outboxTurnFence,
      workingNoticeSent: false,
    };
    const joinedPresentation = input.outboxTurnFence?.turnId
      ? readLatestJoinedChatPresentation(
          this.agentDir,
          input.outboxTurnFence.turnId,
        )
      : null;
    const joinedMessageId =
      joinedPresentation?.chatKey === this.chatKey
        ? safeString(joinedPresentation.messageId).trim()
        : "";
    this.presentationIncomingMessageId =
      joinedMessageId || nextIncomingMessageId || "";
    this.presentationReplyToMessageId =
      joinedMessageId || nextReplyToMessageId || nextIncomingMessageId || "";
    this.backendAcceptedIncomingMessageId = "";
  }

  private setJoinedPresentation(input: {
    incomingMessageId?: string;
    replyToMessageId?: string;
  }) {
    const incomingMessageId = safeString(input.incomingMessageId).trim();
    if (!incomingMessageId) return;
    this.presentationIncomingMessageId = incomingMessageId;
    this.presentationReplyToMessageId =
      safeString(input.replyToMessageId).trim() || incomingMessageId;
  }

  private hasUnacceptedPendingPresentationReplacement() {
    const currentMessageId = this.currentIncomingMessageId();
    return Array.from(this.pendingTurnPresentations.values()).some(
      (pending) => {
        const pendingMessageId = safeString(pending.incomingMessageId).trim();
        return Boolean(
          !pending.backendAccepted &&
          pendingMessageId &&
          pendingMessageId !== currentMessageId,
        );
      },
    );
  }

  private async adoptBackendAcceptedPendingPresentation(
    requestTag: string,
    input: { sessionFile?: string } = {},
  ) {
    const pending = this.pendingTurnPresentations.get(requestTag);
    if (!pending || pending.backendAccepted) return pending;
    const sessionFile =
      safeString(input.sessionFile).trim() ||
      safeString(pending.sessionFile).trim();
    if (
      pending.outboxTurnFence &&
      (!sessionFile ||
        (input.sessionFile &&
          pending.sessionFile &&
          !sessionFilesMatch(
            this.agentDir,
            input.sessionFile,
            pending.sessionFile,
          )))
    ) {
      throw new Error("chat_turn_fence_lost");
    }
    const previousIncomingMessageId = this.currentIncomingMessageId();
    const previousReplyToMessageId = this.currentReplyToMessageId();
    const previousWorkingIndicators = this.activeWorkingIndicators.length
      ? [...this.activeWorkingIndicators]
      : this.getWorkingIndicators();
    const ownerTurnId = safeString(pending.joinedOwnerTurnId).trim();
    const accepted = sessionFile
      ? this.markAcceptedMessage(pending.incomingMessageId, {
          sessionFile,
          joinedTurnId: ownerTurnId || undefined,
        })
      : undefined;
    if (pending.outboxTurnFence && (!ownerTurnId || accepted !== true)) {
      throw new Error("chat_turn_fence_lost");
    }
    this.setJoinedPresentation(pending);
    this.backendAcceptedIncomingMessageId = safeString(
      pending.incomingMessageId,
    ).trim();
    pending.backendAccepted = true;
    if (
      previousIncomingMessageId &&
      previousIncomingMessageId !== pending.incomingMessageId
    ) {
      const hasEndIndicator =
        selectWorkingIndicatorsForEnd(previousWorkingIndicators).length > 0;
      const cleared = await this.endWorkingIndicatorsForTurn(
        previousWorkingIndicators,
        {
          incomingMessageId: previousIncomingMessageId,
          replyToMessageId: previousReplyToMessageId,
          endReason: "presentation_transferred",
        },
      );
      this.activeWorkingIndicators = [];
      this.lastWorkingIndicatorAt = 0;
      this.lastTypingIndicatorAt = 0;
      this.workingIndicatorTick = 0;
      this.latestAssistantSummaryText = "";
      if (this.currentTurn) this.currentTurn.workingNoticeSent = false;
      if (hasEndIndicator && !cleared) {
        this.logger.warn(
          `chat previous presentation cleanup failed chatKey=${this.chatKey} messageId=${previousIncomingMessageId}`,
        );
      }
    }
    if (
      this.driver.isWorking() &&
      !this.hasUnacceptedPendingPresentationReplacement()
    ) {
      void this.pollTyping().catch(() => {});
    }
    return pending;
  }

  private async prepareTurnPrompt(
    input: {
      text: string;
      attachments: SavedAttachment[];
      incomingMessageId?: string;
      replyToMessageId?: string;
      receivedAt?: string;
      requestTag?: string;
      outboxTurnFence?: ChatOutboxTurnFence;
    },
    deliverFinal: boolean,
  ) {
    let primedTurn: ChatTurnMeta | null = null;
    const shouldRestoreDurableTurn = Boolean(
      deliverFinal &&
      input.outboxTurnFence &&
      !this.currentTurn?.outboxTurnFence,
    );
    if (deliverFinal && (!this.currentTurn || shouldRestoreDurableTurn)) {
      // Install reply identity before reconnect can replay progress. connect()
      // temporarily yields that identity only while draining older terminals.
      this.setCurrentTurn(input);
      primedTurn = this.currentTurn;
      this.awaitingTurnSettle = true;
    }
    try {
      const frontendReady = await this.connect();
      if (this.currentTurn) this.currentTurn.frontendReadyAt = Date.now();
      await this.preloadEditableTodoPresentation();
      return {
        ...(await restorePromptParts({
          text: input.text,
          attachments: input.attachments,
          startedAt: Date.now(),
        })),
        frontendReady,
      };
    } catch (error) {
      if (primedTurn && this.currentTurn === primedTurn) {
        this.awaitingTurnSettle = false;
        this.clearCurrentTurn();
      }
      throw error;
    }
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

  private async clearReactionWorkingIndicatorFor(messageIdValue: string) {
    const messageId = safeString(messageIdValue).trim();
    if (!messageId) return false;
    const indicators = this.getWorkingIndicators().filter(
      (indicator) => workingIndicatorPresentation(indicator) === "reaction",
    );
    const context = this.workingIndicatorContext({
      event: "end",
      messageId,
    });
    const results = await Promise.all(
      indicators.map((indicator) =>
        this.callWorkingIndicator(indicator, "end", context),
      ),
    );
    return results.some(Boolean);
  }

  private clearCurrentTurn() {
    const requestTag = safeString(this.currentTurn?.requestTag).trim();
    if (requestTag) {
      this.startedReactionRequestTags.delete(requestTag);
      this.deferredWorkingReactionRequestTags.delete(requestTag);
    }
    this.currentTurn = null;
    this.presentationIncomingMessageId = "";
    this.presentationReplyToMessageId = "";
    this.backendAcceptedIncomingMessageId = "";
    this.latestAssistantSummaryText = "";
    this.editableCompactionStatusText = "";
    this.editableCompactionRestorePending = false;
  }

  private setActiveCommandTurnInput(input: {
    incomingMessageId?: string;
    replyToMessageId?: string;
    requestTag?: string;
    commandName?: string;
    outboxTurnFence?: ChatOutboxTurnFence;
  }) {
    const outboxTurnFence =
      input.outboxTurnFence || getActiveChatOutboxTurnFence();
    const commandTurnInput = Object.freeze({
      incomingMessageId:
        safeString(input.incomingMessageId || "").trim() || undefined,
      replyToMessageId:
        safeString(input.replyToMessageId || "").trim() || undefined,
      requestTag:
        safeString(input.requestTag).trim() ||
        this.requestTagForInboundMessage(
          input.incomingMessageId,
          outboxTurnFence,
        ),
      commandName: safeString(input.commandName).trim() || undefined,
      outboxTurnFence,
    });
    this.activeCommandTurnInput = commandTurnInput;
    return commandTurnInput;
  }

  private clearActiveCommandTurnInput() {
    this.activeCommandTurnInput = null;
  }

  private ownsManualCompactionPresentation() {
    return this.activeCommandTurnInput?.commandName === "compact";
  }

  ownsOutboxTurnFence(fence?: ChatOutboxTurnFence) {
    if (!fence) return false;
    const matches = (candidate?: ChatOutboxTurnFence) =>
      Boolean(
        candidate &&
        safeString(candidate.turnId).trim() ===
          safeString(fence.turnId).trim() &&
        safeString(candidate.ownerEpoch).trim() ===
          safeString(fence.ownerEpoch).trim() &&
        Number(candidate.attempt) === Number(fence.attempt),
      );
    return (
      matches(this.currentTurn?.outboxTurnFence) ||
      matches(this.activeCommandTurnInput?.outboxTurnFence)
    );
  }

  ownsAuthoritativeTerminalProjection(terminal: Record<string, unknown>) {
    const terminalRequestTag = safeString(terminal?.requestTag).trim();
    const activeRequestTag = safeString(this.currentTurn?.requestTag).trim();
    return Boolean(
      terminalRequestTag &&
      activeRequestTag &&
      terminalRequestTag === activeRequestTag,
    );
  }

  ownsInboundMessage(messageId?: string) {
    return (
      this.claimsInboundMessage(messageId) ||
      this.hasBackendAcceptedInboundMessage(messageId)
    );
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
      messageId: this.currentPresentationIncomingMessageId() || undefined,
      replyToMessageId: this.currentReplyToMessageId() || undefined,
      tick: this.workingIndicatorTick,
      todoNoticeText: this.latestTodoNoticeText || undefined,
      assistantSummaryText: this.latestAssistantSummaryText || undefined,
      ...extra,
    };
  }

  private compactionWorkingIndicatorContext(extra: Record<string, any> = {}) {
    return this.workingIndicatorContext({
      messageId: this.compactionTurn?.incomingMessageId || undefined,
      replyToMessageId: this.compactionTurn?.replyToMessageId || undefined,
      tick: this.compactionIndicatorTick,
      ...(this.editableCompactionStatusText
        ? { workingStatusText: this.editableCompactionStatusText }
        : {}),
      ...extra,
    });
  }

  private async preloadEditableTodoPresentation() {
    if (!findEditableWorkingIndicator(this.getWorkingIndicators())) return;
    const snapshot = await readTodoSnapshotFromSessionFile(
      this.driver.currentSessionFile(),
    );
    if (!snapshot) return;
    this.latestTodoNoticeText =
      snapshot.todos.length > 0 && snapshot.pendingCount > 0
        ? presentTodoNotice(this.chatKey, snapshot.todos, "").text
        : "";
    if (
      this.driver.isWorking() &&
      this.currentTurn &&
      this.awaitingTurnSettle
    ) {
      await this.refreshEditableWorkingNotice({ force: true }).catch(
        () => false,
      );
    }
  }

  private canDeliverReplies() {
    const parsed = parseChatKey(this.chatKey);
    if (!parsed) return false;
    return Boolean(findBot(this.app, parsed.platform, parsed.botId));
  }

  private chatPlatform() {
    return parseChatKey(this.chatKey)?.platform.toLowerCase() || "";
  }

  private warnTypingIndicatorFailure(error: unknown, now = Date.now()) {
    if (
      this.lastTypingFailureWarningAt > 0 &&
      now - this.lastTypingFailureWarningAt < TYPING_FAILURE_WARNING_INTERVAL_MS
    ) {
      return;
    }
    this.lastTypingFailureWarningAt = now;
    this.logger.warn(
      `chat typing indicator failed chatKey=${this.chatKey} err=${safeString(
        (error as any)?.message || error,
      )}`,
    );
  }

  private async pollWorkingIndicators(
    indicators: WorkingIndicator[],
    context: Record<string, any>,
    now: number,
  ) {
    return await Promise.all(
      indicators.map(async (indicator) => {
        try {
          return Boolean(
            await this.callWorkingIndicator(indicator, "tick", context),
          );
        } catch (error) {
          if (workingIndicatorPresentation(indicator) === "typing") {
            this.warnTypingIndicatorFailure(error, now);
          }
          return false;
        }
      }),
    );
  }

  private isQuietModeEnabled() {
    if (this.quietModeOverride !== undefined) return this.quietModeOverride;
    return resolveChatQuietModeEnabled(
      readJsonFileOrDefault(path.join(this.agentDir, "settings.json"), {}),
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

  private async endWorkingIndicatorsForTurn(
    indicators: WorkingIndicator[],
    input: {
      incomingMessageId?: string;
      replyToMessageId?: string;
      endReason?: "presentation_transferred";
    },
  ) {
    const incomingMessageId = safeString(input.incomingMessageId).trim();
    const replyToMessageId =
      safeString(input.replyToMessageId).trim() || incomingMessageId;
    const context = this.workingIndicatorContext({
      event: "end",
      messageId: incomingMessageId || undefined,
      replyToMessageId: replyToMessageId || undefined,
      endReason: input.endReason,
    });
    const results = await Promise.all(
      selectWorkingIndicatorsForEnd(indicators).map((indicator) =>
        this.callWorkingIndicator(indicator, "end", context).catch(() => false),
      ),
    );
    return results.some(Boolean);
  }

  async clearWorkingReaction(options: { preserveTodoNotice?: boolean } = {}) {
    const indicators = this.activeWorkingIndicators.length
      ? this.activeWorkingIndicators
      : this.getWorkingIndicators();
    const todoNoticeText = this.latestTodoNoticeText;
    this.activeWorkingIndicators = [];
    this.lastWorkingIndicatorAt = 0;
    this.lastTypingIndicatorAt = 0;
    this.workingIndicatorTick = 0;
    this.latestAssistantSummaryText = "";
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

  private async clearCompactionWorkingReaction(
    options: {
      endReason?: "presentation_transferred";
    } = {},
  ) {
    const indicators = [...this.compactionWorkingIndicators];
    this.compactionWorkingIndicators = [];
    this.lastCompactionIndicatorAt = 0;
    this.lastCompactionTypingIndicatorAt = 0;
    this.compactionIndicatorTick = 0;
    const context = this.compactionWorkingIndicatorContext({
      event: "end",
      endReason: options.endReason,
    });
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
    const typingIndicators = selectTypingIndicatorsForKind(
      indicators,
      "polling",
    );
    const visibleIndicators = selectVisibleWorkingIndicatorsForKind(
      indicators,
      "polling",
    );
    const typingDue =
      typingIndicators.length > 0 &&
      isWorkingIndicatorPollDue(
        this.chatPlatform(),
        this.lastCompactionTypingIndicatorAt,
        now,
      );
    const visibleDue =
      visibleIndicators.length > 0 &&
      isWorkingIndicatorPollDue(
        this.chatPlatform(),
        this.lastCompactionIndicatorAt,
        now,
      );
    if (!typingDue && !visibleDue) return false;

    const context = this.compactionWorkingIndicatorContext({
      event: "tick",
      tick: this.compactionIndicatorTick,
      workingStarted: true,
    });
    const selected = [...typingIndicators, ...visibleIndicators];
    if (visibleIndicators.length || !this.compactionWorkingIndicators.length) {
      this.compactionWorkingIndicators = selected;
    }
    if (typingDue) this.lastCompactionTypingIndicatorAt = now;
    if (visibleDue) this.lastCompactionIndicatorAt = now;
    const [typingResults, visibleResults] = await Promise.all([
      typingDue
        ? this.pollWorkingIndicators(typingIndicators, context, now)
        : Promise.resolve([]),
      visibleDue
        ? this.pollWorkingIndicators(visibleIndicators, context, now)
        : Promise.resolve([]),
    ]);
    const editableWorkingPublished = visibleResults.some(
      (result, index) =>
        Boolean(result) &&
        workingIndicatorPresentation(visibleIndicators[index]) ===
          "editable-message",
    );
    if (
      editableWorkingPublished &&
      typingIndicators.length &&
      (!typingDue || typingResults.some(Boolean))
    ) {
      const reassertedAt = Date.now();
      this.lastCompactionTypingIndicatorAt = reassertedAt;
      typingResults.push(
        ...(await this.pollWorkingIndicators(
          typingIndicators,
          context,
          reassertedAt,
        )),
      );
    }
    if (visibleDue) this.compactionIndicatorTick += 1;
    return [...typingResults, ...visibleResults].some(Boolean);
  }

  private async startBackendWorkingMarker() {
    const turn = this.currentTurn;
    if (
      !turn ||
      turn.workingNoticeSent ||
      this.hasUnacceptedPendingPresentationReplacement() ||
      !workingIndicatorPolicy(this.getWorkingIndicators()).marker
    ) {
      return false;
    }
    turn.workingNoticeSent = true;
    const started = await this.startWorkingMarker(this.getWorkingIndicators());
    if (!started && this.currentTurn === turn) turn.workingNoticeSent = false;
    return started;
  }

  private currentDeliveryTarget(input: {
    incomingMessageId?: string;
    replyToMessageId?: string;
    outboxTurnFence?: ChatOutboxTurnFence;
  }) {
    return {
      incomingMessageId:
        this.backendAcceptedIncomingMessageId ||
        this.presentationIncomingMessageId ||
        this.currentIncomingMessageId() ||
        safeString(input.incomingMessageId || "").trim() ||
        undefined,
      replyToMessageId:
        this.currentReplyToMessageId() ||
        safeString(input.replyToMessageId || "").trim() ||
        undefined,
      outboxTurnFence:
        this.currentTurn?.outboxTurnFence || input.outboxTurnFence,
    };
  }

  private shouldShowTypingIndicator() {
    return this.driver.isWorking();
  }

  private async refreshEditableWorkingNotice(
    options: {
      force?: boolean;
      workingStatusText?: string;
      allowDetachedActiveTurn?: boolean;
      allowPresentationReplacement?: boolean;
    } = {},
  ) {
    const ownsEditableProgress = Boolean(
      (this.currentTurn && this.awaitingTurnSettle) ||
      (options.allowDetachedActiveTurn && this.hasActiveTurn()),
    );
    if (
      !ownsEditableProgress ||
      (!options.allowPresentationReplacement &&
        this.hasUnacceptedPendingPresentationReplacement()) ||
      !this.canDeliverReplies() ||
      shouldSuppressQuietDelivery(
        this.isQuietModeEnabled(),
        "passive_notice",
      ) ||
      this.ownsManualCompactionPresentation() ||
      (!options.force && !this.shouldShowTypingIndicator())
    ) {
      return false;
    }
    const editable = findEditableWorkingIndicator(this.getWorkingIndicators());
    if (!editable) return false;

    const now = Date.now();
    const context = this.workingIndicatorContext({
      event: "tick",
      tick: this.workingIndicatorTick,
      ...(options.workingStatusText
        ? { workingStatusText: options.workingStatusText }
        : {}),
    });
    const result = await this.callWorkingIndicator(
      editable,
      "tick",
      context,
    ).catch(() => false);
    this.lastWorkingIndicatorAt = now;
    this.workingIndicatorTick += 1;
    return Boolean(result);
  }

  private async showAssistantSummary(text: unknown) {
    const summary = normalizeAssistantSummaryText(text);
    if (!summary || !this.currentTurn || !this.awaitingTurnSettle) {
      return false;
    }
    this.latestAssistantSummaryText = summary;
    return await this.refreshEditableWorkingNotice();
  }

  async pollTyping() {
    if (!this.canDeliverReplies()) return false;
    if (!this.shouldShowTypingIndicator()) {
      await this.clearWorkingReaction().catch(() => {});
      return false;
    }
    if (this.editableCompactionRestorePending) {
      const restored = await this.refreshEditableWorkingNotice({
        force: true,
        allowDetachedActiveTurn: true,
        allowPresentationReplacement: true,
      }).catch(() => false);
      this.editableCompactionRestorePending = !restored;
    }
    const indicators = this.getWorkingIndicators();
    const now = Date.now();
    const typingIndicators = selectTypingIndicatorsForKind(
      indicators,
      "polling",
    );
    const visibleIndicators =
      this.hasUnacceptedPendingPresentationReplacement() ||
      this.ownsManualCompactionPresentation() ||
      Boolean(this.editableCompactionStatusText)
        ? []
        : selectVisibleWorkingIndicatorsForKind(indicators, "polling");
    const typingDue =
      typingIndicators.length > 0 &&
      isWorkingIndicatorPollDue(
        this.chatPlatform(),
        this.lastTypingIndicatorAt,
        now,
      );
    const visibleDue =
      visibleIndicators.length > 0 &&
      isWorkingIndicatorPollDue(
        this.chatPlatform(),
        this.lastWorkingIndicatorAt,
        now,
      );
    if (!typingDue && !visibleDue) return false;

    const context = this.workingIndicatorContext({
      event: "tick",
      tick: this.workingIndicatorTick,
      workingStarted: true,
    });
    const selected = [...typingIndicators, ...visibleIndicators];
    if (visibleIndicators.length || !this.activeWorkingIndicators.length) {
      this.activeWorkingIndicators = selected;
    }
    if (typingDue) this.lastTypingIndicatorAt = now;
    if (visibleDue) this.lastWorkingIndicatorAt = now;
    const [typingResults, visibleResults] = await Promise.all([
      typingDue
        ? this.pollWorkingIndicators(typingIndicators, context, now)
        : Promise.resolve([]),
      visibleDue
        ? this.pollWorkingIndicators(visibleIndicators, context, now)
        : Promise.resolve([]),
    ]);
    const editableWorkingPublished = visibleResults.some(
      (result, index) =>
        Boolean(result) &&
        workingIndicatorPresentation(visibleIndicators[index]) ===
          "editable-message",
    );
    if (
      editableWorkingPublished &&
      typingIndicators.length &&
      (!typingDue || typingResults.some(Boolean))
    ) {
      const reassertedAt = Date.now();
      this.lastTypingIndicatorAt = reassertedAt;
      typingResults.push(
        ...(await this.pollWorkingIndicators(
          typingIndicators,
          context,
          reassertedAt,
        )),
      );
    }
    if (visibleDue) this.workingIndicatorTick += 1;
    if (
      this.editableCompactionRestorePending &&
      visibleResults.some(
        (result, index) =>
          Boolean(result) &&
          workingIndicatorPresentation(visibleIndicators[index]) ===
            "editable-message",
      )
    ) {
      this.editableCompactionRestorePending = false;
    }
    return [...typingResults, ...visibleResults].some(Boolean);
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
    return this.commandResponses.current;
  }

  private replaceStoredSessionFile(...candidates: unknown[]) {
    const picked = firstSessionValue(...candidates);
    this.state.sessionFile = toStoredSessionFile(this.agentDir, picked);
    return this.state.sessionFile;
  }

  private updateStoredSessionFile(...args: unknown[]) {
    const last = args.at(-1);
    const hasOptions =
      last &&
      typeof last === "object" &&
      !Array.isArray(last) &&
      Object.prototype.hasOwnProperty.call(last, "persist");
    const options = hasOptions
      ? (args.pop() as { persist?: boolean })
      : undefined;
    const picked = firstSessionValue(...args, this.state.sessionFile);
    this.state.sessionFile = toStoredSessionFile(this.agentDir, picked);
    if (
      this.affectChatBinding &&
      parseChatKey(this.chatKey) &&
      options?.persist !== false
    ) {
      const fence =
        this.currentTurn?.outboxTurnFence ||
        this.activeCommandTurnInput?.outboxTurnFence ||
        getActiveChatOutboxTurnFence();
      if (fence) {
        if (
          !writeChatSessionBindingWithFence(
            this.agentDir,
            fence,
            this.state.sessionFile,
          )
        ) {
          this.state.sessionFile =
            readChatSessionBinding(this.agentDir, this.chatKey) || undefined;
        }
      } else {
        writeChatSessionBinding(
          this.agentDir,
          this.chatKey,
          this.state.sessionFile,
        );
      }
    }
    return this.state.sessionFile;
  }

  private assertRestoredTurnStayedOnSession(
    restoreSessionFile: string,
    resultSessionFile: unknown,
  ) {
    if (!restoreSessionFile) return;
    if (
      sessionFilesMatch(this.agentDir, restoreSessionFile, resultSessionFile)
    ) {
      return;
    }
    throw new Error("chat_restored_session_mismatch");
  }

  private getRecoverableSessionFile() {
    const wanted = resolveSessionFileForUse(
      this.agentDir,
      this.state.sessionFile,
    );
    if (!wanted) return "";
    if (sessionFileExists(wanted)) return wanted;
    if (this.affectChatBinding && parseChatKey(this.chatKey)) {
      const fence =
        this.currentTurn?.outboxTurnFence ||
        this.activeCommandTurnInput?.outboxTurnFence ||
        getActiveChatOutboxTurnFence();
      if (fence) {
        if (!writeChatSessionBindingWithFence(this.agentDir, fence, "")) {
          this.state.sessionFile =
            readChatSessionBinding(this.agentDir, this.chatKey) || undefined;
          const authoritative = resolveSessionFileForUse(
            this.agentDir,
            this.state.sessionFile,
          );
          this.saveState();
          return sessionFileExists(authoritative) ? authoritative : "";
        }
      } else {
        writeChatSessionBinding(this.agentDir, this.chatKey, "");
      }
    }
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
    const stored = openChatDatabase(this.agentDir)
      .prepare(
        `SELECT chat_type FROM messages
         WHERE chat_key = ? AND chat_type IN ('private', 'group')
         ORDER BY sequence DESC LIMIT 1`,
      )
      .get(this.chatKey) as any;
    return stored?.chat_type || "group";
  }

  private rememberPromptChatType(promptMeta?: PromptContextMeta) {
    const chatType = safeString((promptMeta as any)?.chatType).trim();
    if (chatType === "private" || chatType === "group") {
      this.state.chatType = chatType;
    }
  }

  private turnFenceForInboundMessage(messageId?: string) {
    const nextMessageId = safeString(messageId).trim();
    if (!nextMessageId) return undefined;
    return [
      this.currentTurn?.outboxTurnFence,
      this.activeCommandTurnInput?.outboxTurnFence,
      ...Array.from(this.pendingTurnPresentations.values()).map(
        (pending) => pending.outboxTurnFence,
      ),
      getActiveChatOutboxTurnFence(),
    ].find(
      (fence) =>
        fence &&
        fence.chatKey === this.chatKey &&
        fence.messageId === nextMessageId,
    );
  }

  private hasManagedTurnForInboundMessage(messageId?: string) {
    const nextMessageId = safeString(messageId).trim();
    if (!nextMessageId || !parseChatKey(this.chatKey)) return false;
    return Boolean(
      openChatDatabase(this.agentDir)
        .prepare(
          `SELECT 1
           FROM inbox_jobs
           JOIN messages ON messages.id = inbox_jobs.inbound_message_id
           WHERE inbox_jobs.chat_key = ? AND messages.message_id = ?
           LIMIT 1`,
        )
        .get(this.chatKey, nextMessageId),
    );
  }

  private markAcceptedMessage(
    messageId?: string,
    input: { sessionFile?: string; joinedTurnId?: string } = {},
  ) {
    if (!this.affectChatBinding) return;
    const nextMessageId = safeString(messageId || "").trim();
    if (!nextMessageId) return;
    const acceptedAt = nowIso();
    const sessionFile =
      safeString(input.sessionFile).trim() || this.currentSessionFile();
    if (!sessionFile) return;
    const storedSessionFile =
      toStoredSessionFile(this.agentDir, sessionFile) || sessionFile;
    const fence = this.turnFenceForInboundMessage(nextMessageId);
    if (fence) {
      const accepted = markChatMessageAcceptedWithFence(this.agentDir, fence, {
        sessionFile: storedSessionFile,
        acceptedAt,
        joinedTurnId: input.joinedTurnId,
      });
      if (!accepted) return false;
    } else {
      if (this.hasManagedTurnForInboundMessage(nextMessageId)) return false;
      markProcessedChatMessage(this.agentDir, this.chatKey, nextMessageId, {
        sessionFile: storedSessionFile,
        acceptedAt,
      });
    }
    this.updateStoredSessionFile(storedSessionFile);
    this.saveState();
    return true;
  }

  private markProcessedMessage(messageId?: string, bindSession = true) {
    const nextMessageId = safeString(messageId || "").trim();
    if (!nextMessageId) return false;
    if (
      this.turnFenceForInboundMessage(nextMessageId) ||
      this.hasManagedTurnForInboundMessage(nextMessageId)
    ) {
      return false;
    }
    markProcessedChatMessage(this.agentDir, this.chatKey, nextMessageId, {
      ...(bindSession ? { sessionFile: this.currentSessionFile() } : {}),
      acceptedAt: nowIso(),
      processedAt: nowIso(),
    });
    return true;
  }

  private stageAssistantDelivery(input: {
    text?: string;
    parts?: ChatMessagePart[];
    replyToMessageId?: string;
    sessionFile?: string;
    bindSession?: boolean;
    deliveryKind?: "final" | "error";
  }) {
    this.stagedDelivery = buildChatAssistantDelivery(
      {
        agentDir: this.agentDir,
        chatKey: this.chatKey,
        currentSessionFile: this.currentSessionFile(),
      },
      input,
    );
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
      turnFence?: ChatOutboxTurnFence;
      terminalTurn?: RinChatDeliveryContext;
      terminalRequestTag?: string;
      terminalRecordId?: string;
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
        deliveryKind === "passive_notice" ||
        deliveryKind === "error") &&
      !payload.deliveryKind
        ? { ...payload, deliveryKind }
        : payload;
    const effectiveDeliveryKind = safeString(
      normalizedPayload?.deliveryKind || deliveryKind,
    ).trim();
    const presentedPayload =
      effectiveDeliveryKind === "error"
        ? {
            ...normalizedPayload,
            parts: formatChatErrorDelivery({
              parts: normalizedPayload.parts,
            }).parts,
          }
        : normalizedPayload;
    if (
      shouldSuppressQuietDelivery(
        this.isQuietModeEnabled(),
        effectiveDeliveryKind,
      )
    ) {
      return chatDeliveryOutcome([], { accepted: false });
    }
    await validateChatOutboxPayloadForDispatch(presentedPayload, this.h);
    let outboxId: string;
    if (options.terminalTurn) {
      if (deliveryKind !== "final" && deliveryKind !== "error") {
        throw new Error("chat_terminal_invalid_delivery_kind");
      }
      const terminalRequestTag = safeString(options.terminalRequestTag).trim();
      const terminalRecordId = safeString(options.terminalRecordId).trim();
      if (!terminalRequestTag || !terminalRecordId) {
        throw new Error("chat_terminal_record_missing");
      }
      const terminalOutboxId = `chat-${terminalRecordId}`;
      outboxId = enqueueChatOutboxPayload(this.agentDir, presentedPayload, {
        id: terminalOutboxId,
        idempotencyKey: terminalOutboxId,
        deliveryKind: deliveryKind as any,
        normalizeExistingErrorParts: formatChatErrorParts,
        postDelivery: options.postDelivery,
        terminalTurn: options.terminalTurn,
        terminalRecordId,
      });
      const terminalOutbox = readChatOutboxItemById(
        this.agentDir,
        outboxId,
      )?.item;
      if (!terminalOutbox) throw new Error("chat_terminal_delivery_mismatch");
      const terminalPostDelivery = terminalOutbox.postDelivery;
      if (
        (terminalOutbox.status === "delivered" ||
          (terminalOutbox.status === "failed" &&
            terminalOutbox.failureKind === "partial")) &&
        (!terminalPostDelivery?.markJoinedProcessed ||
          !safeString(terminalPostDelivery.markProcessed?.messageId).trim() ||
          !safeString(
            terminalPostDelivery.markProcessed?.chatKey ||
              terminalOutbox.payload?.chatKey,
          ).trim() ||
          !applyPostDelivery(this.agentDir, terminalOutbox))
      ) {
        throw new Error("chat_terminal_delivery_mismatch");
      }
      try {
        await this.driver.acknowledgeTerminal(
          terminalRequestTag,
          terminalRecordId,
        );
      } catch (error: any) {
        this.logger?.warn?.(
          `chat terminal acknowledgement deferred: ${String(
            error?.message || error,
          )}`,
        );
      }
    } else {
      outboxId = enqueueChatOutboxPayload(this.agentDir, presentedPayload, {
        ...options,
        normalizeExistingErrorParts: formatChatErrorParts,
        turnFence:
          options.turnFence ||
          getActiveChatOutboxTurnFence() ||
          this.currentTurn?.outboxTurnFence ||
          this.activeCommandTurnInput?.outboxTurnFence,
        id,
      });
    }
    const results = await drainChatOutbox(
      this.app,
      this.agentDir,
      this.h,
      this.logger,
      {
        chatKey: safeString(presentedPayload?.chatKey).trim(),
        itemId: outboxId,
      },
    );
    const own = Array.isArray(results)
      ? results.find((item: any) => item?.id === outboxId)
      : null;
    if (own && own.status !== "delivered") {
      if (own.status === "failed") {
        const current = readChatOutboxItemById(this.agentDir, outboxId)?.item;
        if (current?.failureKind === "partial") {
          return chatDeliveryOutcome(current.deliveryResult || []);
        }
      }
      if (own.status === "dispatched") {
        const deliveryResult = options.waitUntilDeliverySettled
          ? await waitForChatOutboxDelivery(this.agentDir, outboxId)
          : Number.isFinite(options.waitForDeliveryMs)
            ? await waitForChatOutboxDelivery(
                this.agentDir,
                outboxId,
                options.waitForDeliveryMs,
              )
            : null;
        if (deliveryResult) return chatDeliveryOutcome(deliveryResult);
        const current = readChatOutboxItemById(this.agentDir, outboxId)?.item;
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
      const current = readChatOutboxItemById(this.agentDir, outboxId)?.item;
      if (current?.status === "delivered") {
        return chatDeliveryOutcome(current.deliveryResult || []);
      }
      if (current?.status === "failed") {
        if (current.failureKind === "partial") {
          return chatDeliveryOutcome(current.deliveryResult || []);
        }
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
    deliveryOptions: {
      id?: string;
      idempotencyKey?: string;
      turnFence?: ChatOutboxTurnFence;
      terminalTurn?: RinChatDeliveryContext;
      terminalRequestTag?: string;
      terminalRecordId?: string;
    } = {},
  ) {
    const processingTurn = clearProcessing ? this.currentTurn : null;
    const pending = this.stagedDelivery;
    if (!pending) return chatDeliveryOutcome([], { accepted: false });
    if (!this.affectChatBinding && !this.canDeliverReplies()) {
      if (this.stagedDelivery === pending) this.stagedDelivery = null;
      if (processingTurn && this.currentTurn === processingTurn) {
        await this.clearWorkingReaction().catch(() => {});
        if (this.currentTurn === processingTurn) this.clearCurrentTurn();
      }
      return chatDeliveryOutcome([], { accepted: false });
    }
    const deliveryPayload = {
      ...pending,
      createdAt: nowIso(),
    };
    const outcome = await this.enqueueAndDrainDelivery(deliveryPayload, {
      deliveryKind: pending.deliveryKind || "final",
      postDelivery,
      requireDelivery: true,
      waitUntilDeliverySettled: true,
      ...deliveryOptions,
    });
    if (this.stagedDelivery === pending) this.stagedDelivery = null;
    if (processingTurn && this.currentTurn === processingTurn) {
      await this.clearWorkingReaction().catch(() => {});
      if (this.currentTurn === processingTurn) this.clearCurrentTurn();
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
    deliveryKind?: "final" | "error";
    idempotencyKey?: string;
    outboxTurnFence?: ChatOutboxTurnFence;
    terminalTurn?: RinChatDeliveryContext;
    terminalRequestTag?: string;
    terminalRecordId?: string;
    joinedOwnerTurnId?: string;
  }) {
    const linkSession =
      input.bindSession !== false && this.linkDeliveriesToSession;
    const bindSession = linkSession && this.affectChatBinding;
    this.stageAssistantDelivery({
      ...input,
      bindSession: linkSession,
    });
    const incomingMessageId = safeString(input.incomingMessageId).trim();
    const replyToMessageId = safeString(
      input.replyToMessageId || input.incomingMessageId,
    ).trim();
    const deliveryKind = input.deliveryKind || "final";
    const explicitIdempotencyKey = safeString(input.idempotencyKey).trim();
    const idempotencyKey =
      explicitIdempotencyKey ||
      (incomingMessageId
        ? JSON.stringify([
            deliveryKind,
            this.chatKey,
            incomingMessageId,
            replyToMessageId,
            deliveryKind === "error"
              ? hashChatErrorDeliveryContent(
                  safeString(input.text).trim(),
                  input.parts || [],
                )
              : sha256Hex(
                  JSON.stringify({
                    text: safeString(input.text).trim(),
                    parts: input.parts || [],
                  }),
                ),
          ])
        : "");
    const id = idempotencyKey
      ? `${deliveryKind}-${sha256Hex(idempotencyKey)}`
      : "";
    const activeCommandFence =
      safeString(this.activeCommandTurnInput?.incomingMessageId).trim() ===
      incomingMessageId
        ? this.activeCommandTurnInput?.outboxTurnFence
        : undefined;
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
        ...(safeString(input.joinedOwnerTurnId).trim()
          ? {
              markJoinedProcessed: {
                ownerTurnId: safeString(input.joinedOwnerTurnId).trim(),
                deliveryKind:
                  deliveryKind === "error"
                    ? ("outbox_error" as const)
                    : ("outbox_final" as const),
              },
            }
          : {}),
      },
      {
        id,
        idempotencyKey,
        turnFence: input.outboxTurnFence || activeCommandFence,
        terminalTurn: input.terminalTurn,
        terminalRequestTag: input.terminalRequestTag,
        terminalRecordId: input.terminalRecordId,
      },
    );
    if (delivery?.accepted !== false && delivery?.settled !== false) {
      this.markProcessedMessage(input.incomingMessageId, bindSession);
    }
    return safeString(input.text).trim();
  }

  private async deliverAssistantInterim(text: string) {
    const trimmed = safeString(text).trim();
    if (!trimmed) return false;
    if (!this.canDeliverReplies()) return true;
    const deliveryTarget = this.currentDeliveryTarget({});
    const incomingMessageId = deliveryTarget.incomingMessageId;
    const replyToMessageId =
      deliveryTarget.replyToMessageId || this.currentReplyToMessageId();
    try {
      await this.enqueueAndDrainDelivery(
        {
          createdAt: nowIso(),
          chatKey: this.chatKey,
          deliveryKind: "interim",
          parts: withChatQuotePart(
            [
              {
                type: "text",
                text: presentInterimText(
                  trimmed,
                  Boolean(
                    findEditableWorkingIndicator(this.getWorkingIndicators()),
                  ),
                ),
              },
            ],
            replyToMessageId,
          ),
          coalesceWithWorkingMessage: true,
          ...conversationSessionPayload(
            this.linkDeliveriesToSession,
            this.currentSessionFile(),
          ),
        },
        { deliveryKind: "interim" },
      );
      this.markAcceptedMessage(incomingMessageId);
      return true;
    } catch {
      return false;
    }
  }

  private async sendProgressNoticeNow(
    text: string,
    deliveryKind: "interim" | "passive_notice",
    options: {
      postDelivery?: any;
      id?: string;
      idempotencyKey?: string;
      waitForDeliveryMs?: number;
      waitUntilDeliverySettled?: boolean;
      requireDelivery?: boolean;
      coalesceWithWorkingMessage?: boolean;
      exclusiveProgressMessage?: boolean;
      replyToMessageId?: string;
      turnFence?: ChatOutboxTurnFence;
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
          parts: withChatQuotePart(
            [{ type: "text", text: trimmed }],
            replyToMessageId,
          ),
          ...(options.coalesceWithWorkingMessage
            ? { coalesceWithWorkingMessage: true }
            : {}),
          ...(options.exclusiveProgressMessage
            ? { exclusiveProgressMessage: true }
            : {}),
          ...conversationSessionPayload(
            this.linkDeliveriesToSession,
            this.currentSessionFile(),
          ),
        },
        { deliveryKind, ...options },
      );
      return true;
    } catch {
      return false;
    }
  }

  private async sendPassiveNoticeNow(
    text: string,
    options: Parameters<ChatController["sendProgressNoticeNow"]>[2] = {},
  ) {
    return await this.sendProgressNoticeNow(text, "passive_notice", options);
  }

  private async sendCompactionInterimNow(
    text: string,
    options: Parameters<ChatController["sendProgressNoticeNow"]>[2] = {},
  ) {
    return await this.sendProgressNoticeNow(text, "interim", options);
  }

  private async reportFrontendEventHandlingFailure(
    failure: RinFrontendEventHandlingFailure,
  ) {
    const errorText =
      safeString((failure.error as any)?.message || failure.error).trim() ||
      "unknown frontend event error";
    const eventType =
      failure.frontendEvent?.type || failure.clientEvent?.type || "unknown";
    this.logger?.warn?.(
      `frontend event handling failed stage=${failure.stage} event=${eventType}: ${errorText}`,
    );
    if (failure.stage === "terminal_listener") return;
    const idempotencyKey = `frontend-event-error:${crypto
      .createHash("sha256")
      .update(
        JSON.stringify([
          this.chatKey,
          this.currentTurn?.requestTag || "",
          failure.stage,
          eventType,
          errorText,
        ]),
      )
      .digest("hex")}`;
    await this.sendErrorNoticeNow(
      `frontend event handling failed (${failure.stage}/${eventType}): ${errorText}`,
      { idempotencyKey },
    );
  }

  private async sendErrorNoticeNow(
    text: string,
    options: {
      idempotencyKey?: string;
      turnFence?: ChatOutboxTurnFence;
    } = {},
  ) {
    const trimmed = safeString(text).trim();
    if (!trimmed) return false;
    if (!this.canDeliverReplies()) return true;
    try {
      await this.enqueueAndDrainDelivery(
        {
          createdAt: nowIso(),
          chatKey: this.chatKey,
          deliveryKind: "error",
          parts: withChatQuotePart(
            [{ type: "text", text: trimmed }],
            this.currentReplyToMessageId(),
          ),
          ...conversationSessionPayload(
            this.linkDeliveriesToSession,
            this.currentSessionFile(),
          ),
        },
        {
          deliveryKind: "error",
          waitUntilDeliverySettled: true,
          requireDelivery: true,
          ...options,
        },
      );
      return true;
    } catch {
      return false;
    }
  }

  private isLatestDurableTodoEvent(
    todoOwner: string,
    idempotencyKeys: string[],
  ) {
    const db = openChatDatabase(this.agentDir);
    const latest = db
      .prepare(
        `SELECT MAX(sequence) AS sequence FROM outbox
         WHERE turn_id = ?
           AND json_extract(idempotency_key, '$[0]') = 'todo_notice'`,
      )
      .get(todoOwner) as { sequence?: number | null };
    const keys = idempotencyKeys.filter(Boolean);
    if (!keys.length || latest?.sequence == null) return false;
    const placeholders = keys.map(() => "?").join(", ");
    const current = db
      .prepare(
        `SELECT MAX(sequence) AS sequence FROM outbox
         WHERE turn_id = ? AND idempotency_key IN (${placeholders})`,
      )
      .get(todoOwner, ...keys) as { sequence?: number | null };
    return current?.sequence != null && current.sequence === latest.sequence;
  }

  private durableTodoFallbackState(todoOwner: string) {
    const rows = openChatDatabase(this.agentDir)
      .prepare(
        `SELECT idempotency_key FROM outbox
         WHERE turn_id = ? AND idempotency_key IS NOT NULL
         ORDER BY sequence DESC`,
      )
      .all(todoOwner) as Array<{ idempotency_key?: string }>;
    for (const row of rows) {
      try {
        const identity = JSON.parse(safeString(row.idempotency_key));
        if (
          Array.isArray(identity) &&
          identity[0] === "todo_notice" &&
          identity[1] === this.chatKey &&
          identity[2] === todoOwner &&
          identity[3] === "fallback"
        ) {
          return {
            revision: Math.max(0, Number(identity[4]) || 0),
            hash: safeString(identity[5]).trim(),
          };
        }
      } catch {
        continue;
      }
    }
    return { revision: 0, hash: "" };
  }

  private async sendTodoPassiveNoticeNow(event: any) {
    const currentTurn = this.currentTurn;
    const deliveryTarget = currentTurn
      ? {
          ...currentTurn,
          outboxTurnFence: currentTurn.outboxTurnFence
            ? { ...currentTurn.outboxTurnFence }
            : undefined,
        }
      : null;
    const operation = this.todoDeliveryQueue.then(() =>
      this.sendTodoPassiveNoticeOwned(event, deliveryTarget),
    );
    this.todoDeliveryQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return await operation;
  }

  private async sendTodoPassiveNoticeOwned(
    event: any,
    deliveryTarget: ChatTurnMeta | null,
  ) {
    const turnFence = deliveryTarget?.outboxTurnFence;
    const todoOwner = safeString(turnFence?.turnId).trim();
    if (
      !deliveryTarget ||
      !turnFence ||
      !todoOwner ||
      safeString(this.currentTurn?.outboxTurnFence?.turnId).trim() !==
        todoOwner ||
      !this.ownsOutboxTurnFence(turnFence)
    ) {
      return true;
    }
    const { todos, text: noticeText } = presentTodoNotice(
      this.chatKey,
      event?.todoItems,
      event?.text,
    );
    const todoHash = crypto
      .createHash("sha256")
      .update(noticeText)
      .digest("hex");
    const sourceEventId = safeString(event?.sourceEventId).trim();
    let nextFallbackOwner = this.todoFallbackOwner;
    let nextFallbackHash = this.todoFallbackHash;
    let nextFallbackRevision = this.todoFallbackRevision;
    let todoIdempotencyIdentity: unknown[];
    if (sourceEventId) {
      todoIdempotencyIdentity = ["event", sourceEventId];
    } else {
      if (nextFallbackOwner !== todoOwner) {
        const durableState = this.durableTodoFallbackState(todoOwner);
        nextFallbackOwner = todoOwner;
        nextFallbackHash = durableState.hash;
        nextFallbackRevision = durableState.revision;
      }
      if (nextFallbackHash !== todoHash) {
        nextFallbackHash = todoHash;
        nextFallbackRevision += 1;
      }
      todoIdempotencyIdentity = ["fallback", nextFallbackRevision, todoHash];
    }
    const commitTodoDisplayState = (idempotencyKeys: string[]) => {
      if (
        !this.ownsOutboxTurnFence(turnFence) ||
        !isChatOutboxTurnFenceActive(this.agentDir, turnFence, this.chatKey) ||
        !this.isLatestDurableTodoEvent(todoOwner, idempotencyKeys)
      ) {
        return false;
      }
      this.latestTodoNoticeText = noticeText;
      if (!sourceEventId) {
        this.todoFallbackOwner = nextFallbackOwner;
        this.todoFallbackHash = nextFallbackHash;
        this.todoFallbackRevision = nextFallbackRevision;
      }
      return true;
    };
    const todoIdempotencyKey = JSON.stringify([
      "todo_notice",
      this.chatKey,
      todoOwner,
      ...todoIdempotencyIdentity,
    ]);
    const todoDeliveryOptions = {
      waitUntilDeliverySettled: true,
      requireDelivery: true,
      coalesceWithWorkingMessage: true,
      turnFence,
      idempotencyKey: todoIdempotencyKey,
    };
    if (!this.canDeliverReplies()) return true;

    if (todos?.length === 0) {
      // An empty Todo snapshot has no durable delivery to fence. Do not let it
      // mutate or refresh presentation state; final settlement clears Working.
      return true;
    }

    const todoDelivery = this.sendPassiveNoticeNow(
      noticeText,
      todoDeliveryOptions,
    );
    const todoDelivered = await todoDelivery;
    if (todoDelivered) commitTodoDisplayState([todoIdempotencyKey]);
    return todoDelivered;
  }

  private async deliverPassiveNotice(text: string) {
    const trimmed = safeString(text).trim();
    if (!trimmed) return false;
    if (
      shouldSuppressQuietDelivery(this.isQuietModeEnabled(), "passive_notice")
    ) {
      return true;
    }
    if (
      shouldDeferPassiveNotice({
        hasActiveTurn: this.hasActiveTurn(),
        awaitingTurnSettle: this.awaitingTurnSettle,
        hasStagedDelivery: Boolean(this.stagedDelivery),
      })
    ) {
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

  private async clearCompactionPresentation(
    options: {
      endReason?: "presentation_transferred";
    } = {},
  ) {
    await this.clearCompactionWorkingReaction(options).catch(() => false);
    this.compactionTurn = null;
    this.compactionWorkingIndicators = [];
    this.lastCompactionIndicatorAt = 0;
    this.lastCompactionTypingIndicatorAt = 0;
    this.compactionIndicatorTick = 0;
    this.editableCompactionStatusText = "";
    this.editableCompactionRestorePending = false;
  }

  private async deliverManualCompactionCompletion(
    text: string,
    commandTurnInput: ChatCommandTurnInput,
  ) {
    const incomingMessageId = safeString(
      commandTurnInput.incomingMessageId,
    ).trim();
    try {
      await this.deliverAssistantReply({
        text,
        incomingMessageId,
        replyToMessageId:
          safeString(commandTurnInput.replyToMessageId).trim() ||
          incomingMessageId,
        clearProcessing: true,
        bindSession: false,
        outboxTurnFence: commandTurnInput.outboxTurnFence,
      });
    } finally {
      await this.clearCompactionPresentation();
    }
  }

  private async deliverAutomaticCompactionEndNotice(text: string) {
    if (this.editableCompactionStatusText) {
      await this.clearCompactionPresentation();
      const restored = await this.refreshEditableWorkingNotice({
        force: true,
        allowDetachedActiveTurn: true,
        allowPresentationReplacement: true,
      }).catch(() => false);
      this.editableCompactionRestorePending = !restored;
      return true;
    }
    const recoveredEditableTurn = Boolean(
      this.compactionTurn &&
      this.hasActiveTurn() &&
      findEditableWorkingIndicator(this.getWorkingIndicators()),
    );
    if (recoveredEditableTurn) {
      await this.clearCompactionPresentation({
        endReason: "presentation_transferred",
      });
      const restored = await this.refreshEditableWorkingNotice({
        force: true,
        allowDetachedActiveTurn: true,
        allowPresentationReplacement: true,
      }).catch(() => false);
      this.editableCompactionRestorePending = !restored;
      return true;
    }
    const coalesceReplyToMessageId = safeString(
      this.compactionTurn?.replyToMessageId || "",
    ).trim();
    const shouldCoalesce = Boolean(this.compactionTurn || this.currentTurn);
    try {
      return await this.sendCompactionInterimNow(text, {
        ...(shouldCoalesce
          ? {
              coalesceWithWorkingMessage: true,
              ...(coalesceReplyToMessageId
                ? { replyToMessageId: coalesceReplyToMessageId }
                : {}),
            }
          : {}),
      });
    } finally {
      await this.clearCompactionPresentation();
      await this.refreshEditableWorkingNotice().catch(() => false);
    }
  }

  private async deliverCompactionStartNotice(text: string) {
    const trimmed = safeString(text).trim();
    if (!trimmed) return false;
    if (!this.canDeliverReplies()) return true;
    const commandIncomingMessageId = safeString(
      this.activeCommandTurnInput?.incomingMessageId || "",
    ).trim();
    const commandReplyToMessageId =
      safeString(this.activeCommandTurnInput?.replyToMessageId || "").trim() ||
      commandIncomingMessageId;
    const coalesceReplyToMessageId =
      this.currentReplyToMessageId() || commandReplyToMessageId || undefined;

    const manualCompaction = this.ownsManualCompactionPresentation();
    if (
      !manualCompaction &&
      this.hasActiveTurn() &&
      findEditableWorkingIndicator(this.getWorkingIndicators())
    ) {
      this.editableCompactionStatusText = trimmed;
      const overlaid = await this.refreshEditableWorkingNotice({
        force: true,
        workingStatusText: trimmed,
        allowDetachedActiveTurn: true,
      });
      if (overlaid) return true;
      this.editableCompactionStatusText = "";
    }

    try {
      const delivery = await this.enqueueAndDrainDelivery(
        {
          createdAt: nowIso(),
          chatKey: this.chatKey,
          deliveryKind: "interim",
          coalesceWithWorkingMessage: true,
          ...(manualCompaction ? { exclusiveProgressMessage: true } : {}),
          parts: withChatQuotePart(
            [{ type: "text", text: trimmed }],
            coalesceReplyToMessageId,
          ),
          ...conversationSessionPayload(
            this.linkDeliveriesToSession,
            this.currentSessionFile(),
          ),
        },
        {
          deliveryKind: "interim",
          coalesceWithWorkingMessage: true,
          ...(manualCompaction ? { exclusiveProgressMessage: true } : {}),
          waitForDeliveryMs: 1000,
        },
      );
      const messageId = safeString(delivery.messageIds[0]).trim();
      if (messageId) {
        this.compactionTurn = {
          startedAt: Date.now(),
          incomingMessageId: messageId,
          replyToMessageId: coalesceReplyToMessageId || undefined,
          workingNoticeSent: false,
        };
        if (!manualCompaction) {
          const marker = this.startCompactionWorkingMarker().catch(() => false);
          const poll = this.pollCompactionTyping().catch(() => false);
          await Promise.race([
            Promise.all([marker, poll]),
            new Promise((resolve) => setImmediate(resolve)),
          ]);
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  async detachForDaemonShutdown() {
    this.lastActivityAt = Date.now();
    await this.driver.detachForDaemonShutdown();
  }

  async shutdownSession() {
    this.lastActivityAt = Date.now();
    const wanted = this.getRecoverableSessionFile();
    if (wanted) await this.connect({ restoreSession: true });
    await this.driver.shutdownSession();
    await this.clearAllWaitingReactions().catch(() => {});
    this.currentTurn = null;
    this.presentationIncomingMessageId = "";
    this.presentationReplyToMessageId = "";
    this.compactionTurn = null;
    this.compactionWorkingIndicators = [];
    this.activeCommandTurnInput = null;
    this.startedReactionRequestTags.clear();
    this.deferredWorkingReactionRequestTags.clear();
    this.backendAcceptedIncomingMessageId = "";
    this.stagedDelivery = null;
    this.awaitingTurnSettle = false;
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

  private async advanceGenerationAfterNonterminalSends(input: {
    preserveInboundMessageId?: string;
    sessionFile?: string;
    turnFence?: ChatOutboxTurnFence;
  }) {
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        return advanceChatGeneration(this.agentDir, this.chatKey, input);
      } catch (error) {
        if (
          safeString((error as any)?.message || error) !==
          "chat_generation_nonterminal_send_in_flight"
        ) {
          throw error;
        }
        if (Date.now() >= deadline) {
          return advanceChatGeneration(this.agentDir, this.chatKey, {
            ...input,
            resolveNonterminalSends: true,
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  async runCommand(
    commandLine: string,
    replyToMessageId = "",
    incomingMessageId = "",
    _sessionFile = "",
    promptMeta?: PromptContextMeta,
    outboxTurnFence?: ChatOutboxTurnFence,
  ) {
    this.rememberPromptChatType(promptMeta);
    const commandName = frontendCommandNameFromLine(commandLine);
    const commandPolicy =
      getRinNonInteractiveCommandInteractionPolicy(commandLine);
    const hadActiveTurn = this.hasActiveTurn();
    const interruptingActiveTurn =
      hadActiveTurn &&
      (commandPolicy.activeTurnHandling === "abort" ||
        commandPolicy.activeTurnHandling === "interrupt_then_run");
    let activeTurnInterruptionCommitted = false;
    const skipSessionRecovery = commandPolicy.skipSessionRecovery;
    // Slash commands are controls; reply-bound session files belong to prompt inbox_jobs only.
    const explicitSessionFile = "";
    const storedRestoreSessionFile = skipSessionRecovery
      ? ""
      : this.getRecoverableSessionFile();
    const managedSessionLeaf =
      commandPolicy.skipSessionRecovery && commandName === "new"
        ? MANAGED_CHAT_SESSION_LEAF
        : !storedRestoreSessionFile
          ? this.managedSessionLeafForFreshChat()
          : undefined;
    this.lastActivityAt = Date.now();
    const commandTurnInput = this.setActiveCommandTurnInput({
      incomingMessageId,
      replyToMessageId,
      commandName,
      outboxTurnFence: outboxTurnFence || getActiveChatOutboxTurnFence(),
    });
    try {
      if (commandPolicy.acceptInboundBeforeExecution) {
        this.ensureVisibleCommandTurn();
        this.markAcceptedMessage(incomingMessageId);
      }

      this.commandUiMessages = [];
      this.commandUiParts = [];
      this.collectingCommandUi = true;
      let data: any;
      if (commandName === "done") {
        await this.shutdownSession();
        data = { text: "Conversation completed." };
      } else {
        const frontendReady = await this.connect({
          restoreSession: !skipSessionRecovery,
        });
        const restoreSessionFile = skipSessionRecovery
          ? ""
          : this.getRecoverableSessionFile() || storedRestoreSessionFile;
        data = await this.driver.runCommand(commandLine, {
          assumeConnected: frontendReady === true,
          assumeSessionReady:
            frontendReady === true &&
            sessionFilesMatch(
              this.agentDir,
              this.driver.currentSessionFile(),
              restoreSessionFile,
            ),
          skipSessionRecovery,
          restoreSessionFile,
          sessionFile: explicitSessionFile,
          managedSessionLeaf,
          promptContext: commandName === "reload" ? promptMeta : undefined,
          onActiveTurnInterruptionCommitted: interruptingActiveTurn
            ? () => {
                activeTurnInterruptionCommitted = true;
              }
            : undefined,
        });
        const nextSessionFile =
          commandName === "new"
            ? this.replaceStoredSessionFile(
                data?.sessionFile,
                this.driver.currentSessionFile(),
              )
            : this.updateStoredSessionFile(
                data?.sessionFile,
                this.driver.currentSessionFile(),
              );
        if (commandName === "new" && parseChatKey(this.chatKey)) {
          await this.advanceGenerationAfterNonterminalSends({
            preserveInboundMessageId: incomingMessageId,
            sessionFile: nextSessionFile,
            turnFence:
              this.activeCommandTurnInput?.outboxTurnFence ||
              getActiveChatOutboxTurnFence(),
          });
        }
        this.saveState();
      }
      data = applyChatBuiltinCommandText(
        commandName,
        data,
        this.getCommandResponses(),
      );
      const text = [
        safeString(data?.text || "").trim(),
        ...this.commandUiMessages,
      ]
        .map((part) => safeString(part).trim())
        .filter(Boolean)
        .join("\n");

      if (commandName === "compact") {
        if (text) {
          await this.deliverManualCompactionCompletion(text, commandTurnInput);
        }
        return text ? { ...data, text } : data;
      }

      const parts = [
        ...this.commandUiParts,
        ...(Array.isArray(data?.parts)
          ? (data.parts.filter(Boolean) as ChatMessagePart[])
          : []),
      ];
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
        text: errorMessage,
        replyToMessageId: replyToMessageId || undefined,
        incomingMessageId,
        clearProcessing: true,
        bindSession: false,
        deliveryKind: "error",
      });
      throw error;
    } finally {
      this.collectingCommandUi = false;
      this.commandUiMessages = [];
      this.commandUiParts = [];
      if (!interruptingActiveTurn || activeTurnInterruptionCommitted) {
        this.awaitingTurnSettle = false;
        await this.clearWorkingReaction().catch(() => {});
        this.clearCurrentTurn();
        this.stagedDelivery = null;
      }
      this.clearActiveCommandTurnInput();
      this.saveState();
    }
  }

  async resumeTurn(
    input: {
      incomingMessageId?: string;
      replyToMessageId?: string;
      receivedAt?: string;
      requestTag?: string;
      sessionFile?: string;
      outboxTurnFence?: ChatOutboxTurnFence;
    },
    options: { connect?: () => Promise<unknown> } = {},
  ) {
    input.outboxTurnFence ||= getActiveChatOutboxTurnFence();
    input.requestTag ||=
      this.requestTagForInboundMessage(
        input.incomingMessageId,
        input.outboxTurnFence,
      ) || undefined;
    return await (async () => {
      const requestTag = safeString(input.requestTag).trim();
      const sessionFile = resolveSessionFileForUse(
        this.agentDir,
        input.sessionFile,
      );
      const messageId = safeString(input.incomingMessageId).trim();
      if (!requestTag) throw new Error("chat_turn_request_tag_missing");
      if (!sessionFile || !sessionFileExists(sessionFile)) {
        throw missingSessionFileError(sessionFile);
      }
      this.setCurrentTurn({ ...input, requestTag });
      const recoveredTurn = this.currentTurn;
      this.awaitingTurnSettle = true;
      try {
        await (options.connect ? options.connect() : this.connect());
        if (this.currentTurn) this.currentTurn.frontendReadyAt = Date.now();
        const result = await this.driver.resumeTurn({
          requestTag,
          sessionFile,
          chatDeliveryContext:
            input.outboxTurnFence && messageId
              ? {
                  turnId: input.outboxTurnFence.turnId,
                  chatKey: this.chatKey,
                  messageId,
                }
              : undefined,
        });
        await this.preloadEditableTodoPresentation();
        return result;
      } catch (error) {
        if (recoveredTurn && this.currentTurn === recoveredTurn) {
          this.awaitingTurnSettle = false;
          this.clearCurrentTurn();
        }
        throw error;
      }
    })();
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
        requestTag?: string;
        deliveryIdempotencyKey?: string;
        model?: string;
        thinkingLevel?: string;
        managedSessionLeaf?: string;
        createSessionFileIfMissing?: boolean;
        deliverFinal?: boolean;
        disabledRinCapabilities?: string[];
        quietMode?: boolean;
        receivedAt?: string;
        outboxTurnFence?: ChatOutboxTurnFence;
      },
  ) {
    input.outboxTurnFence ||= getActiveChatOutboxTurnFence();
    input.requestTag ||=
      this.requestTagForInboundMessage(
        input.incomingMessageId,
        input.outboxTurnFence,
      ) || undefined;
    this.rememberPromptChatType(input.promptMeta);
    this.lastActivityAt = Date.now();
    return await (async () => {
      const deliverFinal = input.deliverFinal !== false;
      const currentTurnBeforeSubmission = this.currentTurn;
      let preserveCurrentTurn = Boolean(
        currentTurnBeforeSubmission &&
        input.incomingMessageId &&
        currentTurnBeforeSubmission.incomingMessageId !==
          input.incomingMessageId,
      );
      const { sessionFile: rawWantedSessionFile } = normalizeSessionRef(input);
      const wantedSessionFile = resolveSessionFileForUse(
        this.agentDir,
        rawWantedSessionFile,
      );
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
      const { text, images, frontendReady } = await this.prepareTurnPrompt(
        input,
        deliverFinal,
      );
      const requestTag =
        safeString(input.requestTag).trim() ||
        this.requestTagForInboundMessage(
          input.incomingMessageId,
          input.outboxTurnFence,
        );
      const pendingPresentation: PendingTurnPresentation = {
        incomingMessageId: input.incomingMessageId,
        replyToMessageId: input.replyToMessageId,
        submittedText: safeString(input.text).trim() || undefined,
        requestTag,
        outboxTurnFence: input.outboxTurnFence,
        backendAccepted: false,
        joinedOwnerTurnId: preserveCurrentTurn
          ? currentTurnBeforeSubmission?.outboxTurnFence?.turnId
          : undefined,
        sessionFile: this.driver.currentSessionFile(),
      };
      if (requestTag) {
        this.pendingTurnPresentations.set(requestTag, pendingPresentation);
      }
      if (this.currentTurn && !preserveCurrentTurn)
        this.currentTurn.requestTag = requestTag || undefined;
      try {
        const messageId = safeString(input.incomingMessageId).trim();
        const chatDeliveryContext =
          input.outboxTurnFence && messageId
            ? {
                turnId: input.outboxTurnFence.turnId,
                chatKey: this.chatKey,
                messageId,
              }
            : undefined;
        const result = await this.runDriverTurnWithQuietMode(input.quietMode, {
          text,
          chatDeliveryContext,
          images,
          assumeConnected: frontendReady === true,
          assumeSessionReady:
            frontendReady === true &&
            sessionFilesMatch(
              this.agentDir,
              this.driver.currentSessionFile(),
              restoreSessionFile,
            ),
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
          requestTag,
          commitNonterminalAcceptance: pendingPresentation.outboxTurnFence
            ? async (acceptance) => {
                if (acceptance.requestTag !== requestTag) {
                  throw new Error("chat_turn_fence_lost");
                }
                if (!pendingPresentation.joinedOwnerTurnId) {
                  const activeOwnerTurnId = safeString(
                    this.currentTurn?.outboxTurnFence?.turnId,
                  ).trim();
                  if (
                    activeOwnerTurnId &&
                    this.currentIncomingMessageId() !==
                      safeString(pendingPresentation.incomingMessageId).trim()
                  ) {
                    pendingPresentation.joinedOwnerTurnId = activeOwnerTurnId;
                  }
                }
                if (!pendingPresentation.joinedOwnerTurnId) {
                  pendingPresentation.joinedOwnerTurnId =
                    this.joinedOwnerTurnIdForRequestTag(
                      safeString(acceptance.joinedRequestTag).trim(),
                    );
                }
                if (!pendingPresentation.joinedOwnerTurnId) {
                  throw new Error("chat_turn_fence_lost");
                }
                if (
                  !pendingPresentation.sessionFile ||
                  !sessionFilesMatch(
                    this.agentDir,
                    acceptance.sessionFile,
                    pendingPresentation.sessionFile,
                  )
                ) {
                  throw new Error("chat_turn_fence_lost");
                }
                const acceptedPresentation =
                  await this.adoptBackendAcceptedPendingPresentation(
                    requestTag,
                    { sessionFile: acceptance.sessionFile },
                  );
                if (!acceptedPresentation?.backendAccepted) {
                  throw new Error("chat_turn_fence_lost");
                }
                preserveCurrentTurn = true;
              }
            : undefined,
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
        if (result.outcome === "terminalOwner" && preserveCurrentTurn) {
          this.setCurrentTurn(input);
          preserveCurrentTurn = false;
        }
        if (this.currentTurn && !preserveCurrentTurn) {
          this.currentTurn.requestTag = result.requestTag || requestTag;
        }
        const effectiveOutcome =
          result.outcome === "rejoined"
            ? result.originalOutcome
            : result.outcome;
        if (
          preserveCurrentTurn &&
          effectiveOutcome === "nonterminal" &&
          pendingPresentation.outboxTurnFence &&
          !pendingPresentation.backendAccepted
        ) {
          throw new Error("chat_turn_fence_lost");
        }
        if (deliverFinal && this.currentTurn && !result.superseded) {
          if (
            this.currentTurn.outboxTurnFence &&
            (!result.chatDeliveryContext || !result.terminalRecord)
          ) {
            throw new Error("chat_terminal_record_missing");
          }
          await this.settleProjectedTurnComplete({
            finalText: result.finalText,
            deliveryIdempotencyKey: input.deliveryIdempotencyKey,
            result: result.result,
            sessionFile: result.sessionFile,
            requestTag: result.requestTag || requestTag,
            chatDeliveryContext: result.chatDeliveryContext,
            terminalRecord: result.terminalRecord,
          });
        }
        await this.flushPendingPassiveNotices(input.quietMode);
        return {
          finalText: result.finalText,
          result: result.result,
          sessionId: this.currentSessionId() || undefined,
          sessionFile: this.currentSessionFile(),
          superseded: result.superseded,
        };
      } finally {
        if (
          requestTag &&
          this.pendingTurnPresentations.get(requestTag) === pendingPresentation
        ) {
          this.pendingTurnPresentations.delete(requestTag);
        }
        if (!preserveCurrentTurn) {
          await this.clearWorkingReactionFor(input.incomingMessageId);
          this.clearCurrentTurnFor(input.incomingMessageId);
        }
        this.awaitingTurnSettle = false;
        this.stagedDelivery = null;
        this.saveState();
      }
    })();
  }

  private async settleProjectedTurnComplete(event: {
    finalText?: string;
    deliveryIdempotencyKey?: string;
    result?: unknown;
    sessionFile?: string;
    requestTag?: string;
    chatDeliveryContext?: RinChatDeliveryContext;
    terminalRecord?: {
      terminalId: string;
      state: "complete" | "error" | "interrupted";
      terminalAt?: string;
    };
  }) {
    const context = event.chatDeliveryContext;
    if (!context && !this.currentTurn) return;
    if (context) {
      event = this.authoritativeTerminalEvent(
        event,
        "complete",
      ) as typeof event;
    }
    const presentationTurn = context
      ? this.currentPresentationForTerminal(context)
      : this.currentTurn;
    const deliveryTarget = context
      ? this.terminalDeliveryTarget(context)
      : this.currentDeliveryTarget(presentationTurn || {});
    const replyToMessageId = context
      ? deliveryTarget.replyToMessageId
      : this.currentReplyToMessageId() || deliveryTarget.replyToMessageId;
    const joinedOwnerTurnId = context?.turnId || "";
    const resultParts = assistantDeliveryParts(event.finalText, event.result);
    if (safeString(event.finalText).trim() || resultParts.length) {
      await this.deliverAssistantReply({
        text: event.finalText,
        parts: resultParts.length ? resultParts : undefined,
        idempotencyKey: event.deliveryIdempotencyKey,
        replyToMessageId,
        incomingMessageId: deliveryTarget.incomingMessageId,
        outboxTurnFence: deliveryTarget.outboxTurnFence,
        sessionFile:
          event.sessionFile ||
          (context ? undefined : this.currentSessionFile()),
        terminalTurn: context,
        terminalRequestTag: event.requestTag,
        terminalRecordId: event.terminalRecord?.terminalId,
        joinedOwnerTurnId,
      });
    } else {
      await this.settleProjectedTurnError({
        error: RIN_EMPTY_AGENT_RESPONSE_ERROR,
        sessionFile: event.sessionFile,
        requestTag: event.requestTag,
        chatDeliveryContext: context,
        terminalRecord: event.terminalRecord,
      });
      return;
    }
    await this.finishTerminalPresentation(presentationTurn);
  }

  private async settleProjectedTurnError(event: {
    error?: string;
    sessionFile?: string;
    requestTag?: string;
    chatDeliveryContext?: RinChatDeliveryContext;
    terminalRecord?: {
      terminalId: string;
      state: "complete" | "error" | "interrupted";
      terminalAt?: string;
    };
  }) {
    const context = event.chatDeliveryContext;
    if (!context && !this.currentTurn) return;
    if (context) {
      event = this.authoritativeTerminalEvent(event, "error") as typeof event;
    }
    const errorMessage = safeString(event.error).trim() || "rpc_turn_failed";
    const presentationTurn = context
      ? this.currentPresentationForTerminal(context)
      : this.currentTurn;
    const deliveryTarget = context
      ? this.terminalDeliveryTarget(context)
      : this.currentDeliveryTarget(presentationTurn || {});
    await this.deliverAssistantReply({
      text: errorMessage,
      replyToMessageId: context
        ? deliveryTarget.replyToMessageId
        : this.currentReplyToMessageId() || deliveryTarget.replyToMessageId,
      incomingMessageId: deliveryTarget.incomingMessageId,
      outboxTurnFence: deliveryTarget.outboxTurnFence,
      sessionFile:
        event.sessionFile || (context ? undefined : this.currentSessionFile()),
      terminalTurn: context,
      terminalRequestTag: event.requestTag,
      terminalRecordId: event.terminalRecord?.terminalId,
      joinedOwnerTurnId: context?.turnId,
      deliveryKind: "error",
    });
    await this.finishTerminalPresentation(presentationTurn);
  }

  private async finishTerminalPresentation(turn: ChatTurnMeta | null) {
    if (!turn || (this.currentTurn && this.currentTurn !== turn)) return;
    if (this.currentTurn === turn) {
      await this.clearWorkingReaction().catch(() => {});
    }
    if (this.currentTurn && this.currentTurn !== turn) return;
    this.awaitingTurnSettle = false;
    if (this.currentTurn === turn) this.clearCurrentTurn();
    this.saveState();
    await this.flushPendingPassiveNotices(false);
  }

  async housekeep() {
    await this.pollTyping().catch(() => {});
    await this.pollCompactionTyping().catch(() => {});
    await this.sleepIfIdle().catch(() => false);
  }

  async handleClientEvent(event: any) {
    await this.driver.handleClientEvent(event);
    const requestTag = safeString(event?.payload?.requestTag).trim();
    if (
      event?.type === "ui" &&
      event?.payload?.type === "compaction_end" &&
      this.editableCompactionStatusText &&
      (!requestTag || this.acceptsScopedTurnEvent(requestTag))
    ) {
      const pendingStatus = this.editableCompactionStatusText;
      await new Promise((resolve) => setImmediate(resolve));
      if (
        this.editableCompactionStatusText === pendingStatus &&
        (!requestTag || this.acceptsScopedTurnEvent(requestTag))
      ) {
        await this.clearCompactionPresentation();
        await this.refreshEditableWorkingNotice({ force: true }).catch(
          () => false,
        );
      }
    }
  }

  async handleSessionEvent(event: any) {
    await this.driver.handleClientEvent(event);
  }

  private async handleFrontendEvent(event: any) {
    if (!event || typeof event !== "object") return;
    if (event.type === "extension_ui_request") {
      if (event.method === "setCommandResponses") {
        this.commandResponses.current = resolveChatCommandResponses(
          event.commandResponses,
          this.commandResponses.baseline,
        );
        return;
      }
      if (event.method === "setWorkingMessage") {
        this.onWorkingMessage?.(safeString(event.message).trim());
        if (!this.ownsManualCompactionPresentation()) {
          await this.refreshEditableWorkingNotice().catch(() => false);
        }
        return;
      }
      const projection = projectChatExtensionUiRequest(event);
      if (projection.response) {
        await this.client
          .respondExtensionUi(projection.response)
          .catch(() => {});
      }
      if (projection.text || projection.parts?.length) {
        if (this.collectingCommandUi) {
          if (projection.text) this.commandUiMessages.push(projection.text);
          if (projection.parts?.length) {
            this.commandUiParts.push(...projection.parts);
          }
        } else if (projection.parts?.length) {
          throw new Error(
            "Extension command result arrived outside command execution",
          );
        } else if (projection.text) {
          await this.deliverPassiveNotice(projection.text).catch(() => {});
        }
      }
      return;
    }
    const activeRequestTag = safeString(this.currentTurn?.requestTag).trim();
    const eventRequestTag = safeString(event.requestTag).trim();
    const pendingPresentation =
      this.pendingTurnPresentations.get(eventRequestTag);
    const pendingPresentationReplacesCurrent = Boolean(
      pendingPresentation &&
      (!this.currentTurn ||
        activeRequestTag !== eventRequestTag ||
        this.currentIncomingMessageId() !==
          safeString(pendingPresentation.incomingMessageId).trim()),
    );
    if (
      event.type === "turn_accepted" &&
      eventRequestTag &&
      pendingPresentationReplacesCurrent
    ) {
      try {
        await this.adoptBackendAcceptedPendingPresentation(eventRequestTag);
      } catch (error) {
        if (
          safeString((error as any)?.message || error).trim() !==
          "chat_turn_fence_lost"
        ) {
          throw error;
        }
        if (
          this.pendingTurnPresentations.get(eventRequestTag) ===
          pendingPresentation
        ) {
          this.pendingTurnPresentations.delete(eventRequestTag);
        }
        this.logger.info(
          `chat stale turn acceptance retired chatKey=${this.chatKey} requestTag=${eventRequestTag}`,
        );
        return;
      }
    }
    if (
      activeRequestTag &&
      eventRequestTag &&
      activeRequestTag !== eventRequestTag &&
      !this.acceptsScopedTurnEvent(eventRequestTag)
    ) {
      return;
    }
    switch (event.type) {
      case "frontend_status":
        return;
      case "working_state": {
        if (this.ownsManualCompactionPresentation()) return;
        void Promise.all([
          event.working
            ? this.startBackendWorkingMarker()
            : Promise.resolve(false),
          this.pollTyping(),
        ]).catch(() => false);
        return;
      }
      case "turn_accepted": {
        const expectedRequestTag = safeString(
          this.currentTurn?.requestTag,
        ).trim();
        const acceptedRequestTag = safeString(event.requestTag).trim();
        const acceptedPendingPresentation =
          this.pendingTurnPresentations.get(
            acceptedRequestTag,
          )?.backendAccepted;
        if (
          this.currentTurn?.outboxTurnFence &&
          !acceptedPendingPresentation &&
          (!acceptedRequestTag || acceptedRequestTag !== expectedRequestTag)
        ) {
          return;
        }
        const turn = acceptedPendingPresentation ? null : this.currentTurn;
        if (
          turn &&
          !turn.startupTimingLogged &&
          typeof turn.receivedAtMs === "number"
        ) {
          turn.startupTimingLogged = true;
          const acceptedAt = Date.now();
          const receivedToRunMs = Math.max(
            0,
            turn.startedAt - turn.receivedAtMs,
          );
          const connectMs = Math.max(
            0,
            (turn.frontendReadyAt || acceptedAt) - turn.startedAt,
          );
          const runToAcceptedMs = Math.max(0, acceptedAt - turn.startedAt);
          this.logger.info(
            `chat turn startup chatKey=${this.chatKey} messageId=${this.currentIncomingMessageId() || "unknown"} receivedToRunMs=${receivedToRunMs} connectMs=${connectMs} runToAcceptedMs=${runToAcceptedMs} receivedToAcceptedMs=${Math.max(0, acceptedAt - turn.receivedAtMs)}`,
          );
        }
        if (!acceptedPendingPresentation) {
          this.backendAcceptedIncomingMessageId =
            this.currentIncomingMessageId();
          this.markAcceptedMessage(this.backendAcceptedIncomingMessageId);
        }
        return;
      }
      case "turn_waiting":
        await this.showWaitingReaction(event.requestTag);
        return;
      case "queue_idle":
        await this.clearAllWaitingReactions({ startDeferredWorking: true });
        return;
      case "user_message_start": {
        const requestTag = safeString(event.requestTag).trim();
        if (requestTag) {
          this.startedReactionRequestTags.add(requestTag);
        }
        const hadWaitingReaction = Boolean(
          event.requestTag &&
          (this.waitingReactionCreatesByRequestTag.has(event.requestTag) ||
            this.waitingReactionsByRequestTag.has(event.requestTag) ||
            this.waitingReactionClearsByRequestTag.has(event.requestTag)),
        );
        const waitingReactionCleared =
          !hadWaitingReaction ||
          (event.requestTag
            ? await this.clearWaitingReaction(event.requestTag)
            : true);
        this.backendAcceptedIncomingMessageId = this.currentIncomingMessageId();
        this.markAcceptedMessage(this.backendAcceptedIncomingMessageId);
        if (waitingReactionCleared) {
          if (requestTag) {
            this.deferredWorkingReactionRequestTags.delete(requestTag);
          }
          await this.startBackendAcceptedWorkingReaction();
        } else if (hadWaitingReaction && requestTag) {
          this.deferredWorkingReactionRequestTags.add(requestTag);
        }
        return;
      }
      case "passive_notice":
        if (event.noticeKind === "compaction_end") {
          await this.deliverAutomaticCompactionEndNotice(event.text);
          return;
        }
        if (event.noticeKind === "todo" && event.deferDuringTurn === false) {
          await this.sendTodoPassiveNoticeNow(event);
          return;
        }
        if (event.level === "error" && event.deferDuringTurn === false) {
          await this.sendErrorNoticeNow(event.text);
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
      case "assistant_summary":
        if (this.acceptsOwnedProgressEvent(event.requestTag)) {
          await this.showAssistantSummary(event.text);
        }
        return;
      case "assistant_interim":
        if (this.acceptsOwnedProgressEvent(event.requestTag)) {
          await this.deliverAssistantInterim(event.text);
        }
        return;
      case "turn_complete":
        if (event.requestTag) {
          await this.clearWaitingReaction(event.requestTag);
          this.startedReactionRequestTags.delete(event.requestTag);
          this.deferredWorkingReactionRequestTags.delete(event.requestTag);
        }
        if (
          this.currentTurn?.outboxTurnFence &&
          (!event.chatDeliveryContext || !event.terminalRecord)
        ) {
          throw new Error("chat_terminal_record_missing");
        }
        if (event.chatDeliveryContext) {
          await this.settleProjectedTurnComplete(event);
        } else if (this.acceptsScopedTurnEvent(event.requestTag)) {
          await this.settleProjectedTurnComplete(event);
        }
        return;
      case "turn_error":
        if (event.requestTag) {
          await this.clearWaitingReaction(event.requestTag);
          this.startedReactionRequestTags.delete(event.requestTag);
          this.deferredWorkingReactionRequestTags.delete(event.requestTag);
        }
        if (
          this.currentTurn?.outboxTurnFence &&
          (!event.chatDeliveryContext || !event.terminalRecord)
        ) {
          throw new Error("chat_terminal_record_missing");
        }
        if (event.chatDeliveryContext) {
          await this.settleProjectedTurnError(event);
        } else if (this.acceptsScopedTurnEvent(event.requestTag)) {
          await this.settleProjectedTurnError(event);
        }
        return;
    }
  }
}

export function loadChatSettings(settingsPath: string) {
  const settings: any = readJsonFileOrDefault(settingsPath, {});
  if (settings.enableSkillCommands == null) settings.enableSkillCommands = true;
  return settings;
}
