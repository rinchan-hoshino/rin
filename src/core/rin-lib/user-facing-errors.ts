const INTERNAL_RUNTIME_ERROR_RE = /^(?:[a-z][a-z0-9]*_)+[a-z0-9]+(?::\S+)?$/;

export function rawErrorMessage(error: unknown) {
  return String((error as any)?.message || error || "").trim();
}

export function formatRuntimeErrorForUser(error: unknown) {
  const message = rawErrorMessage(error);
  if (!message) return "Rin hit an internal error. Please retry.";
  if (INTERNAL_RUNTIME_ERROR_RE.test(message)) {
    return "Rin hit an internal error. Please retry, or check the logs for details.";
  }
  return message;
}
