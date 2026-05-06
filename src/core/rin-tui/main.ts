#!/usr/bin/env node
import { startTui } from "./launcher.js";

startTui().catch((error: any) => {
  console.error(String(error?.message || error || "rin_tui_failed"));
  process.exit(1);
});
