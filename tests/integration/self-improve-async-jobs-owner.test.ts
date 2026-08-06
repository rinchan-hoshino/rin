import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { importBuiltModule } from "../support/import-built-module.js";

const execFileAsync = promisify(execFile);
await import("../support/register-async-jobs-private-owner-fixture.ts");
const asyncJobs = await importBuiltModule<
  typeof import("../../src/core/self-improve/async-jobs.js")
>("dist/core/self-improve/async-jobs.js");
const selfImprovePaths = await importBuiltModule<
  typeof import("../../src/core/self-improve/paths.js")
>("dist/core/self-improve/paths.js");
const registerFixture = path.resolve(
  "tests/support/register-async-jobs-owner-fixture.ts",
);

async function withTempRoot(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-async-jobs-owner-"),
  );
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function readJson(filePath: string) {
  return fs.readFile(filePath, "utf8").then(JSON.parse);
}

async function readJsonLines(filePath: string) {
  return (await fs.readFile(filePath, "utf8"))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("maintenance private normalizers cover sparse lock and history boundaries", () => {
  const seam = asyncJobs as any;
  assert.equal(seam.__rinOwnerResolveAgentDir(" "), "");
  assert.equal(seam.__rinOwnerResolveAgentDir("."), process.cwd());
  assert.equal(seam.__rinOwnerResolveSessionFile(" "), "");
  assert.equal(
    seam.__rinOwnerResolveSessionFile("owner.jsonl"),
    path.resolve("owner.jsonl"),
  );
  assert.equal(
    seam.__rinOwnerNormalizeAdditionalExtensionPaths(null),
    undefined,
  );
  assert.deepEqual(
    seam.__rinOwnerNormalizeAdditionalExtensionPaths([" a ", "", "a", "b"]),
    ["a", "b"],
  );
  const base = {
    kind: "self_improve_review",
    agentDir: "/a",
    sessionFile: "/s",
  };
  assert.equal(seam.__rinOwnerSameJob(base, { ...base }), true);
  assert.equal(
    seam.__rinOwnerSameJob(base, { ...base, agentDir: "/b" }),
    false,
  );
  assert.equal(
    seam.__rinOwnerSameJob(
      { ...base, snapshotKey: "one" },
      { ...base, snapshotKey: "two" },
    ),
    false,
  );
  assert.equal(
    seam.__rinOwnerSameJob(
      { ...base, snapshotKey: "one" },
      { ...base, snapshotKey: "one" },
    ),
    true,
  );
  assert.equal(seam.__rinOwnerProcessExists(0), false);
  assert.equal(seam.__rinOwnerProcessExists(process.pid), true);
  assert.equal(seam.__rinOwnerProcessExists(2_147_483_647), false);
  assert.equal(seam.__rinOwnerLockIsExpired(null, Date.now()), true);
  assert.equal(
    seam.__rinOwnerLockIsExpired(
      { updatedAt: new Date().toISOString() },
      Date.now(),
    ),
    false,
  );
  assert.deepEqual(seam.__rinOwnerNormalizeChangedFiles(null), []);
  assert.deepEqual(
    seam.__rinOwnerNormalizeChangedFiles([
      null,
      { path: " a ", change: "created" },
      { path: "b", change: "other" },
    ]),
    [
      { path: "a", change: "created" },
      { path: "b", change: "updated" },
    ],
  );
  assert.equal(seam.__rinOwnerTruncateText(" ", 2), "");
  assert.equal(seam.__rinOwnerTruncateText("abcd", 2), "ab…");
  assert.equal(seam.__rinOwnerTruncateText("ab", 2), "ab");
  assert.equal(
    seam.__rinOwnerNormalizeErrorMessage(new Error("owner")),
    "owner",
  );
  assert.equal(
    seam.__rinOwnerNormalizeErrorMessage(null),
    "maintenance_job_failed",
  );
  const digest = "a".repeat(64);
  assert.equal(seam.__rinOwnerNormalizeAuditReference(null), undefined);
  assert.equal(
    seam.__rinOwnerNormalizeAuditReference({ path: "owner", sha256: "bad" }),
    undefined,
  );
  assert.deepEqual(
    seam.__rinOwnerNormalizeAuditReference({
      path: " owner.json ",
      sha256: digest,
      auditId: "b".repeat(64),
      complete: true,
      redacted: true,
      truncated: true,
    }),
    {
      version: 1,
      auditId: "b".repeat(64),
      path: "owner.json",
      sha256: digest,
      complete: true,
      redacted: true,
      truncated: true,
    },
  );
  assert.equal(seam.__rinOwnerRecoverHistoryText(""), "");
  assert.equal(seam.__rinOwnerRecoverHistoryText("{}\n"), "{}\n");
  assert.equal(seam.__rinOwnerRecoverHistoryText("{}"), "{}\n");
  assert.equal(seam.__rinOwnerRecoverHistoryText("broken"), "");
  assert.equal(seam.__rinOwnerRecoverHistoryText('{}\n{"broken"'), "{}\n");
  assert.equal(
    seam.__rinOwnerPersistedExecutionStartedAt({
      executionStartedAt: " owner-started ",
    }),
    "owner-started",
  );
  const emptyLock = seam.__rinOwnerLockPayload();
  assert.equal(emptyLock.pid, process.pid);
  assert.match(emptyLock.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(emptyLock.updatedAt, emptyLock.createdAt);
  assert.equal(emptyLock.activeJob, undefined);
  const activeLock = seam.__rinOwnerLockPayload({
    id: "owner-job",
    kind: "self_improve_review",
    createdAt: emptyLock.createdAt,
    updatedAt: emptyLock.updatedAt,
    agentDir: "/owner",
    sessionFile: "/owner/session.jsonl",
    leafId: "owner-leaf",
    trigger: "owner-trigger",
    snapshotKey: "owner-snapshot",
  });
  assert.deepEqual(activeLock.activeJob, {
    id: "owner-job",
    kind: "self_improve_review",
    trigger: "owner-trigger",
    sessionFile: "/owner/session.jsonl",
    leafId: "owner-leaf",
    snapshotKey: "owner-snapshot",
  });
});

test("queued worker supervisor is bounded when no runnable queue exists", async () => {
  await withTempRoot(async (root) => {
    assert.equal(asyncJobs.spawnQueuedMemoryWorker(root), false);
    const queuePath = selfImprovePaths.maintenanceQueuePath(root);
    await fs.mkdir(path.dirname(queuePath), { recursive: true });
    await fs.writeFile(queuePath, "not-json");
    assert.equal(asyncJobs.spawnQueuedMemoryWorker(root), false);
    await fs.writeFile(
      queuePath,
      JSON.stringify([{ kind: "session_summary" }, null]),
    );
    assert.equal(asyncJobs.spawnQueuedMemoryWorker(root), false);

    const supervisor = asyncJobs.startQueuedMemoryWorkerSupervisor(root, {
      intervalMs: 1,
    });
    assert.equal(supervisor.wake(), false);
    supervisor.stop();
    assert.equal(supervisor.wake(), false);
    const defaultSupervisor = asyncJobs.startQueuedMemoryWorkerSupervisor(root);
    defaultSupervisor.stop();
    defaultSupervisor.stop();
  });
});

test("maintenance queue normalizes identities and keeps snapshot jobs distinct", async () => {
  await withTempRoot(async (root) => {
    const queuePath = selfImprovePaths.maintenanceQueuePath(root);
    await fs.mkdir(path.dirname(queuePath), { recursive: true });
    await fs.writeFile(
      queuePath,
      JSON.stringify([
        {
          id: "legacy-summary",
          kind: "session_summary",
          agentDir: root,
          sessionFile: "/tmp/legacy.jsonl",
        },
      ]),
    );

    await asyncJobs.enqueueSelfImproveMaintenanceJob({
      agentDir: ` ${root} `,
      sessionFile: " /tmp/owner-session.jsonl ",
      trigger: "",
      leafId: " leaf-before ",
      additionalExtensionPaths: [
        " /tmp/ext-a.ts ",
        "/tmp/ext-a.ts",
        "",
        " /tmp/ext-b.ts ",
      ],
    });
    let queue = await readJson(queuePath);
    assert.equal(queue.length, 1);
    assert.match(queue[0].id, /^maintenance_job_/);
    assert.equal(queue[0].kind, "self_improve_review");
    assert.equal(queue[0].trigger, "self_improve:review");
    assert.equal(queue[0].agentDir, path.resolve(root));
    assert.equal(queue[0].sessionFile, "/tmp/owner-session.jsonl");
    assert.equal(queue[0].leafId, "leaf-before");
    assert.deepEqual(queue[0].additionalExtensionPaths, [
      "/tmp/ext-a.ts",
      "/tmp/ext-b.ts",
    ]);

    queue[0].attempts = 4;
    queue[0].lastError = "stale";
    queue[0].lastAttemptAt = "2026-01-01T00:00:00.000Z";
    await fs.writeFile(queuePath, JSON.stringify(queue));
    await asyncJobs.enqueueSelfImproveMaintenanceJob({
      agentDir: root,
      sessionFile: "/tmp/owner-session.jsonl",
      trigger: "owner refresh",
      leafId: "leaf-after",
      additionalExtensionPaths: [],
    });
    queue = await readJson(queuePath);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].trigger, "owner refresh");
    assert.equal(queue[0].leafId, "leaf-after");
    assert.equal(queue[0].additionalExtensionPaths, undefined);
    assert.equal(queue[0].attempts, undefined);
    assert.equal(queue[0].lastError, undefined);
    assert.equal(queue[0].lastAttemptAt, undefined);

    await asyncJobs.enqueueSelfImproveMaintenanceJob({
      agentDir: root,
      sessionFile: "/tmp/owner-session.jsonl",
      trigger: "snapshot a",
      snapshotKey: " snapshot:a ",
    });
    await asyncJobs.enqueueSelfImproveMaintenanceJob({
      agentDir: root,
      sessionFile: "/tmp/owner-session.jsonl",
      trigger: "snapshot b",
      snapshotKey: "snapshot:b",
    });
    queue = await readJson(queuePath);
    assert.deepEqual(
      queue.map((job: any) => job.snapshotKey),
      [undefined, "snapshot:a", "snapshot:b"],
    );

    await assert.rejects(
      () =>
        asyncJobs.enqueueSelfImproveMaintenanceJob({
          agentDir: " ",
          sessionFile: "/tmp/session.jsonl",
        }),
      /maintenance_job_invalid_input/,
    );
    await assert.rejects(
      () =>
        asyncJobs.enqueueSelfImproveMaintenanceJob({
          agentDir: root,
          sessionFile: " ",
        }),
      /maintenance_job_invalid_input/,
    );
  });
});

