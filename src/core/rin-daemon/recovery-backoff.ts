export const DAEMON_RECOVERY_MAX_DELAY_MS = 30_000;

export function daemonRecoveryDelayMs(attempt: number) {
  const normalizedAttempt = Math.max(1, Math.floor(Number(attempt) || 1));
  return Math.min(
    DAEMON_RECOVERY_MAX_DELAY_MS,
    500 * 2 ** Math.min(normalizedAttempt - 1, 6),
  );
}
