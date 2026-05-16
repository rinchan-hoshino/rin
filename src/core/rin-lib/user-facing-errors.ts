const INTERNAL_RUNTIME_ERROR_RE =
  /^((?:[a-z][a-z0-9]*_)+[a-z0-9]+)(?::(\S+))?$/;

const USER_FACING_RUNTIME_ERRORS: Record<string, (detail: string) => string> = {
  new_session_session_file_unsupported: () =>
    "Could not start a new chat session because the command was bound to a replied message's old session. Retry /new; chat commands should not use replied-message sessions.",
  frontend_model_not_found: (detail) =>
    `Model not found${detail ? `: ${detail}` : ""}. Choose an available model in /model or settings.`,
  rin_request_failed: () =>
    "Rin request failed. Retry the command; if it repeats, run rin doctor.",
};

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
    return `Internal error: ${marker}${detail ? `: ${detail}` : ""}`;
  }
  return message;
}
