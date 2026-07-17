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
const prompt = maintainer.buildSelfImproveReviewPrompt("ignored-trigger", agentDir);
assert.match(prompt, new RegExp(agentDir.replace(/[.*+?^$()|[\]\\]/g, "\\$&")));
assert.match(prompt, /self-improve distillation contract/);
assert.match(prompt, /replay the future trigger/);
assert.doesNotMatch(prompt, /ignored-trigger/);

assert.deepEqual(await maintainer.maintainMemory({}, {}), {
  skipped: "no-session-file",
});
const result = await maintainer.maintainMemory(
  {},
  {
    agentDir,
    sessionFile,
    leafId: "leaf-owner",
    trigger: "  owner-trigger  ",
    additionalExtensionPaths: ["/extensions/owner.ts"],
  },
);
assert.deepEqual(result, {
  skipped: "",
  forked: true,
  saved: true,
  output: "owner review complete",
  changedFiles: [
    { path: updated, change: "updated" },
    { path: created, change: "created" },
    { path: deleted, change: "deleted" },
  ].sort((a, b) => a.path.localeCompare(b.path)),
  mode: "session",
  sessionFile,
  leafId: "leaf-owner",
  trigger: "owner-trigger",
});
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
assert.deepEqual(bindEvent[1].disabledRinCapabilities, ["self_improve"]);
const promptEvent = globalThis.__rinMaintainerOwnerEvents.find(([name]) => name === "prompt");
assert.match(promptEvent[1], /owner's exact trigger wording/);
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
const emptyResult = await maintainer.maintainMemory(
  {},
  {
    agentDir: emptyAgentDir,
    trigger: "",
    sessionManager: {
      getSessionFile: () => sessionFile,
      getLeafId: () => "",
    },
  },
);
assert.equal(emptyResult.output, "");
assert.deepEqual(emptyResult.changedFiles, []);
assert.equal(emptyResult.leafId, undefined);
assert.equal(emptyResult.trigger, "self_improve:review");
assert.equal(emptyResult.sessionFile, sessionFile);
assert.equal(globalThis.__rinMaintainerOwnerEvents.find(([name]) => name === "bind")[1].cwd.length > 0, true);

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
    assert.deepEqual(JSON.parse(result.stdout), { changed: 3, events: 7 });
    assert.equal(result.stderr, "");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
