import {
  missingSessionFileError,
  normalizeSessionRef,
  sessionFileExists,
} from "../session/ref.js";
import {
  applyFrontendBuiltinCommandText,
  frontendCommandNameFromLine,
  isFrontendNewSessionCommand,
  parseFrontendCompactCommand,
  resolveRinFrontendCommandResponses,
  type RinFrontendCommandResponses,
} from "./command-responses.js";
import { getRinNonInteractiveCommandInteractionPolicy } from "./command-dispatcher.js";
import { sleep } from "../platform/process.js";
import { safeString } from "../text-utils.js";
import {
  hasRinToolStartupOptions,
  resolveRinActiveToolNames,
  serializeRinToolStartupOptions,
  type RinToolStartupOptions,
} from "../rin-lib/tool-options.js";
import type { RinPiPassthroughOptions } from "../rin-lib/pi-passthrough.js";
import { createRinFrontendBackendEventTranslator } from "./backend-events.js";
import {
  normalizeFrontendIdentity,
  sourceFrontendIdentity,
  type RinFrontendIdentity,
} from "./frontend-identity.js";
import {
  createRinFrontendTurnCancelledError,
  isRinFrontendTurnCancelledError,
} from "./lifecycle-errors.js";
import {
  applyRinFrontendLifecycleEvent,
  executeRinFrontendInterruptIntent,
  projectRinFrontendLifecycleEvent,
} from "./frontend-lifecycle.js";
import { injectPromptContextHeader } from "./prompt-context.js";
import {
  submitNativeFrontendPromptTurn,
  type RinFrontendPromptTurnInput,
} from "./input-submission.js";
import {
  handleRinRpcSessionEvent,
  type RinRpcSessionEventTarget,
} from "./rpc-session-events.js";
import type {
  RinChatDeliveryContext,
  RinFrontendBackendEvent,
  RinFrontendClient,
  RinFrontendEvent,
  RinNewSessionResult,
  RinPromptContext,
  RinSessionState,
} from "./types.js";

export {
  submitNativeFrontendPromptTurn,
  type RinFrontendPromptTurnInput,
} from "./input-submission.js";

export type RinFrontendTurnPhase =
  | "idle"
  | "connecting"
  | "starting"
  | "sending"
  | "working";

export type RinFrontendTurnResult = {
  finalText?: string;
  result?: any;
  sessionId?: string;
  sessionFile?: string;
  requestTag?: string;
  chatDeliveryContext?: RinChatDeliveryContext;
  outcome?:
    | "terminalOwner"
    | "nonterminal"
    | "rejected"
    | "indeterminate"
    | "rejoined";
  originalOutcome?:
    | "terminalOwner"
    | "nonterminal"
    | "rejected"
    | "indeterminate";
  promptAccepted?: boolean;
  superseded?: boolean;
  terminalRecord?: {
    terminalId: string;
    state: "complete" | "error" | "interrupted";
    terminalAt?: string;
  };
};

function isRecoverableConnectionError(error: unknown) {
  const message = safeString((error as any)?.message || error).trim();
  if (message.includes("rpc_turn_queued_offline")) return false;
  return (
    isRinFrontendTurnCancelledError(error) ||
    /rin_tui_not_connected|rin_disconnected|frontend_turn_driver_disposed/.test(
      message,
    ) ||
    /rin_worker_(?:exit|unavailable|oom|cleanup_failed)/.test(message)
  );
}

export type RinFrontendPassiveNoticeEvent = Extract<
  RinFrontendBackendEvent,
  { type: "passive_notice" }
> & { requestTag?: string };

export type RinFrontendEventHandlingFailure = {
  stage: "client_event" | "frontend_listener" | "terminal_listener";
  error: unknown;
  clientEvent?: RinFrontendEvent;
  frontendEvent?: RinFrontendTurnDriverEvent;
};

export type RinFrontendTurnDriverEvent =
  | { type: "frontend_status"; phase: RinFrontendTurnPhase }
  | { type: "working_state"; working: boolean }
  | { type: "turn_accepted"; requestTag?: string }
  | { type: "turn_waiting"; requestTag: string }
  | { type: "queue_idle" }
  | {
      type: "user_message_start";
      text: string;
      requestTag?: string;
    }
  | RinFrontendPassiveNoticeEvent
  | { type: "compaction_start_notice"; text: string }
  | { type: "assistant_summary"; text: string; requestTag?: string }
  | { type: "assistant_interim"; text: string; requestTag?: string }
  | {
      type: "turn_complete";
      finalText: string;
      result?: unknown;
      sessionId?: string;
      sessionFile?: string;
      requestTag?: string;
      chatDeliveryContext?: RinChatDeliveryContext;
      terminalRecord?: {
        terminalId: string;
        state: "complete" | "error" | "interrupted";
        terminalAt?: string;
      };
    }
  | {
      type: "turn_error";
      error: string;
      sessionId?: string;
      sessionFile?: string;
      requestTag?: string;
      chatDeliveryContext?: RinChatDeliveryContext;
      terminalRecord?: {
        terminalId: string;
        state: "complete" | "error" | "interrupted";
        terminalAt?: string;
      };
    };

export type RinFrontendTurnClient = RinFrontendClient & {
  ensureSessionReady?: (
    restoreSessionFile?: string,
    managedSessionLeaf?: string,
    toolOptions?: RinToolStartupOptions &
      Pick<RinPiPassthroughOptions, "piStartupOptions">,
  ) => Promise<Record<string, unknown>>;
  shutdownSession?: () => Promise<unknown>;
  terminateSession?: () => Promise<unknown>;
};

export function shouldDeferPassiveNoticeForTurnState(state: {
  liveTurn?: unknown;
  isStreaming?: boolean;
  turnActive?: boolean;
}) {
  return Boolean(state.liveTurn || state.isStreaming || state.turnActive);
}

function sameFrontendSessionFile(left: unknown, right: unknown) {
  const leftText = safeString(left).trim();
  const rightText = safeString(right).trim();
  return Boolean(leftText && rightText && leftText === rightText);
}

function parseResumeCommandTarget(commandLine: string) {
  const trimmed = safeString(commandLine).trim();
  if (!trimmed.startsWith("/resume ")) return "";
  return trimmed.slice("/resume ".length).trim();
}

function requireNativeInputOutcome(value: unknown) {
  const outcome = safeString((value as any)?.outcome).trim();
  if (
    ![
      "terminalOwner",
      "nonterminal",
      "rejected",
      "indeterminate",
      "rejoined",
    ].includes(outcome)
  ) {
    throw new Error("rin_prompt_outcome_invalid");
  }
  const originalOutcome = safeString((value as any)?.originalOutcome).trim();
  if (
    outcome === "rejoined" &&
    !["terminalOwner", "nonterminal", "rejected", "indeterminate"].includes(
      originalOutcome,
    )
  ) {
    throw new Error("rin_prompt_outcome_invalid");
  }
  return {
    outcome: outcome as NonNullable<RinFrontendTurnResult["outcome"]>,
    ...(["terminalOwner", "nonterminal", "rejected", "indeterminate"].includes(
      originalOutcome,
    )
      ? {
          originalOutcome: originalOutcome as NonNullable<
            RinFrontendTurnResult["originalOutcome"]
          >,
        }
      : {}),
  };
}

