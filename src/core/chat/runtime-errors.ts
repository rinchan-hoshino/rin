import {
  isRinFrontendTurnCancelledError,
  RIN_FRONTEND_TURN_CANCELLED,
} from "../rin-frontend-sdk/lifecycle-errors.js";
import { formatRuntimeErrorForChat } from "../rin-lib/user-facing-errors.js";
import { safeString } from "./chat-helpers.js";

const TRANSIENT_CHAT_RUNTIME_ERROR_RE =
  /rin_timeout:|rin_disconnected:|rin_tui_not_connected|chat_controller_disposed|rin_worker_exit(?::|\b)|chat_turn_stale|WebSocket (?:closed|error)\b|connect (?:ENOENT|ECONNREFUSED|ECONNRESET|EPIPE)\b|socket hang up|write EPIPE/;

export function isTransientChatRuntimeError(error: unknown) {
  if (isRinFrontendTurnCancelledError(error)) return true;
  return TRANSIENT_CHAT_RUNTIME_ERROR_RE.test(
    safeString((error as any)?.message || error),
  );
}

export function isSilentChatRuntimeRetryError(error: unknown) {
  return (
    isRinFrontendTurnCancelledError(error) ||
    safeString(error).trim() === RIN_FRONTEND_TURN_CANCELLED
  );
}

export function formatChatRuntimeErrorForUser(error: unknown) {
  return formatRuntimeErrorForChat(error);
}
