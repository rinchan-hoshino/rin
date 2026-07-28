import { strict as assert } from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireSelfImproveMaintenanceLock,
  appendMaintenanceHistoryRecord,
  releaseSelfImproveMaintenanceLock,
  sanitizeMaintenanceHistoryRecord,
} from "../../dist/core/self-improve/async-jobs.js";
import {
  acknowledgeSelfImproveRunAudit,
  beginSelfImproveRunAudit,
  completeSelfImproveRunAudit,
  markSelfImproveRunAuditExecutionStarted,
  verifySelfImproveRunAudit,
} from "../../dist/core/self-improve/run-audit.js";

function writeManagedFile(
  agentDir: string,
  relativePath: string,
  content: string,
) {
  const filePath = path.join(agentDir, "self_improve", relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function readAudit(agentDir: string, relativePath: string) {
  return JSON.parse(fs.readFileSync(path.join(agentDir, relativePath), "utf8"));
}

test("maintenance history keeps distinct audited identities instead of deduplicating by display id", async () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-history-identity-"),
  );
  const record = (value: string) => ({
    id: "same-display-id",
    kind: "self_improve_review" as const,
    status: "completed" as const,
    trigger: "manual",
    startedAt: `2026-07-28T0${value === "a" ? "6" : "7"}:00:00.000Z`,
    finishedAt: `2026-07-28T0${value === "a" ? "6" : "7"}:01:00.000Z`,
    attempts: 1,
    audit: {
      version: 1 as const,
      auditId: value.repeat(64),
      path: `self_improve/state/run-audits/${value}.json`,
      sha256: value.repeat(64),
      complete: true,
      redacted: false,
      truncated: false,
    },
  });
  await appendMaintenanceHistoryRecord(agentDir, record("a"));
  await appendMaintenanceHistoryRecord(agentDir, record("b"));
  await appendMaintenanceHistoryRecord(agentDir, record("b"));
  const conflicting = record("b");
  conflicting.audit.sha256 = "c".repeat(64);
  await assert.rejects(
    () => appendMaintenanceHistoryRecord(agentDir, conflicting),
    /self_improve_audit_history_corrupt/,
  );
  const misattributed = record("b");
  misattributed.id = "different-run-id";
  await assert.rejects(
    () => appendMaintenanceHistoryRecord(agentDir, misattributed),
    /self_improve_audit_history_corrupt/,
  );
  const rows = fs
    .readFileSync(
      path.join(agentDir, "self_improve", "state", "maintenance-history.jsonl"),
      "utf8",
    )
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, "same-display-id");
  assert.equal(rows[1].id, "same-display-id@bbbbbbbbbbbb");
  assert.equal(rows[1].runId, "same-display-id");
});

test("maintenance history atomically repairs a torn trailing row and is private", async () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-history-torn-"),
  );
  const historyPath = path.join(
    agentDir,
    "self_improve",
    "state",
    "maintenance-history.jsonl",
  );
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.writeFileSync(
    historyPath,
    `${JSON.stringify({ id: "legacy", status: "completed" })}\n{"id":`,
    { mode: 0o644 },
  );
  await appendMaintenanceHistoryRecord(agentDir, {
    id: "new-run",
    kind: "self_improve_review",
    status: "completed",
    trigger: "manual",
    startedAt: "2026-07-28T06:00:00.000Z",
    finishedAt: "2026-07-28T06:01:00.000Z",
    attempts: 1,
  });
  const rows = fs
    .readFileSync(historyPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    rows.map((row) => row.id),
    ["legacy", "new-run"],
  );
  assert.equal(fs.statSync(historyPath).mode & 0o777, 0o600);
});

test("maintenance history redacts bounded output, errors, source paths, and changed paths", () => {
  const secret = "sk-test-historyabcdefghijklmnopqrstuvwxyz";
  const credentialPhrase = "credential value with spaces";
  const sanitized = sanitizeMaintenanceHistoryRecord({
    id: "run-history",
    kind: "self_improve_review",
    status: "failed",
    trigger: `token=${secret}`,
    sessionFile: `/tmp/${secret}.jsonl`,
    startedAt: "2026-07-28T06:00:00.000Z",
    finishedAt: "2026-07-28T06:01:00.000Z",
    attempts: 1,
    outputPreview: `GOOGLE_APPLICATION_CREDENTIALS=${credentialPhrase}`,
    error: `AWS_SHARED_CREDENTIALS_FILE=${credentialPhrase}`,
    changedFiles: [
      {
        path: `/tmp/${secret}/SKILL.md`,
        change: "updated",
      },
    ],
  });
  const raw = JSON.stringify(sanitized);
  assert.equal(raw.includes(secret), false);
  assert.equal(raw.includes(credentialPhrase), false);
  assert.equal(sanitized.historyRedacted, true);
  assert.match(sanitized.outputPreview || "", /\[REDACTED\]/);
  assert.match(sanitized.error || "", /\[REDACTED\]/);
  assert.match(sanitized.sessionFile || "", /\[REDACTED\]/);
  assert.match(sanitized.changedFiles?.[0]?.path || "", /\[REDACTED\]/);
});

