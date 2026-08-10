export type UpdateConfirmationContext = {
  assumeYes: boolean;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
};

export function assertUpdateConfirmationAvailable(
  context: UpdateConfirmationContext,
) {
  if (!context.assumeYes && (!context.stdinIsTTY || !context.stdoutIsTTY)) {
    throw new Error(
      "rin_update_confirmation_required: pass --yes in non-interactive mode",
    );
  }
}
