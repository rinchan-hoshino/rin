import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const rpc = await importBuiltModule<
  typeof import("../../src/core/rin-lib/rpc.js")
>("dist/core/rin-lib/rpc.js");

test("rpc command catalog preserves Rin overrides and generic prompt routing", () => {
  assert.deepEqual(
    rpc.RIN_BUILTIN_SLASH_COMMANDS.map((command) => command.name),
    ["help", "abort", "status"],
  );
  assert.equal(
    rpc.BUILTIN_SLASH_COMMANDS.find((command) => command.name === "abort")
      ?.origin,
    "rin",
  );
  assert.equal(
    rpc.BUILTIN_SLASH_COMMANDS.some((command) => command.name === "usage"),
    false,
  );
  assert.equal(
    rpc.BUILTIN_SLASH_COMMANDS.find((command) => command.name === "resume")
      ?.chat,
    false,
  );
  assert.equal(
    rpc.BUILTIN_SLASH_COMMANDS.some((command) =>
      /\bPi\b|\bpi\b/.test(command.description),
    ),
    false,
  );
  assert.equal(
    rpc.isGenericPromptRunCommandBuiltinSlashCommand("  usage  "),
    false,
  );
  assert.equal(
    rpc.isGenericPromptRunCommandBuiltinSlashCommand("abort"),
    false,
  );
  assert.equal(rpc.isGenericPromptRunCommandBuiltinSlashCommand(null), false);
});

test("rpc command composition filters blanks and lets Rin override Pi", () => {
  assert.deepEqual(
    rpc.composeBuiltinSlashCommands(
      [
        { name: "", description: "" },
        { name: " shared ", description: "Pi pi" },
      ],
      [
        { name: " ", description: "ignored" },
        { name: "shared", description: "Rin override", origin: "rin" },
      ],
    ),
    [{ name: "shared", description: "Rin override", origin: "rin" }],
  );
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

test("rpc command module preserves response helper exports", () => {
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
  assert.equal(rpc.fail("2", "prompt", " stopped ").error, "stopped");
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
    working: false,
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
