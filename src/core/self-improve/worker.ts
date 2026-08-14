import { resolveAgentDir } from "./agent-dir.js";
import { processQueuedSelfImproveJobs } from "./async-jobs.js";

export async function runMemoryWorker(agentDir: string) {
  const resolvedAgentDir = resolveAgentDir(agentDir);
  if (!resolvedAgentDir) return;
  await processQueuedSelfImproveJobs(resolvedAgentDir);
}
