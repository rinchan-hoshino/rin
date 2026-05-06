#!/usr/bin/env node
import { startTui } from "./launcher.js";
import {
  installTuiFatalTerminalReset,
  restoreTerminalStateForExit,
} from "./terminal-cleanup.js";

installTuiFatalTerminalReset();

startTui().catch((error: any) => {
  restoreTerminalStateForExit();
  console.error(String(error?.message || error || "rin_tui_failed"));
  process.exit(1);
});
