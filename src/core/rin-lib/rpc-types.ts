import type { RpcCommand as PiRpcCommand } from "@earendil-works/pi-coding-agent";

type PiRpcCommandType = PiRpcCommand["type"];
type AssertNever<T extends never> = T;

export type RinPiNativeRpcCommandType =
  | "prompt"
  | "abort"
  | "clear_queue"
  | "get_state"
  | "cycle_model"
  | "get_messages"
  | "get_commands"
  | "get_available_models"
  | "set_thinking_level"
  | "cycle_thinking_level"
  | "get_available_thinking_levels"
  | "set_steering_mode"
  | "set_follow_up_mode"
  | "compact"
  | "set_auto_compaction"
  | "set_auto_retry"
  | "abort_retry"
  | "bash"
  | "abort_bash"
  | "get_session_stats"
  | "export_html"
  | "get_fork_messages"
  | "get_last_assistant_text"
  | "set_session_name"
  | "new_session"
  | "switch_session"
  | "fork"
  | "set_model";

type _RinPiNativeCommandsMustRemainPiCommands = AssertNever<
  Exclude<RinPiNativeRpcCommandType, PiRpcCommandType>
>;

export type RinDaemonRpcCommandType =
  | "await_turn_terminal"
  | "ack_turn_terminal"
  | "list_unacknowledged_chat_terminals"
  | "get_session_snapshot"
  | "get_all_models"
  | "get_oauth_state"
  | "get_resource_diagnostics"
  | "get_command_argument_completions"
  | "reset_model_options_from_settings"
  | "abort_compaction"
  | "set_entry_label"
  | "navigate_tree"
  | "export_jsonl"
  | "import_jsonl"
  | "get_active_tools"
  | "get_all_tools"
  | "set_active_tools"
  | "refresh_tools"
  | "append_custom_entry"
  | "send_custom_message"
  | "send_user_message"
  | "list_sessions"
  | "attach_session"
  | "select_session"
  | "detach_session"
  | "rename_session"
  | "daemon_status"
  | "daemon_activity"
  | "chat_send"
  | "chat_run_turn"
  | "chat_submit_incoming"
  | "chat_typing"
  | "chat_react"
  | "chat_terminate_turn"
  | "chat_message_get"
  | "chat_message_list"
  | "chat_bridge_eval"
  | "nerve_emit"
  | "nerve_status"
  | "nerve_abort"
  | "nerve_reload_trigger"
  | "replace_queued_steer"
  | "cron_list_tasks"
  | "cron_reload_tasks"
  | "cron_get_task"
  | "cron_upsert_task"
  | "cron_delete_task"
  | "cron_complete_task"
  | "cron_run_task"
  | "cron_wake_task"
  | "cron_pause_task"
  | "cron_resume_task"
  | "cron_reschedule_once_task"
  | "run_command"
  | "oauth_login_start"
  | "oauth_login_respond"
  | "oauth_login_cancel"
  | "oauth_set_api_key"
  | "oauth_logout"
  | "reload"
  | "shutdown_session"
  | "terminate_session";

type _RinDaemonCommandsMustNotShadowPiCommands = AssertNever<
  Extract<RinDaemonRpcCommandType, PiRpcCommandType>
>;

export type RinRpcCommandType =
  | RinPiNativeRpcCommandType
  | RinDaemonRpcCommandType;

export type RinRpcCommandEnvelope = Readonly<{
  id?: unknown;
  type?: unknown;
  [key: string]: unknown;
}>;

export type RinRpcCommandResult = Readonly<
  | { success?: true; data?: unknown; error?: never }
  | { success: false; error: string; data?: never }
>;

export type RinRpcCommandRouter = (
  command: unknown,
) => Promise<RinRpcCommandResult | undefined> | RinRpcCommandResult | undefined;

export type RinRpcResponseEnvelope = {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
};