test("queue processing appends immutable failure history and reclaims stale locks", async () => {
  await withTempRoot(async (root) => {
    assert.deepEqual(await asyncJobs.processQueuedSelfImproveJobs("  "), {
      skipped: "no-agent-dir",
    });
    const missing = path.join(root, "missing.jsonl");
    const empty = path.join(root, "empty.jsonl");
    await fs.writeFile(empty, "");
    await asyncJobs.enqueueSelfImproveMaintenanceJob({
      agentDir: root,
      sessionFile: missing,
      trigger: "missing",
    });
    await asyncJobs.enqueueSelfImproveMaintenanceJob({
      agentDir: root,
      sessionFile: empty,
      trigger: "empty",
    });
    const queuePath = selfImprovePaths.maintenanceQueuePath(root);
    const queue = await readJson(queuePath);
    queue[1].attempts = 2;
    await fs.writeFile(queuePath, JSON.stringify(queue));

    const lockPath = selfImprovePaths.maintenanceLockPath(root);
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        createdAt: "2000-01-01T00:00:00.000Z",
        updatedAt: "2000-01-01T00:00:00.000Z",
      }),
    );
    const result = await asyncJobs.processQueuedSelfImproveJobs(root);
    assert.deepEqual(result, {
      skipped: "",
      processed: 0,
      failed: 2,
      retried: 0,
    });
    assert.deepEqual(await readJson(queuePath), []);
    await assert.rejects(() => fs.readFile(lockPath), /ENOENT/);

    const historyPath = selfImprovePaths.maintenanceHistoryPath(root);
    const history = await readJsonLines(historyPath);
    assert.equal(history.length, 2);
    assert.deepEqual(
      history.map((record: any) => ({
        status: record.status,
        trigger: record.trigger,
        attempts: record.attempts,
      })),
      [
        { status: "failed", trigger: "missing", attempts: 1 },
        { status: "failed", trigger: "empty", attempts: 3 },
      ],
    );
    assert.match(history[0].error, /maintenance_job_missing_session_file/);
    assert.match(history[1].error, /maintenance_job_invalid_session_file/);

    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    assert.deepEqual(await asyncJobs.processQueuedSelfImproveJobs(root), {
      skipped: "locked",
    });
    await fs.rm(lockPath, { force: true });

    await fs.writeFile(lockPath, "not-json");
    assert.deepEqual(await asyncJobs.processQueuedSelfImproveJobs(root), {
      skipped: "locked",
    });
    await fs.rm(lockPath, { force: true });

    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    assert.deepEqual(await asyncJobs.processQueuedSelfImproveJobs(root), {
      skipped: "",
      processed: 0,
      failed: 0,
      retried: 0,
    });
    await assert.rejects(() => fs.readFile(lockPath), /ENOENT/);
  });
});

