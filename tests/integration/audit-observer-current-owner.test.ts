import assert from "node:assert/strict";
import test from "node:test";
import { importBuiltModule } from "../support/import-built-module.ts";

const observer = await importBuiltModule<
  typeof import("../../src/core/self-improve/audit-observer.ts")
>("dist/core/self-improve/audit-observer.js");

interface OwnerState {
  calls: unknown[][];
  beginError?: unknown;
  completeError?: unknown;
  maintainError?: unknown;
  ackError?: unknown;
}

function installState(overrides: Partial<OwnerState> = {}): OwnerState {
  const state: OwnerState = { calls: [], ...overrides };
  (
    globalThis as typeof globalThis & {
      __rinAuditObserverOwnerState?: OwnerState;
    }
  ).__rinAuditObserverOwnerState = state;
  return state;
}

const base = {
  agentDir: "/tmp/rin-audit-observer-owner",
  runId: "owner-run",
  kind: "self_improve_review",
  startedAt: "2026-07-31T00:00:00.000Z",
  source: { trigger: "owner" },
};

test("audit observer preserves primary work across every audit outcome", async (t) => {
  assert.equal(
    observer.combineSelfImproveAuditErrors(undefined, undefined),
    "self_improve_audit_failed",
  );
  assert.equal(
    observer.combineSelfImproveAuditErrors("owner", "owner"),
    "owner",
  );
  assert.equal(
    observer.combineSelfImproveAuditErrors("owner-a", new Error("owner-b")),
    "owner-a; owner-b",
  );

  const reported: string[] = [];
  t.mock.method(console, "error", (message: unknown) => {
    reported.push(String(message));
  });
  observer.reportSelfImproveAuditObservationError("primitive");
  assert.match(reported[0], /rin-self-improve-audit.*primitive/);

  const beginState = installState();
  const begun = await observer.beginSelfImproveAuditObservation(base);
  assert.deepEqual(begun.handle, {
    pendingPath: "pending/owner.json",
    runId: "owner-run",
  });
  assert.equal(begun.auditError, undefined);
  assert.equal(beginState.calls[0][0], "begin");

  installState({ beginError: new Error("begin owner failure") });
  const beginFailure = await observer.beginSelfImproveAuditObservation(base);
  assert.equal(beginFailure.handle, undefined);
  assert.match(beginFailure.auditError || "", /begin owner failure/);

  const maintenanceOnly = installState();
  const withoutHandle = await observer.completeSelfImproveAuditObservation({
    ...base,
    status: "completed",
    finishedAt: "2026-07-31T00:01:00.000Z",
    output: "owner output",
  });
  assert.equal(withoutHandle.audit, undefined);
  assert.equal(withoutHandle.auditHandle, undefined);
  assert.deepEqual(withoutHandle.changedFiles, []);
  assert.equal(withoutHandle.auditError, undefined);
  assert.equal(maintenanceOnly.calls[0][0], "maintain");

  const completedState = installState();
  const completed = await observer.completeSelfImproveAuditObservation({
    ...base,
    handle: begun.handle,
    status: "completed",
    finishedAt: "2026-07-31T00:02:00.000Z",
    output: "owner output",
  });
  assert.equal(completed.audit?.path, "runs/owner.json");
  assert.equal(completed.auditHandle, begun.handle);
  assert.deepEqual(completed.changedFiles, [
    { path: "owner.ts", change: "updated" },
  ]);
  assert.equal(completed.auditError, undefined);
  assert.deepEqual(
    completedState.calls.map((entry) => entry[0]),
    ["complete", "maintain"],
  );

  installState({
    completeError: new Error("complete owner failure"),
    maintainError: new Error("maintain owner failure"),
  });
  const failed = await observer.completeSelfImproveAuditObservation({
    ...base,
    handle: begun.handle,
    status: "failed",
    finishedAt: "2026-07-31T00:03:00.000Z",
    error: "primary owner failure",
    auditError: "earlier owner failure",
  });
  assert.equal(failed.audit, undefined);
  assert.deepEqual(failed.changedFiles, []);
  assert.match(failed.auditError || "", /earlier owner failure/);
  assert.match(failed.auditError || "", /complete owner failure/);
  assert.match(failed.auditError || "", /maintain owner failure/);

  const ackState = installState();
  assert.equal(
    await observer.acknowledgeSelfImproveAuditObservation({
      agentDir: base.agentDir,
      auditError: "owner existing error",
    }),
    "owner existing error",
  );
  assert.equal(
    await observer.acknowledgeSelfImproveAuditObservation({
      agentDir: base.agentDir,
      handle: begun.handle,
      reference: completed.audit,
    }),
    undefined,
  );
  assert.equal(ackState.calls[0][0], "ack");

  installState({ ackError: new Error("ack owner failure") });
  const ackFailure = await observer.acknowledgeSelfImproveAuditObservation({
    agentDir: base.agentDir,
    handle: begun.handle,
    reference: completed.audit,
    auditError: "earlier owner failure",
  });
  assert.equal(ackFailure, "earlier owner failure; ack owner failure");
});
