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
const rawExecMod = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-daemon", "cron-execution.js"),
  ).href
);
function withScheduledInputDelivery(chat: any) {
  return chat &&
    typeof chat.runTurn === "function" &&
    typeof chat.submitIncoming !== "function"
    ? {
        ...chat,
        submitIncoming: async (payload: any) =>
          chat.runTurn({
            controllerKey: "default",
            deliverFinal: true,
            quietMode: false,
            ...payload,
            incomingMessageId: "scheduled-input-test",
            replyToMessageId: "scheduled-input-test",
          }),
      }
    : chat;
}
const execMod = {
  ...rawExecMod,
  executeCronAgentTask: (task: any, options: any) =>
    rawExecMod.executeCronAgentTask(task, {
      ...options,
      runId: options?.runId || `test-run:${task.id}`,
      chat: withScheduledInputDelivery(options?.chat),
    }),
  executeCronSessionInvocation: (invocation: any, options: any) =>
    rawExecMod.executeCronSessionInvocation(invocation, {
      ...options,
      chat: withScheduledInputDelivery(options?.chat),
    }),
};
const cronRuntimeMod = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-daemon", "cron.js"))
    .href
);
class FrontendBoundCronScheduler extends cronRuntimeMod.CronScheduler {
  constructor(options: any) {
    super({
      ...options,
      chat: withScheduledInputDelivery(options?.chat),
    });
  }

