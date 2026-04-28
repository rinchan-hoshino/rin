import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const stateUtils = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-tui", "state-utils.js"))
    .href
);

test("rpc state utils derive branch and apply state", () => {
  const target = {
    model: { provider: "openai", id: "gpt-5" },
    thinkingLevel: "high",
    steeringMode: "all",
    followUpMode: "one-at-a-time",
    isStreaming: false,
    isCompacting: false,
    pendingMessageCount: 0,
    autoCompactionEnabled: false,
    sessionId: "",
    sessionFile: undefined,
    sessionName: undefined,
    state: {},
  };

  stateUtils.applyRpcSessionState(target, {
    sessionId: " s0 ",
    sessionFile: " /tmp/old ",
    sessionName: " demo session ",
    model: { provider: "anthropic", id: "claude-sonnet-4-5" },
    thinkingLevel: "medium",
    steeringMode: "one-at-a-time",
    followUpMode: "all",
    autoCompactionEnabled: true,
    pendingMessageCount: "2.9",
    isStreaming: false,
  });
  assert.equal(target.sessionId, "s0");
  assert.equal(target.sessionFile, "/tmp/old");
  assert.equal(target.model.provider, "anthropic");
  assert.equal(target.thinkingLevel, "medium");
  assert.equal(target.steeringMode, "one-at-a-time");
  assert.equal(target.followUpMode, "all");
  assert.equal(target.autoCompactionEnabled, true);
  assert.equal(target.pendingMessageCount, 2);
  assert.equal(target.sessionName, "demo session");

  stateUtils.applyRpcSessionState(target, {
    sessionId: " s1 ",
    sessionFile: " /tmp/x ",
    thinkingLevel: "low",
    isStreaming: true,
  });
  assert.equal(target.sessionId, "s1");
  assert.equal(target.sessionFile, "/tmp/x");
  assert.equal(target.thinkingLevel, "low");
  assert.equal(target.isStreaming, true);

  let remoteStreaming = false;
  stateUtils.applyRpcSessionState(
    {
      ...target,
      setRemoteTurnRunning(value) {
        remoteStreaming = value;
      },
    },
    {
      sessionId: " s2 ",
      sessionFile: " /tmp/y ",
      isStreaming: true,
    },
  );
  assert.equal(remoteStreaming, true);

  remoteStreaming = false;
  const staleTurnTarget = {
    ...target,
    activeTurn: { mode: "prompt" },
    remoteTurnRunning: true,
    setRemoteTurnRunning(value) {
      remoteStreaming = value;
      this.remoteTurnRunning = value;
    },
  };
  stateUtils.applyRpcSessionState(staleTurnTarget, {
    sessionId: "s3",
    sessionFile: "/tmp/z",
    turnActive: false,
    isStreaming: false,
    isCompacting: false,
  });
  assert.equal(remoteStreaming, false);
  assert.equal(staleTurnTarget.activeTurn, null);

  const entryById = new Map([
    ["1", { id: "1" }],
    ["2", { id: "2", parentId: "1" }],
  ]);
  const branch = stateUtils.getSessionBranch(entryById, "2");
  assert.deepEqual(
    branch.map((x) => x.id),
    ["1", "2"],
  );
});

test("rpc state utils normalize session tree snapshots", () => {
  const target = {
    entries: [],
    tree: [],
    leafId: null,
    entryById: new Map(),
    labelsById: new Map(),
  };

  stateUtils.applyRpcSessionTree(
    target,
    {
      entries: [
        { id: " 1 ", type: "message" },
        { id: " ", type: "message" },
        { id: "2", parentId: " 1 ", type: "message" },
      ],
    },
    {
      tree: [
        {
          entry: { id: " 1 " },
          label: "Root",
          children: [
            {
              entry: { id: "2" },
              label: "Child",
              children: [{ entry: { id: "missing" }, label: "skip" }],
            },
            { entry: { id: " " }, label: "skip" },
          ],
        },
        { entry: { id: "missing" }, label: "skip" },
      ],
      leafId: " 2 ",
    },
  );

  assert.deepEqual(
    target.entries.map((entry) => ({ id: entry.id, parentId: entry.parentId })),
    [
      { id: "1", parentId: undefined },
      { id: "2", parentId: "1" },
    ],
  );
  assert.equal(target.tree.length, 1);
  assert.equal(target.tree[0].entry, target.entryById.get("1"));
  assert.equal(target.tree[0].children[0].entry, target.entryById.get("2"));
  assert.deepEqual(Array.from(target.labelsById.entries()), [
    ["1", "Root"],
    ["2", "Child"],
  ]);
  assert.equal(target.leafId, "2");

  stateUtils.applyRpcSessionTree(
    target,
    { entries: [{ id: "3", type: "message" }] },
    { tree: [{ entry: { id: "3" }, children: [] }], leafId: "missing" },
  );
  assert.equal(target.leafId, null);
});

test("rpc state utils stop branch traversal on parent cycles", () => {
  const entryById = new Map([
    ["1", { id: "1", parentId: "2" }],
    ["2", { id: "2", parentId: "1" }],
  ]);

  const branch = stateUtils.getSessionBranch(entryById, "2");
  assert.deepEqual(
    branch.map((entry) => entry.id),
    ["1", "2"],
  );
});
