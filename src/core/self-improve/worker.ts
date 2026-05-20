#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { processQueuedMemoryJobs } from "./async-jobs.js";
import { safeString } from "./core/utils.js";
import { resolveAgentDir } from "./agent-dir.js";

function readAgentDirArgValue() {
  for (let index = 2; index < process.argv.length; index += 1) {
    const value = process.argv[index];
    if (value === "--agent-dir") {
      return safeString(process.argv[index + 1]).trim();
    }
    if (value.startsWith("--agent-dir=")) {
      return safeString(value.slice("--agent-dir=".length)).trim();
    }
  }
  return safeString(process.env.RIN_DIR || "").trim();
}

export async function runMemoryWorker() {
  const agentDirArg = readAgentDirArgValue();
  if (!agentDirArg) return;
  await processQueuedMemoryJobs(resolveAgentDir(agentDirArg));
}

const isDirectEntry =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectEntry) {
  runMemoryWorker().catch((error: any) => {
    const message = String(
      error && error.message
        ? error.message
        : error || "rin_memory_worker_failed",
    );
    console.error(message);
    process.exit(1);
  });
}
