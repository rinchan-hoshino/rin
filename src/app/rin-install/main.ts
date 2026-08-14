#!/usr/bin/env node
import { processTerminationExitCode } from "../../core/platform/process-lifetime.js";
import { formatRuntimeErrorForUser } from "../../core/presentation/error.js";
import { startInstaller } from "../../core/rin-install/main.js";

process.on("uncaughtException", (error) => {
  const exitCode = processTerminationExitCode(error);
  if (exitCode !== undefined) process.exit(exitCode);
  console.error(formatRuntimeErrorForUser(error || "rin_app_install_failed"));
  process.exit(1);
});

startInstaller()
  .then((exitCode) => {
    if (typeof exitCode === "number") process.exitCode = exitCode;
  })
  .catch((error: any) => {
    const exitCode = processTerminationExitCode(error);
    if (exitCode !== undefined) process.exit(exitCode);
    if (
      !error?.rinApplyPlanErrorHandoffWritten &&
      !error?.suppressUserFacingPrint
    ) {
      console.error(
        formatRuntimeErrorForUser(error || "rin_app_install_failed"),
      );
    }
    process.exit(1);
  });
