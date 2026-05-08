import { safeString } from "./chat-helpers.js";

const TRANSIENT_CHAT_RUNTIME_ERROR_RE =
  /rin_timeout:|rin_disconnected:|rin_tui_not_connected|chat_controller_disposed|chat_frontend_driver_disposed|frontend_turn_driver_disposed|rin_worker_exit:|chat_turn_stale|WebSocket (?:closed|error)\b|connect (?:ENOENT|ECONNREFUSED|ECONNRESET|EPIPE)\b|socket hang up|write EPIPE/;

const INTERNAL_CHAT_RUNTIME_ERROR_RE =
  /^(?:[a-z][a-z0-9]*_)+[a-z0-9]+(?::\S+)?$/;

export function isTransientChatRuntimeError(error: unknown) {
  return TRANSIENT_CHAT_RUNTIME_ERROR_RE.test(
    safeString((error as any)?.message || error),
  );
}

export function formatChatRuntimeErrorForUser(error: unknown) {
  const message = safeString((error as any)?.message || error).trim();
  if (!message) return "Rin hit an internal chat error. Please retry.";
  if (INTERNAL_CHAT_RUNTIME_ERROR_RE.test(message)) {
    return "Rin hit an internal chat error. Please retry, or ask the owner to check the logs.";
  }
  return message;
}
