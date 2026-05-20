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
  assert.equal(dispatcher.classifyRinFrontendCommand("/todos").kind, "daemon");
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
  assert.deepEqual(dispatcher.RIN_NON_INTERACTIVE_COMMAND_NAMES, [
    "help",
    "abort",
    "new",
    "compact",
    "reload",
    "status",
    "session",
    "model",
  ]);
  assert.deepEqual(
    dispatcher.getRinNonInteractiveCommandInteractionPolicy("new"),
    {
      skipSessionRecovery: true,
      acceptInboundBeforeExecution: true,
    },
  );
  assert.deepEqual(
    dispatcher.getRinNonInteractiveCommandInteractionPolicy("session"),
    {
      skipSessionRecovery: false,
      acceptInboundBeforeExecution: false,
    },
  );
});
