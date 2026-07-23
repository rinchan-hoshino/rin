import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const { RinDaemonFrontendClient } = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-frontend-sdk", "index.js"),
  ).href
);
const { createConnectedRpcSocketPair } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "platform", "rpc-socket.js"))
    .href
);
const { RpcInteractiveSession } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-tui", "runtime.js"))
    .href
);

test("rpc client ignores stale socket disconnect after reconnect", () => {
  const client = new RinDaemonFrontendClient("/tmp/fake.sock");
  const seen = [];
  client.subscribe((event) => seen.push(event));

  const staleSocket = { destroyed: false };
  const currentSocket = { destroyed: false };

  client.socket = currentSocket;
  client.connectPromise = null;

  RinDaemonFrontendClient.prototype.handleDisconnect.call(
    client,
    true,
    staleSocket,
  );

  assert.equal(client.socket, currentSocket);
  assert.equal(seen.length, 0);

  RinDaemonFrontendClient.prototype.handleDisconnect.call(
    client,
    true,
    currentSocket,
  );

  assert.equal(client.socket, null);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.type, "ui");
  assert.equal(seen[0]?.name, "connection_lost");
});

test("rpc client identifies an in-flight command when its transport disconnects", async () => {
  const { clientSocket, serverSocket } = createConnectedRpcSocketPair();
  const client = new RinDaemonFrontendClient({
    socketPath: "inprocess://disconnect-pending",
    connectSocket: async () => clientSocket,
  });
  const seen = [];
  client.subscribe((event) => seen.push(event));

  await client.connect();
  const request = client.send({ type: "get_state" });
  await new Promise((resolve) => setImmediate(resolve));
  serverSocket.destroy();

  await assert.rejects(request, /^Error: rin_disconnected:get_state:req_1$/);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(client.pending.size, 0);
  assert.equal(client.isConnected(), false);
  assert.deepEqual(
    seen.map((event) => [event.type, event.name]),
    [["ui", "connection_lost"]],
  );
});

test("rpc client retries after a socket connect attempt stalls", async () => {
  let attempts = 0;
  class StalledSocket extends EventEmitter {
    destroyed = false;
    write() {
      return false;
    }
    end() {
      this.destroy();
    }
    destroy(error?: Error) {
      if (this.destroyed) return;
      this.destroyed = true;
      if (error) queueMicrotask(() => this.emit("error", error));
      queueMicrotask(() => this.emit("close"));
    }
  }

  const client = new RinDaemonFrontendClient({
    socketPath: "inprocess://stall-once",
    connectTimeoutMs: 5,
    connectSocket: async () => {
      attempts += 1;
      if (attempts === 1) return new StalledSocket();
      return createConnectedRpcSocketPair().clientSocket;
    },
  });

  await assert.rejects(client.connect(), /rin_timeout:connect/);
  assert.equal(client.connectPromise, null);
  assert.equal(client.isConnected(), false);

  await client.connect();
  assert.equal(attempts, 2);
  assert.equal(client.isConnected(), true);
});

test("rpc client supports injected in-process transport connectors", async () => {
  const client = new RinDaemonFrontendClient({
    socketPath: "inprocess://test",
    connectSocket: async () => {
      const { clientSocket, serverSocket } = createConnectedRpcSocketPair();
      let buffer = "";
      serverSocket.on("data", (chunk) => {
        buffer += String(chunk);
        while (true) {
          const idx = buffer.indexOf("\n");
          if (idx < 0) break;
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          const payload = JSON.parse(line);
          serverSocket.write(
            `${JSON.stringify({
              type: "response",
              id: payload.id,
              command: payload.type,
              success: true,
              data: {
                models: [
                  {
                    id: "provider/model",
                    label: "provider/model",
                    provider: "provider",
                  },
                ],
              },
            })}\n`,
          );
        }
      });
      return clientSocket;
    },
  });

  await client.connect();
  const models = await client.listModels();

  assert.deepEqual(models, [
    {
      id: "provider/model",
      label: "provider/model",
      provider: "provider",
      description: undefined,
    },
  ]);
});

