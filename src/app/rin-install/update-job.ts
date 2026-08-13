#!/usr/bin/env node

import {
  launchWindowsDetachedUpdateJob,
  runUpdateJobExecutor,
} from "../../core/rin/update-job.js";
import { formatRuntimeErrorForUser } from "../../core/presentation/error.js";

const modeOrJobPath = String(process.argv[2] || "").trim();
if (!modeOrJobPath) throw new Error("Rin update job file was not provided.");

try {
  if (modeOrJobPath === "--detach") {
    const jobPath = String(process.argv[3] || "").trim();
    if (!jobPath) throw new Error("Rin update job file was not provided.");
    await launchWindowsDetachedUpdateJob(process.argv[1]!, jobPath);
  } else {
    process.exitCode = await runUpdateJobExecutor(modeOrJobPath);
  }
} catch (error) {
  process.stderr.write(`${formatRuntimeErrorForUser(error)}\n`);
  process.exitCode = 1;
}
