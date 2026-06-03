export type BuiltinSlashCommand = {
  name: string;
  description: string;
};

export const BUILTIN_SLASH_COMMANDS = [
  { name: "abort", description: "Abort the current operation" },
  { name: "settings", description: "Open settings menu" },
  { name: "model", description: "Select model (opens selector UI)" },
  {
    name: "scoped-models",
    description: "Enable/disable models for Ctrl+P cycling",
  },
  {
    name: "export",
    description: "Export session (HTML default, or specify path: .html/.jsonl)",
  },
  {
    name: "import",
    description: "Import and resume a session from a JSONL file",
  },
  { name: "share", description: "Share session as a secret GitHub gist" },
  { name: "copy", description: "Copy last agent message to clipboard" },
  { name: "name", description: "Set session display name" },
  { name: "session", description: "Show session info and stats" },
  { name: "todos", description: "Show all todos on the current branch" },
  { name: "chat", description: "Configure an official chat bridge adapter" },
  { name: "changelog", description: "Show changelog entries" },
  { name: "hotkeys", description: "Show all keyboard shortcuts" },
  { name: "fork", description: "Create a new fork from a previous message" },
  { name: "tree", description: "Navigate session tree (switch branches)" },
  { name: "login", description: "Login with OAuth provider" },
  { name: "logout", description: "Logout from OAuth provider" },
  { name: "new", description: "Start a new session" },
  { name: "compact", description: "Manually compact the session context" },
  { name: "resume", description: "Resume a different session" },
  {
    name: "reload",
    description: "Reload keybindings, extensions, skills, prompts, and themes",
  },
  { name: "quit", description: "Quit rin" },
] satisfies BuiltinSlashCommand[];

const DAEMON_BUILTIN_SLASH_COMMAND_NAMES = new Set(["todos", "chat"]);

export function isDaemonBuiltinSlashCommand(name: unknown) {
  return DAEMON_BUILTIN_SLASH_COMMAND_NAMES.has(String(name || "").trim());
}

const SESSION_SCOPED_COMMAND_NAMES = [
  "prompt",
  "resume_interrupted_turn",
  "steer",
  "follow_up",
  "clear_queue",
  "abort",
  "get_state",
  "cycle_model",
  "get_all_models",
  "get_available_models",
  "get_oauth_state",
  "get_resource_diagnostics",
  "get_command_argument_completions",
  "set_thinking_level",
  "reset_model_options_from_settings",
  "cycle_thinking_level",
  "set_steering_mode",
  "set_follow_up_mode",
  "compact",
  "set_auto_compaction",
  "set_auto_retry",
  "abort_retry",
  "bash",
  "abort_bash",
  "get_session_stats",
  "get_session_snapshot",
  "set_entry_label",
  "navigate_tree",
  "export_html",
  "export_jsonl",
  "import_jsonl",
  "get_fork_messages",
  "get_last_assistant_text",
  "get_messages",
  "resolve_submitted_turn",
  "get_active_tools",
  "get_all_tools",
  "set_active_tools",
  "refresh_tools",
  "append_custom_entry",
  "send_custom_message",
  "send_user_message",
  "run_command",
  "attach_session",
  "select_session",
  "fork",
  "shutdown_session",
  "terminate_session",
  "set_model",
  "set_session_name",
  "oauth_login_start",
  "oauth_login_respond",
  "oauth_login_cancel",
  "oauth_set_api_key",
  "oauth_logout",
  "reload",
] as const;

const SESSION_SCOPED_COMMANDS = new Set<string>(SESSION_SCOPED_COMMAND_NAMES);

const EMPTY_SESSION_STATE = {
  model: null,
  thinkingLevel: "medium",
  turnActive: false,
  isStreaming: false,
  isCompacting: false,
  steeringMode: "all",
  followUpMode: "one-at-a-time",
  sessionFile: undefined,
  sessionId: "",
  sessionName: undefined,
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
};

function normalizeCommandType(type: unknown) {
  return String(type || "").trim();
}

function normalizeResponseError(payload: unknown) {
  const message = String(
    (payload as any)?.message || (payload as any)?.error || payload || "",
  ).trim();
  return message || "rin_request_failed";
}

function buildResponseEnvelope(
  id: string | undefined,
  command: string,
  success: boolean,
) {
  return { id, type: "response", command, success };
}

export function isSessionScopedCommand(type: string) {
  return SESSION_SCOPED_COMMANDS.has(normalizeCommandType(type));
}

export function response(
  id: string | undefined,
  command: string,
  success: boolean,
  payload?: unknown,
) {
  const base = buildResponseEnvelope(id, command, success);
  if (success) return payload === undefined ? base : { ...base, data: payload };
  return { ...base, error: normalizeResponseError(payload) };
}

export function ok(id: string | undefined, command: string, data?: unknown) {
  return response(id, command, true, data);
}

export function fail(id: string | undefined, command: string, error: unknown) {
  return response(id, command, false, error);
}

export function emptySessionState() {
  return { ...EMPTY_SESSION_STATE };
}
