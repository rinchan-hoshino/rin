import { PI_BUILTIN_SLASH_COMMANDS } from "../pi/private-api.js";

export { fail, ok, response } from "./rpc-response.js";

export type BuiltinSlashCommandOrigin = "pi" | "rin";
export type BuiltinSlashCommandGenericPromptRoute = "run_command";

export type BuiltinSlashCommand = {
  name: string;
  description: string;
  origin?: BuiltinSlashCommandOrigin;
  genericPromptRoute?: BuiltinSlashCommandGenericPromptRoute;
  chat?: boolean;
};

const PI_CHAT_BUILTIN_COMMAND_NAMES = new Set([
  "changelog",
  "compact",
  "model",
  "new",
  "reload",
  "session",
]);

export const RIN_BUILTIN_SLASH_COMMANDS = [
  {
    name: "help",
    description: "Show available commands",
    origin: "rin",
    chat: true,
  },
  {
    name: "abort",
    description: "Abort the current operation",
    origin: "rin",
    chat: true,
  },
  {
    name: "status",
    description: "Show this chat session status",
    origin: "rin",
    chat: true,
  },
  {
    name: "done",
    description: "Complete this chat and exit its worker",
    origin: "rin",
    chat: true,
  },
] satisfies BuiltinSlashCommand[];

function rinizePiCommandDescription(description: string) {
  return description.replace(/\bPi\b/g, "Rin").replace(/\bpi\b/g, "rin");
}

export function composeBuiltinSlashCommands(
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
      chat: PI_CHAT_BUILTIN_COMMAND_NAMES.has(item.name),
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
      command.chat !== false &&
      command.genericPromptRoute === "run_command",
  );
}

const SESSION_SCOPED_COMMAND_NAMES = [
  "prompt",
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
  working: false,
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

export function isSessionScopedCommand(type: string) {
  return SESSION_SCOPED_COMMANDS.has(normalizeCommandType(type));
}

export function emptySessionState() {
  return { ...EMPTY_SESSION_STATE };
}
