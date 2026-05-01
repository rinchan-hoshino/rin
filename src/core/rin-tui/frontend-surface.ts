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

export type InteractiveFrontendEvent =
  | FrontendMessageDeltaEvent
  | FrontendMessageDoneEvent
  | FrontendStatusEvent
  | FrontendToolEvent
  | FrontendSessionChangedEvent
  | FrontendUiEvent;

export interface FrontendAutocompleteItem {
  id: string;
  label: string;
  insertText?: string;
  detail?: string;
  kind?: "command" | "file" | "symbol" | "session" | "model" | "other";
}

export interface FrontendCommandItem {
  id: string;
  name: string;
  description?: string;
  category?: string;
  source?: string;
}

export interface FrontendSessionItem {
  id: string;
  title: string;
  subtitle?: string;
  isActive?: boolean;
}

export interface FrontendModelItem {
  id: string;
  label: string;
  provider?: string;
  description?: string;
}

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
  send(command: unknown): Promise<any>;
}
