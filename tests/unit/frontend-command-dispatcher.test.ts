import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const dispatcher = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-frontend-sdk", "index.js"),
  ).href
);

test("frontend command dispatcher owns session command classification", () => {
  assert.equal(dispatcher.classifyRinFrontendCommand("/new").kind, "frontend");
  assert.equal(
    dispatcher.classifyRinFrontendCommand("/compact keep names").kind,
    "frontend",
  );
  assert.equal(
    dispatcher.classifyRinFrontendCommand("/resume abc").kind,
    "frontend",
  );
  assert.equal(dispatcher.classifyRinFrontendCommand("/todos").kind, "none");
  assert.equal(dispatcher.classifyRinFrontendCommand("/usage").kind, "daemon");
  assert.equal(dispatcher.classifyRinFrontendCommand("/unknown").kind, "none");
  assert.equal(
    dispatcher.classifyRinFrontendCommand("/local", [
      { name: "local", source: "extension" },
    ]).kind,
    "daemon",
  );
});

test("non-interactive command exposure and degraded interaction policy live in frontend SDK", () => {
  assert.equal(dispatcher.isRinNonInteractiveCommandExposed("new"), true);
  assert.equal(dispatcher.isRinNonInteractiveCommandExposed("resume"), false);
  assert.equal(dispatcher.isRinNonInteractiveCommandExposed("todos"), false);
  assert.equal(dispatcher.isRinNonInteractiveCommandExposed("status"), false);
  assert.equal(dispatcher.isRinNonInteractiveCommandExposed("model"), false);
  assert.equal(dispatcher.isRinNonInteractiveCommandExposed("session"), false);
  assert.equal(dispatcher.isRinNonInteractiveCommandExposed("usage"), true);
  assert.deepEqual(dispatcher.RIN_NON_INTERACTIVE_COMMAND_NAMES, [
    "help",
    "abort",
    "new",
    "compact",
    "reload",
    "usage",
  ]);
  assert.deepEqual(
    dispatcher.getRinNonInteractiveCommandInteractionPolicy("abort"),
    {
      skipSessionRecovery: false,
      acceptInboundBeforeExecution: true,
      activeTurnHandling: "abort",
    },
  );
  assert.deepEqual(
    dispatcher.getRinNonInteractiveCommandInteractionPolicy("new"),
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
    dispatcher.getRinNonInteractiveCommandInteractionPolicy("usage"),
    {
      skipSessionRecovery: false,
      acceptInboundBeforeExecution: false,
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
});