test("self-improve run audit rejects non-ISO timestamp path input", async () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-audit-time-"),
  );
  await assert.rejects(
    () =>
      beginSelfImproveRunAudit({
        agentDir,
        runId: "run:bad-time",
        kind: "self_improve_review",
        startedAt: "../../outside",
      }),
    /self_improve_audit_invalid_timestamp/,
  );
});

test("self-improve run audit rejects symlinked managed and audit storage roots", async () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-audit-link-"),
  );
  const outside = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-audit-outside-"),
  );
  fs.mkdirSync(path.join(agentDir, "self_improve"), { recursive: true });
  fs.symlinkSync(outside, path.join(agentDir, "self_improve", "skills"));
  await assert.rejects(
    () =>
      beginSelfImproveRunAudit({
        agentDir,
        runId: "run:symlink",
        kind: "self_improve_review",
        startedAt: "2026-07-28T06:00:00.000Z",
      }),
    /self_improve_audit_symlink_path/,
  );
  fs.rmSync(path.join(agentDir, "self_improve", "skills"));
  fs.mkdirSync(path.join(agentDir, "self_improve", "state"), {
    recursive: true,
  });
  fs.symlinkSync(
    outside,
    path.join(agentDir, "self_improve", "state", "run-audits-pending"),
  );
  await assert.rejects(
    () =>
      beginSelfImproveRunAudit({
        agentDir,
        runId: "run:symlink-state",
        kind: "self_improve_review",
        startedAt: "2026-07-28T06:01:00.000Z",
      }),
    /self_improve_audit_symlink_path/,
  );
});

test("self-improve run audit preserves exact create/update/delete patches and output evidence", async () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-audit-"),
  );
  writeManagedFile(agentDir, "skills/demo/SKILL.md", "# Demo\n\nold value\n");
  writeManagedFile(agentDir, "prompts/delete-me.md", "remove me\n");

  const handle = await beginSelfImproveRunAudit({
    agentDir,
    runId: "run:create-update-delete",
    kind: "self_improve_review",
    startedAt: "2026-07-28T06:00:00.000Z",
    source: {
      sessionFile: "/tmp/source.jsonl",
      leafId: "leaf-1",
      snapshotKey: "snapshot-1",
      trigger: "periodic_review",
    },
  });

  writeManagedFile(agentDir, "skills/demo/SKILL.md", "# Demo\n\nnew value\n");
  writeManagedFile(agentDir, "skills/new/SKILL.md", "# New\n");
  fs.rmSync(path.join(agentDir, "self_improve", "prompts", "delete-me.md"));

  const reference = await completeSelfImproveRunAudit({
    agentDir,
    handle,
    status: "completed",
    finishedAt: "2026-07-28T06:01:00.000Z",
    output: "changed demo guidance",
  });

  assert.equal(reference.version, 1);
  assert.equal(reference.complete, true);
  assert.equal(reference.redacted, false);
  assert.equal(reference.truncated, false);
  assert.match(reference.path, /^self_improve\/state\/run-audits\//);

  const artifactPath = path.join(agentDir, reference.path);
  assert.equal(fs.statSync(artifactPath).mode & 0o777, 0o600);
  assert.equal(
    crypto
      .createHash("sha256")
      .update(fs.readFileSync(artifactPath))
      .digest("hex"),
    reference.sha256,
  );

  const artifact = readAudit(agentDir, reference.path);
  assert.equal(artifact.runId, "run:create-update-delete");
  assert.equal(artifact.source.leafId, "leaf-1");
  assert.equal(artifact.output.text, "changed demo guidance");
  assert.equal(artifact.output.sha256.length, 64);
  assert.equal(artifact.changes.length, 3);

  const updated = artifact.changes.find(
    (entry: any) => entry.change === "updated",
  );
  const created = artifact.changes.find(
    (entry: any) => entry.change === "created",
  );
  const deleted = artifact.changes.find(
    (entry: any) => entry.change === "deleted",
  );
  assert.match(updated.patch, /-old value/);
  assert.match(updated.patch, /\+new value/);
  assert.match(created.patch, /\+# New/);
  assert.match(deleted.patch, /-remove me/);
  assert.equal(updated.beforeSha256.length, 64);
  assert.equal(updated.afterSha256.length, 64);

  assert.equal(fs.existsSync(path.join(agentDir, handle.pendingPath)), true);
  await acknowledgeSelfImproveRunAudit({ agentDir, handle, reference });
  assert.equal(fs.existsSync(path.join(agentDir, handle.pendingPath)), false);
  assert.deepEqual(await verifySelfImproveRunAudit(agentDir, reference), {
    ok: true,
  });
  assert.deepEqual(
    await verifySelfImproveRunAudit(agentDir, {
      ...reference,
      complete: !reference.complete,
    }),
    { ok: false, error: "reference_metadata_mismatch" },
  );
});

