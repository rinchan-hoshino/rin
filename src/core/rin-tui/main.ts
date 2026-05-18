#!/usr/bin/env node
import { startTui } from "./launcher.js";
import { formatRuntimeErrorForUser } from "../rin-lib/user-facing-errors.js";

startTui().catch((error: any) => {
  console.error(formatRuntimeErrorForUser(error || "rin_tui_failed"));
  process.exit(1);
});