test("rpc client applies configured frontend identity to scoped frontend commands", async () => {
  const received = [];
  const client = new RinDaemonFrontendClient({
    socketPath: "inprocess://frontend-identity",
    frontendIdentity: { kind: "gui" },
    connectSocket: async () => {
      const { clientSocket, serverSocket } = createConnectedRpcSocketPair();
      let buffer = "";
      serverSocket.on("data", (chunk) => {
        buffer += String(chunk);
        while (true) {
          const idx = buffer.indexOf("\n");
          if (idx < 0) break;
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          const payload = JSON.parse(line);
          received.push(payload);
          serverSocket.write(
            `${JSON.stringify({
              type: "response",
              id: payload.id,
              success: true,
              data: {},
            })}\n`,
          );
        }
      });
      return clientSocket;
    },
  });

  await client.connect();
  await client.prompt("hello");
  await client.newSession();
  await client.resumeSession("/tmp/session.jsonl");
  await client.shutdownSession();
  await client.terminateSession();

  assert.deepEqual(
    received.map((payload) => ({
      type: payload.type,
      frontendIdentity: payload.frontendIdentity,
    })),
    [
      { type: "prompt", frontendIdentity: { kind: "gui" } },
      { type: "new_session", frontendIdentity: { kind: "gui" } },
      { type: "select_session", frontendIdentity: { kind: "gui" } },
      { type: "shutdown_session", frontendIdentity: { kind: "gui" } },
      { type: "terminate_session", frontendIdentity: { kind: "gui" } },
    ],
  );
});

test("rpc client runs compact through a shared single-flight request", async () => {
  let client: RinDaemonFrontendClient | undefined;
  let releaseCompact: (() => void) | undefined;
  const compactReceived = new Promise<void>((resolve) => {
    client = new RinDaemonFrontendClient({
      socketPath: "inprocess://compact-single-flight",
      connectSocket: async () => {
        const { clientSocket, serverSocket } = createConnectedRpcSocketPair();
        let buffer = "";
        serverSocket.on("data", (chunk) => {
          buffer += String(chunk);
          while (true) {
            const idx = buffer.indexOf("\n");
            if (idx < 0) break;
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) continue;
            const payload = JSON.parse(line);
            if (payload.type !== "compact") continue;
            resolve();
            void new Promise<void>((next) => {
              releaseCompact = next;
            }).then(() => {
              serverSocket.write(
                `${JSON.stringify({
                  type: "response",
                  id: payload.id,
                  command: payload.type,
                  success: true,
                  data: { compacted: true },
                })}\n`,
              );
            });
          }
        });
        return clientSocket;
      },
    });
  });
  assert.ok(client);

  await client.connect();
  const first = client.compact();
  await compactReceived;
  const second = await client.compact();
  releaseCompact?.();
  const firstResult = await first;

  assert.equal(second.compactionBusy, true);
  assert.deepEqual(firstResult, { compacted: true });
});

test("rpc client exposes typed extension UI events and responses", async () => {
  const client = new RinDaemonFrontendClient("/tmp/fake.sock");
  const events = [];
  client.subscribe((event) => events.push(event));

  RinDaemonFrontendClient.prototype.handleLine.call(
    client,
    JSON.stringify({
      type: "extension_ui_request",
      id: "ui-1",
      method: "confirm",
      title: "Confirm",
      message: "Proceed?",
    }),
  );

  assert.deepEqual(events[0], {
    type: "extension_ui_request",
    payload: {
      type: "extension_ui_request",
      id: "ui-1",
      method: "confirm",
      title: "Confirm",
      message: "Proceed?",
    },
  });

  let sent;
  client.send = async (payload) => {
    sent = payload;
    return { success: true, data: {} };
  };

  await client.respondExtensionUi({
    type: "extension_ui_response",
    id: "ui-1",
    confirmed: true,
  });
  assert.deepEqual(sent, {
    type: "extension_ui_response",
    id: "ui-1",
    confirmed: true,
  });
});

