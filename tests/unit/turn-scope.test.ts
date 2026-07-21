import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const { captureTurnScope, readTurnMessages } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "session", "turn-scope.js"))
    .href
);

function managerFor(entries = []) {
  let branch = entries;
  return {
    getBranch: () => branch,
    getLeafId: () => branch.at(-1)?.id,
    replace(next) {
      branch = next;
    },
  };
}

test("turn scope allows an initially empty branch to create its first leaf", () => {
  const manager = managerFor([]);
  const session = { sessionManager: manager };
  const scope = captureTurnScope(session);

  manager.replace([
    {
      id: "first",
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    },
  ]);

  assert.deepEqual(readTurnMessages(session, scope), [
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ]);
});

test("turn scope returns only messages after the captured baseline leaf", () => {
  const manager = managerFor([
    {
      id: "before",
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "old" }] },
    },
  ]);
  const session = { sessionManager: manager };
  const scope = captureTurnScope(session);

  manager.replace([
    {
      id: "before",
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "old" }] },
    },
    { id: "metadata", type: "model_change", model: "demo" },
    {
      id: "after",
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "new" }] },
    },
  ]);

  assert.deepEqual(readTurnMessages(session, scope), [
    { role: "assistant", content: [{ type: "text", text: "new" }] },
  ]);
});

test("turn scope rejects a malformed manager leaf even on an empty branch", () => {
  const session = {
    sessionManager: {
      getBranch: () => [],
      getLeafId: () => 42,
    },
  };

  assert.throws(() => captureTurnScope(session), /cursor is unavailable/);
});

test("turn scope rejects session-manager replacement and baseline loss", () => {
  const manager = managerFor([
    { id: "before", type: "message", message: { role: "user", content: [] } },
  ]);
  const session = { sessionManager: manager };
  const scope = captureTurnScope(session);

  assert.throws(
    () => readTurnMessages({ sessionManager: managerFor([]) }, scope),
    /branch ownership changed/,
  );

  manager.replace([
    {
      id: "other",
      type: "message",
      message: { role: "assistant", content: [] },
    },
  ]);
  assert.throws(
    () => readTurnMessages(session, scope),
    /branch ownership changed/,
  );
});
