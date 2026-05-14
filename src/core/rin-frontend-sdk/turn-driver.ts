import {
  missingSessionFileError,
  normalizeSessionRef,
  sessionFileExists,
} from "../session/ref.js";
import { resolveTurnCompletion } from "../session/turn-result.js";
import { safeString } from "../text-utils.js";
import { createRinFrontendBackendEventTranslator } from "./backend-events.js";
import type {
  RinFrontendBackendEvent,
  RinFrontendClient,
  RinFrontendEvent,
  RinNewSessionResult,
  RinPromptContext,
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

export type RinFrontendTurnDriverEvent =
  | { type: "frontend_status"; phase: RinFrontendTurnPhase }
  | { type: "turn_accepted" }
  | { type: "assistant_interim"; text: string };

export type RinFrontendTurnClient = RinFrontendClient & {
  ensureSessionReady?: (
    restoreSessionFile?: string,
    managedSessionLeaf?: string,
  ) => Promise<Record<string, unknown>>;
  terminateSession?: () => Promise<unknown>;
  consumeQueuedOfflineOperation?: (requestTag?: string) => boolean;
};

function isAgentAlreadyProcessingError(error: unknown) {
  return safeString((error as any)?.message || error).includes(
    "Agent is already processing.",
  );
}

function isAbortCommand(commandLine: string) {
  return safeString(commandLine).trim() === "/abort";
}

function isNewSessionCommand(commandLine: string) {
  return safeString(commandLine).trim() === "/new";
}

function isRecoverableConnectionError(error: unknown) {
  return /rin_tui_not_connected|rin_disconnected|rin_session_recovering|frontend_turn_driver_disposed/.test(
    safeString((error as any)?.message || error),
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RinFrontendTurnDriver {
  private readonly clientFactory: () => RinFrontendTurnClient;
  private readonly promptSource: string;
  client: RinFrontendTurnClient | null = null;
  private frontendState: Record<string, any> = {};
  liveTurn: {
    requestTag?: string;
    promise: Promise<any>;
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  } | null = null;
  private readonly backendEventTranslator =
    createRinFrontendBackendEventTranslator();
  latestAssistantText = "";
  assistantFinalReplyCommitted = false;
  frontendPhase: RinFrontendTurnPhase = "idle";
  listeners = new Set<(event: RinFrontendTurnDriverEvent) => void>();
  private reconnectingTurnPromise: Promise<void> | null = null;
  private liveTurnRecoveryContext: {
    sessionFile?: string;
    baselineMessages: unknown[];
  } | null = null;

  constructor(options: {
    clientFactory: () => RinFrontendTurnClient;
    promptSource?: string;
  }) {
    this.clientFactory = options.clientFactory;
    this.promptSource = safeString(options.promptSource).trim() || "frontend";
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
      await this.switchSessionIfNeeded(wantedSessionFile);
      return;
    }
    await this.refreshFrontendState().catch(() => {});
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

  private async refreshFrontendState() {
    if (!this.client) return this.frontendState;
    const state = await this.client.getState();
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

  private messagesAdvanced(baseline: unknown[], current: unknown[]) {
    return Array.isArray(current) && current.length > baseline.length;
  }

  private resolveLiveTurnFromMessages(messages: unknown[]) {
    if (!this.liveTurn) return false;
    const completion = resolveTurnCompletion({ messages: messages as any[] });
    const finalText = safeString(completion.finalText).trim();
    if (!finalText) return false;
    this.latestAssistantText = finalText;
    this.setFrontendPhase("idle");
    this.liveTurn.resolve({
      finalText,
      result: completion.result,
      sessionId: this.currentSessionId() || undefined,
      sessionFile: this.currentSessionFile() || undefined,
    });
    return true;
  }

  private async recoverLiveTurnAfterDisconnect(error?: unknown) {
    if (!this.liveTurn || this.reconnectingTurnPromise) {
      return await this.reconnectingTurnPromise;
    }
    const context = this.liveTurnRecoveryContext;
    this.reconnectingTurnPromise = (async () => {
      this.setFrontendPhase("connecting");
      const deadline = Date.now() + 120_000;
      while (this.liveTurn && Date.now() < deadline) {
        try {
          await this.connect({ restoreSessionFile: context?.sessionFile });
          const state = await this.refreshFrontendState().catch(() => ({}));
          if (
            Boolean((state as any)?.turnActive || (state as any)?.isStreaming)
          ) {
            this.setFrontendPhase("working");
            await Promise.race([this.liveTurn.promise, sleep(1000)]);
            continue;
          }
          const messages = await this.client?.getMessages?.().catch(() => []);
          if (
            Array.isArray(messages) &&
            this.messagesAdvanced(context?.baselineMessages || [], messages) &&
            this.resolveLiveTurnFromMessages(messages)
          ) {
            return;
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

  private async switchSessionIfNeeded(sessionFile?: string) {
    const wanted = safeString(sessionFile || "").trim();
    if (!wanted) return { changed: false };
    if (!this.client) throw new Error("frontend_session_not_connected");
    const before = this.currentSessionFile();
    if (before !== wanted) await this.client.resumeSession(wanted);
    await this.refreshFrontendState().catch(() => {});
    return {
      changed: before !== wanted,
      sessionId: this.currentSessionId() || undefined,
      sessionFile: this.currentSessionFile() || undefined,
    };
  }

  async resumeSessionFile(sessionFile: string) {
    if (!sessionFileExists(sessionFile))
      throw missingSessionFileError(sessionFile);
    await this.connect();
    return await this.switchSessionIfNeeded(sessionFile);
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

    await this.refreshFrontendState().catch(() => {});
    const wanted = safeString(restoreSessionFile || "").trim();
    const managedLeaf = safeString(managedSessionLeaf || "").trim();
    if (managedLeaf && !wanted) {
      const value = await this.client.newSession({
        managedSessionLeaf: managedLeaf,
      });
      if (value?.cancelled) throw new Error("rin_new_session_cancelled");
      this.updateFrontendStateFrom(value);
      await this.refreshFrontendState().catch(() => {});
    } else if (wanted && this.currentSessionFile() !== wanted) {
      await this.switchSessionIfNeeded(wanted);
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
    const skipSessionRecovery = options.skipSessionRecovery === true;
    const restoreSessionFile = safeString(
      options.restoreSessionFile || "",
    ).trim();
    const sessionFile = safeString(options.sessionFile || "").trim();
    const managedSessionLeaf = safeString(
      options.managedSessionLeaf || "",
    ).trim();
    if (isAbortCommand(commandLine) && (this.liveTurn || this.isStreaming())) {
      return {
        handled: true,
        text: "Aborted current operation.",
        ...this.interruptActiveTurnLikeTui(),
      };
    }
    await this.connect({
      restoreSessionFile: skipSessionRecovery ? "" : restoreSessionFile,
    });
    if (!this.client) throw new Error("frontend_session_not_connected");
    if (isNewSessionCommand(commandLine)) {
      if (sessionFile && !managedSessionLeaf) {
        throw new Error("new_session_session_file_unsupported");
      }
      const value: RinNewSessionResult = await this.client.newSession(
        managedSessionLeaf ? { managedSessionLeaf } : undefined,
      );
      this.updateFrontendStateFrom(value);
      await this.refreshFrontendState().catch(() => {});
      return {
        handled: true,
        text: value?.cancelled
          ? "Session switch cancelled."
          : "Started a new session.",
        sessionId: this.currentSessionId() || undefined,
        sessionFile: this.currentSessionFile() || undefined,
      };
    }
    if (sessionFile) {
      if (!sessionFileExists(sessionFile))
        throw missingSessionFileError(sessionFile);
      await this.switchSessionIfNeeded(sessionFile);
    }
    const ready = !skipSessionRecovery
      ? await this.ensureSessionReady(
          sessionFile || restoreSessionFile,
          managedSessionLeaf,
        )
      : undefined;
    const data: any = await this.client.runCommand(commandLine);
    if (isAbortCommand(commandLine)) this.rejectLiveTurnAsAborted();
    return {
      ...data,
      sessionId:
        safeString(
          data?.sessionId || ready?.sessionId || this.currentSessionId(),
        ).trim() || undefined,
      sessionFile:
        safeString(
          data?.sessionFile || ready?.sessionFile || this.currentSessionFile(),
        ).trim() || undefined,
    };
  }

  private async resetModelOptionsFromSettings() {
    if (!this.client) throw new Error("frontend_session_not_connected");
    await this.client.resetModelOptionsFromSettings();
    await this.refreshFrontendState();
  }

  private async applyTurnModelOptions(options: {
    model?: string;
    thinkingLevel?: string;
  }) {
    if (!this.client) throw new Error("frontend_session_not_connected");
    const modelRef = safeString(options.model || "").trim();
    if (modelRef) {
      const [provider, ...modelIdParts] = modelRef.split("/");
      const modelId = modelIdParts.join("/");
      const models = await this.client.listModels();
      const model = models.find(
        (item: any) => item?.provider === provider && item?.id === modelId,
      );
      if (!model) throw new Error(`frontend_model_not_found:${modelRef}`);
      await this.client.setModel(provider, modelId, {
        persistSettings: false,
      });
    }

    const thinkingLevel = safeString(options.thinkingLevel || "").trim();
    if (thinkingLevel) {
      await this.client.setThinkingLevel(thinkingLevel, {
        persistSettings: false,
      });
      this.frontendState.thinkingLevel = thinkingLevel;
    }
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
  }): Promise<RinFrontendTurnResult> {
    const promptSource = safeString(input.source).trim() || this.promptSource;
    const sessionFile = safeString(input.sessionFile || "").trim();
    const restoreSessionFile = safeString(
      input.restoreSessionFile || "",
    ).trim();
    const managedSessionLeaf = safeString(
      input.managedSessionLeaf || "",
    ).trim();
    await this.connect({ restoreSessionFile });
    if (!this.client) throw new Error("frontend_session_not_connected");
    if (sessionFile) {
      if (!sessionFileExists(sessionFile))
        throw missingSessionFileError(sessionFile);
      await this.switchSessionIfNeeded(sessionFile);
    }
    const ready = await this.ensureSessionReady(
      sessionFile || restoreSessionFile,
      managedSessionLeaf,
    );
    if (input.resetModelOptionsFromSettings) {
      await this.resetModelOptionsFromSettings();
    }
    await this.applyTurnModelOptions({
      model: input.model,
      thinkingLevel: input.thinkingLevel,
    });
    const text = safeString(input.text).trim();
    const images = Array.isArray(input.images) ? input.images : [];

    if (this.isStreaming()) {
      this.clearAssistantInterimState();
      const requestTag = this.createTurnRequestTag();
      await this.client.prompt(text, {
        images,
        source: promptSource,
        streamingBehavior: "steer",
        requestTag,
        promptContext: input.promptContext,
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

    this.resetAssistantSegmentTracking();
    this.latestAssistantText = "";
    const baselineMessages = await this.client.getMessages().catch(() => []);
    const requestTag = this.createTurnRequestTag();
    const liveTurn = this.startLiveTurn(requestTag);
    this.liveTurnRecoveryContext = {
      sessionFile:
        safeString(ready?.sessionFile || this.currentSessionFile()).trim() ||
        undefined,
      baselineMessages: Array.isArray(baselineMessages) ? baselineMessages : [],
    };
    const promptSubmission = (async () => {
      await this.client!.prompt(text, {
        images,
        source: promptSource,
        requestTag,
        promptContext: input.promptContext,
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
        if (this.liveTurn === liveTurn) this.liveTurn = null;
        this.liveTurnRecoveryContext = null;
        this.clearAssistantInterimState();
        const steerRequestTag = this.createTurnRequestTag();
        await this.client.prompt(text, {
          images,
          source: promptSource,
          streamingBehavior: "steer",
          requestTag: steerRequestTag,
          promptContext: input.promptContext,
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
        const finalText =
          safeString(event.finalText).trim() ||
          safeString(this.latestAssistantText).trim();
        if (!finalText) {
          this.failLiveTurn(new Error("rpc_turn_final_output_missing"));
          return;
        }
        this.latestAssistantText = finalText;
        this.updateFrontendStateFrom(event);
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
        this.frontendState.turnActive = false;
        this.frontendState.isStreaming = false;
        this.setFrontendPhase("idle");
        this.updateFrontendStateFrom(event);
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
