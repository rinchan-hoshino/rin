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
    async switchSession(sessionPath, cwdOverride) {
      calls.push(["switchSession", sessionPath, cwdOverride]);
      return false;
    },
    async fork(entryId) {
      calls.push(["fork", entryId]);
      return { cancelled: false, selectedText: "hi" };
    },
    async importFromJsonl(inputPath, cwdOverride) {
      calls.push(["importFromJsonl", inputPath, cwdOverride]);
      return true;
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
  assert.deepEqual(
    await runtimeHost.switchSession("/tmp/demo.jsonl", "/tmp/cwd"),
    { cancelled: true },
  );
  assert.deepEqual(await runtimeHost.fork("entry-1"), {
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
    ["rebind", "session-like"],
    ["switchSession", "/tmp/demo.jsonl", "/tmp/cwd"],
    ["fork", "entry-1"],
    ["beforeInvalidate"],
    ["rebind", "session-like"],
    ["importFromJsonl", "/tmp/in.jsonl", "/tmp/cwd"],
    ["beforeInvalidate"],
    ["rebind", "session-like"],
    ["beforeInvalidate"],
    ["terminateSession"],
    ["disconnect"],
  ]);
});
