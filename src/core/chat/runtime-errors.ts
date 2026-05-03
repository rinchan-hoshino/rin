import { safeString } from "./chat-helpers.js";

const TRANSIENT_CHAT_RUNTIME_ERROR_RE =
  /rin_timeout:|rin_disconnected:|rin_tui_not_connected|chat_controller_disposed|chat_frontend_driver_disposed|rin_worker_exit:|chat_turn_stale|WebSocket (?:closed|error)\b|connect (?:ENOENT|ECONNREFUSED|ECONNRESET|EPIPE)\b|socket hang up|write EPIPE/;

export function isTransientChatRuntimeError(error: unknown) {
  return TRANSIENT_CHAT_RUNTIME_ERROR_RE.test(
    safeString((error as any)?.message || error),
  );
}
