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

test("turn scope rejects unavailable and inconsistent initial branch cursors", () => {
  for (const session of [
    null,
    {},
    { sessionManager: {} },
    { sessionManager: { getBranch: () => [], getLeafId: undefined } },
    { sessionManager: { getBranch: () => null, getLeafId: () => null } },
    { sessionManager: { getBranch: () => [], getLeafId: () => 42 } },
    { sessionManager: { getBranch: () => [], getLeafId: () => "orphan" } },
    {
      sessionManager: {
        getBranch: () => [{ type: "message" }],
        getLeafId: () => "leaf",
      },
    },
    {
      sessionManager: {
        getBranch: () => [{ id: "branch-leaf", type: "message" }],
        getLeafId: () => "other-leaf",
      },
    },
  ]) {
    assert.throws(() => captureTurnScope(session), /cursor is unavailable/);
  }
});

test("turn scope rejects invalid branch ownership while reading", () => {
  const manager = managerFor([]);
  const session = { sessionManager: manager };
  const emptyScope = captureTurnScope(session);

  const originalGetBranch = manager.getBranch;
  const originalGetLeafId = manager.getLeafId;
  (manager as any).getBranch = () => null;
  assert.throws(
    () => readTurnMessages(session, emptyScope),
    /branch ownership changed/,
  );
  (manager as any).getBranch = originalGetBranch;
  (manager as any).getLeafId = undefined;
  assert.throws(
    () => readTurnMessages(session, emptyScope),
    /branch ownership changed/,
  );
  (manager as any).getLeafId = () => 42;
  assert.throws(
    () => readTurnMessages(session, emptyScope),
    /branch ownership changed/,
  );
  (manager as any).getLeafId = () => "orphan";
  assert.throws(
    () => readTurnMessages(session, emptyScope),
    /branch ownership changed/,
  );

  manager.replace([{ type: "message", message: null }]);
  (manager as any).getLeafId = () => "leaf";
  assert.throws(
    () => readTurnMessages(session, emptyScope),
    /branch ownership changed/,
  );
  manager.replace([{ id: "leaf", type: "message", message: null }]);
  (manager as any).getLeafId = () => "other";
  assert.throws(
    () => readTurnMessages(session, emptyScope),
    /branch ownership changed/,
  );

  (manager as any).getBranch = originalGetBranch;
  (manager as any).getLeafId = originalGetLeafId;
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
