import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const sessionHelpers = await importBuiltModule<
  typeof import("../../src/core/session/helpers.js")
>("dist/core/session/helpers.js");

test("assistant text selection includes thinking and skips empty or non-assistant messages", () => {
  assert.equal(
    sessionHelpers.extractText([
      { type: "thinking", thinking: "reasoning" },
      { type: "text", text: " answer" },
    ]),
    "reasoning answer",
  );
  assert.equal(
    sessionHelpers.getLastAssistantText([
      { role: "assistant", content: "older" },
      { role: "assistant", content: "" },
      { role: "user", content: "question" },
      { role: "assistant", content: [{ type: "text", text: "latest" }] },
      { role: "toolResult", content: "ignored" },
    ] as any),
    "latest",
  );
  assert.equal(
    sessionHelpers.getLastAssistantText([
      { role: "assistant", content: "" },
      { role: "user", content: "question" },
    ] as any),
    undefined,
  );
  assert.equal(sessionHelpers.getLastAssistantText(null as any), undefined);
});

test("message token estimates cover each persisted message shape", () => {
  assert.equal(sessionHelpers.estimateMessageTokens(null), 0);
  assert.equal(sessionHelpers.estimateMessageTokens("invalid"), 0);
  assert.equal(
    sessionHelpers.estimateMessageTokens({ role: "user", content: "12345" }),
    2,
  );
  assert.equal(
    sessionHelpers.estimateMessageTokens({
      role: "custom",
      content: [
        { type: "text", text: "1234" },
        { type: "image", data: "image" },
        { type: "ignored", text: "ignored" },
      ],
    }),
    1201,
  );
  assert.equal(
    sessionHelpers.estimateMessageTokens({
      role: "toolResult",
      content: { type: "text", text: "12345678" },
    }),
    2,
  );
  assert.equal(
    sessionHelpers.estimateMessageTokens({
      role: "assistant",
      content: [
        { type: "text", text: "1234" },
        { type: "thinking", thinking: "12345678" },
        { type: "toolCall", name: "read", arguments: { path: "abc" } },
        { type: "image", data: "ignored" },
      ],
    }),
    8,
  );
  assert.equal(
    sessionHelpers.estimateMessageTokens({
      role: "bashExecution",
      command: "1234",
      output: "12345",
    }),
    3,
  );
  assert.equal(
    sessionHelpers.estimateMessageTokens({
      role: "branchSummary",
      summary: "12345",
    }),
    2,
  );
  assert.equal(
    sessionHelpers.estimateMessageTokens({
      role: "compactionSummary",
      summary: "12345678",
    }),
    2,
  );
  assert.equal(
    sessionHelpers.estimateMessageTokens({
      role: "unknown",
      content: { type: "text", text: "1234" },
    }),
    1,
  );
});

test("context estimates reuse only successful positive assistant usage", () => {
  assert.equal(sessionHelpers.calculateContextTokens(null), 0);
  assert.equal(sessionHelpers.calculateContextTokens("bad"), 0);
  assert.equal(
    sessionHelpers.calculateContextTokens({
      totalTokens: 42,
      input: 100,
      output: 100,
    }),
    42,
  );
  assert.equal(
    sessionHelpers.calculateContextTokens({
      input: 2,
      output: 3,
      cacheRead: 4,
      cacheWrite: 1,
    }),
    10,
  );
  assert.equal(
    sessionHelpers.calculateContextTokens({ input: Infinity, output: "bad" }),
    0,
  );

  const estimate = (message: any) => Number(message?.estimate || 0);
  const usage = (value: any) => Number(value?.tokens || 0);
  assert.equal(
    sessionHelpers.estimateContextTokensWithHelpers(
      [
        { role: "assistant", usage: { tokens: 20 } },
        { role: "user", estimate: 2 },
        {
          role: "assistant",
          usage: { tokens: 100 },
          stopReason: "aborted",
          estimate: 3,
        },
        { role: "toolResult", estimate: 4 },
      ] as any,
      { calculateContextTokens: usage, estimateMessageTokens: estimate },
    ),
    29,
  );
  assert.equal(
    sessionHelpers.estimateContextTokensWithHelpers(
      [
        { role: "user", usage: { tokens: 50 }, estimate: 1 },
        { role: "assistant", usage: "bad", estimate: 2 },
        { role: "assistant", usage: { tokens: 0 }, estimate: 3 },
        {
          role: "assistant",
          usage: { tokens: 10 },
          stopReason: "error",
          estimate: 4,
        },
      ] as any,
      { calculateContextTokens: usage, estimateMessageTokens: estimate },
    ),
    10,
  );
  assert.equal(
    sessionHelpers.estimateContextTokens([
      { role: "assistant", content: "done", usage: { totalTokens: 12 } },
      { role: "user", content: "1234" },
    ] as any),
    13,
  );
  assert.equal(sessionHelpers.estimateContextTokens(null as any), 0);
});
