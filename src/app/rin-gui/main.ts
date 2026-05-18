#!/usr/bin/env node
import { runGui } from "../../core/rin-gui/main.js";
import { resolveParsedArgs } from "../../core/rin/shared.js";
import { formatRuntimeErrorForUser } from "../../core/rin-lib/user-facing-errors.js";

const rawArgv = process.argv.slice(2);
const parsed = resolveParsedArgs("gui", {}, rawArgv);

runGui(parsed, rawArgv).catch((error: any) => {
  console.error(formatRuntimeErrorForUser(error || "rin_gui_failed"));
  process.exit(1);
});
