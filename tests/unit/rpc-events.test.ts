import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const events = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-tui", "events.js")).href
);
const runtime = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-tui", "runtime.js"))
    .href
);

test("rpc session events do not refresh whole state on every stream update", async () => {
  const seen = [];
  let refreshMessages = 0;
  let refreshMessagesAndSession = 0;
  const target = {
    isStreaming: false,
    isCompacting: false,
    retryAttempt: 0,
    activeTurn: { mode: "prompt" },
    remoteTurnRunning: false,
    setRemoteTurnRunning(value) {
      this.remoteTurnRunning = value;
      this.isStreaming = value;
    },
    emitFrontendStatus(force) {
      seen.push({
        type: "frontend_status_refresh",
        force,
        compacting: this.isCompacting,
      });
    },
    emitEvent: (event) => seen.push(event),
  };

  await events.handleRpcSessionEvent(
    target,
    { type: "message_update", message: { role: "assistant" } },
    async () => {
      refreshMessages += 1;
    },
    async () => {
      refreshMessagesAndSession += 1;
    },
  );
  assert.equal(refreshMessages, 0);
  assert.equal(refreshMessagesAndSession, 0);

  await events.handleRpcSessionEvent(
    target,
    { type: "message_end", message: { role: "assistant" } },
    async () => {
      refreshMessages += 1;
    },
    async () => {
      refreshMessagesAndSession += 1;
    },
  );
  assert.equal(refreshMessages, 1);
  assert.equal(refreshMessagesAndSession, 0);

  await events.handleRpcSessionEvent(
    target,
    { type: "rpc_turn_event", event: "heartbeat", requestTag: "tag-1" },
    async () => {
      refreshMessages += 1;
    },
    async () => {
      refreshMessagesAndSession += 1;
    },
  );
  assert.equal(target.isStreaming, true);
  assert.equal(target.remoteTurnRunning, true);
  assert.equal(target.activeTurn?.mode, "prompt");

  await events.handleRpcSessionEvent(
    target,
    { type: "compaction_start", reason: "threshold" },
    async () => {
      refreshMessages += 1;
    },
    async () => {
      refreshMessagesAndSession += 1;
    },
  );
  assert.equal(target.isCompacting, true);

  await events.handleRpcSessionEvent(
    target,
    { type: "compaction_end", reason: "threshold", aborted: false },
    async () => {
      refreshMessages += 1;
    },
    async () => {
      refreshMessagesAndSession += 1;
    },
  );
  assert.equal(target.isCompacting, false);
  assert.equal(target.remoteTurnRunning, true);
  assert.equal(target.isStreaming, true);

  await events.handleRpcSessionEvent(
    target,
    { type: "worker_exit", code: 9, signal: null },
    async () => {
      refreshMessages += 1;
    },
    async () => {
      refreshMessagesAndSession += 1;
    },
  );
  assert.equal(target.isStreaming, false);
  assert.equal(target.remoteTurnRunning, false);
  assert.equal(target.activeTurn, null);
  assert.equal(refreshMessagesAndSession, 2);

  target.activeTurn = { mode: "prompt" };
  target.remoteTurnRunning = true;
  target.isStreaming = true;

  await events.handleRpcSessionEvent(
    target,
    { type: "rpc_turn_event", event: "complete", requestTag: "tag-1" },
    async () => {
      refreshMessages += 1;
    },
    async () => {
      refreshMessagesAndSession += 1;
    },
  );
  assert.equal(target.isStreaming, false);
  assert.equal(target.remoteTurnRunning, false);
  assert.equal(target.activeTurn, null);
  assert.equal(refreshMessagesAndSession, 3);
  assert.deepEqual(seen, [
    { type: "message_update", message: { role: "assistant" } },
    { type: "message_end", message: { role: "assistant" } },
    { type: "rpc_turn_event", event: "heartbeat", requestTag: "tag-1" },
    { type: "compaction_start", reason: "threshold" },
    { type: "frontend_status_refresh", force: true, compacting: true },
    { type: "compaction_end", reason: "threshold", aborted: false },
    { type: "frontend_status_refresh", force: true, compacting: false },
    { type: "worker_exit", code: 9, signal: null },
    { type: "rpc_turn_event", event: "complete", requestTag: "tag-1" },
  ]);
});

