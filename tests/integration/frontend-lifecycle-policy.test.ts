import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import {
  createRinFrontendLifecycleState,
  executeRinFrontendInterruptIntent,
  projectRinFrontendLifecycleEvent,
  reduceRinFrontendLifecycleState,
  renderRinFrontendLifecycleEvent,
} from "../../dist/core/rin-frontend-sdk/frontend-lifecycle.js";

function apply(
  state: ReturnType<typeof createRinFrontendLifecycleState>,
  payload: any,
) {
  const event = projectRinFrontendLifecycleEvent(payload);
  assert.ok(event, `expected lifecycle event for ${payload?.type}`);
  reduceRinFrontendLifecycleState(state, event);
  return event;
}

test("shared lifecycle reducer tracks facts without owning Working presentation", () => {
  const state = createRinFrontendLifecycleState();

  apply(state, { type: "agent_start" });
  assert.deepEqual(state, {
    turnActive: true,
    isStreaming: true,
    isCompacting: false,
    compactionReason: "",
    retryAttempt: 0,
    maxRetryAttempts: 0,
    retryDelayMs: 0,
    retryError: "",
  });

  apply(state, { type: "compaction_start", reason: "threshold" });
  assert.equal(state.isCompacting, true);
  assert.equal(state.compactionReason, "threshold");

  apply(state, {
    type: "summarization_retry_scheduled",
    attempt: 1,
    maxAttempts: 3,
    delayMs: 2000,
    errorMessage: "Compaction failed: overloaded",
  });
  assert.equal(state.retryAttempt, 1);
  assert.equal(state.maxRetryAttempts, 3);
  assert.equal(state.retryError, "Compaction failed: overloaded");

  apply(state, {
    type: "summarization_retry_attempt_start",
    source: "compaction",
    reason: "threshold",
  });
  assert.equal(state.retryAttempt, 0);
  assert.equal(state.isCompacting, true);

  apply(state, {
    type: "compaction_end",
    reason: "threshold",
    aborted: false,
    willRetry: false,
    errorMessage: "Compaction failed after retries",
  });
  assert.equal(state.isCompacting, false);

  apply(state, {
    type: "auto_retry_start",
    attempt: 2,
    maxAttempts: 3,
    delayMs: 1000,
    errorMessage: "Provider unavailable",
  });
  assert.equal(state.retryAttempt, 2);

  apply(state, { type: "auto_retry_end", success: true, attempt: 2 });
  assert.equal(state.retryAttempt, 0);

  apply(state, { type: "agent_end" });
  apply(state, { type: "agent_settled" });
  assert.equal(state.turnActive, true);

  apply(state, {
    type: "rpc_turn_event",
    event: "error",
    error: "Provider unavailable",
    requestTag: "turn-1",
  });
  assert.equal(state.turnActive, false);
  assert.equal(state.isStreaming, false);
});

test("canonical lifecycle renderer keeps retry schedules silent while preserving compaction errors", () => {
  const scheduled = projectRinFrontendLifecycleEvent({
    type: "summarization_retry_scheduled",
    attempt: 1,
    maxAttempts: 3,
    delayMs: 2000,
    errorMessage: "Compaction failed: overloaded",
    requestTag: "turn-1",
  });
  assert.ok(scheduled);
  assert.deepEqual(renderRinFrontendLifecycleEvent(scheduled), []);

  const compactionFailure = projectRinFrontendLifecycleEvent({
    type: "compaction_end",
    reason: "threshold",
    aborted: false,
    willRetry: false,
    errorMessage: "Compaction failed after retries",
  });
  assert.ok(compactionFailure);
  assert.deepEqual(renderRinFrontendLifecycleEvent(compactionFailure), [
    {
      type: "passive_notice",
      text: "Compaction failed after retries",
      level: "error",
      deferDuringTurn: false,
      noticeKind: "lifecycle_error",
    },
  ]);

  const retry = projectRinFrontendLifecycleEvent({
    type: "auto_retry_start",
    attempt: 2,
    maxAttempts: 3,
    delayMs: 1000,
    errorMessage: "Provider unavailable",
    requestTag: "turn-2",
  });
  assert.ok(retry);
  assert.deepEqual(renderRinFrontendLifecycleEvent(retry), []);
});

