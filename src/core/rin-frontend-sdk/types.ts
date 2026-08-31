import type {
  RinRpcCommandType,
  RinRpcResponseEnvelope,
} from "../rin-lib/rpc-types.js";
import type { RinTodoItem } from "../rin-lib/todo-state.js";
import type { RinFrontendIdentity } from "../rin-lib/frontend-identity.js";
import type { PromptContextMeta } from "../rin-lib/prompt-context.js";
import type { RinToolStartupOptions } from "../rin-lib/tool-options.js";
import type { ChatMessagePart } from "../rin-lib/chat-outbox-contract.js";

export type RinRpcCommand = {
  id?: string;
  type: RinRpcCommandType | "extension_ui_response";
  [key: string]: unknown;
};

export type RinRpcResponse<T = unknown> = Omit<
  RinRpcResponseEnvelope,
  "data"
> & {
  data?: T;
};

export type RinExtensionUiMethod =
  | "select"
  | "confirm"
  | "input"
  | "editor"
  | "notify"
  | "rinCommandResult"
  | "setMessageCatalog"
  | "setStatus"
  | "setWorkingMessage"
  | "setWorkingVisible"
  | "setWorkingIndicator"
  | "setHiddenThinkingLabel"
  | "setWidget"
  | "setFooter"
  | "setHeader"
  | "setTitle"
  | "setToolsExpanded"
  | "set_editor_text";

export type RinMessageKey =
  | "command.abort.completed"
  | "session.new.completed"
  | "session.new.cancelled"
  | "session.compaction.completed"
  | "extensions.reload.completed"
  | "session.compaction.busy"
  | "session.compaction.started"
  | "session.compaction.summary";

export type RinMessageCatalog = Partial<Record<RinMessageKey, string>>;

export type RinExtensionCommandResult = {
  text?: string;
  fallbackText?: string;
  parts?: ChatMessagePart[];
};

export type RinExtensionUiRequest = {
  type: "extension_ui_request";
  id?: string;
  method: RinExtensionUiMethod | string;
  title?: string;
  message?: string;
  options?: unknown[];
  placeholder?: string;
  prefill?: string;
  notifyType?: string;
  statusKey?: string;
  statusText?: string;
  visible?: boolean;
  label?: string;
  widgetKey?: string;
  widgetLines?: unknown;
  widgetPlacement?: string;
  expanded?: boolean;
  text?: string;
  result?: RinExtensionCommandResult;
  catalog?: RinMessageCatalog;
  [key: string]: unknown;
};

export type RinExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

export type RinFrontendStatusPhase =
  | "idle"
  | "connecting"
  | "starting"
  | "sending"
  | "working"
  | "compacting"
  | "retrying";

export type RinChatDeliveryContext = {
  turnId: string;
  chatKey: string;
  messageId: string;
};

export type RinTerminalRecord = {
  terminalId: string;
  state: "complete" | "error" | "interrupted";
  terminalAt?: string;
};

export type RinFrontendRetryFailure = {
  attempt: number;
  finalError: string;
};

export type RinFrontendBackendEvent =
  | RinExtensionUiRequest
  | {
      type: "status";
      phase: RinFrontendStatusPhase;
      label?: string;
      connected?: boolean;
      turnActive?: boolean;
      isStreaming?: boolean;
    }
  | { type: "turn_accepted"; requestTag?: string }
  | {
      type: "user_message_start";
      text: string;
      requestTag?: string;
    }
  | {
      type: "passive_notice";
      text: string;
      level?: "info" | "warning" | "error";
      deferDuringTurn?: boolean;
      noticeKind?: "compaction_end" | "lifecycle_error" | "todo";
      todoItems?: RinTodoItem[];
      sourceEventId?: string;
      requestTag?: string;
    }
  | { type: "compaction_start_notice"; text: string }
  | { type: "assistant_stream"; text: string; requestTag?: string }
  | { type: "assistant_summary"; text: string; requestTag?: string }
  | { type: "assistant_interim"; text: string; requestTag?: string }
  | {
      type: "assistant_final";
      text: string;
      result?: unknown;
      sessionId?: string;
      sessionFile?: string;
      requestTag?: string;
      chatDeliveryContext?: RinChatDeliveryContext;
      terminalRecord?: RinTerminalRecord;
    }
  | {
      type: "turn_complete";
      finalText?: string;
      result?: unknown;
      sessionId?: string;
      sessionFile?: string;
      requestTag?: string;
      chatDeliveryContext?: RinChatDeliveryContext;
      terminalRecord?: RinTerminalRecord;
    }
  | {
      type: "turn_error";
      error: string;
      retryFailure?: RinFrontendRetryFailure;
      sessionId?: string;
      sessionFile?: string;
      requestTag?: string;
      chatDeliveryContext?: RinChatDeliveryContext;
      terminalRecord?: RinTerminalRecord;
    };

