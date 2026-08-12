import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
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
  assert.equal("tokens" in result, false);
  assert.equal("cost" in result, false);

  const emptyResult = stats.computeSessionStats(
    { contextWindow: 1000 },
    undefined,
    "sid",
    undefined,
    undefined,
  );
  assert.equal(emptyResult.totalMessages, 0);
  assert.equal("tokens" in emptyResult, false);
  assert.equal("cost" in emptyResult, false);
});

test("tui stats get context usage estimates the pruned provider-bound context", () => {
  const usage = stats.getContextUsage(
    { contextWindow: 1000 },
    [
      { role: "user", content: "turn 1" },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "huge-old", name: "read", arguments: {} },
        ],
      },
      { role: "toolResult", toolCallId: "huge-old", content: "x".repeat(4000) },
      { role: "assistant", content: "done 1" },
      ...Array.from({ length: 63 }, (_, index) => {
        const id = `padding-${index + 1}`;
        return [
          {
            role: "assistant",
            content: [{ type: "toolCall", id, name: "read", arguments: {} }],
          },
          { role: "toolResult", toolCallId: id, content: `output ${id}` },
        ];
      }).flat(),
    ],
    [],
  );

  assert.ok(usage.tokens < 1000, `tokens=${usage.tokens}`);
});

test("tui stats get context usage rejects absent windows and accepts post-compaction usage", () => {
  assert.equal(stats.getContextUsage(null, [], []), undefined);
  assert.equal(stats.getContextUsage({ contextWindow: -1 }, [], []), undefined);

  const usage = stats.getContextUsage(
    { contextWindow: 1000 },
    [{ role: "assistant", content: "done" }],
    [
      { type: "compaction" },
      { type: "custom" },
      { type: "message", message: { role: "user" } },
      {
        type: "message",
        message: {
          role: "assistant",
          stopReason: "stop",
          usage: { input: 0 },
        },
      },
      { type: "message", message: { role: "user" } },
      {
        type: "message",
        message: {
          role: "assistant",
          stopReason: "stop",
          usage: { input: 25 },
        },
      },
    ],
  );
  assert.equal(usage?.contextWindow, 1000);
  assert.equal(typeof usage?.tokens, "number");
  assert.equal(
    stats.getContextUsage({ contextWindow: 1000 }, [], [])?.tokens,
    0,
  );

  const emptyStats = stats.computeSessionStats(
    null,
    undefined,
    "sid",
    [{ type: "custom" }, { type: "message" }],
    undefined,
  );
  assert.equal(emptyStats.totalMessages, 0);
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
