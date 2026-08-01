export const RIN_FRONTEND_SESSION_NOT_CONNECTED =
  "frontend_session_not_connected" as const;

export class RinFrontendSessionNotConnectedError extends Error {
  readonly code = RIN_FRONTEND_SESSION_NOT_CONNECTED;

  constructor() {
    super(RIN_FRONTEND_SESSION_NOT_CONNECTED);
    this.name = "RinFrontendSessionNotConnectedError";
  }
}

export function isRinFrontendSessionNotConnectedError(error: unknown) {
  if (error instanceof RinFrontendSessionNotConnectedError) return true;
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === RIN_FRONTEND_SESSION_NOT_CONNECTED,
  );
}
