#!/usr/bin/env node

import { runRestartJobExecutor } from "../../core/rin/restart-job.js";
import { formatRuntimeErrorForUser } from "../../core/presentation/error.js";

const jobPath = String(process.argv[2] || "").trim();
if (!jobPath) throw new Error("Rin restart job file was not provided.");

try {
  await runRestartJobExecutor(jobPath);
} catch (error) {
  process.stderr.write(`${formatRuntimeErrorForUser(error)}\n`);
  process.exitCode = 1;
}
