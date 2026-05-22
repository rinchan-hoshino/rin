import {
  missingSessionFileError,
  normalizeSessionRef,
  sessionFileExists,
} from "../session/ref.js";
import {
  applyFrontendBuiltinCommandText,
  frontendCommandNameFromLine,
  isFrontendAbortCommand,
  isFrontendNewSessionCommand,
  parseFrontendCompactCommand,
  resolveRinFrontendCommandResponses,
  type RinFrontendCommandResponses,
} from "./command-responses.js";
import { sleep } from "../platform/process.js";
import { resolveTurnCompletion } from "../session/turn-result.js";
import { safeString } from "../text-utils.js";
import { createRinFrontendBackendEventTranslator } from "./backend-events.js";
import { handleRinRpcSessionEvent } from "./rpc-session-events.js";
import type {
  RinFrontendBackendEvent,
  RinFrontendClient,
  RinFrontendEvent,
  RinNewSessionResult,
  RinPromptContext,
  RinPromptOptions,
  RinSessionState,
} from "./types.js";

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
  sessionId?: string;
  sessionFile?: string;
};

export type RinFrontendPassiveNoticeEvent = {
  type: "passive_notice";
  text: string;
  level?: "info" | "warning" | "error";
};

export type RinFrontendTurnDriverEvent =
  | { type: "frontend_status"; phase: RinFrontendTurnPhase }
  | { type: "turn_accepted" }
  | RinFrontendPassiveNoticeEvent
  | { type: "compaction_start_notice"; text: string }
  | { type: "assistant_interim"; text: string };

