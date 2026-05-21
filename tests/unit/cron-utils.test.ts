import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
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
});

test("cron utils compute next cron tick", () => {
  const next = cronUtils.nextCronAt(
    "5 * * * *",
    Date.parse("2026-03-31T12:00:00.000Z"),
  );
  assert.equal(next, "2026-03-31T12:05:00.000Z");
  assert.deepEqual(
    Array.from(cronUtils.formatCronField("1-5/2,10", 0, 10)).sort(
      (a, b) => a - b,
    ),
    [1, 3, 5, 10],
  );
  assert.throws(
    () => cronUtils.formatCronField("*/0", 0, 59),
    /cron_invalid_expression/,
  );
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
});
