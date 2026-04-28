import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const { RpcInteractiveSession } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-tui", "runtime.js"))
    .href
);

test("rpc restore reattaches once and avoids duplicate restore work", async () => {
  const events = [];
  const calls = [];
  const refreshes = [];
  let releaseRefresh;
  const refreshGate = new Promise((resolve) => {
    releaseRefresh = resolve;
  });

  const target = {
    disposed: false,
    restorePromise: null,
    reconnecting: true,
    reconnectTimer: null,
    setRpcConnected: () => {},
    emitFrontendStatus: () => {},
    emitSessionResynced: () => {},
    emitEvent: (event) => events.push(event),
    sessionFile: "/tmp/demo.jsonl",
    sessionId: "",
    call: async (type, payload) => {
      calls.push({ type, payload });
      return {};
    },
    queueRefreshState: () => Promise.resolve(),
    refreshState: async (flags) => {
      refreshes.push(flags);
      await refreshGate;
    },
    queuedOfflineOps: [],
    sendOrQueue: async () => {
      throw new Error("should_not_send_queued_ops");
    },
    isStreaming: false,
    isCompacting: false,
  };

  const p1 =
    RpcInteractiveSession.prototype.handleConnectionRestored.call(target);
  const p2 =
    RpcInteractiveSession.prototype.handleConnectionRestored.call(target);
  releaseRefresh();
  await Promise.all([p1, p2]);

  assert.equal(
    calls.filter((item) => item.type === "select_session").length,
    1,
  );
  assert.equal(
    calls.filter((item) => item.type === "resume_interrupted_turn").length,
    0,
  );
  assert.deepEqual(refreshes, [{ messages: true, session: true }]);
  assert.deepEqual(events, []);
});

test("rpc restore flushes queued offline ops after reattach", async () => {
  const calls = [];
  const sent = [];
  const target = {
    disposed: false,
    restorePromise: null,
    reconnecting: true,
    reconnectTimer: null,
    setRpcConnected: () => {},
    emitFrontendStatus: () => {},
    emitSessionResynced: () => {},
    emitEvent: () => {},
    sessionFile: "/tmp/demo.jsonl",
    sessionId: "",
    call: async (type, payload) => {
      calls.push({ type, payload });
      return {};
    },
    queueRefreshState: () => Promise.resolve(),
    refreshState: async () => {},
    queuedOfflineOps: [
      { mode: "prompt", message: "queued-1", streamingBehavior: "steer" },
      { mode: "follow_up", message: "queued-2" },
    ],
    sendOrQueue: async (operation) => {
      sent.push(operation);
    },
    isStreaming: false,
    isCompacting: false,
  };

  await RpcInteractiveSession.prototype.handleConnectionRestored.call(target);

  assert.equal(
    calls.filter((item) => item.type === "select_session").length,
    1,
  );
  assert.deepEqual(sent, [
    { mode: "prompt", message: "queued-1", streamingBehavior: "steer" },
    { mode: "follow_up", message: "queued-2" },
  ]);
  assert.deepEqual(target.queuedOfflineOps, []);
});
