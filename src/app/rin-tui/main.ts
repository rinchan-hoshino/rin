#!/usr/bin/env node
/**
 * App TUI entrypoint.
 *
 * Thin assembly wrapper over the shared core TUI launcher.
 */
import { runFrontendEntrypoint } from "../../core/rin-frontend-sdk/entrypoint.js";
import { startTui } from "../../core/rin-tui/launcher.js";

runFrontendEntrypoint(startTui);
