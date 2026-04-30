import { normalizeSessionRef } from "../session/ref.js";
import {
  countToolCalls,
  extractMessageText,
  extractTextBeforeFirstToolCall,
} from "../message-content.js";
import { safeString } from "../text-utils.js";
import type { RpcFrontendClient } from "./frontend-surface.js";
import { RinDaemonFrontendClient } from "./rpc-client.js";
import { RpcInteractiveSession } from "./runtime.js";

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

function isAgentAlreadyProcessingError(error: unknown) {
  return safeString((error as any)?.message || error).includes(
    "Agent is already processing.",
  );
}

function isQueuedOperationArray(
  value: unknown,
): value is Array<{ requestTag?: string }> {
  return Array.isArray(value);
}

function isAbortCommand(commandLine: string) {
  return safeString(commandLine).trim() === "/abort";
}

function isNewSessionCommand(commandLine: string) {
  return safeString(commandLine).trim() === "/new";
}

export class ChatFrontendDriver {
  private readonly clientFactory: () => RpcFrontendClient;
  client: RpcFrontendClient | null = null;
  session: RpcInteractiveSession | any = null;
  liveTurn: {
    requestTag?: string;
    promise: Promise<any>;
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  } | null = null;
  latestAssistantText = "";
  deliveredAssistantInterimTexts = new Set<string>();
  assistantReplyCommitted = false;
  frontendPhase: FrontendPhase = "idle";
  listeners = new Set<(event: ChatFrontendDriverEvent) => void>();

  constructor(options: { clientFactory?: () => RpcFrontendClient } = {}) {
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
    if (this.session) return;
    const client = this.clientFactory();
    const session = new RpcInteractiveSession(client);
    await session.connect();
    this.client = client;
    this.session = session;

    session.subscribe((event: any) => {
      void this.handleSessionEvent(event).catch(() => {});
    });

    const wantedSessionFile = safeString(
      options.restoreSessionFile || "",
    ).trim();
    if (wantedSessionFile) {
      await session.switchSession(wantedSessionFile);
    }
  }

  dispose() {
    this.failLiveTurn(new Error("chat_controller_disposed"));
    this.resetAssistantSegmentTracking();
    this.frontendPhase = "idle";
    const session = this.session;
    this.client = null;
    this.session = null;
    if (session?.disconnect) {
      void session.disconnect().catch(() => {});
    }
  }

  currentSessionId() {
    return safeString(
      this.session?.sessionManager?.getSessionId?.() || "",
    ).trim();
  }

