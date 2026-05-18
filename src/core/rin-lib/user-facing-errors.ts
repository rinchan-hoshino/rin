const INTERNAL_RUNTIME_ERROR_RE =
  /^((?:[a-z][a-z0-9]*_)+[a-z0-9]+)(?::\s*(.*))?$/;

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

const USER_FACING_RUNTIME_ERRORS: Record<string, (detail: string) => string> = {
  new_session_session_file_unsupported: () =>
    "Could not start a new chat session because the command was bound to a replied message's old session. Retry /new; chat commands should not use replied-message sessions.",
  frontend_model_not_found: (detail) =>
    `Model not found${detail ? `: ${detail}` : ""}. Choose an available model in /model or settings.`,
  unknown_model: (detail) =>
    `Model not found${detail ? `: ${detail}` : ""}. Choose an available model in /model or settings.`,
  invalid_model: (detail) =>
    `Invalid model${detail ? `: ${detail}` : ""}. Choose an available model in /model or settings.`,
  invalid_model_ref: (detail) =>
    `Invalid model${detail ? `: ${detail}` : ""}. Use provider/model format or choose a model from /model.`,
  rin_request_failed: () =>
    "Rin request failed. Retry the command; if it repeats, run rin doctor.",
  rin_timeout: (detail) =>
    `Rin timed out while ${describeRuntimeOperation(detail)}. Retry the action; if it repeats, restart Rin and try again.`,
  rin_disconnected: () =>
    "Rin lost its connection to the background runtime. Retry the action; if it repeats, restart Rin.",
  rin_tui_not_connected: () =>
    "Rin is not connected to an interactive session yet. Start or reconnect the Rin interface, then retry.",
  rin_no_attached_session: () =>
    "Rin could not find a session attached to this chat command. Start a new chat session with /new, then retry the command.",
  rin_worker_exit: () =>
    "Rin's background worker exited before the request finished. Retry the action; if it repeats, restart Rin and try again.",
  rin_worker_failed: () =>
    "Rin's background worker failed before the request finished. Retry the action; if it repeats, restart Rin and try again.",
  rin_session_recovering: () =>
    "Rin is still recovering the session after a disconnect or restart. Wait a moment, then retry.",
  rin_daemon_unavailable: (detail) =>
    `Rin's background service is not available${detail ? `: ${detail}` : ""}. Start or restart Rin, then retry.`,
  rin_daemon_shutting_down: () =>
    "Rin is shutting down right now. Wait until it starts again, then retry.",
  rin_daemon_failed: () =>
    "Rin's background service failed to start. Run rin doctor or restart Rin to inspect the problem.",
  frontend_session_not_connected: () =>
    "Rin is not connected to a session yet. Reconnect or start a new session, then retry.",
  frontend_turn_driver_disposed: () =>
    "Rin stopped the previous chat driver while recovering. Retry the action now.",
  chat_frontend_driver_disposed: () =>
    "Rin stopped the chat driver while recovering. Retry the action now.",
  chat_controller_disposed: () =>
    "Rin restarted the chat controller while handling this message. Retry the action now.",
  rpc_turn_final_output_missing: () =>
    "Rin finished the turn but did not receive a final reply. Retry the action; if it repeats, restart Rin.",
  chat_command_failed: () =>
    "Rin could not run that chat command. Retry it; if it repeats, restart Rin.",
  chat_command_text_missing: () =>
    "Rin ran the chat command, but it returned no reply text. Retry it; if it repeats, restart Rin.",
};

const UNKNOWN_INTERNAL_ERROR_MESSAGE =
  "Rin hit an internal runtime problem before it could finish. Retry the action; if it repeats, run rin doctor and check the logs.";

export function rawErrorMessage(error: unknown) {
  return String((error as any)?.message || error || "").trim();
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
  return message;
}
