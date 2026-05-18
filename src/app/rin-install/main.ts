#!/usr/bin/env node
import { startInstaller } from "../../core/rin-install/main.js";
import { formatRuntimeErrorForUser } from "../../core/rin-lib/user-facing-errors.js";

startInstaller().catch((error: any) => {
  console.error(formatRuntimeErrorForUser(error || "rin_app_install_failed"));
  process.exit(1);
});