  upsertTask(input: any, defaults?: any) {
    const boundInput =
      input?.target?.kind === "agent_prompt" &&
      !input.frontend &&
      !defaults?.frontend &&
      input.id !== "cron_none"
        ? {
            ...input,
            frontend: { kind: "chat", key: "discord/1:2" },
          }
        : input;
    return super.upsertTask(boundInput, defaults);
  }
}
const cronMod = {
  ...cronRuntimeMod,
  CronScheduler: FrontendBoundCronScheduler,
};
const runAuditMod = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "self-improve", "run-audit.js"),
  ).href
);
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
    assert.equal(firstCalls[0].requestTag, undefined);
    assert.equal(
      firstCalls[0].deliveryIdempotencyKey,
      `scheduled-input:${startedRow.activeInvocation?.requestTag}`,
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
    assert.equal(secondCalls[0].taskId, firstCalls[0].taskId);
    assert.equal(secondCalls[0].taskName, firstCalls[0].taskName);
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

test("cron scheduler ignores removed session selectors", () => {
  const scheduler = new cronMod.CronScheduler({
    agentDir: "/tmp/rin-agent",
    cwd: process.cwd(),
  });
  const task = scheduler.upsertTask({
    trigger: { runAt: "2026-04-10T00:00:00.000Z" },
    session: { mode: "specific" },
    target: { kind: "agent_prompt", prompt: "hello" },
  });
  assert.equal(Object.hasOwn(task, "session"), false);
});

test("cron scheduler never derives task-owned session files", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const scheduler = new cronMod.CronScheduler({ agentDir });
  try {
    const task = scheduler.upsertTask({
      id: "cron_seeded_dedicated",
      trigger: { expression: "*/1 * * * *", timezone: "local" },
      session: { mode: "dedicated" },
      target: { kind: "agent_prompt", prompt: "hello" },
    });
    assert.equal(task.dedicatedSessionFile, undefined);
    assert.equal(task.dedicatedSessionPersistent, undefined);
    assert.equal(task.session, undefined);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler drops every legacy task-session field before first run", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const scheduler = new cronMod.CronScheduler({ agentDir });
  try {
    const task = scheduler.upsertTask({
      id: "cron_managed_dedicated",
      trigger: { expression: "*/1 * * * *", timezone: "local" },
      session: { mode: "dedicated" },
      target: { kind: "agent_prompt", prompt: "hello" },
    });
    assert.equal(task.dedicatedSessionFile, undefined);
    assert.equal(task.dedicatedSessionPersistent, undefined);
    assert.equal(task.session, undefined);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler durable invocation keeps the first recurring prompt initial", async () => {
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
    assert.equal(calls[0].createSessionFileIfMissing, undefined);
  } finally {
    scheduler.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron legacy session fields never create or select a task-owned session", async () => {
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
    assert.equal(first.sessionFile, firstSessionFile);
    assert.equal(task.dedicatedSessionFile, undefined);
    assert.equal(task.dedicatedSessionPersistent, undefined);

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
    assert.equal(second.sessionFile, secondSessionFile);
    assert.equal(task.dedicatedSessionFile, undefined);
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
          controllerKey: "default",
          affectChatBinding: undefined,
          linkDeliveriesToSession: undefined,
          deliverFinal: true,
          disposeAfterTurn: undefined,
          text: "hello",
          sessionFile: undefined,
          createSessionFileIfMissing: undefined,
        },
        {
          chatKey: "telegram/demo:1",
          controllerKey: "default",
          affectChatBinding: undefined,
          linkDeliveriesToSession: undefined,
          deliverFinal: true,
          disposeAfterTurn: undefined,
          text: "hello",
          sessionFile: undefined,
          createSessionFileIfMissing: undefined,
        },
      ],
    );
    assert.equal(calls[0].taskId, "cron_dedicated");
    assert.equal("triggerKind" in (calls[0].promptMeta || {}), false);
    assert.equal("taskRunId" in (calls[0].promptMeta || {}), false);
    assert.equal("taskSessionMode" in (calls[0].promptMeta || {}), false);
    assert.equal(calls[0].systemPromptBlocks, undefined);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron legacy session artifacts cannot override the current frontend session", async () => {
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
    assert.equal(result.sessionFile, "/tmp/seeded-session-next.jsonl");
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
        controllerKey: "default",
        affectChatBinding: undefined,
        linkDeliveriesToSession: undefined,
        deliverFinal: true,
        disposeAfterTurn: undefined,
        text: "hello",
        sessionFile: undefined,
      },
    );
    assert.equal(calls[0].taskId, "cron_seeded");
    assert.equal("taskSessionMode" in (calls[0].promptMeta || {}), false);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron agent tasks require a frontend instead of a session fallback", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  try {
    await assert.rejects(
      execMod.executeCronAgentTask(
        {
          id: "cron_unbound",
          createdFrom: { sessionFile: "/tmp/legacy-session.jsonl" },
          target: { kind: "agent_prompt", prompt: "hello" },
        },
        {
          agentDir,
          chat: { runTurn: async () => ({ finalText: "unreachable" }) },
        },
      ),
      /cron_frontend_required/,
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron frontend input uses the standard frontend controller and delivery", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const sourceSessionFile = path.join(agentDir, "sessions", "source.jsonl");
  const resultSessionFile = path.join(agentDir, "sessions", "frontend.jsonl");
  const task = {
    id: "cron_frontend_bound",
    frontend: { kind: "sdk", key: "client/main" },
    session: { mode: "none" },
    createdFrom: { sessionFile: sourceSessionFile },
    target: { kind: "agent_prompt", prompt: "hello" },
  };
  const calls = [];
  try {
    await fs.mkdir(path.dirname(sourceSessionFile), { recursive: true });
    await fs.writeFile(sourceSessionFile, "session", "utf8");
    const result = await execMod.executeCronAgentTask(task, {
      agentDir,
      runId: "run-frontend-1",
      chat: {
        runTurn: async (payload) => {
          calls.push(payload);
          return {
            finalText: "done",
            sessionId: "s1",
            sessionFile: resultSessionFile,
          };
        },
      },
    });
    assert.equal(result.text, "done");
    assert.equal(result.sessionFile, resultSessionFile);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].chatKey, undefined);
    assert.equal(calls[0].controllerKey, "client/main");
    assert.equal("affectChatBinding" in calls[0], false);
    assert.equal(calls[0].shutdownAfterTurn, undefined);
    assert.equal("sessionFile" in calls[0], false);
    assert.deepEqual(calls[0].promptMeta?.frontend, {
      kind: "sdk",
      key: "client/main",
    });
    assert.equal(calls[0].promptMeta?.source, "scheduled-task");
    assert.equal(calls[0].promptMeta?.taskId, "cron_frontend_bound");
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler accepts the singleton TUI frontend binding", () => {
  const scheduler = new cronMod.CronScheduler({
    agentDir: "/tmp/rin-agent",
    cwd: process.cwd(),
  });
  const task = scheduler.upsertTask({
    trigger: { runAt: "2026-04-10T00:00:00.000Z" },
    frontend: { kind: "tui", key: "terminal/main" },
    session: { mode: "none" },
    target: { kind: "agent_prompt", prompt: "hello" },
  });
  assert.deepEqual(task.frontend, { kind: "tui" });
});

