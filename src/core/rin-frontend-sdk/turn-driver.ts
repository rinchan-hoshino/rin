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
import type { RinSubmittedTurnResolution } from "./submitted-turn.js";
import {
  hasRinToolStartupOptions,
  resolveRinActiveToolNames,
  serializeRinToolStartupOptions,
  type RinToolStartupOptions,
} from "../rin-lib/tool-options.js";
import type { RinPiPassthroughOptions } from "../rin-lib/pi-passthrough.js";
import type { RinTodoItem } from "../rin-lib/todo-state.js";
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
import { replayPendingTerminalTurnEvent } from "./pending-terminal-turn.js";
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
  RinFrontendBackendEvent,
  RinFrontendClient,
  RinFrontendEvent,
  RinNewSessionResult,
  RinPromptAdmission,
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
  steered?: boolean;
  superseded?: boolean;
  sessionId?: string;
  sessionFile?: string;
};

const TURN_RESULT_INVARIANT_ERROR = "rin_turn_result_invariant_failed";
const TURN_RESULT_RECOVERY_TIMEOUT_ERROR = "rin_turn_result_recovery_timeout";

function isRecoverableConnectionError(error: unknown) {
  const message = safeString((error as any)?.message || error).trim();
  if (message.includes("rpc_turn_queued_offline")) return false;
  return (
    isRinFrontendTurnCancelledError(error) ||
    /rin_tui_not_connected|rin_disconnected|rin_session_recovering|frontend_turn_driver_disposed/.test(
      message,
    )
  );
}

export type RinFrontendPassiveNoticeEvent = {
  type: "passive_notice";
  text: string;
  level?: "info" | "warning" | "error";
  deferDuringTurn?: boolean;
  noticeKind?: "compaction_end" | "todo";
  todoItems?: RinTodoItem[];
  todoError?: string;
};

export type RinFrontendTurnDriverEvent =
  | { type: "frontend_status"; phase: RinFrontendTurnPhase }
  | { type: "turn_accepted" }
  | { type: "user_message_start"; text: string }
  | RinFrontendPassiveNoticeEvent
  | { type: "compaction_start_notice"; text: string }
  | { type: "assistant_interim"; text: string };