test("queue processing finalizes a persisted interrupted execution", async () => {
  await withTempRoot(async (root) => {
    const sessionFile = path.join(root, "interrupted.jsonl");
    await fs.writeFile(sessionFile, '{"type":"session","id":"owner"}\n');
    await asyncJobs.enqueueSelfImproveMaintenanceJob({
      agentDir: root,
      sessionFile,
      trigger: "interrupted-owner",
    });
    const queuePath = selfImprovePaths.maintenanceQueuePath(root);
    const queue = await readJson(queuePath);
    queue[0].executionStartedAt = "2026-07-31T00:00:00.000Z";
    await fs.writeFile(queuePath, JSON.stringify(queue));

    assert.deepEqual(await asyncJobs.processQueuedSelfImproveJobs(root), {
      skipped: "",
      processed: 0,
      failed: 1,
      retried: 0,
    });
    await assert.rejects(() => readJson(queuePath), /ENOENT/);
    const history = await readJsonLines(
      selfImprovePaths.maintenanceHistoryPath(root),
    );
    assert.equal(history.at(-1)?.status, "failed");
    assert.equal(
      history.at(-1)?.error,
      "maintenance_job_interrupted_execution",
    );
  });
});

test("synchronous maintenance validates sessions before entering its processor", async () => {
  await withTempRoot(async (root) => {
    const missing = await asyncJobs.runSelfImproveMaintenanceJobNow({
      agentDir: root,
      sessionFile: path.join(root, "missing.jsonl"),
      trigger: "missing-now",
    });
    assert.deepEqual(missing.status, "failed");
    assert.match(String((missing as any).error), /missing_session_file/);

    const emptyPath = path.join(root, "empty.jsonl");
    await fs.writeFile(emptyPath, "");
    const empty = await asyncJobs.runSelfImproveMaintenanceJobNow({
      agentDir: root,
      sessionFile: emptyPath,
      trigger: "empty-now",
      snapshotKey: "snapshot:empty",
    });
    assert.deepEqual(empty.status, "failed");
    assert.match(String((empty as any).error), /invalid_session_file/);

    const history = await readJsonLines(
      selfImprovePaths.maintenanceHistoryPath(root),
    );
    assert.deepEqual(
      history.map((record: any) => ({
        status: record.status,
        trigger: record.trigger,
        snapshotKey: record.snapshotKey,
      })),
      [
        { status: "failed", trigger: "missing-now", snapshotKey: undefined },
        {
          status: "failed",
          trigger: "empty-now",
          snapshotKey: "snapshot:empty",
        },
      ],
    );
  });
  assert.equal(asyncJobs.spawnQueuedMemoryWorker("  "), false);
});