export class RinFrontendTurnDriver {
  private readonly clientFactory: () => RinFrontendTurnClient;
  private readonly promptSource: string;
  private readonly commandResponses: RinFrontendCommandResponses;
  private readonly frontendIdentity: RinFrontendIdentity;
  private readonly onEventHandlingError?: (
    failure: RinFrontendEventHandlingFailure,
  ) => void | Promise<void>;
  client: RinFrontendTurnClient | null = null;
  private frontendState: Record<string, any> = {};
  liveTurn: {
    requestTag?: string;
    chatDeliveryContext?: RinChatDeliveryContext;
    promise: Promise<any>;
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  } | null = null;
  private readonly backendEventTranslator;
  latestAssistantText = "";
  frontendPhase: RinFrontendTurnPhase = "idle";
  private backendTurnRequestTag = "";
  listeners = new Set<
    (event: RinFrontendTurnDriverEvent) => void | Promise<void>
  >();
  private liveTurnRecoveryContext: {
    sessionFile?: string;
  } | null = null;
  private disconnectedTurnRecovery: Promise<void> | null = null;
  private turnInterruptionSeq = 0;
  private ignoredTerminalRequestTags = new Set<string>();
  private readonly startedRequestTags = new Set<string>();
  private readonly acknowledgedIgnoredTerminalRequestTags = new Set<string>();
  private readonly ignoredTerminalAckTasks = new Map<string, Promise<void>>();
  private readonly committedTerminalProjections = new Set<string>();
  private readonly terminalProjectionTasks = new Map<
    string,
    Promise<boolean>
  >();
  private pendingTurnCount = 0;
  private readonly pendingSubmissionCancellations = new Map<
    string,
    (error: Error) => void
  >();
  private daemonShutdownDetached = false;

  constructor(options: {
    clientFactory: () => RinFrontendTurnClient;
    promptSource?: string;
    commandResponses?: Partial<RinFrontendCommandResponses>;
    frontendIdentity?: RinFrontendIdentity;
    onEventHandlingError?: (
      failure: RinFrontendEventHandlingFailure,
    ) => void | Promise<void>;
  }) {
    this.clientFactory = options.clientFactory;
    this.promptSource = safeString(options.promptSource).trim() || "frontend";
    this.commandResponses = resolveRinFrontendCommandResponses(
      options.commandResponses,
    );
    this.frontendIdentity =
      normalizeFrontendIdentity(options.frontendIdentity) ||
      sourceFrontendIdentity(this.promptSource);
    this.onEventHandlingError = options.onEventHandlingError;
    this.backendEventTranslator = createRinFrontendBackendEventTranslator({
      commandResponses: this.commandResponses,
    });
  }

  subscribe(
    listener: (event: RinFrontendTurnDriverEvent) => void | Promise<void>,
  ) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private logEventHandlingError(
    failure: RinFrontendEventHandlingFailure,
    reportError?: unknown,
  ) {
    const eventType =
      failure.frontendEvent?.type || failure.clientEvent?.type || "unknown";
    console.error(
      `[rin frontend] event handling failed stage=${failure.stage} event=${eventType}`,
      failure.error,
    );
    if (reportError !== undefined) {
      console.error("[rin frontend] event error reporter failed", reportError);
    }
  }

  private reportEventHandlingError(failure: RinFrontendEventHandlingFailure) {
    if (!this.onEventHandlingError) {
      this.logEventHandlingError(failure);
      return;
    }
    try {
      void Promise.resolve(this.onEventHandlingError(failure)).catch(
        (reportError) => {
          this.logEventHandlingError(failure, reportError);
        },
      );
    } catch (reportError) {
      this.logEventHandlingError(failure, reportError);
    }
  }

  private emit(event: RinFrontendTurnDriverEvent) {
    for (const listener of this.listeners) {
      try {
        void Promise.resolve(listener(event)).catch((error) => {
          this.reportEventHandlingError({
            stage: "frontend_listener",
            error,
            frontendEvent: event,
          });
        });
      } catch (error) {
        this.reportEventHandlingError({
          stage: "frontend_listener",
          error,
          frontendEvent: event,
        });
      }
    }
  }

  private async emitAndWait(event: RinFrontendTurnDriverEvent) {
    await Promise.all([...this.listeners].map((listener) => listener(event)));
  }

  private async disconnectSupersededClient(client: RinFrontendTurnClient) {
    if (!this.daemonShutdownDetached && this.client === client) return false;
    await client.disconnect?.().catch(() => {});
    return true;
  }

  async connect(options: { restoreSessionFile?: string } = {}) {
    if (this.daemonShutdownDetached) return false;
    const client = this.client || this.clientFactory();
    this.client = client;
    if (!client.isConnected()) {
      try {
        await client.connect();
      } catch (error) {
        if (await this.disconnectSupersededClient(client)) return false;
        throw error;
      }
      if (await this.disconnectSupersededClient(client)) return false;
      client.subscribe((event: RinFrontendEvent) => {
        void this.handleClientEvent(event).catch((error) => {
          this.reportEventHandlingError({
            stage: "client_event",
            error,
            clientEvent: event,
          });
        });
      });
    }

    const wantedSessionFile = safeString(
      options.restoreSessionFile || "",
    ).trim();
    if (wantedSessionFile) {
      await this.selectSessionTarget(wantedSessionFile);
      if (await this.disconnectSupersededClient(client)) return false;
      return true;
    }
    await this.refreshFrontendState().catch(() => {});
    if (await this.disconnectSupersededClient(client)) return false;
    return true;
  }

  dispose() {
    const cancellation = createRinFrontendTurnCancelledError();
    for (const reject of this.pendingSubmissionCancellations.values()) {
      reject(cancellation);
    }
    this.pendingSubmissionCancellations.clear();
    this.failLiveTurn(cancellation);
    this.resetAssistantSegmentTracking();
    this.startedRequestTags.clear();
    this.frontendPhase = "idle";
    const client = this.client;
    this.client = null;
    this.frontendState = {};
    if (client?.disconnect) {
      void client.disconnect().catch(() => {});
    }
  }

  async detachForDaemonShutdown() {
    this.daemonShutdownDetached = true;
    const client = this.client;
    this.client = null;
    if (client?.disconnect) {
      await client.disconnect().catch(() => {});
    }
  }

  async shutdownSession() {
    if (!this.client?.isConnected()) return;
    if (typeof this.client.shutdownSession === "function") {
      await this.client.shutdownSession();
    } else {
      await this.client.request({ type: "shutdown_session" });
    }
    this.resetAssistantSegmentTracking();
    this.frontendPhase = "idle";
    const client = this.client;
    this.client = null;
    this.frontendState = {};
    if (client?.disconnect) {
      await client.disconnect().catch(() => {});
    }
  }

  async terminateSession() {
    if (!this.client?.isConnected()) return;
    if (typeof this.client.terminateSession === "function") {
      await this.client.terminateSession();
    } else {
      await this.client.request({ type: "terminate_session" });
    }
    this.failLiveTurn(new Error("frontend_session_terminated"));
    this.resetAssistantSegmentTracking();
    this.frontendPhase = "idle";
    this.frontendState = {};
  }

  private sessionFileFromReady(
    ready?: RinSessionState | Record<string, unknown>,
    fallback = "",
  ) {
    return safeString(
      (ready as any)?.sessionFile || fallback || this.currentSessionFile(),
    ).trim();
  }

  private assertTargetSessionReady(
    requestedSessionFile: string,
    actualSessionFile: unknown,
  ) {
    if (!requestedSessionFile) return;
    if (sameFrontendSessionFile(requestedSessionFile, actualSessionFile))
      return;
    throw new Error("frontend_session_restore_mismatch");
  }

  private async getStateForSession(sessionFile?: string) {
    if (!this.client) return this.frontendState;
    const wanted = safeString(sessionFile || "").trim();
    if (!wanted) return await this.client.getState();
    return await this.client.request<Record<string, unknown>>({
      type: "get_state",
      sessionFile: wanted,
    });
  }

  private applyBackendWorkingState(
    working: boolean,
    previousWorking = Boolean(this.frontendState.working),
  ) {
    this.frontendState.working = working;
    this.setFrontendPhase(working ? "working" : "idle");
    if (working !== previousWorking) {
      this.emit({ type: "working_state", working });
    }
  }

  private applyFrontendStateSnapshot(state: RinSessionState | undefined) {
    const previousWorking = Boolean(this.frontendState.working);
    this.frontendState = { ...this.frontendState, ...(state || {}) };
    if (state && !Object.prototype.hasOwnProperty.call(state, "requestTag")) {
      delete this.frontendState.requestTag;
    }
    if (Boolean(state?.turnActive || state?.isStreaming)) {
      this.backendTurnRequestTag = safeString(state?.requestTag).trim();
    }
    if (typeof state?.working === "boolean") {
      this.applyBackendWorkingState(state.working, previousWorking);
    }
    return this.frontendState;
  }

