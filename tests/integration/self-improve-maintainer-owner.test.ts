import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { importBuiltModule } from "../support/import-built-module.js";

const execFileAsync = promisify(execFile);
const maintainerModule = await importBuiltModule<Record<string, any>>(
  "dist/core/self-improve/maintainer.js",
);
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
await fs.writeFile(
  sessionFile,
  [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "019fad2a-b02a-74cc-9d03-56b909f1f929",
      cwd: "/workspace/project",
    }),
    JSON.stringify({
      type: "custom_message",
      id: "leaf-owner",
      parentId: null,
      timestamp: "2026-08-11T00:00:00.000Z",
      customType: "test",
      content: "owner context",
      display: false,
    }),
  ].join("\n") + "\n",
);
await fs.writeFile(updated, "before\n");
await fs.writeFile(deleted, "delete me\n");
await fs.writeFile(unchanged, "same\n");

globalThis.__rinMaintainerOwnerEvents = [];
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
assert.equal(result.inMemory, true);
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
const memoryEvent = globalThis.__rinMaintainerOwnerEvents.find(([name]) => name === "memory");
assert.deepEqual(memoryEvent, [
  "memory",
  "/workspace/project",
  {
    id: "019fad2a-b02a-74cc-9d03-56b909f1f929",
    parentSession: sessionFile,
  },
]);
const seedEvent = globalThis.__rinMaintainerOwnerEvents.find(([name]) => name === "seed");
assert.equal(seedEvent[1].some((entry) => entry.id === "leaf-owner"), true);
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
await fs.writeFile(
  primitiveSessionFile,
  '{"type":"session","id":"019fad2a-b02a-74cc-9d03-56b909f1f929","cwd":"/primitive"}\n' +
    '{"type":"custom_message","id":"primitive-leaf","parentId":null,"customType":"test","content":"primitive","display":false}\n',
);
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
await fs.writeFile(
  defaultSessionFile,
  '{"type":"session","id":"019fad2a-b02a-74cc-9d03-56b909f1f929","cwd":"/default"}\n' +
    '{"type":"custom_message","id":"default-leaf","parentId":null,"customType":"test","content":"default","display":false}\n',
);
const defaultResult = await withMaintenanceLock(defaultAgentDir, (maintenanceLockHandle) =>
  maintainer.runMaintainerUnderMaintenanceLock({}, {
    agentDir: defaultAgentDir,
    sessionFile: defaultSessionFile,
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

test("self-improve seeds one in-memory Pi session from the pinned effective context", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-maintainer-context-"),
  );
  const sessionFile = path.join(root, "source.jsonl");
  const sourceId = "019fad2a-b02a-74cc-9d03-56b909f1f929";
  const timestamp = "2026-08-11T00:00:00.000Z";
  const oldPayload = `summarized-history:${"x".repeat(2 * 1024 * 1024)}`;
  const entries = [
    { type: "session", version: 3, id: sourceId, timestamp, cwd: "/source" },
    {
      type: "model_change",
      id: "model001",
      parentId: null,
      timestamp,
      provider: "openai",
      modelId: "gpt-test",
    },
    {
      type: "thinking_level_change",
      id: "think001",
      parentId: "model001",
      timestamp,
      thinkingLevel: "high",
    },
    {
      type: "custom_message",
      id: "old00001",
      parentId: "think001",
      timestamp,
      customType: "test",
      content: oldPayload,
      display: false,
    },
    {
      type: "custom_message",
      id: "keep0001",
      parentId: "old00001",
      timestamp,
      customType: "test",
      content: "kept context",
      display: false,
    },
    {
      type: "compaction",
      id: "compact1",
      parentId: "keep0001",
      timestamp,
      summary: "complete prior summary",
      firstKeptEntryId: "keep0001",
      tokensBefore: 1000,
    },
    {
      type: "custom_message",
      id: "post0001",
      parentId: "compact1",
      timestamp,
      customType: "test",
      content: "post-compaction context",
      display: false,
    },
    {
      type: "custom_message",
      id: "target01",
      parentId: "post0001",
      timestamp,
      customType: "test",
      content: "pinned leaf",
      display: false,
    },
    {
      type: "custom_message",
      id: "other001",
      parentId: "old00001",
      timestamp,
      customType: "test",
      content: "abandoned branch",
      display: false,
    },
  ];

  try {
    await fs.writeFile(
      sessionFile,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    const before = createHash("sha256")
      .update(await fs.readFile(sessionFile))
      .digest("hex");
    const sourceManager = SessionManager.open(sessionFile, root);
    sourceManager.branch("target01");

    const created = await maintainerModule.createSelfImproveInMemorySession({
      sessionFile,
      leafId: "target01",
    });

    assert.equal(created.cwd, "/source");
    assert.equal(created.sessionManager.isPersisted(), false);
    assert.equal(created.sessionManager.getSessionFile(), undefined);
    assert.equal(created.sessionManager.getSessionId(), sourceId);
    assert.deepEqual(
      created.sessionManager.buildSessionContext(),
      sourceManager.buildSessionContext(),
    );
    const projected = JSON.stringify(created.sessionManager.getEntries());
    assert.doesNotMatch(projected, /summarized-history:/);
    assert.doesNotMatch(projected, /abandoned branch/);
    assert.equal(
      created.sessionManager[
        Symbol.for("rin.ephemeralFork.disableRoutineCompaction")
      ],
      undefined,
    );
    await assert.rejects(
      () =>
        maintainerModule.createSelfImproveInMemorySession({
          sessionFile,
          leafId: "missing-leaf",
        }),
      /self_improve_session_leaf_missing:missing-leaf/,
    );
    assert.equal(
      createHash("sha256")
        .update(await fs.readFile(sessionFile))
        .digest("hex"),
      before,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("self-improve rejects malformed pinned session topology", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-maintainer-invalid-context-"),
  );
  const writeSession = async (name: string, lines: string[]) => {
    const sessionFile = path.join(root, `${name}.jsonl`);
    await fs.writeFile(sessionFile, `${lines.join("\n")}\n`);
    return sessionFile;
  };
  const header = JSON.stringify({
    type: "session",
    version: 3,
    id: "019fad2a-b02a-74cc-9d03-56b909f1f929",
    cwd: "/source",
  });

  try {
    const invalidHeader = await writeSession("invalid-header", [
      "not-json",
      JSON.stringify({ type: "custom_message", id: "not-a-header" }),
    ]);
    await assert.rejects(
      () =>
        maintainerModule.createSelfImproveInMemorySession({
          sessionFile: invalidHeader,
        }),
      /self_improve_session_invalid_header:/,
    );

    const missingHeader = await writeSession("missing-header", ["not-json"]);
    await assert.rejects(
      () =>
        maintainerModule.createSelfImproveInMemorySession({
          sessionFile: missingHeader,
        }),
      /self_improve_session_invalid_header:/,
    );

    const missingParent = await writeSession("missing-parent", [
      header,
      JSON.stringify({
        type: "custom_message",
        id: "leaf",
        parentId: "absent",
        content: "owner context",
      }),
    ]);
    await assert.rejects(
      () =>
        maintainerModule.createSelfImproveInMemorySession({
          sessionFile: missingParent,
          leafId: "leaf",
        }),
      /self_improve_session_parent_missing:absent/,
    );

    const parentCycle = await writeSession("parent-cycle", [
      header,
      JSON.stringify({
        type: "custom_message",
        id: "first",
        parentId: "second",
        content: "first",
      }),
      JSON.stringify({
        type: "custom_message",
        id: "second",
        parentId: "first",
        content: "second",
      }),
    ]);
    await assert.rejects(
      () =>
        maintainerModule.createSelfImproveInMemorySession({
          sessionFile: parentCycle,
          leafId: "first",
        }),
      /self_improve_session_parent_cycle:first/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("self-improve restores assistant model metadata from the pinned branch", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-maintainer-assistant-model-"),
  );
  const sessionFile = path.join(root, "source.jsonl");
  try {
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "019fad2a-b02a-74cc-9d03-56b909f1f929",
          cwd: "",
        }),
        JSON.stringify({
          type: "message",
          id: "assistant",
          parentId: null,
          message: {
            role: "assistant",
            provider: "openai",
            model: "owner-model",
            content: [{ type: "text", text: "context" }],
          },
        }),
      ].join("\n") + "\n",
    );

    const created = await maintainerModule.createSelfImproveInMemorySession({
      sessionFile,
    });
    assert.equal(created.cwd, os.homedir());
    assert.equal(
      created.sessionManager
        .getEntries()
        .some(
          (entry: any) =>
            entry.type === "model_change" &&
            entry.provider === "openai" &&
            entry.modelId === "owner-model",
        ),
      true,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("self-improve maintainer runs one isolated in-memory review and reports exact artifact changes", async () => {
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
