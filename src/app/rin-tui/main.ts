#!/usr/bin/env node
/**
 * App TUI entrypoint.
 *
 * Thin assembly wrapper over the shared core TUI launcher.
 */
import { startTui } from "../../core/rin-tui/launcher.js";
import {
  installTuiTerminalStateRestore,
  restoreTerminalStateForExit,
} from "../../core/rin-tui/terminal-state-restore.js";

installTuiTerminalStateRestore();

startTui().catch((error: any) => {
  restoreTerminalStateForExit();
  console.error(String(error?.message || error || "rin_app_tui_failed"));
  process.exit(1);
});
