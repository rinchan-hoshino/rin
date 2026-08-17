import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const maintenanceQueue = await importBuiltModule<
  typeof import("../../src/core/self-improve/maintenance-queue.js")
>("dist/core/self-improve/maintenance-queue.js");
const selfImprovePaths = await importBuiltModule<
  typeof import("../../src/core/self-improve/paths.js")
>("dist/core/self-improve/paths.js");

async function withTempRoot(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-maintenance-queue-owner-"),
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

test("maintenance queue normalizes identities and keeps leaf jobs distinct", async () => {
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

    await maintenanceQueue.enqueueSelfImproveMaintenanceJob({
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
    await maintenanceQueue.enqueueSelfImproveMaintenanceJob({
      agentDir: root,
      sessionFile: "/tmp/owner-session.jsonl",
      trigger: "owner refresh",
      leafId: "leaf-before",
      additionalExtensionPaths: [],
    });
    queue = await readJson(queuePath);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].trigger, "owner refresh");
    assert.equal(queue[0].leafId, "leaf-before");
    assert.equal(queue[0].additionalExtensionPaths, undefined);
    assert.equal(queue[0].attempts, undefined);
    assert.equal(queue[0].lastError, undefined);
    assert.equal(queue[0].lastAttemptAt, undefined);

    await maintenanceQueue.enqueueSelfImproveMaintenanceJob({
      agentDir: root,
      sessionFile: "/tmp/owner-session.jsonl",
      trigger: "leaf a",
      leafId: " leaf-a ",
    });
    await maintenanceQueue.enqueueSelfImproveMaintenanceJob({
      agentDir: root,
      sessionFile: "/tmp/owner-session.jsonl",
      trigger: "leaf b",
      leafId: "leaf-b",
    });
    queue = await readJson(queuePath);
    assert.deepEqual(
      queue.map((job: any) => job.leafId),
      ["leaf-before", "leaf-a", "leaf-b"],
    );

    await assert.rejects(
      () =>
        maintenanceQueue.enqueueSelfImproveMaintenanceJob({
          agentDir: " ",
          sessionFile: "/tmp/session.jsonl",
        }),
      /maintenance_job_invalid_input/,
    );
    await assert.rejects(
      () =>
        maintenanceQueue.enqueueSelfImproveMaintenanceJob({
          agentDir: root,
          sessionFile: " ",
        }),
      /maintenance_job_invalid_input/,
    );
  });
});

test("maintenance queue migrates legacy claims and preserves requeue identity", async () => {
  await withTempRoot(async (root) => {
    const queuePath = selfImprovePaths.maintenanceQueuePath(root);
    const historyPath = selfImprovePaths.maintenanceHistoryPath(root);
    const base = maintenanceQueue.createMaintenanceJob({
      kind: "self_improve_review",
      agentDir: root,
      sessionFile: "/tmp/queue-session.jsonl",
      leafId: "leaf-a",
      trigger: "owner",
    });
    await fs.mkdir(path.dirname(queuePath), { recursive: true });
    await fs.writeFile(
      queuePath,
      JSON.stringify([
        {
          ...base,
          auditStartedAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    );
    let queue = await maintenanceQueue.loadQueue(root);
    assert.equal(queue[0].executionStartedAt, "2026-01-01T00:00:00.000Z");
    assert.equal("auditStartedAt" in queue[0], false);

    await fs.writeFile(
      historyPath,
      [
        "",
        "not-json",
        JSON.stringify({
          kind: base.kind,
          sessionFile: "/tmp/other.jsonl",
          leafId: base.leafId,
        }),
        JSON.stringify({
          kind: base.kind,
          sessionFile: base.sessionFile,
          leafId: base.leafId,
        }),
      ].join("\n"),
    );
    await fs.rm(queuePath, { force: true });
    await maintenanceQueue.enqueueSelfImproveMaintenanceJob({
      agentDir: root,
      sessionFile: base.sessionFile,
      leafId: base.leafId,
      trigger: "history duplicate",
    });
    assert.deepEqual(await maintenanceQueue.loadQueue(root), []);

    await fs.rm(historyPath, { force: true });
    await maintenanceQueue.saveQueue(root, [base]);
    const updated = { ...base, trigger: "updated" };
    await maintenanceQueue.requeueMaintenanceJob(updated);
    queue = await maintenanceQueue.loadQueue(root);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].trigger, "updated");

    const duplicate = { ...base, id: "different-id" };
    await maintenanceQueue.requeueMaintenanceJob(duplicate);
    assert.equal((await maintenanceQueue.loadQueue(root)).length, 1);

    const distinct = {
      ...base,
      id: "distinct-id",
      leafId: "leaf-b",
    };
    await maintenanceQueue.requeueMaintenanceJob(distinct);
    queue = await maintenanceQueue.loadQueue(root);
    assert.deepEqual(
      queue.map((job) => job.leafId),
      ["leaf-b", "leaf-a"],
    );
  });
});
