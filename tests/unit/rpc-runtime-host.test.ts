import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

type Call = unknown[];
type FakeSession = Record<string, unknown>;
const runtimeHostModule = await importBuiltModule<{
  createRpcRuntimeHost(session: FakeSession): Record<string, any>;
}>("dist/core/rin-tui/runtime-host.js");

function createSession(calls: Call[]) {
  return {
    id: "session-like",
    async newSession(options: unknown) {
      calls.push(["newSession", options]);
      return true;
    },
    async switchSession(sessionPath: string, options: unknown) {
      calls.push(["switchSession", sessionPath, options]);
      return false;
    },
    async fork(entryId: string, options: unknown) {
      calls.push(["fork", entryId, options]);
      return { cancelled: false, selectedText: "hi" };
    },
    async importFromJsonl(inputPath: string, cwdOverride: string) {
      calls.push(["importFromJsonl", inputPath, cwdOverride]);
      return true;
    },
    async shutdownLocalExtensions(event: unknown) {
      calls.push(["shutdownLocalExtensions", event]);
    },
    async shutdownSession() {
      calls.push(["shutdownSession"]);
    },
    async disconnect() {
      calls.push(["disconnect"]);
    },
  };
}

test("RPC runtime host rebinds completed replacements and preserves cancellation", async () => {
  const calls: Call[] = [];
  const session = createSession(calls);
  const host = runtimeHostModule.createRpcRuntimeHost(session);
  host.setBeforeSessionInvalidate(() => calls.push(["beforeInvalidate"]));
  host.setRebindSession(async (next: { id: string }) => {
    calls.push(["rebind", next.id]);
  });

  assert.equal(host.session, session);
  assert.deepEqual(await host.newSession({ parentSession: "p" }), {
    cancelled: false,
  });
  const switchOptions = {
    cwdOverride: "/tmp/cwd",
    withSession: async () => {},
  };
  assert.deepEqual(await host.switchSession("/tmp/demo.jsonl", switchOptions), {
    cancelled: true,
  });
  const forkOptions = { position: "at" };
  assert.deepEqual(await host.fork("entry-1", forkOptions), {
    cancelled: false,
    selectedText: "hi",
  });
  assert.deepEqual(await host.importFromJsonl("/tmp/in.jsonl", "/tmp/cwd"), {
    cancelled: false,
  });
  await host.dispose();

  assert.deepEqual(calls, [
    ["newSession", { parentSession: "p" }],
    ["beforeInvalidate"],
    ["shutdownLocalExtensions", { reason: "new" }],
    ["rebind", "session-like"],
    ["switchSession", "/tmp/demo.jsonl", switchOptions],
    ["fork", "entry-1", forkOptions],
    ["beforeInvalidate"],
    ["shutdownLocalExtensions", { reason: "fork" }],
    ["rebind", "session-like"],
    ["importFromJsonl", "/tmp/in.jsonl", "/tmp/cwd"],
    ["beforeInvalidate"],
    ["shutdownLocalExtensions", { reason: "resume" }],
    ["rebind", "session-like"],
    ["beforeInvalidate"],
    ["shutdownLocalExtensions", { reason: "quit" }],
    ["shutdownSession"],
    ["disconnect"],
  ]);
});

test("RPC runtime host leaves cancelled forks untouched without optional callbacks", async () => {
  const calls: Call[] = [];
  const session = {
    async newSession() {
      return false;
    },
    async switchSession() {
      return false;
    },
    async fork() {
      return { cancelled: true };
    },
    async importFromJsonl() {
      return false;
    },
    async shutdownSession() {
      calls.push(["shutdownSession"]);
    },
    async disconnect() {
      calls.push(["disconnect"]);
    },
  };
  const host = runtimeHostModule.createRpcRuntimeHost(session);
  host.setBeforeSessionInvalidate(undefined);
  host.setRebindSession(undefined);
  assert.deepEqual(await host.newSession(), { cancelled: true });
  assert.deepEqual(await host.switchSession("file"), { cancelled: true });
  assert.deepEqual(await host.fork("entry"), { cancelled: true });
  assert.deepEqual(await host.importFromJsonl("file"), { cancelled: true });
  await host.dispose();
  assert.deepEqual(calls, [["shutdownSession"], ["disconnect"]]);
});
