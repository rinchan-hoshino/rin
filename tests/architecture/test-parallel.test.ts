import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { mapWithConcurrency } from "../../scripts/test/parallel.js";

test("parallel test scheduling respects its limit and preserves result order", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrency(
    [30, 5, 20, 10],
    2,
    async (delay) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, delay));
      active -= 1;
      return delay * 2;
    },
  );

  assert.equal(peak, 2);
  assert.deepEqual(results, [60, 10, 40, 20]);
});

test("parallel test scheduling rejects invalid limits and stops queued work", async () => {
  await assert.rejects(
    mapWithConcurrency([1], 0, async (value) => value),
    /parallel_concurrency_invalid:0/,
  );

  const started: number[] = [];
  await assert.rejects(
    mapWithConcurrency([0, 1, 2, 3, 4], 2, async (value) => {
      started.push(value);
      if (value === 1) throw new Error("planned_failure");
      await new Promise((resolve) => setTimeout(resolve, 20));
      return value;
    }),
    /planned_failure/,
  );
  assert.deepEqual(started, [0, 1]);
});
