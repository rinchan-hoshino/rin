import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadRecentTranscriptSessionsAbortable,
  runTranscriptSearchTask,
  searchTranscriptArchiveAbortable,
} from "../../dist/core/memory/transcript-search-task.js";
import { appendTranscriptArchiveEntry } from "../../dist/core/memory/transcript-search.js";

test("abortable transcript search executes off-thread and honors cancellation", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-search-task-owner-"),
  );
  try {
    const sessionFile = path.join(root, "sessions", "owner.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", id: "owner" })}\n`,
    );
    await appendTranscriptArchiveEntry(
      {
        id: "owner-entry",
        timestamp: "2026-08-07T08:00:00.000Z",
        sessionId: "owner-session",
        sessionFile,
        role: "assistant",
        text: "interruptible owner transcript search",
      },
      root,
    );

    const results = await searchTranscriptArchiveAbortable(
      "interruptible owner",
      { limit: 1 },
      root,
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].sessionId, "owner-session");

    const recent = await loadRecentTranscriptSessionsAbortable(
      { limit: 1 },
      root,
    );
    assert.equal(recent[0].sessionId, "owner-session");

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      searchTranscriptArchiveAbortable("owner", {}, root, controller.signal),
      /recall_aborted/,
    );

    const runningController = new AbortController();
    const interrupted = searchTranscriptArchiveAbortable(
      "owner",
      {},
      root,
      runningController.signal,
    );
    runningController.abort();
    await assert.rejects(interrupted, /recall_aborted/);

    const invalidRoot = path.join(root, "not-a-directory");
    await fs.writeFile(invalidRoot, "owner");
    await assert.rejects(
      searchTranscriptArchiveAbortable("owner", {}, invalidRoot),
      /ENOTDIR|not a directory/,
    );

    const task = {
      operation: "search" as const,
      query: "owner",
      params: {},
      rootOverride: root,
    };
    await assert.rejects(
      runTranscriptSearchTask(
        task,
        undefined,
        new URL(
          'data:text/javascript,throw new Error("owner worker boot failed")',
        ),
      ),
      /owner worker boot failed/,
    );
    await assert.rejects(
      runTranscriptSearchTask(
        task,
        undefined,
        new URL("data:text/javascript,process.exit(0)"),
      ),
      /transcript_search_worker_no_result/,
    );

    const metadataErrorWorker = new URL(
      `data:text/javascript,${encodeURIComponent(`
        import { parentPort } from "node:worker_threads";
        parentPort.postMessage({
          ok: false,
          error: {
            message: "owner worker response failed",
            code: "OWNER_RESPONSE",
            stack: "owner worker stack",
          },
        });
      `)}`,
    );
    await assert.rejects(
      runTranscriptSearchTask(task, undefined, metadataErrorWorker),
      (error: any) => {
        assert.equal(error.message, "owner worker response failed");
        assert.equal(error.code, "OWNER_RESPONSE");
        assert.equal(error.stack, "owner worker stack");
        return true;
      },
    );

    const malformedResponseWorker = new URL(
      `data:text/javascript,${encodeURIComponent(`
        import { parentPort } from "node:worker_threads";
        parentPort.postMessage({ ok: false });
      `)}`,
    );
    await assert.rejects(
      runTranscriptSearchTask(task, undefined, malformedResponseWorker),
      /transcript_search_worker_failed/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
