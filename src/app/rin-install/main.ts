#!/usr/bin/env node
import { startInstaller } from "../../core/rin-install/main.js";
import { formatRuntimeErrorForUser } from "../../core/presentation/error.js";

startInstaller().catch((error: any) => {
  if (
    !error?.rinApplyPlanErrorHandoffWritten &&
    !error?.suppressUserFacingPrint
  ) {
    console.error(formatRuntimeErrorForUser(error || "rin_app_install_failed"));
  }
  process.exit(1);
});
