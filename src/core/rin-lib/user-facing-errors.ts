const INTERNAL_RUNTIME_ERROR_RE =
  /^([a-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+)(?::\s*(.*))?$/;

const UNKNOWN_INTERNAL_ERROR_MESSAGE =
  "Rin hit an internal runtime problem before it could finish. Retry the action; if it repeats, run rin doctor and check the logs.";

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
  chat_bridge_at_id_required: () =>
    "Chat bridge send failed because a mention is missing its target id. Fix the mention part and retry.",
  chat_bridge_chat_required: () =>
    "Chat bridge send failed because no target chat was selected. Choose a chat and retry.",
  chat_bridge_entry_missing: () =>
    "Chat bridge setup is incomplete. Configure the chat bridge entry and retry.",
  chat_bridge_send_empty: () =>
    "Chat bridge send failed because the message is empty. Add text or an attachment and retry.",
  chat_command_failed: () =>
    "Rin could not run that chat command. Retry it; if it repeats, restart Rin.",
  chat_command_text_missing: () =>
    "Rin ran the chat command, but it returned no reply text. Retry it; if it repeats, restart Rin.",
  chat_controller_key_required: () =>
    "Chat controller setup is missing a controller key. Recreate the chat binding and retry.",
  chat_controller_disposed: () =>
    "Rin restarted the chat controller while handling this message. Retry the action now.",
  chat_final_assistant_text_missing: () =>
    "Rin finished the chat turn but did not produce reply text. Retry the message; if it repeats, restart Rin.",
  chat_frontend_driver_disposed: () =>
    "Rin stopped the chat driver while recovering. Retry the action now.",
  chat_inbox_chatKey_required: () =>
    "Chat inbox write failed because the chat key is missing. Check the adapter event and retry.",
  chat_inbox_messageId_required: () =>
    "Chat inbox write failed because the message id is missing. Check the adapter event and retry.",
  chat_message_store_chatKey_required: () =>
    "Chat message store write failed because the chat key is missing. Check the adapter event and retry.",
  chat_message_store_messageId_required: () =>
    "Chat message store write failed because the message id is missing. Check the adapter event and retry.",
  chat_outbox_empty_message: () =>
    "Chat send failed because the outgoing message is empty. Add text or an attachment and retry.",
  chat_outbox_invalid_json: () =>
    "Chat outbox contains invalid JSON. Recreate the outbox item and retry.",
  chat_outbox_invalid_part: () =>
    "Chat send failed because one message part is invalid. Fix the rich message part and retry.",
  chat_restored_session_mismatch: () =>
    "Rin detected that the chat turn switched to a different session while recovering. Retry the message; if it repeats, restart Rin.",
  chat_send_at_id_required: () =>
    "Chat send failed because a mention is missing its target id. Fix the mention part and retry.",
  chat_send_message_empty_result: () =>
    "Chat adapter accepted the send request but returned no delivered message. Check the adapter connection and retry.",
  chat_text_required: () =>
    "Chat handling failed because the incoming text is empty. Send a non-empty message and retry.",
  chat_turn_aborted: () => "The chat turn was aborted.",

  cron_chat_unavailable: () =>
    "Scheduled task delivery failed because the target chat is unavailable. Check the task chat binding and retry.",
  cron_final_assistant_text_missing: () =>
    "Scheduled task finished but produced no final reply. Check the task session and retry.",
  cron_invalid_agent_task: () =>
    "Scheduled task configuration is not a valid agent task. Fix the task target and retry.",
  cron_invalid_expression: () =>
    "Scheduled task cron expression is invalid. Fix the schedule and retry.",
  cron_invalid_session_instruction_task: () =>
    "Scheduled task configuration is not a valid session-instruction task. Fix the task target and retry.",
  cron_invalid_shell_task: () =>
    "Scheduled task configuration is not a valid shell task. Fix the task target and retry.",
  cron_next_run_not_found: () =>
    "Scheduled task has no next run time. Check the schedule and retry.",
  cron_prompt_required: () =>
    "Scheduled task needs a prompt before it can run. Add the prompt and retry.",
  cron_session_file_not_found: () =>
    "Scheduled task session file was not found. Recreate or rebind the task session and retry.",
  cron_session_file_required: () =>
    "Scheduled task needs a session file before it can run. Rebind the task session and retry.",
  cron_session_instruction_chat_binding_not_found: () =>
    "Scheduled task cannot find the chat binding for this session. Rebind the task or choose another session.",
  cron_session_instruction_chat_key_forbidden: () =>
    "Scheduled task session instructions must use the session chat binding, not a separate chat key. Fix the task target and retry.",
  cron_session_instruction_requires_agent_prompt: () =>
    "Scheduled task session instruction needs an agent prompt. Add the prompt and retry.",
  cron_session_instruction_requires_once: () =>
    "Scheduled task session instruction must be a one-time task. Change the schedule and retry.",
  cron_target_required: () =>
    "Scheduled task needs a target before it can run. Choose a target and retry.",
  cron_trigger_required: () =>
    "Scheduled task needs a trigger before it can run. Add a schedule or one-time trigger and retry.",

  discord_channel_not_sendable: (detail) =>
    withDetail(
      "Discord send failed because the target channel cannot receive messages",
      detail,
      ". Check the channel and bot permissions.",
    ),
  discord_send_message_empty: () =>
    "Discord send failed because the outgoing message is empty. Add text or an attachment and retry.",
  discord_send_message_empty_result: () =>
    "Discord accepted the send request but returned no delivered message. Check the bot permissions and retry.",
  discord_token_required: () =>
    "Discord adapter needs a bot token before it can start. Add the token and restart Rin.",

  external_chat_adapter_did_not_register_bot: () =>
    "External chat adapter started but did not register a bot. Fix the adapter implementation and restart Rin.",
  external_chat_adapter_missing_createAdapter: () =>
    "External chat adapter is missing its createAdapter entrypoint. Fix the adapter package and restart Rin.",
  external_chat_adapter_return_requires_adapter_and_bot: () =>
    "External chat adapter must return both an adapter and a bot. Fix the adapter implementation and restart Rin.",

  final_assistant_text_missing: () =>
    "Rin finished the turn but did not produce final reply text. Retry the action; if it repeats, restart Rin.",
  frontend_model_not_found: modelNotFound,
  frontend_session_not_connected: () =>
    "Rin is not connected to a session yet. Reconnect or start a new session, then retry.",
  frontend_session_restore_mismatch: () =>
    "Rin could not restore the requested chat session before running the turn. Retry the message; if it repeats, restart Rin.",
  frontend_turn_already_running: () =>
    "A turn is already running in this session. Wait for it to finish or abort it, then retry.",
  frontend_turn_driver_disposed: () =>
    "Rin stopped the previous chat driver while recovering. Retry the action now.",

  identity_first_owner_must_self_claim: () =>
    "The first owner identity must be claimed by the same platform user. Use the owner account and retry.",
  identity_last_owner_required: () =>
    "Rin must keep at least one owner identity. Add another owner before removing this one.",
  identity_owner_bootstrap_required: () =>
    "Only an owner can bootstrap trusted chat identities. Use the owner account and retry.",
  identity_owner_required: () =>
    "Only an owner can change this chat identity setting. Use the owner account and retry.",
  identity_platform_required: () =>
    "Identity update needs a platform name. Provide the platform and retry.",
  identity_user_id_required: () =>
    "Identity update needs a user id. Provide the user id and retry.",

  invalid_chatKey: (detail) =>
    withDetail(
      "Invalid chat key",
      detail,
      ". Use a configured platform chat key and retry.",
    ),
  invalid_json: () => "Invalid JSON. Fix the JSON and retry.",
  invalid_model: invalidModel,
  invalid_model_ref: invalidModel,

  lark_app_id_required: () =>
    "Lark adapter needs an app id before it can start. Add the app id and restart Rin.",
  lark_app_secret_required: () =>
    "Lark adapter needs an app secret before it can start. Add the app secret and restart Rin.",
  lark_reaction_emoji_required: () =>
    "Lark reaction failed because the emoji is missing. Choose an emoji and retry.",
  lark_send_message_empty: () =>
    "Lark send failed because the outgoing message is empty. Add text or an attachment and retry.",

  maintenance_job_failed: () =>
    "Maintenance job failed. Check the maintenance log and retry.",
  maintenance_job_invalid_input: () =>
    "Maintenance job input is invalid. Recreate the job and retry.",
  maintenance_job_invalid_payload: () =>
    "Maintenance job payload is invalid. Recreate the job and retry.",
  managed_new_session_unsupported: () =>
    "This managed session cannot create a new session through that path. Use /new or the session menu instead.",

  minecraft_not_connected: () =>
    "Minecraft chat adapter is not connected. Check the adapter connection and retry.",
  minecraft_send_message_empty: () =>
    "Minecraft chat send failed because the outgoing message is empty. Add text and retry.",
  minecraft_url_required: () =>
    "Minecraft chat adapter needs a server URL before it can start. Add the URL and restart Rin.",
  missing_status_interval: () =>
    "Status watch needs an interval value. Provide a valid interval and retry.",

  new_session_session_file_unsupported: () =>
    "Could not start a new chat session because the command was bound to a replied message's old session. Retry /new; chat commands should not use replied-message sessions.",

  oauth_login_failed: () =>
    "OAuth login failed. Retry the login; if it repeats, check the provider configuration.",
  oauth_provider_id_required: () =>
    "OAuth login needs a provider id. Choose a provider and retry.",

  onebot_disconnected: () =>
    "OneBot adapter disconnected. Check NapCat/OneBot and retry after it reconnects.",
  onebot_endpoint_required: () =>
    "OneBot adapter needs an endpoint before it can start. Add the endpoint and restart Rin.",
  onebot_not_connected: () =>
    "OneBot adapter is not connected. Check NapCat/OneBot and retry.",
  onebot_reaction_emoji_unsupported: () =>
    "OneBot reaction failed because this emoji is not supported. Choose a supported emoji and retry.",
  onebot_reaction_requires_group_chat: () =>
    "OneBot reactions are only available in group chats. Use a group chat or skip the reaction.",
  onebot_send_message_empty: () =>
    "OneBot send failed because the outgoing message is empty. Add text or an attachment and retry.",
  onebot_send_message_empty_result: () =>
    "OneBot accepted the send request but returned no delivered message. Check NapCat/OneBot and retry.",

  background_extension_entrypoint_missing: () =>
    "Background extension is missing a Rin extension entry point. Export a Rin extension factory or background service and restart Rin.",

  python_not_found: () =>
    "Web search needs Python to start the local SearXNG sidecar. Install Python 3.10 or newer and retry.",
  python_version_unsupported: () =>
    "Web search could not prepare a Python 3.10 or newer runtime for the local SearXNG sidecar. Check the network and retry, or run rin doctor.",
  uv_install_failed: () =>
    "Web search could not install Rin's private Python helper. Check the network and retry, or run rin doctor.",
  qq_app_id_required: () =>
    "QQ adapter needs an app id before it can start. Add the app id and restart Rin.",
  qq_reaction_requires_channel_chat: () =>
    "QQ reaction failed because the target is not a channel chat. Use a channel chat or skip the reaction.",
  qq_send_message_empty: () =>
    "QQ send failed because the outgoing message is empty. Add text or an attachment and retry.",
  qq_token_required: () =>
    "QQ adapter needs a token before it can start. Add the token and restart Rin.",

  rin_agent_sdk_task_id_required: () =>
    "Agent SDK task operation needs a task id. Provide the task id and retry.",
  rin_app_cli_failed: () =>
    "Rin command failed before it could finish. Retry the command; if it repeats, run rin doctor.",
  rin_app_daemon_failed: () =>
    "Rin daemon failed before it could finish starting. Run rin doctor or restart Rin.",
  rin_app_daemon_services_failed: () =>
    "Rin daemon could not start its background services. Run rin doctor and check the daemon logs.",
  rin_app_install_failed: () =>
    "Rin installer failed before it could finish. Check the install settings and retry.",
  rin_app_tui_failed: () =>
    "Rin TUI failed before it could start. Retry; if it repeats, run rin doctor.",
  rin_app_worker_failed: () =>
    "Rin worker failed before it could start. Restart Rin; if it repeats, run rin doctor.",
  rin_beta_selector_not_supported: () =>
    "This command does not support selecting the beta channel here. Remove the beta selector and retry.",
  rin_command_failed: (detail) =>
    withDetail(
      "Rin command failed",
      detail,
      ". Check the command output and retry.",
    ),
  rin_installer_fd_install_dir_missing: () =>
    "Rin installer needs an install directory before preparing managed search tools. Choose an install directory and retry.",
  rin_installer_fd_manager_unavailable: () =>
    "Rin installer could not prepare managed search tools. Retry the install; if it repeats, run rin doctor.",
  rin_container_name_required: () =>
    "Target operation needs a container name. Provide the container name and retry.",
  rin_daemon_failed: () =>
    "Rin's background service failed to start. Run rin doctor or restart Rin to inspect the problem.",
  rin_daemon_shutting_down: () =>
    "Rin is shutting down right now. Wait until it starts again, then retry.",
  rin_daemon_unavailable: (detail) =>
    withDetail(
      "Rin's background service is not available",
      detail,
      ". Start or restart Rin, then retry.",
    ),
  rin_desktop_host_failed: () =>
    "Rin desktop host failed before it could start. Retry; if it repeats, run rin doctor.",
  rin_digitalocean_ssh_key_not_found: () =>
    "DigitalOcean target setup could not find the SSH key. Add the key and retry.",
  rin_disconnected: () =>
    "Rin lost its connection to the background runtime. Retry the action; if it repeats, restart Rin.",
  rin_gui_failed: () =>
    "Rin GUI failed before it could start. Retry; if it repeats, run rin doctor.",
  rin_gui_unrecognized_arg: (detail) =>
    withDetail(
      "Rin GUI received an unsupported option",
      detail,
      ". Remove it and retry.",
    ),
  rin_install_temp_dir_unavailable: () =>
    "Rin installer could not create a temporary directory. Check disk permissions and retry.",
  rin_installed_daemon_entry_missing: () =>
    "Rin install is missing the daemon entrypoint. Reinstall or update Rin.",
  rin_installer_apply_result_missing: () =>
    "Rin installer did not return an install result. Retry the install; if it repeats, check the logs.",
  rin_installer_gui_command_failed: () =>
    "Rin installer GUI command failed. Check the install settings and retry.",
  rin_installer_gui_install_dir_required: () =>
    "Rin installer GUI needs an install directory. Choose a directory and retry.",
  rin_installer_gui_model_required: () =>
    "Rin installer GUI needs a model selection. Choose a model and retry.",
  rin_installer_gui_provider_required: () =>
    "Rin installer GUI needs a provider selection. Choose a provider and retry.",
  rin_installer_gui_token_required: () =>
    "Rin installer GUI needs an API token for this provider. Enter the token and retry.",
  rin_installer_gui_unrecognized_arg: (detail) =>
    withDetail(
      "Rin installer GUI received an unsupported option",
      detail,
      ". Remove it and retry.",
    ),
  rin_launchd_target_user_not_found: () =>
    "Rin could not find the target launchd user. Check the target user and retry.",
  rin_missing_required_tool: (detail) =>
    withDetail(
      "Rin is missing a required system tool",
      detail,
      ". Install it and retry.",
    ),
  rin_missing_settings_manager: () =>
    "Rin settings are not available in this session. Reconnect or restart Rin, then retry.",
  rin_native_gui_command_failed: () =>
    "Rin native GUI command failed. Retry the action; if it repeats, restart Rin.",
  rin_native_gui_missing_session: () =>
    "Rin GUI could not find the requested session. Choose an existing session and retry.",
  rin_native_gui_settings_path_missing: () =>
    "Rin GUI could not locate the settings file. Restart Rin or reinstall it, then retry.",
  rin_new_session_cancelled: () => "New session creation was cancelled.",
  rin_nightly_selector_not_supported: () =>
    "This command does not support selecting the nightly channel here. Remove the nightly selector and retry.",
  rin_no_attached_session: () =>
    "Rin could not find a session attached to this chat command. Start a new chat session with /new, then retry the command.",
  rin_release_branch_and_version_conflict: () =>
    "Choose either a release branch or a release version, not both.",
  rin_release_channel_conflict: () =>
    "Choose only one release channel. Remove the extra channel option and retry.",
  rin_release_not_found: (detail) =>
    withDetail(
      "Rin release was not found",
      detail,
      ". Choose another version and retry.",
    ),
  rin_request_failed: () =>
    "Rin request failed. Retry the command; if it repeats, run rin doctor.",
  rin_rollback_no_previous_release: () =>
    "No previous Rin release is available to roll back to.",
  rin_rollback_target_is_current: () =>
    "The selected rollback target is already the current Rin release.",
  rin_session_recovering: () =>
    "Rin is still recovering the session after a disconnect or restart. Wait a moment, then retry.",
  rin_service_install_unsupported: () =>
    "Managed service install is not supported on this platform. Use a supported platform or manual startup.",
  rin_stable_branch_not_supported: () =>
    "Stable releases do not support selecting a branch. Remove the branch option and retry.",
  rin_stable_selector_not_supported: () =>
    "This command does not support selecting the stable channel here. Remove the stable selector and retry.",
  rin_ssh_not_ready: (detail) =>
    withDetail(
      "SSH target is not ready",
      detail,
      ". Check SSH access and retry.",
    ),
  rin_target_name_required: () =>
    "Target command needs a target name. Provide the target name and retry.",
  rin_target_not_found: (detail) =>
    withDetail(
      "Rin target was not found",
      detail,
      ". Choose an existing target and retry.",
    ),
  rin_target_register_local_user_usage: () =>
    "Registering a local target needs both a target name and a user. Provide both and retry.",
  rin_timeout: (detail) =>
    `Rin timed out while ${describeRuntimeOperation(detail)}. Retry the action; if it repeats, restart Rin and try again.`,
  rin_tui_disposed: () =>
    "Rin TUI session has already closed. Reopen Rin and retry.",
  rin_tui_failed: () =>
    "Rin TUI failed before it could start. Retry; if it repeats, run rin doctor.",
  rin_tui_not_connected: () =>
    "Rin is not connected to an interactive session yet. Start or reconnect the Rin interface, then retry.",
  rin_wait_for_idle_timeout: () =>
    "Rin did not become idle before the timeout. Wait a moment, abort the turn if needed, then retry.",
  rin_worker_exit: () =>
    "Rin's background worker exited before the request finished. Retry the action; if it repeats, restart Rin and try again.",
  rin_worker_failed: () =>
    "Rin's background worker failed before the request finished. Retry the action; if it repeats, restart Rin and try again.",

  rpc_turn_failed: () =>
    "Rin failed while running the remote turn. Retry the action; if it repeats, restart Rin.",
  rpc_turn_final_output_missing: () =>
    "Rin finished the turn but did not receive a final reply. Retry the action; if it repeats, restart Rin.",

  run_mode_value_required: () =>
    "Run command needs a mode value. Choose text or json and retry.",
  run_name_unsupported: () =>
    "This run mode does not support naming sessions. Remove the name option and retry.",
  run_prompt_required: () =>
    "Run command needs a prompt. Provide a prompt and retry.",

  search_memory_aborted: () => "Memory search was aborted.",
  searxng_start_failed: () =>
    "The local SearXNG search sidecar exited before it became ready. Restart Rin or run rin doctor.",
  searxng_start_timeout: () =>
    "The local SearXNG search sidecar did not become ready in time. Retry later or run rin doctor.",
  self_improve_content_required: () =>
    "Self-improvement update needs content. Add content and retry.",
  session_file_required: () =>
    "Session operation needs a session file. Choose a session and retry.",
  session_fork_unsupported: () =>
    "This session cannot be forked through that path. Use a supported session type or start a new session.",

  slack_app_token_required: () =>
    "Slack adapter needs an app token before it can start. Add the token and restart Rin.",
  slack_bot_token_required: () =>
    "Slack adapter needs a bot token before it can start. Add the token and restart Rin.",
  slack_reaction_emoji_required: () =>
    "Slack reaction failed because the emoji is missing. Choose an emoji and retry.",
  slack_send_message_empty: () =>
    "Slack send failed because the outgoing message is empty. Add text or an attachment and retry.",

  telegram_api_failed: (detail) =>
    withDetail(
      "Telegram API request failed",
      detail,
      ". Check the bot token, permissions, and network, then retry.",
    ),
  telegram_media_source_missing: () =>
    "Telegram media send failed because the media source is missing. Attach a valid file and retry.",
  telegram_send_message_empty: () =>
    "Telegram send failed because the outgoing message is empty. Add text or an attachment and retry.",
  telegram_token_required: () =>
    "Telegram adapter needs a bot token before it can start. Add the token and restart Rin.",

  unknown_model: modelNotFound,
  unknown_run_option: (detail) =>
    withDetail(
      "Unknown run option",
      detail,
      ". Remove it or check the command help.",
    ),
  web_fetch_invalid_url: () => "Enter a valid HTTP or HTTPS URL.",
  web_search_failed: () =>
    "Web search failed. Check the network or search backend, then retry.",
  web_search_query_required: () => "Enter a search query or URL.",
  web_search_runtime_fetch_tools_not_found: () =>
    "Web search needs git, or curl/wget plus tar, to install the local SearXNG sidecar. Install the missing tool and retry.",
  web_search_runtime_source_invalid: () =>
    "The local SearXNG search runtime is incomplete. Re-run the Rin installer or run rin doctor.",
  web_search_runtime_not_installed: () =>
    "The local SearXNG search runtime is not installed. Re-run the Rin installer or run rin doctor.",
  web_search_sidecar_unavailable: () =>
    "The local SearXNG search sidecar is not available yet. Restart Rin or run rin doctor.",

  fetch_failed: () =>
    "The network request failed. Check the URL, network/proxy, or retry later.",
  unknown_error: () =>
    "Rin hit an unexpected problem before it could finish. Retry the action; if it repeats, run rin doctor and check the logs.",
};

export function rawErrorMessage(error: unknown) {
  return String((error as any)?.message || error || "").trim();
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
  const internalError = INTERNAL_RUNTIME_ERROR_RE.exec(message);
  if (internalError) {
    const marker = internalError[1];
    const detail = internalError[2] || "";
    const formatKnownError = USER_FACING_RUNTIME_ERRORS[marker];
    if (formatKnownError) return formatKnownError(detail);
    return UNKNOWN_INTERNAL_ERROR_MESSAGE;
  }
  const embeddedMarker = findMappedMarker(message);
  if (embeddedMarker) {
    return USER_FACING_RUNTIME_ERRORS[embeddedMarker]("");
  }
  return message;
}
