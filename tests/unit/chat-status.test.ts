import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const status = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "status.js")).href
);

const agentDir = path.join(path.sep, "tmp", "rin-chat-status-agent");
const storedSessionFile = "managed/chat/current.jsonl";
const absoluteSessionFile = path.join(agentDir, "sessions", storedSessionFile);

function activity(worker = {}) {
  return {
    schemaVersion: 1,
    workers: [
      {
        sessionFile: absoluteSessionFile,
        state: "idle",
        working: false,
        turnActive: false,
        isCompacting: false,
        ...worker,
      },
    ],
  };
}

test("chat status classifies the current bound session without exposing its path", () => {
  const snapshot = status.buildChatSessionStatus({
    agentDir,
    daemonReachable: true,
    sessionFile: storedSessionFile,
    localTurnActive: false,
    activity: activity(),
  });
  assert.deepEqual(snapshot, { session: "idle" });
  const text = status.renderChatSessionStatus(snapshot);
  assert.equal(text, "Current session: idle");
  assert.equal(text.includes(storedSessionFile), false);
  assert.equal(text.includes(absoluteSessionFile), false);
});

test("chat status distinguishes working, compacting, and stopping workers", () => {
  for (const [worker, expected] of [
    [{ state: "working", working: true }, "working"],
    [{ state: "compacting", isCompacting: true }, "compacting"],
    [{ state: "stopping" }, "stopping"],
    [
      {
        state: "stopping",
        isCompacting: true,
        gracefulShutdownRequested: true,
      },
      "stopping",
    ],
  ]) {
    assert.equal(
      status.buildChatSessionStatus({
        agentDir,
        daemonReachable: true,
        sessionFile: storedSessionFile,
        localTurnActive: false,
        activity: activity(worker),
      }).session,
      expected,
    );
  }
});

test("chat status uses local ownership for a just-started turn and ignores other workers", () => {
  assert.equal(
    status.buildChatSessionStatus({
      agentDir,
      daemonReachable: true,
      sessionFile: undefined,
      localTurnActive: true,
      activity: { workers: [] },
    }).session,
    "working",
  );
  assert.equal(
    status.buildChatSessionStatus({
      agentDir,
      daemonReachable: true,
      sessionFile: storedSessionFile,
      localTurnActive: false,
      activity: activity({
        sessionFile: "/tmp/some-other-session.jsonl",
        state: "working",
      }),
    }).session,
    "idle",
  );
});

test("chat status distinguishes no session from an unavailable agent", async () => {
  assert.deepEqual(
    status.buildChatSessionStatus({
      agentDir,
      daemonReachable: true,
      sessionFile: undefined,
      localTurnActive: false,
      activity: { workers: [] },
    }),
    { session: "not started" },
  );

  const unavailable = await status.readChatSessionStatus(
    {
      agentDir,
      sessionFile: storedSessionFile,
      localTurnActive: false,
    },
    async () => {
      throw new Error("daemon socket unavailable");
    },
  );
  assert.deepEqual(unavailable, { session: "unavailable" });
});
