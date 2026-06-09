#!/usr/bin/env node
import { startTui } from "./launcher.js";
import { formatRuntimeErrorForTui } from "../rin-lib/user-facing-errors.js";

startTui().catch((error: any) => {
  console.error(formatRuntimeErrorForTui(error || "rin_tui_failed"));
  process.exit(1);
});
