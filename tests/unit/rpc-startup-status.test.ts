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

function createClient(overrides = {}) {
  return {
    subscribe() {
      return () => {};
    },
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => false,
    send: async () => ({ success: true, data: {} }),
    submit: async () => {},
    abort: async () => {},
    getAutocompleteItems: async () => [],
    getCommands: async () => [],
    listSessions: async () => [],
    resumeSession: async () => {},
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("rpc frontend reports Starting during initial TUI startup", () => {
  const session = new RpcInteractiveSession(createClient());

  assert.deepEqual(session.getFrontendStatusEvent(), {
    type: "rpc_frontend_status",
    phase: "starting",
    label: "Starting",
    connected: false,
  });
});

test("rpc session manager exposes Pi persistence helpers", () => {
  const session = new RpcInteractiveSession(createClient());

  assert.equal(session.sessionManager.isPersisted(), false);
  assert.equal(session.sessionManager.usesDefaultSessionDir(), false);

  session.sessionFile = "/tmp/demo-session.jsonl";
  assert.equal(session.sessionManager.isPersisted(), true);
});

test("rpc frontend stays idle while loading resume sessions", async () => {
  const pending = deferred();
  const session = new RpcInteractiveSession(
    createClient({
      isConnected: () => true,
      send: () => pending.promise,
    }),
  );
  session.startupPending = false;
  session.rpcConnected = true;

  const events = [];
  session.subscribe((event) => events.push(event));
  const listPromise = session.listSessions("all");

  assert.deepEqual(events, []);

  pending.resolve({ success: true, data: { sessions: [] } });
  assert.deepEqual(await listPromise, []);
  assert.deepEqual(events, []);
});

test("rpc frontend status labels follow phase priority", () => {
  const session = new RpcInteractiveSession(createClient());
  session.startupPending = false;

  assert.deepEqual(session.getFrontendStatusEvent(), {
    type: "rpc_frontend_status",
    phase: "connecting",
    label: "Connecting",
    connected: false,
  });

  session.rpcConnected = true;
  session.isCompacting = true;
  assert.deepEqual(session.getFrontendStatusEvent(), {
    type: "rpc_frontend_status",
    phase: "compacting",
    label: "Compacting context",
    connected: true,
  });

  session.isCompacting = false;
  session.retryAttempt = 2;
  session.remoteTurnRunning = true;
  assert.deepEqual(session.getFrontendStatusEvent(), {
    type: "rpc_frontend_status",
    phase: "retrying",
    label: "Retrying",
    connected: true,
  });

  session.retryAttempt = 0;
  assert.deepEqual(session.getFrontendStatusEvent(), {
    type: "rpc_frontend_status",
    phase: "working",
    label: "Working",
    connected: true,
  });

  session.remoteTurnRunning = false;
  session.activeTurn = { mode: "prompt", message: "hello" };
  assert.deepEqual(session.getFrontendStatusEvent(), {
    type: "rpc_frontend_status",
    phase: "sending",
    label: "Sending",
    connected: true,
  });
});