const childScript = String.raw`
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.RIN_TEST_ASYNC_JOBS_ROOT;
const paths = await import(pathToFileURL(path.resolve("dist/core/self-improve/paths.js")).href);
globalThis.__rinAsyncJobsOwnerCalls = [];
globalThis.__rinAsyncJobsOwnerBehaviors = [];
const jobs = await import(pathToFileURL(path.resolve("dist/core/self-improve/async-jobs.js")).href);
const sessionA = path.join(root, "session-a.jsonl");
const sessionB = path.join(root, "session-b.jsonl");
const sessionC = path.join(root, "session-c.jsonl");
await fs.writeFile(sessionA, "{}\n");
await fs.writeFile(sessionB, "{}\n");
await fs.writeFile(sessionC, "{}\n");

globalThis.__rinAsyncJobsOwnerBehaviors.push(
  {
    result: {
      skipped: "owner-skip",
      output: "x".repeat(900),
      changedFiles: [
        { path: " created.md ", change: "created" },
        { path: "updated.md", change: "unexpected" },
        { path: "", change: "deleted" },
        null,
      ],
    },
  },
  { throwMessage: "queued owner failure" },
);
await jobs.enqueueSelfImproveMaintenanceJob({
  agentDir: root,
  sessionFile: sessionA,
  leafId: "leaf-a",
  trigger: "queued-success",
  snapshotKey: "snapshot:a",
  additionalExtensionPaths: ["/tmp/owner-ext.ts"],
});
await jobs.enqueueSelfImproveMaintenanceJob({
  agentDir: root,
  sessionFile: sessionB,
  trigger: "queued-failure",
});
const processed = await jobs.processQueuedSelfImproveJobs(root);
assert.deepEqual(processed, { skipped: "", processed: 1, failed: 1, retried: 0 });

globalThis.__rinAsyncJobsOwnerBehaviors.push(
  {
    result: {
      sessionSummary: " summary fallback ",
      changedFiles: [{ path: "deleted.md", change: "deleted" }],
    },
  },
  { throwMessage: "now owner failure" },
);
const completed = await jobs.runSelfImproveMaintenanceJobNow({
  agentDir: root,
  sessionFile: sessionC,
  trigger: "now-success",
});
assert.equal(completed.status, "completed");
const failed = await jobs.runSelfImproveMaintenanceJobNow({
  agentDir: root,
  sessionFile: sessionC,
  trigger: "now-failure",
});
assert.deepEqual(failed, { status: "failed", error: "now owner failure" });

globalThis.__rinAsyncJobsOwnerRemoveQueue = async () => {
  await fs.rm(paths.maintenanceQueuePath(root), { force: true });
};
globalThis.__rinAsyncJobsOwnerBehaviors.push({
  beforeThrow: "__rinAsyncJobsOwnerRemoveQueue",
  throwMessage: "requeue missing owner failure",
});
await jobs.enqueueSelfImproveMaintenanceJob({
  agentDir: root,
  sessionFile: sessionC,
  trigger: "requeue-missing",
});
const requeued = await jobs.processQueuedSelfImproveJobs(root);
assert.deepEqual(requeued, { skipped: "", processed: 0, failed: 1, retried: 0 });

const history = (await fs.readFile(paths.maintenanceHistoryPath(root), "utf8"))
  .trim().split(/\r?\n/).map(JSON.parse);
assert.equal(history.length, 5);
assert.equal(history[0].status, "completed");
assert.equal(history[0].skipped, "owner-skip");
assert.equal(history[0].outputPreview.length, 801);
assert.match(history[0].outputPreview, /…$/);
assert.deepEqual(history[0].changedFiles, [
  { path: "created.md", change: "created" },
  { path: "updated.md", change: "updated" },
]);
assert.equal(history[1].status, "failed");
assert.equal(history[1].error, "queued owner failure");
assert.equal(history[2].outputPreview, "summary fallback");
assert.deepEqual(history[2].changedFiles, [
  { path: "deleted.md", change: "deleted" },
]);
assert.equal(history[3].error, "now owner failure");
assert.equal(history[4].error, "requeue missing owner failure");
assert.deepEqual(
  globalThis.__rinAsyncJobsOwnerCalls.map(({ trigger, sessionFile }) => ({ trigger, sessionFile })),
  [
    { trigger: "queued-success", sessionFile: sessionA },
    { trigger: "queued-failure", sessionFile: sessionB },
    { trigger: "now-success", sessionFile: sessionC },
    { trigger: "now-failure", sessionFile: sessionC },
    { trigger: "requeue-missing", sessionFile: sessionC },
  ],
);
assert.equal(jobs.spawnQueuedMemoryWorker(""), false);
console.log(JSON.stringify({ processed, history: history.length, calls: globalThis.__rinAsyncJobsOwnerCalls.length }));
`;

