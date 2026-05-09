const INTERNAL_RUNTIME_ERROR_RE =
  /^((?:[a-z][a-z0-9]*_)+[a-z0-9]+)(?::(\S+))?$/;

export function rawErrorMessage(error: unknown) {
  return String((error as any)?.message || error || "").trim();
}

export function formatRuntimeErrorForUser(error: unknown) {
  const message = rawErrorMessage(error);
  if (!message) return "unknown error";
  const internalError = INTERNAL_RUNTIME_ERROR_RE.exec(message);
  if (internalError) {
    const readableMarker = internalError[1].replaceAll("_", " ");
    const detail = internalError[2] ? `: ${internalError[2]}` : "";
    return `${readableMarker}${detail}`;
  }
  return message;
}
