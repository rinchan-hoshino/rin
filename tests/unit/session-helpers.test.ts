import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const sessionHelpers = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-tui", "session-helpers.js"),
  ).href
);
const providerAuth = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-install", "provider-auth.js"),
  ).href
);

test("session helpers share deterministic thinking-level availability", () => {
  const codexMax = {
    provider: "openai",
    id: "Codex-Max-Latest",
    reasoning: true,
  };
  const standard = {
    provider: "anthropic",
    id: "claude-sonnet",
    reasoning: true,
  };
  const noReasoning = { provider: "openai", id: "gpt-4.1", reasoning: false };

  assert.deepEqual(
    sessionHelpers.computeAvailableThinkingLevels(codexMax),
    providerAuth.computeAvailableThinkingLevels(codexMax),
  );
  assert.deepEqual(sessionHelpers.computeAvailableThinkingLevels(codexMax), [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  assert.deepEqual(sessionHelpers.computeAvailableThinkingLevels(standard), [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
  ]);
  assert.deepEqual(sessionHelpers.computeAvailableThinkingLevels(noReasoning), [
    "off",
  ]);
});

test("getLastAssistantText scans backward without requiring a copied array", () => {
  const messages = [
    { role: "assistant", content: "older reply" },
    { role: "assistant", content: "" },
    { role: "user", content: "question" },
    { role: "assistant", content: "latest reply" },
    { role: "toolResult", content: "tool output" },
  ];
  assert.equal(sessionHelpers.getLastAssistantText(messages), "latest reply");
});

test("estimateContextTokens reuses the latest successful usage and estimates only trailing messages", () => {
  const messages = [
    { role: "user", content: "1234" },
    {
      role: "assistant",
      content: "stable answer",
      usage: { totalTokens: 20 },
    },
    { role: "user", content: "12345678" },
    {
      role: "assistant",
      content: "1234567890",
      usage: { totalTokens: 999 },
      stopReason: "error",
    },
    { role: "toolResult", content: "1234" },
  ];

  assert.equal(sessionHelpers.estimateContextTokens(messages), 26);
});

test("estimateContextTokens falls back to estimating every message when no usage is reusable", () => {
  const messages = [
    { role: "user", content: "1234" },
    {
      role: "assistant",
      content: "12345678",
      usage: { totalTokens: 999 },
      stopReason: "aborted",
    },
    { role: "toolResult", content: "123456789012" },
  ];

  assert.equal(sessionHelpers.estimateContextTokens(messages), 6);
  assert.equal(sessionHelpers.estimateMessageTokens(messages[2]), 3);
});

test("session helpers guard against non-array and malformed message inputs", () => {
  assert.equal(sessionHelpers.getLastAssistantText(null), undefined);
  assert.equal(sessionHelpers.estimateContextTokens(null), 0);
  assert.equal(sessionHelpers.estimateContextTokens({}), 0);
  assert.equal(sessionHelpers.estimateMessageTokens(null), 0);
  assert.equal(sessionHelpers.estimateMessageTokens("bad"), 0);
  assert.equal(
    sessionHelpers.estimateContextTokens([
      null,
      { role: "assistant", content: "1234", usage: "bad" },
      { role: "assistant", content: "12345678", usage: { totalTokens: 12 } },
      { role: "user", content: "1234" },
    ]),
    13,
  );
});