test("maintenance processor records completed and failed jobs through its maintainer boundary", async () => {
  await withTempRoot(async (root) => {
    const result = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        registerFixture,
        "--input-type=module",
        "-e",
        childScript,
      ],
      {
        cwd: path.resolve("."),
        env: { ...process.env, RIN_TEST_ASYNC_JOBS_ROOT: root },
      },
    );
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      processed: { skipped: "", processed: 1, failed: 1, retried: 0 },
      history: 5,
      calls: 5,
    });
  });
});

test("maintenance history sanitization and audit identity remain private and idempotent", async () => {
  await withTempRoot(async (root) => {
    const sanitized = asyncJobs.sanitizeMaintenanceHistoryRecord({
      id: "sanitize-owner",
      kind: "self_improve_review",
      status: "completed",
      trigger: "Authorization: Bearer trigger-secret",
      sessionFile: "password=session-secret",
      leafId: "token=leaf-secret",
      snapshotKey: "api_key=snapshot-secret",
      startedAt: "2026-07-28T15:00:00.000Z",
      finishedAt: "2026-07-28T15:01:00.000Z",
      attempts: 1,
      outputPreview: `Bearer output-secret ${"x".repeat(900)}`,
      changedFiles: [{ path: "password=path-secret", change: "created" }],
    } as any);
    assert.equal(sanitized.historyRedacted, true);
    assert.equal(sanitized.outputPreview!.length <= 801, true);
    assert.doesNotMatch(
      JSON.stringify(sanitized),
      /trigger-secret|path-secret/,
    );
    const sparse = asyncJobs.sanitizeMaintenanceHistoryRecord({
      id: "sparse-owner",
      kind: "self_improve_review",
      status: "skipped",
      startedAt: "2026-07-28T15:02:00.000Z",
      attempts: 0,
      outputPreview: undefined,
      changedFiles: undefined,
    } as any);
    assert.equal(sparse.outputPreview, undefined);
    assert.equal(sparse.changedFiles, undefined);

    const base = {
      id: "history-owner",
      kind: "self_improve_review" as const,
      status: "completed" as const,
      trigger: "owner",
      sessionFile: "/sessions/owner.jsonl",
      startedAt: "2026-07-28T16:00:00.000Z",
      finishedAt: "2026-07-28T16:01:00.000Z",
      attempts: 1,
    };
    await asyncJobs.appendMaintenanceHistoryRecord(root, base);
    await asyncJobs.appendMaintenanceHistoryRecord(root, base);
    await asyncJobs.appendMaintenanceHistoryRecord(root, {
      ...base,
      startedAt: "2026-07-28T16:02:00.000Z",
    });

    const audit = {
      version: 1 as const,
      auditId: "audit-owner",
      path: "self_improve/state/run-audits/owner.json",
      sha256: "a".repeat(64),
      status: "completed" as const,
      complete: true,
      redacted: false,
      truncated: false,
    };
    const audited = {
      ...base,
      id: "audited-history-owner",
      startedAt: "2026-07-28T17:00:00.000Z",
      audit,
    };
    await asyncJobs.appendMaintenanceHistoryRecord(root, audited);
    await asyncJobs.appendMaintenanceHistoryRecord(root, audited);
    await assert.rejects(
      () =>
        asyncJobs.appendMaintenanceHistoryRecord(root, {
          ...audited,
          audit: { ...audit, sha256: "b".repeat(64) },
        }),
      /self_improve_audit_history_corrupt/,
    );

    const history = await readJsonLines(
      selfImprovePaths.maintenanceHistoryPath(root),
    );
    assert.equal(history.length, 3);
    assert.match(history[1].id, /^history-owner@/);
    assert.equal(history[2].audit.auditId, "audit-owner");
  });
});
