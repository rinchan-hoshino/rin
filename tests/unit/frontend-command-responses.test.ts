import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const responsesModule = await importBuiltModule<
  typeof import("../../src/core/rin-frontend-sdk/command-responses.js")
>("dist/core/rin-frontend-sdk/command-responses.js");
const presentationModule = await importBuiltModule<
  typeof import("../../src/core/rin-frontend-sdk/command-result-presentation.js")
>("dist/core/rin-frontend-sdk/command-result-presentation.js");

test("frontend command responses parse builtin command lines", () => {
  assert.equal(
    responsesModule.frontendCommandNameFromLine("/compact now"),
    "compact",
  );
  assert.equal(responsesModule.frontendCommandNameFromLine("plain text"), "");
  assert.equal(responsesModule.frontendCommandNameFromLine("/"), "");
  assert.deepEqual(responsesModule.parseFrontendCompactCommand("/compact"), {
    compact: true,
    customInstructions: undefined,
  });
  assert.deepEqual(
    responsesModule.parseFrontendCompactCommand("/compact keep facts"),
    { compact: true, customInstructions: "keep facts" },
  );
  assert.deepEqual(responsesModule.parseFrontendCompactCommand("/status"), {
    compact: false,
    customInstructions: undefined,
  });
  assert.equal(responsesModule.isFrontendAbortCommand("/abort"), true);
  assert.equal(responsesModule.isFrontendAbortCommand("/abort later"), false);
  assert.equal(responsesModule.isFrontendNewSessionCommand("/new"), true);
  assert.equal(responsesModule.isFrontendNewSessionCommand(" /new "), true);
});

test("frontend command responses normalize configured text", () => {
  assert.equal(
    responsesModule.resolveRinFrontendCommandResponses(undefined).new,
    "Started a new session.",
  );
  const responses = responsesModule.resolveRinFrontendCommandResponses({
    compact: "done",
    reload: "loaded",
    new: "   ",
  });
  assert.equal(responses.compact, "done");
  assert.equal(responses.reload, "loaded");
  assert.equal(responses.new, "Started a new session.");
});

test("frontend command responses render abort, session, and reload states", () => {
  const responses = responsesModule.resolveRinFrontendCommandResponses();
  assert.deepEqual(
    responsesModule.applyFrontendBuiltinCommandText("abort", null),
    { text: "Aborted current operation." },
  );
  assert.equal(
    responsesModule.applyFrontendBuiltinCommandText("new", {}, responses).text,
    "Started a new session.",
  );
  assert.equal(
    responsesModule.applyFrontendBuiltinCommandText(
      "new",
      { cancelled: true },
      responses,
    ).text,
    "Session switch cancelled.",
  );
  assert.equal(
    responsesModule.applyFrontendBuiltinCommandText(
      "compact",
      { compactionBusy: true, text: "Already running" },
      responses,
    ).text,
    "Already running",
  );
  assert.equal(
    responsesModule.applyFrontendBuiltinCommandText(
      "reload",
      { text: "native reload" },
      responses,
    ).text,
    "native reload",
  );
  assert.equal(
    responsesModule.applyFrontendBuiltinCommandText(
      "reload",
      { text: "native reload" },
      responses,
      { preferConfiguredText: true },
    ).text,
    "Reloaded extensions, prompts, skills, and themes.",
  );
});

test("frontend command responses render nested backend facts with frontend-owned text", () => {
  const responses = responsesModule.resolveRinFrontendCommandResponses({
    newCancelled: "CUSTOM-CANCEL",
  });
  const presented = presentationModule.presentBuiltinCommandResult({
    handled: true,
    command: "new",
    data: { cancelled: true },
  });
  assert.equal(
    responsesModule.applyFrontendBuiltinCommandText("new", presented, responses)
      .text,
    "CUSTOM-CANCEL",
  );
});

test("frontend command responses render builtin completion states", () => {
  const responses = responsesModule.resolveRinFrontendCommandResponses({
    compact: "done",
    reload: "loaded",
  });
  assert.equal(
    responsesModule.applyFrontendBuiltinCommandText("compact", {}, responses)
      .text,
    "done",
  );
  assert.equal(
    responsesModule.applyFrontendBuiltinCommandText(
      "compact",
      { text: "native compact summary must not leak", tokensBefore: 108642 },
      responses,
    ).text,
    "[compaction]\n\nCompacted from 108,642 tokens",
  );
  assert.equal(
    responsesModule.applyFrontendBuiltinCommandText(
      "compact",
      { tokensBefore: 108642 },
      responses,
      { compactionExpandKeyText: "ctrl+o" },
    ).text,
    "[compaction]\n\nCompacted from 108,642 tokens (ctrl+o to expand)",
  );
  assert.equal(
    responsesModule.applyFrontendBuiltinCommandText(
      "compact",
      { compactionBusy: true },
      responses,
    ).text,
    "Compaction already in progress.",
  );
  const localized = responsesModule.resolveRinFrontendCommandResponses({
    compactionBusy: "Already compacting.",
    compactionSummaryLine: "Shrunk {tokens}.",
    compactionSummaryText: "COMPACT: {summary}",
  });
  assert.equal(
    responsesModule.applyFrontendBuiltinCommandText(
      "compact",
      { compactionBusy: true },
      localized,
    ).text,
    "Already compacting.",
  );
  assert.equal(
    responsesModule.applyFrontendBuiltinCommandText(
      "compact",
      { tokensBefore: 108642 },
      localized,
    ).text,
    "COMPACT: Shrunk 108,642.",
  );
  assert.equal(
    responsesModule.applyFrontendBuiltinCommandText("reload", {}, responses)
      .text,
    "loaded",
  );
  assert.deepEqual(
    responsesModule.applyFrontendBuiltinCommandText(
      "unknown",
      { native: true },
      responses,
    ),
    { native: true },
  );
});
