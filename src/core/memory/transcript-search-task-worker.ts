import { parentPort, workerData } from "node:worker_threads";

import {
  loadRecentTranscriptSessions,
  searchTranscriptArchive,
} from "./transcript-search.js";
import type { TranscriptSearchTask } from "./transcript-search-task.js";

const port = parentPort!;
const task = workerData as TranscriptSearchTask;

async function main() {
  try {
    const result =
      task.operation === "search"
        ? await searchTranscriptArchive(
            task.query,
            task.params,
            task.rootOverride,
          )
        : await loadRecentTranscriptSessions(task.params, task.rootOverride);
    port.postMessage({ ok: true, results: result });
  } catch (error) {
    port.postMessage({
      ok: false,
      error: { message: String(error) },
    });
  }
}

void main();
