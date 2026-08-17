import "../support/require-test-sandbox.ts";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const cronUtils = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-daemon", "cron-utils.js"),
  ).href
);

test("cron utils normalize iso and summarize text", () => {
  assert.ok(
    cronUtils.normalizeIso("2026-03-31T12:00:00Z", "startAt").endsWith("Z"),
  );
  assert.equal(
    cronUtils.summarizeText("  hello\r\nworld  ", 20),
    "hello\nworld",
  );
  assert.equal(cronUtils.normalizeIso("   ", "startAt"), undefined);
  assert.throws(
    () => cronUtils.normalizeIso("not-a-date", "startAt"),
    /cron_invalid_startAt/,
  );
});

test("cron utils compute next run for once triggers", () => {
  const once = cronUtils.computeNextRunAt(
    {
      id: "a",
      createdAt: "",
      updatedAt: "",
      enabled: true,
      cwd: "",
      chatKey: undefined,
      trigger: { kind: "once", runAt: "2026-03-31T12:00:00.000Z" },
      session: { mode: "dedicated" },
      target: { kind: "shell_command", command: "echo hi" },
      runCount: 0,
      running: false,
    },
    Date.parse("2026-03-31T11:59:00.000Z"),
  );
  assert.equal(once, "2026-03-31T12:00:00.000Z");

  const selfRescheduledOnce = cronUtils.computeNextRunAt(
    {
      id: "a",
      createdAt: "",
      updatedAt: "",
      enabled: true,
      cwd: "",
      chatKey: undefined,
      trigger: { runAt: "2026-03-31T12:00:00.000Z" },
      session: { mode: "dedicated" },
      target: { kind: "shell_command", command: "echo hi" },
      runCount: 3,
      running: false,
    },
    Date.parse("2026-03-31T11:59:00.000Z"),
  );
  assert.equal(selfRescheduledOnce, "2026-03-31T12:00:00.000Z");
});

test("cron utils compute next cron tick", () => {
  const next = cronUtils.nextCronAt(
    "5 * * * *",
    Date.parse("2026-03-31T12:00:00.000Z"),
  );
  assert.equal(next, "2026-03-31T12:05:00.000Z");
  assert.equal(
    cronUtils.nextCronAt(
      "1-5/2,10 * * * *",
      Date.parse("2026-03-31T12:00:00.000Z"),
    ),
    "2026-03-31T12:01:00.000Z",
  );
});

test("cron utils follow standard day-of-month OR day-of-week semantics", () => {
  const next = cronUtils.nextCronAt(
    "0 0 1 * 1",
    Date.parse("2026-08-02T00:01:00.000Z"),
  );
  assert.equal(next, "2026-08-03T00:00:00.000Z");
});

test("cron utils find valid sparse schedules without an arbitrary two-year horizon", () => {
  const next = cronUtils.nextCronAt(
    "0 0 29 2 *",
    Date.parse("2025-03-01T00:00:00.000Z"),
  );
  assert.equal(next, "2028-02-29T00:00:00.000Z");
});

test("cron utils stop disabled or exhausted tasks before computing the next run", () => {
  const baseTask = {
    id: "a",
    createdAt: "",
    updatedAt: "",
    enabled: true,
    cwd: "",
    chatKey: undefined,
    session: { mode: "dedicated" },
    target: { kind: "shell_command", command: "echo hi" },
    runCount: 0,
    running: false,
    trigger: { expression: "*/1 * * * *", timezone: "local" },
  };

  assert.equal(
    cronUtils.computeNextRunAt({ ...baseTask, enabled: false }, Date.now()),
    undefined,
  );
  assert.equal(
    cronUtils.computeNextRunAt(
      {
        ...baseTask,
        termination: { maxRuns: 1 },
        runCount: 1,
      },
      Date.now(),
    ),
    undefined,
  );
  assert.equal(
    cronUtils.computeNextRunAt(
      {
        ...baseTask,
        termination: { stopAt: "2026-03-31T12:00:00.000Z" },
      },
      Date.parse("2026-03-31T12:00:01.000Z"),
    ),
    undefined,
  );
  assert.equal(
    cronUtils.computeNextRunAt(
      { ...baseTask, completedAt: "2026-03-31T11:00:00.000Z" },
      Date.parse("2026-03-31T12:00:01.000Z"),
    ),
    undefined,
  );
  assert.match(
    cronUtils.computeNextRunAt(
      { ...baseTask, termination: { stopAt: "invalid" } },
      Date.parse("2026-03-31T12:00:01.000Z"),
    ),
    /^2026-03-31T12:01:00\.000Z$/,
  );
});

test("cron utils derive stable storage paths and run identifiers", (t) => {
  t.mock.method(Date, "now", () => 1_713_436_800_000);
  t.mock.method(Math, "random", () => 0.5);

  assert.match(cronUtils.cronRoot("/tmp/agent"), /scheduler$/);
  assert.match(
    cronUtils.cronTasksPath("/tmp/agent"),
    /scheduler\/tasks\.json$/,
  );
  assert.match(cronUtils.createCronTaskId(), /^cron_[a-z0-9]+[a-z0-9]{6}$/);
  assert.equal(
    cronUtils.cronTaskRunId({
      id: "task-1",
      runCount: 2,
      lastStartedAt: " 2026-03-31T12:00:00.000Z ",
    }),
    "task-1:2:2026-03-31T12:00:00.000Z",
  );
  assert.throws(
    () => cronUtils.cronTaskRunId({ id: "task-1", runCount: 2 }),
    /cron_tasks_file_invalid/,
  );
});

test("cron utils reject malformed fields and exhausted one-shot triggers", () => {
  for (const expression of [
    "",
    "* * *",
    "* * * * * *",
    "x * * * *",
    "5-1 * * * *",
    "-1 * * * *",
    "60 * * * *",
    "1/a * * * *",
    "*/0 * * * *",
  ]) {
    assert.throws(
      () => cronUtils.nextCronAt(expression, Date.now()),
      /cron_invalid_expression/,
      expression,
    );
  }

  const task = {
    id: "once",
    createdAt: "",
    updatedAt: "",
    enabled: true,
    cwd: "",
    chatKey: undefined,
    trigger: { runAt: "2026-03-31T12:00:00.000Z" },
    session: { mode: "dedicated" },
    target: { kind: "shell_command", command: "echo hi" },
    runCount: 0,
    running: false,
  };
  assert.equal(
    cronUtils.computeNextRunAt(task, Date.parse("2026-03-31T12:00:00.000Z")),
    undefined,
  );
  assert.equal(
    cronUtils.computeNextRunAt(
      { ...task, trigger: { runAt: "invalid" } },
      Date.parse("2026-03-31T11:00:00.000Z"),
    ),
    undefined,
  );
});
