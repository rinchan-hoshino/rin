import "../support/require-test-sandbox.ts";
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
  beginSelfImproveRunAudit,
  completeSelfImproveRunAudit,
  resolveSafeSelfImprovePath,
  sanitizeSelfImproveHistoryText,
  verifySelfImproveRunAudit,
} from "../../dist/core/self-improve/run-audit.js";

function writeManagedFile(
  agentDir: string,
  relativePath: string,
  content: string | Buffer,
) {
  const filePath = path.join(agentDir, "self_improve", relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function readAudit(agentDir: string, relativePath: string) {
  return JSON.parse(fs.readFileSync(path.join(agentDir, relativePath), "utf8"));
}

test("maintenance history keeps distinct audited identities", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "rin-audit-history-"));
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
  try {
    await appendMaintenanceHistoryRecord(agentDir, record("a"));
    await appendMaintenanceHistoryRecord(agentDir, record("b"));
    await appendMaintenanceHistoryRecord(agentDir, record("b"));
    const rows = fs
      .readFileSync(
        path.join(
          agentDir,
          "self_improve",
          "state",
          "maintenance-history.jsonl",
        ),
        "utf8",
      )
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 2);
    assert.equal(rows[1].id, "same-display-id@bbbbbbbbbbbb");
    assert.equal(rows[1].runId, "same-display-id");
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("maintenance history repairs a torn tail and sanitizes evidence", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "rin-audit-history-"));
  const historyPath = path.join(
    agentDir,
    "self_improve",
    "state",
    "maintenance-history.jsonl",
  );
  try {
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
    assert.equal(fs.statSync(historyPath).mode & 0o777, 0o600);
    assert.equal(
      fs.readFileSync(historyPath, "utf8").trim().split("\n").length,
      2,
    );

    const secret = "sk-test-historyabcdefghijklmnopqrstuvwxyz";
    const sanitized = sanitizeMaintenanceHistoryRecord({
      id: "run-history",
      kind: "self_improve_review",
      status: "failed",
      trigger: `token=${secret}`,
      sessionFile: `/tmp/${secret}.jsonl`,
      startedAt: "2026-07-28T06:00:00.000Z",
      finishedAt: "2026-07-28T06:01:00.000Z",
      attempts: 1,
      outputPreview: `Authorization: Bearer ${secret}`,
      changedFiles: [{ path: `/tmp/${secret}/SKILL.md`, change: "updated" }],
    });
    assert.equal(JSON.stringify(sanitized).includes(secret), false);
    assert.equal(sanitized.historyRedacted, true);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("audit start keeps the before snapshot only in memory", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "rin-audit-memory-"));
  try {
    writeManagedFile(agentDir, "skills/demo/SKILL.md", "before\n");
    const capture = await beginSelfImproveRunAudit({
      agentDir,
      runId: "memory-only",
      kind: "self_improve_review",
      startedAt: "2026-08-12T06:00:00.000Z",
    });
    assert.equal(capture.before.entries.length, 1);
    assert.equal(
      fs.existsSync(path.join(agentDir, "self_improve", "state")),
      false,
    );
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("audit completion writes one exact final artifact", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "rin-audit-final-"));
  try {
    writeManagedFile(agentDir, "skills/demo/SKILL.md", "old value\n");
    writeManagedFile(agentDir, "prompts/delete.md", "remove me\n");
    const capture = await beginSelfImproveRunAudit({
      agentDir,
      runId: "create-update-delete",
      kind: "self_improve_review",
      startedAt: "2026-08-12T06:00:00.000Z",
      source: { leafId: "leaf-1", trigger: "manual" },
    });
    writeManagedFile(agentDir, "skills/demo/SKILL.md", "new value\n");
    writeManagedFile(agentDir, "skills/new/SKILL.md", "# New\n");
    fs.rmSync(path.join(agentDir, "self_improve", "prompts", "delete.md"));

    const reference = await completeSelfImproveRunAudit({
      agentDir,
      capture,
      status: "completed",
      finishedAt: "2026-08-12T06:01:00.000Z",
      output: "done",
    });
    assert.deepEqual(
      fs.readdirSync(path.join(agentDir, "self_improve", "state")),
      ["run-audits"],
    );
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
    assert.equal(artifact.output.text, "done");
    assert.equal(artifact.changes.length, 3);
    assert.match(
      artifact.changes.find((x: any) => x.change === "updated").patch,
      /-old value[\s\S]*\+new value/,
    );
    assert.match(
      artifact.changes.find((x: any) => x.change === "created").patch,
      /\+# New/,
    );
    assert.match(
      artifact.changes.find((x: any) => x.change === "deleted").patch,
      /-remove me/,
    );
    assert.deepEqual(await verifySelfImproveRunAudit(agentDir, reference), {
      ok: true,
    });
    await assert.rejects(
      () =>
        completeSelfImproveRunAudit({
          agentDir,
          capture,
          status: "failed",
          finishedAt: "2026-08-12T06:02:00.000Z",
          error: "must not replace the completed artifact",
        }),
      (error: any) => error?.code === "EEXIST",
    );
    assert.equal(readAudit(agentDir, reference.path).status, "completed");
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("audit redacts and bounds metadata, patches, output, and binary changes", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "rin-audit-bounds-"));
  const secret = "sk-test-metadataabcdefghijklmnopqrstuvwxyz";
  try {
    writeManagedFile(agentDir, `skills/${secret}/SKILL.md`, "before\n");
    const capture = await beginSelfImproveRunAudit({
      agentDir,
      runId: `run-${secret}`,
      kind: "self_improve_review",
      startedAt: "2026-08-12T06:00:00.000Z",
      source: {
        sessionFile: `/tmp/${secret}.jsonl`,
        trigger: `token=${secret}`,
      },
      policy: { maxOutputBytes: 32, maxErrorBytes: 32, maxPatchBytes: 64 },
    });
    writeManagedFile(
      agentDir,
      `skills/${secret}/SKILL.md`,
      Buffer.from([0, 1, 2]),
    );
    const reference = await completeSelfImproveRunAudit({
      agentDir,
      capture,
      status: "failed",
      finishedAt: "2026-08-12T06:01:00.000Z",
      output: `Authorization: Bearer ${secret}`,
      error: `token=${secret}`,
    });
    const raw = fs.readFileSync(path.join(agentDir, reference.path), "utf8");
    assert.equal(raw.includes(secret), false);
    assert.equal(reference.complete, false);
    assert.equal(reference.redacted, true);
    assert.equal(reference.truncated, true);
    assert.equal(JSON.parse(raw).changes[0].patchUnavailable, true);
    assert.deepEqual(sanitizeSelfImproveHistoryText("é", 1), {
      text: "",
      redacted: false,
      truncated: true,
    });
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("audit rejects invalid policy, time, outside paths, and symlinks", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "rin-audit-safe-"));
  try {
    await assert.rejects(
      () =>
        beginSelfImproveRunAudit({
          agentDir,
          runId: "invalid-policy",
          kind: "review",
          startedAt: "2026-08-12T06:00:00.000Z",
          policy: { maxOutputBytes: 0 },
        }),
      /self_improve_audit_invalid_policy:maxOutputBytes/,
    );
    await assert.rejects(
      () =>
        beginSelfImproveRunAudit({
          agentDir,
          runId: "invalid-time",
          kind: "review",
          startedAt: "not-a-time",
        }),
      /self_improve_audit_invalid_timestamp/,
    );
    await assert.rejects(
      () => resolveSafeSelfImprovePath(agentDir, path.join(agentDir, "..")),
      /self_improve_audit_path_outside_agent_dir/,
    );
    fs.mkdirSync(path.join(agentDir, "self_improve"), { recursive: true });
    fs.symlinkSync(os.tmpdir(), path.join(agentDir, "self_improve", "skills"));
    await assert.rejects(
      () =>
        beginSelfImproveRunAudit({
          agentDir,
          runId: "symlink",
          kind: "review",
          startedAt: "2026-08-12T06:00:00.000Z",
        }),
      /self_improve_audit_symlink_path/,
    );
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("audit retention bounds completed artifacts without acknowledgment state", async () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-audit-retention-"),
  );
  try {
    writeManagedFile(agentDir, "skills/demo/SKILL.md", "zero\n");
    for (let index = 1; index <= 3; index += 1) {
      const capture = await beginSelfImproveRunAudit({
        agentDir,
        runId: `run:${index}`,
        kind: "self_improve_review",
        startedAt: `2026-08-12T06:0${index}:00.000Z`,
        policy: { maxArtifacts: 2, maxAgeMs: 86_400_000 },
      });
      writeManagedFile(agentDir, "skills/demo/SKILL.md", `${index}\n`);
      await completeSelfImproveRunAudit({
        agentDir,
        capture,
        status: "completed",
        finishedAt: `2026-08-12T06:0${index}:30.000Z`,
        output: `run ${index}`,
        nowMs: Date.parse("2026-08-12T07:00:00.000Z"),
      });
    }
    const files = fs
      .readdirSync(path.join(agentDir, "self_improve", "state", "run-audits"), {
        recursive: true,
      })
      .filter((entry) => String(entry).endsWith(".json"));
    assert.equal(files.length, 2);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("audit verification distinguishes unavailable evidence from invalid evidence", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "rin-audit-verify-"));
  try {
    const capture = await beginSelfImproveRunAudit({
      agentDir,
      runId: "verify",
      kind: "review",
      startedAt: "2026-08-12T06:00:00.000Z",
    });
    const reference = await completeSelfImproveRunAudit({
      agentDir,
      capture,
      status: "completed",
      finishedAt: "2026-08-12T06:01:00.000Z",
    });
    const artifactPath = path.join(agentDir, reference.path);
    fs.appendFileSync(artifactPath, "tampered");
    assert.deepEqual(await verifySelfImproveRunAudit(agentDir, reference), {
      ok: false,
      error: "sha256_mismatch",
    });
    fs.rmSync(artifactPath);
    assert.deepEqual(await verifySelfImproveRunAudit(agentDir, reference), {
      ok: false,
      error: "artifact_unavailable",
    });
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("self-improve maintenance lock serializes audit attribution", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "rin-audit-lock-"));
  try {
    const first = await acquireSelfImproveMaintenanceLock(agentDir, 0);
    assert.ok(first);
    let resolved = false;
    const secondPromise = acquireSelfImproveMaintenanceLock(
      agentDir,
      2_000,
    ).then((handle) => {
      resolved = true;
      return handle;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(resolved, false);
    await releaseSelfImproveMaintenanceLock(agentDir, first);
    const second = await secondPromise;
    assert.ok(second);
    await releaseSelfImproveMaintenanceLock(agentDir, second);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});