test("cron scheduler binds tasks created from the singleton TUI frontend", async () => {
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
    assert.deepEqual(task.frontend, { kind: "tui" });
    const rows = JSON.parse(await fs.readFile(tasksFile, "utf8"));
    assert.deepEqual(rows[0].createdFrom.frontend, { kind: "tui" });
  } finally {
    scheduler.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler accepts persisted TUI frontend bindings", async () => {
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
    scheduler.reloadTasks();
    assert.deepEqual(scheduler.getTask("cron_tui_frontend")?.frontend, {
      kind: "tui",
    });
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
        id: "cron_invalid_frontend_task",
        frontend: { kind: "sdk" },
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

test("cron scheduler drops removed capability overrides", () => {
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
  assert.equal(task.disabledRinCapabilities, undefined);
});

test("cron chat-bound agent task submits into the current frontend session", async () => {
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
  const runTurnCalls = [];
  const incomingCalls = [];
  const order = [];
  try {
    await fs.mkdir(path.dirname(transientSessionFile), { recursive: true });
    await fs.writeFile(transientSessionFile, "temporary session", "utf8");
    const result = await execMod.executeCronAgentTask(task, {
      agentDir,
      runId: "run-chat-1",
      chat: {
        send: async () => {
          throw new Error("scheduled tasks must not call chat.send");
        },
        runTurn: async (payload) => {
          runTurnCalls.push(payload);
          throw new Error("scheduled tasks must not call runTurn directly");
        },
        submitIncoming: async (payload) => {
          order.push("submit-incoming");
          incomingCalls.push(payload);
          return { turnId: "scheduled-inbox-1" };
        },
      },
    });
    assert.deepEqual(order, ["submit-incoming"]);
    assert.equal(result.text, "");
    assert.equal(result.sessionFile, undefined);
    assert.equal(
      await fs.readFile(transientSessionFile, "utf8"),
      "temporary session",
    );
    assert.equal(runTurnCalls.length, 0);
    assert.equal(incomingCalls[0].chatKey, "telegram/demo:1");
    assert.equal("affectChatBinding" in incomingCalls[0], false);
    assert.equal(incomingCalls[0].linkDeliveriesToSession, undefined);
    assert.equal(incomingCalls[0].sessionFile, undefined);
    assert.equal(incomingCalls[0].managedSessionLeaf, undefined);
    assert.equal(incomingCalls[0].disposeAfterTurn, undefined);
    assert.equal(incomingCalls[0].shutdownAfterTurn, undefined);
    assert.equal(incomingCalls[0].messageId, undefined);
    assert.equal(incomingCalls[0].text, "hello");
    assert.equal(incomingCalls[0].taskId, "cron_chat_bound");
    assert.equal(incomingCalls[0].taskName, "Chat Bound Task");
    assert.equal(incomingCalls[0].promptMeta, undefined);
    assert.equal(incomingCalls[0].requestTag, undefined);
    assert.equal(
      incomingCalls[0].deliveryIdempotencyKey,
      "scheduled-input:run-chat-1",
    );
    assert.equal(incomingCalls[0].showInput, true);
    assert.equal(incomingCalls[0].deliverFinal, true);
    assert.equal(incomingCalls[0].quietMode, false);
    assert.equal(incomingCalls[0].systemPromptBlocks, undefined);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron visible agent task does not start before its input delivery is confirmed", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  let runTurnCalls = 0;
  try {
    await assert.rejects(
      rawExecMod.executeCronAgentTask(
        {
          id: "cron_delivery_fence",
          name: "Delivery fence",
          frontend: { kind: "chat", key: "discord/1:2" },
          quiet: false,
          session: { mode: "none" },
          trigger: { expression: "0 * * * *", timezone: "local" },
          target: { kind: "agent_prompt", prompt: "inspect" },
        },
        {
          agentDir,
          runId: "run-delivery-fence",
          chat: {
            submitIncoming: async () => {
              throw new Error("delivery pending");
            },
            runTurn: async () => {
              runTurnCalls += 1;
              return { finalText: "should not run" };
            },
          },
        },
      ),
      /delivery pending/,
    );
    assert.equal(runTurnCalls, 0);
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
    frontend: { kind: "chat", key: "discord/1:2" },
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

test("cron quiet agent tasks keep the frontend turn but suppress automatic delivery", async () => {
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
    assert.equal(calls[0].chatKey, "telegram/demo:1");
    assert.equal(calls[0].deliverFinal, false);
    assert.equal(calls[0].quietMode, true);
    assert.equal(calls[0].showInput, false);
    assert.equal(calls[1].chatKey, "telegram/demo:1");
    assert.equal(calls[1].deliverFinal, true);
    assert.equal(calls[1].quietMode, false);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat quiet mode suppresses scheduled input but preserves final delivery", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const chatKey = "onebot/demo:quiet-group";
  await fs.writeFile(
    path.join(agentDir, "settings.json"),
    `${JSON.stringify({ chat: { byChatKey: { [chatKey]: { quietMode: true } } } })}\n`,
    "utf8",
  );
  const sends = [];
  const turns = [];
  await execMod.executeCronAgentTask(
    {
      id: "cron_chat_quiet",
      name: "quiet group",
      frontend: { kind: "chat", key: chatKey },
      target: { kind: "agent_prompt", prompt: "hello" },
    },
    {
      agentDir,
      runId: "run:chat-quiet",
      chat: {
        send: async (payload) => {
          sends.push(payload);
          return { delivered: true, messageIds: ["unexpected"] };
        },
        runTurn: async (payload) => {
          turns.push(payload);
          return { finalText: "done" };
        },
      },
    },
  );
  assert.deepEqual(sends, []);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].showInput, false);
  assert.equal(turns[0].quietMode, false);
  assert.equal(turns[0].deliverFinal, true);
});

test("cron scheduler strips legacy session instructions from task files", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const tasksFile = path.join(agentDir, "data", "scheduler", "tasks.json");
  const legacyTask = {
    id: "cron_legacy_instruction",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    enabled: true,
    frontend: { kind: "chat", key: "discord/1:2" },
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
    scheduler.reloadTasks();
    const loaded = scheduler.getTask("cron_legacy_instruction");
    assert.equal(Object.hasOwn(loaded, "session"), false);
    scheduler.upsertTask({ id: loaded.id, name: "migrated" });
    const [persisted] = JSON.parse(await fs.readFile(tasksFile, "utf8"));
    assert.equal(Object.hasOwn(persisted, "session"), false);
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
    assert.equal(result.text, "done from result");
    assert.equal(result.sessionFile, "/tmp/cron-result-fallback.jsonl");
    assert.equal(task.dedicatedSessionFile, undefined);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron recurring agent task uses separate initial and continuation prompts", async () => {
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

test("cron chat-bound agent task uses standard frontend delivery", async () => {
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
          return {
            delivered: true,
            messageIds: ["scheduled-input-delivery"],
          };
        },
      },
    });
    assert.equal(sent.length, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].replyToMessageId, "scheduled-input-test");
    assert.equal(calls[0].chatKey, "telegram/demo:1");
    assert.equal("affectChatBinding" in calls[0], false);
    assert.equal(calls[0].linkDeliveriesToSession, undefined);
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
    assert.equal(calls[0].chatKey, "telegram/demo:1");
    assert.equal(calls[0].deliverFinal, false);
    assert.equal(calls[0].quietMode, true);
    assert.equal(calls[0].showInput, false);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron chat-bound shell task toggles frontend working while running", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const working = [];
  const order = [];
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
          order.push(payload.visible ? "working" : "idle");
        },
        send: async (payload) => {
          const text = payload.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text || part.attrs?.text || "")
            .join("\n");
          order.push(
            text.includes("Scheduled task") ? "scheduled-input" : "final",
          );
          return {
            delivered: true,
            messageIds: ["scheduled-shell-input"],
          };
        },
      },
    });
    assert.deepEqual(order, ["scheduled-input", "working", "final", "idle"]);
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

test("cron scheduler terminates active frontend turns when agent tasks stop", async () => {
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
    scheduler.activeExecutions.set("cron_stop_me", { startedAt: Date.now() });
    scheduler.pauseTask("cron_stop_me");
    scheduler.deleteTask("cron_stop_me");
    scheduler.pauseTask("cron_unbound_stop_me");
    scheduler.completeTask("cron_none_complete_me", "done");
    assert.deepEqual(terminations, ["default", "default"]);
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