  currentSessionFile() {
    return safeString(
      this.session?.sessionManager?.getSessionFile?.() || "",
    ).trim();
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

  interruptActiveTurnLikeTui() {
    this.rejectLiveTurnAsAborted();
    const session = this.session;
    try {
      if (typeof session?.agent?.abort === "function") {
        session.agent.abort();
      } else if (typeof session?.abort === "function") {
        void Promise.resolve(session.abort()).catch(() => {});
      }
    } catch {}
    return {
      sessionId: this.currentSessionId() || undefined,
      sessionFile: this.currentSessionFile() || undefined,
    };
  }

  private resetAssistantSegmentTracking() {
    this.deliveredAssistantInterimTexts.clear();
    this.assistantReplyCommitted = false;
  }

  canSteerActiveTurn() {
    if (!this.liveTurn && !this.session?.isStreaming) return false;
    return !this.assistantReplyCommitted;
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
    this.assistantReplyCommitted = true;
    if (!hasToolCalls) return;
    const interimText = safeString(
      extractTextBeforeFirstToolCall(content, {
        includeThinking: false,
        trim: true,
      }),
    ).trim();
    this.emitAssistantInterim(interimText);
  }

  private consumeQueuedOfflineOperation(requestTag?: string) {
    const tag = safeString(requestTag || "").trim();
    if (!tag) return false;
    const queued = (this.session as any)?.queuedOfflineOps;
    if (!isQueuedOperationArray(queued)) return false;
    const index = queued.findIndex(
      (item) => safeString(item?.requestTag || "").trim() === tag,
    );
    if (index < 0) return false;
    queued.splice(index, 1);
    if (typeof (this.session as any)?.syncPendingCount === "function") {
      (this.session as any).syncPendingCount();
    }
    if (typeof (this.session as any)?.emitFrontendStatus === "function") {
      (this.session as any).emitFrontendStatus(true);
    }
    return true;
  }

  private throwIfQueuedOffline(requestTag?: string) {
    if (!this.consumeQueuedOfflineOperation(requestTag)) return;
    throw new Error("rin_disconnected:rpc_turn_queued_offline");
  }

  private async switchSessionIfNeeded(sessionFile?: string) {
    const wanted = safeString(sessionFile || "").trim();
    if (!wanted) return { changed: false };
    if (!this.session) throw new Error("chat_session_not_connected");
    const before = this.currentSessionFile();
    if (before !== wanted) await this.session.switchSession(wanted);
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
    if (!this.session) throw new Error("chat_session_not_connected");
    const current = this.currentSessionFile();
    const wanted = safeString(restoreSessionFile || "").trim();
    const managedLeaf = safeString(managedSessionLeaf || "").trim();
    if (
      managedLeaf &&
      !wanted &&
      typeof this.session.newSession === "function"
    ) {
      const completed = await this.session.newSession({
        managedSessionLeaf: managedLeaf,
      });
      if (!completed) throw new Error("rin_new_session_cancelled");
    } else if (!current && wanted) {
      await this.switchSessionIfNeeded(wanted);
    }
    return await this.session.ensureSessionReady();
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
    if (
      isAbortCommand(commandLine) &&
      (this.liveTurn || this.session?.isStreaming)
    ) {
      return {
        handled: true,
        text: "Aborted current operation.",
        ...this.interruptActiveTurnLikeTui(),
      };
    }
    await this.connect({
      restoreSessionFile: skipSessionRecovery ? "" : restoreSessionFile,
    });
    if (!this.session) throw new Error("chat_session_not_connected");
    if (isNewSessionCommand(commandLine)) {
      if (sessionFile && !managedSessionLeaf) {
        throw new Error("new_session_session_file_unsupported");
      }
      const completed = await this.session.newSession(
        managedSessionLeaf ? { managedSessionLeaf } : undefined,
      );
      return {
        handled: true,
        text: completed
          ? "Started a new session."
          : "Session switch cancelled.",
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
    const data: any = await this.session.runCommand(commandLine);
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
    if (!this.session) throw new Error("chat_session_not_connected");
    const modelRef = safeString(options.model || "").trim();
    if (modelRef) {
      const [provider, ...modelIdParts] = modelRef.split("/");
      const modelId = modelIdParts.join("/");
      const models = await this.session.modelRegistry.getAvailable();
      const model = models.find(
        (item: any) => item?.provider === provider && item?.id === modelId,
      );
      if (!model) throw new Error(`chat_model_not_found:${modelRef}`);
      await this.session.setModel(model);
    }

    const thinkingLevel = safeString(options.thinkingLevel || "").trim();
    if (thinkingLevel) {
      this.session.thinkingLevel = thinkingLevel;
      if (this.session.state && typeof this.session.state === "object") {
        this.session.state.thinkingLevel = thinkingLevel;
      }
      await this.session.client?.send?.({
        type: "set_thinking_level",
        level: thinkingLevel,
      });
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
  }): Promise<DriverTurnResult> {
    const sessionFile = safeString(input.sessionFile || "").trim();
    const restoreSessionFile = safeString(
      input.restoreSessionFile || "",
    ).trim();
    const managedSessionLeaf = safeString(
      input.managedSessionLeaf || "",
    ).trim();
    await this.connect({ restoreSessionFile });
    if (!this.session) throw new Error("chat_session_not_connected");
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

    if (this.session.isStreaming) {
      this.clearAssistantInterimState();
      const requestTag = this.createTurnRequestTag();
      await this.session.prompt(text, {
        images,
        source: "chat-bridge",
        streamingBehavior: "steer",
        requestTag,
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
      await this.session.prompt(text, {
        images,
        source: "chat-bridge",
        requestTag,
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
        await this.session.prompt(text, {
          images,
          source: "chat-bridge",
          streamingBehavior: "steer",
          requestTag: steerRequestTag,
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
      return;
    }
    if (event.type === "rpc_turn_event") {
      if (event.event === "start" || event.event === "heartbeat") {
        this.emit({ type: "turn_accepted" });
        return;
      }
      if (event.event === "complete") {
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
        this.setFrontendPhase("idle");
        const session = normalizeSessionRef(event);
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
