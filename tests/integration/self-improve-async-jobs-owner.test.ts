import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { importBuiltModule } from "../support/import-built-module.js";

const execFileAsync = promisify(execFile);
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

const history = (await fs.readFile(paths.maintenanceHistoryPath(root), "utf8"))
  .trim().split(/\r?\n/).map(JSON.parse);
assert.equal(history.length, 4);
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
assert.deepEqual(
  globalThis.__rinAsyncJobsOwnerCalls.map(({ trigger, sessionFile }) => ({ trigger, sessionFile })),
  [
    { trigger: "queued-success", sessionFile: sessionA },
    { trigger: "queued-failure", sessionFile: sessionB },
    { trigger: "now-success", sessionFile: sessionC },
    { trigger: "now-failure", sessionFile: sessionC },
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
      history: 4,
      calls: 4,
    });
  });
});