test("self-improve run audit redacts credentials and marks bounded evidence as incomplete", async () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-audit-secret-"),
  );
  writeManagedFile(agentDir, "skills/demo/SKILL.md", "# Demo\n");
  const handle = await beginSelfImproveRunAudit({
    agentDir,
    runId: "run:secret",
    kind: "self_improve_review",
    startedAt: "2026-07-28T06:00:00.000Z",
    policy: { maxOutputBytes: 80, maxPatchBytes: 120 },
  });
  const secret = "sk-test-abcdefghijklmnopqrstuvwxyz0123456789";
  const spacedSecret = "correct horse battery staple";
  writeManagedFile(
    agentDir,
    "skills/demo/SKILL.md",
    `# Demo\nOPENAI_API_KEY=${spacedSecret}\nGOOGLE_APPLICATION_CREDENTIALS=${spacedSecret}\n${"x".repeat(200)}\n`,
  );
  const reference = await completeSelfImproveRunAudit({
    agentDir,
    handle,
    status: "completed",
    finishedAt: "2026-07-28T06:01:00.000Z",
    output: `{"password":"${spacedSecret}"}\nAuthorization=Custom ${secret}\n${"result ".repeat(40)}`,
  });

  const raw = fs.readFileSync(path.join(agentDir, reference.path), "utf8");
  assert.equal(raw.includes(secret), false);
  assert.equal(raw.includes(spacedSecret), false);
  assert.match(raw, /\[REDACTED\]/);
  assert.equal(reference.redacted, true);
  assert.equal(reference.truncated, true);
  assert.equal(reference.complete, false);
  const artifact = JSON.parse(raw);
  assert.equal(artifact.output.truncated, true);
  assert.equal(artifact.changes[0].patchTruncated, true);
});

test("self-improve audit UTF-8 truncation never exceeds byte limits", async () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-audit-utf8-"),
  );
  const handle = await beginSelfImproveRunAudit({
    agentDir,
    runId: "run:utf8",
    kind: "self_improve_review",
    startedAt: "2026-07-28T06:00:00.000Z",
    policy: { maxOutputBytes: 1 },
  });
  const reference = await completeSelfImproveRunAudit({
    agentDir,
    handle,
    status: "completed",
    finishedAt: "2026-07-28T06:01:00.000Z",
    output: "🙂",
  });
  const artifact = JSON.parse(
    fs.readFileSync(path.join(agentDir, reference.path), "utf8"),
  );
  assert.ok(Buffer.byteLength(artifact.output.text, "utf8") <= 1);
  assert.equal(artifact.output.text.includes("�"), false);
  assert.equal(artifact.output.truncated, true);
});

test("self-improve run audit marks changed binary evidence incomplete", async () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-audit-binary-"),
  );
  writeManagedFile(agentDir, "skills/demo/SKILL.md", "before\n");
  const handle = await beginSelfImproveRunAudit({
    agentDir,
    runId: "run:binary",
    kind: "self_improve_review",
    startedAt: "2026-07-28T06:00:00.000Z",
  });
  const filePath = path.join(
    agentDir,
    "self_improve",
    "skills",
    "demo",
    "SKILL.md",
  );
  fs.writeFileSync(filePath, Buffer.from([0, 1, 2, 3]));
  const reference = await completeSelfImproveRunAudit({
    agentDir,
    handle,
    status: "completed",
    finishedAt: "2026-07-28T06:01:00.000Z",
    output: "done",
  });
  assert.equal(reference.complete, false);
  assert.equal(reference.truncated, true);
  const artifact = readAudit(agentDir, reference.path);
  assert.equal(artifact.changes[0].patchUnavailable, true);
});

test("pending audit policy and snapshot evidence are integrity protected", async () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-audit-pending-integrity-"),
  );
  const handle = await beginSelfImproveRunAudit({
    agentDir,
    runId: "run:pending-integrity",
    kind: "self_improve_review",
    startedAt: "2026-07-28T06:00:00.000Z",
  });
  const pendingPath = path.join(agentDir, handle.pendingPath);
  const pending = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
  pending.policy.maxOutputBytes = 1;
  fs.writeFileSync(pendingPath, `${JSON.stringify(pending)}\n`, {
    mode: 0o600,
  });
  await assert.rejects(
    () =>
      completeSelfImproveRunAudit({
        agentDir,
        handle,
        status: "completed",
        finishedAt: "2026-07-28T06:01:00.000Z",
        output: "done",
      }),
    /self_improve_audit_pending_mismatch/,
  );
});

test("integrity-consistent pending evidence still validates its persisted policy", async () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-audit-pending-policy-"),
  );
  const input = {
    agentDir,
    runId: "run:pending-policy",
    kind: "self_improve_review",
    startedAt: "2026-07-28T06:00:00.000Z",
  };
  const handle = await beginSelfImproveRunAudit(input);
  const pendingPath = path.join(agentDir, handle.pendingPath);
  const pending = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
  pending.policy.maxAgeMs = "forever";
  const { integritySha256: _oldIntegrity, ...unsigned } = pending;
  pending.integritySha256 = crypto
    .createHash("sha256")
    .update(JSON.stringify(unsigned))
    .digest("hex");
  fs.writeFileSync(pendingPath, `${JSON.stringify(pending, null, 2)}\n`, {
    mode: 0o600,
  });
  await assert.rejects(
    () => beginSelfImproveRunAudit(input),
    /self_improve_audit_invalid_policy/,
  );
});

test("default policy blocks a distinct run while prior audit evidence is unresolved", async () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-audit-pending-capacity-"),
  );
  await beginSelfImproveRunAudit({
    agentDir,
    runId: "run:pending-capacity-1",
    kind: "self_improve_review",
    startedAt: "2026-07-28T06:00:00.000Z",
  });
  await assert.rejects(
    () =>
      beginSelfImproveRunAudit({
        agentDir,
        runId: "run:pending-capacity-2",
        kind: "self_improve_review",
        startedAt: "2026-07-28T07:00:00.000Z",
      }),
    /self_improve_audit_pending_capacity/,
  );
});