export type RinFrontendTurnClient = RinFrontendClient & {
  ensureSessionReady?: (
    restoreSessionFile?: string,
    managedSessionLeaf?: string,
    toolOptions?: RinToolStartupOptions &
      Pick<RinPiPassthroughOptions, "piStartupOptions">,
  ) => Promise<Record<string, unknown>>;
  shutdownSession?: () => Promise<unknown>;
  terminateSession?: () => Promise<unknown>;
  consumeQueuedOfflineOperation?: (requestTag?: string) => boolean;
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

function promptAdmissionAcceptedAs(admission: unknown) {
  const acceptedAs = safeString((admission as RinPromptAdmission)?.acceptedAs);
  return acceptedAs === "steer" ||
    acceptedAs === "followUp" ||
    acceptedAs === "rejoin"
    ? acceptedAs
    : acceptedAs === "prompt"
      ? "prompt"
      : "";
}

export class RinFrontendTurnDriver {
  private readonly clientFactory: () => RinFrontendTurnClient;
  private readonly promptSource: string;
  private readonly commandResponses: RinFrontendCommandResponses;
  private readonly frontendIdentity: RinFrontendIdentity;
  client: RinFrontendTurnClient | null = null;
  private frontendState: Record<string, any> = {};
  liveTurn: {
    requestTag?: string;
    promise: Promise<any>;
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  } | null = null;
  private readonly backendEventTranslator;
  latestAssistantText = "";
  assistantFinalReplyCommitted = false;
  frontendPhase: RinFrontendTurnPhase = "idle";
  private externalWorkingDepth = 0;
  listeners = new Set<(event: RinFrontendTurnDriverEvent) => void>();
  private reconnectingTurnPromise: Promise<void> | null = null;
  private liveTurnRecoveryContext: {
    sessionFile?: string;
  } | null = null;
  private turnInterruptionSeq = 0;
  private pendingTurnCount = 0;
  private daemonShutdownDetached = false;

  constructor(options: {
    clientFactory: () => RinFrontendTurnClient;
    promptSource?: string;
    commandResponses?: Partial<RinFrontendCommandResponses>;
    frontendIdentity?: RinFrontendIdentity;
  }) {
    this.clientFactory = options.clientFactory;
    this.promptSource = safeString(options.promptSource).trim() || "frontend";
    this.commandResponses = resolveRinFrontendCommandResponses(
      options.commandResponses,
    );
    this.frontendIdentity =
      normalizeFrontendIdentity(options.frontendIdentity) ||
      sourceFrontendIdentity(this.promptSource);
    this.backendEventTranslator = createRinFrontendBackendEventTranslator({
      commandResponses: this.commandResponses,
    });
  }

  subscribe(listener: (event: RinFrontendTurnDriverEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: RinFrontendTurnDriverEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {}
    }
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
        void this.handleClientEvent(event).catch(() => {});
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
    this.failLiveTurn(createRinFrontendTurnCancelledError());
    this.resetAssistantSegmentTracking();
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

  private async refreshFrontendState(sessionFile?: string) {
    if (!this.client) return this.frontendState;
    const state = await this.getStateForSession(sessionFile);
    this.frontendState = { ...this.frontendState, ...(state || {}) };
    return this.frontendState;
  }

  private updateFrontendStateFrom(value: unknown) {
    const session = normalizeSessionRef(value);
    if (session.sessionId) this.frontendState.sessionId = session.sessionId;
    if (session.sessionFile) {
      this.frontendState.sessionFile = session.sessionFile;
    }
  }

  currentSessionId() {
    return safeString(this.frontendState.sessionId || "").trim();
  }

  currentSessionFile() {
    return safeString(this.frontendState.sessionFile || "").trim();
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

  private startLiveTurn(requestTag?: string) {
    if (this.liveTurn) throw new Error("frontend_turn_already_running");
    let resolve!: (value: any) => void;
    let reject!: (error: Error) => void;
    const liveTurn = {
      requestTag,
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
    this.clearAssistantInterimState();
    this.frontendState.turnActive = false;
    this.frontendState.isStreaming = false;
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
      onWaiting: () => this.setFrontendPhase("working"),
    };
  }

  private isSessionRecovering() {
    return Boolean(this.frontendState.sessionRecovering);
  }

  private isVisibleChatWorkingTurn() {
    return Boolean(
      this.liveTurn ||
      this.frontendState.isStreaming ||
      this.frontendState.turnActive,
    );
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
      void this.client?.abort?.().catch(() => {});
    } catch {}
    return result;
  }

  private resetAssistantSegmentTracking() {
    this.backendEventTranslator.resetAssistantSegments();
    this.assistantFinalReplyCommitted = false;
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

  hasVisibleChatWorkingTurn() {
    return this.isVisibleChatWorkingTurn();
  }

  hasExplicitWorkingVisible() {
    return Boolean(this.frontendState.piWorkingVisible);
  }

  hasWorkerActiveTurn() {
    return this.hasVisibleChatWorkingTurn();
  }

  hasClient() {
    return Boolean(this.client);
  }

  private terminalRpcTurnPayloadMatchesLiveTurn(payload: any) {
    if (!payload || payload.type !== "rpc_turn_event") return true;
    if (payload.event !== "complete" && payload.event !== "error") {
      return true;
    }
    if (!this.liveTurn) return false;
    const current = safeString(this.liveTurn.requestTag || "").trim();
    const incoming = safeString(payload.requestTag || "").trim();
    return !(current && incoming && current !== incoming);
  }

  canSteerActiveTurn() {
    if (!this.hasRemoteOrLiveTurnActive()) return false;
    return !this.assistantFinalReplyCommitted;
  }

  private clearAssistantInterimState() {
    this.backendEventTranslator.resetAssistantSegments();
  }

  private async recoverLiveTurnAfterDisconnect() {
    if (this.daemonShutdownDetached) return;
    if (!this.liveTurn || this.reconnectingTurnPromise) {
      return await this.reconnectingTurnPromise;
    }
    const context = this.liveTurnRecoveryContext;
    this.reconnectingTurnPromise = (async () => {
      this.setFrontendPhase("connecting");
      let deadline = Date.now() + 120_000;
      while (
        this.liveTurn &&
        !this.daemonShutdownDetached &&
        Date.now() < deadline
      ) {
        try {
          const connected = await this.connect({
            restoreSessionFile: context?.sessionFile,
          });
          if (!connected || this.daemonShutdownDetached) break;
          await this.replayPendingTerminalTurnEvent(context?.sessionFile).catch(
            () => false,
          );
          if (!this.liveTurn || this.daemonShutdownDetached) break;
          const state = await this.refreshFrontendState(
            context?.sessionFile,
          ).catch(() => ({}));
          if (this.daemonShutdownDetached) break;
          if (
            Boolean((state as any)?.turnActive || (state as any)?.isStreaming)
          ) {
            deadline = Date.now() + 120_000;
            this.setFrontendPhase("working");
            await Promise.race([this.liveTurn.promise, sleep(1000)]);
            continue;
          }
          await sleep(1000);
        } catch {
          await sleep(1000);
        }
      }
      if (this.liveTurn && !this.daemonShutdownDetached) {
        this.failLiveTurn(new Error("frontend_turn_recovery_failed"));
      }
    })().finally(() => {
      this.reconnectingTurnPromise = null;
      this.liveTurnRecoveryContext = null;
    });
    return await this.reconnectingTurnPromise;
  }

  private throwIfQueuedOffline(requestTag?: string) {
    if (!this.client?.consumeQueuedOfflineOperation?.(requestTag)) return;
    throw new Error("rin_disconnected:rpc_turn_queued_offline");
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
      this.frontendState = { ...this.frontendState, ...(ready || {}) };
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
      this.updateFrontendStateFrom(value);
      await this.refreshFrontendState(this.currentSessionFile()).catch(
        () => {},
      );
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
      this.updateFrontendStateFrom(value);
      await this.refreshFrontendState(this.currentSessionFile()).catch(
        () => {},
      );
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
    if (!finalText) throw new Error(TURN_RESULT_INVARIANT_ERROR);
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

  private async replayPendingTerminalTurnEvent(sessionFile?: string) {
    if (!this.client || !this.liveTurn) return false;
    return await replayPendingTerminalTurnEvent(
      (command) => this.client!.request(command),
      { sessionFile: sessionFile || this.currentSessionFile() },
    );
  }

  private async resolveSubmittedTurnForSession(
    sessionFile: string | undefined,
    input: { text: string; sentAt?: number },
  ): Promise<RinSubmittedTurnResolution> {
    if (!this.client) return null;
    const sentAt = Number(input.sentAt || 0);
    if (!Number.isFinite(sentAt) || sentAt <= 0) return null;
    const text = safeString(input.text).trim();
    if (!text) return null;
    const wanted = safeString(sessionFile || "").trim();
    const resolved: any = await this.client
      .request({
        type: "resolve_submitted_turn",
        text,
        sentAt,
        ...(wanted ? { sessionFile: wanted } : {}),
      })
      .catch(() => null);
    if (!resolved) return null;
    const errorMessage = safeString(resolved.error).trim();
    if (errorMessage) {
      this.finishResolvedSubmittedTurn();
      const error = new Error(errorMessage) as Error & {
        sessionId?: string;
        sessionFile?: string;
      };
      error.sessionId = safeString(resolved.sessionId).trim() || undefined;
      error.sessionFile = safeString(resolved.sessionFile).trim() || undefined;
      throw error;
    }
    if (resolved.submitted) return { submitted: true };
    if ("superseded" in resolved && resolved.superseded) {
      this.finishResolvedSubmittedTurn();
      return {
        superseded: true,
        sessionId:
          safeString(resolved.sessionId || this.currentSessionId()).trim() ||
          undefined,
        sessionFile:
          safeString(
            resolved.sessionFile || this.currentSessionFile(),
          ).trim() || undefined,
      };
    }
    const finalText = safeString(resolved.finalText).trim();
    if (!finalText) return null;
    this.latestAssistantText = finalText;
    this.finishResolvedSubmittedTurn();
    return {
      finalText,
      result: resolved.result,
      sessionId:
        safeString(resolved.sessionId || this.currentSessionId()).trim() ||
        undefined,
      sessionFile:
        safeString(resolved.sessionFile || this.currentSessionFile()).trim() ||
        undefined,
    };
  }

  private async waitForExistingSubmittedTurn(
    input: { text: string; sentAt?: number },
    ready?: RinSessionState,
  ) {
    if (!this.client) throw new Error("frontend_session_not_connected");
    this.resetAssistantSegmentTracking();
    this.latestAssistantText = "";
    const liveTurn = this.liveTurn || this.startLiveTurn("");
    liveTurn.requestTag = "";
    const targetSessionFile = this.sessionFileFromReady(ready);
    this.liveTurnRecoveryContext = {
      sessionFile: targetSessionFile || undefined,
    };
    this.setFrontendPhase("working");
    await this.replayPendingTerminalTurnEvent(targetSessionFile).catch(
      () => false,
    );
    let deadline = Date.now() + 120_000;
    while (this.liveTurn === liveTurn && Date.now() < deadline) {
      const recovered = await this.resolveSubmittedTurnForSession(
        targetSessionFile,
        input,
      );
      if (recovered && !("submitted" in recovered)) {
        liveTurn.resolve(recovered);
        break;
      }
      const state = await this.refreshFrontendState(targetSessionFile).catch(
        () => ({}),
      );
      if (
        Boolean(
          (state as any)?.turnActive ||
          (state as any)?.isStreaming ||
          (state as any)?.sessionRecovering,
        )
      ) {
        deadline = Date.now() + 120_000;
      }
      const raced = await Promise.race([
        liveTurn.promise.then((completion) => ({ completion })),
        sleep(1000).then(() => ({})),
      ]);
      if ("completion" in raced)
        return this.normalizeTurnCompletion(raced.completion);
    }
    if (this.liveTurn === liveTurn) {
      const error = new Error(TURN_RESULT_RECOVERY_TIMEOUT_ERROR);
      this.failLiveTurn(error);
      throw error;
    }
    return this.normalizeTurnCompletion(await liveTurn.promise);
  }

  private async followActiveTurn(ready?: RinSessionState, requestTag = "") {
    if (!this.client) throw new Error("frontend_session_not_connected");
    const targetSessionFile = this.sessionFileFromReady(ready);
    this.resetAssistantSegmentTracking();
    this.latestAssistantText = "";
    const liveTurn = this.liveTurn || this.startLiveTurn(requestTag);
    liveTurn.requestTag = requestTag;
    this.liveTurnRecoveryContext = {
      sessionFile: targetSessionFile || undefined,
    };
    this.setFrontendPhase("working");
    await this.replayPendingTerminalTurnEvent(targetSessionFile).catch(
      () => false,
    );
    while (this.liveTurn === liveTurn) {
      const state: any = await this.refreshFrontendState(targetSessionFile);
      if (!Boolean(state?.turnActive || state?.isStreaming)) {
        if (this.isSessionRecovering() || state?.sessionRecovering) {
          await this.recoverLiveTurnAfterDisconnect();
          if (this.liveTurn === liveTurn) continue;
          break;
        }
        await this.replayPendingTerminalTurnEvent(targetSessionFile).catch(
          () => false,
        );
        const replayed = await Promise.race([
          liveTurn.promise.then((completion) => ({ completion })),
          sleep(1000).then(() => ({})),
        ]);
        if ("completion" in replayed) {
          return this.normalizeTurnCompletion(replayed.completion);
        }
        const error = new Error(TURN_RESULT_INVARIANT_ERROR);
        this.failLiveTurn(error);
        throw error;
      }
      const raced = await Promise.race([
        liveTurn.promise.then((completion) => ({ completion })),
        sleep(1000).then(() => ({})),
      ]);
      if ("completion" in raced)
        return this.normalizeTurnCompletion(raced.completion);
    }
    return this.normalizeTurnCompletion(await liveTurn.promise);
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
    await submitNativeFrontendPromptTurn(this.client, {
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
    this.throwIfQueuedOffline(requestTag);
    return {
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
      streamingBehavior?: "steer" | "follow";
      assumeConnected?: boolean;
      assumeSessionReady?: boolean;
      piStartupOptions?: RinPiPassthroughOptions["piStartupOptions"];
      disabledRinCapabilities?: string[];
    } & RinToolStartupOptions,
  ): Promise<RinFrontendTurnResult> {
    const turnInterruptionSeq = this.turnInterruptionSeq;
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

      if (this.hasRemoteOrLiveTurnActive()) {
        this.clearAssistantInterimState();
        const requestTag =
          safeString(input.requestTag).trim() || this.createTurnRequestTag();
        const admission = await submitNativeFrontendPromptTurn(this.client, {
          text,
          images,
          source: promptSource,
          frontendIdentity: this.frontendIdentity,
          requestTag,
          promptContext: input.promptContext,
          sessionFile: targetSessionFile,
          gate: inputGate,
        });
        this.throwIfQueuedOffline(requestTag);
        const acceptedAs = promptAdmissionAcceptedAs(admission);
        if (acceptedAs === "steer" || acceptedAs === "followUp") {
          return {
            steered: true,
            sessionId:
              safeString(ready?.sessionId || this.currentSessionId()).trim() ||
              undefined,
            sessionFile:
              safeString(
                ready?.sessionFile || this.currentSessionFile(),
              ).trim() || undefined,
          };
        }
        if (acceptedAs === "rejoin" || acceptedAs === "prompt") {
          return await this.followActiveTurn(ready, requestTag);
        }
        return await this.followActiveTurn(ready);
      }

      if (input.streamingBehavior !== "steer") {
        const existing = await this.resolveSubmittedTurnForSession(
          targetSessionFile,
          { text, sentAt: input.promptContext?.sentAt },
        );
        this.throwIfTurnInterrupted(turnInterruptionSeq);
        if (existing) {
          if ("submitted" in existing) {
            return await this.waitForExistingSubmittedTurn(
              { text, sentAt: input.promptContext?.sentAt },
              ready,
            );
          }
          return existing;
        }
      }

      this.throwIfTurnInterrupted(turnInterruptionSeq);
      this.resetAssistantSegmentTracking();
      this.latestAssistantText = "";
      const requestTag =
        safeString(input.requestTag).trim() || this.createTurnRequestTag();
      const liveTurn = this.startLiveTurn(requestTag);
      this.setFrontendPhase("sending");
      this.liveTurnRecoveryContext = {
        sessionFile:
          safeString(ready?.sessionFile || this.currentSessionFile()).trim() ||
          undefined,
      };
      const promptSubmission = (async () => {
        this.throwIfTurnInterrupted(turnInterruptionSeq);
        const admission = await submitNativeFrontendPromptTurn(this.client!, {
          text,
          images,
          source: promptSource,
          requestTag,
          promptContext: input.promptContext,
          sessionFile: targetSessionFile,
          gate: inputGate,
        });
        this.throwIfQueuedOffline(requestTag);
        return admission;
      })();
      promptSubmission.catch(() => {});

      const firstResult = await Promise.race([
        promptSubmission.then(
          (admission) => ({ type: "prompt_submitted" as const, admission }),
          (error: unknown) => ({ type: "prompt_error" as const, error }),
        ),
        liveTurn.promise.then(
          (completion) => ({ type: "turn_complete" as const, completion }),
          (error: unknown) => ({ type: "turn_error" as const, error }),
        ),
      ]);

      if (firstResult.type === "prompt_error") {
        const error = firstResult.error;
        if (isRecoverableConnectionError(error)) {
          await this.recoverLiveTurnAfterDisconnect();
          return this.normalizeTurnCompletion(await liveTurn.promise);
        }
        this.failLiveTurn(
          error instanceof Error
            ? error
            : new Error(String(error || "frontend_turn_failed")),
        );
        this.liveTurnRecoveryContext = null;
        throw error;
      }
      if (firstResult.type === "turn_error") {
        if (isRecoverableConnectionError(firstResult.error)) {
          await this.recoverLiveTurnAfterDisconnect();
          return this.normalizeTurnCompletion(await liveTurn.promise);
        }
        this.liveTurnRecoveryContext = null;
        throw firstResult.error;
      }
      if (firstResult.type === "prompt_submitted") {
        const acceptedAs = promptAdmissionAcceptedAs(firstResult.admission);
        if (acceptedAs === "steer" || acceptedAs === "followUp") {
          liveTurn.resolve({ steered: true });
          this.liveTurnRecoveryContext = null;
          return {
            steered: true,
            sessionId:
              safeString(ready?.sessionId || this.currentSessionId()).trim() ||
              undefined,
            sessionFile:
              safeString(
                ready?.sessionFile || this.currentSessionFile(),
              ).trim() || undefined,
          };
        }
      }

      const completion =
        firstResult.type === "turn_complete"
          ? firstResult.completion
          : await liveTurn.promise;
      const finalText = safeString((completion as any)?.finalText).trim();
      if (!finalText) {
        this.liveTurnRecoveryContext = null;
        throw new Error(TURN_RESULT_INVARIANT_ERROR);
      }
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
    } finally {
      this.pendingTurnCount = Math.max(0, this.pendingTurnCount - 1);
    }
  }

  async handleClientEvent(event: any) {
    if (!event || typeof event !== "object") return;
    if (event.type === "ui" && event.name === "connection_lost") {
      if (this.liveTurn) void this.recoverLiveTurnAfterDisconnect();
      return;
    }
    if (event.type === "ui") {
      const payload: any = event.payload;
      if (!this.terminalRpcTurnPayloadMatchesLiveTurn(payload)) return;
      if (
        payload?.type === "agent_start" ||
        payload?.type === "agent_end" ||
        payload?.type === "worker_exit" ||
        payload?.type === "session_recovering" ||
        payload?.type === "session_recovered" ||
        payload?.type === "queue_update" ||
        payload?.type === "compaction_start" ||
        payload?.type === "compaction_end" ||
        (payload?.type === "rpc_turn_event" &&
          (payload.event === "start" ||
            payload.event === "heartbeat" ||
            payload.event === "complete" ||
            payload.event === "error"))
      ) {
        const frontendState = this.frontendState;
        const eventTarget: RinRpcSessionEventTarget = {
          get isCompacting() {
            return Boolean(frontendState.isCompacting);
          },
          set isCompacting(value: boolean) {
            frontendState.isCompacting = Boolean(value);
          },
          setRemoteTurnRunning: (running: boolean) => {
            this.frontendState.turnActive = running;
            this.frontendState.isStreaming = running;
            this.setFrontendPhase(running ? "working" : "idle");
          },
          handleSessionUnavailable: () => {
            this.frontendState.sessionRecovering = true;
            this.setFrontendPhase("connecting");
            if (this.liveTurn) {
              void this.recoverLiveTurnAfterDisconnect();
            }
          },
          handleSessionRecovered: () => {
            this.frontendState.sessionRecovering = false;
            if (this.liveTurn) this.setFrontendPhase("working");
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
      }
    }
    const backendEvents =
      event.type === "backend_event"
        ? [event.payload as RinFrontendBackendEvent]
        : this.backendEventTranslator.translate(event);
    for (const backendEvent of backendEvents) {
      await this.handleBackendEvent(backendEvent);
    }
  }

  private async handleBackendEvent(event: RinFrontendBackendEvent) {
    switch (event.type) {
      case "status":
        this.setFrontendPhase(
          event.phase === "compacting" ? "working" : event.phase,
        );
        if (typeof event.turnActive === "boolean") {
          this.frontendState.turnActive = event.turnActive;
        }
        if (typeof event.isStreaming === "boolean") {
          this.frontendState.isStreaming = event.isStreaming;
        }
        return;
      case "turn_accepted":
        this.frontendState.turnActive = true;
        this.setFrontendPhase("working");
        this.emit({ type: "turn_accepted" });
        return;
      case "user_message_start":
        this.emit({ type: "user_message_start", text: event.text });
        return;
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
          },
          { deferDuringTurn: event.deferDuringTurn },
        );
        return;
      case "compaction_start_notice":
        this.emit({ type: "compaction_start_notice", text: event.text });
        return;
      case "external_working_start":
        this.externalWorkingDepth += 1;
        this.setFrontendPhase("working");
        return;
      case "external_working_end":
        this.externalWorkingDepth = Math.max(0, this.externalWorkingDepth - 1);
        if (
          this.externalWorkingDepth === 0 &&
          !this.liveTurn &&
          !this.isStreaming()
        ) {
          this.setFrontendPhase("idle");
        }
        return;
      case "working_visible":
        this.frontendState.piWorkingVisible = event.visible;
        this.setFrontendPhase(event.visible ? "working" : "idle");
        return;
      case "assistant_stream":
        this.latestAssistantText = event.text;
        return;
      case "assistant_interim":
        this.emit({ type: "assistant_interim", text: event.text });
        return;
      case "assistant_final":
        this.latestAssistantText = event.text;
        this.assistantFinalReplyCommitted = true;
        return;
      case "turn_complete": {
        if (!this.liveTurn) return;
        const current = safeString(this.liveTurn.requestTag || "").trim();
        const incoming = safeString(event.requestTag || "").trim();
        if (current && incoming && current !== incoming) return;
        this.frontendState.turnActive = false;
        this.frontendState.isStreaming = false;
        this.updateFrontendStateFrom(event);
        const finalText = safeString(event.finalText).trim();
        if (!finalText) {
          this.failLiveTurn(new Error(TURN_RESULT_INVARIANT_ERROR));
          return;
        }
        this.latestAssistantText = finalText;
        this.setFrontendPhase("idle");
        this.liveTurn.resolve({
          finalText,
          result: event.result,
          sessionId: event.sessionId,
          sessionFile: event.sessionFile,
        });
        return;
      }
      case "turn_error": {
        if (!this.liveTurn) return;
        const current = safeString(this.liveTurn.requestTag || "").trim();
        const incoming = safeString(event.requestTag || "").trim();
        if (current && incoming && current !== incoming) return;
        this.frontendState.turnActive = false;
        this.frontendState.isStreaming = false;
        this.updateFrontendStateFrom(event);
        this.setFrontendPhase("idle");
        const error = new Error(event.error) as Error & {
          sessionId?: string;
          sessionFile?: string;
        };
        error.sessionId = event.sessionId;
        error.sessionFile = event.sessionFile;
        this.failLiveTurn(error);
        return;
      }
    }
  }
}
