#!/usr/bin/env node
/**
 * App TUI entrypoint.
 *
 * Thin assembly wrapper over the shared core TUI launcher.
 */
import { startTui } from "../../core/rin-tui/launcher.js";
import { formatRuntimeErrorForTui } from "../../core/rin-lib/user-facing-errors.js";

startTui().catch((error: any) => {
  console.error(formatRuntimeErrorForTui(error || "rin_app_tui_failed"));
  process.exit(1);
});