test("rpc compaction refresh redraws footer after the session snapshot lands", async () => {
  const statuses: any[] = [];
  let snapshotCompacted = false;
  const oldAssistant = {
    role: "assistant",
    content: [{ type: "text", text: "before compaction" }],
    usage: { input: 900, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const entriesBefore = [
    { type: "message", id: "user1", parentId: null, message: { role: "user" } },
    {
      type: "message",
      id: "assistant1",
      parentId: "user1",
      message: oldAssistant,
    },
  ];
  const entriesAfter = [
    ...entriesBefore,
    {
      type: "compaction",
      id: "compact1",
      parentId: "assistant1",
      summary: "summary",
      firstKeptEntryId: "assistant1",
      tokensBefore: 900,
    },
  ];
  const session = new runtime.RpcInteractiveSession({
    subscribe() {
      return () => {};
    },
    isConnected() {
      return true;
    },
    async send(command: any) {
      if (command.type === "get_state") {
        return {
          success: true,
          data: {
            model: { id: "demo", contextWindow: 1000 },
            turnActive: true,
          },
        };
      }
      if (command.type === "get_session_snapshot") {
        return {
          success: true,
          data: {
            entries: snapshotCompacted ? entriesAfter : entriesBefore,
            leafId: snapshotCompacted ? "compact1" : "assistant1",
          },
        };
      }
      return { success: true, data: {} };
    },
  });
  session.rpcConnected = true;
  session.startupPending = false;
  session.model = { id: "demo", contextWindow: 1000 };
  session.entries = entriesBefore;
  session.entryById = new Map(
    entriesBefore.map((entry: any) => [entry.id, entry]),
  );
  session.leafId = "assistant1";
  session.messages = [oldAssistant];
  session.state.messages = session.messages;
  session.state.model = session.model;
  session.subscribe((event: any) => {
    if (event.type === "rpc_frontend_status") statuses.push(event);
  });

  assert.equal(session.getContextUsage().percent, 90);
  snapshotCompacted = true;
  await session.handleRpcEvent({
    type: "compaction_end",
    reason: "threshold",
    aborted: false,
  });
  await session.refreshLoopPromise;

  assert.equal(session.getContextUsage().percent, null);
  assert.equal(statuses.at(-1)?.phase, "working");
  assert.ok(statuses.length >= 2);
});

test("rpc session events do not keep TUI turns alive for overflow continuation markers", async () => {
  const seen = [];
  let refreshMessages = 0;
  let refreshMessagesAndSession = 0;
  const target = {
    isStreaming: true,
    isCompacting: false,
    remoteTurnRunning: true,
    activeTurn: { mode: "prompt" },
    setRemoteTurnRunning(value) {
      this.remoteTurnRunning = value;
      this.isStreaming = value;
    },
    emitFrontendStatus(force) {
      seen.push({ type: "frontend_status_refresh", force });
    },
    emitEvent: (event) => seen.push(event),
  };

  await events.handleRpcSessionEvent(
    target,
    {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "context_length_exceeded",
      },
    },
    async () => {
      refreshMessages += 1;
    },
    async () => {
      refreshMessagesAndSession += 1;
    },
  );
  assert.equal(target.remoteTurnRunning, true);
  assert.equal(refreshMessages, 1);

  await events.handleRpcSessionEvent(
    target,
    { type: "agent_end" },
    async () => {
      refreshMessages += 1;
    },
    async () => {
      refreshMessagesAndSession += 1;
    },
  );
  assert.equal(target.remoteTurnRunning, false);
  assert.equal(target.activeTurn, null);

  await events.handleRpcSessionEvent(
    target,
    { type: "compaction_start", reason: "overflow" },
    async () => {
      refreshMessages += 1;
    },
    async () => {
      refreshMessagesAndSession += 1;
    },
  );
  assert.equal(target.isCompacting, true);
  assert.equal(target.compactionReason, "overflow");

  await events.handleRpcSessionEvent(
    target,
    {
      type: "compaction_end",
      reason: "overflow",
      aborted: false,
      willRetry: true,
    },
    async () => {
      refreshMessages += 1;
    },
    async () => {
      refreshMessagesAndSession += 1;
    },
  );
  assert.equal(target.remoteTurnRunning, false);

  await events.handleRpcSessionEvent(
    target,
    { type: "agent_start" },
    async () => {
      refreshMessages += 1;
    },
    async () => {
      refreshMessagesAndSession += 1;
    },
  );
  assert.equal(target.remoteTurnRunning, true);
  assert.equal(target.activeTurn, null);

  await events.handleRpcSessionEvent(
    target,
    {
      type: "rpc_turn_event",
      event: "complete",
      requestTag: "tag-1",
      finalText: "continued",
    },
    async () => {
      refreshMessages += 1;
    },
    async () => {
      refreshMessagesAndSession += 1;
    },
  );
  assert.equal(target.remoteTurnRunning, false);
  assert.equal(target.isStreaming, false);
  assert.equal(target.activeTurn, null);
  assert.equal(refreshMessagesAndSession, 3);
  assert.deepEqual(seen, [
    {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "context_length_exceeded",
      },
    },
    { type: "agent_end" },
    { type: "compaction_start", reason: "overflow" },
    { type: "frontend_status_refresh", force: true },
    {
      type: "compaction_end",
      reason: "overflow",
      aborted: false,
      willRetry: true,
    },
    { type: "frontend_status_refresh", force: true },
    { type: "agent_start" },
    {
      type: "rpc_turn_event",
      event: "complete",
      requestTag: "tag-1",
      finalText: "continued",
    },
  ]);
});

