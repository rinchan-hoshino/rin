import "../support/require-test-sandbox.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const execMod = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-daemon", "cron-execution.js"),
  ).href
);
const cronMod = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-daemon", "cron.js"))
    .href
);
const selfImprovePromptMod = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "self-improve", "prompt.js"))
    .href
);
const runAuditMod = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "self-improve", "run-audit.js"),
  ).href
);
test("cron execution resolves only existing dedicated session files", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const dedicatedSessionFile = path.join(
    agentDir,
    "sessions",
    "managed",
    "task",
    "cron_a.jsonl",
  );
  try {
    assert.equal(
      await execMod.resolveCronSessionFile({
        session: { mode: "dedicated" },
        dedicatedSessionFile,
      }),
      undefined,
    );
    await fs.mkdir(path.dirname(dedicatedSessionFile), { recursive: true });
    await fs.writeFile(dedicatedSessionFile, "session", "utf8");
    assert.equal(
      await execMod.resolveCronSessionFile({
        session: { mode: "dedicated" },
        dedicatedSessionFile,
      }),
      dedicatedSessionFile,
    );
    assert.equal(
      await execMod.resolveCronSessionFile({ session: { mode: "none" } }),
      undefined,
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler derives one-time triggers when no interval is set", () => {
  const scheduler = new cronMod.CronScheduler({
    agentDir: "/tmp/rin-agent",
    cwd: process.cwd(),
  });
  const task = scheduler.upsertTask({
    trigger: { runAt: "2026-04-10T00:00:00.000Z" },
    session: { mode: "none" },
    target: { kind: "agent_prompt", prompt: "hello" },
  });
  assert.equal(task.trigger.runAt, "2026-04-10T00:00:00.000Z");
});

test("cron scheduler keeps future one-time reschedules across task upserts", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const scheduler = new cronMod.CronScheduler({ agentDir });
  const taskId = "cron_self_reschedule_once";
  const firstRunAt = "2099-04-10T00:00:00.000Z";
  const nextRunAt = "2099-04-11T00:00:00.000Z";
  try {
    scheduler.upsertTask({
      id: taskId,
      trigger: { runAt: firstRunAt },
      session: { mode: "none" },
      target: { kind: "agent_prompt", prompt: "hello" },
    });
    scheduler.tasks.get(taskId).runCount = 3;
    scheduler.rescheduleOneTimeTask(taskId, nextRunAt);

    const updated = scheduler.upsertTask({
      id: taskId,
      target: { kind: "agent_prompt", prompt: "updated" },
    });

    assert.equal(updated.trigger.runAt, nextRunAt);
    assert.equal(updated.nextRunAt, nextRunAt);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler preserves finish metadata when a running once task self-reschedules", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const taskId = "cron_self_reschedule_during_run";
  const startRunAt = "2099-04-10T00:00:00.000Z";
  const nextRunAt = "2099-04-11T00:00:00.000Z";
  const scheduler = new cronMod.CronScheduler({
    agentDir,
    chat: {
      runTurn: async () => {
        scheduler.rescheduleOneTimeTask(taskId, nextRunAt);
        return { finalText: "done after self-reschedule" };
      },
    },
  });
  try {
    scheduler.upsertTask({
      id: taskId,
      trigger: { runAt: startRunAt },
      session: { mode: "none" },
      target: { kind: "agent_prompt", prompt: "hello" },
    });

    scheduler.runTaskNow(taskId);
    for (let i = 0; i < 50 && scheduler.getTask(taskId).running; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const task = scheduler.getTask(taskId);
    assert.equal(task.running, false);
    assert.equal(task.enabled, true);
    assert.equal(task.completedAt, undefined);
    assert.equal(task.trigger.runAt, nextRunAt);
    assert.equal(task.nextRunAt, nextRunAt);
    assert.equal(task.lastResultText, "done after self-reschedule");
    assert.match(task.lastFinishedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler resumes one durable agent invocation after restart", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const taskId = "cron_restart_durable_turn";
  const tasksFile = path.join(agentDir, "data", "scheduler", "tasks.json");
  const firstCalls = [];
  const secondCalls = [];
  const firstScheduler = new cronMod.CronScheduler({
    agentDir,
    chat: {
      runTurn: async (payload) => {
        firstCalls.push(payload);
        return await new Promise(() => {});
      },
    },
  });
  let secondScheduler;
  try {
    firstScheduler.upsertTask({
      id: taskId,
      trigger: { runAt: "2099-04-10T00:00:00.000Z" },
      frontend: { kind: "chat", key: "discord/1:2" },
      session: { mode: "none" },
      target: { kind: "agent_prompt", prompt: "original prompt" },
    });

    firstScheduler.runTaskNow(taskId);
    for (let i = 0; i < 50 && firstCalls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(firstCalls.length, 1);

    firstScheduler.upsertTask({
      id: taskId,
      target: { kind: "agent_prompt", prompt: "future prompt" },
    });
    firstScheduler.stop();

    const startedRows = JSON.parse(await fs.readFile(tasksFile, "utf8"));
    const startedRow = startedRows.find((item) => item.id === taskId);
    assert.equal(startedRow.runCount, 1);
    assert.equal(startedRow.activeInvocation?.taskId, taskId);
    assert.equal(startedRow.activeInvocation?.target.prompt, "original prompt");
    assert.equal(
      firstCalls[0].requestTag,
      startedRow.activeInvocation?.requestTag,
    );
    assert.equal(
      firstCalls[0].deliveryIdempotencyKey,
      `scheduled-final:${startedRow.activeInvocation?.id}`,
    );
    assert.equal(
      firstCalls[0].sessionFile,
      startedRow.activeInvocation?.sessionFile,
    );

    secondScheduler = new cronMod.CronScheduler({
      agentDir,
      chat: {
        runTurn: async (payload) => {
          secondCalls.push(payload);
          return {
            finalText: "recovered final",
            sessionFile: payload.sessionFile,
          };
        },
      },
    });
    secondScheduler.start();
    for (
      let i = 0;
      i < 100 &&
      secondScheduler.getTask(taskId)?.lastResultText !== "recovered final";
      i += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const finished = secondScheduler.getTask(taskId);
    assert.equal(secondCalls.length, 1);
    assert.equal(secondCalls[0].requestTag, firstCalls[0].requestTag);
    assert.equal(secondCalls[0].text, "original prompt");
    assert.equal(
      secondCalls[0].promptMeta.sentAt,
      firstCalls[0].promptMeta.sentAt,
    );
    assert.equal(secondCalls[0].sessionFile, firstCalls[0].sessionFile);
    assert.equal(
      secondCalls[0].deliveryIdempotencyKey,
      firstCalls[0].deliveryIdempotencyKey,
    );
    assert.equal(finished.runCount, 1);
    assert.equal(finished.running, false);
    assert.equal(finished.lastResultText, "recovered final");
    assert.match(finished.lastFinishedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(finished.enabled, false);
    assert.match(finished.completedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(finished.nextRunAt, undefined);

    const finishedRows = JSON.parse(await fs.readFile(tasksFile, "utf8"));
    const finishedRow = finishedRows.find((item) => item.id === taskId);
    assert.equal(finishedRow.activeInvocation, undefined);
  } finally {
    firstScheduler.stop();
    secondScheduler?.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler does not relaunch a live durable invocation on tick", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const taskId = "cron_live_invocation_single_launch";
  let calls = 0;
  let resolveTurn;
  const scheduler = new cronMod.CronScheduler({
    agentDir,
    chat: {
      runTurn: async () => {
        calls += 1;
        return await new Promise((resolve) => {
          resolveTurn = resolve;
        });
      },
    },
  });
  try {
    scheduler.upsertTask({
      id: taskId,
      trigger: { expression: "0 0 1 1 *" },
      session: { mode: "none" },
      target: { kind: "agent_prompt", prompt: "run once" },
    });
    scheduler.runTaskNow(taskId);
    for (let i = 0; i < 50 && !resolveTurn; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await scheduler.tick();
    assert.equal(calls, 1);

    resolveTurn({ finalText: "done once" });
    for (
      let i = 0;
      i < 50 && scheduler.tasks.get(taskId).activeInvocation;
      i += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(scheduler.getTask(taskId).lastResultText, "done once");
  } finally {
    scheduler.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler persists infrastructure retry backoff without inflating run count", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const taskId = "cron_retry_infrastructure_failure";
  let calls = 0;
  const scheduler = new cronMod.CronScheduler({
    agentDir,
    chat: {
      runTurn: async () => {
        calls += 1;
        throw new Error("chat transport unavailable");
      },
    },
  });
  try {
    scheduler.upsertTask({
      id: taskId,
      trigger: { runAt: "2099-04-10T00:00:00.000Z" },
      session: { mode: "none" },
      target: { kind: "agent_prompt", prompt: "retry me" },
    });
    scheduler.runTaskNow(taskId);
    for (let i = 0; i < 50 && scheduler.activeExecutions.has(taskId); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const row = scheduler.tasks.get(taskId);
    assert.equal(row.activeInvocation?.taskId, taskId);
    assert.equal(row.activeInvocation?.retryAttempt, 1);
    const retryDelayMs =
      Date.parse(row.activeInvocation?.nextAttemptAt || "") - Date.now();
    assert.ok(retryDelayMs > 0 && retryDelayMs <= 500);
    assert.equal(row.lastFinishedAt, undefined);
    assert.equal(row.lastError, undefined);
    assert.equal(scheduler.getTask(taskId).running, true);
    assert.equal(scheduler.getTask(taskId).runCount, 1);

    await scheduler.tick();
    assert.equal(calls, 1);
  } finally {
    scheduler.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler preserves retry backoff across restart and wake bypasses it", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const taskId = "cron_retry_restart_backoff";
  const firstScheduler = new cronMod.CronScheduler({
    agentDir,
    chat: {
      runTurn: async () => {
        throw new Error("first transport failure");
      },
    },
  });
  let retryCalls = 0;
  let secondScheduler;
  try {
    firstScheduler.upsertTask({
      id: taskId,
      trigger: { runAt: "2099-04-10T00:00:00.000Z" },
      session: { mode: "none" },
      target: { kind: "agent_prompt", prompt: "retry after restart" },
    });
    firstScheduler.runTaskNow(taskId);
    for (
      let i = 0;
      i < 50 && firstScheduler.activeExecutions.has(taskId);
      i += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    firstScheduler.tasks.get(taskId).activeInvocation.nextAttemptAt = new Date(
      Date.now() + 60_000,
    ).toISOString();
    firstScheduler.stop();

    secondScheduler = new cronMod.CronScheduler({
      agentDir,
      chat: {
        runTurn: async () => {
          retryCalls += 1;
          throw new Error("second transport failure");
        },
      },
    });
    secondScheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(retryCalls, 0);
    assert.equal(secondScheduler.getTask(taskId).runCount, 1);

    secondScheduler.wakeTaskNow(taskId);
    await secondScheduler.tick();
    for (
      let i = 0;
      i < 50 && secondScheduler.activeExecutions.has(taskId);
      i += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(retryCalls, 1);
    assert.equal(secondScheduler.getTask(taskId).runCount, 1);
    assert.equal(
      secondScheduler.tasks.get(taskId).activeInvocation.retryAttempt,
      2,
    );
  } finally {
    firstScheduler.stop();
    secondScheduler?.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler does not resume a disabled durable invocation", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const taskId = "cron_disabled_durable_invocation";
  const tasksFile = path.join(agentDir, "data", "scheduler", "tasks.json");
  let firstStarted = false;
  const firstScheduler = new cronMod.CronScheduler({
    agentDir,
    chat: {
      runTurn: async () => {
        firstStarted = true;
        return await new Promise(() => {});
      },
    },
  });
  let secondScheduler;
  try {
    firstScheduler.upsertTask({
      id: taskId,
      trigger: { runAt: "2099-04-10T00:00:00.000Z" },
      session: { mode: "none" },
      target: { kind: "agent_prompt", prompt: "do not resume" },
    });
    firstScheduler.runTaskNow(taskId);
    for (let i = 0; i < 50 && !firstStarted; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    firstScheduler.stop();

    const rows = JSON.parse(await fs.readFile(tasksFile, "utf8"));
    const row = rows.find((item) => item.id === taskId);
    row.enabled = false;
    await fs.writeFile(tasksFile, `${JSON.stringify(rows, null, 2)}\n`, "utf8");

    let resumed = false;
    secondScheduler = new cronMod.CronScheduler({
      agentDir,
      chat: {
        runTurn: async () => {
          resumed = true;
          return { finalText: "must not run" };
        },
      },
    });
    secondScheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(resumed, false);
    assert.equal(secondScheduler.getTask(taskId).running, false);
    const stored = JSON.parse(await fs.readFile(tasksFile, "utf8")).find(
      (item) => item.id === taskId,
    );
    assert.equal(stored.activeInvocation, undefined);
  } finally {
    firstScheduler.stop();
    secondScheduler?.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler projects only a canonical terminal error", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const taskId = "cron_canonical_terminal_error";
  const scheduler = new cronMod.CronScheduler({
    agentDir,
    chat: {
      runTurn: async () => {
        const error = new Error("model terminal failure") as Error & {
          rinTurnTerminal?: boolean;
        };
        error.rinTurnTerminal = true;
        throw error;
      },
    },
  });
  try {
    scheduler.upsertTask({
      id: taskId,
      trigger: { runAt: "2099-04-10T00:00:00.000Z" },
      session: { mode: "none" },
      target: { kind: "agent_prompt", prompt: "fail canonically" },
    });
    scheduler.runTaskNow(taskId);
    for (
      let i = 0;
      i < 50 && scheduler.tasks.get(taskId)?.activeInvocation;
      i += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const row = scheduler.tasks.get(taskId);
    assert.equal(row.activeInvocation, undefined);
    assert.equal(row.lastError, "model terminal failure");
    assert.match(row.lastFinishedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    scheduler.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler projects a live terminal after pausing its invocation", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const taskId = "cron_pause_live_invocation";
  let resolveTurn;
  const scheduler = new cronMod.CronScheduler({
    agentDir,
    chat: {
      runTurn: async () =>
        await new Promise((resolve) => {
          resolveTurn = resolve;
        }),
    },
  });
  try {
    scheduler.upsertTask({
      id: taskId,
      trigger: { expression: "0 0 1 1 *" },
      session: { mode: "none" },
      target: { kind: "agent_prompt", prompt: "pause while running" },
    });
    scheduler.runTaskNow(taskId);
    for (let i = 0; i < 50 && !resolveTurn; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    scheduler.pauseTask(taskId);
    assert.ok(scheduler.tasks.get(taskId).activeInvocation);
    resolveTurn({ finalText: "terminal after pause" });
    for (
      let i = 0;
      i < 50 && scheduler.tasks.get(taskId).activeInvocation;
      i += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const task = scheduler.getTask(taskId);
    assert.equal(task.running, false);
    assert.equal(task.enabled, false);
    assert.match(task.pausedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(task.lastResultText, "terminal after pause");
    assert.match(task.lastFinishedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    scheduler.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler preserves explicit completion while projecting its live terminal", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const taskId = "cron_complete_live_invocation";
  let resolveTurn;
  const scheduler = new cronMod.CronScheduler({
    agentDir,
    chat: {
      runTurn: async () =>
        await new Promise((resolve) => {
          resolveTurn = resolve;
        }),
    },
  });
  try {
    scheduler.upsertTask({
      id: taskId,
      trigger: { expression: "0 0 1 1 *" },
      session: { mode: "none" },
      target: { kind: "agent_prompt", prompt: "complete while running" },
    });
    scheduler.runTaskNow(taskId);
    for (let i = 0; i < 50 && !resolveTurn; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    scheduler.completeTask(taskId, "stopped_by_owner");
    assert.ok(scheduler.tasks.get(taskId).activeInvocation);
    resolveTurn({ finalText: "terminal after completion" });
    for (
      let i = 0;
      i < 50 && scheduler.tasks.get(taskId).activeInvocation;
      i += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const task = scheduler.getTask(taskId);
    assert.equal(task.running, false);
    assert.equal(task.enabled, false);
    assert.equal(task.completionReason, "stopped_by_owner");
    assert.equal(task.lastResultText, "terminal after completion");
    assert.match(task.lastFinishedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    scheduler.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler reloads task file edits only when requested", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const scheduler = new cronMod.CronScheduler({ agentDir });
  const taskId = "cron_hot_reload_read";
  const tasksFile = path.join(agentDir, "data", "scheduler", "tasks.json");
  try {
    scheduler.upsertTask({
      id: taskId,
      trigger: { runAt: "2099-04-10T00:00:00.000Z" },
      session: { mode: "none" },
      target: { kind: "agent_prompt", prompt: "old prompt" },
    });

    const rows = JSON.parse(await fs.readFile(tasksFile, "utf8"));
    const row = rows.find((item) => item.id === taskId);
    row.trigger = { runAt: "2099-04-12T00:00:00.000Z" };
    row.nextRunAt = "2099-04-12T00:00:00.000Z";
    row.target.prompt = "new hot-reloaded prompt";
    await fs.writeFile(tasksFile, `${JSON.stringify(rows, null, 2)}\n`, "utf8");

    assert.equal(scheduler.getTask(taskId).target.prompt, "old prompt");

    scheduler.reloadTasks();
    const reloaded = scheduler.getTask(taskId);
    assert.equal(reloaded.trigger.runAt, "2099-04-12T00:00:00.000Z");
    assert.equal(reloaded.nextRunAt, "2099-04-12T00:00:00.000Z");
    assert.equal(reloaded.target.prompt, "new hot-reloaded prompt");
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler reloads task file deletions only when requested", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const scheduler = new cronMod.CronScheduler({ agentDir });
  const taskId = "cron_hot_reload_deleted";
  const tasksFile = path.join(agentDir, "data", "scheduler", "tasks.json");
  try {
    scheduler.upsertTask({
      id: taskId,
      trigger: { runAt: "2099-04-10T00:00:00.000Z" },
      session: { mode: "none" },
      target: { kind: "agent_prompt", prompt: "hello" },
    });

    const rows = JSON.parse(await fs.readFile(tasksFile, "utf8"));
    await fs.writeFile(
      tasksFile,
      `${JSON.stringify(
        rows.filter((item) => item.id !== taskId),
        null,
        2,
      )}\n`,
      "utf8",
    );

    assert.equal(scheduler.getTask(taskId).id, taskId);
    scheduler.reloadTasks();
    assert.equal(scheduler.getTask(taskId), undefined);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler keeps the in-memory schedule when explicit reload finds an invalid file", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const scheduler = new cronMod.CronScheduler({ agentDir });
  const taskId = "cron_hot_reload_invalid";
  const tasksFile = path.join(agentDir, "data", "scheduler", "tasks.json");
  try {
    scheduler.upsertTask({
      id: taskId,
      trigger: { runAt: "2099-04-10T00:00:00.000Z" },
      session: { mode: "none" },
      target: { kind: "agent_prompt", prompt: "still loaded" },
    });

    const validRows = JSON.parse(await fs.readFile(tasksFile, "utf8"));
    await fs.writeFile(tasksFile, "{", "utf8");

    assert.throws(() => scheduler.reloadTasks(), /cron_tasks_file_invalid/);
    const task = scheduler.getTask(taskId);
    assert.equal(task.target.prompt, "still loaded");
    assert.throws(
      () => scheduler.wakeTaskNow(taskId),
      /cron_tasks_file_invalid/,
    );

    const row = validRows.find((item) => item.id === taskId);
    row.target.prompt = "recovered hot reload";
    await fs.writeFile(
      tasksFile,
      `${JSON.stringify(validRows, null, 2)}\n`,
      "utf8",
    );

    scheduler.reloadTasks();
    const recovered = scheduler.getTask(taskId);
    assert.equal(recovered.target.prompt, "recovered hot reload");
    const woken = scheduler.wakeTaskNow(taskId);
    assert.ok(Date.parse(woken.nextRunAt) <= Date.now() + 1000);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler stop preserves a file rejected by reload", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const scheduler = new cronMod.CronScheduler({ agentDir });
  const tasksFile = path.join(agentDir, "data", "scheduler", "tasks.json");
  try {
    scheduler.upsertTask({
      id: "cron_invalid_reload_preserved",
      trigger: { runAt: "2099-04-10T00:00:00.000Z" },
      session: { mode: "none" },
      target: { kind: "agent_prompt", prompt: "still loaded" },
    });
    const invalid = "{ invalid scheduler file";
    await fs.writeFile(tasksFile, invalid, "utf8");

    assert.throws(() => scheduler.reloadTasks(), /cron_tasks_file_invalid/);
    assert.throws(
      () => scheduler.wakeTaskNow("cron_invalid_reload_preserved"),
      /cron_tasks_file_invalid/,
    );
    scheduler.tasks.get("cron_invalid_reload_preserved").nextRunAt =
      "2000-01-01T00:00:00.000Z";
    await scheduler.tick();
    scheduler.save();
    scheduler.stop();
    assert.equal(await fs.readFile(tasksFile, "utf8"), invalid);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler ticks against explicitly reloaded due times", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const taskId = "cron_hot_reload_tick";
  const tasksFile = path.join(agentDir, "data", "scheduler", "tasks.json");
  let ran = false;
  const scheduler = new cronMod.CronScheduler({
    agentDir,
    chat: {
      runTurn: async () => {
        ran = true;
        return { finalText: "hot reload tick ran" };
      },
    },
  });
  try {
    scheduler.upsertTask({
      id: taskId,
      trigger: { runAt: "2099-04-10T00:00:00.000Z" },
      session: { mode: "none" },
      target: { kind: "agent_prompt", prompt: "hello" },
    });

    const rows = JSON.parse(await fs.readFile(tasksFile, "utf8"));
    const row = rows.find((item) => item.id === taskId);
    row.trigger = { runAt: "2000-01-01T00:00:00.000Z" };
    row.nextRunAt = "2000-01-01T00:00:00.000Z";
    await fs.writeFile(tasksFile, `${JSON.stringify(rows, null, 2)}\n`, "utf8");

    await scheduler.tick();
    assert.equal(ran, false);

    scheduler.reloadTasks();
    await scheduler.tick();
    for (let i = 0; i < 50 && scheduler.getTask(taskId)?.running; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(ran, true);
    assert.equal(
      scheduler.getTask(taskId).lastResultText,
      "hot reload tick ran",
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler does not resurrect a running task disabled by file edit", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const taskId = "cron_hot_reload_disable_running";
  const tasksFile = path.join(agentDir, "data", "scheduler", "tasks.json");
  let finishRun: (() => void) | undefined;
  const scheduler = new cronMod.CronScheduler({
    agentDir,
    chat: {
      runTurn: async () =>
        await new Promise((resolve) => {
          finishRun = () => resolve({ finalText: "finished after disable" });
        }),
      terminateTurn: async () => ({}),
    },
  });
  try {
    scheduler.upsertTask({
      id: taskId,
      trigger: { expression: "*/1 * * * *", timezone: "local" },
      session: { mode: "none" },
      target: { kind: "agent_prompt", prompt: "hello" },
    });

    scheduler.runTaskNow(taskId);
    assert.equal(scheduler.getTask(taskId).running, true);
    for (let i = 0; i < 50 && !finishRun; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(typeof finishRun, "function");

    const rows = JSON.parse(await fs.readFile(tasksFile, "utf8"));
    const row = rows.find((item) => item.id === taskId);
    row.enabled = false;
    delete row.nextRunAt;
    await fs.writeFile(tasksFile, `${JSON.stringify(rows, null, 2)}\n`, "utf8");

    assert.equal(scheduler.getTask(taskId).enabled, true);
    scheduler.reloadTasks();
    const disabled = scheduler.getTask(taskId);
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.nextRunAt, undefined);

    finishRun?.();
    for (let i = 0; i < 50 && scheduler.getTask(taskId)?.running; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const finished = scheduler.getTask(taskId);
    assert.equal(finished.enabled, false);
    assert.equal(finished.nextRunAt, undefined);
    assert.equal(finished.lastResultText, "finished after disable");
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler rejects removed specific session mode", () => {
  const scheduler = new cronMod.CronScheduler({
    agentDir: "/tmp/rin-agent",
    cwd: process.cwd(),
  });
  assert.throws(
    () =>
      scheduler.upsertTask({
        trigger: { runAt: "2026-04-10T00:00:00.000Z" },
        session: { mode: "specific" },
        target: { kind: "agent_prompt", prompt: "hello" },
      }),
    /cron_invalid_session_mode:specific/,
  );
});

test("cron scheduler always derives dedicated session files from task ids", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const scheduler = new cronMod.CronScheduler({ agentDir });
  try {
    const task = scheduler.upsertTask({
      id: "cron_seeded_dedicated",
      trigger: { expression: "*/1 * * * *", timezone: "local" },
      session: { mode: "dedicated" },
      target: { kind: "agent_prompt", prompt: "hello" },
    });
    assert.equal(
      task.dedicatedSessionFile,
      path.join(
        agentDir,
        "sessions",
        "managed",
        "task",
        "cron_seeded_dedicated.jsonl",
      ),
    );
    assert.equal(task.dedicatedSessionPersistent, true);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler assigns task-id-named dedicated session files before first run", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const scheduler = new cronMod.CronScheduler({ agentDir });
  try {
    const task = scheduler.upsertTask({
      id: "cron_managed_dedicated",
      trigger: { expression: "*/1 * * * *", timezone: "local" },
      session: { mode: "dedicated" },
      target: { kind: "agent_prompt", prompt: "hello" },
    });
    assert.equal(
      task.dedicatedSessionFile,
      path.join(
        agentDir,
        "sessions",
        "managed",
        "task",
        "cron_managed_dedicated.jsonl",
      ),
    );
    assert.equal(task.dedicatedSessionPersistent, true);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler durable invocation keeps the first dedicated prompt initial", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const calls = [];
  const scheduler = new cronMod.CronScheduler({
    agentDir,
    chat: {
      runTurn: async (payload) => {
        calls.push(payload);
        return { finalText: "done", sessionFile: payload.sessionFile };
      },
    },
  });
  try {
    scheduler.upsertTask({
      id: "cron_durable_dedicated_initial",
      trigger: { runAt: "2099-04-10T00:00:00.000Z" },
      session: { mode: "dedicated" },
      target: {
        kind: "agent_prompt",
        prompt: "initial prompt",
        continuationPrompt: "continuation prompt",
      },
    });
    scheduler.runTaskNow("cron_durable_dedicated_initial");
    for (let i = 0; i < 50 && calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].text, "initial prompt");
    assert.equal(calls[0].createSessionFileIfMissing, true);
  } finally {
    scheduler.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron dedicated agent task creates and then preserves its bound session", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const dedicatedSessionFile = path.join(
    agentDir,
    "sessions",
    "managed",
    "task",
    "cron_dedicated.jsonl",
  );
  const firstSessionFile = path.join(agentDir, "dedicated-session.jsonl");
  const secondSessionFile = path.join(agentDir, "dedicated-session-next.jsonl");
  const task = {
    id: "cron_dedicated",
    frontend: { kind: "chat", key: "telegram/demo:1" },
    session: { mode: "dedicated" },
    target: {
      kind: "agent_prompt",
      prompt: "hello",
      continuationPrompt: "hello again",
    },
  };
  const calls = [];
  try {
    const first = await execMod.executeCronAgentTask(task, {
      agentDir,
      runId: "run-1",
      chat: {
        runTurn: async (payload) => {
          calls.push(payload);
          return {
            finalText: "done",
            sessionId: "s1",
            sessionFile: firstSessionFile,
          };
        },
      },
    });
    assert.equal(first.text, "done");
    assert.equal(first.sessionFile, dedicatedSessionFile);
    assert.equal(task.dedicatedSessionFile, dedicatedSessionFile);
    await fs.mkdir(path.dirname(dedicatedSessionFile), { recursive: true });
    await fs.writeFile(dedicatedSessionFile, "session", "utf8");
    assert.equal(task.dedicatedSessionPersistent, true);

    const second = await execMod.executeCronAgentTask(task, {
      agentDir,
      runId: "run-2",
      chat: {
        runTurn: async (payload) => {
          calls.push(payload);
          return {
            finalText: "done again",
            sessionId: "s1",
            sessionFile: secondSessionFile,
          };
        },
      },
    });
    assert.equal(second.text, "done again");
    assert.equal(second.sessionFile, dedicatedSessionFile);
    assert.equal(task.dedicatedSessionFile, dedicatedSessionFile);
    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.map((item) => ({
        chatKey: item.chatKey,
        controllerKey: item.controllerKey,
        affectChatBinding: item.affectChatBinding,
        linkDeliveriesToSession: item.linkDeliveriesToSession,
        deliverFinal: item.deliverFinal,
        disposeAfterTurn: item.disposeAfterTurn,
        text: item.text,
        sessionFile: item.sessionFile,
        createSessionFileIfMissing: item.createSessionFileIfMissing,
      })),
      [
        {
          chatKey: "telegram/demo:1",
          controllerKey: "cron_dedicated",
          affectChatBinding: false,
          linkDeliveriesToSession: true,
          deliverFinal: true,
          disposeAfterTurn: false,
          text: "hello",
          sessionFile: dedicatedSessionFile,
          createSessionFileIfMissing: true,
        },
        {
          chatKey: "telegram/demo:1",
          controllerKey: "cron_dedicated",
          affectChatBinding: false,
          linkDeliveriesToSession: true,
          deliverFinal: true,
          disposeAfterTurn: false,
          text: "hello again",
          sessionFile: dedicatedSessionFile,
          createSessionFileIfMissing: undefined,
        },
      ],
    );
    assert.equal(calls[0].promptMeta?.taskId, "cron_dedicated");
    assert.equal(calls[0].promptMeta?.taskContextKind, "scheduled-task");
    assert.equal("triggerKind" in (calls[0].promptMeta || {}), false);
    assert.equal("taskRunId" in (calls[0].promptMeta || {}), false);
    assert.equal("taskSessionMode" in (calls[0].promptMeta || {}), false);
    assert.equal(calls[0].systemPromptBlocks, undefined);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron dedicated agent task resumes an existing canonical session", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const task = {
    id: "cron_seeded",
    frontend: { kind: "chat", key: "telegram/demo:1" },
    session: { mode: "dedicated" },
    dedicatedSessionFile: path.join(
      agentDir,
      "sessions",
      "managed",
      "task",
      "cron_seeded.jsonl",
    ),
    dedicatedSessionPersistent: true,
    target: {
      kind: "agent_prompt",
      prompt: "hello",
      continuationPrompt: "hello again",
    },
  };
  const calls = [];
  try {
    await fs.mkdir(path.dirname(task.dedicatedSessionFile), {
      recursive: true,
    });
    await fs.writeFile(task.dedicatedSessionFile, "session", "utf8");
    const result = await execMod.executeCronAgentTask(task, {
      agentDir,
      runId: "run-1",
      chat: {
        runTurn: async (payload) => {
          calls.push(payload);
          return {
            finalText: "done",
            sessionId: "s1",
            sessionFile: "/tmp/seeded-session-next.jsonl",
          };
        },
      },
    });
    assert.equal(result.sessionFile, task.dedicatedSessionFile);
    assert.ok(task.dedicatedSessionFile.endsWith("cron_seeded.jsonl"));
    assert.equal(calls.length, 1);
    assert.deepEqual(
      {
        chatKey: calls[0].chatKey,
        controllerKey: calls[0].controllerKey,
        affectChatBinding: calls[0].affectChatBinding,
        linkDeliveriesToSession: calls[0].linkDeliveriesToSession,
        deliverFinal: calls[0].deliverFinal,
        disposeAfterTurn: calls[0].disposeAfterTurn,
        text: calls[0].text,
        sessionFile: calls[0].sessionFile,
      },
      {
        chatKey: "telegram/demo:1",
        controllerKey: "cron_seeded",
        affectChatBinding: false,
        linkDeliveriesToSession: true,
        deliverFinal: true,
        disposeAfterTurn: false,
        text: "hello again",
        sessionFile: path.join(
          agentDir,
          "sessions",
          "managed",
          "task",
          "cron_seeded.jsonl",
        ),
      },
    );
    assert.equal(calls[0].promptMeta?.taskId, "cron_seeded");
    assert.equal(calls[0].promptMeta?.taskContextKind, "scheduled-task");
    assert.equal("taskSessionMode" in (calls[0].promptMeta || {}), false);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron unbound no-session agent task shuts down and preserves its session file for review", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const transientSessionFile = path.join(
    agentDir,
    "sessions",
    "managed",
    "task",
    "cron_none.jsonl",
  );
  const task = {
    id: "cron_none",
    session: { mode: "none" },
    model: "openai-codex/gpt-5.5",
    thinkingLevel: "low",
    target: { kind: "agent_prompt", prompt: "hello" },
  };
  const calls = [];
  try {
    await fs.mkdir(path.dirname(transientSessionFile), { recursive: true });
    await fs.writeFile(transientSessionFile, "temporary session", "utf8");
    const result = await execMod.executeCronAgentTask(task, {
      agentDir,
      runId: "run-1",
      chat: {
        runTurn: async (payload) => {
          calls.push(payload);
          return {
            finalText: "done",
            sessionId: "s1",
            sessionFile: transientSessionFile,
          };
        },
      },
    });
    assert.equal(result.text, "done");
    assert.equal(result.sessionFile, undefined);
    assert.equal(
      await fs.readFile(transientSessionFile, "utf8"),
      "temporary session",
    );
    assert.equal(task.dedicatedSessionFile, undefined);
    assert.equal(calls.length, 1);
    assert.deepEqual(
      {
        controllerKey: calls[0].controllerKey,
        affectChatBinding: calls[0].affectChatBinding,
        disposeAfterTurn: calls[0].disposeAfterTurn,
        shutdownAfterTurn: calls[0].shutdownAfterTurn,
        text: calls[0].text,
        sessionFile: calls[0].sessionFile,
        managedSessionLeaf: calls[0].managedSessionLeaf,
        model: calls[0].model,
        thinkingLevel: calls[0].thinkingLevel,
        frontend: calls[0].frontend,
      },
      {
        controllerKey: "cron_none",
        affectChatBinding: false,
        disposeAfterTurn: true,
        shutdownAfterTurn: true,
        text: "hello",
        sessionFile: undefined,
        managedSessionLeaf: "task",
        model: "openai-codex/gpt-5.5",
        thinkingLevel: "low",
        frontend: { kind: "scheduled-task", key: "cron_none" },
      },
    );
    assert.equal(calls[0].promptMeta?.source, "scheduled-task");
    assert.equal(calls[0].promptMeta?.taskId, "cron_none");
    assert.equal(calls[0].promptMeta?.taskContextKind, "scheduled-task");
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron frontend-bound no-session agent task uses frontend controller without controller auto-delivery", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const task = {
    id: "cron_frontend_bound",
    frontend: { kind: "sdk", key: "client/main" },
    session: { mode: "none" },
    target: { kind: "agent_prompt", prompt: "hello" },
  };
  const calls = [];
  try {
    const result = await execMod.executeCronAgentTask(task, {
      agentDir,
      runId: "run-frontend-1",
      chat: {
        runTurn: async (payload) => {
          calls.push(payload);
          return {
            finalText: "done",
            sessionId: "s1",
            sessionFile: path.join(agentDir, "sessions", "frontend.jsonl"),
          };
        },
      },
    });
    assert.equal(result.text, "done");
    assert.equal(result.sessionFile, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].chatKey, undefined);
    assert.equal(calls[0].controllerKey, "client/main");
    assert.equal(calls[0].affectChatBinding, false);
    assert.equal(calls[0].shutdownAfterTurn, true);
    assert.deepEqual(calls[0].promptMeta?.frontend, {
      kind: "sdk",
      key: "client/main",
    });
    assert.equal(calls[0].promptMeta?.source, "scheduled-task");
    assert.equal(calls[0].promptMeta?.taskId, "cron_frontend_bound");
    assert.equal(calls[0].promptMeta?.taskContextKind, "scheduled-task");
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler rejects TUI frontend bindings", () => {
  const scheduler = new cronMod.CronScheduler({
    agentDir: "/tmp/rin-agent",
    cwd: process.cwd(),
  });
  assert.throws(
    () =>
      scheduler.upsertTask({
        trigger: { runAt: "2026-04-10T00:00:00.000Z" },
        frontend: { kind: "tui", key: "terminal/main" },
        session: { mode: "none" },
        target: { kind: "agent_prompt", prompt: "hello" },
      }),
    /cron_frontend_tui_unbindable/,
  );
});

test("cron scheduler keeps TUI creation identity as unbound provenance", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const tasksFile = path.join(agentDir, "data", "scheduler", "tasks.json");
  const scheduler = new cronMod.CronScheduler({ agentDir });
  try {
    const task = scheduler.upsertTask(
      {
        id: "cron_created_from_tui",
        trigger: { runAt: "2099-01-01T00:00:00.000Z" },
        session: { mode: "none" },
        target: { kind: "agent_prompt", prompt: "hello" },
      },
      { frontend: { kind: "tui", key: "terminal/main" } },
    );
    assert.equal(task.frontend, undefined);
    const rows = JSON.parse(await fs.readFile(tasksFile, "utf8"));
    assert.deepEqual(rows[0].createdFrom.frontend, { kind: "tui" });
  } finally {
    scheduler.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler rejects persisted TUI frontend bindings", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const tasksFile = path.join(agentDir, "data", "scheduler", "tasks.json");
  const task = {
    id: "cron_tui_frontend",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    enabled: true,
    frontend: { kind: "tui", key: "terminal/main" },
    trigger: { runAt: "2099-01-01T00:00:00.000Z" },
    session: { mode: "none" },
    target: { kind: "agent_prompt", prompt: "hello" },
    runCount: 0,
    running: false,
  };
  await fs.mkdir(path.dirname(tasksFile), { recursive: true });
  await fs.writeFile(tasksFile, `${JSON.stringify([task], null, 2)}\n`, "utf8");
  const scheduler = new cronMod.CronScheduler({ agentDir });
  try {
    assert.throws(() => scheduler.reloadTasks(), /cron_tasks_file_invalid/);
  } finally {
    scheduler.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler rejects removed continuation targets with shell payloads", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const tasksFile = path.join(agentDir, "data", "scheduler", "tasks.json");
  const scheduler = new cronMod.CronScheduler({ agentDir });
  const task = {
    id: "cron_removed_continuation_target",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    enabled: true,
    trigger: { runAt: "2099-01-01T00:00:00.000Z" },
    session: { mode: "none" },
    target: { kind: "session_continue", command: "echo must-not-run" },
    runCount: 0,
    running: false,
  };
  try {
    assert.throws(
      () => scheduler.upsertTask(task),
      /cron_invalid_target_kind:session_continue/,
    );
    await fs.mkdir(path.dirname(tasksFile), { recursive: true });
    await fs.writeFile(
      tasksFile,
      `${JSON.stringify([task], null, 2)}\n`,
      "utf8",
    );
    assert.throws(() => scheduler.reloadTasks(), /cron_tasks_file_invalid/);
  } finally {
    scheduler.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler startup preserves invalid mixed task files", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const tasksFile = path.join(agentDir, "data", "scheduler", "tasks.json");
  const baseTask = {
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    enabled: true,
    trigger: { runAt: "2099-01-01T00:00:00.000Z" },
    session: { mode: "none" },
    target: { kind: "agent_prompt", prompt: "hello" },
    runCount: 0,
    running: false,
  };
  const original = `${JSON.stringify(
    [
      { ...baseTask, id: "cron_valid_task" },
      {
        ...baseTask,
        id: "cron_invalid_tui_task",
        frontend: { kind: "tui", key: "terminal/main" },
      },
    ],
    null,
    2,
  )}\n`;
  try {
    await fs.mkdir(path.dirname(tasksFile), { recursive: true });
    await fs.writeFile(tasksFile, original, "utf8");
    const scheduler = new cronMod.CronScheduler({ agentDir });
    assert.throws(() => scheduler.start(), /cron_tasks_file_invalid/);
    assert.equal(await fs.readFile(tasksFile, "utf8"), original);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler startup rejects and preserves malformed task rows", async (t) => {
  const validTask = {
    id: "cron_valid_task",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    enabled: true,
    trigger: { runAt: "2099-01-01T00:00:00.000Z" },
    session: { mode: "none" },
    target: { kind: "agent_prompt", prompt: "hello" },
    runCount: 0,
    running: false,
  };
  const cases = [
    {
      name: "missing id with TUI binding",
      row: { ...validTask, id: undefined, frontend: { kind: "tui" } },
    },
    { name: "whitespace id", row: { ...validTask, id: "   " } },
    { name: "non-string id", row: { ...validTask, id: 42 } },
    { name: "duplicate id", row: { ...validTask } },
    { name: "null row", row: null },
    { name: "scalar row", row: "invalid task row" },
  ];
  for (const { name, row } of cases) {
    await t.test(name, async () => {
      const agentDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "rin-cron-agent-"),
      );
      const tasksFile = path.join(agentDir, "data", "scheduler", "tasks.json");
      const original = `${JSON.stringify([validTask, row], null, 2)}\n`;
      try {
        await fs.mkdir(path.dirname(tasksFile), { recursive: true });
        await fs.writeFile(tasksFile, original, "utf8");
        const scheduler = new cronMod.CronScheduler({ agentDir });
        assert.throws(() => scheduler.start(), /cron_tasks_file_invalid/);
        assert.equal(await fs.readFile(tasksFile, "utf8"), original);
      } finally {
        await fs.rm(agentDir, { recursive: true, force: true });
      }
    });
  }
});

test("cron scheduler persists disabled Rin capabilities", () => {
  const scheduler = new cronMod.CronScheduler({
    agentDir: "/tmp/rin-agent",
    cwd: process.cwd(),
  });
  const task = scheduler.upsertTask({
    trigger: { runAt: "2026-04-10T00:00:00.000Z" },
    session: { mode: "none" },
    disabledRinCapabilities: [" self_improve ", "self_improve", "memory"],
    target: { kind: "agent_prompt", prompt: "hello" },
  });
  assert.deepEqual(task.disabledRinCapabilities, ["self_improve", "memory"]);
});

test("cron chat-bound no-session agent task preserves session file for quote resume", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const transientSessionFile = path.join(
    agentDir,
    "sessions",
    "managed",
    "task",
    "cron_chat_bound.jsonl",
  );
  const task = {
    id: "cron_chat_bound",
    name: "Chat Bound Task",
    frontend: { kind: "chat", key: "telegram/demo:1" },
    session: { mode: "none" },
    target: { kind: "agent_prompt", prompt: "hello" },
    trigger: { expression: "*/1 * * * *", timezone: "local" },
  };
  const calls = [];
  try {
    await fs.mkdir(path.dirname(transientSessionFile), { recursive: true });
    await fs.writeFile(transientSessionFile, "temporary session", "utf8");
    const result = await execMod.executeCronAgentTask(task, {
      agentDir,
      runId: "run-chat-1",
      chat: {
        runTurn: async (payload) => {
          calls.push(payload);
          return {
            finalText: "done",
            sessionId: "s1",
            sessionFile: transientSessionFile,
          };
        },
      },
    });
    assert.equal(result.text, "done");
    assert.equal(result.sessionFile, transientSessionFile);
    assert.equal(
      await fs.readFile(transientSessionFile, "utf8"),
      "temporary session",
    );
    assert.equal(calls[0].chatKey, "telegram/demo:1");
    assert.equal(calls[0].affectChatBinding, false);
    assert.equal(calls[0].linkDeliveriesToSession, true);
    assert.equal(calls[0].deliverFinal, true);
    assert.equal(calls[0].promptMeta?.source, "scheduled-task");
    assert.equal(calls[0].promptMeta?.taskId, "cron_chat_bound");
    assert.equal(calls[0].shutdownAfterTurn, true);
    assert.equal(calls[0].promptMeta?.taskName, "Chat Bound Task");
    assert.equal(calls[0].promptMeta?.taskContextKind, "scheduled-task");
    assert.equal("triggerKind" in (calls[0].promptMeta || {}), false);
    assert.equal("taskRunId" in (calls[0].promptMeta || {}), false);
    assert.equal("taskSessionMode" in (calls[0].promptMeta || {}), false);
    assert.equal(calls[0].systemPromptBlocks, undefined);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler defaults task quiet mode off and preserves explicit on", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const scheduler = new cronMod.CronScheduler({ agentDir });
  try {
    const task = scheduler.upsertTask({
      id: "cron_quiet_default",
      trigger: { runAt: "2099-01-01T00:00:00.000Z" },
      session: { mode: "none" },
      target: { kind: "agent_prompt", prompt: "hello" },
    });
    assert.equal(task.quiet, false);
    assert.equal(
      Object.prototype.hasOwnProperty.call(task, "deliverFinal"),
      false,
    );

    const quietOn = scheduler.upsertTask({
      id: "cron_quiet_default",
      quiet: true,
    });
    assert.equal(quietOn.quiet, true);

    const preserved = scheduler.upsertTask({
      id: "cron_quiet_default",
      name: "quiet remains on",
    });
    assert.equal(preserved.quiet, true);
  } finally {
    scheduler.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler drops legacy deliverFinal without migrating it to quiet", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const tasksFile = path.join(agentDir, "data", "scheduler", "tasks.json");
  const legacyTask = {
    id: "cron_legacy_delivery",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    enabled: true,
    deliverFinal: false,
    trigger: { runAt: "2099-01-01T00:00:00.000Z" },
    session: { mode: "none" },
    target: { kind: "agent_prompt", prompt: "legacy" },
    runCount: 0,
    running: false,
  };
  await fs.mkdir(path.dirname(tasksFile), { recursive: true });
  await fs.writeFile(
    tasksFile,
    `${JSON.stringify([legacyTask], null, 2)}\n`,
    "utf8",
  );

  const scheduler = new cronMod.CronScheduler({ agentDir });
  try {
    scheduler.start();
    const loaded = scheduler.getTask("cron_legacy_delivery");
    assert.equal(loaded.quiet, false);
    assert.equal(
      Object.prototype.hasOwnProperty.call(loaded, "deliverFinal"),
      false,
    );

    scheduler.upsertTask({
      id: "cron_legacy_delivery",
      name: "legacy renamed",
    });
    const persisted = JSON.parse(await fs.readFile(tasksFile, "utf8"));
    const persistedTask = persisted.find(
      (task) => task.id === "cron_legacy_delivery",
    );
    assert.equal(persistedTask.quiet, false);
    assert.equal(
      Object.prototype.hasOwnProperty.call(persistedTask, "deliverFinal"),
      false,
    );
  } finally {
    scheduler.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron quiet agent tasks run without a bound delivery frontend", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const calls = [];
  try {
    await execMod.executeCronAgentTask(
      {
        id: "cron_quiet_on",
        quiet: true,
        frontend: { kind: "chat", key: "telegram/demo:1" },
        session: { mode: "none" },
        target: { kind: "agent_prompt", prompt: "hello" },
      },
      {
        agentDir,
        chat: {
          runTurn: async (payload) => {
            calls.push(payload);
            return { finalText: "done", sessionFile: "/tmp/quiet-on.jsonl" };
          },
        },
      },
    );
    await execMod.executeCronAgentTask(
      {
        id: "cron_quiet_default",
        frontend: { kind: "chat", key: "telegram/demo:1" },
        session: { mode: "none" },
        target: { kind: "agent_prompt", prompt: "hello" },
      },
      {
        agentDir,
        chat: {
          runTurn: async (payload) => {
            calls.push(payload);
            return {
              finalText: "done",
              sessionFile: "/tmp/quiet-default.jsonl",
            };
          },
        },
      },
    );
    assert.equal(calls[0].chatKey, undefined);
    assert.equal(calls[0].deliverFinal, false);
    assert.equal(calls[0].quietMode, true);
    assert.deepEqual(calls[0].frontend, {
      kind: "scheduled-task",
      key: "cron_quiet_on",
    });
    assert.equal(calls[1].chatKey, "telegram/demo:1");
    assert.equal(calls[1].deliverFinal, true);
    assert.equal(calls[1].quietMode, false);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler rejects legacy session instruction task files", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const tasksFile = path.join(agentDir, "data", "scheduler", "tasks.json");
  const legacyTask = {
    id: "cron_legacy_instruction",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    enabled: true,
    trigger: { runAt: "2099-01-01T00:00:00.000Z" },
    session: {
      mode: "session_instruction",
      sessionFile: "/tmp/legacy.jsonl",
    },
    target: { kind: "agent_prompt", prompt: "Ask a follow-up." },
    runCount: 0,
    running: false,
  };
  await fs.mkdir(path.dirname(tasksFile), { recursive: true });
  await fs.writeFile(
    tasksFile,
    `${JSON.stringify([legacyTask], null, 2)}\n`,
    "utf8",
  );
  const scheduler = new cronMod.CronScheduler({ agentDir });
  try {
    assert.throws(() => scheduler.reloadTasks(), /cron_tasks_file_invalid/);
  } finally {
    scheduler.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron agent task falls back to canonical turn result text", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const task = {
    id: "cron_result_fallback",
    frontend: { kind: "chat", key: "telegram/demo:1" },
    session: { mode: "dedicated" },
    target: { kind: "agent_prompt", prompt: "hello" },
  };
  try {
    const result = await execMod.executeCronAgentTask(task, {
      agentDir,
      runId: "run-1",
      chat: {
        runTurn: async () => ({
          result: {
            messages: [{ type: "text", text: "done from result" }],
          },
          sessionId: "s1",
          sessionFile: "/tmp/cron-result-fallback.jsonl",
        }),
      },
    });
    const expectedSessionFile = path.join(
      agentDir,
      "sessions",
      "managed",
      "task",
      "cron_result_fallback.jsonl",
    );
    assert.equal(result.text, "done from result");
    assert.equal(result.sessionFile, expectedSessionFile);
    assert.equal(task.dedicatedSessionFile, expectedSessionFile);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron dedicated agent task uses separate initial and continuation prompts", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const dedicatedSessionFile = path.join(
    agentDir,
    "sessions",
    "managed",
    "task",
    "cron_prompt_modes.jsonl",
  );
  const task = {
    id: "cron_prompt_modes",
    frontend: { kind: "chat", key: "telegram/demo:1" },
    session: { mode: "dedicated" },
    runCount: 1,
    target: {
      kind: "agent_prompt",
      prompt: "first turn",
      continuationPrompt: "next turn",
    },
  };
  const calls = [];
  try {
    await execMod.executeCronAgentTask(task, {
      agentDir,
      chat: {
        runTurn: async (payload) => {
          calls.push(payload);
          return { finalText: "done", sessionFile: dedicatedSessionFile };
        },
      },
    });
    await fs.mkdir(path.dirname(dedicatedSessionFile), { recursive: true });
    await fs.writeFile(dedicatedSessionFile, "session", "utf8");
    task.runCount = 2;
    await execMod.executeCronAgentTask(task, {
      agentDir,
      chat: {
        runTurn: async (payload) => {
          calls.push(payload);
          return { finalText: "done", sessionFile: dedicatedSessionFile };
        },
      },
    });
    assert.deepEqual(
      calls.map((item) => item.text),
      ["first turn", "next turn"],
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron chat-bound agent task links its delivery without changing chat binding", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const sessionFile = path.join(
    agentDir,
    "sessions",
    "managed",
    "task",
    "cron_delivery.jsonl",
  );
  const calls = [];
  const sent = [];
  const task = {
    id: "cron_delivery",
    frontend: { kind: "chat", key: "telegram/demo:1" },
    session: { mode: "none" },
    trigger: { runAt: new Date(Date.now() - 1000).toISOString() },
    target: { kind: "agent_prompt", prompt: "hello" },
    runCount: 1,
  };
  try {
    const invocation = execMod.createCronSessionInvocation(task, agentDir);
    const result = await execMod.executeCronSessionInvocation(invocation, {
      agentDir,
      chat: {
        runTurn: async (payload) => {
          calls.push(payload);
          return { finalText: "done", sessionFile };
        },
        send: async (payload) => {
          sent.push(payload);
        },
      },
    });
    assert.equal(sent.length, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].chatKey, "telegram/demo:1");
    assert.equal(calls[0].affectChatBinding, false);
    assert.equal(calls[0].linkDeliveriesToSession, true);
    assert.equal(calls[0].deliverFinal, true);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron quiet agent task suppresses every automatic frontend delivery", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const calls = [];
  const sent = [];
  const working = [];
  const task = {
    id: "cron_silent_delivery",
    frontend: { kind: "chat", key: "telegram/demo:1" },
    quiet: true,
    session: { mode: "none" },
    trigger: { runAt: new Date(Date.now() - 1000).toISOString() },
    target: { kind: "agent_prompt", prompt: "hello" },
    runCount: 1,
  };
  try {
    const invocation = execMod.createCronSessionInvocation(task, agentDir);
    const result = await execMod.executeCronSessionInvocation(invocation, {
      agentDir,
      chat: {
        runTurn: async (payload) => {
          calls.push(payload);
          return { finalText: "hidden final" };
        },
        send: async (payload) => {
          sent.push(payload);
        },
        setWorkingVisible: async (payload) => {
          working.push(payload);
        },
      },
    });
    assert.equal(result.text, "hidden final");
    assert.equal(sent.length, 0);
    assert.equal(working.length, 0);
    assert.equal(calls[0].chatKey, undefined);
    assert.equal(calls[0].deliverFinal, false);
    assert.equal(calls[0].quietMode, true);
    assert.deepEqual(calls[0].frontend, {
      kind: "scheduled-task",
      key: "cron_silent_delivery",
    });
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("built-in self-improve cron task keeps audit observational", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const disabledRinCapabilities = ["self_improve"];
  const task = {
    id: "builtin_self_improve_sleep_consolidation_daily",
    session: { mode: "none" },
    trigger: { expression: "43 3 * * *", timezone: "local" },
    target: {
      kind: "agent_prompt",
      prompt:
        "Follow the manual at /tmp/rin/docs/rin/docs/self-improve-distillation.md to optimize self-improve guidance.",
    },
    disabledRinCapabilities,
    runCount: 4,
    lastStartedAt: "2026-05-08T09:33:09.353Z",
  };
  const calls = [];
  const managedFile = path.join(
    agentDir,
    "self_improve",
    "skills",
    "demo",
    "SKILL.md",
  );
  const secret = "sk-test-cronabcdefghijklmnopqrstuvwxyz";
  const fullFinal = `distillation done\napi_key: ${secret}\n${"evidence ".repeat(700)}`;
  try {
    await fs.mkdir(path.dirname(managedFile), { recursive: true });
    await fs.writeFile(managedFile, "before\n", "utf8");
    const invocation = execMod.createCronSessionInvocation(task, agentDir);
    const result = await execMod.executeCronSessionInvocation(invocation, {
      agentDir,
      chat: {
        runTurn: async (payload) => {
          calls.push(payload);
          await fs.writeFile(managedFile, "after\n", "utf8");
          return {
            finalText: fullFinal,
            sessionFile: path.join(
              agentDir,
              "sessions",
              "managed",
              "task",
              "night.jsonl",
            ),
          };
        },
      },
    });
    const historyPath = path.join(
      agentDir,
      "self_improve",
      "state",
      "maintenance-history.jsonl",
    );
    const historyRaw = await fs.readFile(historyPath, "utf8");
    assert.equal(historyRaw.includes(secret), false);
    const rows = historyRaw
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "self_improve_review");
    assert.equal(rows[0].status, "completed");
    assert.equal(
      rows[0].trigger,
      "cron:builtin_self_improve_sleep_consolidation_daily",
    );
    assert.match(rows[0].outputPreview, /^distillation done/);
    assert.ok(rows[0].outputPreview.length < fullFinal.length);
    assert.equal(rows[0].sessionFile, undefined);
    assert.equal(rows[0].audit.version, 1);
    assert.equal(rows[0].audit.complete, false);
    assert.equal(rows[0].audit.redacted, true);
    assert.equal(rows[0].historyRedacted, true);
    const audit = JSON.parse(
      await fs.readFile(path.join(agentDir, rows[0].audit.path), "utf8"),
    );
    assert.equal(audit.output.text.includes(secret), false);
    assert.match(audit.output.text, /\[REDACTED\]/);
    assert.match(audit.changes[0].patch, /-before/);
    assert.match(audit.changes[0].patch, /\+after/);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].disabledRinCapabilities, disabledRinCapabilities);
    assert.equal(calls[0].shutdownAfterTurn, true);
    assert.deepEqual(calls[0].frontend, {
      kind: "scheduled-task",
      key: "builtin_self_improve_sleep_consolidation_daily",
    });

    let repeatedRunCalls = 0;
    const repeatedTask = {
      ...task,
      runCount: 4,
      lastStartedAt: "2026-05-08T09:33:09.353Z",
    };
    const repeatedInvocation = execMod.createCronSessionInvocation(
      repeatedTask,
      agentDir,
    );
    const repeatedResult = await execMod.executeCronSessionInvocation(
      repeatedInvocation,
      {
        agentDir,
        chat: {
          runTurn: async () => {
            repeatedRunCalls += 1;
            return { finalText: "second execution" };
          },
        },
      },
    );
    assert.equal(repeatedRunCalls, 1);
    assert.equal(repeatedResult.text, "second execution");
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("built-in self-improve cron executes when audit initialization fails", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-cron-audit-init-failure-"),
  );
  try {
    const stateDir = path.join(agentDir, "self_improve", "state");
    const outside = path.join(agentDir, "outside-audits");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, path.join(stateDir, "run-audits"), "dir");
    const task = {
      id: "builtin_self_improve_sleep_consolidation_daily",
      session: { mode: "none" },
      trigger: { expression: "43 3 * * *", timezone: "local" },
      target: {
        kind: "agent_prompt",
        prompt:
          "Follow the self-improve distillation manual to optimize guidance.",
      },
      disabledRinCapabilities: ["self_improve"],
      runCount: 2,
      lastStartedAt: "2026-07-31T06:00:00.000Z",
    };
    let calls = 0;

    const invocation = execMod.createCronSessionInvocation(task, agentDir);
    const result = await execMod.executeCronSessionInvocation(invocation, {
      agentDir,
      chat: {
        runTurn: async () => {
          calls += 1;
          return { finalText: "distilled" };
        },
      },
    });

    assert.equal(calls, 1);
    assert.equal(result.text, "distilled");
    const history = (
      await fs.readFile(
        path.join(
          agentDir,
          "self_improve",
          "state",
          "maintenance-history.jsonl",
        ),
        "utf8",
      )
    )
      .trim()
      .split(/\r?\n/g)
      .map((line) => JSON.parse(line));
    assert.equal(history[0].status, "completed");
    assert.equal(history[0].audit, undefined);
    assert.equal(history[0].auditError, "self_improve_audit_symlink_path");
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron chat-bound shell task toggles frontend working while running", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const working = [];
  const task = {
    id: "cron_shell_working",
    frontend: { kind: "chat", key: "telegram/demo:1" },
    session: { mode: "none" },
    trigger: { runAt: new Date(Date.now() - 1000).toISOString() },
    target: { kind: "shell_command", command: "printf done" },
    runCount: 1,
  };
  try {
    await execMod.executeCronShellTask(task, {
      agentDir,
      chat: {
        setWorkingVisible: async (payload) => {
          working.push(payload);
        },
        send: async () => {},
      },
    });
    assert.deepEqual(working, [
      {
        chatKey: "telegram/demo:1",
        visible: true,
      },
      {
        chatKey: "telegram/demo:1",
        visible: false,
      },
    ]);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron quiet shell task emits no frontend messages or working state", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const sent = [];
  const working = [];
  const task = {
    id: "cron_shell_quiet",
    frontend: { kind: "chat", key: "telegram/demo:1" },
    quiet: true,
    session: { mode: "none" },
    trigger: { runAt: new Date(Date.now() - 1000).toISOString() },
    target: { kind: "shell_command", command: "printf done" },
    runCount: 1,
  };
  try {
    await execMod.executeCronShellTask(task, {
      agentDir,
      chat: {
        setWorkingVisible: async (payload) => {
          working.push(payload);
        },
        send: async (payload) => {
          sent.push(payload);
        },
      },
    });
    assert.equal(task.lastResultText.includes("done"), true);
    assert.deepEqual(working, []);
    assert.deepEqual(sent, []);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("audit history persistence failure does not block cron terminal projection", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-cron-audit-history-failure-"),
  );
  const historyPath = path.join(
    agentDir,
    "self_improve",
    "state",
    "maintenance-history.jsonl",
  );
  const task = {
    id: "builtin_self_improve_sleep_consolidation_daily",
    name: "Self-improve consolidation",
    enabled: true,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    lastStartedAt: "2026-04-02T00:00:00.000Z",
    runCount: 1,
    trigger: { expression: "0 4 * * *" },
    session: { mode: "none" },
    target: { kind: "agent_prompt", prompt: "self improve" },
  };
  try {
    const auditCapture = await runAuditMod.beginSelfImproveRunAudit({
      agentDir,
      runId: "cron-history-failure",
      kind: "cron",
      startedAt: task.lastStartedAt,
    });
    const audit = await runAuditMod.completeSelfImproveRunAudit({
      agentDir,
      capture: auditCapture,
      status: "completed",
      finishedAt: "2026-05-08T09:34:00.000Z",
      output: "done",
    });
    await fs.mkdir(historyPath, { recursive: true });
    await execMod.projectCronTaskTerminal(
      task,
      {
        status: "completed",
        text: "done",
        audit,
      },
      { agentDir, startedAt: task.lastStartedAt },
    );
    assert.equal(typeof (task as any).lastFinishedAt, "string");
    assert.equal(task.lastResultText, "done");
    assert.equal(task.runCount, 1);
    assert.equal(
      (await fs.stat(path.join(agentDir, audit.path))).isFile(),
      true,
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("audited cron history preserves distinct immutable identities for the same display run id", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-cron-audit-history-collision-"),
  );
  const makeTask = () => ({
    id: "builtin_self_improve_sleep_consolidation_daily",
    name: "Self-improve consolidation",
    enabled: true,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    lastStartedAt: "2026-04-02T00:00:00.000Z",
    runCount: 1,
    trigger: { expression: "0 4 * * *" },
    session: { mode: "none" },
    target: { kind: "agent_prompt", prompt: "self improve" },
  });
  const audit = (value: string) => ({
    version: 1,
    auditId: value.repeat(64),
    path: `self_improve/state/run-audits/${value}.json`,
    sha256: value.repeat(64),
    complete: true,
    redacted: false,
    truncated: false,
  });
  try {
    await execMod.projectCronTaskTerminal(
      makeTask(),
      { status: "completed", text: "one", audit: audit("a") },
      { agentDir, startedAt: "2026-04-02T00:00:00.000Z" },
    );
    await execMod.projectCronTaskTerminal(
      makeTask(),
      { status: "completed", text: "two", audit: audit("b") },
      { agentDir, startedAt: "2026-04-02T01:00:00.000Z" },
    );
    await execMod.projectCronTaskTerminal(
      makeTask(),
      { status: "completed", text: "two retry", audit: audit("b") },
      { agentDir, startedAt: "2026-04-02T01:00:00.000Z" },
    );
    const rows = (
      await fs.readFile(
        path.join(
          agentDir,
          "self_improve",
          "state",
          "maintenance-history.jsonl",
        ),
        "utf8",
      )
    )
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 2);
    assert.equal(
      rows[0].id,
      "builtin_self_improve_sleep_consolidation_daily:1",
    );
    assert.match(
      rows[1].id,
      /^builtin_self_improve_sleep_consolidation_daily:1@b{12}$/,
    );
    assert.equal(
      rows[1].runId,
      "builtin_self_improve_sleep_consolidation_daily:1",
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler terminates task sessions when tasks stop", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const terminations = [];
  const scheduler = new cronMod.CronScheduler({
    agentDir,
    chat: {
      terminateTurn: async (payload) => {
        terminations.push(payload.controllerKey);
      },
    },
  });
  try {
    scheduler.upsertTask({
      id: "cron_stop_me",
      trigger: { expression: "*/1 * * * *", timezone: "local" },
      session: { mode: "dedicated" },
      target: { kind: "agent_prompt", prompt: "hello" },
    });
    scheduler.upsertTask({
      id: "cron_unbound_stop_me",
      trigger: { expression: "*/1 * * * *", timezone: "local" },
      session: { mode: "none" },
      target: { kind: "agent_prompt", prompt: "hello" },
    });
    scheduler.upsertTask({
      id: "cron_none_complete_me",
      trigger: { expression: "*/1 * * * *", timezone: "local" },
      session: { mode: "none" },
      target: { kind: "shell_command", command: "printf hello" },
    });
    scheduler.pauseTask("cron_stop_me");
    scheduler.deleteTask("cron_stop_me");
    scheduler.pauseTask("cron_unbound_stop_me");
    scheduler.completeTask("cron_none_complete_me", "done");
    assert.deepEqual(terminations, [
      "cron_stop_me",
      "cron_stop_me",
      "cron_unbound_stop_me",
      "cron_none_complete_me",
    ]);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron execution shell task returns summarized success body", async () => {
  const text = await execMod.executeCronShellCommand(
    {
      target: { kind: "shell_command", command: "printf hello" },
      cwd: process.cwd(),
    },
    { agentDir: process.cwd() },
  );
  assert.ok(text.includes("Command: printf hello"));
  assert.ok(text.includes("stdout:"));
});

test("cron scheduler isolates condition failures and continues the due loop", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const scheduler = new cronMod.CronScheduler({ agentDir });
  try {
    scheduler.upsertTask({
      id: "cron_condition_broken",
      trigger: { expression: "* * * * *", timezone: "local" },
      session: { mode: "none" },
      target: { kind: "shell_command", command: "printf broken" },
      condition: {
        code: "(() => { throw new Error('condition blocked'); })()",
      },
    });
    scheduler.upsertTask({
      id: "cron_condition_healthy",
      trigger: { expression: "* * * * *", timezone: "local" },
      session: { mode: "none" },
      target: { kind: "shell_command", command: "printf healthy" },
      condition: { code: "true" },
    });

    const tasks = (scheduler as any).tasks as Map<string, any>;
    const broken = tasks.get("cron_condition_broken");
    const healthy = tasks.get("cron_condition_healthy");
    broken.nextRunAt = new Date(Date.now() - 61_000).toISOString();
    healthy.nextRunAt = new Date(Date.now() - 60_000).toISOString();

    await (scheduler as any).tick();

    const failed = scheduler.getTask("cron_condition_broken");
    let started = scheduler.getTask("cron_condition_healthy");
    const completionDeadline = Date.now() + 5_000;
    while (!started.lastFinishedAt && Date.now() < completionDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      started = scheduler.getTask("cron_condition_healthy");
    }
    assert.equal(failed.runCount, 1);
    assert.match(String(failed.lastError || ""), /cron_condition_failed/);
    assert.ok(failed.lastFinishedAt);
    assert.ok(failed.condition.lastEvaluatedAt);
    assert.equal(failed.condition.lastResult, undefined);
    assert.ok(Date.parse(failed.nextRunAt) > Date.now());
    assert.equal(started.runCount, 1);
    assert.ok(started.lastFinishedAt);
  } finally {
    scheduler.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("one-time condition failures terminate without running the target", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  let runTurnCount = 0;
  const scheduler = new cronMod.CronScheduler({
    agentDir,
    chat: {
      runTurn: async () => {
        runTurnCount += 1;
        return { finalText: "ran" };
      },
    },
  });
  try {
    scheduler.upsertTask({
      id: "cron_condition_broken_once",
      trigger: { runAt: new Date(Date.now() + 60_000).toISOString() },
      session: { mode: "none" },
      target: { kind: "agent_prompt", prompt: "must not run" },
      condition: { code: "(() => { throw new Error('blocked once'); })()" },
    });

    const failed = scheduler.runTaskNow("cron_condition_broken_once");

    assert.equal(runTurnCount, 0);
    assert.equal(failed.runCount, 1);
    assert.equal(failed.running, false);
    assert.equal(failed.enabled, false);
    assert.ok(failed.completedAt);
    assert.equal(failed.nextRunAt, undefined);
    assert.match(String(failed.lastError || ""), /cron_condition_failed/);
  } finally {
    scheduler.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron task condition false skips execution and schedules the next tick", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  let runTurnCount = 0;
  const scheduler = new cronMod.CronScheduler({
    agentDir,
    chat: {
      runTurn: async () => {
        runTurnCount += 1;
        return { finalText: "ran" };
      },
    },
  });
  try {
    scheduler.start();
    scheduler.upsertTask({
      id: "cron_condition_false",
      trigger: { expression: "* * * * *", timezone: "local" },
      session: { mode: "none" },
      target: { kind: "agent_prompt", prompt: "run" },
      condition: { code: "false" },
    });
    const skipped = scheduler.runTaskNow("cron_condition_false");
    assert.equal(runTurnCount, 0);
    assert.equal(skipped.runCount, 0);
    assert.equal(skipped.running, false);
    assert.equal(skipped.condition.lastResult, false);
    assert.equal(skipped.lastResultText, "condition_false");
    assert.ok(Date.parse(skipped.nextRunAt) > Date.now());
  } finally {
    scheduler.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron task condition true allows TypeScript execution", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  let runTurnCount = 0;
  const scheduler = new cronMod.CronScheduler({
    agentDir,
    chat: {
      runTurn: async () => {
        runTurnCount += 1;
        return { finalText: "ran" };
      },
    },
  });
  try {
    scheduler.start();
    scheduler.upsertTask({
      id: "cron_condition_true",
      trigger: { expression: "* * * * *", timezone: "local" },
      session: { mode: "none" },
      target: { kind: "agent_prompt", prompt: "run" },
      condition: {
        code: "(context: { task: { id: string } }) => context.task.id === 'cron_condition_true'",
      },
    });
    const started = scheduler.runTaskNow("cron_condition_true");
    assert.equal(started.runCount, 1);
    assert.equal(started.condition.lastResult, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(runTurnCount, 1);
  } finally {
    scheduler.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron task condition accepts function bodies with return", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  let runTurnCount = 0;
  const scheduler = new cronMod.CronScheduler({
    agentDir,
    chat: {
      runTurn: async () => {
        runTurnCount += 1;
        return { finalText: "ran" };
      },
    },
  });
  try {
    scheduler.start();
    scheduler.upsertTask({
      id: "cron_condition_body",
      trigger: { expression: "* * * * *", timezone: "local" },
      session: { mode: "none" },
      target: { kind: "agent_prompt", prompt: "run" },
      condition: {
        code: "const id: string = context.task.id;\nreturn id === 'cron_condition_body';",
      },
    });
    const started = scheduler.runTaskNow("cron_condition_body");
    assert.equal(started.runCount, 1);
    assert.equal(started.condition.lastResult, true);
    assert.equal(started.lastError, undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(runTurnCount, 1);
  } finally {
    scheduler.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler installs self-improve distillation without daily memory repair", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const scheduler = new cronMod.CronScheduler({ agentDir });
  try {
    scheduler.start();
    assert.equal(
      scheduler
        .listTasks()
        .some((task) => task.id === "builtin_memory_index_repair_daily"),
      false,
    );
    assert.equal(
      scheduler.getTask("builtin_memory_index_repair_daily", {
        includeBuiltIn: true,
      }),
      undefined,
    );

    const sleep = scheduler.getTask(
      "builtin_self_improve_sleep_consolidation_daily",
      { includeBuiltIn: true },
    );
    assert.ok(sleep);
    assert.equal(sleep.builtIn, true);
    assert.equal(sleep.trigger.expression, "43 3 * * *");
    assert.equal(sleep.session.mode, "none");
    assert.deepEqual(sleep.disabledRinCapabilities, ["self_improve"]);
    assert.equal(sleep.target.kind, "agent_prompt");
    assert.equal(
      sleep.target.prompt,
      selfImprovePromptMod.buildSelfImproveSleepPrompt(agentDir),
    );
    assert.match(
      sleep.target.prompt,
      new RegExp(
        `Follow ${agentDir.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}/docs/rin/docs/self-improve-distillation\\.md as the complete contract`,
      ),
    );
    assert.match(
      sleep.target.prompt,
      new RegExp(
        `over ${agentDir.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}/self_improve`,
      ),
    );
    assert.match(
      sleep.target.prompt,
      /Evidence scope: Rin session records from the previous 24 hours/,
    );
    assert.match(sleep.target.prompt, /Pass mode: nightly-retrospective\./);
    const normalizedSleepPrompt = sleep.target.prompt.replaceAll(
      agentDir,
      "<agent-dir>",
    );
    assert.ok(
      normalizedSleepPrompt.length < 350,
      `sleep prompt is too long after path normalization: ${normalizedSleepPrompt.length}`,
    );
    assert.doesNotMatch(sleep.target.prompt, /Trigger context/);
    assert.doesNotMatch(sleep.target.prompt, /conversation above/);
    assert.doesNotMatch(sleep.target.prompt, /prompt baselines/);
    assert.doesNotMatch(sleep.target.prompt, /reusable lessons learned/);
    assert.doesNotMatch(sleep.target.prompt, /Replay the future trigger/);
    assert.doesNotMatch(sleep.target.prompt, /Report changed artifacts/);
  } finally {
    scheduler.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler migrates persisted chatKey tasks to frontend chat bindings", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const tasksFile = path.join(agentDir, "data", "scheduler", "tasks.json");
  let scheduler;
  try {
    await fs.mkdir(path.dirname(tasksFile), { recursive: true });
    await fs.writeFile(
      tasksFile,
      JSON.stringify([
        {
          id: "cron_legacy_chat",
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:00:00.000Z",
          enabled: true,
          chatKey: "telegram/demo:1",
          trigger: { runAt: "2099-01-01T00:00:00.000Z" },
          session: { mode: "none" },
          target: { kind: "agent_prompt", prompt: "hello" },
          runCount: 0,
          running: false,
        },
      ]),
      "utf8",
    );

    scheduler = new cronMod.CronScheduler({ agentDir });
    scheduler.start();
    const task = scheduler.getTask("cron_legacy_chat");
    assert.deepEqual(task.frontend, {
      kind: "chat",
      key: "telegram/demo:1",
    });
    assert.equal("chatKey" in task, false);
    scheduler.stop();

    const rows = JSON.parse(await fs.readFile(tasksFile, "utf8"));
    const row = rows.find((item) => item.id === "cron_legacy_chat");
    assert.deepEqual(row.frontend, {
      kind: "chat",
      key: "telegram/demo:1",
    });
    assert.equal("chatKey" in row, false);
  } finally {
    scheduler?.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler persists built-in task state across restarts while hiding it publicly", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const tasksFile = path.join(agentDir, "data", "scheduler", "tasks.json");
  const builtInId = "builtin_self_improve_sleep_consolidation_daily";
  try {
    const first = new cronMod.CronScheduler({ agentDir });
    first.start();
    first.stop();

    const rows = JSON.parse(await fs.readFile(tasksFile, "utf8"));
    const row = rows.find((task) => task.id === builtInId);
    assert.ok(row);
    row.runCount = 7;
    row.lastFinishedAt = "2026-04-14T20:17:01.000Z";
    await fs.writeFile(tasksFile, JSON.stringify(rows, null, 2));

    const second = new cronMod.CronScheduler({ agentDir });
    second.start();
    const builtIn = second.getTask(builtInId, { includeBuiltIn: true });
    assert.equal(second.getTask(builtInId), undefined);
    assert.ok(builtIn);
    assert.equal(builtIn.runCount, 7);
    assert.equal(builtIn.lastFinishedAt, "2026-04-14T20:17:01.000Z");
    second.stop();
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler protects built-in tasks from public mutation", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const scheduler = new cronMod.CronScheduler({ agentDir });
  try {
    scheduler.start();
    assert.equal(
      scheduler.getTask("builtin_memory_index_repair_daily", {
        includeBuiltIn: true,
      }),
      undefined,
    );
    assert.throws(
      () =>
        scheduler.pauseTask("builtin_self_improve_sleep_consolidation_daily"),
      /cron_builtin_task_protected:builtin_self_improve_sleep_consolidation_daily/,
    );
  } finally {
    scheduler.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler can reschedule and activate a one-time task while it is running", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const scheduler = new cronMod.CronScheduler({ agentDir });
  try {
    scheduler.start();
    const taskId = "cron_reschedule_once";
    const original = scheduler.upsertTask({
      id: taskId,
      trigger: { runAt: "2099-01-01T00:00:00.000Z" },
      session: { mode: "none" },
      target: { kind: "agent_prompt", prompt: "follow up" },
    });
    assert.equal(original.runCount, 0);

    const runningTaskObject = scheduler.tasks.get(taskId);
    assert.ok(runningTaskObject);
    scheduler.activeExecutions.set(taskId, { startedAt: Date.now() });
    runningTaskObject.runCount = 1;

    const rescheduled = scheduler.rescheduleOneTimeTask(
      taskId,
      "2099-01-02T00:00:00.000Z",
    );
    assert.equal(rescheduled.enabled, true);
    assert.equal(rescheduled.completedAt, undefined);
    assert.equal(rescheduled.trigger.runAt, "2099-01-02T00:00:00.000Z");
    assert.equal(rescheduled.nextRunAt, "2099-01-02T00:00:00.000Z");
    assert.equal(rescheduled.runCount, 1);
    assert.equal(rescheduled.running, true);

    runningTaskObject.completedAt = new Date().toISOString();
    runningTaskObject.completionReason = "once_completed";
    runningTaskObject.enabled = false;
    runningTaskObject.nextRunAt = undefined;
    scheduler.activeExecutions.delete(taskId);
    scheduler.save();

    const afterFinish = scheduler.getTask(taskId);
    assert.ok(afterFinish);
    assert.equal(afterFinish.enabled, true);
    assert.equal(afterFinish.completedAt, undefined);
    assert.equal(afterFinish.completionReason, undefined);
    assert.equal(afterFinish.nextRunAt, "2099-01-02T00:00:00.000Z");
    assert.equal(afterFinish.runCount, 1);
  } finally {
    scheduler.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler can set the next run for a recurring task", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const scheduler = new cronMod.CronScheduler({ agentDir });
  try {
    scheduler.start();
    const task = scheduler.upsertTask({
      id: "cron_recurring_next",
      trigger: { expression: "*/1 * * * *", timezone: "local" },
      session: { mode: "none" },
      target: { kind: "shell_command", command: "echo ok" },
    });
    assert.equal(task.trigger.expression, "*/1 * * * *");

    const rescheduled = scheduler.rescheduleOneTimeTask(
      "cron_recurring_next",
      "2099-01-02T00:00:00.000Z",
    );
    assert.equal(rescheduled.enabled, true);
    assert.equal(rescheduled.completedAt, undefined);
    assert.equal(rescheduled.trigger.expression, "*/1 * * * *");
    assert.equal(rescheduled.nextRunAt, "2099-01-02T00:00:00.000Z");
  } finally {
    scheduler.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler preserves an agent-chosen recurring next run after execution", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const chosenNextRunAt = "2099-01-02T00:00:00.000Z";
  const scheduler = new cronMod.CronScheduler({
    agentDir,
    chat: {
      runTurn: async () => {
        const runningTask = scheduler.tasks.get("cron_recurring_self_next");
        assert.ok(runningTask);
        runningTask.nextRunAt = chosenNextRunAt;
        return { finalText: "done" };
      },
    },
  });
  try {
    scheduler.upsertTask({
      id: "cron_recurring_self_next",
      trigger: { expression: "*/1 * * * *", timezone: "local" },
      session: { mode: "none" },
      target: { kind: "agent_prompt", prompt: "hello" },
    });
    const task = scheduler.tasks.get("cron_recurring_self_next");
    assert.ok(task);
    task.runCount = 1;
    task.nextRunAt = "2099-01-01T00:00:00.000Z";

    const invocation = execMod.createCronSessionInvocation(task, agentDir);
    task.activeInvocation = invocation;
    scheduler.activeExecutions.set(task.id, { startedAt: Date.now() });
    await scheduler.executeSessionInvocation(task.id, invocation);

    const after = scheduler.getTask("cron_recurring_self_next");
    assert.equal(after?.nextRunAt, chosenNextRunAt);
  } finally {
    scheduler.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler does not expose retired daily memory repair for manual runs", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const scheduler = new cronMod.CronScheduler({ agentDir });
  try {
    scheduler.start();
    assert.throws(
      () => scheduler.runTaskNow("builtin_memory_index_repair_daily"),
      /cron_task_not_found:builtin_memory_index_repair_daily/,
    );
  } finally {
    scheduler.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler derives running from live execution without persisting it", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const tasksFile = path.join(agentDir, "data", "scheduler", "tasks.json");
  const scheduler = new cronMod.CronScheduler({ agentDir });
  try {
    scheduler.start();
    scheduler.upsertTask({
      id: "cron_running_state",
      trigger: { expression: "*/1 * * * *", timezone: "local" },
      session: { mode: "dedicated" },
      target: { kind: "shell_command", command: "echo ready" },
    });

    scheduler.activeExecutions.set("cron_running_state", {
      startedAt: Date.now(),
    });
    scheduler.save();

    const runningTask = scheduler.getTask("cron_running_state");
    assert.equal(runningTask?.running, true);
    assert.ok(runningTask?.activeStartedAt);
    assert.equal(typeof runningTask?.activeDurationMs, "number");

    const status = scheduler.getStatusSnapshot();
    assert.equal(status.taskCount, 1);
    assert.equal(status.enabledTaskCount, 1);
    assert.equal(status.runningTaskCount, 1);
    assert.equal(status.tasks[0]?.id, "cron_running_state");
    assert.equal(status.tasks[0]?.running, true);
    assert.deepEqual(status.tasks[0]?.target, { kind: "shell_command" });
    assert.equal(status.tasks[0]?.target.command, undefined);

    const rows = JSON.parse(await fs.readFile(tasksFile, "utf8"));
    const storedTask = rows.find((task) => task.id === "cron_running_state");
    assert.ok(storedTask);
    assert.equal(storedTask.running, false);
    assert.equal(storedTask.activeStartedAt, undefined);
    assert.equal(storedTask.activeDurationMs, undefined);

    scheduler.activeExecutions.delete("cron_running_state");
    assert.equal(scheduler.getTask("cron_running_state")?.running, false);
  } finally {
    scheduler.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});
