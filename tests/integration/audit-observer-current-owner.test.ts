import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { importBuiltModule } from "../support/import-built-module.ts";

await import("../support/register-audit-observer-owner-fixture.ts");

const observer = await importBuiltModule<
  typeof import("../../src/core/self-improve/audit-observer.ts")
>("dist/core/self-improve/audit-observer.js");

interface OwnerState {
  calls: unknown[][];
  beginError?: unknown;
  completeError?: unknown;
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
  assert.deepEqual(begun.capture, {
    auditId: "owner-audit",
    runId: "owner-run",
  });
  assert.equal(beginState.calls[0][0], "begin");

  installState({ beginError: new Error("begin owner failure") });
  const beginFailure = await observer.beginSelfImproveAuditObservation(base);
  assert.equal(beginFailure.capture, undefined);
  assert.match(beginFailure.auditError || "", /begin owner failure/);

  const withoutCapture = await observer.completeSelfImproveAuditObservation({
    ...base,
    status: "completed",
    finishedAt: "2026-07-31T00:01:00.000Z",
    output: "owner output",
  });
  assert.equal(withoutCapture.audit, undefined);
  assert.deepEqual(withoutCapture.changedFiles, []);

  const completedState = installState();
  const completed = await observer.completeSelfImproveAuditObservation({
    ...base,
    capture: begun.capture,
    status: "completed",
    finishedAt: "2026-07-31T00:02:00.000Z",
    output: "owner output",
  });
  assert.equal(completed.audit?.path, "runs/owner.json");
  assert.deepEqual(completed.changedFiles, [
    { path: "owner.ts", change: "updated" },
  ]);
  assert.deepEqual(
    completedState.calls.map((entry) => entry[0]),
    ["complete"],
  );

  installState({ completeError: new Error("complete owner failure") });
  const failed = await observer.completeSelfImproveAuditObservation({
    ...base,
    capture: begun.capture,
    status: "failed",
    finishedAt: "2026-07-31T00:03:00.000Z",
    error: "primary owner failure",
    auditError: "earlier owner failure",
  });
  assert.equal(failed.audit, undefined);
  assert.deepEqual(failed.changedFiles, []);
  assert.equal(
    failed.auditError,
    "earlier owner failure; complete owner failure",
  );
});
