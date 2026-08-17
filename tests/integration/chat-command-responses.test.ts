import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const commandResponses = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat", "command-responses.js"),
  ).href
);

test("chat command responses resolve stable English defaults", () => {
  assert.equal(
    commandResponses.resolveChatCommandResponses().abort,
    "Aborted current operation.",
  );
  assert.equal(
    commandResponses.resolveChatCommandResponses().compactionSummaryText,
    "{summary}",
  );
});

test("chat command responses accept partial extension contributions", () => {
  const responses = commandResponses.resolveChatCommandResponses({
    new: "New localized session",
    compactionStart: "Compacting locally",
    abort: "   ",
  });
  assert.equal(responses.new, "New localized session");
  assert.equal(responses.compactionStart, "Compacting locally");
  assert.equal(responses.abort, "Aborted current operation.");
});

test("chat command response presentation localizes builtin results", () => {
  const responses = commandResponses.resolveChatCommandResponses({
    new: "Localized new session",
    newCancelled: "Localized cancellation",
  });
  assert.equal(
    commandResponses.localizeChatBuiltinCommandResult(
      "new",
      { text: "frontend text", cancelled: false },
      responses,
    ).text,
    "Localized new session",
  );
  assert.equal(
    commandResponses.localizeChatBuiltinCommandResult(
      "new",
      { cancelled: true },
      responses,
    ).text,
    "Localized cancellation",
  );
});