  private async refreshFrontendState(sessionFile?: string) {
    if (!this.client) return this.frontendState;
    const state = await this.getStateForSession(sessionFile);
    return this.applyFrontendStateSnapshot(state);
  }

  private updateFrontendStateFrom(value: unknown) {
    const session = normalizeSessionRef(value);
    if (session.sessionId) this.frontendState.sessionId = session.sessionId;
    if (session.sessionFile) {
      this.frontendState.sessionFile = session.sessionFile;
    }
  }

  private replaceFrontendSessionRefFrom(value: unknown) {
    const session = normalizeSessionRef(value);
    this.frontendState.sessionId = session.sessionId || undefined;
    this.frontendState.sessionFile = session.sessionFile || undefined;
  }

  currentSessionId() {
    return safeString(this.frontendState.sessionId || "").trim();
  }

  currentSessionFile() {
    return safeString(this.frontendState.sessionFile || "").trim();
  }

  async acknowledgeTerminal(requestTag: string, terminalId: string) {
    if (!this.client) throw new Error("frontend_session_not_connected");
    return await this.client.request({
      type: "ack_turn_terminal",
      requestTag,
      terminalId,
    });
  }

  async projectAuthoritativeTerminal(payload: Record<string, unknown>) {
    const translated = this.backendEventTranslator.translate({
      type: "ui",
      payload,
    });
    let projected = false;
    for (const event of translated) {
      if (event.type !== "turn_complete" && event.type !== "turn_error") {
        continue;
      }
      await this.handleBackendEvent(event);
      projected = true;
    }
    return projected;
  }

  async recoverUnacknowledgedChatTerminals(chatKey: string) {
    if (!this.client) throw new Error("frontend_session_not_connected");
    const response: any = await this.client.request({
      type: "list_unacknowledged_chat_terminals",
      chatKey,
    });
    const terminals = Array.isArray(response?.terminals)
      ? response.terminals
      : [];
    for (const terminal of terminals) {
      await this.projectAuthoritativeTerminal(terminal);
    }
    return terminals.length;
  }

  private async applySessionName(sessionName?: string) {
    const name = safeString(sessionName || "").trim();
    if (!name || !this.client) return;
    if (safeString(this.frontendState.sessionName || "").trim() === name) {
      return;
    }
    await this.client.request({ type: "set_session_name", name });
    this.frontendState.sessionName = name;
  }

