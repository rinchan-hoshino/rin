import type {
  RinExtensionUiRequest,
  RinExtensionUiResponse,
  RinFrontendAutocompleteItem,
  RinFrontendBackendEvent,
  RinFrontendClient,
  RinFrontendCommandItem,
  RinFrontendEvent,
  RinFrontendModelItem,
  RinFrontendSessionItem,
  RinNewSessionOptions,
  RinNewSessionResult,
  RinRpcCommand,
  RinRpcResponse,
} from "../rin-frontend-sdk/index.js";

export interface FrontendMessageDeltaEvent {
  type: "message_delta";
  messageId: string;
  role: "user" | "assistant" | "system" | "tool";
  delta: string;
}

export interface FrontendMessageDoneEvent {
  type: "message_done";
  messageId: string;
  stopReason?: string;
}

export interface FrontendStatusEvent {
  type: "status";
  level: "info" | "warning" | "error";
  text: string;
}

export interface FrontendToolEvent {
  type: "tool";
  toolCallId: string;
  phase: "start" | "update" | "done";
  toolName: string;
  title?: string;
  body?: string;
  isError?: boolean;
}

export interface FrontendSessionChangedEvent {
  type: "session_changed";
  sessionId: string;
  title?: string;
}

export interface FrontendUiEvent {
  type: "ui";
  name: string;
  payload: unknown;
}

export interface FrontendExtensionUiRequestEvent {
  type: "extension_ui_request";
  payload: RinExtensionUiRequest;
}

export interface FrontendExtensionErrorEvent {
  type: "extension_error";
  payload: unknown;
}

export type InteractiveFrontendEvent =
  | FrontendMessageDeltaEvent
  | FrontendMessageDoneEvent
  | FrontendStatusEvent
  | FrontendToolEvent
  | FrontendSessionChangedEvent
  | FrontendExtensionUiRequestEvent
  | FrontendExtensionErrorEvent
  | FrontendUiEvent;

export type FrontendAutocompleteItem = RinFrontendAutocompleteItem;
export type FrontendCommandItem = RinFrontendCommandItem;
export type FrontendSessionItem = RinFrontendSessionItem;
export type FrontendModelItem = RinFrontendModelItem;

export interface FrontendDialogSpec {
  id: string;
  title: string;
  kind: "select" | "confirm" | "input" | "custom";
  payload: unknown;
}

export interface InteractiveFrontendSurface {
  submit(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: (event: InteractiveFrontendEvent) => void): () => void;
  getAutocompleteItems(input: string): Promise<FrontendAutocompleteItem[]>;
  getCommands(): Promise<FrontendCommandItem[]>;
  listSessions(): Promise<FrontendSessionItem[]>;
  resumeSession(sessionId: string): Promise<void>;
  listModels?(): Promise<FrontendModelItem[]>;
  openDialog?(id: string): Promise<FrontendDialogSpec | null>;
  respondDialog?(id: string, payload: unknown): Promise<void>;
}

export interface RpcFrontendClient extends InteractiveFrontendSurface {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  request<T = unknown>(command: RinRpcCommand): Promise<T>;
  send(command: RinRpcCommand): Promise<RinRpcResponse>;
  prompt(text: string, options?: Record<string, unknown>): Promise<void>;
  getState(): Promise<Record<string, unknown>>;
  runCommand(commandLine: string): Promise<unknown>;
  newSession(options?: RinNewSessionOptions): Promise<RinNewSessionResult>;
  setModel(
    provider: string,
    modelId: string,
    options?: { persistSettings?: boolean },
  ): Promise<unknown>;
  setThinkingLevel(
    level: string,
    options?: { persistSettings?: boolean },
  ): Promise<unknown>;
  resetModelOptionsFromSettings(): Promise<unknown>;
  respondExtensionUi(response: RinExtensionUiResponse): Promise<void>;
}

export type { RinFrontendBackendEvent, RinFrontendClient, RinFrontendEvent };
