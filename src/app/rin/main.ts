#!/usr/bin/env node
import { startRinCli } from "../../core/rin/main.js";
import { formatRuntimeErrorForUser } from "../../core/presentation/error.js";

startRinCli().catch((error: any) => {
  console.error(formatRuntimeErrorForUser(error || "rin_app_cli_failed"));
  process.exit(1);
});
