import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const registerFixture = path.resolve(
  "tests/support/register-maintainer-owner-fixture.ts",
);

const childScript = String.raw`
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.RIN_TEST_MAINTAINER_ROOT;
const agentDir = path.join(root, "agent");
const sessionFile = path.join(root, "sessions", "source.jsonl");
const promptDir = path.join(agentDir, "self_improve", "prompts");
const skillsDir = path.join(agentDir, "self_improve", "skills");
const updated = path.join(promptDir, "agent_profile.md");
const deleted = path.join(skillsDir, "old", "SKILL.md");
const unchanged = path.join(skillsDir, "keep", "SKILL.md");
const created = path.join(skillsDir, "new", "SKILL.md");
await fs.mkdir(path.dirname(sessionFile), { recursive: true });
await fs.mkdir(path.dirname(deleted), { recursive: true });
await fs.mkdir(path.dirname(unchanged), { recursive: true });
await fs.mkdir(promptDir, { recursive: true });
await fs.writeFile(sessionFile, "{}\n");
await fs.writeFile(updated, "before\n");
await fs.writeFile(deleted, "delete me\n");
await fs.writeFile(unchanged, "same\n");

globalThis.__rinMaintainerOwnerEvents = [];
globalThis.__rinMaintainerOwnerCwd = " /workspace/project ";
globalThis.__rinMaintainerOwnerFinalText = "  owner review complete  ";
globalThis.__rinMaintainerOwnerAbortFails = true;
globalThis.__rinMaintainerOwnerDisposeFails = true;
globalThis.__rinMaintainerOwnerMutation = async () => {
  await fs.writeFile(updated, "after\n");
  await fs.rm(deleted);
  await fs.mkdir(path.dirname(created), { recursive: true });
  await fs.writeFile(created, "created\n");
};

const maintainer = await import(
  pathToFileURL(path.resolve("dist/core/self-improve/maintainer.js")).href
);
const audit = await import(
  pathToFileURL(path.resolve("dist/core/self-improve/run-audit.js")).href
);
const prompt = maintainer.buildSelfImproveReviewPrompt("ignored-trigger", agentDir);
assert.match(prompt, new RegExp(agentDir.replace(/[.*+?^$()|[\]\\]/g, "\\$&")));
assert.match(prompt, /as the complete contract/);
assert.match(prompt, /Evidence scope: the conversation above/);
assert.match(prompt, /ignored-trigger/);

assert.deepEqual(await maintainer.runMaintainerUnderMaintenanceLock({}, {}), {
  skipped: "no-session-file",
});
const lockPath = path.join(
  agentDir,
  "self_improve",
  "state",
  "maintenance-worker.lock",
);
await fs.mkdir(path.dirname(lockPath), { recursive: true });
const lockHandle = await fs.open(lockPath, "w");
let result;
try {
  result = await maintainer.runMaintainerUnderMaintenanceLock(
    {},
    {
      agentDir,
      sessionFile,
      leafId: "leaf-owner",
      trigger: "  owner-trigger  ",
      additionalExtensionPaths: ["/extensions/owner.ts"],
      runId: "maintainer-owner-run",
      startedAt: "2026-07-28T10:00:00.000Z",
      maintenanceLockHandle: lockHandle,
    },
  );
} finally {
  await lockHandle.close();
}
assert.equal(result.skipped, "");
assert.equal(result.forked, true);
assert.equal(result.saved, true);
assert.equal(result.output, "owner review complete");
assert.deepEqual(
  [...result.changedFiles].sort((a, b) => a.path.localeCompare(b.path)),
  [
    { path: updated, change: "updated" },
    { path: created, change: "created" },
    { path: deleted, change: "deleted" },
  ].sort((a, b) => a.path.localeCompare(b.path)),
);
assert.equal(result.mode, "session");
assert.equal(result.sessionFile, sessionFile);
assert.equal(result.leafId, "leaf-owner");
assert.equal(result.trigger, "owner-trigger");
assert.equal(result.audit.output, "owner review complete");
assert.equal(result.auditHandle.runId, "maintainer-owner-run");
const openEvent = globalThis.__rinMaintainerOwnerEvents.find(([name]) => name === "open");
assert.deepEqual(openEvent, ["open", sessionFile, path.dirname(sessionFile)]);
const forkEvent = globalThis.__rinMaintainerOwnerEvents.find(([name]) => name === "fork");
assert.equal(forkEvent[1][1], sessionFile);
assert.equal(forkEvent[1][2], "/workspace/project");
assert.deepEqual(forkEvent[1][4], {
  persist: false,
  leafId: "leaf-owner",
  preserveSourceSessionId: true,
  disableRoutineCompaction: true,
});
const bindEvent = globalThis.__rinMaintainerOwnerEvents.find(([name]) => name === "bind");
assert.equal(bindEvent[1].cwd, "/workspace/project");
assert.equal(bindEvent[1].agentDir, agentDir);
assert.deepEqual(bindEvent[1].additionalExtensionPaths, ["/extensions/owner.ts"]);
assert.equal("tools" in bindEvent[1], false);
assert.equal("customTools" in bindEvent[1], false);
assert.equal("disabledRinCapabilities" in bindEvent[1], false);
const promptEvent = globalThis.__rinMaintainerOwnerEvents.find(([name]) => name === "prompt");
assert.match(promptEvent[1], /Trigger context.*owner-trigger/);
assert.deepEqual(promptEvent[2], {
  expandPromptTemplates: false,
  source: "builtin:self-improve",
});
assert.deepEqual(
  globalThis.__rinMaintainerOwnerEvents
    .filter(([name]) => ["idle", "abort", "dispose"].includes(name))
    .map(([name]) => name),
  ["idle", "abort", "dispose"],
);

const emptyAgentDir = path.join(root, "empty-agent");
globalThis.__rinMaintainerOwnerEvents.length = 0;
globalThis.__rinMaintainerOwnerCwd = "";
globalThis.__rinMaintainerOwnerFinalText = "";
globalThis.__rinMaintainerOwnerAbortFails = false;
globalThis.__rinMaintainerOwnerDisposeFails = false;
globalThis.__rinMaintainerOwnerMutation = undefined;
const emptyLockPath = path.join(
  emptyAgentDir,
  "self_improve",
  "state",
  "maintenance-worker.lock",
);
await fs.mkdir(path.dirname(emptyLockPath), { recursive: true });
const emptyLockHandle = await fs.open(emptyLockPath, "w");
let emptyResult;
try {
  emptyResult = await maintainer.runMaintainerUnderMaintenanceLock(
    {},
    {
      agentDir: emptyAgentDir,
      trigger: "",
      sessionManager: {
        getSessionFile: () => sessionFile,
        getLeafId: () => "",
      },
      runId: "maintainer-owner-empty",
      startedAt: "2026-07-28T10:01:00.000Z",
      maintenanceLockHandle: emptyLockHandle,
    },
  );
} finally {
  await emptyLockHandle.close();
}
assert.equal(emptyResult.output, "");
assert.deepEqual(emptyResult.changedFiles, []);
assert.equal(emptyResult.leafId, undefined);
assert.equal(emptyResult.trigger, "self_improve:review");
assert.equal(emptyResult.sessionFile, sessionFile);
assert.equal(globalThis.__rinMaintainerOwnerEvents.find(([name]) => name === "bind")[1].cwd.length > 0, true);

async function withMaintenanceLock(targetAgentDir, callback) {
  const targetLockPath = path.join(targetAgentDir, "self_improve", "state", "maintenance-worker.lock");
  await fs.mkdir(path.dirname(targetLockPath), { recursive: true });
  const targetLockHandle = await fs.open(targetLockPath, "w");
  try {
    return await callback(targetLockHandle);
  } finally {
    await targetLockHandle.close();
  }
}

const missingAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-maintainer-missing-owner-"));
await assert.rejects(
  () => withMaintenanceLock(missingAgentDir, (maintenanceLockHandle) =>
    maintainer.runMaintainerUnderMaintenanceLock({}, {
      agentDir: missingAgentDir,
      sessionFile: path.join(missingAgentDir, "missing-session.jsonl"),
      runId: "maintainer-missing-session",
      startedAt: "2026-07-28T14:00:00.000Z",
      maintenanceLockHandle,
    }),
  ),
  /maintenance_job_missing_session_file/,
);

const invalidAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-maintainer-empty-session-owner-"));
const invalidSessionFile = path.join(invalidAgentDir, "session.jsonl");
await fs.writeFile(invalidSessionFile, "");
await assert.rejects(
  () => withMaintenanceLock(invalidAgentDir, (maintenanceLockHandle) =>
    maintainer.runMaintainerUnderMaintenanceLock({}, {
      agentDir: invalidAgentDir,
      sessionFile: invalidSessionFile,
      runId: "maintainer-empty-session",
      startedAt: "2026-07-28T16:00:00.000Z",
      maintenanceLockHandle,
    }),
  ),
  /maintenance_job_invalid_session_file/,
);

globalThis.__rinMaintainerOwnerMutation = async () => {
  throw "primitive owner prompt failure";
};
const primitiveAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-maintainer-primitive-owner-"));
const primitiveSessionFile = path.join(primitiveAgentDir, "session.jsonl");
await fs.writeFile(primitiveSessionFile, '{"type":"session","id":"primitive"}\\n');
await assert.rejects(
  () => withMaintenanceLock(primitiveAgentDir, (maintenanceLockHandle) =>
    maintainer.runMaintainerUnderMaintenanceLock({}, {
      agentDir: primitiveAgentDir,
      sessionFile: primitiveSessionFile,
      runId: "maintainer-primitive-failure",
      startedAt: "2026-07-28T17:00:00.000Z",
      maintenanceLockHandle,
    }),
  ),
  /primitive owner prompt failure/,
);

globalThis.__rinMaintainerOwnerMutation = async () => {};
globalThis.__rinMaintainerOwnerFinalText = "default owner output";
const defaultAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-maintainer-default-owner-"));
const defaultSessionFile = path.join(defaultAgentDir, "session.jsonl");
await fs.writeFile(defaultSessionFile, '{"type":"session","id":"default"}\\n');
const defaultResult = await withMaintenanceLock(defaultAgentDir, (maintenanceLockHandle) =>
  maintainer.runMaintainerUnderMaintenanceLock({}, {
    agentDir: defaultAgentDir,
    sessionFile: defaultSessionFile,
    snapshotKey: "snapshot-owner",
    maintenanceLockHandle,
  }),
);
assert.equal(defaultResult.output, "default owner output");

const directoryAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-maintainer-directory-owner-"));
const directorySessionPath = path.join(directoryAgentDir, "session-dir");
await fs.mkdir(directorySessionPath);
await assert.rejects(
  () => withMaintenanceLock(directoryAgentDir, (maintenanceLockHandle) =>
    maintainer.runMaintainerUnderMaintenanceLock({}, {
      agentDir: directoryAgentDir,
      sessionFile: directorySessionPath,
      runId: "maintainer-directory-session",
      startedAt: "2026-07-28T18:00:00.000Z",
      maintenanceLockHandle,
    }),
  ),
  /maintenance_job_invalid_session_file/,
);

const wrongLockAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-maintainer-wrong-lock-owner-"));
const wrongLockSession = path.join(wrongLockAgentDir, "session.jsonl");
await fs.writeFile(wrongLockSession, '{"type":"session","id":"wrong-lock"}\\n');
const expectedLockPath = path.join(wrongLockAgentDir, "self_improve", "state", "maintenance-worker.lock");
await fs.mkdir(path.dirname(expectedLockPath), { recursive: true });
await fs.writeFile(expectedLockPath, "expected");
const wrongLockHandle = await fs.open(path.join(wrongLockAgentDir, "wrong.lock"), "w");
try {
  await assert.rejects(
    () => maintainer.runMaintainerUnderMaintenanceLock({}, {
      agentDir: wrongLockAgentDir,
      sessionFile: wrongLockSession,
      maintenanceLockHandle: wrongLockHandle,
    }),
    /self_improve_maintenance_lock_required/,
  );
} finally {
  await wrongLockHandle.close();
}

console.log(JSON.stringify({ changed: result.changedFiles.length, events: globalThis.__rinMaintainerOwnerEvents.length }));
`;

test("self-improve maintainer forks one isolated review and reports exact artifact changes", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-maintainer-owner-"),
  );
  try {
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
        env: { ...process.env, RIN_TEST_MAINTAINER_ROOT: root },
      },
    );
    const report = JSON.parse(result.stdout);
    assert.equal(report.changed, 3);
    assert.ok(report.events >= 7);
    assert.equal(result.stderr, "");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
