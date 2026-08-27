import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CronScheduler } from "../../dist/core/rin-daemon/cron.js";
import { cronTasksPath } from "../../dist/core/rin-daemon/cron-utils.js";

async function withAgentDir(run: (agentDir: string) => Promise<void>) {
  const agentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "rin-cron-owner-"));
  try {
    await run(agentDir);
  } finally {
    await fsp.rm(agentDir, { recursive: true, force: true });
  }
}

function futureIso(minutes = 30) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function pastIso(minutes = 1) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

async function waitForTaskSettled(scheduler: CronScheduler, taskId: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const task = scheduler.getTask(taskId);
    if (task && !task.running) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`task did not settle:${taskId}`);
}

function shellTaskInput(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Owner ${id}`,
    trigger: { runAt: futureIso() },
    session: { mode: "none" },
    target: { kind: "shell_command", command: "printf owner-cron" },
    ...overrides,
  } as any;
}

test("cron scheduler starts without implicit tasks", async () => {
  await withAgentDir(async (agentDir) => {
    const scheduler = new CronScheduler({ agentDir });
    scheduler.start();
    try {
      assert.deepEqual(scheduler.listTasks(), []);
      assert.equal(scheduler.getTask("missing"), undefined);

      const status = scheduler.getStatusSnapshot();
      assert.equal(status.taskCount, 0);
      assert.equal(status.enabledTaskCount, 0);
      assert.equal(status.runningTaskCount, 0);
      assert.equal(status.nextRunAt, undefined);
    } finally {
      scheduler.stop();
    }
    assert.deepEqual(
      JSON.parse(fs.readFileSync(cronTasksPath(agentDir), "utf8")),
      [],
    );
  });
});

test("cron upsert validates trigger, session, target, frontend, condition, and model options", async () => {
  await withAgentDir(async (agentDir) => {
    const scheduler = new CronScheduler({ agentDir });
    assert.throws(
      () => scheduler.upsertTask({} as any),
      /cron_trigger_required/,
    );
    assert.throws(
      () =>
        scheduler.upsertTask({
          trigger: {},
          session: { mode: "none" },
          target: { kind: "shell_command", command: "owner" },
        } as any),
      /cron_runAt_required/,
    );
    assert.throws(
      () =>
        scheduler.upsertTask({
          trigger: { runAt: "not-a-date" },
          session: { mode: "none" },
          target: { kind: "shell_command", command: "owner" },
        } as any),
      /invalid_runAt/,
    );
    assert.throws(
      () =>
        scheduler.upsertTask({
          trigger: { runAt: futureIso() },
          session: { mode: "invalid" },
          target: { kind: "shell_command", command: "owner" },
        } as any),
      /cron_invalid_session_mode/,
    );
    assert.throws(
      () =>
        scheduler.upsertTask({
          trigger: { runAt: futureIso() },
          session: { mode: "none" },
        } as any),
      /cron_target_required/,
    );
    assert.throws(
      () =>
        scheduler.upsertTask({
          trigger: { runAt: futureIso() },
          session: { mode: "none" },
          target: { kind: "agent_prompt", prompt: " " },
        } as any),
      /cron_prompt_required/,
    );
    assert.throws(
      () =>
        scheduler.upsertTask({
          trigger: { runAt: futureIso() },
          session: { mode: "none" },
          target: { kind: "shell_command", command: " " },
        } as any),
      /cron_command_required/,
    );
    assert.throws(
      () =>
        scheduler.upsertTask({
          trigger: { runAt: futureIso() },
          session: { mode: "none" },
          target: { kind: "unknown" },
        } as any),
      /cron_invalid_target_kind:unknown/,
    );
    assert.throws(
      () =>
        scheduler.upsertTask({
          trigger: { runAt: futureIso() },
          frontend: { kind: "tui", key: "terminal" },
          target: { kind: "shell_command", command: "owner" },
        } as any),
      /cron_frontend_tui_unbindable/,
    );
    const defaulted = scheduler.upsertTask({
      id: "defaulted",
      trigger: { runAt: futureIso() },
      frontend: { key: "owner-front" },
      target: { kind: "shell_command", command: "owner" },
    } as any);
    assert.deepEqual(defaulted.session, { mode: "none" });
    assert.deepEqual(defaulted.frontend, { key: "owner-front" });
    assert.throws(
      () =>
        scheduler.upsertTask({
          trigger: { runAt: futureIso() },
          frontend: { key: " " },
          session: { mode: "none" },
          target: { kind: "shell_command", command: "owner" },
        } as any),
      /cron_frontend_key_required/,
    );
    assert.throws(
      () =>
        scheduler.upsertTask({
          trigger: { runAt: futureIso() },
          condition: { code: " " },
          session: { mode: "none" },
          target: { kind: "shell_command", command: "owner" },
        } as any),
      /cron_condition_code_required/,
    );
    const normalized = scheduler.upsertTask(
      {
        id: "normalized",
        name: "  Owner normalized  ",
        trigger: { expression: "*/15 * * * *", timezone: "local" },
        frontend: { kind: "desktop", key: " owner-front " },
        deliverFinal: false,
        quiet: false,
        model: " owner/model ",
        thinkingLevel: "high",
        disabledRinCapabilities: ["memory", "memory", " ", "todo"],
        termination: { maxRuns: 0, stopAt: futureIso(90) },
        condition: { code: "true", timeoutMs: 1 },
        session: { mode: "dedicated" },
        target: {
          kind: "agent_prompt",
          prompt: " owner prompt ",
          continuationPrompt: " continue owner ",
        },
      },
      {
        sessionFile: "/tmp/created.jsonl",
        sessionId: "created-session",
        sessionName: "Created",
        frontend: { kind: "chat", key: "created-chat" },
      },
    );
    assert.equal(normalized.name, "Owner normalized");
    assert.deepEqual(normalized.frontend, {
      kind: "desktop",
      key: "owner-front",
    });
    assert.equal(normalized.deliverFinal, undefined);
    assert.equal(normalized.quiet, false);
    assert.equal(normalized.model, "owner/model");
    assert.equal(normalized.thinkingLevel, "high");
    assert.deepEqual(normalized.disabledRinCapabilities, ["memory", "todo"]);
    assert.equal(normalized.termination?.maxRuns, undefined);
    assert.equal(normalized.condition?.timeoutMs, 100);
    assert.equal(normalized.dedicatedSessionPersistent, true);
    assert.match(normalized.dedicatedSessionFile ?? "", /normalized\.jsonl$/);
    assert.deepEqual(normalized.createdFrom?.frontend, {
      kind: "chat",
      key: "created-chat",
    });

    const updated = scheduler.upsertTask({
      id: "normalized",
      name: "",
      frontend: null,
      model: "",
      thinkingLevel: "invalid" as any,
      disabledRinCapabilities: null,
      termination: null,
      condition: null,
      trigger: { expression: "0 * * * *" },
      session: { mode: "none" },
      target: {
        kind: "shell_command",
        command: "printf updated",
        timeoutMs: 1,
      },
    });
    assert.equal(updated.createdAt, normalized.createdAt);
    assert.equal(updated.name, undefined);
    assert.equal(updated.frontend, undefined);
    assert.equal(updated.model, undefined);
    assert.equal(updated.thinkingLevel, undefined);
    assert.equal(updated.disabledRinCapabilities, undefined);
    assert.equal(updated.termination, undefined);
    assert.equal(updated.condition, undefined);
    assert.equal(updated.target.kind, "shell_command");
    if (updated.target.kind === "shell_command") {
      assert.equal(updated.target.timeoutMs, 100);
    }
    scheduler.stop();
  });
});

test("cron updates retain omitted state and keep completed tasks terminal", async () => {
  await withAgentDir(async (agentDir) => {
    const scheduler = new CronScheduler({ agentDir });
    const created = scheduler.upsertTask({
      id: "retained",
      trigger: { expression: "*/10 * * * *" },
      frontend: { key: "owner-frontend" },
      disabledRinCapabilities: "memory" as any,
      termination: { maxRuns: 3 },
      condition: { code: "false", timeoutMs: 90_000 },
      target: { kind: "shell_command", command: "printf retained" },
    });
    assert.equal(created.session.mode, "none");
    assert.deepEqual(created.frontend, { key: "owner-frontend" });
    assert.deepEqual(created.disabledRinCapabilities, ["memory"]);
    assert.equal(created.condition?.timeoutMs, 60_000);
    assert.equal(created.target.kind, "shell_command");
    if (created.target.kind === "shell_command") {
      assert.equal(created.target.timeoutMs, 30 * 60_000);
    }

    const conditionSkipped = scheduler.runTaskNow("retained");
    assert.equal(conditionSkipped.condition?.lastResult, false);
    const retained = scheduler.upsertTask({
      id: "retained",
      name: "Retained owner",
      condition: { code: "true" },
    });
    assert.equal(retained.trigger.expression, "*/10 * * * *");
    assert.equal(retained.session.mode, "none");
    assert.equal(retained.target.kind, "shell_command");
    assert.deepEqual(retained.frontend, { key: "owner-frontend" });
    assert.deepEqual(retained.disabledRinCapabilities, ["memory"]);
    assert.equal(retained.termination?.maxRuns, 3);
    assert.equal(retained.condition?.lastResult, false);
    assert.ok(retained.condition?.lastEvaluatedAt);

    const cleared = scheduler.upsertTask({
      id: "retained",
      disabledRinCapabilities: [],
    });
    assert.equal(cleared.disabledRinCapabilities, undefined);
    const recurringReschedule = scheduler.rescheduleOneTimeTask(
      "retained",
      futureIso(120),
    );
    assert.equal(recurringReschedule.trigger.expression, "*/10 * * * *");
    assert.ok(recurringReschedule.nextRunAt);

    const completed = scheduler.completeTask("retained", "");
    assert.equal(completed.completionReason, "completed");
    const afterCompletedUpdate = scheduler.upsertTask({
      id: "retained",
      name: "still terminal",
    });
    assert.equal(afterCompletedUpdate.enabled, false);
    assert.equal(afterCompletedUpdate.nextRunAt, undefined);
    assert.ok(afterCompletedUpdate.completedAt);
    scheduler.stop();
  });
});

test("cron task controls preserve lifecycle state and reject missing or completed tasks", async () => {
  await withAgentDir(async (agentDir) => {
    const terminated: unknown[] = [];
    const scheduler = new CronScheduler({
      agentDir,
      chat: {
        async terminateTurn(payload) {
          terminated.push(payload);
        },
      },
    });
    const task = scheduler.upsertTask(
      shellTaskInput("lifecycle", {
        frontend: { kind: "desktop", key: "owner-controller" },
      }),
    );
    assert.equal(scheduler.pauseTask(task.id).enabled, false);
    assert.ok(scheduler.getTask(task.id)?.pausedAt);
    assert.equal(scheduler.resumeTask(task.id).enabled, true);
    assert.equal(scheduler.getTask(task.id)?.pausedAt, undefined);
    const rescheduled = scheduler.rescheduleOneTimeTask(task.id, futureIso(60));
    assert.equal(rescheduled.enabled, true);
    assert.equal(rescheduled.completedAt, undefined);
    assert.equal(scheduler.wakeTaskNow(task.id).enabled, true);
    assert.ok(scheduler.getTask(task.id)?.nextRunAt);
    const completed = scheduler.completeTask(task.id, " owner complete ");
    assert.equal(completed.enabled, false);
    assert.equal(completed.completionReason, "owner complete");
    assert.equal(completed.nextRunAt, undefined);
    assert.throws(() => scheduler.wakeTaskNow(task.id), /cron_task_completed/);
    assert.throws(() => scheduler.runTaskNow(task.id), /cron_task_completed/);
    assert.equal(scheduler.deleteTask(task.id), true);
    assert.equal(scheduler.deleteTask("missing"), false);
    assert.equal(scheduler.getTask(task.id), undefined);

    for (const operation of [
      () => scheduler.completeTask("missing"),
      () => scheduler.pauseTask("missing"),
      () => scheduler.resumeTask("missing"),
      () => scheduler.rescheduleOneTimeTask("missing", futureIso()),
      () => scheduler.wakeTaskNow("missing"),
      () => scheduler.runTaskNow("missing"),
    ]) {
      assert.throws(operation, /cron_task_not_found/);
    }
    assert.throws(
      () => scheduler.rescheduleOneTimeTask("missing", "invalid"),
      /cron_task_not_found/,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(terminated.length >= 3, true);
    assert.deepEqual(terminated.at(-1), { controllerKey: "owner-controller" });
    scheduler.stop();
  });
});

test("cron run-now evaluates conditions and executes one-time and recurring shell tasks", async () => {
  await withAgentDir(async (agentDir) => {
    const scheduler = new CronScheduler({ agentDir });
    scheduler.upsertTask(
      shellTaskInput("condition-false", {
        trigger: { runAt: pastIso() },
        condition: { code: "false" },
      }),
    );
    const skipped = scheduler.runTaskNow("condition-false");
    assert.equal(skipped.completedAt !== undefined, true);
    assert.equal(skipped.completionReason, "condition_false");
    assert.equal(skipped.condition?.lastResult, false);
    assert.match(skipped.condition?.lastOutput ?? "", /false/);

    scheduler.upsertTask(
      shellTaskInput("condition-recurring", {
        trigger: { expression: "*/5 * * * *" },
        condition: { code: "({ task }) => task.runCount > 0" },
      }),
    );
    const recurringSkipped = scheduler.runTaskNow("condition-recurring");
    assert.equal(recurringSkipped.enabled, true);
    assert.equal(recurringSkipped.completedAt, undefined);
    assert.ok(recurringSkipped.nextRunAt);

    scheduler.upsertTask(
      shellTaskInput("recurring-success", {
        trigger: { expression: "*/5 * * * *" },
      }),
    );
    scheduler.runTaskNow("recurring-success");
    const recurringSettled = await waitForTaskSettled(
      scheduler,
      "recurring-success",
    );
    assert.equal(recurringSettled.runCount, 1);
    assert.ok(recurringSettled.nextRunAt);
    assert.equal(recurringSettled.completedAt, undefined);

    scheduler.upsertTask(
      shellTaskInput("shell-success", {
        trigger: { runAt: pastIso() },
        condition: { code: "return context.task.id === 'shell-success';" },
        termination: { maxRuns: 1 },
      }),
    );
    const running = scheduler.runTaskNow("shell-success");
    assert.equal(running.running, true);
    assert.throws(
      () => scheduler.runTaskNow("shell-success"),
      /cron_task_already_running/,
    );
    const settled = await waitForTaskSettled(scheduler, "shell-success");
    assert.equal(settled.runCount, 1);
    assert.match(settled.lastResultText ?? "", /owner-cron/);
    assert.ok(settled.lastFinishedAt);
    assert.equal(settled.completedAt !== undefined, true);
    scheduler.stop();
  });
});

test("cron releases shell task execution state after a command timeout", async () => {
  await withAgentDir(async (agentDir) => {
    const scheduler = new CronScheduler({ agentDir });
    const pidPath = path.join(agentDir, "scheduler-shell.pid");
    try {
      scheduler.upsertTask(
        shellTaskInput("shell-timeout", {
          target: {
            kind: "shell_command",
            command: `printf %s $$ > ${JSON.stringify(pidPath)}; exec sleep 30`,
            timeoutMs: 100,
          },
        }),
      );
      const running = scheduler.runTaskNow("shell-timeout");
      assert.equal(running.running, true);

      const settled = await waitForTaskSettled(scheduler, "shell-timeout");
      assert.equal(settled.running, false);
      assert.match(settled.lastError ?? "", /cron_shell_command_timeout:100/);
      assert.equal(
        (scheduler as any).activeExecutions.has("shell-timeout"),
        false,
      );
    } finally {
      const pid = Number(await fsp.readFile(pidPath, "utf8").catch(() => ""));
      if (pid > 0) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      scheduler.stop();
    }
  });
});

test("cron merges a finishing execution into a task updated while it runs", async () => {
  await withAgentDir(async (agentDir) => {
    const scheduler = new CronScheduler({ agentDir });
    scheduler.upsertTask(
      shellTaskInput("concurrent-update", {
        target: {
          kind: "shell_command",
          command: "sleep 0.05; printf concurrent-owner",
        },
      }),
    );
    scheduler.runTaskNow("concurrent-update");
    const updated = scheduler.upsertTask({
      id: "concurrent-update",
      name: "Updated while running",
      enabled: false,
    });
    assert.equal(updated.name, "Updated while running");
    assert.equal(updated.enabled, false);
    const settled = await waitForTaskSettled(scheduler, "concurrent-update");
    assert.equal(settled.name, "Updated while running");
    assert.equal(settled.enabled, false);
    assert.equal(settled.runCount, 1);
    assert.match(settled.lastResultText ?? "", /concurrent-owner/);
    scheduler.stop();
  });
});

test("cron session invocations route prompt work through the owned adapter", async () => {
  await withAgentDir(async (agentDir) => {
    const events: Array<[string, any]> = [];
    const scheduler = new CronScheduler({
      agentDir,
      chat: {
        async runTurn(payload) {
          events.push(["runTurn", payload]);
          return {
            finalText: "owner prompt result",
            sessionFile: payload.restoreSessionFile,
          };
        },
        async send(payload) {
          events.push(["send", payload]);
          return { messageIds: ["owner-message"] };
        },
        async setWorkingVisible(payload) {
          events.push(["working", payload]);
        },
        async terminateTurn(payload) {
          events.push(["terminate", payload]);
        },
      },
    });

    scheduler.upsertTask({
      id: "prompt-task",
      name: "Owner prompt task",
      frontend: { kind: "chat", key: "telegram:owner" },
      deliverFinal: true,
      quiet: false,
      trigger: { runAt: pastIso() },
      termination: { maxRuns: 1 },
      session: { mode: "none" },
      target: {
        kind: "agent_prompt",
        prompt: "owner prompt",
        continuationPrompt: "owner continuation",
      },
    });
    scheduler.runTaskNow("prompt-task");
    const prompt = await waitForTaskSettled(scheduler, "prompt-task");
    assert.equal(prompt.lastResultText, "owner prompt result");

    assert.equal(
      events.some(([type]) => type === "runTurn"),
      true,
    );
    scheduler.stop();
  });
});

test("cron reload accepts legacy persisted bindings and rejects invalid task files", async () => {
  await withAgentDir(async (agentDir) => {
    const filePath = cronTasksPath(agentDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      `${JSON.stringify([
        {
          id: "legacy-chat",
          createdAt: "2026-07-17T00:00:00.000Z",
          updatedAt: "2026-07-17T00:00:00.000Z",
          enabled: true,
          chatKey: "telegram/bot:legacy-owner",
          deliverFinal: undefined,
          model: " owner/model ",
          thinkingLevel: "invalid",
          trigger: { startAt: futureIso() },
          session: { mode: "none" },
          target: { kind: "shell_command", command: "printf legacy" },
          runCount: 0,
          running: true,
          lastError: 42,
        },
      ])}\n`,
    );
    const scheduler = new CronScheduler({ agentDir });
    const status = scheduler.reloadTasks();
    assert.equal(status.taskCount, 1);
    const legacy = scheduler.getTask("legacy-chat");
    assert.deepEqual(legacy?.frontend, {
      kind: "chat",
      key: "telegram/bot:legacy-owner",
    });
    assert.equal(legacy?.deliverFinal, undefined);
    assert.equal(legacy?.quiet, false);
    assert.equal(legacy?.thinkingLevel, undefined);
    assert.equal(legacy?.model, "owner/model");
    assert.equal(legacy?.running, false);
    assert.equal(legacy?.lastError, "42");

    fs.writeFileSync(filePath, "{not json\n");
    assert.throws(() => scheduler.reloadTasks(), /cron_tasks_file_invalid/);
    fs.writeFileSync(filePath, `${JSON.stringify({ not: "an array" })}\n`);
    assert.throws(() => scheduler.reloadTasks(), /cron_tasks_file_invalid/);
    fs.writeFileSync(
      filePath,
      `${JSON.stringify([
        {
          id: "invalid-session",
          trigger: { runAt: futureIso() },
          session: { mode: "invalid" },
          target: { kind: "shell_command", command: "owner" },
        },
      ])}\n`,
    );
    assert.throws(() => scheduler.reloadTasks(), /cron_tasks_file_invalid/);
    scheduler.stop();
  });
});
