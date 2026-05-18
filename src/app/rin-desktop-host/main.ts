#!/usr/bin/env node
import electron from "electron";

import { runElectronDesktopHost } from "../../core/rin-gui/native-desktop.js";
import { formatRuntimeErrorForUser } from "../../core/rin-lib/user-facing-errors.js";

const rawArgv = process.argv.slice(2);

runElectronDesktopHost({
  args: rawArgv,
  electronBinary: String(electron),
}).catch((error: any) => {
  console.error(formatRuntimeErrorForUser(error || "rin_desktop_host_failed"));
  process.exit(1);
});
