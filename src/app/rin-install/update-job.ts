#!/usr/bin/env node

import { runUpdateJobExecutor } from "../../core/rin/update-job.js";
import { formatRuntimeErrorForUser } from "../../core/rin-lib/user-facing-errors.js";

const jobPath = String(process.argv[2] || "").trim();
if (!jobPath) throw new Error("Rin update job file was not provided.");

try {
  process.exitCode = await runUpdateJobExecutor(jobPath);
} catch (error) {
  process.stderr.write(`${formatRuntimeErrorForUser(error)}\n`);
  process.exitCode = 1;
}
