#!/usr/bin/env node
import { startRinCli } from "../../core/rin/main.js";
import { formatRuntimeErrorForUser } from "../../core/rin-lib/user-facing-errors.js";

function reportCliStartupFailure(error: any) {
  console.error(formatRuntimeErrorForUser(error || "rin_app_cli_failed"));
  process.exit(1);
}

startRinCli().catch(reportCliStartupFailure);
