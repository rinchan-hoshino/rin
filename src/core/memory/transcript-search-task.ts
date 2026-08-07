import { Worker } from "node:worker_threads";

import { flushTranscriptSearchIndexWrites } from "./transcript-search.js";
import type { TranscriptSessionResult } from "./transcript-types.js";

export type TranscriptSearchTask =
  | {
      operation: "search";
      query: string;
      params: Record<string, unknown>;
      rootOverride: string;
    }
  | {
      operation: "recent";
      params: Record<string, unknown>;
      rootOverride: string;
    };

type TranscriptSearchTaskResult =
  | { ok: true; results: TranscriptSessionResult[] }
  | {
      ok: false;
      error: { message: string; code?: string; stack?: string };
    };

function recallAbortedError() {
  return new Error("recall_aborted");
}

function restoreWorkerError(input: {
  message: string;
  code?: string;
  stack?: string;
}) {
  const error = new Error(input.message || "transcript_search_worker_failed");
  if (input.code) (error as any).code = input.code;
  if (input.stack) error.stack = input.stack;
  return error;
}

export async function runTranscriptSearchTask(
  task: TranscriptSearchTask,
  signal?: AbortSignal,
  workerUrl = new URL("./transcript-search-task-worker.js", import.meta.url),
): Promise<TranscriptSessionResult[]> {
  if (signal?.aborted) throw recallAbortedError();
  flushTranscriptSearchIndexWrites(task.rootOverride);

  const worker = new Worker(workerUrl, { workerData: task, execArgv: [] });
  return await new Promise<TranscriptSessionResult[]>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      worker.removeListener("message", onMessage);
      worker.removeListener("error", onError);
      worker.removeListener("exit", onExit);
    };
    const settle = (
      finish: () => void,
      options: { terminate?: boolean } = {},
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (options.terminate) void worker.terminate();
      finish();
    };
    const onAbort = () =>
      settle(() => reject(recallAbortedError()), { terminate: true });
    const onMessage = (message: TranscriptSearchTaskResult) => {
      if (message?.ok === true) {
        settle(() => resolve(message.results));
        return;
      }
      settle(() =>
        reject(
          restoreWorkerError(
            message?.error || { message: "transcript_search_worker_failed" },
          ),
        ),
      );
    };
    const onError = (error: Error) => settle(() => reject(error));
    const onExit = (code: number) => {
      if (code === 0) {
        settle(() => reject(new Error("transcript_search_worker_no_result")));
        return;
      }
      settle(() => reject(new Error(`transcript_search_worker_exit:${code}`)));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
    if (signal?.aborted) onAbort();
  });
}

export async function searchTranscriptArchiveAbortable(
  query: string,
  params: Record<string, unknown> = {},
  rootOverride = "",
  signal?: AbortSignal,
) {
  return await runTranscriptSearchTask(
    { operation: "search", query, params, rootOverride },
    signal,
  );
}

export async function loadRecentTranscriptSessionsAbortable(
  params: Record<string, unknown> = {},
  rootOverride = "",
  signal?: AbortSignal,
) {
  return await runTranscriptSearchTask(
    { operation: "recent", params, rootOverride },
    signal,
  );
}