test("pending and execution recovery state must remain private regular files", async () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-audit-private-state-"),
  );
  const input = {
    agentDir,
    runId: "run:private-state",
    kind: "self_improve_review",
    startedAt: "2026-07-28T06:00:00.000Z",
  };
  const pendingHandle = await beginSelfImproveRunAudit(input);
  fs.chmodSync(path.join(agentDir, pendingHandle.pendingPath), 0o644);
  await assert.rejects(
    () => beginSelfImproveRunAudit(input),
    /self_improve_audit_pending_mismatch/,
  );

  const secondAgentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-audit-private-marker-"),
  );
  const markerInput = { ...input, agentDir: secondAgentDir };
  const markerHandle = await beginSelfImproveRunAudit(markerInput);
  await markSelfImproveRunAuditExecutionStarted({
    agentDir: secondAgentDir,
    handle: markerHandle,
  });
  fs.chmodSync(
    path.join(secondAgentDir, markerHandle.executionStartedPath),
    0o644,
  );
  await assert.rejects(
    () => beginSelfImproveRunAudit(markerInput),
    /self_improve_audit_pending_mismatch/,
  );
});

test("renamed execution markers and finalized artifacts fail closed", async () => {
  const markerAgentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-audit-renamed-marker-"),
  );
  const markerInput = {
    agentDir: markerAgentDir,
    runId: "run:renamed-marker",
    kind: "self_improve_review",
    startedAt: "2026-07-28T06:00:00.000Z",
  };
  const markerHandle = await beginSelfImproveRunAudit(markerInput);
  await markSelfImproveRunAuditExecutionStarted({
    agentDir: markerAgentDir,
    handle: markerHandle,
  });
  const markerPath = path.join(
    markerAgentDir,
    markerHandle.executionStartedPath,
  );
  fs.renameSync(markerPath, `${markerPath}.moved`);
  await assert.rejects(
    () => beginSelfImproveRunAudit(markerInput),
    /self_improve_audit_pending_mismatch/,
  );

  const artifactAgentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-audit-renamed-final-"),
  );
  const artifactInput = {
    ...markerInput,
    agentDir: artifactAgentDir,
    runId: "run:renamed-final",
  };
  const artifactHandle = await beginSelfImproveRunAudit(artifactInput);
  const reference = await completeSelfImproveRunAudit({
    agentDir: artifactAgentDir,
    handle: artifactHandle,
    status: "completed",
    finishedAt: "2026-07-28T06:01:00.000Z",
    output: "done",
  });
  const artifactPath = path.join(artifactAgentDir, reference.path);
  fs.renameSync(artifactPath, `${artifactPath}.moved`);
  await assert.rejects(
    () => beginSelfImproveRunAudit(artifactInput),
    /self_improve_audit_pending_mismatch/,
  );
});

test("completed artifact recovery validates internal integrity before linking", async () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-audit-artifact-integrity-"),
  );
  const startedAt = "2026-07-28T06:00:00.000Z";
  const handle = await beginSelfImproveRunAudit({
    agentDir,
    runId: "run:artifact-integrity",
    kind: "self_improve_review",
    startedAt,
  });
  const reference = await completeSelfImproveRunAudit({
    agentDir,
    handle,
    status: "completed",
    finishedAt: "2026-07-28T06:01:00.000Z",
    output: "trusted",
  });
  const artifactPath = path.join(agentDir, reference.path);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  artifact.output.text = "tampered";
  fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, {
    mode: 0o600,
  });
  await assert.rejects(
    () =>
      beginSelfImproveRunAudit({
        agentDir,
        runId: "run:artifact-integrity",
        kind: "self_improve_review",
        startedAt,
      }),
    /self_improve_audit_pending_mismatch/,
  );
});

test("an interrupted execution marker prevents mutation rerun and finalizes observed changes", async () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-audit-interrupted-"),
  );
  writeManagedFile(agentDir, "skills/demo/SKILL.md", "before\n");
  const input = {
    agentDir,
    runId: "run:interrupted",
    kind: "self_improve_review",
    startedAt: "2020-01-01T06:00:00.000Z",
    policy: { maxAgeMs: 1 },
  };
  const first = await beginSelfImproveRunAudit(input);
  await markSelfImproveRunAuditExecutionStarted({ agentDir, handle: first });
  writeManagedFile(agentDir, "skills/demo/SKILL.md", "after\n");
  const recovered = await beginSelfImproveRunAudit(input);
  assert.equal(recovered.executionInterrupted, true);
  const reference = await completeSelfImproveRunAudit({
    agentDir,
    handle: recovered,
    status: "failed",
    finishedAt: "2026-07-28T06:01:00.000Z",
    error: "self_improve_audit_interrupted_execution",
  });
  const artifact = JSON.parse(
    fs.readFileSync(path.join(agentDir, reference.path), "utf8"),
  );
  assert.equal(artifact.status, "failed");
  assert.equal(artifact.changes.length, 1);
  assert.match(artifact.changes[0].patch, /-before/);
  assert.match(artifact.changes[0].patch, /\+after/);
  assert.equal(fs.existsSync(path.join(agentDir, recovered.pendingPath)), true);
  await acknowledgeSelfImproveRunAudit({
    agentDir,
    handle: recovered,
    reference,
  });
  assert.equal(
    fs.existsSync(path.join(agentDir, recovered.executionStartedPath)),
    false,
  );
});

