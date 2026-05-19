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

test("tui stats get context usage preserves post-compaction unknown state", () => {
  const usage = stats.getContextUsage(
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
  assert.deepEqual(usage, {
    tokens: null,
    contextWindow: 1000,
    percent: null,
  });
});
