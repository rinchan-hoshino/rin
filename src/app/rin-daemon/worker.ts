#!/usr/bin/env node
import { fileURLToPath } from "node:url";

/**
 * App worker entrypoint.
 *
 * This file exists so app can point the shared core worker at the product shell.
 */
import { startWorkerProcess } from "../../core/rin-daemon/worker.js";
import { formatRuntimeErrorForUser } from "../../core/presentation/error.js";

async function main() {
  await startWorkerProcess({
    executionPath: fileURLToPath(import.meta.url),
    terminateProcess: (code) => process.exit(code),
  });
}

main().catch((error: any) => {
  console.error(formatRuntimeErrorForUser(error || "rin_app_worker_failed"));
  process.exit(1);
});
