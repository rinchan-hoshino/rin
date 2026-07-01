#!/usr/bin/env node
/**
 * App TUI entrypoint.
 *
 * Keep this bootstrap minimal so terminal feedback appears before the full TUI
 * module graph is loaded.
 */
import { runFrontendEntrypoint } from "../../core/rin-frontend-sdk/entrypoint.js";
import { startTuiStartupStatusAnimation } from "../../core/rin-tui/startup-status.js";

const startupStatus = startTuiStartupStatusAnimation();

runFrontendEntrypoint(async () => {
  const { startTui } = await import("../../core/rin-tui/launcher.js");
  return await startTui({ startupStatus });
});
