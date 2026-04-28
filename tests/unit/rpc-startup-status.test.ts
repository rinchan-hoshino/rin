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

function createClient() {
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
  };
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
  session.remoteTurnRunning = true;
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
