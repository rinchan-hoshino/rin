import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

type Route = { kind: "none" | "frontend" | "daemon"; name: string };
const dispatcher = await importBuiltModule<{
  RIN_NON_INTERACTIVE_COMMAND_NAMES: readonly string[];
  getRinFrontendSessionCommandSpec(line: string): { name: string } | undefined;
  isFrontendSessionCommandLine(line: string): boolean;
  isRinNonInteractiveCommandExposed(name: unknown): boolean;
  getRinNonInteractiveCommandInteractionPolicy(
    name: unknown,
  ): Record<string, unknown>;
  classifyRinFrontendCommand(
    line: string,
    catalog?: Array<Record<string, unknown>>,
  ): Route;
}>("dist/core/rin-frontend-sdk/command-dispatcher.js");

test("frontend dispatcher recognizes only complete session commands", () => {
  for (const [line, name] of [
    ["/abort", "abort"],
    [" /new ", "new"],
    ["/compact keep names", "compact"],
    ["/resume abc", "resume"],
  ]) {
    assert.equal(dispatcher.getRinFrontendSessionCommandSpec(line)?.name, name);
    assert.equal(dispatcher.isFrontendSessionCommandLine(line), true);
    assert.deepEqual(dispatcher.classifyRinFrontendCommand(line), {
      kind: "frontend",
      name,
    });
  }
  for (const line of ["", "/resume", "/resume   ", "/abort now", "/unknown"]) {
    assert.equal(dispatcher.getRinFrontendSessionCommandSpec(line), undefined);
    assert.equal(dispatcher.isFrontendSessionCommandLine(line), false);
  }
});

test("frontend dispatcher separates builtins, extensions, and unknown commands", () => {
  assert.deepEqual(dispatcher.classifyRinFrontendCommand(""), {
    kind: "none",
    name: "",
  });
  assert.deepEqual(dispatcher.classifyRinFrontendCommand("/usage"), {
    kind: "none",
    name: "usage",
  });
  assert.deepEqual(
    dispatcher.classifyRinFrontendCommand("/local", [
      { name: " local ", source: " extension " },
      { name: "ignored", source: "builtin" },
      {},
    ]),
    { kind: "daemon", name: "local" },
  );
  assert.deepEqual(dispatcher.classifyRinFrontendCommand("/other", []), {
    kind: "none",
    name: "other",
  });
  assert.deepEqual(dispatcher.classifyRinFrontendCommand("/todos"), {
    kind: "none",
    name: "todos",
  });
});

test("non-interactive exposure and active-turn policy require exact controls", () => {
  assert.deepEqual(dispatcher.RIN_NON_INTERACTIVE_COMMAND_NAMES, [
    "help",
    "abort",
    "new",
    "compact",
    "reload",
  ]);
  for (const name of ["new", "/new"]) {
    assert.equal(dispatcher.isRinNonInteractiveCommandExposed(name), true);
  }
  for (const name of ["resume", "todos", "status", "usage", null]) {
    assert.equal(dispatcher.isRinNonInteractiveCommandExposed(name), false);
  }
  assert.deepEqual(
    dispatcher.getRinNonInteractiveCommandInteractionPolicy("abort"),
    {
      skipSessionRecovery: false,
      acceptInboundBeforeExecution: true,
      activeTurnHandling: "abort",
    },
  );
  assert.deepEqual(
    dispatcher.getRinNonInteractiveCommandInteractionPolicy("/new"),
    {
      skipSessionRecovery: true,
      acceptInboundBeforeExecution: true,
      activeTurnHandling: "interrupt_then_run",
    },
  );
  assert.deepEqual(
    dispatcher.getRinNonInteractiveCommandInteractionPolicy("compact"),
    {
      skipSessionRecovery: false,
      acceptInboundBeforeExecution: true,
      activeTurnHandling: "none",
    },
  );
  assert.deepEqual(
    dispatcher.getRinNonInteractiveCommandInteractionPolicy("/new with args"),
    {
      skipSessionRecovery: false,
      acceptInboundBeforeExecution: false,
      activeTurnHandling: "none",
    },
  );
  assert.deepEqual(
    dispatcher.getRinNonInteractiveCommandInteractionPolicy("usage"),
    {
      skipSessionRecovery: false,
      acceptInboundBeforeExecution: false,
      activeTurnHandling: "none",
    },
  );
});
