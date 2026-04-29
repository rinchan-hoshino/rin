export type RinRpcCommandType =
  | "prompt"
  | "resume_interrupted_turn"
  | "steer"
  | "follow_up"
  | "abort"
  | "get_state"
  | "get_messages"
  | "get_session_snapshot"
  | "get_commands"
  | "get_all_models"
  | "get_available_models"
  | "get_oauth_state"
  | "get_resource_diagnostics"
  | "list_sessions"
  | "attach_session"
  | "select_session"
  | "detach_session"
  | "rename_session"
  | "daemon_status"
  | "daemon_activity"
  | "chat_bridge_eval"
  | "cron_list_tasks"
  | "cron_get_task"
  | "cron_upsert_task"
  | "cron_delete_task"
  | "cron_complete_task"
  | "cron_pause_task"
  | "cron_resume_task"
  | "new_session"
  | "switch_session"
  | "run_command"
  | "set_model"
  | "set_session_name"
  | "terminate_session";

export type RinRpcResponseEnvelope = {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
};