export type RinFrontendTurnClient = RinFrontendClient & {
  ensureSessionReady?: (
    restoreSessionFile?: string,
    managedSessionLeaf?: string,
  ) => Promise<Record<string, unknown>>;
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

export function shouldPullSelfImproveNoticesForTurnState(state: {
  liveTurn?: unknown;
  isStreaming?: boolean;
  turnActive?: boolean;
}) {
  return !shouldDeferPassiveNoticeForTurnState(state);
}

export type RinFrontendPromptTurnInput = {
  text: string;
  images?: any[];
  source?: string;
  requestTag?: string;
  streamingBehavior?: "steer" | "followUp";
  promptContext?: RinPromptContext;
  sessionFile?: string;
  sessionId?: string;
};

export async function submitNativeFrontendPromptTurn(
  client: Pick<RinFrontendClient, "prompt">,
  input: RinFrontendPromptTurnInput,
): Promise<void> {
  const promptOptions: RinPromptOptions = {
    images: input.images,
    streamingBehavior: input.streamingBehavior,
    source: input.source,
    requestTag: input.requestTag,
  };
  if (input.promptContext) promptOptions.promptContext = input.promptContext;
  const sessionFile = safeString(input.sessionFile || "").trim();
  if (sessionFile) promptOptions.sessionFile = sessionFile;
  const sessionId = safeString(input.sessionId || "").trim();
  if (sessionId) promptOptions.sessionId = sessionId;
  await client.prompt(input.text, promptOptions);
}

export async function flushPendingSelfImproveNotices(
  client: Pick<RinFrontendClient, "isConnected" | "request">,
  sessionFile?: string,
  options: { sessionFiles?: string[] } = {},
) {
  if (!client.isConnected()) return;
  const sessionFiles = Array.isArray(options.sessionFiles)
    ? options.sessionFiles
        .map((item) => safeString(item).trim())
        .filter(Boolean)
    : undefined;
  await client.request({
    type: "flush_self_improve_notices",
    sessionFile: safeString(sessionFile || "").trim() || undefined,
    ...(sessionFiles ? { sessionFiles } : {}),
  });
}

function isAgentAlreadyProcessingError(error: unknown) {
  return safeString((error as any)?.message || error).includes(
    "Agent is already processing.",
  );
}

function isRecoverableConnectionError(error: unknown) {
  const message = safeString((error as any)?.message || error);
  if (message.includes("rpc_turn_queued_offline")) return false;
  return /rin_tui_not_connected|rin_disconnected|rin_session_recovering|frontend_turn_driver_disposed/.test(
    message,
  );
}

function sameFrontendSessionFile(left: unknown, right: unknown) {
  const leftText = safeString(left).trim();
  const rightText = safeString(right).trim();
  return Boolean(leftText && rightText && leftText === rightText);
}

export class RinFrontendTurnDriver {
  private readonly clientFactory: () => RinFrontendTurnClient;
  private readonly promptSource: string;
  private readonly commandResponses: RinFrontendCommandResponses;
  private readonly selfImproveNoticeSessionFiles?: () => string[] | undefined;
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
    baselineMessages: unknown[];
  } | null = null;

  constructor(options: {
    clientFactory: () => RinFrontendTurnClient;
    promptSource?: string;
    commandResponses?: Partial<RinFrontendCommandResponses>;
    selfImproveNoticeSessionFiles?: () => string[] | undefined;
  }) {
    this.clientFactory = options.clientFactory;
    this.promptSource = safeString(options.promptSource).trim() || "frontend";
    this.commandResponses = resolveRinFrontendCommandResponses(
      options.commandResponses,
    );
    this.selfImproveNoticeSessionFiles = options.selfImproveNoticeSessionFiles;
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

  async connect(options: { restoreSessionFile?: string } = {}) {
    if (!this.client) this.client = this.clientFactory();
    if (!this.client.isConnected()) {
      await this.client.connect();
      this.client.subscribe((event: RinFrontendEvent) => {
        void this.handleClientEvent(event).catch(() => {});
      });
    }

    const wantedSessionFile = safeString(
      options.restoreSessionFile || "",
    ).trim();
    if (wantedSessionFile) {
      await this.selectSessionTarget(wantedSessionFile);
      await this.flushPendingSelfImproveNotices().catch(() => {});
      return;
    }
    await this.refreshFrontendState().catch(() => {});
    await this.flushPendingSelfImproveNotices().catch(() => {});
  }

  dispose() {
    this.failLiveTurn(new Error("frontend_turn_driver_disposed"));
    this.resetAssistantSegmentTracking();
    this.frontendPhase = "idle";
    const client = this.client;
    this.client = null;
    this.frontendState = {};
    if (client?.disconnect) {
      void client.disconnect().catch(() => {});
    }
  }

  async terminateSession() {
    if (!this.client?.isConnected()) return;
    if (typeof this.client.terminateSession === "function") {
      await this.client.terminateSession();
      return;
    }
    await this.client.request({ type: "terminate_session" });
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

  private async getMessagesForSession(sessionFile?: string) {
    if (!this.client) return [];
    const wanted = safeString(sessionFile || "").trim();
    if (!wanted) return await this.client.getMessages();
    const data: any = await this.client.request({
      type: "get_messages",
      sessionFile: wanted,
    });
    return Array.isArray(data?.messages) ? data.messages : [];
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
    this.frontendPhase = phase;
    this.emit({ type: "frontend_status", phase: this.frontendPhase });
  }

  private rejectLiveTurnAsAborted() {
    this.clearAssistantInterimState();
    this.setFrontendPhase("idle");
    this.failLiveTurn(new Error("chat_turn_aborted"));
  }

  private isStreaming() {
    return Boolean(
      this.frontendState.isStreaming || this.frontendState.turnActive,
    );
  }

  private emitPassiveNoticeAtPullCheckpoint(
    event: RinFrontendPassiveNoticeEvent,
  ) {
    if (
      !shouldPullSelfImproveNoticesForTurnState({
        liveTurn: this.liveTurn,
        isStreaming: Boolean(this.frontendState.isStreaming),
        turnActive: Boolean(this.frontendState.turnActive),
      })
    ) {
      return;
    }
    this.emit(event);
  }

  interruptActiveTurnLikeTui() {
    this.rejectLiveTurnAsAborted();
    try {
      void this.client?.abort?.().catch(() => {});
    } catch {}
    return {
      sessionId: this.currentSessionId() || undefined,
      sessionFile: this.currentSessionFile() || undefined,
    };
  }

  private resetAssistantSegmentTracking() {
    this.backendEventTranslator.resetAssistantSegments();
    this.assistantFinalReplyCommitted = false;
  }

  hasActiveTurn() {
    return Boolean(this.liveTurn) || this.isStreaming();
  }

  hasClient() {
    return Boolean(this.client);
  }

  canSteerActiveTurn() {
    if (!this.liveTurn && !this.isStreaming()) return false;
    return !this.assistantFinalReplyCommitted;
  }

  private clearAssistantInterimState() {
    this.backendEventTranslator.resetAssistantSegments();
  }

  private async recoverLiveTurnAfterDisconnect(error?: unknown) {
    if (!this.liveTurn || this.reconnectingTurnPromise) {
      return await this.reconnectingTurnPromise;
    }
    const context = this.liveTurnRecoveryContext;
    this.reconnectingTurnPromise = (async () => {
      this.setFrontendPhase("connecting");
      let deadline = Date.now() + 120_000;
      while (this.liveTurn && Date.now() < deadline) {
        try {
          await this.connect({ restoreSessionFile: context?.sessionFile });
          const state = await this.refreshFrontendState(
            context?.sessionFile,
          ).catch(() => ({}));
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
      if (this.liveTurn) {
        this.failLiveTurn(
          error instanceof Error
            ? error
            : new Error(String(error || "frontend_turn_recovery_failed")),
        );
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

  private async flushPendingSelfImproveNotices(sessionFile?: string) {
    if (!this.client) return;
    if (
      !shouldPullSelfImproveNoticesForTurnState({
        liveTurn: this.liveTurn,
        isStreaming: Boolean(this.frontendState.isStreaming),
        turnActive: Boolean(this.frontendState.turnActive),
      })
    ) {
      return;
    }
    await flushPendingSelfImproveNotices(this.client, sessionFile, {
      sessionFiles: sessionFile
        ? undefined
        : this.selfImproveNoticeSessionFiles?.(),
    });
  }

  private async selectSessionTarget(sessionFile?: string) {
    const wanted = safeString(sessionFile || "").trim();
    if (!wanted) return { changed: false };
    if (!this.client) throw new Error("frontend_session_not_connected");
    const before = this.currentSessionFile();
    await this.client.resumeSession(wanted);
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
  ) {
    if (!this.client) throw new Error("frontend_session_not_connected");
    if (this.client.ensureSessionReady) {
      const ready = await this.client.ensureSessionReady(
        restoreSessionFile,
        managedSessionLeaf,
      );
      this.frontendState = { ...this.frontendState, ...(ready || {}) };
      return ready;
    }

    const wanted = safeString(restoreSessionFile || "").trim();
    const managedLeaf = safeString(managedSessionLeaf || "").trim();
    await this.refreshFrontendState(wanted).catch(() => {});
    if (managedLeaf && !wanted) {
      const value = await this.client.newSession({
        managedSessionLeaf: managedLeaf,
      });
      if (value?.cancelled) throw new Error("rin_new_session_cancelled");
      this.updateFrontendStateFrom(value);
      await this.refreshFrontendState(this.currentSessionFile()).catch(
        () => {},
      );
      await this.flushPendingSelfImproveNotices().catch(() => {});
    } else if (wanted) {
      await this.selectSessionTarget(wanted);
    }
    return {
      sessionId: this.currentSessionId() || undefined,
      sessionFile: this.currentSessionFile() || undefined,
    };
  }

  async runCommand(
    commandLine: string,
    options: {
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
    if (
      isFrontendAbortCommand(commandLine) &&
      (this.liveTurn || this.isStreaming())
    ) {
      return {
        handled: true,
        text: this.commandResponses.abort,
        ...this.interruptActiveTurnLikeTui(),
      };
    }
    await this.connect();
    if (!this.client) throw new Error("frontend_session_not_connected");
    if (isFrontendNewSessionCommand(commandLine)) {
      if (sessionFile && !managedSessionLeaf) {
        throw new Error("new_session_session_file_unsupported");
      }
      const value: RinNewSessionResult = await this.client.newSession(
        managedSessionLeaf ? { managedSessionLeaf } : undefined,
      );
      this.updateFrontendStateFrom(value);
      await this.refreshFrontendState(this.currentSessionFile()).catch(
        () => {},
      );
      if (!value?.cancelled) {
        await this.flushPendingSelfImproveNotices().catch(() => {});
      }
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
    if (sessionFile) {
      if (!sessionFileExists(sessionFile))
        throw missingSessionFileError(sessionFile);
      if (skipSessionRecovery) await this.selectSessionTarget(sessionFile);
    }
    const ready = !skipSessionRecovery
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
    if (isFrontendAbortCommand(commandLine)) this.rejectLiveTurnAsAborted();
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
    if (!finalText) throw new Error("rpc_turn_final_output_missing");
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

  private messageRole(message: unknown) {
    const value =
      message && typeof message === "object" ? (message as any) : {};
    return safeString(value?.message?.role || value?.role).trim();
  }

  private messageText(message: unknown) {
    const value =
      message && typeof message === "object" ? (message as any) : {};
    const content = value?.message?.content ?? value?.content;
    if (typeof content === "string") return safeString(content).trim();
    if (Array.isArray(content)) {
      return content
        .map((part) =>
          typeof part === "string"
            ? part
            : safeString(part?.text || part?.content || part?.attrs?.content),
        )
        .join("")
        .trim();
    }
    return safeString(value?.text).trim();
  }

  private messageTimestampMs(message: unknown) {
    const value =
      message && typeof message === "object" ? (message as any) : {};
    const raw = value?.message?.timestamp ?? value?.timestamp;
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(safeString(raw));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private resolveExistingSubmittedTurnFromMessages(
    messages: unknown[],
    input: { text: string; sentAt?: number },
  ): RinFrontendTurnResult | { submitted: true } | null {
    const sentAt = Number(input.sentAt || 0);
    if (!Number.isFinite(sentAt) || sentAt <= 0) return null;
    const promptText = safeString(input.text).trim();
    if (!promptText) return null;
    let submittedIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (this.messageRole(message) !== "user") continue;
      if (this.messageTimestampMs(message) < sentAt) continue;
      if (this.messageText(message) !== promptText) continue;
      submittedIndex = index;
      break;
    }
    if (submittedIndex < 0) return null;
    const completion = resolveTurnCompletion({
      messages: messages.slice(submittedIndex + 1),
    });
    const finalText = safeString(completion.finalText).trim();
    if (!finalText) return { submitted: true };
    this.latestAssistantText = finalText;
    this.setFrontendPhase("idle");
    return {
      finalText,
      result: completion.result,
      sessionId: this.currentSessionId() || undefined,
      sessionFile: this.currentSessionFile() || undefined,
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
      baselineMessages: [],
    };
    this.setFrontendPhase("working");
    let deadline = Date.now() + 120_000;
    while (this.liveTurn === liveTurn && Date.now() < deadline) {
      const messages = await this.getMessagesForSession(
        targetSessionFile,
      ).catch(() => []);
      if (Array.isArray(messages)) {
        const recovered = this.resolveExistingSubmittedTurnFromMessages(
          messages,
          input,
        );
        if (recovered && !("submitted" in recovered)) {
          liveTurn.resolve(recovered);
          break;
        }
      }
      const state = await this.refreshFrontendState(targetSessionFile).catch(
        () => ({}),
      );
      if (Boolean((state as any)?.turnActive || (state as any)?.isStreaming)) {
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
      const error = new Error("rpc_turn_final_output_missing");
      this.failLiveTurn(error);
      throw error;
    }
    return this.normalizeTurnCompletion(await liveTurn.promise);
  }

  private async followActiveTurn(ready?: RinSessionState) {
    if (!this.client) throw new Error("frontend_session_not_connected");
    const targetSessionFile = this.sessionFileFromReady(ready);
    this.resetAssistantSegmentTracking();
    this.latestAssistantText = "";
    const liveTurn = this.liveTurn || this.startLiveTurn("");
    liveTurn.requestTag = "";
    const baselineMessages = await this.getMessagesForSession(
      targetSessionFile,
    ).catch(() => []);
    this.liveTurnRecoveryContext = {
      sessionFile: targetSessionFile || undefined,
      baselineMessages: Array.isArray(baselineMessages)
        ? [...baselineMessages]
        : [],
    };
    this.setFrontendPhase("working");
    while (this.liveTurn === liveTurn) {
      const state: any = await this.refreshFrontendState(
        targetSessionFile,
      ).catch(() => ({}));
      if (!Boolean(state?.turnActive || state?.isStreaming)) {
        const error = new Error("rpc_turn_final_output_missing");
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

  async submitTurn(input: {
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
  }): Promise<RinFrontendTurnResult> {
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
    await this.applyTurnModelOptions(
      {
        model: input.model,
        thinkingLevel: input.thinkingLevel,
      },
      targetSessionFile,
    );
    const requestTag =
      safeString(input.requestTag).trim() || this.createTurnRequestTag();
    await submitNativeFrontendPromptTurn(this.client, {
      text: input.text,
      images: input.images,
      source: safeString(input.source).trim() ? promptSource : input.source,
      requestTag,
      streamingBehavior: input.streamingBehavior,
      promptContext: input.promptContext,
      sessionFile: targetSessionFile,
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

  async runTurn(input: {
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
    streamingBehavior?: "steer" | "follow";
  }): Promise<RinFrontendTurnResult> {
    const promptSource = safeString(input.source).trim() || this.promptSource;
    const sessionFile = safeString(input.sessionFile || "").trim();
    const restoreSessionFile = safeString(
      input.restoreSessionFile || "",
    ).trim();
    const managedSessionLeaf = safeString(
      input.managedSessionLeaf || "",
    ).trim();
    await this.connect();
    if (!this.client) throw new Error("frontend_session_not_connected");
    if (sessionFile && !sessionFileExists(sessionFile)) {
      throw missingSessionFileError(sessionFile);
    }
    const ready = await this.ensureSessionReady(
      sessionFile || restoreSessionFile,
      managedSessionLeaf,
    );
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
    await this.applyTurnModelOptions(
      {
        model: input.model,
        thinkingLevel: input.thinkingLevel,
      },
      targetSessionFile,
    );
    const text = safeString(input.text).trim();
    const images = Array.isArray(input.images) ? input.images : [];

    if (this.isStreaming()) {
      if (input.streamingBehavior !== "steer") {
        return await this.followActiveTurn(ready);
      }
      this.clearAssistantInterimState();
      const requestTag = this.createTurnRequestTag();
      await submitNativeFrontendPromptTurn(this.client, {
        text,
        images,
        source: promptSource,
        streamingBehavior: "steer",
        requestTag,
        promptContext: input.promptContext,
        sessionFile: targetSessionFile,
      });
      this.throwIfQueuedOffline(requestTag);
      return {
        steered: true,
        sessionId:
          safeString(ready?.sessionId || this.currentSessionId()).trim() ||
          undefined,
        sessionFile:
          safeString(ready?.sessionFile || this.currentSessionFile()).trim() ||
          undefined,
      };
    }

    if (input.streamingBehavior !== "steer") {
      const messages = await this.getMessagesForSession(
        targetSessionFile,
      ).catch(() => []);
      if (Array.isArray(messages)) {
        const existing = this.resolveExistingSubmittedTurnFromMessages(
          messages,
          { text, sentAt: input.promptContext?.sentAt },
        );
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
    }

    this.resetAssistantSegmentTracking();
    this.latestAssistantText = "";
    const baselineMessages = await this.getMessagesForSession(
      targetSessionFile,
    ).catch(() => []);
    const requestTag = this.createTurnRequestTag();
    const liveTurn = this.startLiveTurn(requestTag);
    this.liveTurnRecoveryContext = {
      sessionFile:
        safeString(ready?.sessionFile || this.currentSessionFile()).trim() ||
        undefined,
      baselineMessages: Array.isArray(baselineMessages)
        ? [...baselineMessages]
        : [],
    };
    const promptSubmission = (async () => {
      await submitNativeFrontendPromptTurn(this.client!, {
        text,
        images,
        source: promptSource,
        requestTag,
        promptContext: input.promptContext,
        sessionFile: targetSessionFile,
      });
      this.throwIfQueuedOffline(requestTag);
    })();
    promptSubmission.catch(() => {});

    const firstResult = await Promise.race([
      promptSubmission.then(
        () => ({ type: "prompt_submitted" as const }),
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
        await this.recoverLiveTurnAfterDisconnect(error);
        return await liveTurn.promise;
      }
      if (isAgentAlreadyProcessingError(error)) {
        if (input.streamingBehavior !== "steer") {
          return await this.followActiveTurn(ready);
        }
        if (this.liveTurn === liveTurn) this.liveTurn = null;
        this.liveTurnRecoveryContext = null;
        this.clearAssistantInterimState();
        const steerRequestTag = this.createTurnRequestTag();
        await submitNativeFrontendPromptTurn(this.client, {
          text,
          images,
          source: promptSource,
          streamingBehavior: "steer",
          requestTag: steerRequestTag,
          promptContext: input.promptContext,
          sessionFile: targetSessionFile,
        });
        this.throwIfQueuedOffline(steerRequestTag);
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
        await this.recoverLiveTurnAfterDisconnect(firstResult.error);
        return await liveTurn.promise;
      }
      this.liveTurnRecoveryContext = null;
      throw firstResult.error;
    }

    const completion =
      firstResult.type === "turn_complete"
        ? firstResult.completion
        : await liveTurn.promise;
    const finalText = safeString((completion as any)?.finalText).trim();
    if (!finalText) {
      this.liveTurnRecoveryContext = null;
      throw new Error("rpc_turn_final_output_missing");
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
  }

  async handleClientEvent(event: any) {
    if (!event || typeof event !== "object") return;
    if (event.type === "ui" && event.name === "connection_lost") {
      if (this.liveTurn) void this.recoverLiveTurnAfterDisconnect(event.name);
      return;
    }
    if (event.type === "ui") {
      const payload: any = event.payload;
      if (
        payload?.type === "agent_start" ||
        payload?.type === "agent_end" ||
        payload?.type === "worker_exit" ||
        payload?.type === "session_recovering" ||
        payload?.type === "session_recovered" ||
        payload?.type === "queue_update" ||
        (payload?.type === "rpc_turn_event" &&
          (payload.event === "start" ||
            payload.event === "heartbeat" ||
            payload.event === "complete" ||
            payload.event === "error"))
      ) {
        await handleRinRpcSessionEvent(
          {
            setRemoteTurnRunning: (running: boolean) => {
              this.frontendState.turnActive = running;
              this.frontendState.isStreaming = running;
              this.setFrontendPhase(running ? "working" : "idle");
            },
            emitFrontendStatus: () => {},
            emitEvent: () => {},
          },
          payload,
          {
            refreshMessages: async () => {},
            refreshMessagesAndSession: async () => {
              await this.refreshFrontendState(this.currentSessionFile()).catch(
                () => ({}),
              );
            },
          },
        );
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
        this.emit({ type: "turn_accepted" });
        return;
      case "passive_notice":
        this.emitPassiveNoticeAtPullCheckpoint({
          type: "passive_notice",
          text: event.text,
          level: event.level,
        });
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
        this.frontendState.turnActive = false;
        this.frontendState.isStreaming = false;
        if (!this.liveTurn) return;
        const current = safeString(this.liveTurn.requestTag || "").trim();
        const incoming = safeString(event.requestTag || "").trim();
        if (current && incoming && current !== incoming) return;
        this.updateFrontendStateFrom(event);
        const finalText = safeString(event.finalText).trim();
        if (!finalText) {
          this.failLiveTurn(new Error("rpc_turn_final_output_missing"));
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
        await this.flushPendingSelfImproveNotices(event.sessionFile).catch(
          () => {},
        );
        return;
      }
      case "turn_error": {
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
        await this.flushPendingSelfImproveNotices(event.sessionFile).catch(
          () => {},
        );
        return;
      }
    }
  }
}
