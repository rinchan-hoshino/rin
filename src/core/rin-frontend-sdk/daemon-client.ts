import net from "node:net";

import { asArray } from "../json-utils.js";
import type {
  RpcSocketConnector,
  RpcSocketLike,
} from "../platform/rpc-socket.js";
import { defaultDaemonSocketPath, parseJsonl } from "../rin-lib/common.js";
import { BUILTIN_SLASH_COMMANDS } from "../rin-lib/rpc.js";
import { describeBoundSessions } from "../session/listing.js";
import {
  normalizeFrontendIdentity,
  type RinFrontendIdentity,
} from "../rin-lib/frontend-identity.js";
import type {
  RinExtensionUiRequest,
  RinExtensionUiResponse,
  RinInputSubmissionOutcome,
  RinRpcCommand,
  RinRpcResponse,
} from "./types.js";
import type {
  FrontendAutocompleteItem,
  FrontendCommandItem,
  FrontendDialogSpec,
  FrontendModelItem,
  FrontendSessionItem,
  InteractiveFrontendEvent,
  RpcFrontendClient,
} from "./frontend-surface.js";

const DEFAULT_RPC_TIMEOUT_MS = 120_000;
const LONG_RUNNING_RPC_TIMEOUT_MS = 5 * 60 * 1000;

function rpcTimeoutMs(command: RinRpcCommand) {
  const type = String(command?.type || "").trim();
  if (type === "compact") return LONG_RUNNING_RPC_TIMEOUT_MS;
  if (
    type === "run_command" &&
    String((command as any)?.commandLine || "")
      .trim()
      .match(/^\/compact(?:\s|$)/)
  ) {
    return LONG_RUNNING_RPC_TIMEOUT_MS;
  }
  return DEFAULT_RPC_TIMEOUT_MS;
}

function toFrontendEvent(event: any): InteractiveFrontendEvent | null {
  if (!event || typeof event !== "object") return null;

  if (event.type === "stderr") {
    return { type: "status", level: "warning", text: String(event.line || "") };
  }

  if (event.type === "worker_exit") {
    return { type: "ui", name: "worker_exit", payload: event };
  }

  if (event.type === "extension_ui_request") {
    return {
      type: "extension_ui_request",
      payload: event as RinExtensionUiRequest,
    };
  }

  if (event.type === "extension_error") {
    return { type: "extension_error", payload: event };
  }

  if (event.type === "response") {
    return { type: "ui", name: "response", payload: event };
  }

  return { type: "ui", name: String(event.type || "event"), payload: event };
}

export type RinDaemonFrontendClientTransportOptions = {
  socketPath?: string;
  connectSocket?: RpcSocketConnector;
  connectTimeoutMs?: number;
  frontendIdentity?: RinFrontendIdentity;
};

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

function normalizeConnectTimeoutMs(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_CONNECT_TIMEOUT_MS;
  }
  return Math.max(1, Math.floor(numeric));
}

function parseCommandArgumentCompletionRequest(input: string) {
  const value = String(input || "");
  if (!value.startsWith("/")) return null;
  const match = value.match(/^\/([^\s]+)\s+(.*)$/s);
  if (!match) return null;
  return {
    commandName: match[1],
    argumentPrefix: match[2] ?? "",
  };
}

export class RinDaemonFrontendClient implements RpcFrontendClient {
  socketPath: string;
  socket: RpcSocketLike | null = null;
  private readonly connectSocket?: RpcSocketConnector;
  private readonly connectTimeoutMs: number;
  private readonly frontendIdentity?: RinFrontendIdentity;
  state = { buffer: "" };
  requestId = 0;
  pending = new Map<
    string,
    {
      commandType: string;
      resolve: (response: RinRpcResponse) => void;
      reject: (error: Error) => void;
      timer?: NodeJS.Timeout;
    }
  >();
  listeners = new Set<(event: InteractiveFrontendEvent) => void>();
  connectPromise: Promise<void> | null = null;
  private compactPromise: Promise<unknown> | null = null;