test("rpc session events expose Rin pre-compaction work as working", async () => {
  const seen = [];
  const target = {
    isStreaming: false,
    isCompacting: false,
    remoteTurnRunning: false,
    setRemoteTurnRunning(value) {
      this.remoteTurnRunning = value;
      this.isStreaming = value;
    },
    emitFrontendStatus(force) {
      seen.push({ type: "frontend_status_refresh", force });
    },
    emitEvent: (event) => seen.push(event),
  };

  await events.handleRpcSessionEvent(
    target,
    { type: "rin_working_start", reason: "session_before_compact" },
    async () => {},
    async () => {},
  );
  assert.equal(target.remoteTurnRunning, true);
  assert.equal(target.rinWorking, true);

  await events.handleRpcSessionEvent(
    target,
    { type: "rin_working_end", reason: "session_before_compact" },
    async () => {},
    async () => {},
  );
  assert.equal(target.remoteTurnRunning, false);
  assert.equal(target.rinWorking, false);
  assert.deepEqual(seen, [
    { type: "rin_working_start", reason: "session_before_compact" },
    { type: "frontend_status_refresh", force: true },
    { type: "rin_working_end", reason: "session_before_compact" },
    { type: "frontend_status_refresh", force: true },
  ]);
});

test("rpc session events delegate worker exit recovery to the runtime when available", async () => {
  const seen = [];
  let refreshMessages = 0;
  let refreshMessagesAndSession = 0;
  const target = {
    handleSessionUnavailable() {
      seen.push({ type: "session_unavailable" });
    },
    emitEvent: (event) => seen.push(event),
  };

  await events.handleRpcSessionEvent(
    target,
    { type: "worker_exit", code: 9, signal: null },
    async () => {
      refreshMessages += 1;
    },
    async () => {
      refreshMessagesAndSession += 1;
    },
  );

  assert.equal(refreshMessages, 0);
  assert.equal(refreshMessagesAndSession, 0);
  assert.deepEqual(seen, [
    { type: "session_unavailable" },
    { type: "worker_exit", code: 9, signal: null },
  ]);
});

test("rpc session recovery events are delegated without fake turn termination", async () => {
  const seen = [];
  let refreshMessages = 0;
  let refreshMessagesAndSession = 0;
  const target = {
    handleSessionUnavailable() {
      seen.push({ type: "session_unavailable" });
    },
    handleSessionRecovered() {
      seen.push({ type: "session_recovered_hook" });
    },
    emitEvent: (event) => seen.push(event),
  };

  await events.handleRpcSessionEvent(
    target,
    { type: "session_recovering", sessionFile: "/tmp/demo.jsonl" },
    async () => {
      refreshMessages += 1;
    },
    async () => {
      refreshMessagesAndSession += 1;
    },
  );
  await events.handleRpcSessionEvent(
    target,
    { type: "session_recovered", sessionFile: "/tmp/demo.jsonl" },
    async () => {
      refreshMessages += 1;
    },
    async () => {
      refreshMessagesAndSession += 1;
    },
  );

  assert.equal(refreshMessages, 0);
  assert.equal(refreshMessagesAndSession, 0);
  assert.deepEqual(seen, [
    { type: "session_unavailable" },
    { type: "session_recovering", sessionFile: "/tmp/demo.jsonl" },
    { type: "session_recovered_hook" },
    { type: "session_recovered", sessionFile: "/tmp/demo.jsonl" },
  ]);
});

test("rpc session listeners added during dispatch do not receive the current event", () => {
  const session = new runtime.RpcInteractiveSession({
    subscribe() {
      return () => {};
    },
    isConnected() {
      return true;
    },
  });
  session.rpcConnected = true;
  session.startupPending = false;

  let resyncEvents = 0;
  let unsubscribe = () => {};
  const listener = (event) => {
    if (event.type !== "rpc_session_resynced") return;
    resyncEvents += 1;
    if (resyncEvents === 1) {
      unsubscribe();
      unsubscribe = session.subscribe(listener);
    }
  };

  unsubscribe = session.subscribe(listener);
  session.emitEvent({ type: "rpc_session_resynced" });
  assert.equal(resyncEvents, 1);

  session.emitEvent({ type: "rpc_session_resynced" });
  assert.equal(resyncEvents, 2);
});
