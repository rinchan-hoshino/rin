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
    new: "Configured new session",
    compactionStart: "Configured compaction",
    abort: "   ",
  });
  assert.equal(responses.new, "Configured new session");
  assert.equal(responses.compactionStart, "Configured compaction");
  assert.equal(responses.abort, "Aborted current operation.");
});

test("chat command response presentation applies configured builtin text", () => {
  const responses = commandResponses.resolveChatCommandResponses({
    new: "Configured new session",
    newCancelled: "Configured cancellation",
  });
  assert.equal(
    commandResponses.applyChatBuiltinCommandText(
      "new",
      { text: "frontend text", cancelled: false },
      responses,
    ).text,
    "Configured new session",
  );
  assert.equal(
    commandResponses.applyChatBuiltinCommandText(
      "new",
      { cancelled: true },
      responses,
    ).text,
    "Configured cancellation",
  );
});
