import os from "node:os";
import * as nodeUtil from "node:util";

import { Errno, strerror } from "kerium";

const INTERNAL_RUNTIME_ERROR_RE =
  /^([a-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+)(?::\s*(.*))?$/;

const UNKNOWN_SYSTEM_ERROR_RE = /\bUnknown system error\s+(-?\d+)\b/i;
const UNKNOWN_SYSTEM_ERROR_SYSCALL_RE =
  /\bUnknown system error\s+-?\d+(?::[^,\n]*)?,\s*([A-Za-z][A-Za-z0-9_]*)\b/i;
const CHAT_RUNTIME_ERROR_PREFIX = "rin error:";
const LEADING_RUNTIME_MARKER_RE =
  /^([a-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+)(?:(:)\s*|\s+)?(.*)$/;

function describeRuntimeOperation(detail: string) {
  switch (detail) {
    case "prompt":
      return "submitting your message";
    case "get_session_snapshot":
      return "reading the current session";
    case "select_session":
      return "switching sessions";
    default:
      return "running the request";
  }
}

function withDetail(message: string, detail: string, suffix = "") {
  return `${message}${detail ? `: ${detail}` : ""}${suffix}`;
}

function modelNotFound(detail: string) {
  return withDetail(
    "Model not found",
    detail,
    ". Choose an available model in /model or settings.",
  );
}

function invalidModel(detail: string) {
  return withDetail(
    "Invalid model",
    detail,
    ". Use provider/model format or choose a model from /model.",
  );
}

const USER_FACING_RUNTIME_ERRORS: Record<string, (detail: string) => string> = {
  chat_accepted_inbound_turn_not_active: () =>
    "Chat recovery could not find the active turn for the accepted message.",
  chat_bridge_at_id_required: () =>
    "Chat bridge send failed because a mention is missing its target id. Fix the mention part.",
  chat_bridge_chat_required: () =>
    "Chat bridge send failed because no target chat was selected. Choose a chat.",
  chat_bridge_entry_missing: () =>
    "Chat bridge setup is incomplete. Configure the chat bridge entry.",
  chat_bridge_send_empty: () =>
    "Chat bridge send failed because the message is empty. Add text or an attachment.",
  chat_command_failed: () => "Rin could not run that chat command.",
  chat_command_text_missing: () =>
    "Rin ran the chat command, but it returned no reply text.",
  chat_controller_key_required: () =>
    "Chat controller setup is missing a controller key. Recreate the chat binding.",
  chat_controller_disposed: () =>
    "Rin restarted the chat controller while handling this message.",
  chat_final_assistant_text_missing: () =>
    "Rin finished the chat turn but did not produce reply text.",
  chat_inbox_chatKey_required: () =>
    "Chat inbox write failed because the chat key is missing. Check the adapter event.",
  chat_inbox_messageId_required: () =>
    "Chat inbox write failed because the message id is missing. Check the adapter event.",
  chat_message_id_required: () =>
    "Chat action failed because the target message is missing. Choose a message.",
  chat_reaction_emoji_required: () =>
    "Chat reaction failed because the emoji is missing. Choose an emoji.",
  chat_key_required: () =>
    "Chat action failed because the target chat is missing. Choose a chat.",
  chat_message_store_chatKey_required: () =>
    "Chat message store write failed because the chat key is missing. Check the adapter event.",
  chat_message_store_messageId_required: () =>
    "Chat message store write failed because the message id is missing. Check the adapter event.",
  chat_outbox_delivery_missing: () =>
    "Chat send failed before the outbox item reached the adapter. Check the outgoing payload.",
  chat_outbox_delivery_pending: () =>
    "Chat reply is still waiting in the outbox.",
  chat_outbox_empty_message: () =>
    "Chat send failed because the outgoing message is empty. Add text or an attachment.",
  chat_outbox_idempotency_collision: () =>
    "Chat outbox found a duplicate delivery key. Check the outgoing payload.",
  chat_outbox_invalid_json: () =>
    "Chat outbox contains invalid JSON. Recreate the outbox item.",
  chat_outbox_invalid_payload: () =>
    "Chat send failed because the outgoing payload is invalid. Add text or message parts.",
  chat_outbox_invalid_part: () =>
    "Chat send failed because one message part is invalid. Fix the rich message part.",
  chat_restored_session_mismatch: () =>
    "Rin detected that the chat turn switched to a different session while recovering.",
  chat_send_at_id_required: () =>
    "Chat send failed because a mention is missing its target id. Fix the mention part.",
  chat_send_message_empty_result: () =>
    "Chat adapter accepted the send request but returned no delivered message. Check the adapter connection.",
  chat_text_required: () =>
    "Chat handling failed because the incoming text is empty. Send a non-empty message.",
  chat_turn_aborted: () => "The chat turn was aborted.",

  agent_practices_fetch_failed: () =>
    "Agent practice document refresh failed because a remote file could not be downloaded.",
  agent_practices_fetch_unavailable: () =>
    "Agent practice document refresh needs a runtime HTTP fetch implementation.",

  cron_chat_unavailable: () =>
    "Scheduled task delivery failed because the target chat is unavailable. Check the task frontend binding.",
  cron_final_assistant_text_missing: () =>
    "Scheduled task finished but produced no final reply. Check the task session.",
  cron_frontend_key_required: () =>
    "Scheduled task frontend binding needs a frontend key. Add the key or remove the binding.",
  cron_invalid_agent_task: () =>
    "Scheduled task configuration is not a valid agent task. Fix the task target.",
  cron_invalid_expression: () =>
    "Scheduled task cron expression is invalid. Fix the schedule.",
  cron_invalid_session_continue_task: () =>
    "Scheduled task configuration is not a valid current-session continuation task. Fix the task target.",
  cron_invalid_shell_task: () =>
    "Scheduled task configuration is not a valid shell task. Fix the task target.",
  cron_next_run_not_found: () =>
    "Scheduled task has no next run time. Check the schedule.",
  cron_prompt_required: () =>
    "Scheduled task needs a prompt before it can run. Add the prompt.",
  cron_session_file_not_found: () =>
    "Scheduled task session file was not found. Recreate or rebind the task session.",
  cron_session_file_required: () =>
    "Scheduled task needs a session file before it can run. Rebind the task session.",
  cron_session_continue_frontend_forbidden: () =>
    "Scheduled task current-session continuations cannot specify a separate frontend target. Remove the task frontend binding.",
  cron_session_continue_requires_session: () =>
    "Scheduled task current-session continuation needs a current-session mode with a session file.",
  cron_session_continue_requires_target: () =>
    "Scheduled task current-session continuation cannot include a prompt or command. Use the current-session continuation target.",
  cron_session_continue_unavailable: () =>
    "Scheduled task current-session continuation is unavailable because the daemon session worker bridge is not ready.",
  cron_target_required: () =>
    "Scheduled task needs a target before it can run. Choose a target.",
  cron_tasks_file_invalid: () =>
    "Scheduled task file contains invalid JSON or task data. Fix ~/.rin/data/scheduler/tasks.json before reloading tasks.",
  cron_trigger_required: () =>
    "Scheduled task needs a trigger before it can run. Add a schedule or one-time trigger.",

  discord_application_commands_unavailable: () =>
    "Discord command sync failed because the application command API is not ready.",
  discord_channel_not_sendable: (detail) =>
    withDetail(
      "Discord send failed because the target channel cannot receive messages",
      detail,
      ". Check the channel and bot permissions.",
    ),
  discord_send_message_empty: () =>
    "Discord send failed because the outgoing message is empty. Add text or an attachment.",
  discord_send_message_empty_result: () =>
    "Discord accepted the send request but returned no delivered message. Check the bot permissions.",
  discord_token_required: () =>
    "Discord adapter needs a bot token before it can start. Add the token.",

  external_chat_adapter_did_not_register_bot: () =>
    "External chat adapter started but did not register a bot. Fix the adapter implementation.",
  external_chat_adapter_missing_createAdapter: () =>
    "External chat adapter is missing its createAdapter entrypoint. Fix the adapter package.",
  external_chat_adapter_return_requires_adapter_and_bot: () =>
    "External chat adapter must return both an adapter and a bot. Fix the adapter implementation.",

  final_assistant_text_missing: () =>
    "Rin finished the turn but did not produce final reply text.",
  frontend_model_not_found: modelNotFound,
  frontend_session_not_connected: () =>
    "Rin is not connected to a session yet. Reconnect or start a new session.",
  frontend_session_restore_mismatch: () =>
    "Rin could not restore the requested chat session before running the turn.",
  frontend_compaction_timeout: () =>
    "Rin waited for context compaction to finish, but it took too long.",
  frontend_turn_already_running: () =>
    "A turn is already running in this session. Wait for it to finish or abort it.",

  identity_first_owner_must_self_claim: () =>
    "The first owner identity must be claimed by the same platform user. Use the owner account.",
  identity_last_owner_required: () =>
    "Rin must keep at least one owner identity. Add another owner before removing this one.",
  identity_owner_bootstrap_required: () =>
    "Only an owner can bootstrap trusted chat identities. Use the owner account.",
  identity_owner_required: () =>
    "Only an owner can change this chat identity setting. Use the owner account.",
  identity_platform_required: () =>
    "Identity update needs a platform name. Provide the platform.",
  identity_user_id_required: () =>
    "Identity update needs a user id. Provide the user id.",

  invalid_chatKey: (detail) =>
    withDetail(
      "Invalid chat key",
      detail,
      ". Use a configured platform chat key.",
    ),
  invalid_json: () => "Invalid JSON. Fix the JSON.",
  invalid_practices_manifest: () =>
    "Agent practice document refresh received an invalid manifest.",
  invalid_practices_manifest_path: () =>
    "Agent practice document refresh received an unsafe manifest path.",
  invalid_model: invalidModel,
  invalid_model_ref: invalidModel,

  lark_app_id_required: () =>
    "Lark adapter needs an app id before it can start. Add the app id.",
  lark_app_secret_required: () =>
    "Lark adapter needs an app secret before it can start. Add the app secret.",
  lark_reaction_emoji_required: () =>
    "Lark reaction failed because the emoji is missing. Choose an emoji.",
  lark_send_message_empty: () =>
    "Lark send failed because the outgoing message is empty. Add text or an attachment.",

  maintenance_job_failed: () =>
    "Maintenance job failed. Check the maintenance log.",
  maintenance_job_invalid_input: () =>
    "Maintenance job input is invalid. Recreate the job.",
  maintenance_job_invalid_payload: () =>
    "Maintenance job payload is invalid. Recreate the job.",
  managed_new_session_unsupported: () =>
    "This managed session cannot create a new session through that path. Use /new or the session menu instead.",

  minecraft_not_connected: () =>
    "Minecraft chat adapter is not connected. Check the adapter connection.",
  minecraft_send_message_empty: () =>
    "Minecraft chat send failed because the outgoing message is empty. Add text.",
  minecraft_url_required: () =>
    "Minecraft chat adapter needs a server URL before it can start. Add the URL.",
  invalid_self_improve_interval: () =>
    "Self-improve live view needs a positive refresh interval.",
  invalid_status_interval: () =>
    "Status live view needs a positive refresh interval.",
  invalid_status_limit: () =>
    "Status backend needs a non-negative session limit.",
  invalid_status_offset: () =>
    "Status backend needs a non-negative session offset.",
  missing_self_improve_interval: () =>
    "Self-improve live view needs an interval value. Provide a valid interval.",
  missing_status_interval: () =>
    "Status live view needs an interval value. Provide a valid interval.",
  missing_status_limit: () => "Status backend needs a session limit value.",
  missing_status_offset: () => "Status backend needs a session offset value.",

  new_session_session_file_unsupported: () =>
    "Could not start a new chat session because the command was bound to a replied message's old session.",

  oauth_login_failed: () => "OAuth login failed.",
  oauth_provider_id_required: () =>
    "OAuth login needs a provider id. Choose a provider.",

  onebot_disconnected: () =>
    "OneBot adapter disconnected. Check NapCat/OneBot.",
  onebot_endpoint_required: () =>
    "OneBot adapter needs an endpoint before it can start. Add the endpoint.",
  onebot_not_connected: () =>
    "OneBot adapter is not connected. Check NapCat/OneBot.",
  onebot_reaction_emoji_unsupported: () =>
    "OneBot reaction failed because this emoji is not supported. Choose a supported emoji.",
  onebot_reaction_requires_group_chat: () =>
    "OneBot reactions are only available in group chats. Use a group chat or skip the reaction.",
  onebot_send_message_empty: () =>
    "OneBot send failed because the outgoing message is empty. Add text or an attachment.",
  onebot_send_message_empty_result: () =>
    "OneBot accepted the send request but returned no delivered message. Check NapCat/OneBot.",

  background_extension_entrypoint_missing: () =>
    "Background extension is missing a Rin extension entry point. Export a Rin extension factory or background service.",

  rin_agent_sdk_task_id_required: () =>
    "Agent SDK task operation needs a task id. Provide the task id.",
  rin_app_cli_failed: () => "Rin command failed before it could finish.",
  rin_app_daemon_failed: () =>
    "Rin daemon failed before it could finish starting.",
  rin_app_daemon_services_failed: () =>
    "Rin daemon could not start its background services.",
  rin_app_install_failed: () =>
    "Rin installer failed before it could finish. Check the install settings.",
  rin_app_tui_failed: () => "Rin TUI failed before it could start.",
  rin_app_worker_failed: () => "Rin worker failed before it could start.",
  rin_beta_selector_not_supported: () =>
    "This command does not support selecting the beta channel here. Remove the beta selector.",
  rin_command_failed: (detail) =>
    withDetail("Rin command failed", detail, ". Check the command output."),
  rin_installer_fd_install_dir_missing: () =>
    "Rin installer needs the default local config directory before preparing managed search tools.",
  rin_installer_fd_manager_unavailable: () =>
    "Rin installer could not prepare managed search tools.",
  rin_container_name_required: () =>
    "Target operation needs a container name. Provide the container name.",
  rin_daemon_failed: () => "Rin's background service failed to start.",
  rin_daemon_shutting_down: () =>
    "Rin is shutting down right now. Wait until it starts again.",
  rin_daemon_unavailable: (detail) =>
    withDetail("Rin's background service is not available", detail, "."),
  rin_desktop_host_failed: () =>
    "Rin desktop host failed before it could start.",
  rin_digitalocean_ssh_key_not_found: () =>
    "DigitalOcean target setup could not find the SSH key. Add the key.",
  rin_disconnected: () => "Rin lost its connection to the background runtime.",
  rin_gui_failed: () => "Rin GUI failed before it could start.",
  rin_gui_unrecognized_arg: (detail) =>
    withDetail(
      "Rin GUI received an unsupported option",
      detail,
      ". Remove it.",
    ),
  rin_install_temp_dir_unavailable: () =>
    "Rin installer could not create a temporary directory. Check disk permissions.",
  rin_elevated_install_unsupported_on_windows: () =>
    "Rin cannot install for another Windows user from this installer session.",
  rin_installed_daemon_entry_missing: () =>
    "Rin install is missing the daemon entrypoint. Reinstall or update Rin.",
  rin_installer_apply_result_missing: () =>
    "Rin installer did not return an install result.",
  rin_installer_gui_command_failed: () =>
    "Rin installer GUI command failed. Check the install settings.",
  rin_installer_gui_disabled: () =>
    "Rin installer GUI is temporarily disabled while the desktop interface is redesigned. Use the terminal installer.",
  rin_installer_gui_install_dir_required: () =>
    "Rin installer GUI needs the default local config directory.",
  rin_installer_gui_model_required: () =>
    "Rin installer GUI needs a model selection. Choose a model.",
  rin_installer_gui_provider_required: () =>
    "Rin installer GUI needs a provider selection. Choose a provider.",
  rin_installer_gui_token_required: () =>
    "Rin installer GUI needs an API token for this provider. Enter the token.",
  rin_installer_gui_unrecognized_arg: (detail) =>
    withDetail(
      "Rin installer GUI received an unsupported option",
      detail,
      ". Remove it.",
    ),
  rin_launchd_daemon_stop_incomplete: () =>
    "Rin could not stop the existing macOS background service.",
  rin_launchd_restart_failed: (detail) =>
    withDetail(
      "Rin could not restart the macOS background service",
      detail,
      ".",
    ),
  rin_launchd_target_user_not_found: () =>
    "Rin could not find the target launchd user. Check the target user.",
  rin_daemon_restart_not_ready: () =>
    "Rin restarted the background service, but its socket did not become ready.",
  rin_managed_service_action_failed: () =>
    "Rin could not control the recorded background service.",
  rin_managed_service_missing: () =>
    "Rin install metadata does not record a background service.",
  rin_managed_service_missing_path: () =>
    "Rin install metadata points to a missing background service file.",
  rin_managed_service_unsupported: () =>
    "This Rin install does not support that lifecycle command on this platform.",
  rin_managed_node_runtime_missing: () =>
    "Rin could not find its managed Node runtime. Repair or reinstall Rin before starting managed services or updating.",
  rin_missing_required_tool: (detail) =>
    withDetail(
      "Rin is missing a required system tool",
      detail,
      ". Install it.",
    ),
  rin_missing_settings_manager: () =>
    "Rin settings are not available in this session.",
  rin_native_gui_command_failed: () => "Rin native GUI command failed.",
  rin_native_gui_missing_session: () =>
    "Rin GUI could not find the requested session. Choose an existing session.",
  rin_native_gui_settings_path_missing: () =>
    "Rin GUI could not locate the settings file.",
  rin_new_session_cancelled: () => "New session creation was cancelled.",
  rin_nightly_selector_not_supported: () =>
    "This command does not support selecting the nightly channel here. Remove the nightly selector.",
  rin_no_attached_session: () =>
    "Rin could not find a session attached to this chat command.",
  rin_release_branch_and_version_conflict: () =>
    "Choose either a release branch or a release version, not both.",
  rin_release_channel_conflict: () =>
    "Choose only one release channel. Remove the extra channel option.",
  rin_release_not_found: (detail) =>
    withDetail(
      "Rin release was not found",
      detail,
      ". Choose another version.",
    ),
  rin_request_failed: () => "Rin request failed.",
  rin_quick_run_daemon_already_running: () =>
    "Quick run found an existing daemon on its startup socket. Stop stale quick-run or Rin daemon processes and try again.",
  rin_quick_run_daemon_exited: (detail) =>
    withDetail(
      "Quick run background service exited before it was ready",
      detail,
      ".",
    ),
  rin_quick_run_daemon_not_ready: () =>
    "Quick run background service did not become ready before the timeout.",
  rin_quick_run_install_dir_missing: () =>
    "Quick run needs a local Rin directory before it can start.",
  rin_quick_run_update_not_supported: () =>
    "Quick run is only available from the installer. Remove the update option.",
  rin_rollback_no_previous_release: () =>
    "No previous Rin release is available to roll back to.",
  rin_rollback_target_is_current: () =>
    "The selected rollback target is already the current Rin release.",
  rin_session_file_required: () =>
    "Rin needs a session file before it can resume that session.",
  rin_session_recovering: () =>
    "Rin is still recovering the session after a disconnect or restart.",
  rin_session_worker_unavailable: () =>
    "Rin could not start a session worker for that session.",
  rin_service_install_unsupported: () =>
    "Managed service install is not supported on this platform. Use a supported platform or manual startup.",
  rin_stable_branch_not_supported: () =>
    "Stable releases do not support selecting a branch. Remove the branch option.",
  rin_stable_selector_not_supported: () =>
    "This command does not support selecting the stable channel here. Remove the stable selector.",
  rin_ssh_not_ready: (detail) =>
    withDetail("SSH target is not ready", detail, ". Check SSH access."),
  rin_target_name_required: () =>
    "Target command needs a target name. Provide the target name.",
  rin_target_not_found: (detail) =>
    withDetail(
      "Rin target was not found",
      detail,
      ". Choose an existing target.",
    ),
  rin_target_register_local_user_usage: () =>
    "Registering a local target needs both a target name and a user. Provide both.",
  rin_timeout: (detail) =>
    `Rin timed out while ${describeRuntimeOperation(detail)}.`,
  rin_tui_disposed: () => "Rin TUI session has already closed. Reopen Rin.",
  rin_tui_failed: () => "Rin TUI failed before it could start.",
  rin_update_installed_release_channel_missing: () =>
    "Rin update could not find the installed release channel. Repair the installed release metadata before updating.",
  rin_update_platform_bundle_checksum_missing: () =>
    "Rin update could not verify the platform bundle because its checksum is missing.",
  rin_update_platform_bundle_checksum_mismatch: () =>
    "Rin update stopped because the platform bundle checksum did not match.",
  rin_tui_not_connected: () =>
    "Rin is not connected to an interactive session yet. Start or reconnect the Rin interface.",
  rin_wait_for_idle_timeout: () =>
    "Rin did not become idle before the timeout. Wait a moment, abort the turn if needed.",
  rin_worker_exit: () =>
    "Rin's background worker exited before the request finished.",
  rin_worker_failed: () =>
    "Rin's background worker failed before the request finished.",
  rin_windows_daemon_cross_user_unsupported: () =>
    "Rin cannot control another Windows user's daemon from this session.",
  rin_windows_daemon_pid_missing: () =>
    "Rin found a Windows daemon socket but could not find its process id.",

  rpc_turn_failed: () => "Rin failed while running the remote turn.",
  rpc_turn_final_output_missing: () =>
    "Rin finished the turn without a final reply.",
  rin_turn_result_invariant_failed: () =>
    "Rin's remote turn ended without a durable terminal result.",
  rin_turn_result_recovery_timeout: () =>
    "Rin could not recover the remote turn result before the timeout.",

  run_managed_session_value_required: () =>
    "Run command needs a managed session name. Provide a leaf such as subagent.",
  run_mode_value_required: () =>
    "Run command needs a mode value. Choose text or json.",
  run_name_unsupported: () =>
    "This run mode does not support naming sessions. Remove the name option.",
  run_prompt_required: () => "Run command needs a prompt. Provide a prompt.",
  run_session_conflict: () =>
    "Choose either --session or --managed-session, not both.",

  recall_aborted: () => "Recall was aborted.",
  self_improve_content_required: () =>
    "Self-improvement update needs content. Add content.",
  session_file_required: () =>
    "Session operation needs a session file. Choose a session.",
  session_fork_unsupported: () =>
    "This session cannot be forked through that path. Use a supported session type or start a new session.",
  run_chat_key_not_supported_in_print_mode: () =>
    "Print mode cannot deliver chat messages. Use a chat-owned delivery surface instead.",

  slack_app_token_required: () =>
    "Slack adapter needs an app token before it can start. Add the token.",
  slack_bot_token_required: () =>
    "Slack adapter needs a bot token before it can start. Add the token.",
  slack_reaction_emoji_required: () =>
    "Slack reaction failed because the emoji is missing. Choose an emoji.",
  slack_send_message_empty: () =>
    "Slack send failed because the outgoing message is empty. Add text or an attachment.",

  telegram_api_failed: (detail) =>
    withDetail(
      "Telegram API request failed",
      detail,
      ". Check the bot token, permissions, and network.",
    ),
  telegram_media_source_missing: () =>
    "Telegram media send failed because the media source is missing. Attach a valid file.",
  telegram_send_message_empty: () =>
    "Telegram send failed because the outgoing message is empty. Add text or an attachment.",
  telegram_token_required: () =>
    "Telegram adapter needs a bot token before it can start. Add the token.",

  unknown_model: modelNotFound,
  unknown_docs_internal_command: () =>
    "Internal document maintenance command is unknown.",
  unknown_run_option: (detail) =>
    withDetail(
      "Unknown run option",
      detail,
      ". Remove it or check the command help.",
    ),
  web_fetch_invalid_url: () => "Enter a valid HTTP or HTTPS URL.",
  fetch_failed: () => "The network request failed.",
  unknown_error: () => "Rin hit an unexpected problem before it could finish.",
};

export function rawErrorMessage(error: unknown) {
  return String((error as any)?.message || error || "").trim();
}

function positiveErrno(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.abs(Math.trunc(value));
}

function errnoFromError(error: unknown, message: string) {
  const direct = positiveErrno((error as any)?.errno);
  if (direct) return direct;
  const matched = UNKNOWN_SYSTEM_ERROR_RE.exec(message);
  return matched ? positiveErrno(Number(matched[1])) : 0;
}

function errnoCodeFromPlatform(errno: number) {
  for (const [code, value] of Object.entries(os.constants.errno || {})) {
    if (value === errno) return code;
  }
  const keriumCode = (Errno as any)[errno];
  return typeof keriumCode === "string" ? keriumCode : "";
}

function nodeSystemErrorName(errno: number) {
  try {
    const name = nodeUtil.getSystemErrorName(-errno);
    return /^Unknown system error\b/i.test(name) ? "" : name;
  } catch {
    return "";
  }
}

function nodeSystemErrorMessage(errno: number) {
  try {
    const getMessage = (nodeUtil as any).getSystemErrorMessage;
    if (typeof getMessage !== "function") return "";
    const message = String(getMessage(-errno) || "").trim();
    return /^Unknown system error\b/i.test(message) ? "" : message;
  } catch {
    return "";
  }
}

function posixSystemErrorMessage(errno: number) {
  try {
    return String(strerror(errno) || "").trim();
  } catch {
    return "";
  }
}

function normalizeSystemErrorMessage(message: string) {
  return message.replace(/^[A-Z](?=[a-z])/, (letter) => letter.toLowerCase());
}

function formatSystemErrno(errno: number) {
  if (!errno) return "";
  const code = nodeSystemErrorName(errno) || errnoCodeFromPlatform(errno);
  const message =
    nodeSystemErrorMessage(errno) || posixSystemErrorMessage(errno);
  if (code && message)
    return `${code}: ${normalizeSystemErrorMessage(message)}`;
  return code || message || "";
}

function formatSystemErrorForUser(error: unknown, message: string) {
  const errno = errnoFromError(error, message);
  const formattedErrno = formatSystemErrno(errno);
  if (!formattedErrno) return "";
  const syscall = String(
    (error as any)?.syscall ||
      UNKNOWN_SYSTEM_ERROR_SYSCALL_RE.exec(message)?.[1] ||
      "",
  ).trim();
  const path = String((error as any)?.path || "").trim();
  const dest = String((error as any)?.dest || "").trim();
  const operation = syscall ? `${syscall} failed: ` : "";
  const pathSuffix = path ? ` (${path}${dest ? ` -> ${dest}` : ""})` : "";
  return `${operation}${formattedErrno}${pathSuffix}`;
}

function markerToTerseRuntimeText(marker: string) {
  return marker.replace(/_/g, " ").replace(/^rin\s+(?:app\s+)?/, "");
}

function formatRuntimeMarkerForFrontendDisplay(message: string) {
  const marker = LEADING_RUNTIME_MARKER_RE.exec(message);
  if (!marker) return message;
  const prefix = markerToTerseRuntimeText(marker[1]);
  const detail = String(marker[3] || "").trim();
  if (!detail) return prefix;
  return `${prefix}${marker[2] ? ":" : ""} ${detail}`;
}

export function formatRuntimeErrorForFrontendDisplay(error: unknown) {
  const message = rawErrorMessage(error);
  if (!message) return "unknown error";
  return formatRuntimeMarkerForFrontendDisplay(message);
}

export function formatRuntimeErrorForChat(error: unknown) {
  const message = formatRuntimeErrorForFrontendDisplay(error);
  if (/^rin error:\s*/i.test(message)) return message;
  return `${CHAT_RUNTIME_ERROR_PREFIX} ${message}`;
}

export function hasUserFacingRuntimeErrorMapping(marker: string) {
  return Boolean(USER_FACING_RUNTIME_ERRORS[marker]);
}

function findMappedMarker(message: string) {
  for (const marker of Object.keys(USER_FACING_RUNTIME_ERRORS)) {
    if (
      new RegExp(`\\b${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(
        message,
      )
    ) {
      return marker;
    }
  }
  return "";
}

export function formatRuntimeErrorForUser(error: unknown) {
  const message = rawErrorMessage(error);
  if (!message) return "unknown error";
  const systemError = formatSystemErrorForUser(error, message);
  if (systemError) return systemError;
  const internalError = INTERNAL_RUNTIME_ERROR_RE.exec(message);
  if (internalError) {
    const marker = internalError[1];
    const detail = internalError[2] || "";
    const formatKnownError = USER_FACING_RUNTIME_ERRORS[marker];
    if (formatKnownError) return formatKnownError(detail);
    return formatRuntimeMarkerForFrontendDisplay(message);
  }
  const embeddedMarker = findMappedMarker(message);
  if (embeddedMarker) {
    return USER_FACING_RUNTIME_ERRORS[embeddedMarker]("");
  }
  return message;
}
