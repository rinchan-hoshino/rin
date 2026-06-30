#!/usr/bin/env node
import { startRinCli } from "../../core/rin/main.js";

startRinCli().catch(async (error: any) => {
  const { formatRuntimeErrorForUser } =
    await import("../../core/rin-lib/user-facing-errors.js");
  console.error(formatRuntimeErrorForUser(error || "rin_app_cli_failed"));
  process.exit(1);
});
