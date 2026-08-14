#!/usr/bin/env node
import { sanitizeSelfImproveHistoryText } from "../../core/self-improve/run-audit.js";
import { runMemoryWorker } from "../../core/self-improve/worker.js";
import { safeString } from "../../core/text-utils.js";

function readAgentDirArgValue() {
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const value = safeString(argv[index]).trim();
    if (value === "--agent-dir") {
      return safeString(argv[index + 1]).trim();
    }
    if (value.startsWith("--agent-dir=")) {
      return value.slice("--agent-dir=".length).trim();
    }
  }
  return safeString(process.env.RIN_DIR).trim();
}

runMemoryWorker(readAgentDirArgValue()).catch((error: any) => {
  const message = sanitizeSelfImproveHistoryText(
    error?.message || error || "rin_memory_worker_failed",
    64 * 1024,
  ).text;
  console.error(`[rin-self-improve-worker] ${message}`);
  process.exit(1);
});