test("begin audit reuses the original pending snapshot after an interrupted retry", async () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-audit-resume-"),
  );
  writeManagedFile(agentDir, "skills/demo/SKILL.md", "before\n");
  const first = await beginSelfImproveRunAudit({
    agentDir,
    runId: "run:resume",
    kind: "cron",
    startedAt: "2026-07-28T06:00:00.000Z",
  });
  writeManagedFile(agentDir, "skills/demo/SKILL.md", "intermediate\n");
  const resumed = await beginSelfImproveRunAudit({
    agentDir,
    runId: "run:resume",
    kind: "cron",
    startedAt: "2026-07-28T06:00:00.000Z",
  });
  assert.equal(resumed.pendingPath, first.pendingPath);
  writeManagedFile(agentDir, "skills/demo/SKILL.md", "after\n");

  const reference = await completeSelfImproveRunAudit({
    agentDir,
    handle: resumed,
    status: "completed",
    finishedAt: "2026-07-28T06:02:00.000Z",
    output: "done",
  });
  const artifact = readAudit(agentDir, reference.path);
  assert.match(artifact.changes[0].patch, /-before/);
  assert.match(artifact.changes[0].patch, /\+after/);
  assert.doesNotMatch(artifact.changes[0].patch, /intermediate/);
});

test("duplicate run ids keep immutable evidence identities and exact retries reuse the artifact", async () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-audit-id-"),
  );
  writeManagedFile(agentDir, "skills/demo/SKILL.md", "zero\n");

  const firstHandle = await beginSelfImproveRunAudit({
    agentDir,
    runId: "duplicate-run",
    kind: "self_improve_review",
    startedAt: "2026-07-28T06:00:00.000Z",
    source: { leafId: "leaf-1" },
  });
  writeManagedFile(agentDir, "skills/demo/SKILL.md", "one\n");
  const first = await completeSelfImproveRunAudit({
    agentDir,
    handle: firstHandle,
    status: "completed",
    finishedAt: "2026-07-28T06:01:00.000Z",
    output: "first",
  });

  const exactRetryHandle = await beginSelfImproveRunAudit({
    agentDir,
    runId: "duplicate-run",
    kind: "self_improve_review",
    startedAt: "2026-07-28T06:00:00.000Z",
    source: { leafId: "leaf-1" },
  });
  assert.ok(exactRetryHandle.completedPath);
  const exactRetry = await completeSelfImproveRunAudit({
    agentDir,
    handle: exactRetryHandle,
    status: "completed",
    finishedAt: "2026-07-28T06:02:00.000Z",
    output: "must not overwrite",
  });
  assert.equal(exactRetry.path, first.path);
  assert.equal(exactRetry.sha256, first.sha256);
  await acknowledgeSelfImproveRunAudit({
    agentDir,
    handle: exactRetryHandle,
    reference: exactRetry,
  });

  const secondHandle = await beginSelfImproveRunAudit({
    agentDir,
    runId: "duplicate-run",
    kind: "self_improve_review",
    startedAt: "2026-07-28T07:00:00.000Z",
    source: { leafId: "leaf-2" },
  });
  writeManagedFile(agentDir, "skills/demo/SKILL.md", "two\n");
  const second = await completeSelfImproveRunAudit({
    agentDir,
    handle: secondHandle,
    status: "completed",
    finishedAt: "2026-07-28T07:01:00.000Z",
    output: "second",
  });
  assert.notEqual(second.path, first.path);
  assert.deepEqual(await verifySelfImproveRunAudit(agentDir, first), {
    ok: true,
  });
  assert.deepEqual(await verifySelfImproveRunAudit(agentDir, second), {
    ok: true,
  });
});

test("audit redacts and bounds run/source/error metadata", async () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-audit-metadata-"),
  );
  const secret = "sk-test-metadataabcdefghijklmnopqrstuvwxyz";
  writeManagedFile(agentDir, `skills/${secret}/SKILL.md`, "before\n");
  const handle = await beginSelfImproveRunAudit({
    agentDir,
    runId: `run-${secret}`,
    kind: "self_improve_review",
    startedAt: "2026-07-28T06:00:00.000Z",
    source: {
      sessionFile: `/tmp/${secret}.jsonl`,
      trigger: `token=${secret}`,
    },
    policy: { maxErrorBytes: 64 },
  });
  const pendingRaw = fs.readFileSync(
    path.join(agentDir, handle.pendingPath),
    "utf8",
  );
  assert.equal(pendingRaw.includes(secret), false);
  writeManagedFile(agentDir, `skills/${secret}/SKILL.md`, "after\n");
  const reference = await completeSelfImproveRunAudit({
    agentDir,
    handle,
    status: "failed",
    finishedAt: "2026-07-28T06:01:00.000Z",
    error: `authorization: Bearer ${secret}\n${"failure ".repeat(30)}`,
  });
  assert.equal(reference.redacted, true);
  assert.equal(reference.truncated, true);
  assert.equal(reference.complete, false);
  assert.equal(reference.path.includes(secret), false);
  const raw = fs.readFileSync(path.join(agentDir, reference.path), "utf8");
  assert.equal(raw.includes(secret), false);
  const artifact = JSON.parse(raw);
  assert.equal(artifact.error.redacted, true);
  assert.equal(artifact.error.truncated, true);
  assert.match(artifact.source.sessionFile, /\[REDACTED\]/);
  assert.match(artifact.changes[0].path, /\[REDACTED\]/);
});

