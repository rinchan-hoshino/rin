import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const stats = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-frontend-sdk", "index.js"),
  ).href
);

test("tui stats compute session stats from entries", () => {
  const entries = [
    { type: "message", message: { role: "user", content: [] } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall" }],
        usage: {
          input: 10,
          output: 20,
          cacheRead: 1,
          cacheWrite: 2,
          cost: { total: 0.5 },
        },
      },
    },
    { type: "message", message: { role: "toolResult", content: [] } },
  ];
  const result = stats.computeSessionStats(
    { contextWindow: 1000 },
    "/tmp/demo",
    "sid",
    entries,
    { tokens: 33, contextWindow: 1000, percent: 3.3 },
  );
  assert.equal(result.userMessages, 1);
  assert.equal(result.assistantMessages, 1);
  assert.equal(result.toolCalls, 1);
  assert.equal(result.toolResults, 1);
  assert.equal(result.tokens.total, 33);

  const emptyResult = stats.computeSessionStats(
    { contextWindow: 1000 },
    undefined,
    "sid",
    undefined,
    undefined,
  );
  assert.equal(emptyResult.totalMessages, 0);
  assert.equal(emptyResult.tokens.total, 0);
});

test("tui stats get context usage estimates the pruned provider-bound context", () => {
  const usage = stats.getContextUsage(
    { contextWindow: 1000 },
    [
      { role: "user", content: "turn 1" },
      { role: "toolResult", content: "x".repeat(4000) },
      { role: "assistant", content: "done 1" },
      { role: "user", content: "turn 2" },
      { role: "assistant", content: "done 2" },
      { role: "user", content: "turn 3" },
      { role: "assistant", content: "done 3" },
      { role: "user", content: "turn 4" },
      { role: "assistant", content: "done 4" },
      { role: "user", content: "turn 5" },
      { role: "assistant", content: "done 5" },
      ...Array.from({ length: 7 }, (_, index) => ({
        role: "assistant",
        content: `tail padding ${index + 1}`,
      })),
    ],
    [],
  );

  assert.ok(usage.tokens < 100, `tokens=${usage.tokens}`);
});

test("tui stats get context usage preserves post-compaction unknown state", () => {
  const expected = {
    tokens: null,
    contextWindow: 1000,
    percent: null,
  };
  const abortedUsage = stats.getContextUsage(
    { contextWindow: 1000 },
    [],
    [
      { type: "message", message: { role: "user" } },
      { type: "compaction" },
      {
        type: "message",
        message: {
          role: "assistant",
          stopReason: "aborted",
          usage: { input: 1 },
        },
      },
    ],
  );
  assert.deepEqual(abortedUsage, expected);

  const overflowUsage = stats.getContextUsage(
    { contextWindow: 1000 },
    [
      {
        role: "assistant",
        usage: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    [
      { type: "message", message: { role: "user" } },
      { type: "compaction" },
      {
        type: "message",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "context_length_exceeded",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      },
    ],
  );
  assert.deepEqual(overflowUsage, expected);
});