test("rpc client typed request unwraps daemon response data", async () => {
  const client = new RinDaemonFrontendClient("/tmp/fake.sock");
  client.isConnected = () => true;
  client.send = async (payload) => ({
    success: true,
    data: { payload },
  });

  assert.deepEqual(await client.getState(), {
    payload: { type: "get_state" },
  });
  assert.deepEqual(await client.runCommand("/hello"), {
    payload: { type: "run_command", commandLine: "/hello" },
  });
});

test("rpc client normalizes session list display metadata from daemon responses", async () => {
  const client = new RinDaemonFrontendClient("/tmp/fake.sock");
  client.isConnected = () => true;
  client.send = async (payload) => {
    if (payload.type === "list_sessions") {
      return {
        success: true,
        data: {
          sessions: [
            {
              id: "session-1",
              path: "/tmp/session-1.jsonl",
              title: "Legacy title",
              subtitle: "2026-04-18T00:00:00.000Z",
            },
          ],
        },
      };
    }
    if (payload.type === "get_state") {
      return {
        success: true,
        data: { sessionFile: "/tmp/session-1.jsonl" },
      };
    }
    return { success: true, data: {} };
  };

  const sessions = await client.listSessions();

  assert.deepEqual(sessions, [
    {
      id: "/tmp/session-1.jsonl",
      title: "Legacy title",
      subtitle: "2026-04-18T00:00:00.000Z",
      isActive: true,
    },
  ]);
});

test("rpc interactive session startup fails when the daemon is unavailable", async () => {
  const client = {
    isConnected: () => false,
    connect: async () => {
      throw new Error("daemon_down");
    },
    subscribe: () => () => {},
    disconnect: async () => {},
  };
  const session = new RpcInteractiveSession(client);
  session.ensureReconnectLoop = async () => {};

  await assert.rejects(session.connect(), /daemon_down/);
  assert.equal(session.rpcConnected, false);
  assert.deepEqual(session.getFrontendStatusEvent(), {
    type: "rpc_frontend_status",
    phase: "connecting",
    label: "Connecting",
    connected: false,
  });
});

test("rpc interactive session keeps a recovering turn busy while reconnecting after disconnect", () => {
  const client = { isConnected: () => false };
  const session = new RpcInteractiveSession(client);
  const seen = [];
  session.subscribe((event) => seen.push(event));
  session.ensureReconnectLoop = () => {};
  session.recoveryPending = false;
  session.rpcConnected = true;
  session.activeTurn = { mode: "prompt", message: "hi" };
  session.backendWorkingVisible = true;
  session.syncStreamingState();
  seen.length = 0;

  session.handleConnectionLost();

  assert.equal(session.isStreaming, true);
  assert.equal(session.activeTurn, null);
  assert.equal(session.backendWorkingVisible, true);
  assert.deepEqual(session.getFrontendStatusEvent(), {
    type: "rpc_frontend_status",
    phase: "connecting",
    label: "Connecting",
    connected: false,
  });
  assert.deepEqual(seen, [
    {
      type: "rpc_frontend_status",
      phase: "connecting",
      label: "Connecting",
      connected: false,
    },
  ]);
});

test("rpc interactive session replays the current frontend status to new subscribers", () => {
  const client = { isConnected: () => false };
  const session = new RpcInteractiveSession(client);
  session.sessionOperationPending = true;
  session.rpcConnected = true;

  const seen = [];
  session.subscribe((event) => seen.push(event));

  assert.deepEqual(seen, [
    {
      type: "rpc_frontend_status",
      phase: "starting",
      label: "Starting",
      connected: true,
    },
  ]);
});

test("rpc interactive session stays in connecting until session recovery succeeds", async () => {
  const client = { isConnected: () => true };
  const session = new RpcInteractiveSession(client);
  session.sessionFile = "/tmp/demo.jsonl";
  session.startupPending = false;
  session.recoveryPending = true;
  session.rpcConnected = false;
  session.call = async () => {
    throw new Error("rin_timeout:select_session");
  };
  session.refreshState = async () => {};

  await assert.rejects(
    session.handleConnectionRestored(),
    /rin_timeout:select_session/,
  );

  assert.equal(session.rpcConnected, false);
  assert.equal(session.recoveryPending, true);
  assert.deepEqual(session.getFrontendStatusEvent(), {
    type: "rpc_frontend_status",
    phase: "connecting",
    label: "Connecting",
    connected: false,
  });
});

