import test from "node:test";
import assert from "node:assert/strict";

import { importBuiltModule } from "../support/import-built-module.js";

const turnMessage = await importBuiltModule<
  typeof import("../../src/core/session/turn-message.js")
>("dist/core/session/turn-message.js");

test("turn classification ignores summaries and assistant tool-call requests", () => {
  assert.equal(
    turnMessage.classifyRinTurnMessage({ type: "compaction" }),
    "nonterminal",
  );
  assert.equal(
    turnMessage.classifyRinTurnMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }],
    }),
    "nonterminal",
  );
});

test("turn classification distinguishes successful and failed assistant terminals", () => {
  assert.equal(
    turnMessage.classifyRinTurnMessage({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    }),
    "complete",
  );
  assert.equal(
    turnMessage.classifyRinTurnMessage({
      role: "assistant",
      stopReason: "error",
      errorMessage: "boom",
      content: [],
    }),
    "error",
  );
});

test("terminal helpers classify wrappers, summary markers, and absent terminals", () => {
  assert.equal(turnMessage.rinTurnMessageValue(null) != null, true);
  assert.equal(
    turnMessage.isRinSessionSummaryMessage({
      message: { role: "branchSummary" },
    }),
    true,
  );
  assert.equal(
    turnMessage.isRinSessionSummaryMessage({ customType: "session_summary" }),
    true,
  );
  assert.equal(
    turnMessage.isRinSessionSummaryMessage({ summaryEntry: true }),
    true,
  );
  assert.equal(
    turnMessage.isRinTerminalAssistantMessage({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    }),
    true,
  );
  assert.equal(
    turnMessage.isRinTerminalAssistantMessage({ role: "user" }),
    false,
  );
  assert.equal(turnMessage.findRinTerminalMessage([{ role: "user" }]), null);
});

test("terminal lookup returns the latest terminal assistant value", () => {
  const terminal = turnMessage.findRinTerminalMessage([
    { role: "assistant", content: [{ type: "text", text: "first" }] },
    { role: "user", content: [{ type: "text", text: "next" }] },
    {
      message: { role: "assistant", content: [{ type: "text", text: "last" }] },
    },
  ]);
  assert.equal((terminal as any)?.content?.[0]?.text, "last");
});
