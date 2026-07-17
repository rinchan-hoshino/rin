import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const rpc = await importBuiltModule<
  typeof import("../../src/core/rin-lib/rpc.js")
>("dist/core/rin-lib/rpc.js");

test("rpc command catalog preserves Rin overrides and generic prompt routing", () => {
  assert.deepEqual(
    rpc.RIN_BUILTIN_SLASH_COMMANDS.map((command) => command.name),
    ["abort", "usage"],
  );
  assert.equal(
    rpc.BUILTIN_SLASH_COMMANDS.find((command) => command.name === "abort")
      ?.origin,
    "rin",
  );
  assert.equal(
    rpc.BUILTIN_SLASH_COMMANDS.find((command) => command.name === "usage")
      ?.genericPromptRoute,
    "run_command",
  );
  assert.equal(
    rpc.BUILTIN_SLASH_COMMANDS.some((command) =>
      /\bPi\b|\bpi\b/.test(command.description),
    ),
    false,
  );
  assert.equal(
    rpc.isGenericPromptRunCommandBuiltinSlashCommand("  usage  "),
    true,
  );
  assert.equal(
    rpc.isGenericPromptRunCommandBuiltinSlashCommand("abort"),
    false,
  );
  assert.equal(rpc.isGenericPromptRunCommandBuiltinSlashCommand(null), false);
});

test("rpc command scope recognizes only normalized session commands", () => {
  for (const command of [
    " prompt ",
    "get_state",
    "run_command",
    "shutdown_session",
    "reload",
  ]) {
    assert.equal(rpc.isSessionScopedCommand(command), true, command);
  }
  assert.equal(rpc.isSessionScopedCommand("list_sessions"), false);
  assert.equal(rpc.isSessionScopedCommand(""), false);
});

test("rpc response helpers preserve payloads and normalize failures", () => {
  assert.deepEqual(rpc.response("1", "get_state", true), {
    id: "1",
    type: "response",
    command: "get_state",
    success: true,
  });
  assert.deepEqual(rpc.ok(undefined, "prompt", { accepted: true }), {
    id: undefined,
    type: "response",
    command: "prompt",
    success: true,
    data: { accepted: true },
  });
  assert.deepEqual(rpc.fail("2", "prompt", { message: " stopped " }), {
    id: "2",
    type: "response",
    command: "prompt",
    success: false,
    error: "stopped",
  });
  assert.equal(rpc.fail("3", "prompt", { error: "failed" }).error, "failed");
  assert.equal(rpc.fail("4", "prompt", " denied ").error, "denied");
  assert.equal(rpc.fail("5", "prompt", {}).error, "[object Object]");
  assert.equal(rpc.fail("6", "prompt", "   ").error, "rin_request_failed");
  assert.equal(rpc.fail("7", "prompt", null).error, "rin_request_failed");
});

test("rpc empty session state returns independent canonical snapshots", () => {
  const first = rpc.emptySessionState();
  const second = rpc.emptySessionState();

  assert.notEqual(first, second);
  assert.deepEqual(first, {
    model: null,
    thinkingLevel: "medium",
    turnActive: false,
    isStreaming: false,
    isCompacting: false,
    steeringMode: "all",
    followUpMode: "one-at-a-time",
    sessionFile: undefined,
    sessionId: "",
    sessionName: undefined,
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0,
  });
  first.sessionId = "changed";
  assert.equal(second.sessionId, "");
});