export type RinFrontendEvent =
  | {
      type: "message_delta";
      messageId: string;
      role: "user" | "assistant" | "system" | "tool";
      delta: string;
    }
  | { type: "message_done"; messageId: string; stopReason?: string }
  | { type: "status"; level: "info" | "warning" | "error"; text: string }
  | {
      type: "tool";
      toolCallId: string;
      phase: "start" | "update" | "done";
      toolName: string;
      title?: string;
      body?: string;
      isError?: boolean;
    }
  | { type: "session_changed"; sessionId: string; title?: string }
  | { type: "extension_ui_request"; payload: RinExtensionUiRequest }
  | { type: "extension_error"; payload: unknown }
  | { type: "backend_event"; payload: RinFrontendBackendEvent }
  | { type: "ui"; name: string; payload: unknown };

export type RinFrontendAutocompleteItem = {
  id: string;
  label: string;
  insertText?: string;
  detail?: string;
  kind?: "command" | "file" | "symbol" | "session" | "model" | "other";
};

export type RinFrontendCommandItem = {
  id: string;
  name: string;
  description?: string;
  category?: string;
  source?: string;
  chat: boolean;
  chatConcurrent?: boolean;
};

export type RinFrontendSessionItem = {
  id: string;
  title: string;
  subtitle?: string;
  isActive?: boolean;
};

export type RinFrontendModelItem = {
  id: string;
  label: string;
  provider?: string;
  description?: string;
};

export type RinSessionState = {
  model?: unknown;
  thinkingLevel?: string;
  turnActive?: boolean;
  isStreaming?: boolean;
  working?: boolean;
  isCompacting?: boolean;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  [key: string]: unknown;
};

export type RinNewSessionOptions = {
  managedSessionLeaf?: string;
  parentSession?: string;
  frontendIdentity?: RinFrontendIdentity;
  resourceOptions?: RinToolStartupOptions & Record<string, unknown>;
};

export type RinNewSessionResult = RinSessionState & {
  cancelled?: boolean;
};

export type RinPromptContext = PromptContextMeta;

export type RinInputSubmissionOutcome =
  | {
      outcome: "terminalOwner" | "nonterminal" | "rejected" | "indeterminate";
      requestTag?: string;
      joinedRequestTag?: string;
      sessionFile?: string;
      sessionId?: string;
      turnActive?: boolean;
      isStreaming?: boolean;
      queued?: boolean;
    }
  | {
      outcome: "rejoined";
      originalOutcome: "terminalOwner" | "nonterminal";
      requestTag?: string;
      joinedRequestTag?: string;
      sessionFile?: string;
      sessionId?: string;
      turnActive?: boolean;
      isStreaming?: boolean;
      queued?: boolean;
    };

export type RinPromptOptions = {
  images?: unknown[];
  streamingBehavior?: "steer" | "followUp";
  source?: string;
  frontendIdentity?: RinFrontendIdentity;
  requestTag?: string;
  chatDeliveryContext?: RinChatDeliveryContext;
  promptContext?: RinPromptContext;
  sessionFile?: string;
  sessionId?: string;
};

export interface RinFrontendClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  subscribe(listener: (event: RinFrontendEvent) => void): () => void;
  request<T = unknown>(command: RinRpcCommand): Promise<T>;
  send(command: RinRpcCommand): Promise<RinRpcResponse>;
  submit(text: string): Promise<RinInputSubmissionOutcome | void>;
  prompt(
    text: string,
    options?: RinPromptOptions,
  ): Promise<RinInputSubmissionOutcome | void>;
  abort(): Promise<void>;
  getState(): Promise<RinSessionState>;
  getMessages(): Promise<unknown[]>;
  getCommands(): Promise<RinFrontendCommandItem[]>;
  runCommand(commandLine: string): Promise<unknown>;
  compact(
    customInstructions?: string,
    options?: { sessionFile?: string },
  ): Promise<unknown>;
  getCommandArgumentCompletions(
    commandName: string,
    argumentPrefix: string,
  ): Promise<RinFrontendAutocompleteItem[]>;
  listSessions(): Promise<RinFrontendSessionItem[]>;
  resumeSession(
    sessionId: string,
    options?: { frontendIdentity?: RinFrontendIdentity },
  ): Promise<void>;
  newSession(options?: RinNewSessionOptions): Promise<RinNewSessionResult>;
  ensureSessionReady?(
    restoreSessionFile?: string,
    managedSessionLeaf?: string,
    toolOptions?: RinToolStartupOptions & {
      disabledRinCapabilities?: string[];
    },
  ): Promise<RinSessionState>;
  listModels(): Promise<RinFrontendModelItem[]>;
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
