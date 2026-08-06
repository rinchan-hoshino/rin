import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const cronCondition = await importBuiltModule<
  typeof import("../../src/core/rin-daemon/cron-condition.js")
>("dist/core/rin-daemon/cron-condition.js");

const task = {
  id: "task-1",
  name: "nightly",
  runCount: 2,
  lastStartedAt: "2026-07-16T00:00:00.000Z",
  lastFinishedAt: "2026-07-16T00:01:00.000Z",
  lastResultText: "ok",
  lastError: "",
  nextRunAt: "2026-07-17T00:00:00.000Z",
} as never;

test("cron conditions accept absent, expression, function, and block forms", () => {
  assert.deepEqual(cronCondition.evaluateCronTaskCondition(undefined, task), {
    passed: true,
  });
  assert.deepEqual(
    cronCondition.evaluateCronTaskCondition({ code: "", timeoutMs: 0 }, task),
    { passed: true },
  );

  const expression = cronCondition.evaluateCronTaskCondition(
    {
      code: "context.task.runCount === 2 && context.task.name === 'nightly'",
      timeoutMs: Number.NaN,
    },
    task,
  );
  assert.equal(expression.passed, true);
  assert.deepEqual(JSON.parse(expression.output || "{}"), {
    passed: true,
    result: true,
  });

  const fn = cronCondition.evaluateCronTaskCondition(
    {
      code: "({ task }: { task: { runCount: number } }) => task.runCount > 4",
      timeoutMs: 200,
    },
    task,
  );
  assert.equal(fn.passed, false);

  const block = cronCondition.evaluateCronTaskCondition(
    {
      code: "const count: number = context.task.runCount; return count === 2;",
      timeoutMs: 100_000,
    },
    task,
  );
  assert.equal(block.passed, true);
});

test("cron conditions surface evaluator failures and bounded timeouts", () => {
  assert.throws(
    () =>
      cronCondition.evaluateCronTaskCondition(
        { code: "(() => { throw new Error('condition blocked'); })()" },
        task,
      ),
    /cron_condition_failed:.*condition blocked/s,
  );

  assert.throws(
    () =>
      cronCondition.evaluateCronTaskCondition(
        { code: "await new Promise(() => {})", timeoutMs: 1 },
        task,
      ),
    /cron_condition_failed|ETIMEDOUT|timed out/,
  );
});
