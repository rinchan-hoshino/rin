import "../support/require-test-sandbox.ts";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
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
    setTurnActive(value) {
      this.remoteTurnRunning = value;
    },
    setAgentStreaming(value) {
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
  assert.equal(target.isStreaming, false);
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
  assert.equal(target.isStreaming, false);

  await events.handleRpcSessionEvent(
    target,
    { type: "auto_retry_start", attempt: 1 },
    async () => {
      refreshMessages += 1;
    },
    async () => {
      refreshMessagesAndSession += 1;
    },
  );
  assert.equal(target.retryAttempt, 1);

  await events.handleRpcSessionEvent(
    target,
    { type: "auto_retry_end", success: true, attempt: 1 },
    async () => {
      refreshMessages += 1;
    },
    async () => {
      refreshMessagesAndSession += 1;
    },
  );
  assert.equal(target.retryAttempt, 0);

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
  assert.equal(target.remoteTurnRunning, true);
  assert.equal(target.activeTurn?.mode, "prompt");
  assert.equal(refreshMessagesAndSession, 1);

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
  assert.equal(refreshMessagesAndSession, 2);
  assert.deepEqual(seen, [
    { type: "message_update", message: { role: "assistant" } },
    { type: "message_end", message: { role: "assistant" } },
    { type: "rpc_turn_event", event: "heartbeat", requestTag: "tag-1" },
    { type: "compaction_start", reason: "threshold" },
    { type: "frontend_status_refresh", force: true, compacting: true },
    { type: "compaction_end", reason: "threshold", aborted: false },
    { type: "frontend_status_refresh", force: true, compacting: false },
    { type: "auto_retry_start", attempt: 1 },
    { type: "frontend_status_refresh", force: true, compacting: false },
    { type: "auto_retry_end", success: true, attempt: 1 },
    { type: "frontend_status_refresh", force: true, compacting: false },
    { type: "worker_exit", code: 9, signal: null },
    { type: "rpc_turn_event", event: "complete", requestTag: "tag-1" },
  ]);
});

