import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const auth = await importBuiltModule(
  "dist/core/rin-install/update-job-auth.js",
);

async function writeJob(installDir: string, id: string, status = "running") {
  const jobDir = path.join(installDir, "data", "core", "updates", "jobs");
  await fs.mkdir(jobDir, { recursive: true });
  const jobPath = path.join(jobDir, `${id}.json`);
  await fs.writeFile(
    jobPath,
    `${JSON.stringify({ version: 1, id, status })}\n`,
    { mode: 0o600 },
  );
  return jobPath;
}

test("update payload accepts only a running executor-owned job", async () => {
  const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-job-auth-"));
  try {
    const id = "rin-update-owner";
    const jobPath = await writeJob(installDir, id);
    const env = auth.updateJobProcessEnvironment(jobPath, id, {
      HOME: "/home/owner",
    });
    assert.deepEqual(auth.assertAuthorizedUpdateJob(installDir, env), {
      id,
      path: jobPath,
    });
    assert.deepEqual(auth.forwardedUpdateJobEnvironment(env), {
      RIN_UPDATE_JOB_PATH: jobPath,
      RIN_UPDATE_JOB_ID: id,
    });
  } finally {
    await fs.rm(installDir, { recursive: true, force: true });
  }
});

test("legacy prepared handoff activates exactly one parent-owned running job", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-update-handoff-"),
  );
  const jobDir = path.join(installDir, "data", "core", "updates", "jobs");
  await fs.mkdir(jobDir, { recursive: true });
  const jobPath = path.join(jobDir, "handoff.json");
  await fs.writeFile(
    jobPath,
    `${JSON.stringify({
      version: 1,
      id: "handoff",
      status: "running",
      pid: 4242,
    })}\n`,
  );
  try {
    const env: NodeJS.ProcessEnv = {};
    assert.deepEqual(
      auth.activateLegacyUpdateHandoff(
        ["--update", "--preconfirmed", "--install-dir", installDir],
        installDir,
        env,
        4242,
      ),
      ["--preconfirmed", "--install-dir", installDir],
    );
    assert.deepEqual(auth.forwardedUpdateJobEnvironment(env), {
      RIN_UPDATE_JOB_PATH: jobPath,
      RIN_UPDATE_JOB_ID: "handoff",
    });
    assert.throws(
      () =>
        auth.activateLegacyUpdateHandoff(
          ["--update", "--install-dir", installDir],
          installDir,
          {},
          4242,
        ),
      /rin_installer_update_entry_removed/,
    );
    assert.throws(
      () =>
        auth.activateLegacyUpdateHandoff(
          ["--update", "--preconfirmed"],
          installDir,
          {},
          7,
        ),
      /rin_installer_update_entry_removed/,
    );
  } finally {
    await fs.rm(installDir, { recursive: true, force: true });
  }
});

test("update payload rejects direct, stale, and out-of-root invocations", async () => {
  assert.deepEqual(auth.forwardedUpdateJobEnvironment({}), {});
  assert.deepEqual(auth.forwardedUpdateJobEnvironment(), {});
  assert.equal(
    auth.updateJobProcessEnvironment("/owner/job.json", "owner-job")
      .RIN_UPDATE_JOB_ID,
    "owner-job",
  );
  assert.throws(
    () => auth.assertAuthorizedUpdateJob("", {}),
    /rin_update_job_authorization_required/,
  );
  const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-job-auth-"));
  const outsideDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-job-outside-"),
  );
  try {
    assert.throws(
      () => auth.assertAuthorizedUpdateJob(installDir, {}),
      /rin_update_job_authorization_required/,
    );
    const queuedPath = await writeJob(installDir, "queued", "queued");
    assert.throws(
      () =>
        auth.assertAuthorizedUpdateJob(
          installDir,
          auth.updateJobProcessEnvironment(queuedPath, "queued", {}),
        ),
      /rin_update_job_authorization_required/,
    );
    const outsidePath = path.join(outsideDir, "outside.json");
    await fs.writeFile(
      outsidePath,
      `${JSON.stringify({ version: 1, id: "outside", status: "running" })}\n`,
    );
    assert.throws(
      () =>
        auth.assertAuthorizedUpdateJob(
          installDir,
          auth.updateJobProcessEnvironment(outsidePath, "outside", {}),
        ),
      /rin_update_job_authorization_required/,
    );
  } finally {
    await fs.rm(installDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});
