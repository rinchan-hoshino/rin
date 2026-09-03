import type { RpcExtensionUiCommandHandlers } from "./rpc-extension-ui-command-handler.js";
import type { RpcTurnCommandHandlers } from "./rpc-turn-command-handler.js";
import type { RpcResourceCommandHandlers } from "./rpc-resource-command-handler.js";
import type { RpcAuthCommandHandlers } from "./rpc-auth-command-handler.js";
import type { RpcSessionCommandHandlers } from "./rpc-session-command-handler.js";
import type {
  RpcCommand,
  RpcCommandRequest,
} from "./rpc-command-handler-context.js";

type RpcCommandHandler = (
  handlers: RpcModeCommandHandlers,
  request: RpcCommandRequest,
) => unknown | Promise<unknown>;
type RpcCommandRegistry = Record<string, RpcCommandHandler>;

export type RpcModeCommandHandlers = {
  extensionUi: RpcExtensionUiCommandHandlers;
  turn: RpcTurnCommandHandlers;
  resource: RpcResourceCommandHandlers;
  auth: RpcAuthCommandHandlers;
  session: RpcSessionCommandHandlers;
};

export const RPC_MODE_COMMAND_REGISTRY: RpcCommandRegistry = {
  extension_ui_response: (handlers, command) =>
    handlers.extensionUi.extension_ui_response(command),
  prompt: (handlers, command) => handlers.turn.prompt(command),
  resume_interrupted_turn: (handlers, command) =>
    handlers.turn.resume_interrupted_turn(command),
  clear_queue: (handlers, command) => handlers.turn.clear_queue(command),
  replace_queued_steer: (handlers, command) =>
    handlers.turn.replace_queued_steer(command),
  abort_interrupted_turn: (handlers, command) =>
    handlers.turn.abort_interrupted_turn(command),
  abort: (handlers, command) => handlers.turn.abort(command),
  shutdown_session: (handlers, command) =>
    handlers.turn.shutdown_session(command),
  sleep_session: (handlers, command) => handlers.turn.sleep_session(command),
  attach_session: (handlers, command) => handlers.turn.attach_session(command),
  get_state: (handlers, command) => handlers.turn.get_state(command),
  send_user_message: (handlers, command) =>
    handlers.turn.send_user_message(command),
  get_resource_diagnostics: (handlers, command) =>
    handlers.resource.get_resource_diagnostics(command),
  get_command_argument_completions: (handlers, command) =>
    handlers.resource.get_command_argument_completions(command),
  get_active_tools: (handlers, command) =>
    handlers.resource.get_active_tools(command),
  get_all_tools: (handlers, command) =>
    handlers.resource.get_all_tools(command),
  set_active_tools: (handlers, command) =>
    handlers.resource.set_active_tools(command),
  refresh_tools: (handlers, command) =>
    handlers.resource.refresh_tools(command),
  get_commands: (handlers, command) => handlers.resource.get_commands(command),
  run_command: (handlers, command) => handlers.resource.run_command(command),
  get_oauth_state: (handlers, command) =>
    handlers.auth.get_oauth_state(command),
  oauth_login_start: (handlers, command) =>
    handlers.auth.oauth_login_start(command),
  oauth_login_respond: (handlers, command) =>
    handlers.auth.oauth_login_respond(command),
  oauth_login_cancel: (handlers, command) =>
    handlers.auth.oauth_login_cancel(command),
  oauth_set_api_key: (handlers, command) =>
    handlers.auth.oauth_set_api_key(command),
  oauth_logout: (handlers, command) => handlers.auth.oauth_logout(command),
  cycle_model: (handlers, command) => handlers.session.cycle_model(command),
  get_all_models: (handlers, command) =>
    handlers.session.get_all_models(command),
  get_available_models: (handlers, command) =>
    handlers.session.get_available_models(command),
  set_thinking_level: (handlers, command) =>
    handlers.session.set_thinking_level(command),
  reset_model_options_from_settings: (handlers, command) =>
    handlers.session.reset_model_options_from_settings(command),
  cycle_thinking_level: (handlers, command) =>
    handlers.session.cycle_thinking_level(command),
  get_available_thinking_levels: (handlers, command) =>
    handlers.session.get_available_thinking_levels(command),
  set_steering_mode: (handlers, command) =>
    handlers.session.set_steering_mode(command),
  set_follow_up_mode: (handlers, command) =>
    handlers.session.set_follow_up_mode(command),
  compact: (handlers, command) => handlers.session.compact(command),
  set_auto_compaction: (handlers, command) =>
    handlers.session.set_auto_compaction(command),
  set_auto_retry: (handlers, command) =>
    handlers.session.set_auto_retry(command),
  abort_retry: (handlers, command) => handlers.session.abort_retry(command),
  abort_compaction: (handlers, command) =>
    handlers.session.abort_compaction(command),
  bash: (handlers, command) => handlers.session.bash(command),
  abort_bash: (handlers, command) => handlers.session.abort_bash(command),
  get_session_stats: (handlers, command) =>
    handlers.session.get_session_stats(command),
  get_session_snapshot: (handlers, command) =>
    handlers.session.get_session_snapshot(command),
  get_entries: (handlers, command) => handlers.session.get_entries(command),
  get_tree: (handlers, command) => handlers.session.get_tree(command),
  set_entry_label: (handlers, command) =>
    handlers.session.set_entry_label(command),
  navigate_tree: (handlers, command) => handlers.session.navigate_tree(command),
  export_html: (handlers, command) => handlers.session.export_html(command),
  export_jsonl: (handlers, command) => handlers.session.export_jsonl(command),
  import_jsonl: (handlers, command) => handlers.session.import_jsonl(command),
  get_fork_messages: (handlers, command) =>
    handlers.session.get_fork_messages(command),
  get_last_assistant_text: (handlers, command) =>
    handlers.session.get_last_assistant_text(command),
  get_messages: (handlers, command) => handlers.session.get_messages(command),
  append_custom_entry: (handlers, command) =>
    handlers.session.append_custom_entry(command),
  send_custom_message: (handlers, command) =>
    handlers.session.send_custom_message(command),
  fork: (handlers, command) => handlers.session.fork(command),
  list_sessions: (handlers, command) => handlers.session.list_sessions(command),
  set_model: (handlers, command) => handlers.session.set_model(command),
  rename_session: (handlers, command) =>
    handlers.session.rename_session(command),
  set_session_name: (handlers, command) =>
    handlers.session.set_session_name(command),
};

export const RPC_MODE_COMMAND_TYPES = Object.freeze(
  Object.keys(RPC_MODE_COMMAND_REGISTRY),
);

export function createRpcCommandDispatcher(handlers: RpcModeCommandHandlers) {
  return async (command: RpcCommand) => {
    const type = String(command?.type || "unknown");
    const handler = RPC_MODE_COMMAND_REGISTRY[type];
    if (!handler) throw new Error(`Unknown command: ${type}`);
    return await handler(handlers, {
      command,
      id: command?.id as string | undefined,
      type,
    });
  };
}