  private createTurnRequestTag() {
    return `frontend_turn_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  private startLiveTurn(
    requestTag?: string,
    chatDeliveryContext?: RinChatDeliveryContext,
  ) {
    if (this.liveTurn) throw new Error("frontend_turn_already_running");
    const backendAlreadyActive = Boolean(
      this.frontendState.turnActive || this.frontendState.isStreaming,
    );
    const activeBackendRequestTag = safeString(
      this.frontendState.requestTag,
    ).trim();
    let resolve!: (value: any) => void;
    let reject!: (error: Error) => void;
    const liveTurn = {
      requestTag,
      chatDeliveryContext,
      promise: new Promise<any>((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
      }),
      resolve: (value: any) => {
        if (this.liveTurn === liveTurn) this.liveTurn = null;
        resolve(value);
      },
      reject: (error: Error) => {
        if (this.liveTurn === liveTurn) this.liveTurn = null;
        reject(error);
      },
    };
    liveTurn.promise.catch(() => {});
    this.liveTurn = liveTurn;
    this.backendTurnRequestTag = backendAlreadyActive
      ? activeBackendRequestTag
      : safeString(requestTag).trim();
    return liveTurn;
  }

  private failLiveTurn(error: Error) {
    if (!this.liveTurn) return;
    const liveTurn = this.liveTurn;
    this.liveTurn = null;
    liveTurn.reject(error);
  }

  private setFrontendPhase(phase: RinFrontendTurnPhase) {
    if (this.frontendPhase === phase) return;
    this.frontendPhase = phase;
    this.emit({ type: "frontend_status", phase: this.frontendPhase });
  }

  private rejectLiveTurnAsAborted() {
    const pendingRequestTags = [...this.pendingSubmissionCancellations.keys()];
    const requestTag =
      safeString(this.liveTurn?.requestTag).trim() ||
      pendingRequestTags[0] ||
      "";
    for (const pendingRequestTag of pendingRequestTags) {
      this.ignoredTerminalRequestTags.add(pendingRequestTag);
      this.pendingSubmissionCancellations.get(pendingRequestTag)?.(
        new Error("chat_turn_aborted"),
      );
    }
    this.pendingSubmissionCancellations.clear();
    if (requestTag) {
      this.ignoredTerminalRequestTags.add(requestTag);
      while (this.ignoredTerminalRequestTags.size > 1024) {
        const oldest = this.ignoredTerminalRequestTags.values().next().value;
        if (!oldest) break;
        this.ignoredTerminalRequestTags.delete(oldest);
        this.acknowledgedIgnoredTerminalRequestTags.delete(oldest);
      }
    }
    const session = this.abortedTurnSessionRef();
    const lifecycleEvent = projectRinFrontendLifecycleEvent({
      type: "frontend_turn_aborted",
      error: "chat_turn_aborted",
      requestTag,
      ...session,
    });
    if (lifecycleEvent) {
      applyRinFrontendLifecycleEvent(this.frontendState, lifecycleEvent);
    }
    this.clearAssistantInterimState();
    this.setFrontendPhase("idle");
    this.failLiveTurn(new Error("chat_turn_aborted"));
  }

  private isTurnInterrupted(interruptionSeq: number) {
    return this.turnInterruptionSeq !== interruptionSeq;
  }

  private throwIfTurnInterrupted(interruptionSeq: number) {
    if (!this.isTurnInterrupted(interruptionSeq)) return;
    throw new Error("chat_turn_aborted");
  }

  private isStreaming() {
    return Boolean(
      this.frontendState.isStreaming || this.frontendState.turnActive,
    );
  }

  private isCompacting() {
    return Boolean(this.frontendState.isCompacting);
  }

  private inputSubmissionGate(sessionFile?: string, interruptionSeq?: number) {
    const hasInterruptionSeq = typeof interruptionSeq === "number";
    return {
      isCompacting: () => this.isCompacting(),
      isAborted: hasInterruptionSeq
        ? () => this.isTurnInterrupted(interruptionSeq)
        : undefined,
      abortErrorMessage: hasInterruptionSeq ? "chat_turn_aborted" : undefined,
      refresh: () => this.refreshFrontendState(sessionFile),
    };
  }

  private isSessionRecovering() {
    return Boolean(this.frontendState.sessionRecovering);
  }

  private isBackendWorking() {
    return Boolean(this.frontendState.working);
  }

  private emitPassiveNoticeAtPullCheckpoint(
    event: RinFrontendPassiveNoticeEvent,
    options: { deferDuringTurn?: boolean } = {},
  ) {
    if (
      options.deferDuringTurn !== false &&
      shouldDeferPassiveNoticeForTurnState({
        liveTurn: this.liveTurn,
        isStreaming: Boolean(this.frontendState.isStreaming),
        turnActive: Boolean(this.frontendState.turnActive),
      })
    ) {
      return;
    }
    this.emit(event);
  }

  private abortedTurnSessionRef() {
    return {
      sessionId: this.currentSessionId() || undefined,
      sessionFile: this.currentSessionFile() || undefined,
    };
  }

  interruptActiveTurnLikeTui() {
    const result = this.abortedTurnSessionRef();
    this.turnInterruptionSeq += 1;
    this.rejectLiveTurnAsAborted();
    try {
      void executeRinFrontendInterruptIntent(this.client, "stop_turn").catch(
        () => {},
      );
    } catch {}
    return result;
  }

  private resetAssistantSegmentTracking() {
    this.backendEventTranslator.resetAssistantSegments();
  }

  private hasRemoteOrLiveTurnActive() {
    return Boolean(
      this.liveTurn ||
      this.frontendState.isStreaming ||
      this.frontendState.turnActive,
    );
  }

  private isTurnActive() {
    return Boolean(
      this.pendingTurnCount > 0 || this.hasRemoteOrLiveTurnActive(),
    );
  }

  hasActiveTurn() {
    return this.isTurnActive();
  }

  isWorking() {
    return this.isBackendWorking();
  }

  hasWorkerActiveTurn() {
    return Boolean(
      this.frontendState.turnActive || this.frontendState.isStreaming,
    );
  }

  hasClient() {
    return Boolean(this.client);
  }

  private consumeIgnoredTerminal(payload: any) {
    if (!payload || payload.type !== "rpc_turn_event") return null;
    if (payload.event !== "complete" && payload.event !== "error") return null;
    const requestTag = safeString(payload.requestTag).trim();
    if (!requestTag || !this.ignoredTerminalRequestTags.has(requestTag)) {
      return null;
    }
    return {
      requestTag,
      terminalId: safeString(payload.terminalRecord?.terminalId).trim(),
    };
  }

  private async acknowledgeIgnoredTerminal(terminal: {
    requestTag: string;
    terminalId: string;
  }) {
    if (!terminal.terminalId) {
      this.ignoredTerminalRequestTags.delete(terminal.requestTag);
      this.acknowledgedIgnoredTerminalRequestTags.delete(terminal.requestTag);
      return;
    }
    if (this.acknowledgedIgnoredTerminalRequestTags.has(terminal.requestTag)) {
      return;
    }
    let task = this.ignoredTerminalAckTasks.get(terminal.requestTag);
    if (!task) {
      const acknowledgement = this.acknowledgeTerminal(
        terminal.requestTag,
        terminal.terminalId,
      )
        .then(() => {
          this.acknowledgedIgnoredTerminalRequestTags.add(terminal.requestTag);
        })
        .finally(() => {
          if (
            this.ignoredTerminalAckTasks.get(terminal.requestTag) ===
            acknowledgement
          ) {
            this.ignoredTerminalAckTasks.delete(terminal.requestTag);
          }
        });
      task = acknowledgement;
      this.ignoredTerminalAckTasks.set(terminal.requestTag, task);
    }
    await task.catch(() => {});
  }

  private terminalRpcTurnPayloadMatchesCurrentSession(payload: any) {
    if (!payload || payload.type !== "rpc_turn_event") return true;
    if (payload.event !== "complete" && payload.event !== "error") {
      return true;
    }
    const incomingRequestTag = safeString(payload.requestTag).trim();
    const incomingTurnId = safeString(
      payload.chatDeliveryContext?.turnId,
    ).trim();
    const activeTurnId = safeString(
      this.liveTurn?.chatDeliveryContext?.turnId,
    ).trim();
    if (incomingTurnId || activeTurnId) {
      if (
        !incomingTurnId ||
        (activeTurnId && incomingTurnId !== activeTurnId)
      ) {
        return false;
      }
    } else {
      const activeRequestTag = safeString(this.liveTurn?.requestTag).trim();
      if (
        incomingRequestTag &&
        activeRequestTag &&
        incomingRequestTag !== activeRequestTag &&
        this.backendTurnRequestTag &&
        incomingRequestTag !== this.backendTurnRequestTag
      ) {
        return false;
      }
    }
    const currentSessionFile = safeString(
      this.frontendState.sessionFile,
    ).trim();
    const incomingSessionFile = safeString(payload.sessionFile).trim();
    if (
      currentSessionFile &&
      incomingSessionFile &&
      currentSessionFile !== incomingSessionFile
    ) {
      return false;
    }
    const currentSessionId = safeString(this.frontendState.sessionId).trim();
    const incomingSessionId = safeString(payload.sessionId).trim();
    return !(
      currentSessionId &&
      incomingSessionId &&
      currentSessionId !== incomingSessionId
    );
  }

  private clearAssistantInterimState() {
    this.backendEventTranslator.resetAssistantSegments();
  }

  private async interruptLiveTurnAfterDisconnect() {
    if (
      !this.liveTurn ||
      this.daemonShutdownDetached ||
      this.disconnectedTurnRecovery
    ) {
      return;
    }
    const recovery = this.liveTurnRecoveryContext;
    const requestTag = safeString(this.liveTurn.requestTag).trim();
    if (!requestTag) {
      this.failLiveTurn(new Error("frontend_turn_interrupted"));
      this.liveTurnRecoveryContext = null;
      return;
    }
    this.disconnectedTurnRecovery = (async () => {
      while (this.liveTurn?.requestTag === requestTag) {
        try {
          await this.connect({ restoreSessionFile: recovery?.sessionFile });
          if (!this.client) throw new Error("frontend_session_not_connected");
          const payload = await this.client.request({
            type: "await_turn_terminal",
            requestTag,
            ...(recovery?.sessionFile
              ? { sessionFile: recovery.sessionFile }
              : {}),
          });
          await this.handleClientEvent(payload);
          return;
        } catch (error) {
          if (!isRecoverableConnectionError(error)) {
            const cause = safeString((error as any)?.message || error).trim();
            this.failLiveTurn(
              new Error(
                `frontend_turn_interrupted:${requestTag}${
                  recovery?.sessionFile ? `:${recovery.sessionFile}` : ""
                }${cause ? `:${cause}` : ""}`,
              ),
            );
            this.liveTurnRecoveryContext = null;
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    })().finally(() => {
      this.disconnectedTurnRecovery = null;
    });
    await this.disconnectedTurnRecovery;
  }

  private async selectSessionTarget(sessionFile?: string) {
    const wanted = safeString(sessionFile || "").trim();
    if (!wanted) return { changed: false };
    if (!this.client) throw new Error("frontend_session_not_connected");
    const before = this.currentSessionFile();
    await this.client.resumeSession(wanted, {
      frontendIdentity: this.frontendIdentity,
    });
    await this.refreshFrontendState(wanted).catch(() => {});
    return {
      changed: before !== wanted,
      sessionId: this.currentSessionId() || undefined,
      sessionFile: this.currentSessionFile() || wanted,
    };
  }

  async resumeSessionFile(sessionFile: string) {
    if (!sessionFileExists(sessionFile))
      throw missingSessionFileError(sessionFile);
    await this.connect();
    return await this.selectSessionTarget(sessionFile);
  }

  private async ensureSessionReady(
    restoreSessionFile = "",
    managedSessionLeaf = "",
    toolOptions?: RinToolStartupOptions &
      Pick<RinPiPassthroughOptions, "piStartupOptions"> & {
        disabledRinCapabilities?: string[];
      },
  ) {
    if (!this.client) throw new Error("frontend_session_not_connected");
    if (this.client.ensureSessionReady) {
      const ready = await this.client.ensureSessionReady(
        restoreSessionFile,
        managedSessionLeaf,
        toolOptions,
      );
      this.applyFrontendStateSnapshot(ready);
      return ready;
    }

    const wanted = safeString(restoreSessionFile || "").trim();
    const managedLeaf = safeString(managedSessionLeaf || "").trim();
    await this.refreshFrontendState(wanted).catch(() => {});
    if (managedLeaf && !wanted) {
      const serializedToolOptions = serializeRinToolStartupOptions(toolOptions);
      const resourceOptions = {
        ...(hasRinToolStartupOptions(serializedToolOptions)
          ? serializedToolOptions
          : {}),
        ...(toolOptions?.piStartupOptions !== undefined
          ? { piStartupOptions: toolOptions.piStartupOptions }
          : {}),
        ...(toolOptions?.disabledRinCapabilities !== undefined
          ? { disabledRinCapabilities: toolOptions.disabledRinCapabilities }
          : {}),
      };
      const value = await this.client.newSession({
        managedSessionLeaf: managedLeaf,
        frontendIdentity: this.frontendIdentity,
        ...(Object.keys(resourceOptions).length > 0 ? { resourceOptions } : {}),
      });
      if (value?.cancelled) throw new Error("rin_new_session_cancelled");
      this.replaceFrontendSessionRefFrom(value);
      await this.refreshFrontendState().catch(() => {});
    } else if (wanted) {
      await this.selectSessionTarget(wanted);
    }
    return {
      sessionId: this.currentSessionId() || undefined,
      sessionFile: this.currentSessionFile() || undefined,
    };
  }

  private async applyTurnToolOptions(
    options: RinToolStartupOptions | undefined,
    sessionFile?: string,
  ) {
    if (!hasRinToolStartupOptions(options)) return;
    if (!this.client) throw new Error("frontend_session_not_connected");
    const wanted = safeString(sessionFile || "").trim();
    const target = wanted ? { sessionFile: wanted } : {};
    const hasExplicitToolAllowlist = options?.tools !== undefined;
    const activeTools = hasExplicitToolAllowlist
      ? []
      : await this.client
          .request<{ tools?: unknown[] }>({
            type: "get_active_tools",
            ...target,
          })
          .then((data) => data?.tools)
          .catch(() => []);
    const toolNames = resolveRinActiveToolNames(activeTools, options);
    await this.client.request({
      type: "set_active_tools",
      toolNames,
      ...target,
    });
    await this.refreshFrontendState(wanted).catch(() => {});
  }

  async runCommand(
    commandLine: string,
    options: {
      assumeConnected?: boolean;
      assumeSessionReady?: boolean;
      skipSessionRecovery?: boolean;
      restoreSessionFile?: string;
      sessionFile?: string;
      managedSessionLeaf?: string;
    } = {},
  ) {
    const commandName = frontendCommandNameFromLine(commandLine);
    const compactCommand = parseFrontendCompactCommand(commandLine);
    const skipSessionRecovery = options.skipSessionRecovery === true;
    const restoreSessionFile = safeString(
      options.restoreSessionFile || "",
    ).trim();
    const sessionFile = safeString(options.sessionFile || "").trim();
    const managedSessionLeaf = safeString(
      options.managedSessionLeaf || "",
    ).trim();
    const interactionPolicy =
      getRinNonInteractiveCommandInteractionPolicy(commandLine);
    if (this.isTurnActive()) {
      if (interactionPolicy.activeTurnHandling === "abort") {
        return {
          handled: true,
          text: this.commandResponses.abort,
          ...this.interruptActiveTurnLikeTui(),
        };
      }
      if (interactionPolicy.activeTurnHandling === "interrupt_then_run") {
        this.interruptActiveTurnLikeTui();
      }
    }
    if (options.assumeConnected) {
      if (!this.client?.isConnected())
        throw new Error("frontend_session_not_connected");
    } else {
      await this.connect();
    }
    if (!this.client) throw new Error("frontend_session_not_connected");
    if (isFrontendNewSessionCommand(commandLine)) {
      if (sessionFile && !managedSessionLeaf) {
        throw new Error("new_session_session_file_unsupported");
      }
      const value: RinNewSessionResult = await this.client.newSession({
        ...(managedSessionLeaf ? { managedSessionLeaf } : {}),
        frontendIdentity: this.frontendIdentity,
      });
      if (!value?.cancelled) this.replaceFrontendSessionRefFrom(value);
      await this.refreshFrontendState().catch(() => {});
      return {
        handled: true,
        cancelled: Boolean(value?.cancelled),
        text: value?.cancelled
          ? this.commandResponses.newCancelled
          : this.commandResponses.new,
        sessionId: this.currentSessionId() || undefined,
        sessionFile: this.currentSessionFile() || undefined,
      };
    }
    const resumeTarget = parseResumeCommandTarget(commandLine);
    if (resumeTarget) {
      const sessions = await this.client.listSessions();
      const match = sessions.find(
        (item: any) =>
          safeString(item?.id).trim() === resumeTarget ||
          safeString(item?.path).trim() === resumeTarget,
      );
      if (!match) {
        throw new Error(`session not found: ${resumeTarget}`);
      }
      const targetSession =
        safeString((match as any)?.path).trim() || safeString(match.id).trim();
      await this.client.resumeSession(targetSession, {
        frontendIdentity: this.frontendIdentity,
      });
      await this.refreshFrontendState(targetSession).catch(() => {});
      return {
        handled: true,
        text: `Resumed session: ${safeString(match.id).trim()}`,
        sessionId: this.currentSessionId() || undefined,
        sessionFile: this.currentSessionFile() || targetSession || undefined,
      };
    }
    if (sessionFile) {
      if (!sessionFileExists(sessionFile))
        throw missingSessionFileError(sessionFile);
      if (skipSessionRecovery) await this.selectSessionTarget(sessionFile);
    }
    const ready = options.assumeSessionReady
      ? {
          sessionId: this.currentSessionId() || undefined,
          sessionFile: this.currentSessionFile() || undefined,
        }
      : !skipSessionRecovery
        ? await this.ensureSessionReady(
            sessionFile || restoreSessionFile,
            managedSessionLeaf,
          )
        : undefined;
    const targetSessionFile = this.sessionFileFromReady(
      ready,
      sessionFile || restoreSessionFile,
    );
    this.assertTargetSessionReady(
      sessionFile || restoreSessionFile,
      targetSessionFile,
    );
    const data: any = compactCommand.compact
      ? await this.client.compact(compactCommand.customInstructions, {
          sessionFile: targetSessionFile || undefined,
        })
      : await this.runCommandForSession(commandLine, targetSessionFile);
    if (interactionPolicy.activeTurnHandling === "abort") {
      this.rejectLiveTurnAsAborted();
    }
    const normalizedData = applyFrontendBuiltinCommandText(
      commandName,
      data,
      this.commandResponses,
    );
    return {
      ...normalizedData,
      sessionId:
        safeString(
          normalizedData?.sessionId ||
            ready?.sessionId ||
            this.currentSessionId(),
        ).trim() || undefined,
      sessionFile:
        safeString(
          normalizedData?.sessionFile ||
            ready?.sessionFile ||
            this.currentSessionFile(),
        ).trim() || undefined,
    };
  }

  private async runCommandForSession(
    commandLine: string,
    sessionFile?: string,
  ) {
    if (!this.client) throw new Error("frontend_session_not_connected");
    const wanted = safeString(sessionFile || "").trim();
    if (!wanted) return await this.client.runCommand(commandLine);
    return await this.client.request({
      type: "run_command",
      commandLine,
      sessionFile: wanted,
    });
  }

  private async resetModelOptionsFromSettings(sessionFile?: string) {
    if (!this.client) throw new Error("frontend_session_not_connected");
    const wanted = safeString(sessionFile || "").trim();
    if (wanted) {
      await this.client.request({
        type: "reset_model_options_from_settings",
        sessionFile: wanted,
      });
    } else {
      await this.client.resetModelOptionsFromSettings();
    }
    await this.refreshFrontendState(wanted);
  }

  private async applyTurnModelOptions(
    options: {
      model?: string;
      thinkingLevel?: string;
    },
    sessionFile?: string,
  ) {
    if (!this.client) throw new Error("frontend_session_not_connected");
    const wanted = safeString(sessionFile || "").trim();
    const modelRef = safeString(options.model || "").trim();
    if (modelRef) {
      const [provider, ...modelIdParts] = modelRef.split("/");
      const modelId = modelIdParts.join("/");
      const models = await this.client.listModels();
      const model = models.find(
        (item: any) => item?.provider === provider && item?.id === modelId,
      );
      if (!model) throw new Error(`frontend_model_not_found:${modelRef}`);
      if (wanted) {
        await this.client.request({
          type: "set_model",
          provider,
          modelId,
          persistSettings: false,
          sessionFile: wanted,
        });
      } else {
        await this.client.setModel(provider, modelId, {
          persistSettings: false,
        });
      }
    }

    const thinkingLevel = safeString(options.thinkingLevel || "").trim();
    if (thinkingLevel) {
      if (wanted) {
        await this.client.request({
          type: "set_thinking_level",
          level: thinkingLevel,
          persistSettings: false,
          sessionFile: wanted,
        });
      } else {
        await this.client.setThinkingLevel(thinkingLevel, {
          persistSettings: false,
        });
      }
      this.frontendState.thinkingLevel = thinkingLevel;
    }
  }

  private normalizeTurnCompletion(
    completion: RinFrontendTurnResult,
  ): RinFrontendTurnResult {
    const finalText = safeString(completion?.finalText).trim();
    this.latestAssistantText = finalText;
    this.liveTurnRecoveryContext = null;
    return {
      finalText,
      result: completion?.result,
      sessionId:
        safeString(completion?.sessionId || this.currentSessionId()).trim() ||
        undefined,
      sessionFile:
        safeString(
          completion?.sessionFile || this.currentSessionFile(),
        ).trim() || undefined,
    };
  }

  private finishResolvedSubmittedTurn() {
    this.frontendState.turnActive = false;
    this.frontendState.isStreaming = false;
    this.frontendState.sessionRecovering = false;
    this.setFrontendPhase("idle");
  }

  async submitTurn(
    input: {
      text: string;
      images?: any[];
      sessionFile?: string;
      restoreSessionFile?: string;
      managedSessionLeaf?: string;
      model?: string;
      thinkingLevel?: string;
      resetModelOptionsFromSettings?: boolean;
      promptContext?: RinPromptContext;
      source?: string;
      requestTag?: string;
      streamingBehavior?: "steer" | "followUp";
      assumeSessionReady?: boolean;
      piStartupOptions?: RinPiPassthroughOptions["piStartupOptions"];
      disabledRinCapabilities?: string[];
    } & RinToolStartupOptions,
  ): Promise<RinFrontendTurnResult> {
    const promptSource = safeString(input.source).trim() || this.promptSource;
    const sessionFile = safeString(input.sessionFile || "").trim();
    const restoreSessionFile = safeString(
      input.restoreSessionFile || "",
    ).trim();
    const managedSessionLeaf = safeString(
      input.managedSessionLeaf || "",
    ).trim();
    let ready: RinSessionState | Record<string, unknown> = {};
    if (input.assumeSessionReady) {
      if (!this.client) this.client = this.clientFactory();
      if (!this.client?.isConnected())
        throw new Error("frontend_session_not_connected");
      ready = {
        sessionId: this.currentSessionId() || undefined,
        sessionFile: this.currentSessionFile() || undefined,
      };
    } else {
      await this.connect();
      if (!this.client) throw new Error("frontend_session_not_connected");
      if (sessionFile && !sessionFileExists(sessionFile)) {
        throw missingSessionFileError(sessionFile);
      }
      ready = await this.ensureSessionReady(
        sessionFile || restoreSessionFile,
        managedSessionLeaf,
        input,
      );
    }
    const targetSessionFile = this.sessionFileFromReady(
      ready,
      sessionFile || restoreSessionFile,
    );
    this.assertTargetSessionReady(
      sessionFile || restoreSessionFile,
      targetSessionFile,
    );
    if (input.resetModelOptionsFromSettings) {
      await this.resetModelOptionsFromSettings(targetSessionFile);
    }
    await this.applyTurnToolOptions(input, targetSessionFile);
    await this.applyTurnModelOptions(
      {
        model: input.model,
        thinkingLevel: input.thinkingLevel,
      },
      targetSessionFile,
    );
    const inputGate = this.inputSubmissionGate(targetSessionFile);
    const requestTag =
      safeString(input.requestTag).trim() || this.createTurnRequestTag();
    const text = injectPromptContextHeader(input.promptContext, input.text);
    const admission = await submitNativeFrontendPromptTurn(this.client, {
      text,
      images: input.images,
      source: safeString(input.source).trim() ? promptSource : input.source,
      frontendIdentity: this.frontendIdentity,
      requestTag,
      streamingBehavior: input.streamingBehavior,
      promptContext: input.promptContext,
      sessionFile: targetSessionFile,
      gate: inputGate,
    });
    const observed = requireNativeInputOutcome(admission);
    return {
      ...observed,
      requestTag,
      promptAccepted:
        observed.outcome === "terminalOwner" ||
        (observed.outcome === "rejoined" &&
          observed.originalOutcome === "terminalOwner"),
      sessionId:
        safeString(ready?.sessionId || this.currentSessionId()).trim() ||
        undefined,
      sessionFile:
        safeString(ready?.sessionFile || this.currentSessionFile()).trim() ||
        undefined,
    };
  }

  async runTurn(
    input: {
      text: string;
      images?: any[];
      sessionFile?: string;
      restoreSessionFile?: string;
      managedSessionLeaf?: string;
      createSessionFileIfMissing?: boolean;
      sessionName?: string;
      model?: string;
      thinkingLevel?: string;
      resetModelOptionsFromSettings?: boolean;
      promptContext?: RinPromptContext;
      source?: string;
      requestTag?: string;
      streamingBehavior?: "steer" | "followUp";
      chatDeliveryContext?: RinChatDeliveryContext;
      assumeConnected?: boolean;
      assumeSessionReady?: boolean;
      piStartupOptions?: RinPiPassthroughOptions["piStartupOptions"];
      disabledRinCapabilities?: string[];
    } & RinToolStartupOptions,
  ): Promise<RinFrontendTurnResult> {
    const turnInterruptionSeq = this.turnInterruptionSeq;
    let activeRequestTag = "";
    this.pendingTurnCount += 1;
    try {
      const promptSource = safeString(input.source).trim() || this.promptSource;
      const sessionFile = safeString(input.sessionFile || "").trim();
      const restoreSessionFile = safeString(
        input.restoreSessionFile || "",
      ).trim();
      const managedSessionLeaf = safeString(
        input.managedSessionLeaf || "",
      ).trim();
      if (input.assumeConnected) {
        if (!this.client?.isConnected())
          throw new Error("frontend_session_not_connected");
      } else {
        await this.connect();
      }
      if (!this.client) throw new Error("frontend_session_not_connected");
      if (
        sessionFile &&
        !input.createSessionFileIfMissing &&
        !sessionFileExists(sessionFile)
      ) {
        throw missingSessionFileError(sessionFile);
      }
      const ready = input.assumeSessionReady
        ? {
            sessionId: this.currentSessionId() || undefined,
            sessionFile: this.currentSessionFile() || undefined,
          }
        : await this.ensureSessionReady(
            sessionFile || restoreSessionFile,
            managedSessionLeaf,
            input,
          );
      const targetSessionFile = this.sessionFileFromReady(
        ready,
        sessionFile || restoreSessionFile,
      );
      this.assertTargetSessionReady(
        sessionFile || restoreSessionFile,
        targetSessionFile,
      );
      await this.applySessionName(input.sessionName);
      await this.applyTurnToolOptions(input, targetSessionFile);
      const inputGate = this.inputSubmissionGate(
        targetSessionFile,
        turnInterruptionSeq,
      );
      if (input.resetModelOptionsFromSettings) {
        await this.resetModelOptionsFromSettings(targetSessionFile);
      }
      await this.applyTurnModelOptions(
        {
          model: input.model,
          thinkingLevel: input.thinkingLevel,
        },
        targetSessionFile,
      );
      const text = injectPromptContextHeader(
        input.promptContext,
        safeString(input.text).trim(),
      );
      const images = Array.isArray(input.images) ? input.images : [];
      this.throwIfTurnInterrupted(turnInterruptionSeq);
      const requestTag =
        safeString(input.requestTag).trim() || this.createTurnRequestTag();
      activeRequestTag = requestTag;
      const existingLiveTurn = this.liveTurn;
      this.setFrontendPhase("sending");
      let submission: unknown;
      let rejectSubmission!: (error: Error) => void;
      const submissionCancellation = new Promise<never>((_resolve, reject) => {
        rejectSubmission = reject;
      });
      this.pendingSubmissionCancellations.set(requestTag, rejectSubmission);
      try {
        submission = await Promise.race([
          submitNativeFrontendPromptTurn(this.client!, {
            text,
            images,
            source: promptSource,
            frontendIdentity: this.frontendIdentity,
            requestTag,
            streamingBehavior: input.streamingBehavior,
            chatDeliveryContext: input.chatDeliveryContext,
            promptContext: input.promptContext,
            sessionFile: targetSessionFile,
            gate: inputGate,
          }),
          submissionCancellation,
        ]);
      } catch (error) {
        const code = safeString(
          (error as any)?.code || (error as any)?.message || error,
        ).trim();
        const transientSubmissionFailure = [
          "rin_worker_exit",
          "rin_worker_unavailable",
          "rin_worker_oom",
          "rin_disconnected",
        ].some(
          (candidate) => code === candidate || code.startsWith(`${candidate}:`),
        );
        if (!transientSubmissionFailure) throw error;
        if (
          code.startsWith("rin_disconnected") &&
          this.daemonShutdownDetached
        ) {
          const detachedTurn =
            this.liveTurn ||
            this.startLiveTurn(requestTag, input.chatDeliveryContext);
          return await detachedTurn.promise;
        }
        if (existingLiveTurn) {
          await existingLiveTurn.promise.catch(() => {});
        }
        return await this.resumeTurn({
          requestTag,
          sessionFile: targetSessionFile,
          chatDeliveryContext: input.chatDeliveryContext,
        });
      } finally {
        if (
          this.pendingSubmissionCancellations.get(requestTag) ===
          rejectSubmission
        ) {
          this.pendingSubmissionCancellations.delete(requestTag);
        }
      }
      if (
        (submission as any)?.queued === true &&
        !this.startedRequestTags.has(requestTag)
      ) {
        this.emit({ type: "turn_waiting", requestTag });
      }
      const observed = requireNativeInputOutcome(submission);
      const effectiveOutcome =
        observed.outcome === "rejoined"
          ? observed.originalOutcome
          : observed.outcome;
      if (effectiveOutcome === "indeterminate") {
        throw new Error("rin_prompt_outcome_indeterminate");
      }
      const ownsTerminal = effectiveOutcome === "terminalOwner";
      if (!ownsTerminal) {
        return {
          ...observed,
          superseded: true,
          requestTag,
          sessionId:
            safeString(ready?.sessionId || this.currentSessionId()).trim() ||
            undefined,
          sessionFile:
            safeString(
              ready?.sessionFile || this.currentSessionFile(),
            ).trim() || undefined,
        };
      }
      if (existingLiveTurn) {
        await existingLiveTurn.promise.catch(() => {});
      }
      return await this.resumeTurn({
        requestTag,
        sessionFile: targetSessionFile,
        chatDeliveryContext: input.chatDeliveryContext,
      });
    } finally {
      if (activeRequestTag) this.startedRequestTags.delete(activeRequestTag);
      this.pendingTurnCount = Math.max(0, this.pendingTurnCount - 1);
    }
  }

  async resumeTurn(input: {
    requestTag: string;
    sessionFile?: string;
    chatDeliveryContext?: RinChatDeliveryContext;
  }) {
    const requestTag = safeString(input.requestTag).trim();
    if (!requestTag) throw new Error("frontend_turn_request_tag_missing");
    this.pendingTurnCount += 1;
    try {
      if (!this.client?.isConnected()) {
        await this.connect({ restoreSessionFile: input.sessionFile });
      }
      if (!this.client) throw new Error("frontend_session_not_connected");
      if (this.liveTurn) throw new Error("frontend_turn_busy");
      this.resetAssistantSegmentTracking();
      this.latestAssistantText = "";
      const liveTurn = this.startLiveTurn(
        requestTag,
        input.chatDeliveryContext,
      );
      this.liveTurnRecoveryContext = {
        sessionFile: safeString(input.sessionFile).trim() || undefined,
      };
      try {
        const event = await this.client.request<any>({
          type: "await_turn_terminal",
          sessionFile: safeString(input.sessionFile).trim() || undefined,
          requestTag,
        });
        if (this.liveTurn === liveTurn && event != null) {
          await this.handleClientEvent(event);
        }
      } catch (error) {
        if (isRecoverableConnectionError(error)) {
          await this.interruptLiveTurnAfterDisconnect();
        } else {
          this.failLiveTurn(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
      const completion = await liveTurn.promise;
      const finalText = safeString(completion?.finalText).trim();
      this.latestAssistantText = finalText;
      return {
        outcome: "terminalOwner" as const,
        finalText,
        result: completion?.result,
        sessionId:
          safeString(completion?.sessionId || this.currentSessionId()).trim() ||
          undefined,
        sessionFile:
          safeString(
            completion?.sessionFile ||
              input.sessionFile ||
              this.currentSessionFile(),
          ).trim() || undefined,
      };
    } finally {
      this.liveTurnRecoveryContext = null;
      this.pendingTurnCount = Math.max(0, this.pendingTurnCount - 1);
    }
  }

  private terminalProjectionIdentity(
    event: Extract<
      RinFrontendTurnDriverEvent,
      { type: "turn_complete" | "turn_error" }
    >,
  ) {
    const requestTag = safeString(event.requestTag).trim();
    return requestTag ? `request:${requestTag}` : "";
  }

  private terminalOwnsLiveTurn(requestTag?: string) {
    const terminalRequestTag = safeString(requestTag).trim();
    return Boolean(
      this.liveTurn &&
      terminalRequestTag &&
      (this.liveTurn.requestTag === terminalRequestTag ||
        this.backendTurnRequestTag === terminalRequestTag),
    );
  }

  private async emitTerminalAfterCommit(
    event: Extract<
      RinFrontendTurnDriverEvent,
      { type: "turn_complete" | "turn_error" }
    >,
  ) {
    const terminalIdentity = this.terminalProjectionIdentity(event);
    if (!terminalIdentity) {
      this.reportEventHandlingError({
        stage: "terminal_listener",
        error: new Error("rin_terminal_request_tag_missing"),
        frontendEvent: event,
      });
      return false;
    }
    if (this.committedTerminalProjections.has(terminalIdentity)) return true;

    let projection = this.terminalProjectionTasks.get(terminalIdentity);
    if (!projection) {
      projection = (async () => {
        const pendingListeners = new Set(this.listeners);
        let attempt = 0;
        while (pendingListeners.size > 0) {
          const failures: unknown[] = [];
          await Promise.all(
            Array.from(pendingListeners, async (listener) => {
              try {
                await listener(event);
                pendingListeners.delete(listener);
              } catch (error) {
                failures.push(error);
              }
            }),
          );
          if (failures.length === 0) return true;
          attempt += 1;
          for (const failure of failures) {
            this.reportEventHandlingError({
              stage: "terminal_listener",
              error: failure,
              frontendEvent: event,
            });
          }
          if (!this.client) return false;
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(2_000, 100 * 2 ** (attempt - 1))),
          );
        }
        return true;
      })();
      this.terminalProjectionTasks.set(terminalIdentity, projection);
    }

    try {
      if (!(await projection)) return false;
      this.committedTerminalProjections.add(terminalIdentity);
      return true;
    } finally {
      if (this.terminalProjectionTasks.get(terminalIdentity) === projection) {
        this.terminalProjectionTasks.delete(terminalIdentity);
      }
    }
  }

  async handleClientEvent(event: any) {
    if (!event || typeof event !== "object") return;
    if (event.type === "ui" && event.name === "connection_lost") {
      if (this.liveTurn) void this.interruptLiveTurnAfterDisconnect();
      return;
    }
    const backendPayload = event.type === "ui" ? event.payload : event;
    if (event.type === "ui") {
      const payload: any = event.payload;
      const ignoredTerminal = this.consumeIgnoredTerminal(payload);
      if (ignoredTerminal) {
        await this.acknowledgeIgnoredTerminal(ignoredTerminal);
        return;
      }
      if (!this.terminalRpcTurnPayloadMatchesCurrentSession(payload)) return;
      if (payload?.working === false) {
        this.applyBackendWorkingState(false);
      }
      if (
        projectRinFrontendLifecycleEvent(payload) ||
        typeof payload?.working === "boolean" ||
        payload?.type === "worker_exit" ||
        payload?.type === "queue_update"
      ) {
        const frontendState = this.frontendState;
        const eventTarget: RinRpcSessionEventTarget = {
          get turnActive() {
            return Boolean(frontendState.turnActive);
          },
          set turnActive(value: boolean) {
            frontendState.turnActive = Boolean(value);
          },
          get isStreaming() {
            return Boolean(frontendState.isStreaming);
          },
          set isStreaming(value: boolean) {
            frontendState.isStreaming = Boolean(value);
          },
          get isCompacting() {
            return Boolean(frontendState.isCompacting);
          },
          set isCompacting(value: boolean) {
            frontendState.isCompacting = Boolean(value);
          },
          get compactionReason() {
            return safeString(frontendState.compactionReason);
          },
          set compactionReason(value: string) {
            frontendState.compactionReason = safeString(value);
          },
          get retryAttempt() {
            return Number(frontendState.retryAttempt || 0);
          },
          set retryAttempt(value: number) {
            frontendState.retryAttempt = Number(value || 0);
          },
          get maxRetryAttempts() {
            return Number(frontendState.maxRetryAttempts || 0);
          },
          set maxRetryAttempts(value: number) {
            frontendState.maxRetryAttempts = Number(value || 0);
          },
          get retryDelayMs() {
            return Number(frontendState.retryDelayMs || 0);
          },
          set retryDelayMs(value: number) {
            frontendState.retryDelayMs = Number(value || 0);
          },
          get retryError() {
            return safeString(frontendState.retryError);
          },
          set retryError(value: string) {
            frontendState.retryError = safeString(value);
          },
          setTurnActive: (active: boolean) => {
            this.frontendState.turnActive = active;
          },
          setAgentStreaming: (streaming: boolean) => {
            this.frontendState.isStreaming = streaming;
          },
          handleSessionUnavailable: () => {
            this.frontendState.sessionRecovering = true;
            this.setFrontendPhase("connecting");
            if (this.liveTurn) {
              void this.interruptLiveTurnAfterDisconnect();
            }
          },
          handleSessionRecovered: () => {
            this.frontendState.sessionRecovering = false;
            if (!this.frontendState.working) {
              this.setFrontendPhase("idle");
            }
          },
          emitFrontendStatus: () => {},
          emitEvent: () => {},
        };
        await handleRinRpcSessionEvent(eventTarget, payload, {
          refreshMessages: async () => {},
          refreshMessagesAndSession: async () => {
            await this.refreshFrontendState(this.currentSessionFile()).catch(
              () => ({}),
            );
          },
        });
        if (
          payload.type === "queue_update" &&
          Array.isArray(payload.steering) &&
          Array.isArray(payload.followUp)
        ) {
          if (payload.steering.length + payload.followUp.length === 0) {
            this.emit({ type: "queue_idle" });
          }
        }
      }
    } else if (backendPayload?.working === false) {
      this.applyBackendWorkingState(false);
    }
    const backendEvents =
      event.type === "backend_event"
        ? [event.payload as RinFrontendBackendEvent]
        : this.backendEventTranslator.translate(event);
    for (const backendEvent of backendEvents) {
      await this.handleBackendEvent(backendEvent);
    }
    if (backendPayload?.working === true) {
      this.applyBackendWorkingState(true);
    }
  }

  private async handleBackendEvent(event: RinFrontendBackendEvent) {
    switch (event.type) {
      case "status":
        if (
          event.phase === "connecting" ||
          event.phase === "starting" ||
          event.phase === "sending"
        ) {
          this.setFrontendPhase(event.phase);
        } else if (event.phase === "idle" && !this.frontendState.working) {
          this.setFrontendPhase("idle");
        }
        if (typeof event.turnActive === "boolean") {
          this.frontendState.turnActive = event.turnActive;
        }
        if (typeof event.isStreaming === "boolean") {
          this.frontendState.isStreaming = event.isStreaming;
        }
        return;
      case "turn_accepted": {
        this.frontendState.turnActive = true;
        const acceptedRequestTag = safeString(event.requestTag).trim();
        if (acceptedRequestTag) {
          this.backendTurnRequestTag = acceptedRequestTag;
        }
        this.emit({
          type: "turn_accepted",
          ...(acceptedRequestTag ? { requestTag: acceptedRequestTag } : {}),
        });
        return;
      }
      case "user_message_start": {
        const requestTag = safeString(event.requestTag).trim();
        if (requestTag) this.startedRequestTags.add(requestTag);
        this.backendTurnRequestTag =
          requestTag ||
          this.backendTurnRequestTag ||
          safeString(this.liveTurn?.requestTag).trim();
        this.emit({
          type: "user_message_start",
          text: event.text,
          ...(safeString(event.requestTag).trim()
            ? { requestTag: safeString(event.requestTag).trim() }
            : {}),
        });
        return;
      }
      case "passive_notice":
        this.emitPassiveNoticeAtPullCheckpoint(
          {
            type: "passive_notice",
            text: event.text,
            level: event.level,
            ...(typeof event.deferDuringTurn === "boolean"
              ? { deferDuringTurn: event.deferDuringTurn }
              : {}),
            ...(event.noticeKind ? { noticeKind: event.noticeKind } : {}),
            ...(event.todoItems ? { todoItems: event.todoItems } : {}),
            ...(event.todoError ? { todoError: event.todoError } : {}),
            ...(event.sourceEventId
              ? { sourceEventId: event.sourceEventId }
              : {}),
            ...(safeString(event.requestTag).trim()
              ? { requestTag: safeString(event.requestTag).trim() }
              : {}),
          },
          { deferDuringTurn: event.deferDuringTurn },
        );
        return;
      case "compaction_start_notice":
        this.emit({ type: "compaction_start_notice", text: event.text });
        return;
      case "assistant_stream":
        this.latestAssistantText = event.text;
        return;
      case "assistant_summary":
        this.emit({
          type: "assistant_summary",
          text: event.text,
          requestTag: safeString(event.requestTag).trim() || undefined,
        });
        return;
      case "assistant_interim":
        this.emit({
          type: "assistant_interim",
          text: event.text,
          requestTag: safeString(event.requestTag).trim() || undefined,
        });
        return;
      case "assistant_final":
        this.latestAssistantText = event.text;
        return;
      case "turn_complete": {
        this.frontendState.turnActive = false;
        this.frontendState.isStreaming = false;
        this.updateFrontendStateFrom(event);
        const finalText = safeString(event.finalText).trim();
        this.latestAssistantText = finalText;
        if (!this.frontendState.working) {
          this.setFrontendPhase("idle");
        }
        const terminalEvent: Extract<
          RinFrontendTurnDriverEvent,
          { type: "turn_complete" }
        > = {
          type: "turn_complete",
          finalText,
          result: event.result,
          sessionId: event.sessionId,
          sessionFile: event.sessionFile,
          requestTag: safeString(event.requestTag).trim() || undefined,
          ...(event.chatDeliveryContext
            ? { chatDeliveryContext: event.chatDeliveryContext }
            : {}),
          ...(event.terminalRecord
            ? { terminalRecord: event.terminalRecord }
            : {}),
        };
        if (!(await this.emitTerminalAfterCommit(terminalEvent))) return;
        if (this.terminalOwnsLiveTurn(terminalEvent.requestTag)) {
          this.liveTurn.resolve({
            finalText,
            result: event.result,
            sessionId: event.sessionId,
            sessionFile: event.sessionFile,
            requestTag: terminalEvent.requestTag,
            chatDeliveryContext: event.chatDeliveryContext,
            terminalRecord: event.terminalRecord,
          });
        }
        return;
      }
      case "turn_error": {
        this.frontendState.turnActive = false;
        this.frontendState.isStreaming = false;
        this.updateFrontendStateFrom(event);
        if (!this.frontendState.working) {
          this.setFrontendPhase("idle");
        }
        const terminalEvent: Extract<
          RinFrontendTurnDriverEvent,
          { type: "turn_error" }
        > = {
          type: "turn_error",
          error: event.error,
          sessionId: event.sessionId,
          sessionFile: event.sessionFile,
          requestTag: safeString(event.requestTag).trim() || undefined,
          ...(event.chatDeliveryContext
            ? { chatDeliveryContext: event.chatDeliveryContext }
            : {}),
          ...(event.terminalRecord
            ? { terminalRecord: event.terminalRecord }
            : {}),
        };
        if (!(await this.emitTerminalAfterCommit(terminalEvent))) return;
        if (!this.terminalOwnsLiveTurn(terminalEvent.requestTag)) return;
        const error = new Error(event.error) as Error & {
          sessionId?: string;
          sessionFile?: string;
          rinTurnTerminal?: boolean;
        };
        error.sessionId = event.sessionId;
        error.sessionFile = event.sessionFile;
        error.rinTurnTerminal = true;
        this.failLiveTurn(error);
        return;
      }
    }
  }
}