  constructor(
    transport:
      | string
      | RinDaemonFrontendClientTransportOptions = defaultDaemonSocketPath(),
  ) {
    if (typeof transport === "string") {
      this.socketPath = transport;
      this.connectSocket = undefined;
      this.connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS;
      this.frontendIdentity = undefined;
      return;
    }
    this.socketPath = transport.socketPath || defaultDaemonSocketPath();
    this.connectSocket = transport.connectSocket;
    this.frontendIdentity = normalizeFrontendIdentity(
      transport.frontendIdentity,
    );
    this.connectTimeoutMs = normalizeConnectTimeoutMs(
      transport.connectTimeoutMs,
    );
  }

  async connect() {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connectPromise) return await this.connectPromise;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      let socket: RpcSocketLike | null = null;
      let settled = false;
      const timerRef: { current?: NodeJS.Timeout } = {};
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timerRef.current) clearTimeout(timerRef.current);
        if (error) {
          try {
            socket?.destroy(error);
          } catch {}
          this.connectPromise = null;
          reject(error);
          return;
        }
        if (!socket) {
          this.connectPromise = null;
          reject(new Error("rin_request_failed:connect"));
          return;
        }
        this.socket = socket;
        this.state.buffer = "";
        socket.on("data", (chunk) => this.handleChunk(String(chunk), socket));
        socket.on("close", () => this.handleDisconnect(true, socket));
        socket.on("error", () => this.handleDisconnect(true, socket));
        this.connectPromise = null;
        resolve();
      };
      timerRef.current = setTimeout(() => {
        finish(new Error("rin_timeout:connect"));
      }, this.connectTimeoutMs);
      const attachSocket = (created: RpcSocketLike) => {
        if (settled) {
          try {
            created.destroy();
          } catch {}
          return;
        }
        socket = created;
        const onError = (error: Error) => finish(error);
        socket.once("error", onError);
        socket.once("connect", () => {
          socket?.removeListener("error", onError);
          finish();
        });
      };
      Promise.resolve(
        this.connectSocket
          ? this.connectSocket()
          : net.createConnection(this.socketPath),
      ).then(attachSocket, (error) => {
        finish(error instanceof Error ? error : new Error(String(error)));
      });
    }).catch((error) => {
      this.connectPromise = null;
      throw error;
    });
    return await this.connectPromise;
  }

  async disconnect() {
    const socket = this.socket;
    this.socket = null;
    this.connectPromise = null;
    if (!socket) return;
    try {
      socket.end();
    } catch {}
    try {
      socket.destroy();
    } catch {}
    this.handleDisconnect(false, socket);
  }

  subscribe(listener: (event: InteractiveFrontendEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async submit(text: string): Promise<RinInputSubmissionOutcome | void> {
    return await this.prompt(text);
  }

  async prompt(
    text: string,
    options: Record<string, unknown> = {},
  ): Promise<RinInputSubmissionOutcome | void> {
    return await this.request<RinInputSubmissionOutcome>({
      type: "prompt",
      message: text,
      ...(this.frontendIdentity
        ? { frontendIdentity: this.frontendIdentity }
        : {}),
      ...options,
    });
  }

  async abort() {
    await this.request({ type: "abort" });
  }

  async replaceQueuedSteer(
    expectedText: string,
    text: string,
  ): Promise<boolean> {
    const result = await this.request<{ replaced?: boolean }>({
      type: "replace_queued_steer",
      expectedText,
      text,
    });
    return result.replaced === true;
  }

  async abortRetry() {
    await this.request({ type: "abort_retry" });
  }

  async abortCompaction() {
    await this.request({ type: "abort_compaction" });
  }

  async getAutocompleteItems(
    input: string,
  ): Promise<FrontendAutocompleteItem[]> {
    const argumentRequest = parseCommandArgumentCompletionRequest(input);
    if (argumentRequest && this.isConnected()) {
      const completions = await this.getCommandArgumentCompletions(
        argumentRequest.commandName,
        argumentRequest.argumentPrefix,
      ).catch(() => []);
      if (completions.length > 0) return completions;
    }
    const commands = await this.getCommands().catch(() => []);
    return commands.map((command) => ({
      id: command.id,
      label: command.name,
      insertText: command.name.startsWith("/")
        ? command.name
        : `/${command.name}`,
      detail: command.description,
      kind: "command" as const,
    }));
  }

  async getCommands(): Promise<FrontendCommandItem[]> {
    if (!this.isConnected()) {
      return BUILTIN_SLASH_COMMANDS.map((command) => ({
        id: command.name,
        name: command.name,
        description: command.description,
        chat: command.chat === true,
      }));
    }
    const data = this.getData(await this.send({ type: "get_commands" }));
    const commands = asArray(data?.commands);
    return commands.map((command: any) => ({
      id: String(command.name || command.id || ""),
      name: String(command.name || ""),
      description:
        typeof command.description === "string"
          ? command.description
          : undefined,
      category:
        typeof command.category === "string" ? command.category : undefined,
      source: typeof command.source === "string" ? command.source : undefined,
      chat: command.chat === true,
      ...(command.chatConcurrent === true ? { chatConcurrent: true } : {}),
    }));
  }

  async getCommandArgumentCompletions(
    commandName: string,
    argumentPrefix: string,
  ): Promise<FrontendAutocompleteItem[]> {
    const data = await this.request<any>({
      type: "get_command_argument_completions",
      commandName,
      argumentPrefix,
    });
    const items = asArray(data?.items);
    return items.map((item: any, index: number) => ({
      id: String(item?.id || item?.value || item?.label || index),
      label: String(item?.label || item?.value || item?.id || ""),
      insertText:
        item?.value === undefined ? undefined : String(item.value || ""),
      detail:
        typeof item?.description === "string" ? item.description : undefined,
      kind: "other" as const,
    }));
  }

  async getState() {
    return await this.request<Record<string, unknown>>({ type: "get_state" });
  }

  async getMessages() {
    const data = await this.request<any>({ type: "get_messages" });
    return asArray(data?.messages);
  }

  async runCommand(commandLine: string) {
    return await this.request({
      type: "run_command",
      commandLine,
      ...(this.frontendIdentity
        ? { frontendIdentity: this.frontendIdentity }
        : {}),
    });
  }

  async compact(
    customInstructions?: string,
    options: { sessionFile?: string } = {},
  ) {
    if (this.compactPromise) {
      return {
        handled: true,
        compactionBusy: true,
        text: "Compaction already in progress.",
      };
    }
    const tracked = (async () => {
      try {
        const sessionFile = String(options.sessionFile || "").trim();
        return await this.request({
          type: "compact",
          customInstructions,
          ...(sessionFile ? { sessionFile } : {}),
        });
      } finally {
        if (this.compactPromise === tracked) this.compactPromise = null;
      }
    })();
    this.compactPromise = tracked;
    return await tracked;
  }

  async shutdownSession() {
    return await this.request({
      type: "shutdown_session",
      ...(this.frontendIdentity
        ? { frontendIdentity: this.frontendIdentity }
        : {}),
    });
  }

  async terminateSession() {
    return await this.request({
      type: "terminate_session",
      ...(this.frontendIdentity
        ? { frontendIdentity: this.frontendIdentity }
        : {}),
    });
  }

  async newSession(options: Record<string, unknown> = {}) {
    const { frontendIdentity: requestedFrontendIdentity, ...rest } = options;
    const frontendIdentity =
      normalizeFrontendIdentity(requestedFrontendIdentity) ||
      this.frontendIdentity;
    return await this.request<Record<string, unknown>>({
      type: "new_session",
      ...(frontendIdentity ? { frontendIdentity } : {}),
      ...rest,
    });
  }

  async setModel(
    provider: string,
    modelId: string,
    options: { persistSettings?: boolean } = {},
  ) {
    return await this.request({
      type: "set_model",
      provider,
      modelId,
      ...(options.persistSettings === false ? { persistSettings: false } : {}),
    });
  }

  async setThinkingLevel(
    level: string,
    options: { persistSettings?: boolean } = {},
  ) {
    return await this.request({
      type: "set_thinking_level",
      level,
      ...(options.persistSettings === false ? { persistSettings: false } : {}),
    });
  }

  async resetModelOptionsFromSettings() {
    return await this.request({ type: "reset_model_options_from_settings" });
  }

  async respondExtensionUi(response: RinExtensionUiResponse) {
    await this.send(response);
  }

  async listSessions(): Promise<FrontendSessionItem[]> {
    if (!this.isConnected()) return [];
    const [sessionsResponse, stateResponse]: any = await Promise.all([
      this.send({ type: "list_sessions", scope: "all" }),
      this.send({ type: "get_state" }).catch(() => ({ success: false })),
    ]);
    const data = this.getData(sessionsResponse);
    const activePath =
      stateResponse && stateResponse.success === true
        ? stateResponse.data?.sessionFile
        : undefined;
    return describeBoundSessions(data?.sessions, activePath).map((session) => ({
      id: String(session.path || session.id || ""),
      title: session.title,
      subtitle: session.subtitle,
      isActive: session.isActive,
    }));
  }

  async resumeSession(
    sessionId: string,
    options: { frontendIdentity?: RinFrontendIdentity } = {},
  ): Promise<void> {
    const frontendIdentity =
      normalizeFrontendIdentity(options.frontendIdentity) ||
      this.frontendIdentity;
    await this.send({
      type: "switch_session",
      sessionPath: sessionId,
      ...(frontendIdentity ? { frontendIdentity } : {}),
    });
  }

  async listModels(): Promise<FrontendModelItem[]> {
    if (!this.isConnected()) return [];
    const data = this.getData(
      await this.send({ type: "get_available_models" }),
    );
    const models = asArray(data?.models);
    return models.map((model: any) => ({
      id: String(model.id || ""),
      label: String(model.label || model.id || ""),
      provider: typeof model.provider === "string" ? model.provider : undefined,
      description:
        typeof model.description === "string" ? model.description : undefined,
    }));
  }

  async openDialog(_id: string): Promise<FrontendDialogSpec | null> {
    return null;
  }

  async respondDialog(_id: string, _payload: unknown): Promise<void> {}

  isConnected() {
    return Boolean(this.socket && !this.socket.destroyed);
  }

  async request<T = unknown>(command: RinRpcCommand): Promise<T> {
    return this.getData(await this.send(command)) as T;
  }

  async send(command: RinRpcCommand): Promise<RinRpcResponse> {
    if (!this.socket || this.socket.destroyed)
      throw new Error("rin_tui_not_connected");
    const commandType = String(command?.type || "command");
    const id =
      commandType === "extension_ui_response" && command?.id
        ? String(command.id)
        : `req_${++this.requestId}`;
    return await new Promise<RinRpcResponse>((resolve, reject) => {
      const timer =
        commandType === "await_turn_terminal" || commandType === "prompt"
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`rin_timeout:${commandType}`));
            }, rpcTimeoutMs(command));
      this.pending.set(id, { commandType, resolve, reject, timer });
      this.socket.write(
        `${JSON.stringify({
          ...command,
          ...(command.frontendIdentity || !this.frontendIdentity
            ? {}
            : { frontendIdentity: this.frontendIdentity }),
          id,
        })}\n`,
      );
    });
  }

  private handleChunk(chunk: string, socket?: RpcSocketLike) {
    if (socket && this.socket !== socket) return;
    parseJsonl(chunk, this.state, (line) => this.handleLine(line));
  }

  private handleLine(line: string) {
    let data: any;
    try {
      data = JSON.parse(line);
    } catch {
      return;
    }

    if (data?.type === "response" && data.id && this.pending.has(data.id)) {
      const pending = this.pending.get(data.id)!;
      this.pending.delete(data.id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve(data);
      return;
    }

    const event = toFrontendEvent(data);
    if (!event) return;
    this.emit(event);
  }

  private handleDisconnect(emitEvent = true, socket?: RpcSocketLike) {
    if (socket && this.socket && this.socket !== socket) return;
    if (!this.socket && !this.connectPromise) return;
    this.socket = null;
    this.connectPromise = null;
    for (const [id, pending] of this.pending.entries()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(
        new Error(`rin_disconnected:${pending.commandType}:${id}`),
      );
    }
    this.pending.clear();
    if (emitEvent) {
      this.emit({
        type: "ui",
        name: "connection_lost",
        payload: { socketPath: this.socketPath },
      });
    }
  }

  private emit(event: InteractiveFrontendEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {}
    }
  }

  private getData(response: any) {
    if (!response || response.success !== true) {
      throw new Error(String(response?.error || "rin_request_failed"));
    }
    return response.data;
  }
}
