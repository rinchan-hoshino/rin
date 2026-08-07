#!/usr/bin/env node
/**
 * App worker entrypoint.
 *
 * This file exists so app can point the shared core worker at the product shell.
 */
import { startWorkerProcess } from "../../core/rin-daemon/worker.js";
import { formatRuntimeErrorForUser } from "../../core/rin-lib/user-facing-errors.js";

async function main() {
  await startWorkerProcess();
}

main().catch((error: any) => {
  console.error(formatRuntimeErrorForUser(error || "rin_app_worker_failed"));
  process.exit(1);
});
