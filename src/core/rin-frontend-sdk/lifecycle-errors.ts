export const RIN_FRONTEND_TURN_CANCELLED = "rin_frontend_turn_cancelled";

export function createRinFrontendTurnCancelledError() {
  const error = new Error(RIN_FRONTEND_TURN_CANCELLED);
  (error as any).code = RIN_FRONTEND_TURN_CANCELLED;
  return error;
}

export function isRinFrontendTurnCancelledError(error: unknown) {
  const record = error as any;
  const message = String(record?.message || error || "").trim();
  return (
    record?.code === RIN_FRONTEND_TURN_CANCELLED ||
    message === RIN_FRONTEND_TURN_CANCELLED ||
    message === "Request was aborted"
  );
}
