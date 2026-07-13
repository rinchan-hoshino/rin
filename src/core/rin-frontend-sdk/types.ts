import type {
  RinRpcCommandType,
  RinRpcResponseEnvelope,
} from "../rin-lib/rpc-types.js";
import type { RinTodoItem } from "../rin-lib/todo-state.js";
import type { RinFrontendIdentity } from "./frontend-identity.js";
import type { PromptContextMeta } from "./prompt-context.js";
import type { RinToolStartupOptions } from "../rin-lib/tool-options.js";

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

export type RinFrontendBackendEvent =
  | {
      type: "status";
      phase: RinFrontendStatusPhase;
      label?: string;
      connected?: boolean;
      turnActive?: boolean;
      isStreaming?: boolean;
    }
  | { type: "turn_accepted"; requestTag?: string }
  | { type: "user_message_start"; text: string }
  | {
      type: "passive_notice";
      text: string;
      level?: "info" | "warning" | "error";
      deferDuringTurn?: boolean;
      noticeKind?: "compaction_end" | "todo";
      todoItems?: RinTodoItem[];
      todoError?: string;
    }
  | { type: "compaction_start_notice"; text: string }
  | { type: "external_working_start" }
  | { type: "external_working_end" }
  | { type: "working_visible"; visible: boolean }
  | { type: "assistant_stream"; text: string }
  | { type: "assistant_summary"; text: string }
  | { type: "assistant_interim"; text: string }
  | {
      type: "assistant_final";
      text: string;
      result?: unknown;
      sessionId?: string;
      sessionFile?: string;
      requestTag?: string;
    }
  | {
      type: "turn_complete";
      finalText?: string;
      result?: unknown;
      sessionId?: string;
      sessionFile?: string;
      requestTag?: string;
    }
  | {
      type: "turn_error";
      error: string;
      sessionId?: string;
      sessionFile?: string;
      requestTag?: string;
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

export type RinPromptAdmission = {
  acceptedAs?: "prompt" | "steer" | "followUp" | "rejoin";
  requestTag?: string;
  sessionFile?: string;
  sessionId?: string;
  turnActive?: boolean;
  isStreaming?: boolean;
};

export type RinPromptOptions = {
  images?: unknown[];
  streamingBehavior?: "steer" | "followUp";
  source?: string;
  frontendIdentity?: RinFrontendIdentity;
  requestTag?: string;
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
  submit(text: string): Promise<RinPromptAdmission | void>;
  prompt(
    text: string,
    options?: RinPromptOptions,
  ): Promise<RinPromptAdmission | void>;
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
