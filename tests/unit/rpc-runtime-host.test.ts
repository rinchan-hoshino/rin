import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const { createRpcRuntimeHost } = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-tui", "runtime-host.js"),
  ).href
);

test("rpc runtime host adapts RpcInteractiveSession shape for InteractiveMode", async () => {
  const calls = [];
  const session = {
    id: "session-like",
    async newSession(options) {
      calls.push(["newSession", options]);
      return true;
    },
    async switchSession(sessionPath, options) {
      calls.push(["switchSession", sessionPath, options]);
      return false;
    },
    async fork(entryId, options) {
      calls.push(["fork", entryId, options]);
      return { cancelled: false, selectedText: "hi" };
    },
    async importFromJsonl(inputPath, cwdOverride) {
      calls.push(["importFromJsonl", inputPath, cwdOverride]);
      return true;
    },
    async shutdownLocalExtensions(event) {
      calls.push(["shutdownLocalExtensions", event]);
    },
    async shutdownSession() {
      calls.push(["shutdownSession"]);
    },
    async terminateSession() {
      calls.push(["terminateSession"]);
    },
    async disconnect() {
      calls.push(["disconnect"]);
    },
  };

  const runtimeHost = createRpcRuntimeHost(session);

  runtimeHost.setBeforeSessionInvalidate(() =>
    calls.push(["beforeInvalidate"]),
  );
  runtimeHost.setRebindSession(async (nextSession) =>
    calls.push(["rebind", nextSession.id]),
  );

  assert.equal(runtimeHost.session, session);
  assert.deepEqual(await runtimeHost.newSession({ parentSession: "p" }), {
    cancelled: false,
  });
  const switchOptions = {
    cwdOverride: "/tmp/cwd",
    withSession: async () => {},
  };
  const forkOptions = { position: "at", withSession: async () => {} };
  assert.deepEqual(
    await runtimeHost.switchSession("/tmp/demo.jsonl", switchOptions),
    {
      cancelled: true,
    },
  );
  assert.deepEqual(await runtimeHost.fork("entry-1", forkOptions), {
    cancelled: false,
    selectedText: "hi",
  });
  assert.deepEqual(
    await runtimeHost.importFromJsonl("/tmp/in.jsonl", "/tmp/cwd"),
    { cancelled: false },
  );
  await runtimeHost.dispose();

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

test("rpc runtime host bounds remote shutdown before disconnecting", async () => {
  const calls = [];
  let finishShutdown;
  const session = {
    async shutdownLocalExtensions(event) {
      calls.push(["shutdownLocalExtensions", event]);
    },
    shutdownSession() {
      calls.push(["shutdownSession"]);
      return new Promise((resolve) => {
        finishShutdown = resolve;
      });
    },
    async disconnect() {
      calls.push(["disconnect"]);
    },
  };
  const runtimeHost = createRpcRuntimeHost(session, { shutdownGraceMs: 20 });
  const dispose = runtimeHost.dispose();
  let watchdog;

  try {
    await new Promise((resolve) => setTimeout(resolve, 1));
    assert.deepEqual(calls, [
      ["shutdownLocalExtensions", { reason: "quit" }],
      ["shutdownSession"],
    ]);

    await Promise.race([
      dispose,
      new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("dispose_timeout")), 200);
      }),
    ]);
    assert.equal(
      calls.some(([name]) => name === "disconnect"),
      true,
    );
  } finally {
    if (watchdog) clearTimeout(watchdog);
    finishShutdown?.();
    await dispose;
  }
});

test("rpc runtime host disconnects when remote shutdown rejects", async () => {
  const calls = [];
  const session = {
    async shutdownLocalExtensions(event) {
      calls.push(["shutdownLocalExtensions", event]);
    },
    async shutdownSession() {
      calls.push(["shutdownSession"]);
      throw new Error("shutdown_failed");
    },
    async disconnect() {
      calls.push(["disconnect"]);
    },
  };
  const runtimeHost = createRpcRuntimeHost(session);

  await runtimeHost.dispose();

  assert.deepEqual(calls, [
    ["shutdownLocalExtensions", { reason: "quit" }],
    ["shutdownSession"],
    ["disconnect"],
  ]);
});
