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
  chat_archive_header_compare_and_swap_failed: () =>
    "Chat archive stopped because the message locator changed during commit.",
  chat_archive_hot_delete_failed: () =>
    "Chat archive could not remove the verified duplicate hot payload.",
  chat_archive_hot_payload_missing: () =>
    "Chat archive could not find every selected hot payload.",
  chat_archive_message_identity_required: () =>
    "Chat archive requires a message id, chat key, and received time.",
  chat_archive_message_still_operational: () =>
    "Chat archive cannot move a message that is still being processed.",
  chat_archive_messages_required: () =>
    "Chat archive requires at least one message.",
  chat_archive_payload_hash_mismatch: () =>
    "Chat archive payload integrity verification failed.",
  chat_archive_payload_locator_mismatch: () =>
    "Chat archive message metadata does not match its payload location.",
  chat_archive_reingest_requires_restore: () =>
    "Chat archive cannot replace an archived payload before restoring it to the hot store.",
  chat_archive_rollback_header_mismatch: () =>
    "Chat archive rollback stopped because the message locator changed.",
  chat_archive_segment_checksum_mismatch: () =>
    "Chat archive segment checksum verification failed.",
  chat_archive_segment_count_mismatch: () =>
    "Chat archive segment does not contain every selected message.",
  chat_archive_segment_hash_mismatch: () =>
    "Chat archive segment contains a payload with an invalid hash.",
  chat_archive_segment_integrity_failed: () =>
    "Chat archive segment database integrity verification failed.",
  chat_archive_segment_missing: (detail) =>
    withDetail("Chat archive segment is missing", detail),
  chat_archive_segment_not_committed: () =>
    "Chat archive rollback requires a committed segment.",
  chat_archive_segment_reservation_lost: () =>
    "Chat archive lost ownership of its segment reservation before commit.",
  chat_archive_single_period_required: () =>
    "Chat archive can move messages from only one calendar month per segment.",
  invalid_received_at: () =>
    "Chat archive message has an invalid received time.",
  transcript_archive_missing: (detail) =>
    withDetail("The canonical transcript archive is missing", detail),
  transcript_search_install_migration_required: () =>
    "Transcript search data must be upgraded by the Rin installer before use.",
  transcript_search_install_migration_incomplete: () =>
    "The Rin installer could not finish upgrading transcript search data.",
  transcript_search_install_staging_schema_mismatch: () =>
    "The staged transcript search index has an incompatible schema.",
  transcript_search_install_staging_path_invalid: () =>
    "The staged transcript search index path is invalid.",
  transcript_search_install_publish_guard_missing: () =>
    "The transcript search migration lost its publish guard.",
  transcript_search_install_backup_manifest_invalid: () =>
    "The transcript search migration backup manifest is invalid.",
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
  chat_bridge_unavailable: (detail) =>
    withDetail("Chat is currently unavailable", detail),
  chat_command_failed: () => "Rin could not run that chat command.",
  chat_command_text_missing: () =>
    "Rin ran the chat command, but it returned no reply text.",
  chat_controller_key_required: () =>
    "Chat controller setup is missing a controller key. Recreate the chat binding.",
  chat_controller_disposed: () =>
    "Rin restarted the chat controller while handling this message.",
  chat_database_chatKey_required: () =>
    "Chat database access failed because the chat key is missing.",
  chat_database_future_schema: (detail) =>
    withDetail("The chat database was created by a newer Rin version", detail),
  chat_database_incomplete_schema: () =>
    "The chat database schema is incomplete.",
  chat_database_partial_schema: () =>
    "The chat database contains a partial schema.",
  chat_database_schema_fingerprint_mismatch: () =>
    "The chat database schema integrity check failed.",
  chat_database_schema_version_mismatch: () =>
    "The chat database schema version does not match its metadata.",
  chat_database_schema_upgrade_required: (detail) =>
    withDetail(
      "The chat database needs an install or update migration before Chat can start",
      detail,
    ),
  chat_database_unsupported_schema: (detail) =>
    withDetail("The chat database schema version is unsupported", detail),
  chat_inbox_chatKey_required: () =>
    "Chat inbox write failed because the chat key is missing. Check the adapter event.",
  chat_inbox_messageId_required: () =>
    "Chat inbox write failed because the message id is missing. Check the adapter event.",
  chat_inbox_claim_required: () =>
    "Chat inbox update failed because its processing claim is missing.",
  chat_inbox_claim_lost_during_classification: () =>
    "Chat inbox ownership changed while classifying the message.",
  chat_inbox_message_commit_failed: () =>
    "Chat inbox write failed while committing the inbound message.",
  chat_inbox_message_identity_required: () =>
    "Chat inbox write failed because the inbound message identity is incomplete.",
  chat_inbox_turn_commit_failed: () =>
    "Chat inbox write failed while committing the turn ledger.",
  chat_install_migration_install_dir_required: () =>
    "Chat migration needs the target Rin install directory.",
  memory_install_migration_install_dir_required: () =>
    "Memory migration needs the target Rin install directory.",
  memory_install_migration_runtime_required: () =>
    "Memory migration needs the staged Rin runtime before installation can continue.",
  chat_install_migration_invalid_session_state: (detail) =>
    withDetail("Chat migration found invalid legacy session state", detail),
  chat_install_migration_session_state_read_failed: (detail) =>
    withDetail("Chat migration could not read legacy session state", detail),
  chat_install_migration_invalid_settings: (detail) =>
    withDetail("Chat migration could not read the installed settings", detail),
  chat_key_migration_invalid_marker: (detail) =>
    withDetail("Chat migration found an invalid progress marker", detail),
  chat_key_migration_marker_id_mismatch: () =>
    "Chat migration found a progress marker owned by another migration.",
  chat_key_migration_invalid_marker_state: () =>
    "Chat migration found an incomplete progress marker state.",
  chat_key_migration_invalid_resolved_ledger: (detail) =>
    withDetail(
      "Chat migration found an invalid resolved-record ledger",
      detail,
    ),
  chat_key_migration_resolved_ledger_collision: () =>
    "Chat migration found conflicting resolved-record ledger identities.",
  chat_key_migration_invalid_resolved_ledger_entry: () =>
    "Chat migration found a resolved-record ledger entry that does not match its archived message.",
  chat_legacy_migration_archive_collision: (detail) =>
    withDetail("Legacy chat migration found an existing archive", detail),
  chat_legacy_migration_invalid_inbox: (detail) =>
    withDetail("Legacy chat migration found an invalid inbox item", detail),
  chat_legacy_migration_invalid_inbox_chat_key: () =>
    "Legacy chat migration found an invalid inbox chat key.",
  chat_legacy_migration_invalid_json: (detail) =>
    withDetail("Legacy chat migration found invalid JSON", detail),
  chat_legacy_migration_read_failed: (detail) =>
    withDetail("Legacy chat migration could not read a source record", detail),
  chat_legacy_migration_invalid_preserved_summary: (detail) =>
    withDetail(
      "Legacy chat migration found an invalid preserved-record summary",
      detail,
    ),
  chat_legacy_migration_invalid_message_identity: () =>
    "Legacy chat migration found a message with incomplete identity.",
  chat_legacy_migration_invalid_outbox: (detail) =>
    withDetail("Legacy chat migration found an invalid outbox item", detail),
  chat_legacy_migration_unknown_state: (detail) =>
    withDetail(
      "Legacy chat migration found an unknown migration state",
      detail,
    ),
  chat_message_id_required: () =>
    "Chat action failed because the target message is missing. Choose a message.",
  chat_reaction_emoji_required: () =>
    "Chat reaction failed because the emoji is missing. Choose an emoji.",
  chat_key_required: () =>
    "Chat action failed because the target chat is missing. Choose a chat.",
  chat_message_store_chatKey_required: () =>
    "Stored chat message access requires an exact chat key.",
  chat_message_store_messageId_required: () =>
    "Chat message store write failed because the message id is missing. Check the adapter event.",
  chat_outbox_delivery_missing: () =>
    "Chat send failed before the outbox item reached the adapter. Check the outgoing payload.",
  chat_outbox_delivery_pending: () =>
    "Chat reply is still waiting in the outbox.",
  chat_outbox_empty_message: () =>
    "Chat send failed because the outgoing message is empty. Add text or an attachment.",
  chat_outbox_claim_read_failed: () =>
    "Chat outbox could not read back its delivery claim.",
  chat_outbox_attempt_superseded: () =>
    "Chat delivery was replaced by a newer outbox attempt.",
  chat_outbox_idempotency_collision: () =>
    "Chat outbox found a duplicate delivery key. Check the outgoing payload.",
  chat_outbox_invalid_json: () =>
    "Chat outbox contains invalid JSON. Recreate the outbox item.",
  chat_outbox_invalid_payload: () =>
    "Chat send failed because the outgoing payload is invalid. Add text or message parts.",
  chat_outbox_invalid_part: () =>
    "Chat send failed because one message part is invalid. Fix the rich message part.",
  chat_outbox_media_missing: () =>
    "Chat send failed because a local attachment is missing.",
  chat_generation_nonterminal_send_in_flight: () =>
    "Chat reset is waiting for an earlier delivery to settle.",
  chat_legacy_migration_archive_changed: () =>
    "Chat data migration stopped because the legacy archive changed.",
  chat_legacy_migration_invalid_message_timestamp: () =>
    "Chat data migration stopped because a legacy message timestamp is invalid.",
  chat_legacy_migration_invalid_timestamp: () =>
    "Chat data migration stopped because a legacy control timestamp is invalid.",
  chat_legacy_migration_source_changed: () =>
    "Chat data migration stopped because legacy data changed after import.",
  chat_legacy_migration_source_changed_during_import: () =>
    "Chat data migration stopped because legacy data changed during import.",
  chat_legacy_migration_source_recreated: () =>
    "Chat data migration stopped because legacy data reappeared after cutover.",
  chat_restored_session_mismatch: () =>
    "Rin detected that the chat turn switched to a different session while recovering.",
  chat_send_at_id_required: () =>
    "Chat send failed because a mention is missing its target id. Fix the mention part.",
  chat_send_message_empty_result: () =>
    "Chat adapter accepted the send request but returned no delivered message. Check the adapter connection.",
  chat_text_required: () =>
    "Chat handling failed because the incoming text is empty. Send a non-empty message.",
  chat_turn_aborted: () => "The chat turn was aborted.",
  chat_turn_fence_lost: () =>
    "The chat turn expired before its reply could be committed. Rin will use the current turn owner.",
  chat_turn_id_required: () =>
    "Chat turn update failed because the turn id is missing.",
  chat_turn_owner_epoch_required: () =>
    "Chat turn update failed because the owner fence is missing.",

  agent_practices_fetch_failed: () =>
    "Agent practice document refresh failed because a remote file could not be downloaded.",
  agent_practices_fetch_unavailable: () =>
    "Agent practice document refresh needs a runtime HTTP fetch implementation.",

  cron_chat_unavailable: () =>
    "Scheduled task delivery failed because the target chat is unavailable. Check the task frontend binding.",
  cron_frontend_key_required: () =>
    "Scheduled task frontend binding needs a frontend key. Add the key or remove the binding.",
  cron_frontend_tui_unbindable: () =>
    "Scheduled tasks cannot bind to a TUI because TUI frontends are not addressable. Remove the task frontend binding.",
  cron_invalid_agent_task: () =>
    "Scheduled task configuration is not a valid agent task. Fix the task target.",
  cron_invalid_expression: () =>
    "Scheduled task cron expression is invalid. Fix the schedule.",
  cron_invalid_shell_task: () =>
    "Scheduled task configuration is not a valid shell task. Fix the task target.",
  cron_invalid_target_kind: () =>
    "Scheduled task target kind is invalid. Choose an agent prompt or shell command target.",
  cron_next_run_not_found: () =>
    "Scheduled task has no next run time. Check the schedule.",
  cron_prompt_required: () =>
    "Scheduled task needs a prompt before it can run. Add the prompt.",
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

  pi_prompt_shape_changed: () =>
    "Rin stopped because Pi's system prompt structure changed and Rin could not apply its prompt overlay safely.",

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
  rin_duplicate_command_id: () =>
    "Rin rejected a duplicate command identifier that is still in use.",
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
  rin_windows_startup_hold_ambiguous: () =>
    "Rin found both active and update-held Windows startup entries. Remove the duplicate entry before retrying the update.",
  rin_systemd_unit_hold_ambiguous: () =>
    "Rin found an ambiguous systemd unit-file hold state. Inspect the recorded unit before retrying the update.",
  rin_managed_service_file_hold_target_executor_required: () =>
    "Rin cannot update the target user's service file without a target-user executor.",
  rin_service_file_hold_arguments_invalid: () =>
    "Rin received invalid service-file hold arguments.",
  rin_service_file_hold_kind_invalid: () =>
    "Rin received an unsupported service-file hold kind.",
  rin_managed_node_runtime_missing: () =>
    "Rin could not find its managed Node runtime. Repair or reinstall Rin before starting managed services or updating.",
  rin_managed_node_npm_missing: () =>
    "Rin could not find npm in its managed Node runtime.",
  rin_managed_npm_cache_write_failed: () =>
    "Rin could not save the verified managed npm archive to its download cache.",
  rin_managed_npm_checksum_mismatch: () =>
    "Rin stopped because the managed npm archive checksum did not match.",
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
  rin_session_model_runtime_unavailable: () =>
    "Rin could not access the session model runtime.",
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
  rin_update_job_invalid: () =>
    "Rin update could not read its job file. Start the update again.",
  rin_update_launchd_user_domain_missing: () =>
    "Rin update could not resolve the current macOS user domain.",
  rin_update_platform_bundle_checksum_missing: () =>
    "Rin update could not verify the platform bundle because its checksum is missing.",
  rin_update_platform_bundle_checksum_mismatch: () =>
    "Rin update stopped because the platform bundle checksum did not match.",
  rin_tui_not_connected: () =>
    "Rin is not connected to an interactive session yet. Start or reconnect the Rin interface.",
  rin_wait_for_idle_timeout: () =>
    "Rin did not become idle before the timeout. Wait a moment, abort the turn if needed.",
  rin_worker_cleanup_failed: () =>
    "Rin could not finish cleaning up the background worker.",
  rin_worker_exit: () =>
    "Rin's background worker exited before the request finished.",
  rin_worker_oom: () => "Rin's background worker ran out of memory.",
  rin_worker_failed: () =>
    "Rin's background worker failed before the request finished.",
  rin_windows_daemon_cross_user_unsupported: () =>
    "Rin cannot control another Windows user's daemon from this session.",
  rin_windows_daemon_pid_missing: () =>
    "Rin found a Windows daemon socket but could not find its process id.",

  rpc_turn_already_active: () =>
    "Rin already has a turn in progress for this session.",
  rpc_turn_failed: () => "Rin failed while running the remote turn.",
  rin_turn_recovery_in_progress: () =>
    "Rin is still recovering the previous turn for this session.",
  rin_turn_request_tag_required: () =>
    "Rin could not start the turn because its durable request identity is missing.",
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
