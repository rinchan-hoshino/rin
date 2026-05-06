#!/usr/bin/env node
import { startTui } from "./launcher.js";
import {
  installTuiTerminalStateRestore,
  restoreTerminalStateForExit,
} from "./terminal-state-restore.js";

installTuiTerminalStateRestore();

startTui().catch((error: any) => {
  restoreTerminalStateForExit();
  console.error(String(error?.message || error || "rin_tui_failed"));
  process.exit(1);
});