test("retention expiry keeps a compact acknowledgment that prevents mutation rerun", async () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-audit-no-reuse-"),
  );
  const firstInput = {
    agentDir,
    runId: "run:no-reuse-1",
    kind: "self_improve_review",
    startedAt: "2026-07-28T05:00:00.000Z",
    policy: { maxArtifacts: 1 },
  };
  const first = await beginSelfImproveRunAudit(firstInput);
  const firstReference = await completeSelfImproveRunAudit({
    agentDir,
    handle: first,
    status: "completed",
    finishedAt: "2026-07-28T05:01:00.000Z",
    output: "one",
  });
  await acknowledgeSelfImproveRunAudit({
    agentDir,
    handle: first,
    reference: firstReference,
  });
  const second = await beginSelfImproveRunAudit({
    agentDir,
    runId: "run:no-reuse-2",
    kind: "self_improve_review",
    startedAt: "2026-07-28T06:00:00.000Z",
    policy: { maxArtifacts: 1 },
  });
  const secondReference = await completeSelfImproveRunAudit({
    agentDir,
    handle: second,
    status: "completed",
    finishedAt: "2026-07-28T06:01:00.000Z",
    output: "two",
  });
  await acknowledgeSelfImproveRunAudit({
    agentDir,
    handle: second,
    reference: secondReference,
  });
  assert.equal(fs.existsSync(path.join(agentDir, firstReference.path)), false);
  const replacement = await beginSelfImproveRunAudit(firstInput);
  assert.equal(replacement.auditId, first.auditId);
  assert.equal(replacement.completedPath, firstReference.path);
  assert.ok(replacement.acknowledged);
  const replacementReference = await completeSelfImproveRunAudit({
    agentDir,
    handle: replacement,
    status: "completed",
    finishedAt: "2026-07-28T07:01:00.000Z",
    output: "replacement",
  });
  assert.equal(replacementReference.path, firstReference.path);
  assert.equal(replacementReference.evidenceRetained, false);
});

test("age expiry never replaces a completed artifact that is still awaiting history acknowledgment", async () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-audit-unacked-expiry-"),
  );
  const input = {
    agentDir,
    runId: "run:unacked-expiry",
    kind: "self_improve_review",
    startedAt: "2020-01-01T00:00:00.000Z",
    policy: { maxAgeMs: 1 },
  };
  const handle = await beginSelfImproveRunAudit(input);
  const reference = await completeSelfImproveRunAudit({
    agentDir,
    handle,
    status: "completed",
    finishedAt: "2020-01-01T00:01:00.000Z",
    output: "unacknowledged",
  });
  fs.rmSync(path.join(agentDir, handle.pendingPath), { force: true });
  const recovered = await beginSelfImproveRunAudit(input);
  assert.equal(recovered.auditId, handle.auditId);
  assert.equal(recovered.completedPath, reference.path);
  assert.equal(fs.existsSync(path.join(agentDir, reference.path)), true);
});

