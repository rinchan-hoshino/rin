import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const dispatcherModule = await import(
  pathToFileURL(
    path.join(
      rootDir,
      "dist",
      "core",
      "rin-daemon",
      "rpc-command-dispatcher.js",
    ),
  ).href
);

const inertHandlers = () => {
  const category = new Proxy({}, { get: () => () => undefined });
  return {
    extensionUi: category,
    turn: category,
    resource: category,
    auth: category,
    session: category,
  };
};

test("RPC command dispatcher routes every registered command exactly once", async () => {
  const calls: Array<{
    category: string;
    request: { command: unknown; id: string; type: string };
  }> = [];
  const category = (name: string) =>
    new Proxy(
      {},
      {
        get:
          () =>
          async (request: { command: unknown; id: string; type: string }) => {
            calls.push({ category: name, request });
            return name;
          },
      },
    );
  const handlers = {
    extensionUi: category("extensionUi"),
    turn: category("turn"),
    resource: category("resource"),
    auth: category("auth"),
    session: category("session"),
  };
  const dispatch = dispatcherModule.createRpcCommandDispatcher(handlers);

  assert.equal(dispatcherModule.RPC_MODE_COMMAND_TYPES.length, 60);
  assert.equal(
    new Set(dispatcherModule.RPC_MODE_COMMAND_TYPES).size,
    dispatcherModule.RPC_MODE_COMMAND_TYPES.length,
  );
  for (const type of dispatcherModule.RPC_MODE_COMMAND_TYPES) {
    const command = { id: `id-${type}`, type };
    await dispatch(command);
    assert.equal(calls.at(-1)?.request.command, command);
    assert.equal(calls.at(-1)?.request.id, command.id);
    assert.equal(calls.at(-1)?.request.type, type);
  }
  assert.equal(calls.length, dispatcherModule.RPC_MODE_COMMAND_TYPES.length);
});

test("RPC command dispatcher preserves the unknown-command error contract", async () => {
  const dispatch = dispatcherModule.createRpcCommandDispatcher(inertHandlers());
  await assert.rejects(
    () => dispatch({ id: "missing", type: "not_registered" }),
    /Unknown command: not_registered/,
  );
  await assert.rejects(() => dispatch({}), /Unknown command: unknown/);
});
