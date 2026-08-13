import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const errors = await import(
  pathToFileURL(path.resolve("dist/core/rin-lib/user-facing-errors.js")).href
);

const OWNED_MARKERS = `daemon_extension_entrypoint_missing
chat_accepted_inbound_turn_not_active
chat_archive_header_compare_and_swap_failed
chat_archive_hot_delete_failed
chat_archive_hot_payload_missing
chat_archive_message_identity_required
chat_archive_message_still_operational
chat_archive_messages_required
chat_archive_payload_hash_mismatch
chat_archive_payload_locator_mismatch
chat_archive_reingest_requires_restore
chat_archive_rollback_header_mismatch
chat_archive_segment_checksum_mismatch
chat_archive_segment_count_mismatch
chat_archive_segment_hash_mismatch
chat_archive_segment_integrity_failed
chat_archive_segment_missing
chat_archive_segment_not_committed
chat_archive_segment_reservation_lost
chat_archive_single_period_required
chat_bridge_at_id_required
chat_bridge_chat_required
chat_bridge_entry_missing
chat_bridge_send_empty
chat_bridge_unavailable
chat_command_failed
chat_command_recovery_requires_durable_result
chat_command_text_missing
chat_controller_disposed
chat_controller_key_required
chat_database_admission_model_incomplete
chat_database_canonical_run_drain_required
chat_database_canonical_run_upgrade_failed
chat_database_chatKey_required
chat_database_foreign_key_mismatch
chat_database_future_schema
chat_database_incomplete_schema
chat_database_invalid_canonical_reconciliation_state
chat_database_partial_schema
chat_database_schema_fingerprint_mismatch
chat_database_schema_upgrade_required
chat_database_schema_version_mismatch
chat_database_unsupported_schema
chat_generation_nonterminal_send_in_flight
chat_inbox_admission_identity_mismatch
chat_inbox_admission_required
chat_inbox_chatKey_required
chat_inbox_claim_lost_during_admission
chat_inbox_claim_required
chat_inbox_messageId_required
chat_inbox_message_commit_failed
chat_inbox_message_identity_required
chat_inbox_turn_commit_failed
chat_install_migration_active_legacy_turn
chat_install_migration_canonical_reconciliation_backup_exists
chat_install_migration_canonical_reconciliation_binding_remains
chat_install_migration_install_dir_required
chat_install_migration_invalid_accepted_orphan
chat_install_migration_invalid_session_state
chat_install_migration_invalid_settings
chat_install_migration_session_state_read_failed
chat_key_migration_invalid_marker
chat_key_migration_invalid_marker_state
chat_key_migration_invalid_resolved_ledger
chat_key_migration_invalid_resolved_ledger_entry
chat_key_migration_marker_id_mismatch
chat_key_migration_resolved_ledger_collision
chat_key_required
chat_legacy_migration_archive_changed
chat_legacy_migration_archive_collision
chat_legacy_migration_invalid_inbox
chat_legacy_migration_invalid_inbox_chat_key
chat_legacy_migration_invalid_json
chat_legacy_migration_invalid_message_identity
chat_legacy_migration_invalid_message_timestamp
chat_legacy_migration_invalid_outbox
chat_legacy_migration_invalid_preserved_summary
chat_legacy_migration_invalid_timestamp
chat_legacy_migration_read_failed
chat_legacy_migration_source_changed
chat_legacy_migration_source_changed_during_import
chat_legacy_migration_source_recreated
chat_legacy_migration_unknown_state
chat_message_id_required
chat_message_store_chatKey_required
chat_message_store_messageId_required
chat_outbox_attempt_superseded
chat_outbox_claim_read_failed
chat_outbox_delivery_missing
chat_outbox_delivery_pending
chat_outbox_empty_message
chat_outbox_idempotency_collision
chat_outbox_invalid_json
chat_outbox_invalid_nonterminal_error
chat_outbox_invalid_part
chat_outbox_invalid_payload
chat_outbox_media_missing
chat_reaction_emoji_required
chat_restored_session_mismatch
chat_send_at_id_required
chat_send_message_empty_result
chat_terminal_delivery_mismatch
chat_terminal_invalid_delivery_kind
chat_terminal_record_missing
chat_terminal_recovery_invalid_event
chat_terminal_recovery_invalid_payload
chat_terminal_turn_mismatch
chat_text_required
chat_turn_busy
chat_turn_fence_lost
chat_turn_id_required
chat_turn_owner_epoch_required
chat_turn_request_tag_missing
cron_chat_unavailable
cron_frontend_key_required
cron_frontend_tui_unbindable
cron_invalid_agent_task
cron_invalid_expression
cron_invalid_shell_task
cron_invalid_target_kind
cron_next_run_not_found
cron_prompt_required
cron_target_required
cron_tasks_file_invalid
cron_trigger_required
discord_application_commands_unavailable
discord_channel_not_sendable
discord_send_message_empty
discord_send_message_empty_result
discord_token_required
external_chat_adapter_did_not_register_bot
external_chat_adapter_missing_createAdapter
external_chat_adapter_return_requires_adapter_and_bot
fetch_failed
frontend_compaction_timeout
frontend_model_not_found
frontend_session_not_connected
frontend_session_restore_mismatch
frontend_turn_already_running
frontend_turn_busy
frontend_turn_interrupted
frontend_turn_request_tag_missing
identity_first_owner_must_self_claim
identity_last_owner_required
identity_owner_bootstrap_required
identity_owner_required
identity_platform_required
identity_user_id_required
invalid_chatKey
invalid_json
invalid_model
invalid_model_ref
invalid_practices_manifest
invalid_practices_manifest_path
invalid_received_at
invalid_self_improve_interval
invalid_status_interval
invalid_status_limit
invalid_status_offset
lark_app_id_required
lark_app_secret_required
lark_reaction_emoji_required
lark_send_message_empty
maintenance_job_failed
maintenance_job_invalid_input
maintenance_job_invalid_payload
managed_new_session_unsupported
memory_install_migration_install_dir_required
memory_install_migration_runtime_required
missing_self_improve_interval
missing_status_interval
missing_status_limit
missing_status_offset
new_session_session_file_unsupported
oauth_login_failed
oauth_provider_id_required
onebot_disconnected
onebot_endpoint_required
onebot_file_source_empty
onebot_not_connected
onebot_reaction_emoji_unsupported
onebot_reaction_requires_group_chat
onebot_send_message_empty
onebot_send_message_empty_result
onebot_upload_file_empty_result
pi_prompt_shape_changed
recall_aborted
rin_agent_sdk_task_id_required
rin_app_cli_failed
rin_app_daemon_failed
rin_app_daemon_services_failed
rin_app_install_failed
rin_app_tui_failed
rin_app_worker_failed
rin_beta_selector_not_supported
rin_command_failed
rin_container_name_required
rin_current_release_missing
rin_current_release_replacement_requires_staging
rin_daemon_failed
rin_daemon_lock_owner_pending
rin_daemon_lock_release_identity_changed
rin_daemon_recovering
rin_daemon_restart_not_ready
rin_daemon_shutting_down
rin_daemon_unavailable
rin_daemon_update_in_progress
rin_disconnected
rin_duplicate_command_id
rin_elevated_install_unsupported_on_windows
rin_frontend_disconnected
rin_install_temp_dir_unavailable
rin_installed_daemon_entry_missing
rin_installer_apply_result_missing
rin_installer_fd_install_dir_missing
rin_installer_fd_manager_unavailable
rin_invalid_runtime_replacement_paths
rin_launchd_daemon_stop_incomplete
rin_launchd_restart_failed
rin_launchd_target_user_not_found
rin_managed_node_npm_missing
rin_managed_node_runtime_missing
rin_managed_npm_cache_write_failed
rin_managed_npm_checksum_mismatch
rin_managed_service_action_failed
rin_managed_service_missing
rin_managed_service_missing_path
rin_managed_service_symlink_refused
rin_managed_service_unsupported
rin_missing_required_tool
rin_missing_settings_manager
rin_new_session_cancelled
rin_nightly_selector_not_supported
rin_no_attached_session
rin_prompt_outcome_indeterminate
rin_prompt_outcome_invalid
rin_prompt_task_missing
rin_quick_run_daemon_already_running
rin_quick_run_daemon_exited
rin_quick_run_daemon_not_ready
rin_quick_run_install_dir_missing
rin_quick_run_update_not_supported
rin_release_branch_and_version_conflict
rin_release_channel_conflict
rin_release_not_found
rin_replaced_release_backup_missing
rin_request_failed
rin_rollback_no_previous_release
rin_rollback_target_is_current
rin_runtime_replacement_path_unavailable
rin_service_install_unsupported
rin_session_file_required
rin_session_model_runtime_unavailable
rin_session_recovering
rin_session_worker_unavailable
rin_stable_branch_not_supported
rin_stable_selector_not_supported
rin_staged_release_missing
rin_systemd_legacy_hold_ambiguous
rin_systemd_legacy_hold_invalid_result
rin_target_name_required
rin_target_not_found
rin_target_register_local_user_usage
rin_target_unsupported
rin_timeout
rin_tui_disposed
rin_tui_failed
rin_tui_not_connected
rin_turn_admission_pending
rin_turn_in_progress
rin_turn_ledger_agent_dir_required
rin_turn_ledger_begin_conflict
rin_turn_ledger_chat_key_required
rin_turn_ledger_interrupt_failed
rin_turn_ledger_interrupt_reason_required
rin_turn_ledger_message_id_required
rin_turn_ledger_newer_schema
rin_turn_ledger_record_missing
rin_turn_ledger_request_tag_required
rin_turn_ledger_terminal_conflict
rin_turn_ledger_terminal_id_mismatch
rin_turn_ledger_terminal_id_required
rin_turn_ledger_terminal_kind_mismatch
rin_turn_ledger_terminal_missing
rin_turn_ledger_terminal_record_failed
rin_turn_ledger_terminal_request_mismatch
rin_turn_ledger_terminal_request_tag_required
rin_turn_ledger_turn_id_required
rin_turn_recovery_not_started
rin_turn_recovery_session_busy
rin_turn_recovery_session_missing
rin_turn_request_tag_required
rin_turn_settled_without_terminal
rin_turn_terminal_conflict
rin_update_composite_fence_release_failed
rin_update_daemon_stop_incomplete
rin_update_failure_recovery_and_fence_release_failed
rin_update_fence_check_args_missing
rin_update_fence_holder_acquire_missing
rin_update_fence_holder_exit_timeout
rin_update_fence_holder_exited
rin_update_fence_holder_invalid_ready
rin_update_fence_holder_lost
rin_update_fence_holder_ready_timeout
rin_update_fence_holder_release_failed
rin_update_fence_release_failed
rin_update_installed_release_channel_missing
rin_update_job_authorization_required
rin_update_job_invalid
rin_update_launchd_user_domain_missing
rin_update_platform_bundle_checksum_mismatch
rin_update_platform_bundle_checksum_missing
rin_wait_for_idle_timeout
rin_windows_daemon_cross_user_unsupported
rin_windows_daemon_pid_missing
rin_worker_cleanup_failed
rin_worker_exit
rin_worker_failed
rin_worker_oom
rpc_turn_already_active
rpc_turn_failed
run_chat_key_not_supported_in_print_mode
run_managed_session_value_required
run_mode_value_required
run_name_unsupported
run_prompt_required
run_session_conflict
self_improve_audit_history_corrupt
self_improve_audit_invalid_policy
self_improve_audit_artifact_invalid
self_improve_audit_capture_mismatch
self_improve_audit_invalid_timestamp
self_improve_audit_path_outside_agent_dir
self_improve_audit_symlink_path
self_improve_content_required
self_improve_maintenance_lock_required
self_improve_maintenance_lock_timeout
session_file_required
session_fork_unsupported
slack_app_token_required
slack_bot_token_required
slack_reaction_emoji_required
slack_send_message_empty
telegram_api_failed
telegram_media_source_missing
telegram_send_message_empty
telegram_token_required
transcript_archive_missing
transcript_search_install_backup_manifest_invalid
transcript_search_install_migration_incomplete
transcript_search_install_migration_required
transcript_search_install_publish_guard_missing
transcript_search_install_staging_path_invalid
transcript_search_install_staging_schema_mismatch
unknown_error
unknown_model
unknown_run_option
web_fetch_invalid_url`
  .trim()
  .split(/\s+/);