test("valid pre-link artifact temporary files are promoted during recovery", async () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-audit-temp-recovery-"),
  );
  const input = {
    agentDir,
    runId: "run:temp-recovery",
    kind: "self_improve_review",
    startedAt: "2026-07-28T06:00:00.000Z",
  };
  const handle = await beginSelfImproveRunAudit(input);
  const reference = await completeSelfImproveRunAudit({
    agentDir,
    handle,
    status: "completed",
    finishedAt: "2026-07-28T06:01:00.000Z",
    output: "recover temp",
  });
  const artifactPath = path.join(agentDir, reference.path);
  const tempPath = `${artifactPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.renameSync(artifactPath, tempPath);
  const recovered = await beginSelfImproveRunAudit(input);
  assert.equal(recovered.completedPath, reference.path);
  assert.equal(fs.existsSync(artifactPath), true);
  assert.equal(fs.existsSync(tempPath), false);
});

test("acknowledgment markers are bound to their canonical private path", async () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-audit-marker-path-"),
  );
  const input = {
    agentDir,
    runId: "run:marker-path",
    kind: "self_improve_review",
    startedAt: "2026-07-28T06:00:00.000Z",
  };
  const handle = await beginSelfImproveRunAudit(input);
  const reference = await completeSelfImproveRunAudit({
    agentDir,
    handle,
    status: "completed",
    finishedAt: "2026-07-28T06:01:00.000Z",
    output: "done",
  });
  await acknowledgeSelfImproveRunAudit({ agentDir, handle, reference });
  fs.rmSync(path.join(agentDir, reference.path), { force: true });
  const markerDir = path.join(
    agentDir,
    "self_improve",
    "state",
    "run-audits-acknowledged",
  );
  const markerName = fs.readdirSync(markerDir)[0];
  fs.renameSync(
    path.join(markerDir, markerName),
    path.join(markerDir, `renamed-${markerName}.moved`),
  );
  await assert.rejects(
    () => beginSelfImproveRunAudit(input),
    /self_improve_audit_pending_mismatch/,
  );
});

test("age-expired acknowledged evidence remains a no-rerun tombstone", async () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-audit-age-expiry-"),
  );
  const input = {
    agentDir,
    runId: "run:age-expiry",
    kind: "self_improve_review",
    startedAt: "2020-01-01T00:00:00.000Z",
    policy: { maxAgeMs: 1 },
  };
  const first = await beginSelfImproveRunAudit(input);
  const firstReference = await completeSelfImproveRunAudit({
    agentDir,
    handle: first,
    status: "completed",
    finishedAt: "2020-01-01T00:01:00.000Z",
    output: "first",
  });
  await acknowledgeSelfImproveRunAudit({
    agentDir,
    handle: first,
    reference: firstReference,
  });
  const replacement = await beginSelfImproveRunAudit(input);
  assert.equal(replacement.auditId, first.auditId);
  assert.equal(replacement.completedPath, firstReference.path);
  assert.ok(replacement.acknowledged);
  assert.equal(fs.existsSync(path.join(agentDir, firstReference.path)), false);
});

test("retention applies each artifact persisted policy instead of the current run policy", async () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-audit-policy-isolation-"),
  );
  const first = await beginSelfImproveRunAudit({
    agentDir,
    runId: "run:policy-long",
    kind: "self_improve_review",
    startedAt: "2026-07-28T06:00:00.000Z",
    policy: { maxArtifacts: 500, maxAgeMs: 30 * 24 * 60 * 60 * 1000 },
  });
  const firstReference = await completeSelfImproveRunAudit({
    agentDir,
    handle: first,
    status: "completed",
    finishedAt: "2026-07-28T06:01:00.000Z",
    output: "long retention",
  });
  await acknowledgeSelfImproveRunAudit({
    agentDir,
    handle: first,
    reference: firstReference,
  });
  const second = await beginSelfImproveRunAudit({
    agentDir,
    runId: "run:policy-short",
    kind: "self_improve_review",
    startedAt: "2026-07-28T09:00:00.000Z",
    policy: { maxArtifacts: 1, maxAgeMs: 1 },
  });
  await completeSelfImproveRunAudit({
    agentDir,
    handle: second,
    status: "completed",
    finishedAt: "2026-07-28T09:01:00.000Z",
    output: "short retention",
    nowMs: Date.parse("2026-07-28T09:01:00.100Z"),
  });
  assert.equal(fs.existsSync(path.join(agentDir, firstReference.path)), true);
});

test("retention refuses to delete completed evidence without a valid acknowledgment marker", async () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-audit-retention-unacked-"),
  );
  const first = await beginSelfImproveRunAudit({
    agentDir,
    runId: "run:retention-unacked-1",
    kind: "self_improve_review",
    startedAt: "2026-07-28T05:00:00.000Z",
    policy: { maxArtifacts: 1 },
  });
  const firstReference = await completeSelfImproveRunAudit({
    agentDir,
    handle: first,
    status: "completed",
    finishedAt: "2026-07-28T05:01:00.000Z",
    output: "unacknowledged",
  });
  fs.rmSync(path.join(agentDir, first.pendingPath), { force: true });
  const second = await beginSelfImproveRunAudit({
    agentDir,
    runId: "run:retention-unacked-2",
    kind: "self_improve_review",
    startedAt: "2026-07-28T06:00:00.000Z",
    policy: { maxArtifacts: 1 },
  });
  await completeSelfImproveRunAudit({
    agentDir,
    handle: second,
    status: "completed",
    finishedAt: "2026-07-28T06:01:00.000Z",
    output: "second",
  });
  assert.equal(fs.existsSync(path.join(agentDir, firstReference.path)), true);
});

test("retention validates every artifact before deleting any evidence", async () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-audit-retention-corrupt-"),
  );
  const first = await beginSelfImproveRunAudit({
    agentDir,
    runId: "run:retention-corrupt-1",
    kind: "self_improve_review",
    startedAt: "2026-07-28T05:00:00.000Z",
    policy: { maxArtifacts: 1 },
  });
  const firstReference = await completeSelfImproveRunAudit({
    agentDir,
    handle: first,
    status: "completed",
    finishedAt: "2026-07-28T05:01:00.000Z",
    output: "one",
  });
  await acknowledgeSelfImproveRunAudit({
    agentDir,
    handle: first,
    reference: firstReference,
  });
  const firstPath = path.join(agentDir, firstReference.path);
  const corrupt = JSON.parse(fs.readFileSync(firstPath, "utf8"));
  corrupt.finishedAt = "not-a-time";
  fs.writeFileSync(firstPath, `${JSON.stringify(corrupt, null, 2)}\n`, {
    mode: 0o600,
  });
  await assert.rejects(() =>
    beginSelfImproveRunAudit({
      agentDir,
      runId: "run:retention-corrupt-2",
      kind: "self_improve_review",
      startedAt: "2026-07-28T06:00:00.000Z",
      policy: { maxArtifacts: 1 },
    }),
  );
  assert.equal(fs.existsSync(firstPath), true);
  const auditFiles = fs
    .readdirSync(path.join(agentDir, "self_improve", "state", "run-audits"), {
      recursive: true,
    })
    .filter((entry) => String(entry).endsWith(".json"));
  assert.equal(auditFiles.length, 1);
});

test("retention protects completed artifacts that still have pending recovery markers", async () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-audit-retention-pending-"),
  );
  const first = await beginSelfImproveRunAudit({
    agentDir,
    runId: "run:retention-pending-1",
    kind: "self_improve_review",
    startedAt: "2026-07-28T05:00:00.000Z",
    policy: { maxArtifacts: 1 },
  });
  const pendingPath = path.join(agentDir, first.pendingPath);
  const pendingEvidence = fs.readFileSync(pendingPath);
  const firstReference = await completeSelfImproveRunAudit({
    agentDir,
    handle: first,
    status: "completed",
    finishedAt: "2026-07-28T05:01:00.000Z",
    output: "one",
  });
  fs.mkdirSync(path.dirname(pendingPath), { recursive: true });
  fs.writeFileSync(pendingPath, pendingEvidence, { mode: 0o600 });
  await assert.rejects(
    () =>
      beginSelfImproveRunAudit({
        agentDir,
        runId: "run:retention-pending-2",
        kind: "self_improve_review",
        startedAt: "2026-07-28T06:00:00.000Z",
      }),
    /self_improve_audit_pending_capacity/,
  );
  assert.equal(fs.existsSync(path.join(agentDir, firstReference.path)), true);
});

test("retention preserves the artifact currently being finalized before history links it", async () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-audit-retain-current-"),
  );
  const handle = await beginSelfImproveRunAudit({
    agentDir,
    runId: "run:retain-current",
    kind: "self_improve_review",
    startedAt: "2020-01-01T00:00:00.000Z",
    policy: { maxArtifacts: 1, maxAgeMs: 1 },
  });
  const reference = await completeSelfImproveRunAudit({
    agentDir,
    handle,
    status: "completed",
    finishedAt: "2020-01-01T00:01:00.000Z",
    output: "done",
    nowMs: Date.parse("2030-01-01T00:00:00.000Z"),
  });
  assert.equal(fs.existsSync(path.join(agentDir, reference.path)), true);
});

test("audit retention keeps the newest bounded set", async () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-audit-retention-"),
  );
  writeManagedFile(agentDir, "skills/demo/SKILL.md", "zero\n");
  for (let index = 1; index <= 3; index += 1) {
    const handle = await beginSelfImproveRunAudit({
      agentDir,
      runId: `run:${index}`,
      kind: "self_improve_review",
      startedAt: `2026-07-28T06:0${index}:00.000Z`,
      policy: { maxArtifacts: 2, maxAgeMs: 86_400_000 },
    });
    writeManagedFile(agentDir, "skills/demo/SKILL.md", `${index}\n`);
    const reference = await completeSelfImproveRunAudit({
      agentDir,
      handle,
      status: "completed",
      finishedAt: `2026-07-28T06:0${index}:30.000Z`,
      output: `run ${index}`,
      nowMs: Date.parse("2026-07-28T07:00:00.000Z"),
    });
    await acknowledgeSelfImproveRunAudit({ agentDir, handle, reference });
  }
  const auditRoot = path.join(agentDir, "self_improve", "state", "run-audits");
  const files = fs
    .readdirSync(auditRoot, { recursive: true })
    .filter((entry) => String(entry).endsWith(".json"));
  assert.equal(files.length, 2);
  assert.equal(
    files.some((entry) => String(entry).includes("run_1")),
    false,
  );
});

test("self-improve maintenance lock serializes audit attribution across runners", async () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-audit-lock-"),
  );
  const first = await acquireSelfImproveMaintenanceLock(agentDir, 0);
  assert.ok(first);
  let secondResolved = false;
  const secondPromise = acquireSelfImproveMaintenanceLock(agentDir, 2_000).then(
    (handle) => {
      secondResolved = true;
      return handle;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(secondResolved, false);
  await releaseSelfImproveMaintenanceLock(agentDir, first);
  const second = await secondPromise;
  assert.ok(second);
  await releaseSelfImproveMaintenanceLock(agentDir, second);
});

test("audit integrity verification detects tampering", async () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-self-improve-audit-tamper-"),
  );
  writeManagedFile(agentDir, "skills/demo/SKILL.md", "before\n");
  const handle = await beginSelfImproveRunAudit({
    agentDir,
    runId: "run:tamper",
    kind: "self_improve_review",
    startedAt: "2026-07-28T06:00:00.000Z",
  });
  writeManagedFile(agentDir, "skills/demo/SKILL.md", "after\n");
  const reference = await completeSelfImproveRunAudit({
    agentDir,
    handle,
    status: "completed",
    finishedAt: "2026-07-28T06:01:00.000Z",
    output: "done",
  });
  fs.appendFileSync(path.join(agentDir, reference.path), "\n");
  const verification = await verifySelfImproveRunAudit(agentDir, reference);
  assert.equal(verification.ok, false);
  assert.equal(verification.error, "sha256_mismatch");
});