test("rpc session events reduce summarization retry state through the canonical lifecycle policy", async () => {
  const seen = [];
  const target = {
    remoteTurnRunning: true,
    isStreaming: false,
    isCompacting: true,
    compactionReason: "threshold",
    retryAttempt: 0,
    maxRetryAttempts: 0,
    retryDelayMs: 0,
    retryError: "",
    setTurnActive(value) {
      this.remoteTurnRunning = value;
    },
    setAgentStreaming(value) {
      this.isStreaming = value;
    },
    emitEvent(event) {
      seen.push(event);
    },
    emitFrontendStatus(force) {
      seen.push({
        type: "frontend_status_refresh",
        force,
        retryAttempt: this.retryAttempt,
        compacting: this.isCompacting,
      });
    },
  };

  await events.handleRpcSessionEvent(
    target,
    {
      type: "summarization_retry_scheduled",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2000,
      errorMessage: "Compaction failed: overloaded",
    },
    async () => {},
    async () => {},
  );
  assert.equal(target.retryAttempt, 1);
  assert.equal(target.maxRetryAttempts, 3);
  assert.equal(target.retryDelayMs, 2000);
  assert.equal(target.retryError, "Compaction failed: overloaded");
  assert.equal(target.isCompacting, true);

  await events.handleRpcSessionEvent(
    target,
    {
      type: "summarization_retry_attempt_start",
      source: "compaction",
      reason: "threshold",
    },
    async () => {},
    async () => {},
  );
  assert.equal(target.retryAttempt, 0);
  assert.equal(target.isCompacting, true);
  assert.deepEqual(seen, [
    {
      type: "summarization_retry_scheduled",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2000,
      errorMessage: "Compaction failed: overloaded",
    },
    {
      type: "frontend_status_refresh",
      force: true,
      retryAttempt: 1,
      compacting: true,
    },
    {
      type: "summarization_retry_attempt_start",
      source: "compaction",
      reason: "threshold",
    },
    {
      type: "frontend_status_refresh",
      force: true,
      retryAttempt: 0,
      compacting: true,
    },
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
  assert.equal(statuses.at(-1)?.phase, "idle");
  assert.ok(statuses.length >= 2);
});

test("rpc session events keep turns alive until explicit rpc completion", async () => {
  const seen = [];
  const statusSnapshots = [];
  let refreshMessages = 0;
  let refreshMessagesAndSession = 0;
  const target = {
    isStreaming: true,
    isCompacting: false,
    remoteTurnRunning: true,
    activeTurn: { mode: "prompt" },
    setTurnActive(value) {
      this.remoteTurnRunning = value;
    },
    setAgentStreaming(value) {
      this.isStreaming = value;
    },
    emitFrontendStatus(force) {
      statusSnapshots.push({
        force,
        turnActive: this.remoteTurnRunning,
        streaming: this.isStreaming,
      });
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
  assert.equal(target.remoteTurnRunning, true);
  assert.equal(target.isStreaming, false);
  assert.deepEqual(target.activeTurn, { mode: "prompt" });

  await events.handleRpcSessionEvent(
    target,
    { type: "agent_settled" },
    async () => {
      refreshMessages += 1;
    },
    async () => {
      refreshMessagesAndSession += 1;
    },
  );
  assert.equal(target.remoteTurnRunning, true);
  assert.deepEqual(target.activeTurn, { mode: "prompt" });
  assert.deepEqual(statusSnapshots.slice(0, 2), [
    { force: true, turnActive: true, streaming: false },
    { force: true, turnActive: true, streaming: false },
  ]);

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
  assert.equal(target.remoteTurnRunning, true);

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
  assert.equal(target.isStreaming, true);
  assert.deepEqual(target.activeTurn, { mode: "prompt" });

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
    { type: "frontend_status_refresh", force: true },
    { type: "agent_settled" },
    { type: "frontend_status_refresh", force: true },
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

test("rpc session events ignore Rin-private working events as frontend working truth", async () => {
  const seen = [];
  const target = {
    isStreaming: false,
    isCompacting: false,
    remoteTurnRunning: false,
    setTurnActive(value) {
      this.remoteTurnRunning = value;
    },
    setAgentStreaming(value) {
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
  await events.handleRpcSessionEvent(
    target,
    { type: "rin_working_end", reason: "session_before_compact" },
    async () => {},
    async () => {},
  );

  assert.equal(target.remoteTurnRunning, false);
  assert.equal(target.rinWorking, undefined);
  assert.deepEqual(seen, [
    { type: "rin_working_start", reason: "session_before_compact" },
    { type: "rin_working_end", reason: "session_before_compact" },
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

test("rpc session events cover recovery, queue, backend, and refresh branches", async () => {
  const seen: any[] = [];
  let messageRefreshes = 0;
  let sessionRefreshes = 0;
  const target = {
    turnActive: false,
    remoteTurnRunning: true,
    isStreaming: false,
    handleSessionUnavailable: () => seen.push("unavailable"),
    handleSessionRecovered: () => seen.push("recovered"),
    applyQueueUpdate: (payload: any) => seen.push(["queue", payload.items]),
    emitEvent: (payload: any) => seen.push(["event", payload.type]),
    emitFrontendStatus: (force: boolean) => seen.push(["status", force]),
    setTurnActive(value: boolean) {
      this.turnActive = value;
      seen.push(["turn", value]);
    },
    setAgentStreaming(value: boolean) {
      this.isStreaming = value;
      seen.push(["streaming", value]);
    },
    setBackendWorking: (value: boolean) => seen.push(["working", value]),
  };
  const refreshMessages = async () => {
    messageRefreshes += 1;
  };
  const refreshMessagesAndSession = async () => {
    sessionRefreshes += 1;
  };

  await events.handleRpcSessionEvent(
    target,
    null,
    refreshMessages,
    refreshMessagesAndSession,
  );
  await events.handleRpcSessionEvent(
    target,
    { type: "session_recovering" },
    refreshMessages,
    refreshMessagesAndSession,
  );
  await events.handleRpcSessionEvent(
    target,
    { type: "session_recovered" },
    refreshMessages,
    refreshMessagesAndSession,
  );
  await events.handleRpcSessionEvent(
    target,
    { type: "queue_update", items: 2, working: true },
    refreshMessages,
    refreshMessagesAndSession,
  );
  await events.handleRpcSessionEvent(
    target,
    { type: "tool_execution_end" },
    refreshMessages,
    refreshMessagesAndSession,
  );
  await events.handleRpcSessionEvent(
    target,
    { type: "compaction_message" },
    refreshMessages,
    refreshMessagesAndSession,
  );
  await events.handleRpcSessionEvent(
    target,
    { type: "rpc_turn_event", event: "error" },
    refreshMessages,
    refreshMessagesAndSession,
  );

  assert.equal(messageRefreshes, 2);
  assert.equal(sessionRefreshes, 1);
  assert.equal(target.turnActive, false);
  assert.equal(target.isStreaming, false);
  assert.ok(seen.includes("unavailable"));
  assert.ok(seen.includes("recovered"));
  assert.ok(seen.some((item) => Array.isArray(item) && item[0] === "queue"));
  assert.ok(seen.some((item) => Array.isArray(item) && item[0] === "working"));
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
