export function rawErrorMessage(error: unknown) {
  return String((error as any)?.message || error || "").trim();
}
