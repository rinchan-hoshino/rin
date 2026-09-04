import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { createTestSandbox } from "../support/test-sandbox.js";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const entryPath = path.join(rootDir, "dist", "app", "rin", "restart-job.js");
const sandboxRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "rin-restart-entrypoint-"),
);
const sandbox = await createTestSandbox(sandboxRoot);
after(() => fs.rmSync(sandboxRoot, { recursive: true, force: true }));

function runEntry(jobPath?: string) {
  return spawnSync(
    process.execPath,
    jobPath ? [entryPath, jobPath] : [entryPath],
    {
      cwd: rootDir,
      encoding: "utf8",
      env: sandbox.env,
    },
  );
}

function queuedRecord(jobPath: string, kind = "restart") {
  return {
    version: 1,
    kind,
    id: "rin-restart-entrypoint-owner-test",
    targetUser: "owner-test",
    installDir: path.dirname(path.dirname(path.dirname(jobPath))),
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    cwd: rootDir,
    environment: { PATH: process.env.PATH ?? "" },
    executorEntryPath: entryPath,
    status: { state: "queued", createdAt: "2026-09-04T00:00:00.000Z" },
  };
}

test("restart job entrypoint owns success and invalid job boundaries", () => {
  const tempDir = path.join(sandboxRoot, "case");
  fs.mkdirSync(tempDir, { recursive: true });
  try {
    const missing = runEntry();
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /restart job file was not provided/i);

    const jobPath = path.join(tempDir, "jobs", "restart", "job.json");
    fs.mkdirSync(path.dirname(jobPath), { recursive: true });
    fs.writeFileSync(jobPath, JSON.stringify(queuedRecord(jobPath)));
    const completed = runEntry(jobPath);
    assert.equal(completed.status, 0, completed.stderr);
    assert.equal(
      JSON.parse(fs.readFileSync(jobPath, "utf8")).status.state,
      "succeeded",
    );

    fs.writeFileSync(jobPath, JSON.stringify(queuedRecord(jobPath, "update")));
    const mismatched = runEntry(jobPath);
    assert.equal(mismatched.status, 1);
    assert.match(
      mismatched.stderr,
      /lifecycle job owned by another operation/i,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
