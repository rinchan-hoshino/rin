import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const usageMetrics = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "usage-metrics.js")).href
);

test("usage metrics derive total tokens from one shared fallback", () => {
  assert.deepEqual(
    usageMetrics.readUsageMetrics({
      input: "10",
      output: 2,
      cacheRead: "3",
      cacheWrite: 4,
      cost: {
        input: "0.1",
        output: 0.2,
        cacheRead: "0.03",
        cacheWrite: 0.04,
        total: "0.37",
      },
    }),
    {
      input: 10,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 19,
      costInput: 0.1,
      costOutput: 0.2,
      costCacheRead: 0.03,
      costCacheWrite: 0.04,
      costTotal: 0.37,
    },
  );
});

test("usage metrics keep explicit total tokens as the single source of truth", () => {
  assert.equal(
    usageMetrics.calculateUsageTotalTokens({
      totalTokens: 99,
      input: 10,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
    }),
    99,
  );
});

test("usage metrics normalize invalid numbers and keep fallback total behavior", () => {
  assert.deepEqual(
    usageMetrics.readUsageMetrics({
      input: "invalid",
      output: undefined,
      cacheRead: null,
      cacheWrite: "5",
      totalTokens: 0,
      cost: {
        input: "bad",
        output: undefined,
        cacheRead: null,
        cacheWrite: "0.04",
        total: "0.04",
      },
    }),
    {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 5,
      totalTokens: 5,
      costInput: 0,
      costOutput: 0,
      costCacheRead: 0,
      costCacheWrite: 0.04,
      costTotal: 0.04,
    },
  );
});