test("every owned runtime marker has a human-facing formatter", () => {
  assert.equal(OWNED_MARKERS.length, 358);
  assert.equal(new Set(OWNED_MARKERS).size, OWNED_MARKERS.length);
  for (const marker of OWNED_MARKERS) {
    assert.equal(errors.hasUserFacingRuntimeErrorMapping(marker), true, marker);
    const output = errors.formatRuntimeErrorForUser(`${marker}: owner-detail`);
    assert.ok(output.length > 0, marker);
    assert.equal(output.includes(marker), false, `${marker}: ${output}`);
    assert.doesNotMatch(
      output,
      /\b[a-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/,
      `${marker}: ${output}`,
    );
  }
  assert.equal(errors.hasUserFacingRuntimeErrorMapping("not_owned"), false);
});

test("archive and migration marker families execute their dedicated mappings", () => {
  for (const marker of [
    "chat_archive_header_compare_and_swap_failed",
    "chat_archive_hot_delete_failed",
    "chat_archive_hot_payload_missing",
    "chat_archive_message_identity_required",
    "chat_archive_messages_required",
    "chat_archive_payload_hash_mismatch",
    "chat_archive_payload_locator_mismatch",
    "chat_archive_segment_checksum_mismatch",
    "chat_archive_segment_count_mismatch",
    "chat_archive_segment_missing",
    "transcript_archive_missing",
    "transcript_search_install_migration_required",
    "transcript_search_install_migration_incomplete",
    "transcript_search_install_backup_manifest_invalid",
    "chat_database_admission_model_incomplete",
    "chat_inbox_claim_lost_during_admission",
    "memory_install_migration_runtime_required",
  ]) {
    const output = errors.formatRuntimeErrorForUser(`${marker}: owner-detail`);
    assert.ok(output.length > 0, marker);
    assert.equal(output.includes(marker), false, marker);
  }
  assert.equal(
    errors.formatRuntimeErrorForFrontend("rin_request_failed"),
    "Error: request failed",
  );
});

test("parameterized marker families preserve useful detail", () => {
  const cases = [
    [
      "frontend_model_not_found: openai/owner-model",
      "Model not found: openai/owner-model. Choose an available model in /model or settings.",
    ],
    [
      "invalid_model: owner-model",
      "Invalid model: owner-model. Use provider/model format or choose a model from /model.",
    ],
    ["rin_timeout: prompt", "Rin timed out while submitting your message."],
    [
      "rin_timeout: get_session_snapshot",
      "Rin timed out while reading the current session.",
    ],
    ["rin_timeout: select_session", "Rin timed out while switching sessions."],
    [
      "rin_timeout: owner-operation",
      "Rin timed out while running the request.",
    ],
    [
      "rin_target_not_found: owner-target",
      "Rin target was not found: owner-target. Choose an existing target.",
    ],
    ["rin_command_failed", "Rin command failed. Check the command output."],
  ];
  for (const [input, expected] of cases) {
    assert.equal(errors.formatRuntimeErrorForUser(input), expected);
  }
});

test("error boundaries handle plain, embedded, empty, and system failures", () => {
  assert.equal(
    errors.rawErrorMessage({ message: " owner failure " }),
    "owner failure",
  );
  assert.equal(errors.rawErrorMessage(0), "");
  assert.equal(errors.formatRuntimeErrorForUser(null), "unknown error");
  assert.equal(
    errors.formatRuntimeErrorForUser("ordinary owner-visible failure"),
    "ordinary owner-visible failure",
  );
  assert.equal(
    errors.formatRuntimeErrorForUser("owner wrapper: fetch_failed"),
    "The network request failed.",
  );
  assert.equal(
    errors.formatRuntimeErrorForUser("unknown_owner_marker: detail"),
    "unknown owner marker: detail",
  );
  assert.match(
    errors.formatRuntimeErrorForUser(
      Object.assign(new Error("Unknown system error -122"), {
        errno: -122,
        syscall: "rename",
        path: "/tmp/from",
        dest: "/tmp/to",
      }),
    ),
    /^rename failed: EDQUOT: .* \(\/tmp\/from -> \/tmp\/to\)$/,
  );
  assert.match(
    errors.formatRuntimeErrorForUser(
      "Unknown system error -122: Unknown system error -122, write",
    ),
    /^write failed: EDQUOT:/,
  );
});

test("frontend and chat display boundaries keep terse marker details", () => {
  assert.equal(
    errors.formatRuntimeErrorForFrontendDisplay(""),
    "unknown error",
  );
  assert.equal(
    errors.formatRuntimeErrorForFrontendDisplay("rin_app_tui_failed"),
    "tui failed",
  );
  assert.equal(
    errors.formatRuntimeErrorForFrontendDisplay(
      "frontend_model_not_found: owner/model",
    ),
    "frontend model not found: owner/model",
  );
  assert.equal(
    errors.formatRuntimeErrorForFrontendDisplay(
      "frontend_model_not_found owner/model",
    ),
    "frontend model not found owner/model",
  );
  assert.equal(
    errors.formatRuntimeErrorForFrontendDisplay("ordinary failure"),
    "ordinary failure",
  );
  assert.equal(
    errors.formatRuntimeErrorForFrontend("rin_request_failed"),
    "Error: request failed",
  );
  assert.equal(
    errors.formatRuntimeErrorForFrontend("rin error: kept"),
    "Error: kept",
  );
});