test("rpc interactive session exposes compaction as a distinct frontend phase", () => {
  const client = { isConnected: () => true };
  const session = new RpcInteractiveSession(client);
  session.rpcConnected = true;
  session.startupPending = false;
  session.isCompacting = true;

  assert.deepEqual(session.getFrontendStatusEvent(), {
    type: "rpc_frontend_status",
    phase: "compacting",
    label: "Compacting context",
    connected: true,
  });
});

test("rpc interactive session does not derive Working from turnActive snapshots", () => {
  const client = { isConnected: () => true };
  const session = new RpcInteractiveSession(client);
  session.rpcConnected = true;
  session.startupPending = false;

  session.applyState({
    sessionId: "s1",
    sessionFile: "/tmp/demo.jsonl",
    turnActive: true,
    isStreaming: false,
    isCompacting: false,
    workingVisible: false,
  });

  assert.equal(session.remoteTurnRunning, true);
  assert.equal(session.agentStreaming, false);
  assert.equal(session.isStreaming, true);
  assert.equal(session.getFrontendStatusEvent(), null);
});

test("rpc interactive session applies backend visibility at Pi agent boundaries", async () => {
  const client = { isConnected: () => true };
  const session = new RpcInteractiveSession(client);
  const visible: boolean[] = [];
  session.rpcConnected = true;
  session.startupPending = false;
  session.activeTurn = { mode: "prompt", message: "hello" };
  session.extensionBindings = {
    uiContext: {
      setWorkingVisible(value) {
        visible.push(value);
      },
    },
  };

  session.handleRpcEvent({
    type: "extension_ui_request",
    method: "setWorkingVisible",
    visible: true,
  });
  assert.equal(session.backendWorkingVisible, true);
  assert.deepEqual(visible, []);
  assert.equal(session.getFrontendStatusEvent()?.phase, "sending");

  session.handleRpcEvent({ type: "agent_start" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(visible, [true]);
  assert.equal(session.getFrontendStatusEvent()?.phase, "working");

  session.handleRpcEvent({
    type: "extension_ui_request",
    method: "setWorkingVisible",
    visible: false,
  });
  session.handleRpcEvent({ type: "agent_end" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(visible, [true, false]);
  assert.equal(session.getFrontendStatusEvent()?.phase, "sending");
});

test("rpc interactive session clears recovering turn state after an idle recovery snapshot", () => {
  const client = { isConnected: () => true };
  const session = new RpcInteractiveSession(client);
  session.recoveryPending = true;
  session.recoveringTurnPending = true;
  session.rpcConnected = true;
  session.startupPending = false;
  session.syncStreamingState();

  session.applyState({
    sessionId: "s1",
    sessionFile: "/tmp/demo.jsonl",
    turnActive: false,
    isStreaming: false,
    isCompacting: false,
  });

  assert.equal(session.isStreaming, false);
  assert.equal(session.recoveringTurnPending, false);
  assert.equal(session.getFrontendStatusEvent()?.phase, "connecting");
});

test("rpc interactive session clears stale local turn state when the worker reports turn inactive", () => {
  const client = { isConnected: () => true };
  const session = new RpcInteractiveSession(client);
  session.rpcConnected = true;
  session.startupPending = false;
  session.activeTurn = { mode: "prompt", message: "demo" };
  session.setTurnActive(true);

  session.applyState({
    sessionId: "s1",
    sessionFile: "/tmp/demo.jsonl",
    turnActive: false,
    isStreaming: false,
    isCompacting: false,
  });

  assert.equal(session.remoteTurnRunning, false);
  assert.equal(session.activeTurn, null);
  assert.equal(session.getFrontendStatusEvent(), null);
});

test("rpc interactive session reconnect loop restores transport and session in one pipeline", async () => {
  let connected = false;
  let connectCalls = 0;
  let restoreCalls = 0;
  const client = {
    isConnected: () => connected,
    connect: async () => {
      connectCalls += 1;
      connected = true;
    },
  };
  const session = new RpcInteractiveSession(client);
  session.rpcConnected = false;
  session.recoveryPending = true;
  session.handleConnectionRestored = async () => {
    restoreCalls += 1;
    session.rpcConnected = true;
    session.recoveryPending = false;
  };

  await session.ensureReconnectLoop();

  assert.equal(connectCalls, 1);
  assert.equal(restoreCalls, 1);
  assert.equal(session.reconnecting, false);
});

test("rpc interactive session waitForDaemonAvailable reuses the reconnect pipeline", async () => {
  const client = { isConnected: () => false };
  const session = new RpcInteractiveSession(client);
  let reconnects = 0;
  session.ensureReconnectLoop = async () => {
    reconnects += 1;
  };

  await session.waitForDaemonAvailable();

  assert.equal(reconnects, 1);
});

test("rpc interactive session reconnect loop re-runs restore while stuck in recovery without a fresh disconnect", async () => {
  const client = {
    isConnected: () => true,
    connect: async () => {},
  };
  const session = new RpcInteractiveSession(client);
  session.rpcConnected = true;
  session.startupPending = false;
  session.recoveryPending = true;
  session.restorePromise = null;
  let restoreCalls = 0;
  session.handleConnectionRestored = async () => {
    restoreCalls += 1;
    session.rpcConnected = true;
    session.recoveryPending = false;
  };

  await session.ensureReconnectLoop();

  assert.equal(restoreCalls, 1);
  assert.equal(session.reconnecting, false);
  assert.deepEqual(session.getFrontendStatusEvent(), null);
});

test("rpc interactive session keeps the daemon connection while a worker exits mid-turn", () => {
  const client = { isConnected: () => true };
  const session = new RpcInteractiveSession(client);
  let reconnects = 0;
  session.ensureReconnectLoop = () => {
    reconnects += 1;
  };
  session.rpcConnected = true;
  session.startupPending = false;
  session.activeTurn = {
    mode: "prompt",
    message: "recall",
    requestTag: "tag-1",
  };
  session.setTurnActive(true);

  const seen = [];
  session.subscribe((event) => seen.push(event));
  seen.length = 0;

  session.handleRpcEvent({ type: "worker_exit", code: 9, signal: null });

  assert.equal(session.activeTurn, null);
  assert.equal(reconnects, 1);
  assert.deepEqual(session.getFrontendStatusEvent(), {
    type: "rpc_frontend_status",
    phase: "connecting",
    label: "Connecting",
    connected: true,
  });
  assert.deepEqual(seen, [
    {
      type: "rpc_frontend_status",
      phase: "connecting",
      label: "Connecting",
      connected: true,
    },
    { type: "worker_exit", code: 9, signal: null },
  ]);
});

test("rpc interactive session does not self-deadlock when restore sees a disconnected request", async () => {
  const client = {
    isConnected: () => true,
    send: async (payload) => {
      if (payload.type === "select_session") {
        throw new Error("rin_disconnected:req_restore");
      }
      return { success: true, data: {} };
    },
  };
  const session = new RpcInteractiveSession(client);
  session.sessionFile = "/tmp/demo.jsonl";
  session.rpcConnected = true;
  session.recoveryPending = true;
  session.reconnectPromise = Promise.resolve();

  await assert.rejects(
    session.handleConnectionRestored(),
    /rin_disconnected:req_restore/,
  );

  assert.equal(session.recoveryPending, true);
});

test("rpc interactive session preserves native prompt payloads through the shared frontend SDK helper", async () => {
  const calls = [];
  const client = {
    isConnected: () => true,
    send: async (payload) => {
      calls.push(payload);
      return { success: true, data: {} };
    },
  };
  const session = new RpcInteractiveSession(client);
  session.ensureRemoteSession = async () => {};
  session.rpcConnected = true;

  await session.prompt("  hello  ", {
    expandPromptTemplates: false,
    images: [{ path: "/tmp/a.png" }],
    source: "tui-test",
    streamingBehavior: "followUp",
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    type: "prompt",
    message: "  hello  ",
    images: [{ path: "/tmp/a.png" }],
    source: "tui-test",
    streamingBehavior: "followUp",
    requestTag: calls[0]?.requestTag,
  });
  assert.match(String(calls[0]?.requestTag || ""), /^rin-tui-/);
});

test("rpc interactive session attaches a request tag to prompt turns by default", async () => {
  const calls = [];
  const client = {
    isConnected: () => true,
    send: async (payload) => {
      calls.push(payload);
      return { success: true, data: {} };
    },
  };
  const session = new RpcInteractiveSession(client);
  session.ensureRemoteSession = async () => {};
  session.rpcConnected = true;

  await session.prompt("hello", { expandPromptTemplates: false });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.type, "prompt");
  assert.match(String(calls[0]?.requestTag || ""), /^rin-tui-/);
});

test("rpc interactive session recovers prompt submission timeout without surfacing an editor exception", async () => {
  const calls = [];
  let promptCalls = 0;
  const client = {
    isConnected: () => true,
    send: async (payload) => {
      calls.push(payload);
      if (payload.type === "prompt") {
        promptCalls += 1;
        if (promptCalls === 1) throw new Error("rin_timeout:prompt");
        return { success: true, data: {} };
      }
      if (payload.type === "get_state") {
        return {
          success: true,
          data: {
            sessionId: "s1",
            sessionFile: "/tmp/s1.jsonl",
            thinkingLevel: "medium",
            steeringMode: "all",
            followUpMode: "one-at-a-time",
            autoCompactionEnabled: false,
            turnActive: false,
            isStreaming: false,
            isCompacting: false,
            pendingMessageCount: 0,
          },
        };
      }
      return { success: true, data: {} };
    },
  };
  const session = new RpcInteractiveSession(client);
  session.ensureRemoteSession = async () => {};
  session.refreshState = async () => {};
  session.ensureReconnectLoop = () => Promise.resolve();
  session.rpcConnected = true;
  session.startupPending = false;

  await session.prompt("hello", { expandPromptTemplates: false });

  assert.equal(promptCalls, 1);
  assert.equal(session.recoveryPending, true);
  assert.deepEqual(session.getFrontendStatusEvent(), {
    type: "rpc_frontend_status",
    phase: "connecting",
    label: "Connecting",
    connected: true,
  });

  session.handleSessionRecovered();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(promptCalls, 2);
  assert.deepEqual(
    calls
      .filter((payload) => payload.type === "prompt")
      .map((payload) => payload.message),
    ["hello", "hello"],
  );
  assert.equal(session.recoveryPending, false);
});

test("rpc interactive session recovers steer prompt timeout without surfacing an editor exception", async () => {
  const calls = [];
  let promptCalls = 0;
  const client = {
    isConnected: () => true,
    send: async (payload) => {
      calls.push(payload);
      if (payload.type === "prompt") {
        promptCalls += 1;
        throw new Error("rin_timeout:prompt");
      }
      if (payload.type === "get_state") {
        return {
          success: true,
          data: {
            sessionId: "s1",
            sessionFile: "/tmp/s1.jsonl",
            thinkingLevel: "medium",
            steeringMode: "all",
            followUpMode: "one-at-a-time",
            autoCompactionEnabled: false,
            turnActive: true,
            isStreaming: true,
            isCompacting: false,
            pendingMessageCount: 0,
          },
        };
      }
      return { success: true, data: {} };
    },
  };
  const session = new RpcInteractiveSession(client);
  session.ensureRemoteSession = async () => {};
  session.refreshState = async () => {};
  session.ensureReconnectLoop = () => Promise.resolve();
  session.rpcConnected = true;
  session.startupPending = false;
  session.remoteTurnRunning = true;
  session.syncStreamingState();

  await session.prompt("steer", {
    expandPromptTemplates: false,
    streamingBehavior: "steer",
  });

  assert.equal(promptCalls, 1);
  assert.equal(session.recoveryPending, true);
  assert.deepEqual(session.getFrontendStatusEvent(), {
    type: "rpc_frontend_status",
    phase: "connecting",
    label: "Connecting",
    connected: true,
  });

  session.handleSessionRecovered();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(promptCalls, 1);
  assert.deepEqual(
    calls.filter((payload) => payload.type === "prompt"),
    [
      {
        type: "prompt",
        message: "steer",
        images: undefined,
        streamingBehavior: undefined,
        source: undefined,
        requestTag: calls[0]?.requestTag,
      },
    ],
  );
  assert.equal(session.recoveryPending, false);
  assert.equal(session.remoteTurnRunning, true);
});

test("rpc interactive session preserves raw runtime error markers inside session logic", async () => {
  const session = new RpcInteractiveSession({
    isConnected: () => true,
    send: async () => {
      throw new Error("rin_request_failed");
    },
  });
  session.ensureRemoteSession = async () => {};
  session.rpcConnected = true;

  await assert.rejects(
    session.prompt("hello", { expandPromptTemplates: false }),
    /rin_request_failed/,
  );
});

test("rpc interactive session can shut down or terminate an attached worker without local session selectors", async () => {
  const calls = [];
  const client = {
    isConnected: () => true,
    send: async (payload) => {
      calls.push(payload);
      return { success: true, data: { terminated: true } };
    },
  };
  const session = new RpcInteractiveSession(client);
  session.rpcConnected = true;

  await session.shutdownSession();
  await session.terminateSession();

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.type, "shutdown_session");
  assert.equal(calls[1]?.type, "terminate_session");
});

test("rpc interactive session keeps recovery-pending prompts out of the Pi queue projection", async () => {
  const calls = [];
  const seen = [];
  const session = new RpcInteractiveSession({
    isConnected: () => true,
    send: async (payload) => {
      calls.push(payload);
      return { success: true, data: {} };
    },
  });
  session.ensureReconnectLoop = () => Promise.resolve();
  session.startupPending = false;
  session.recoveryPending = true;
  session.rpcConnected = true;
  session.subscribe((event) => seen.push(event));
  seen.length = 0;

  await session.prompt("hello", { expandPromptTemplates: false });

  assert.equal(calls.length, 0);
  assert.deepEqual(session.queuedOfflineOps, [
    {
      mode: "prompt",
      message: "hello",
      images: undefined,
      streamingBehavior: undefined,
      source: undefined,
      requestTag: session.queuedOfflineOps[0]?.requestTag,
    },
  ]);
  assert.match(
    String(session.queuedOfflineOps[0]?.requestTag || ""),
    /^rin-tui-/,
  );
  assert.deepEqual(session.getSteeringMessages(), []);
  assert.equal(session.pendingMessageCount, 1);
  assert.deepEqual(
    seen.filter((event) => event.type === "queue_update"),
    [{ type: "queue_update", steering: [], followUp: [] }],
  );
  assert.deepEqual(session.getFrontendStatusEvent(), {
    type: "rpc_frontend_status",
    phase: "connecting",
    label: "Connecting",
    connected: true,
  });

  const cleared = session.clearQueue();
  assert.deepEqual(cleared, { steering: [], followUp: [] });
  assert.deepEqual(session.queuedOfflineOps, []);
  assert.deepEqual(session.getSteeringMessages(), []);
  assert.equal(session.pendingMessageCount, 0);
});

test("rpc interactive session exits connecting after get_state succeeds and delays resync until history refresh finishes", async () => {
  const calls = [];
  const refreshes = [];
  let releaseRefresh;
  const refreshGate = new Promise((resolve) => {
    releaseRefresh = resolve;
  });
  const session = new RpcInteractiveSession({
    isConnected: () => true,
    send: async (payload) => {
      calls.push(payload);
      if (payload.type === "get_state") {
        return {
          success: true,
          data: {
            sessionId: "s1",
            sessionFile: "/tmp/s1.jsonl",
            thinkingLevel: "medium",
            steeringMode: "all",
            followUpMode: "one-at-a-time",
            autoCompactionEnabled: false,
            isStreaming: true,
            workingVisible: true,
            isCompacting: false,
            pendingMessageCount: 0,
          },
        };
      }
      return { success: true, data: {} };
    },
  });
  let resyncs = 0;
  session.emitSessionResynced = () => {
    resyncs += 1;
  };
  session.refreshState = async (flags) => {
    refreshes.push(flags);
    await refreshGate;
  };
  session.rpcConnected = true;
  session.startupPending = false;
  session.recoveryPending = true;

  session.handleSessionRecovered();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(session.recoveryPending, false);
  assert.equal(resyncs, 0);
  assert.equal(session.backendWorkingVisible, true);
  assert.deepEqual(session.getFrontendStatusEvent(), {
    type: "rpc_frontend_status",
    phase: "working",
    label: "Working",
    connected: true,
  });
  assert.deepEqual(
    calls.map((payload) => payload.type),
    ["get_state", "replay_pending_terminal_turn_event"],
  );
  assert.deepEqual(refreshes, [{ messages: true, session: true }]);

  releaseRefresh();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(resyncs, 1);
});

test("rpc interactive session finishes daemon-side session recovery without dropping transport", async () => {
  const calls = [];
  const refreshes = [];
  let releaseRefresh;
  const refreshGate = new Promise((resolve) => {
    releaseRefresh = resolve;
  });
  const session = new RpcInteractiveSession({
    isConnected: () => true,
    send: async (payload) => {
      calls.push(payload);
      switch (payload.type) {
        case "get_state":
          return {
            success: true,
            data: {
              sessionId: "s1",
              sessionFile: "/tmp/s1.jsonl",
              thinkingLevel: "medium",
              steeringMode: "all",
              followUpMode: "one-at-a-time",
              autoCompactionEnabled: false,
              isStreaming: false,
              isCompacting: false,
              pendingMessageCount: 0,
            },
          };
        default:
          return { success: true, data: {} };
      }
    },
  });
  let resyncs = 0;
  session.emitSessionResynced = () => {
    resyncs += 1;
  };
  session.refreshState = async (flags) => {
    refreshes.push(flags);
    await refreshGate;
  };
  session.rpcConnected = true;
  session.startupPending = false;
  session.recoveryPending = true;
  session.queuedOfflineOps = [
    {
      mode: "prompt",
      message: "hello",
      requestTag: "tag-1",
    },
  ];

  session.handleSessionRecovered();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(session.recoveryPending, false);
  assert.equal(resyncs, 0);
  assert.equal(session.queuedOfflineOps.length, 0);
  assert.deepEqual(
    calls.map((payload) => payload.type),
    ["get_state", "replay_pending_terminal_turn_event", "prompt"],
  );
  assert.deepEqual(refreshes, [{ messages: true, session: true }]);

  releaseRefresh();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(resyncs, 1);
});

test("rpc interactive session clears the busy state immediately when abort is requested", async () => {
  let abortResolved = false;
  let resolveAbort;
  const client = {
    abort: () =>
      new Promise((resolve) => {
        resolveAbort = () => {
          abortResolved = true;
          resolve();
        };
      }),
  };
  const session = new RpcInteractiveSession(client);
  session.rpcConnected = true;
  session.startupPending = false;
  session.activeTurn = {
    mode: "prompt",
    message: "hello",
    requestTag: "tag-1",
  };
  session.remoteTurnRunning = true;
  session.isCompacting = true;
  session.isBashRunning = true;
  session.retryAttempt = 2;
  session.syncStreamingState();

  const seen = [];
  session.subscribe((event) => seen.push(event));
  seen.length = 0;

  await session.abort();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(session.activeTurn, null);
  assert.equal(session.remoteTurnRunning, false);
  assert.equal(session.isCompacting, false);
  assert.equal(session.isBashRunning, false);
  assert.equal(session.retryAttempt, 0);
  assert.equal(session.isStreaming, false);
  assert.equal(session.getFrontendStatusEvent(), null);
  assert.equal(abortResolved, false);
  assert.deepEqual(seen, [{ type: "rpc_frontend_status", phase: "idle" }]);

  resolveAbort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(abortResolved, true);
});
