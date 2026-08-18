import os from "node:os";
import * as nodeUtil from "node:util";

import { Errno, strerror } from "kerium";

import { rawErrorMessage } from "../rin-lib/error-facts.js";

export { rawErrorMessage } from "../rin-lib/error-facts.js";

const INTERNAL_RUNTIME_ERROR_RE =
  /^([a-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+)(?::\s*(.*))?$/;

const UNKNOWN_SYSTEM_ERROR_RE = /\bUnknown system error\s+(-?\d+)\b/i;
const UNKNOWN_SYSTEM_ERROR_SYSCALL_RE =
  /\bUnknown system error\s+-?\d+(?::[^,\n]*)?,\s*([A-Za-z][A-Za-z0-9_]*)\b/i;
const FRONTEND_RUNTIME_ERROR_PREFIX_RE = /^(?:(?:rin\s+)?error:\s*)+/i;
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
  transcript_archive_install_manifest_invalid: () =>
    "The transcript archive migration manifest is invalid.",
  transcript_archive_install_staging_path_invalid: () =>
    "The staged transcript archive path is invalid.",
  transcript_archive_install_backup_manifest_invalid: () =>
    "The transcript archive migration backup manifest is invalid.",
  transcript_archive_install_live_path_invalid: () =>
    "The live transcript archive path is invalid.",
  transcript_archive_install_publish_guard_missing: () =>
    "The transcript archive migration lost its publish guard.",
  transcript_archive_install_migration_incomplete: () =>
    "The Rin installer could not finish upgrading the transcript archive.",
  transcript_archive_install_target_path_invalid: () =>
    "The transcript archive migration target path is invalid.",
  transcript_archive_install_source_path_invalid: () =>
    "The transcript archive migration source path is invalid.",
  transcript_archive_install_target_not_empty: () =>
    "The transcript archive migration target is not empty.",
  transcript_archive_install_unknown_corruption: (detail) =>
    withDetail(
      "Transcript archive migration found unexplained malformed data",
      detail,
    ),
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
  chat_command_recovery_requires_durable_result: () =>
    "Chat is still waiting for the command's durable result.",
  chat_command_text_missing: () =>
    "Rin ran the chat command, but it returned no reply text.",
  chat_controller_key_required: () =>
    "Chat controller setup is missing a controller key. Recreate the chat binding.",
  chat_controller_disposed: () =>
    "Rin restarted the chat controller while handling this message.",
  chat_database_admission_model_incomplete: () =>
    "The chat database update migration did not complete.",
  chat_database_chatKey_required: () =>
    "Chat database access failed because the chat key is missing.",
  chat_database_future_schema: (detail) =>
    withDetail("The chat database was created by a newer Rin version", detail),
  chat_database_incomplete_schema: () =>
    "The chat database schema is incomplete.",
  chat_database_partial_schema: () =>
    "The chat database contains a partial schema.",
  chat_database_foreign_key_mismatch: () =>
    "The chat database has invalid record relationships.",
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
  chat_database_canonical_run_drain_required: (detail) =>
    withDetail("Rin update is waiting for active chat runs to finish", detail),
  chat_database_canonical_run_upgrade_failed: (detail) =>
    withDetail("Rin could not upgrade canonical chat run storage", detail),
  chat_database_invalid_canonical_reconciliation_state: () =>
    "Rin found invalid canonical chat reconciliation state.",
  chat_terminal_recovery_invalid_event: () =>
    "Rin quarantined a completed chat turn with an invalid event.",
  chat_terminal_recovery_invalid_payload: () =>
    "Rin quarantined a completed chat turn with an invalid payload.",
  chat_terminal_turn_mismatch: () =>
    "The terminal journal does not match its transport turn.",
  chat_terminal_invalid_delivery_kind: () =>
    "Rin rejected an invalid terminal delivery kind.",
  chat_terminal_delivery_mismatch: () =>
    "The terminal record does not match the current transport turn.",
  chat_inbox_chatKey_required: () =>
    "Chat inbox write failed because the chat key is missing. Check the adapter event.",
  chat_inbox_messageId_required: () =>
    "Chat inbox write failed because the message id is missing. Check the adapter event.",
  chat_inbox_claim_required: () =>
    "Chat inbox update failed because its processing claim is missing.",
  chat_inbox_claim_lost_during_admission: () =>
    "Chat inbox ownership changed while committing the admission result.",
  chat_inbox_admission_required: () =>
    "Chat inbox recovery could not find a committed admission result.",
  chat_inbox_admission_identity_mismatch: () =>
    "Chat inbox admission does not match its durable turn identity.",
  chat_inbox_message_commit_failed: () =>
    "Chat inbox write failed while committing the inbound message.",
  chat_inbox_message_identity_required: () =>
    "Chat inbox write failed because the inbound message identity is incomplete.",
  chat_inbox_turn_commit_failed: () =>
    "Chat inbox write failed while committing the turn ledger.",
  chat_database_migration_active_legacy_turn: () =>
    "Rin update cannot continue while a chat turn from the current version is still active.",
  chat_database_migration_canonical_reconciliation_backup_exists: (detail) =>
    withDetail("Rin found an existing canonical reconciliation backup", detail),
  chat_database_migration_canonical_reconciliation_binding_remains: (detail) =>
    withDetail(
      "Rin could not retire a stale canonical chat session binding",
      detail,
    ),
  chat_database_migration_install_dir_required: () =>
    "Chat migration needs the target Rin install directory.",
  chat_database_migration_invalid_accepted_orphan: () =>
    "Chat migration found an accepted legacy message with incomplete identity.",
  memory_install_migration_install_dir_required: () =>
    "Memory migration needs the target Rin install directory.",
  memory_install_migration_runtime_required: () =>
    "Memory migration needs the staged Rin runtime before installation can continue.",
  memory_install_migration_mode_invalid: (detail) =>
    withDetail("Memory migration received an invalid mode", detail),
  memory_install_migration_failed: () =>
    "The Rin installer could not complete memory migration.",
  memory_install_migration_prepare_incomplete: () =>
    "The Rin installer could not prepare all memory migration payloads.",
  memory_install_migration_publish_state_inconsistent: () =>
    "Memory migration found inconsistent published payload state.",
  memory_install_migration_runtime_not_quiesced: () =>
    "Memory migration requires the Rin runtime to be fully stopped.",
  chat_database_migration_invalid_session_state: (detail) =>
    withDetail("Chat migration found invalid legacy session state", detail),
  chat_database_migration_session_state_read_failed: (detail) =>
    withDetail("Chat migration could not read legacy session state", detail),
  chat_database_migration_invalid_settings: (detail) =>
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
    "Chat message store write failed because the chat key is missing. Check the adapter event.",
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
  chat_outbox_invalid_nonterminal_error: () =>
    "Chat progress error is missing its active turn owner.",
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
  chat_turn_busy: () => "This chat is still processing another turn.",
  frontend_turn_busy: () => "This session is still processing another turn.",
  frontend_turn_interrupted: () => "The active turn was interrupted.",
  frontend_turn_request_tag_missing: () =>
    "The frontend turn is missing its durable request identity.",
  rin_frontend_disconnected: () =>
    "Rin is disconnected. Reconnect before submitting another turn.",
  chat_terminal_record_missing: () =>
    "Rin did not receive an authoritative terminal record for this turn.",
  chat_turn_fence_lost: () =>
    "The chat turn expired before its reply could be committed. Rin will use the current turn owner.",
  chat_turn_id_required: () =>
    "Chat turn update failed because the turn id is missing.",
  chat_turn_owner_epoch_required: () =>
    "Chat turn update failed because the owner fence is missing.",
  chat_turn_request_tag_missing: () =>
    "Chat turn recovery failed because its durable request identity is missing.",

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

  command_model_not_found: modelNotFound,
  command_model_usage: () => "Usage: /model <provider/model> [thinking-level].",
  command_session_not_found: (detail) =>
    withDetail("Session not found", detail),
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

  maintenance_job_failed: () =>
    "Maintenance job failed. Check the maintenance log.",
  maintenance_job_invalid_input: () =>
    "Maintenance job input is invalid. Recreate the job.",
  maintenance_job_invalid_payload: () =>
    "Maintenance job payload is invalid. Recreate the job.",
  managed_new_session_unsupported: () =>
    "This managed session cannot create a new session through that path. Use /new or the session menu instead.",

  invalid_self_improve_interval: () =>
    "Self-improve live view needs a positive refresh interval.",
  self_improve_audit_invalid_policy: () =>
    "Self-improve audit settings are invalid.",
  self_improve_audit_invalid_timestamp: () =>
    "Self-improve audit received an invalid run timestamp.",
  self_improve_audit_symlink_path: () =>
    "Self-improve audit rejected a symbolic-link path outside its trusted storage boundary.",
  self_improve_audit_path_outside_agent_dir: () =>
    "Self-improve audit rejected an unsafe evidence path.",
  self_improve_audit_capture_mismatch: () =>
    "Self-improve audit capture does not belong to this agent directory.",
  self_improve_audit_artifact_invalid: () =>
    "Self-improve audit evidence is incomplete or corrupt.",
  self_improve_audit_history_corrupt: () =>
    "Self-improve audit history is incomplete or corrupt; refusing to append evidence.",
  self_improve_maintenance_lock_timeout: () =>
    "Self-improve maintenance stayed busy and this run could not start safely.",
  self_improve_maintenance_lock_required: () =>
    "Self-improve mutation requires the shared maintenance lock.",
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

  rin_system_prompt_owner_unavailable: () =>
    "Rin could not bind the session's system prompt owner. Reload Rin; if this persists, repair the runtime installation.",
  rin_context_transform_owner_unavailable: () =>
    "Rin could not bind the session context transformer. Reload Rin; if this persists, repair the runtime installation.",
  rin_compaction_owner_unavailable: () =>
    "Rin could not bind the session compaction owner. Reload Rin; if this persists, repair the runtime installation.",

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
  rin_container_image_invalid: () =>
    "Container target needs a valid image reference.",
  rin_container_name_required: () =>
    "Target operation needs a container name. Provide the container name.",
  rin_daemon_failed: () => "Rin's background service failed to start.",
  rin_daemon_worker_entrypoint_required: () =>
    "Rin daemon needs its app-owned worker entrypoints before it can start.",
  rin_daemon_lock_owner_pending: () =>
    "Rin found incomplete background-service ownership state and stopped safely.",
  rin_daemon_lock_release_identity_changed: () =>
    "Rin stopped safely because background-service ownership changed during release.",
  rin_daemon_recovering: () =>
    "Rin's background service is still recovering active turns and cannot accept new work yet.",
  rin_daemon_update_in_progress: () =>
    "Rin's background service is paused while an update is in progress.",
  rin_daemon_shutting_down: () =>
    "Rin is shutting down right now. Wait until it starts again.",
  rin_daemon_unavailable: (detail) =>
    withDetail("Rin's background service is not available", detail, "."),
  rin_disconnected: () => "Rin lost its connection to the background runtime.",
  rin_install_temp_dir_unavailable: () =>
    "Rin installer could not create a temporary directory. Check disk permissions.",
  rin_current_release_missing: (detail) =>
    withDetail("Rin update could not find the current release", detail, "."),
  rin_current_release_replacement_requires_staging: () =>
    "Rin update cannot safely replace the running release before staging it.",
  rin_elevated_install_unsupported_on_windows: () =>
    "Rin cannot install for another Windows user from this installer session.",
  rin_invalid_runtime_replacement_paths: () =>
    "Rin update prepared invalid runtime replacement paths.",
  rin_replaced_release_backup_missing: (detail) =>
    withDetail("Rin update could not find its release backup", detail, "."),
  rin_runtime_replacement_path_unavailable: (detail) =>
    withDetail(
      "Rin update could not reserve a runtime replacement path",
      detail,
      ".",
    ),
  rin_staged_release_missing: (detail) =>
    withDetail("Rin update could not find its staged release", detail, "."),
  rin_system_user_creation_unsupported: (detail) =>
    withDetail("Rin cannot create a system user on this platform", detail, "."),
  rin_system_user_creation_unverified: () =>
    "Rin could not verify the new system user after creating it.",
  rin_system_user_name_invalid: () =>
    "New system user needs a valid Linux username.",
  rin_system_useradd_unavailable: () =>
    "Rin could not find the Linux useradd command needed to create the system user.",
  rin_systemd_linger_enable_failed: (detail) =>
    withDetail(
      "Rin could not enable the persistent Linux user service",
      detail,
      ".",
    ),
  rin_installed_daemon_entry_missing: () =>
    "Rin install is missing the daemon entrypoint. Reinstall or update Rin.",
  rin_installer_apply_result_missing: () =>
    "Rin installer did not return an install result.",
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
  rin_managed_service_symlink_refused: () =>
    "Rin left the managed service link unchanged because its ownership could not be verified.",
  rin_managed_service_unsupported: () =>
    "This Rin install does not support that lifecycle command on this platform.",
  rin_systemd_legacy_hold_ambiguous: () =>
    "Rin found an ambiguous legacy service hold and left it unchanged.",
  rin_systemd_legacy_hold_invalid_result: () =>
    "Rin could not verify the legacy service hold recovery result.",
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
  rin_target_name_required: () =>
    "Target command needs a target name. Provide the target name.",
  rin_target_not_found: (detail) =>
    withDetail(
      "Rin target was not found",
      detail,
      ". Choose an existing target.",
    ),
  rin_target_unsupported: (detail) =>
    withDetail(
      "Rin target mode is no longer supported",
      detail,
      ". Use a local-user, SSH, or container target.",
    ),
  rin_target_register_local_user_usage: () =>
    "Registering a local target needs both a target name and a user. Provide both.",
  rin_timeout: (detail) =>
    `Rin timed out while ${describeRuntimeOperation(detail)}.`,
  rin_tui_disposed: () => "Rin TUI session has already closed. Reopen Rin.",
  rin_tui_failed: () => "Rin TUI failed before it could start.",
  rin_update_composite_fence_release_failed: () =>
    "Rin update could not release all background-service maintenance locks.",
  rin_update_daemon_stop_incomplete: () =>
    "Rin update stopped because the background service did not shut down.",
  rin_update_fence_check_args_missing: () =>
    "Rin could not check the background-service maintenance fence.",
  rin_update_fence_holder_acquire_missing: () =>
    "Rin update could not establish the background-service maintenance fence.",
  rin_update_fence_holder_exit_timeout: () =>
    "Rin update could not release the background-service maintenance fence.",
  rin_update_fence_holder_exited: () =>
    "Rin update could not establish the background-service maintenance fence.",
  rin_update_fence_holder_invalid_ready: () =>
    "Rin update could not verify the background-service maintenance fence.",
  rin_update_fence_holder_ready_timeout: () =>
    "Rin update could not establish the background-service maintenance fence.",
  rin_update_fence_holder_lost: () =>
    "Rin update stopped immediately because background-service maintenance ownership was lost.",
  rin_update_fence_holder_release_failed: () =>
    "Rin update could not release the background-service maintenance fence.",
  rin_update_fence_release_failed: () =>
    "Rin update could not release the background-service maintenance fence after retrying.",
  rin_update_failure_recovery_and_fence_release_failed: () =>
    "Rin update recovery failed and the background-service maintenance fence could not be released cleanly.",
  rin_update_installed_release_channel_missing: () =>
    "Rin update could not find the installed release channel. Repair the installed release metadata before updating.",
  rin_update_job_authorization_required: () =>
    "Rin's internal update payload requires an authorized update job. Run `rin update` instead.",
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
  rin_execution_plane_exit: () =>
    "Rin's session execution process exited before the request finished.",
  rin_execution_plane_session_unknown: () =>
    "Rin could not recover the blocked session because its durable session file is unknown.",
  rin_execution_plane_startup_timeout: () =>
    "Rin's session execution process did not become ready in time.",
  rin_execution_plane_stdin_unavailable: () =>
    "Rin could not send the request to the session execution process.",
  rin_execution_plane_unavailable: () =>
    "Rin's session execution process is unavailable.",
  rin_turn_ledger_agent_dir_required: () =>
    "Rin could not open its turn lifecycle ledger.",
  rin_turn_ledger_begin_conflict: () =>
    "Rin rejected conflicting lifecycle ownership for this turn.",
  rin_turn_ledger_chat_key_required: () =>
    "Rin cannot route this turn because its chat target is missing.",
  rin_turn_ledger_interrupt_failed: () =>
    "Rin could not durably interrupt the active turn because the lifecycle ledger is unavailable.",
  rin_turn_ledger_interrupt_reason_required: () =>
    "Rin could not record why this turn was interrupted.",
  rin_turn_ledger_message_id_required: () =>
    "Rin cannot route this turn because its message identity is missing.",
  rin_turn_ledger_newer_schema: () =>
    "This Rin installation cannot read the newer turn lifecycle ledger.",
  rin_turn_ledger_record_missing: () =>
    "Rin could not find the authoritative lifecycle record for this turn.",
  rin_turn_ledger_request_tag_required: () =>
    "Rin cannot identify this turn request.",
  rin_turn_ledger_terminal_conflict: () =>
    "Rin rejected conflicting terminal outcomes for this turn.",
  rin_turn_ledger_terminal_record_failed: () =>
    "Rin could not durably record the turn result because the lifecycle ledger is unavailable.",
  rin_turn_ledger_terminal_id_mismatch: () =>
    "Rin rejected an acknowledgement for a different terminal outcome.",
  rin_turn_ledger_terminal_id_required: () =>
    "Rin cannot acknowledge a terminal outcome without its identity.",
  rin_turn_ledger_terminal_kind_mismatch: () =>
    "Rin rejected an invalid terminal outcome kind.",
  rin_turn_ledger_terminal_missing: () =>
    "Rin could not find a durable terminal outcome for this turn.",
  rin_turn_ledger_terminal_request_mismatch: () =>
    "Rin rejected a terminal outcome for a different request.",
  rin_turn_ledger_terminal_request_tag_required: () =>
    "Rin rejected a terminal outcome without a request identity.",
  rin_turn_ledger_turn_id_required: () =>
    "Rin cannot route this turn because its transport identity is missing.",
  rin_windows_daemon_cross_user_unsupported: () =>
    "Rin cannot control another Windows user's daemon from this session.",
  rin_windows_daemon_pid_missing: () =>
    "Rin found a Windows daemon socket but could not find its process id.",

  rpc_turn_already_active: () =>
    "Rin already has a turn in progress for this session.",
  rpc_turn_failed: () => "Rin failed while running the remote turn.",
  rin_turn_in_progress: () =>
    "Rin already has another accepted turn in progress for this session.",
  rin_turn_admission_pending: () => "Rin is still durably accepting this turn.",
  rin_prompt_outcome_invalid: () =>
    "Rin could not verify Pi's native lifecycle outcome.",
  rin_prompt_outcome_indeterminate: () =>
    "Rin could not durably determine this input's lifecycle outcome.",
  rin_prompt_task_missing: () =>
    "Rin observed the input lifecycle but could not retain its Pi task.",
  rin_turn_request_tag_required: () =>
    "Rin could not start the turn because its durable request identity is missing.",
  rin_turn_recovery_not_started: () =>
    "Rin is still waiting to continue the active turn.",
  rin_turn_recovery_session_busy: () =>
    "Rin found another active turn owning the recovery session.",
  rin_turn_recovery_session_missing: () =>
    "Rin could not restore the active turn because its session file is missing.",
  rin_turn_settled_without_terminal: () =>
    "Rin could not determine the completed turn result.",
  rin_turn_terminal_conflict: () =>
    "Rin found conflicting terminal results for the same turn.",

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
  const rawMessage = rawErrorMessage(error);
  const message = rawMessage
    .replace(FRONTEND_RUNTIME_ERROR_PREFIX_RE, "")
    .trim();
  if (!message) return "unknown error";
  return formatRuntimeMarkerForFrontendDisplay(message);
}

/** Matches Pi TUI's native `showError` output while sharing its error body. */
export function formatRuntimeErrorForFrontend(error: unknown) {
  return `Error: ${formatRuntimeErrorForFrontendDisplay(error)}`;
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
