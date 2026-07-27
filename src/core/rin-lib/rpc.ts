import { PI_BUILTIN_SLASH_COMMANDS } from "../pi/private-api.js";

export type BuiltinSlashCommandOrigin = "pi" | "rin";
export type BuiltinSlashCommandGenericPromptRoute = "run_command";

export type BuiltinSlashCommand = {
  name: string;
  description: string;
  origin?: BuiltinSlashCommandOrigin;
  genericPromptRoute?: BuiltinSlashCommandGenericPromptRoute;
};

export const RIN_BUILTIN_SLASH_COMMANDS = [
  { name: "abort", description: "Abort the current operation", origin: "rin" },
  {
    name: "usage",
    description: "Show compact quota and usage status",
    origin: "rin",
    genericPromptRoute: "run_command",
  },
] satisfies BuiltinSlashCommand[];

function rinizePiCommandDescription(description: string) {
  return description.replace(/\bPi\b/g, "Rin").replace(/\bpi\b/g, "rin");
}

function composeBuiltinSlashCommands(
  piCommands: ReadonlyArray<{ name: string; description: string }>,
  rinCommands: ReadonlyArray<BuiltinSlashCommand>,
) {
  const commands: BuiltinSlashCommand[] = [];
  const indexes = new Map<string, number>();
  for (const command of [
    ...piCommands.map((item) => ({
      ...item,
      description: rinizePiCommandDescription(String(item.description || "")),
      origin: "pi" as const,
    })),
    ...rinCommands,
  ]) {
    const name = String(command.name || "").trim();
    if (!name) continue;
    const normalized = { ...command, name };
    const existingIndex = indexes.get(name);
    if (existingIndex === undefined) {
      indexes.set(name, commands.length);
      commands.push(normalized);
    } else {
      commands[existingIndex] = normalized;
    }
  }
  return commands;
}

export const BUILTIN_SLASH_COMMANDS = composeBuiltinSlashCommands(
  PI_BUILTIN_SLASH_COMMANDS,
  RIN_BUILTIN_SLASH_COMMANDS,
);

export function isGenericPromptRunCommandBuiltinSlashCommand(name: unknown) {
  const commandName = String(name || "").trim();
  return BUILTIN_SLASH_COMMANDS.some(
    (command) =>
      command.name === commandName &&
      command.genericPromptRoute === "run_command",
  );
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
  "abort_compaction",
  "bash",
  "abort_bash",
  "get_session_stats",
  "get_session_snapshot",
  "get_entries",
  "get_tree",
  "set_entry_label",
  "navigate_tree",
  "export_html",
  "export_jsonl",
  "import_jsonl",
  "get_fork_messages",
  "get_last_assistant_text",
  "get_messages",
  "resolve_submitted_turn",
  "replay_pending_terminal_turn_event",
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
