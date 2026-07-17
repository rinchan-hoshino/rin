import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const errors = await import(
  pathToFileURL(path.resolve("dist/core/rin-lib/user-facing-errors.js")).href
);

const OWNED_MARKERS = `
chat_accepted_inbound_turn_not_active
chat_bridge_at_id_required
chat_bridge_chat_required
chat_bridge_entry_missing
chat_bridge_send_empty
chat_command_failed
chat_command_text_missing
chat_controller_key_required
chat_controller_disposed
chat_final_assistant_text_missing
chat_inbox_chatKey_required
chat_inbox_messageId_required
chat_message_id_required
chat_reaction_emoji_required
chat_key_required
chat_message_store_chatKey_required
chat_message_store_messageId_required
chat_outbox_delivery_missing
chat_outbox_delivery_pending
chat_outbox_empty_message
chat_outbox_idempotency_collision
chat_outbox_invalid_json
chat_outbox_invalid_payload
chat_outbox_invalid_part
chat_restored_session_mismatch
chat_send_at_id_required
chat_send_message_empty_result
chat_text_required
chat_turn_aborted
agent_practices_fetch_failed
agent_practices_fetch_unavailable
cron_chat_unavailable
cron_final_assistant_text_missing
cron_frontend_key_required
cron_invalid_agent_task
cron_invalid_expression
cron_invalid_session_continue_task
cron_invalid_shell_task
cron_next_run_not_found
cron_prompt_required
cron_session_file_not_found
cron_session_file_required
cron_session_continue_frontend_forbidden
cron_session_continue_requires_session
cron_session_continue_requires_target
cron_session_continue_unavailable
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
final_assistant_text_missing
frontend_model_not_found
frontend_session_not_connected
frontend_session_restore_mismatch
frontend_compaction_timeout
frontend_turn_already_running
identity_first_owner_must_self_claim
identity_last_owner_required
identity_owner_bootstrap_required
identity_owner_required
identity_platform_required
identity_user_id_required
invalid_chatKey
invalid_json
invalid_practices_manifest
invalid_practices_manifest_path
invalid_model
invalid_model_ref
lark_app_id_required
lark_app_secret_required
lark_reaction_emoji_required
lark_send_message_empty
maintenance_job_failed
maintenance_job_invalid_input
maintenance_job_invalid_payload
managed_new_session_unsupported
minecraft_not_connected
minecraft_send_message_empty
minecraft_url_required
invalid_self_improve_interval
invalid_status_interval
invalid_status_limit
invalid_status_offset
missing_self_improve_interval
missing_status_interval
missing_status_limit
missing_status_offset
new_session_session_file_unsupported
oauth_login_failed
oauth_provider_id_required
onebot_disconnected
onebot_endpoint_required
onebot_not_connected
onebot_reaction_emoji_unsupported
onebot_reaction_requires_group_chat
onebot_send_message_empty
onebot_send_message_empty_result
background_extension_entrypoint_missing
rin_agent_sdk_task_id_required
rin_app_cli_failed
rin_app_daemon_failed
rin_app_daemon_services_failed
rin_app_install_failed
rin_app_tui_failed
rin_app_worker_failed
rin_beta_selector_not_supported
rin_command_failed
rin_duplicate_command_id
rin_installer_fd_install_dir_missing
rin_installer_fd_manager_unavailable
rin_container_name_required
rin_daemon_failed
rin_daemon_shutting_down
rin_daemon_unavailable
rin_desktop_host_failed
rin_digitalocean_ssh_key_not_found
rin_disconnected
rin_gui_failed
rin_gui_unrecognized_arg
rin_install_temp_dir_unavailable
rin_elevated_install_unsupported_on_windows
rin_installed_daemon_entry_missing
rin_installer_apply_result_missing
rin_installer_gui_command_failed
rin_installer_gui_disabled
rin_installer_gui_install_dir_required
rin_installer_gui_model_required
rin_installer_gui_provider_required
rin_installer_gui_token_required
rin_installer_gui_unrecognized_arg
rin_launchd_daemon_stop_incomplete
rin_launchd_restart_failed
rin_launchd_target_user_not_found
rin_daemon_restart_not_ready
rin_managed_service_action_failed
rin_managed_service_missing
rin_managed_service_missing_path
rin_managed_service_unsupported
rin_managed_node_runtime_missing
rin_missing_required_tool
rin_missing_settings_manager
rin_native_gui_command_failed
rin_native_gui_missing_session
rin_native_gui_settings_path_missing
rin_new_session_cancelled
rin_nightly_selector_not_supported
rin_no_attached_session
rin_release_branch_and_version_conflict
rin_release_channel_conflict
rin_release_not_found
rin_request_failed
rin_quick_run_daemon_already_running
rin_quick_run_daemon_exited
rin_quick_run_daemon_not_ready
rin_quick_run_install_dir_missing
rin_quick_run_update_not_supported
rin_rollback_no_previous_release
rin_rollback_target_is_current
rin_session_file_required
rin_session_recovering
rin_session_worker_unavailable
rin_service_install_unsupported
rin_stable_branch_not_supported
rin_stable_selector_not_supported
rin_ssh_not_ready
rin_target_name_required
rin_target_not_found
rin_target_register_local_user_usage
rin_timeout
rin_tui_disposed
rin_tui_failed
rin_update_installed_release_channel_missing
rin_update_platform_bundle_checksum_missing
rin_update_platform_bundle_checksum_mismatch
rin_tui_not_connected
rin_wait_for_idle_timeout
rin_worker_cleanup_failed
rin_worker_exit
rin_worker_oom
rin_worker_failed
rin_windows_daemon_cross_user_unsupported
rin_windows_daemon_pid_missing
rpc_turn_already_active
rpc_turn_failed
rpc_turn_final_output_missing
rin_turn_recovery_in_progress
rin_turn_request_tag_required
rin_turn_result_invariant_failed
rin_turn_result_recovery_timeout
run_managed_session_value_required
run_mode_value_required
run_name_unsupported
run_prompt_required
run_session_conflict
recall_aborted
self_improve_content_required
session_file_required
session_fork_unsupported
run_chat_key_not_supported_in_print_mode
slack_app_token_required
slack_bot_token_required
slack_reaction_emoji_required
slack_send_message_empty
telegram_api_failed
telegram_media_source_missing
telegram_send_message_empty
telegram_token_required
unknown_model
unknown_docs_internal_command
unknown_run_option
web_fetch_invalid_url
fetch_failed
unknown_error
`
  .trim()
  .split(/\s+/);

test("every owned runtime marker has a human-facing formatter", () => {
  assert.equal(OWNED_MARKERS.length, 220);
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
    errors.formatRuntimeErrorForChat("rin_request_failed"),
    "rin error: request failed",
  );
  assert.equal(
    errors.formatRuntimeErrorForChat("rin error: kept"),
    "rin error: kept",
  );
});
