import { normalizeSessionRef } from "../session/ref.js";
import {
  countToolCalls,
  extractMessageText,
  extractTextBeforeFirstToolCall,
} from "../message-content.js";
import type { PromptContextMeta } from "../chat-bridge/prompt-context.js";
import { safeString } from "../text-utils.js";
import type {
  InteractiveFrontendEvent,
  RpcFrontendClient,
} from "./frontend-surface.js";
import { RinDaemonFrontendClient } from "./rpc-client.js";

type FrontendPhase = "idle" | "connecting" | "starting" | "sending" | "working";

type DriverTurnResult = {
  finalText?: string;
  result?: any;
  steered?: boolean;
  sessionId?: string;
  sessionFile?: string;
};

export type ChatFrontendDriverEvent =
  | { type: "frontend_status"; phase: FrontendPhase }
  | { type: "turn_accepted" }
  | { type: "assistant_interim"; text: string };

type ChatFrontendClient = RpcFrontendClient & {
  ensureSessionReady?: (
    restoreSessionFile?: string,
    managedSessionLeaf?: string,
  ) => Promise<Record<string, unknown>>;
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

export class ChatFrontendDriver {
  private readonly clientFactory: () => ChatFrontendClient;
  client: ChatFrontendClient | null = null;
  private frontendState: Record<string, any> = {};
  liveTurn: {
    requestTag?: string;
    promise: Promise<any>;
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  } | null = null;
  latestAssistantText = "";
  deliveredAssistantInterimTexts = new Set<string>();
  assistantFinalReplyCommitted = false;
  frontendPhase: FrontendPhase = "idle";
  listeners = new Set<(event: ChatFrontendDriverEvent) => void>();

  constructor(options: { clientFactory?: () => ChatFrontendClient } = {}) {
    this.clientFactory =
      options.clientFactory || (() => new RinDaemonFrontendClient());
  }

  subscribe(listener: (event: ChatFrontendDriverEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ChatFrontendDriverEvent) {
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
      this.client.subscribe((event: any) => {
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
    this.failLiveTurn(new Error("chat_controller_disposed"));
    this.resetAssistantSegmentTracking();
    this.frontendPhase = "idle";
    const client = this.client;
    this.client = null;
    this.frontendState = {};
    if (client?.disconnect) {
      void client.disconnect().catch(() => {});
    }
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
    if (session.sessionFile)
      this.frontendState.sessionFile = session.sessionFile;
  }

  currentSessionId() {
    return safeString(this.frontendState.sessionId || "").trim();
  }

  currentSessionFile() {
    return safeString(this.frontendState.sessionFile || "").trim();
  }

  private createTurnRequestTag() {
    return `chat_turn_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  private startLiveTurn(requestTag?: string) {
    if (this.liveTurn) throw new Error("chat_turn_already_running");
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

  private setFrontendPhase(phase: FrontendPhase) {
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
    this.deliveredAssistantInterimTexts.clear();
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
    this.deliveredAssistantInterimTexts.clear();
  }

  private emitAssistantInterim(text: string) {
    const trimmed = safeString(text).trim();
    if (!trimmed) return false;
    if (this.deliveredAssistantInterimTexts.has(trimmed)) return false;
    this.deliveredAssistantInterimTexts.add(trimmed);
    this.emit({ type: "assistant_interim", text: trimmed });
    return true;
  }

  private handleAssistantMessageUpdate(message: any) {
    const text = safeString(
      extractMessageText(message?.content, {
        includeThinking: false,
        trim: true,
      }),
    ).trim();
    if (!text) return;
    this.latestAssistantText = text;
  }

  private handleAssistantMessageEnd(message: any) {
    const content = message?.content;
    const hasToolCalls = countToolCalls(content) > 0;
    const fullText = safeString(
      extractMessageText(content, {
        includeThinking: false,
        trim: true,
      }),
    ).trim();
    if (fullText) this.latestAssistantText = fullText;
    if (!hasToolCalls) {
      this.assistantFinalReplyCommitted = true;
      return;
    }
    const interimText = safeString(
      extractTextBeforeFirstToolCall(content, {
        includeThinking: false,
        trim: true,
      }),
    ).trim();
    this.emitAssistantInterim(interimText);
  }

  private throwIfQueuedOffline(requestTag?: string) {
    if (!this.client?.consumeQueuedOfflineOperation?.(requestTag)) return;
    throw new Error("rin_disconnected:rpc_turn_queued_offline");
  }

  private async switchSessionIfNeeded(sessionFile?: string) {
    const wanted = safeString(sessionFile || "").trim();
    if (!wanted) return { changed: false };
    if (!this.client) throw new Error("chat_session_not_connected");
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
    await this.connect();
    return await this.switchSessionIfNeeded(sessionFile);
  }

  private async ensureSessionReady(
    restoreSessionFile = "",
    managedSessionLeaf = "",
  ) {
    if (!this.client) throw new Error("chat_session_not_connected");
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
    if (!this.client) throw new Error("chat_session_not_connected");
    if (isNewSessionCommand(commandLine)) {
      if (sessionFile && !managedSessionLeaf) {
        throw new Error("new_session_session_file_unsupported");
      }
      const value = await this.client.newSession(
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

  private async applyTurnModelOptions(options: {
    model?: string;
    thinkingLevel?: string;
  }) {
    if (!this.client) throw new Error("chat_session_not_connected");
    const modelRef = safeString(options.model || "").trim();
    if (modelRef) {
      const [provider, ...modelIdParts] = modelRef.split("/");
      const modelId = modelIdParts.join("/");
      const models = await this.client.listModels();
      const model = models.find(
        (item: any) => item?.provider === provider && item?.id === modelId,
      );
      if (!model) throw new Error(`chat_model_not_found:${modelRef}`);
      await this.client.setModel(provider, modelId);
    }

    const thinkingLevel = safeString(options.thinkingLevel || "").trim();
    if (thinkingLevel) {
      await this.client.setThinkingLevel(thinkingLevel);
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
    promptContext?: PromptContextMeta;
  }): Promise<DriverTurnResult> {
    const sessionFile = safeString(input.sessionFile || "").trim();
    const restoreSessionFile = safeString(
      input.restoreSessionFile || "",
    ).trim();
    const managedSessionLeaf = safeString(
      input.managedSessionLeaf || "",
    ).trim();
    await this.connect({ restoreSessionFile });
    if (!this.client) throw new Error("chat_session_not_connected");
    if (sessionFile) {
      await this.switchSessionIfNeeded(sessionFile);
    }
    const ready = await this.ensureSessionReady(
      sessionFile || restoreSessionFile,
      managedSessionLeaf,
    );
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
        source: "chat-bridge",
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
    const requestTag = this.createTurnRequestTag();
    const liveTurn = this.startLiveTurn(requestTag);
    const promptSubmission = (async () => {
      await this.client!.prompt(text, {
        images,
        source: "chat-bridge",
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
      if (isAgentAlreadyProcessingError(error)) {
        if (this.liveTurn === liveTurn) this.liveTurn = null;
        this.clearAssistantInterimState();
        const steerRequestTag = this.createTurnRequestTag();
        await this.client.prompt(text, {
          images,
          source: "chat-bridge",
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
          : new Error(String(error || "chat_turn_failed")),
      );
      throw error;
    }
    if (firstResult.type === "turn_error") {
      throw firstResult.error;
    }

    const completion =
      firstResult.type === "turn_complete"
        ? firstResult.completion
        : await liveTurn.promise;
    const finalText = safeString((completion as any)?.finalText).trim();
    if (!finalText) {
      throw new Error("rpc_turn_final_output_missing");
    }
    this.latestAssistantText = finalText;
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
    const payload = event.type === "ui" ? event.payload : event;
    await this.handleSessionEvent(payload);
  }

  private async handleSessionEvent(event: any) {
    if (!event || typeof event !== "object") return;
    if (event.type === "rpc_frontend_status") {
      this.setFrontendPhase(
        (safeString(event.phase).trim() as FrontendPhase) || "idle",
      );
      if (typeof event.turnActive === "boolean") {
        this.frontendState.turnActive = event.turnActive;
      }
      if (typeof event.isStreaming === "boolean") {
        this.frontendState.isStreaming = event.isStreaming;
      }
      return;
    }
    if (event.type === "rpc_turn_event") {
      if (event.event === "start" || event.event === "heartbeat") {
        this.frontendState.turnActive = true;
        this.emit({ type: "turn_accepted" });
        return;
      }
      if (event.event === "complete") {
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
        const session = normalizeSessionRef(event);
        this.updateFrontendStateFrom(event);
        this.setFrontendPhase("idle");
        this.liveTurn.resolve({
          finalText,
          result: event.result,
          sessionId: session.sessionId,
          sessionFile: session.sessionFile,
        });
        return;
      }
      if (event.event === "error") {
        this.frontendState.turnActive = false;
        this.frontendState.isStreaming = false;
        this.setFrontendPhase("idle");
        const session = normalizeSessionRef(event);
        this.updateFrontendStateFrom(event);
        const error = new Error(
          String(event.error || "rpc_turn_failed"),
        ) as Error & {
          sessionId?: string;
          sessionFile?: string;
        };
        error.sessionId = session.sessionId;
        error.sessionFile = session.sessionFile;
        this.failLiveTurn(error);
        return;
      }
    }

    switch (event.type) {
      case "agent_start":
        this.resetAssistantSegmentTracking();
        this.latestAssistantText = "";
        this.frontendState.turnActive = true;
        this.emit({ type: "turn_accepted" });
        break;
      case "message_end":
        if (event?.message?.role === "assistant") {
          this.handleAssistantMessageEnd(event.message);
        }
        break;
      case "message_update":
        if (event?.message?.role === "assistant") {
          this.handleAssistantMessageUpdate(event.message);
        }
        break;
      case "tool_execution_end":
      case "tool_execution_start":
      case "compaction_start":
      case "compaction_end":
        this.emit({ type: "turn_accepted" });
        break;
    }
  }
}
