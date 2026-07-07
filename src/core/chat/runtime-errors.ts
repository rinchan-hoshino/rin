import {
  isRinFrontendTurnCancelledError,
  RIN_FRONTEND_TURN_CANCELLED,
} from "../rin-frontend-sdk/lifecycle-errors.js";
import {
  formatRuntimeErrorForChat,
  formatRuntimeErrorForUser,
} from "../rin-lib/user-facing-errors.js";
import { safeString } from "./chat-helpers.js";

function isRetryableRuntimeMarker(message: string) {
  return (
    message.startsWith("rin_timeout:") ||
    message.startsWith("rin_disconnected:") ||
    message === "rin_tui_not_connected" ||
    message === "chat_controller_disposed" ||
    message === "chat_turn_stale" ||
    message === "rin_worker_exit" ||
    message.startsWith("rin_worker_exit:")
  );
}

function isRetryableTransportError(message: string) {
  return (
    message.startsWith("WebSocket closed") ||
    message === "WebSocket error" ||
    message.startsWith("connect ENOENT") ||
    message.startsWith("connect ECONNREFUSED") ||
    message.startsWith("connect ECONNRESET") ||
    message.startsWith("connect EPIPE") ||
    message.includes("socket hang up") ||
    message.includes("write EPIPE")
  );
}

export function isTransientChatRuntimeError(error: unknown) {
  if (isRinFrontendTurnCancelledError(error)) return true;
  const message = safeString((error as any)?.message || error);
  return (
    isRetryableRuntimeMarker(message) || isRetryableTransportError(message)
  );
}

function isMarkerOrMarkerDetail(message: string, marker: string) {
  return message === marker || message.startsWith(`${marker}:`);
}

export function isChatLifecycleRuntimeError(error: unknown) {
  const message = safeString((error as any)?.message || error);
  return (
    isMarkerOrMarkerDetail(message, "rin_worker_exit") ||
    isMarkerOrMarkerDetail(message, "rin_turn_result_recovery_timeout") ||
    isMarkerOrMarkerDetail(message, "rpc_turn_final_output_missing") ||
    isMarkerOrMarkerDetail(message, "rin_turn_result_invariant_failed")
  );
}

export function isSilentChatRuntimeRetryError(error: unknown) {
  return (
    isRinFrontendTurnCancelledError(error) ||
    safeString(error).trim() === RIN_FRONTEND_TURN_CANCELLED ||
    isChatLifecycleRuntimeError(error)
  );
}

export function formatChatRuntimeErrorForUser(error: unknown) {
  if (isChatLifecycleRuntimeError(error))
    return formatRuntimeErrorForUser(error);
  return formatRuntimeErrorForChat(error);
}