test("canonical lifecycle renderer owns complete and error terminal projection", () => {
  const complete = projectRinFrontendLifecycleEvent({
    type: "rpc_turn_event",
    event: "complete",
    finalText: "  done  ",
    result: { ok: true },
    chatDeliveryContext: [],
    terminalRecord: [],
    requestTag: "turn-3",
  });
  assert.ok(complete);
  const invalidTerminalRecord = projectRinFrontendLifecycleEvent({
    type: "rpc_turn_event",
    event: "complete",
    terminalRecord: { terminalId: "", state: "complete" },
  });
  assert.ok(invalidTerminalRecord);
  assert.equal(invalidTerminalRecord.terminalRecord, undefined);
  const validTerminalRecord = projectRinFrontendLifecycleEvent({
    type: "rpc_turn_event",
    event: "complete",
    terminalRecord: {
      terminalId: "terminal-turn-3",
      state: "complete",
      terminalAt: "2026-08-07T00:45:00.000Z",
    },
  });
  assert.ok(validTerminalRecord);
  assert.deepEqual(validTerminalRecord.terminalRecord, {
    terminalId: "terminal-turn-3",
    state: "complete",
    terminalAt: "2026-08-07T00:45:00.000Z",
  });
  assert.deepEqual(renderRinFrontendLifecycleEvent(complete), [
    {
      type: "assistant_final",
      text: "done",
      result: { ok: true },
      sessionId: undefined,
      sessionFile: undefined,
      requestTag: "turn-3",
    },
    {
      type: "turn_complete",
      finalText: "done",
      result: { ok: true },
      sessionId: undefined,
      sessionFile: undefined,
      requestTag: "turn-3",
    },
  ]);

  const failed = projectRinFrontendLifecycleEvent({
    type: "rpc_turn_event",
    event: "error",
    error: "  failed  ",
    requestTag: "turn-4",
  });
  assert.ok(failed);
  assert.deepEqual(renderRinFrontendLifecycleEvent(failed), [
    {
      type: "turn_error",
      error: "failed",
      sessionId: undefined,
      sessionFile: undefined,
      requestTag: "turn-4",
    },
  ]);

  const retryExhausted = projectRinFrontendLifecycleEvent({
    type: "rpc_turn_event",
    event: "error",
    error: "fetch failed",
    retryFailure: {
      attempt: 3,
      finalError: "fetch failed",
    },
    requestTag: "turn-retry",
  });
  assert.ok(retryExhausted);
  assert.deepEqual(renderRinFrontendLifecycleEvent(retryExhausted), [
    {
      type: "turn_error",
      error: "Retry failed after 3 attempts: fetch failed",
      retryFailure: {
        attempt: 3,
        finalError: "fetch failed",
      },
      sessionId: undefined,
      sessionFile: undefined,
      requestTag: "turn-retry",
    },
  ]);
});

test("canonical lifecycle renders manual and automatic compaction cancellation", () => {
  assert.deepEqual(
    renderRinFrontendLifecycleEvent({
      kind: "compaction_finished",
      aborted: true,
      reason: "manual",
      tokensBefore: 10,
    }),
    [
      {
        type: "passive_notice",
        text: "Compaction cancelled",
        level: "error",
        deferDuringTurn: false,
        noticeKind: "lifecycle_error",
      },
    ],
  );
  assert.deepEqual(
    renderRinFrontendLifecycleEvent({
      kind: "compaction_finished",
      aborted: true,
      reason: "auto",
      tokensBefore: 10,
    }),
    [
      {
        type: "passive_notice",
        text: "Auto-compaction cancelled",
        level: "info",
        deferDuringTurn: false,
        noticeKind: "lifecycle_error",
      },
    ],
  );
});

test("canonical lifecycle normalizes fallback terminal errors", () => {
  assert.equal(
    projectRinFrontendLifecycleEvent({
      type: "frontend_turn_aborted",
      error: "legacy abort event",
      requestTag: "turn-abort",
    }),
    null,
  );

  const agentStopped = projectRinFrontendLifecycleEvent({
    type: "agent_end",
    settled: true,
  });
  assert.ok(agentStopped);
  assert.deepEqual(renderRinFrontendLifecycleEvent(agentStopped), []);

  const failed = projectRinFrontendLifecycleEvent({
    type: "rpc_turn_event",
    event: "error",
    error: "   ",
  });
  assert.ok(failed);
  assert.deepEqual(renderRinFrontendLifecycleEvent(failed), [
    {
      type: "turn_error",
      error: "rpc_turn_failed",
      sessionId: undefined,
      sessionFile: undefined,
      requestTag: undefined,
    },
  ]);
});

test("canonical interrupt intents preserve frontend meaning while sharing one command policy", async () => {
  const calls: string[] = [];
  const client = {
    abort: async () => calls.push("abort"),
    abortRetry: async () => calls.push("abort_retry"),
    abortCompaction: async () => calls.push("abort_compaction"),
  };

  await executeRinFrontendInterruptIntent(client, "stop_turn");
  await executeRinFrontendInterruptIntent(client, "cancel_retry");
  await executeRinFrontendInterruptIntent(client, "cancel_compaction");

  assert.deepEqual(calls, ["abort", "abort_retry", "abort_compaction"]);
});
