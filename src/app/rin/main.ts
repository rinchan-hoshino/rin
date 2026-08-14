#!/usr/bin/env node
import { processTerminationExitCode } from "../../core/platform/process-lifetime.js";
import { formatRuntimeErrorForUser } from "../../core/presentation/error.js";
import { startRinCli } from "../../core/rin/main.js";

startRinCli()
  .then((exitCode) => {
    if (typeof exitCode === "number") process.exitCode = exitCode;
  })
  .catch((error: any) => {
    const exitCode = processTerminationExitCode(error);
    if (exitCode !== undefined) process.exit(exitCode);
    console.error(formatRuntimeErrorForUser(error || "rin_app_cli_failed"));
    process.exit(1);
  });
