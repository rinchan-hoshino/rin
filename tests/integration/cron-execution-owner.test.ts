import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const cronExecution = await importBuiltModule<
  typeof import("../../src/core/rin-daemon/cron-execution.js")
>("dist/core/rin-daemon/cron-execution.js");
const runAudit = await importBuiltModule<
  typeof import("../../src/core/self-improve/run-audit.js")
>("dist/core/self-improve/run-audit.js");

function task(overrides: Record<string, any> = {}) {
  return {
    id: "cron_owner",
    name: "Owner task",
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    enabled: true,
    trigger: { runAt: "2099-07-17T00:00:00.000Z" },
    frontend: { kind: "chat", key: "discord/owner:task" },
    target: { kind: "agent_prompt", prompt: "run owner task" },
    runCount: 1,
    ...overrides,
  } as any;
}

function selfImproveTask(overrides: Record<string, any> = {}) {
  return task({
    id: "scheduled_self_improve_distillation",
    target: {
      kind: "agent_prompt",
      prompt: "Follow self-improve-distillation.md.",
    },
    ...overrides,
  });
}

async function withAgentDir(run: (agentDir: string) => Promise<void>) {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-owner-"));
  try {
    await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

test("cron chat delivery requires a sender and preserves conversation binding", async () => {
  await assert.rejects(
    cronExecution.sendChatText(
      {},
      {
        chatKey: "discord/1:2",
        taskId: "cron_owner",
        runId: "run-1",
        text: "done",
      },
    ),
    /cron_chat_unavailable/,
  );

  const sent: any[] = [];
  await cronExecution.sendChatText(
    { chat: { send: async (payload) => sent.push(payload) } },
    {
      chatKey: "discord/1:2",
      taskId: "cron_owner",
      runId: "run-1",
      text: "done",
      sessionFile: "/sessions/owner.jsonl",
    },
  );
  await cronExecution.sendChatText(
    { chat: { send: async (payload) => sent.push(payload) } },
    {
      chatKey: "discord/1:2",
      taskId: "cron_owner",
      runId: "run-2",
      text: "plain",
    },
  );

  assert.match(sent[0].createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(sent[0].parts, [{ type: "text", text: "done" }]);
  assert.equal(sent[0].sessionBinding, "conversation");
  assert.equal(sent[0].sessionFile, "/sessions/owner.jsonl");
  assert.equal(sent[1].sessionFile, undefined);
  assert.equal(sent[1].sessionBinding, undefined);
});

test("cron shell execution reports command output and failures", async () => {
  await withAgentDir(async (agentDir) => {
    const success = await cronExecution.executeCronShellCommand(
      task({
        target: {
          kind: "shell_command",
          command: "printf owner-out; printf owner-err >&2",
        },
      }),
      { agentDir },
    );
    assert.match(success, /Command: printf owner-out/);
    assert.match(success, /Exit: 0/);
    assert.match(success, /stdout:\nowner-out/);
    assert.match(success, /stderr:\nowner-err/);

    await assert.rejects(
      cronExecution.executeCronShellCommand(
        task({
          target: {
            kind: "shell_command",
            command: "printf failed >&2; exit 7",
          },
        }),
        { agentDir },
      ),
      (error: any) => {
        assert.match(error.message, /Exit: 7/);
        assert.match(error.message, /stderr:\nfailed/);
        return true;
      },
    );
    await assert.rejects(
      cronExecution.executeCronShellCommand(task(), { agentDir }),
      /cron_invalid_shell_task/,
    );

    await fs.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ shellPath: "/missing/owner-shell" }),
    );
    await assert.rejects(
      cronExecution.executeCronShellCommand(
        task({ target: { kind: "shell_command", command: "true" } }),
        { agentDir },
      ),
      /Custom shell path not found/,
    );

    await fs.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ shellPath: "/bin/sh" }),
    );
    const custom = await cronExecution.executeCronShellCommand(
      task({ target: { kind: "shell_command", command: "printf custom" } }),
      { agentDir },
    );
    assert.match(custom, /stdout:\ncustom/);
  });
});

test("cron shell execution times out instead of retaining active work", async () => {
  await withAgentDir(async (agentDir) => {
    const pidPath = path.join(agentDir, "shell.pid");
    const execution = cronExecution.executeCronShellCommand(
      task({
        target: {
          kind: "shell_command",
          command: `sleep 30 & printf %s $! > ${JSON.stringify(pidPath)}`,
          timeoutMs: 100,
        },
      }),
      { agentDir },
    );
    const observed = await Promise.race([
      execution.then(
        () => ({ status: "resolved" as const }),
        (error) => ({ status: "rejected" as const, error }),
      ),
      new Promise<{ status: "pending" }>((resolve) => {
        setTimeout(() => resolve({ status: "pending" }), 1_000);
      }),
    ]);

    const pid = Number(await fs.readFile(pidPath, "utf8").catch(() => ""));
    if (observed.status === "pending") {
      if (pid > 0) process.kill(pid, "SIGKILL");
      await execution.catch(() => {});
    }

    assert.equal(observed.status, "rejected");
    if (observed.status === "rejected") {
      assert.match(observed.error.message, /cron_shell_command_timeout:100/);
    }
    assert.ok(pid > 0);
    let running = true;
    for (let attempt = 0; attempt < 50 && running; attempt += 1) {
      const stat = await fs
        .readFile(`/proc/${pid}/stat`, "utf8")
        .catch(() => "");
      running = Boolean(stat && !/\) Z /.test(stat));
      if (running) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(running, false);
  });
});

test("cron prompt context identifies chat and controller frontends", () => {
  assert.deepEqual(
    cronExecution.buildCronTaskPromptContext(
      task({ frontend: { kind: "chat", key: "telegram/1:2" } }),
      123,
    ),
    {
      source: "scheduled-task",
      sentAt: 123,
      chatKey: "telegram/1:2",
      frontend: { kind: "chat", key: "telegram/1:2" },
      taskId: "cron_owner",
      taskName: "Owner task",
      taskContextKind: "scheduled-task",
      selfImproveEligible: true,
    },
  );
  assert.deepEqual(
    cronExecution.buildCronTaskPromptContext(
      task({ name: " ", frontend: { kind: "tui", key: "terminal" } }),
      456,
    ),
    {
      source: "scheduled-task",
      sentAt: 456,
      frontend: { kind: "tui", key: "tui" },
      taskId: "cron_owner",
      taskName: undefined,
      taskContextKind: "scheduled-task",
      selfImproveEligible: true,
    },
  );
  assert.equal(
    cronExecution.buildCronTaskPromptContext(task({ frontend: undefined }), 789)
      .frontend,
    undefined,
  );
});

test("agent tasks defer non-quiet progress delivery to the current frontend", async () => {
  await withAgentDir(async (agentDir) => {
    const calls: any[] = [];
    const ownerTask = task({
      frontend: { kind: "chat", key: "discord/1:2" },
      quiet: false,
    });
    const result = await cronExecution.executeCronAgentTask(ownerTask, {
      agentDir,
      runId: "scheduled:owner",
      deliveryIdempotencyKey: "delivery-owner",
      chat: {
        runTurn: async (payload) => {
          calls.push(payload);
          return {
            messages: [
              { role: "user", content: "ignored" },
              { role: "assistant", content: [{ type: "text", text: "done" }] },
            ],
            sessionId: "session-owner",
            sessionFile: "/sessions/chat-owner.jsonl",
          };
        },
      },
    });

    assert.deepEqual(result, {
      text: "done",
      auditOutput: "done",
      sessionId: "session-owner",
      sessionFile: "/sessions/chat-owner.jsonl",
    });
    assert.equal(calls[0].controllerKey, "default");
    assert.equal(calls[0].chatKey, "discord/1:2");
    assert.equal("affectChatBinding" in calls[0], false);
    assert.equal(calls[0].deliverFinal, true);
    assert.equal("quietMode" in calls[0], false);
    assert.equal(calls[0].text, "run owner task");
    assert.equal(calls[0].requestTag, "scheduled:owner");
    assert.equal(calls[0].deliveryIdempotencyKey, "delivery-owner");
    assert.equal("sessionFile" in calls[0], false);
    assert.equal("managedSessionLeaf" in calls[0], false);
    assert.equal("model" in calls[0], false);
    assert.equal("thinkingLevel" in calls[0], false);
    assert.equal("disabledRinCapabilities" in calls[0], false);
    assert.deepEqual(calls[0].frontend, {
      kind: "chat",
      key: "discord/1:2",
    });
    assert.equal(calls[0].promptMeta.source, "scheduled-task");
    assert.equal(calls[0].promptMeta.taskName, "Owner task");

    await assert.rejects(
      cronExecution.executeCronAgentTask(
        task({ name: undefined, frontend: undefined }),
        {
          agentDir,
          continuing: false,
          chat: { runTurn: async () => ({ finalText: "detached" }) },
        },
      ),
      /cron_frontend_required/,
    );
  });
});

test("recurring frontend inputs select initial and continuation prompts", async () => {
  await withAgentDir(async (agentDir) => {
    const prompts: any[] = [];
    const recurring = task({
      runCount: 1,
      target: {
        kind: "agent_prompt",
        prompt: "initial",
        continuationPrompt: "continue",
      },
    });
    const first = await cronExecution.executeCronAgentTask(recurring, {
      agentDir,
      chat: {
        runTurn: async (payload) => {
          prompts.push(payload);
          return { finalText: "first", sessionFile: "/ignored.jsonl" };
        },
      },
    });
    assert.equal(first.sessionFile, "/ignored.jsonl");
    assert.equal(prompts[0].text, "initial");
    assert.equal(prompts[0].createSessionFileIfMissing, undefined);

    recurring.runCount = 2;
    const next = await cronExecution.executeCronAgentTask(recurring, {
      agentDir,
      chat: {
        runTurn: async (payload) => {
          prompts.push(payload);
          return { finalText: "next", sessionId: "dedicated" };
        },
      },
    });
    assert.equal(next.text, "next");
    assert.equal(next.sessionFile, undefined);
    assert.equal(prompts[1].text, "continue");
    assert.equal(prompts[1].createSessionFileIfMissing, undefined);

    await assert.rejects(
      cronExecution.executeCronAgentTask(
        task({ target: { kind: "shell_command", command: "true" } }),
        { agentDir },
      ),
      /cron_invalid_agent_task/,
    );
    await assert.rejects(
      cronExecution.executeCronAgentTask(task(), { agentDir }),
      /cron_chat_unavailable/,
    );
    await assert.rejects(
      cronExecution.executeCronAgentTask(
        task({ target: { kind: "agent_prompt", prompt: " " } }),
        { agentDir, chat: { runTurn: async () => ({}) } },
      ),
      /cron_prompt_required/,
    );
    assert.deepEqual(
      await cronExecution.executeCronAgentTask(task(), {
        agentDir,
        chat: { runTurn: async () => ({ messages: [] }) },
      }),
      {
        text: "",
        auditOutput: "",
        sessionId: undefined,
        sessionFile: undefined,
      },
    );
  });
});

test("durable cron invocations snapshot owner execution inputs", async () => {
  await withAgentDir(async (agentDir) => {
    const scheduled = task({
      lastStartedAt: "2026-07-17T02:00:00.000Z",
      nextRunAt: "2026-07-18T02:00:00.000Z",
      frontend: { kind: "chat", key: "discord/1:2" },
    });
    const invocation = cronExecution.createCronSessionInvocation(
      scheduled,
      agentDir,
    );
    assert.match(invocation.id, /^cron_owner:/);
    assert.equal(invocation.requestTag, `scheduled:${invocation.id}`);
    assert.equal(invocation.taskId, "cron_owner");
    assert.equal(invocation.runCount, 1);
    assert.equal(invocation.scheduledNextRunAt, "2026-07-18T02:00:00.000Z");
    assert.equal("sessionFile" in invocation, false);
    assert.equal(invocation.continuing, false);
    assert.notEqual(invocation.target, scheduled.target);
    assert.deepEqual(invocation.frontend, scheduled.frontend);

    const continued = cronExecution.createCronSessionInvocation(
      task({
        runCount: 2,
        target: {
          kind: "agent_prompt",
          prompt: "initial",
          continuationPrompt: "next",
        },
      }),
      agentDir,
    );
    assert.equal(continued.continuing, true);
    assert.equal("session" in continued, false);
    assert.equal("sessionFile" in continued, false);

    assert.throws(
      () =>
        cronExecution.createCronSessionInvocation(
          task({ target: { kind: "shell_command", command: "true" } }),
          agentDir,
        ),
      /cron_invalid_agent_task/,
    );
  });
});

test("durable invocations execute agent and continued session snapshots", async () => {
  await withAgentDir(async (agentDir) => {
    const agentInvocation = cronExecution.createCronSessionInvocation(
      task({ lastStartedAt: "2026-07-17T03:00:00.000Z" }),
      agentDir,
    );
    const agentCalls: any[] = [];
    const agentResult = await cronExecution.executeCronSessionInvocation(
      agentInvocation,
      {
        agentDir,
        chat: {
          runTurn: async (payload) => {
            agentCalls.push(payload);
            return { finalText: "agent invocation" };
          },
        },
      },
    );
    assert.equal(agentResult.text, "agent invocation");
    assert.equal(agentCalls[0].requestTag, agentInvocation.requestTag);
    assert.equal(
      agentCalls[0].deliveryIdempotencyKey,
      `scheduled-final:${agentInvocation.id}`,
    );
  });
});

test("durable self-improve invocation commits and acknowledges exact audit evidence", async () => {
  await withAgentDir(async (agentDir) => {
    const invocation = cronExecution.createCronSessionInvocation(
      selfImproveTask({
        lastStartedAt: "2026-07-28T18:00:00.000Z",
      }),
      agentDir,
    );
    const result = await cronExecution.executeCronSessionInvocation(
      invocation,
      {
        agentDir,
        chat: {
          runTurn: async () => ({ finalText: "audited cron output" }),
        },
      },
    );
    assert.equal(result.text, "audited cron output");
    assert.equal(result.auditOutput, "audited cron output");
    assert.equal(result.audit?.status, "completed");
    assert.equal(result.auditHistoryCommitted, true);

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
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(history.at(-1)?.audit?.auditId, result.audit?.auditId);
  });
});

test("durable self-improve invocation retains failed audit evidence", async () => {
  await withAgentDir(async (agentDir) => {
    const invocation = cronExecution.createCronSessionInvocation(
      selfImproveTask({
        lastStartedAt: "2026-07-28T18:30:00.000Z",
        runCount: 3,
      }),
      agentDir,
    );
    await assert.rejects(
      () =>
        cronExecution.executeCronSessionInvocation(invocation, {
          agentDir,
          chat: {
            runTurn: async () => {
              throw new Error("audited cron invocation failure");
            },
          },
        }),
      /audited cron invocation failure/,
    );
  });
});

test("terminal projection records completion, failure, and stop policies", () => {
  const once = task({ nextRunAt: undefined });
  cronExecution.applyCronTaskTerminalProjection(once, {
    status: "completed",
    text: "done",
  });
  assert.equal(once.lastResultText, "done");
  assert.equal(once.lastError, undefined);
  assert.equal(once.enabled, false);
  assert.equal(once.completionReason, "once_completed");
  assert.match(once.lastFinishedAt, /^\d{4}-/);

  const recurring = task({
    trigger: { expression: "* * * * *" },
    termination: { maxRuns: 2 },
    runCount: 2,
    lastResultText: "old",
  });
  cronExecution.applyCronTaskTerminalProjection(recurring, {
    status: "failed",
    error: "owner failure",
  });
  assert.equal(recurring.lastError, "owner failure");
  assert.equal(recurring.lastResultText, "old");
  assert.equal(recurring.completionReason, "max_runs_reached");

  const stopped = task({
    trigger: { expression: "* * * * *" },
    termination: { stopAt: "2000-01-01T00:00:00.000Z" },
  });
  cronExecution.applyCronTaskTerminalProjection(stopped, {
    status: "failed",
  });
  assert.equal(stopped.lastError, "cron_task_failed");
  assert.equal(stopped.completionReason, "stop_time_reached");

  const future = task({
    trigger: { expression: "* * * * *" },
    termination: { stopAt: "2099-01-01T00:00:00.000Z" },
  });
  cronExecution.applyCronTaskTerminalProjection(future, {
    status: "completed",
  });
  assert.equal(future.enabled, true);
  assert.equal(future.completedAt, undefined);
});

test("self-improve cron terminal history is durable and idempotent", async () => {
  await withAgentDir(async (agentDir) => {
    const ownerTask = selfImproveTask({
      runCount: 4,
      trigger: { expression: "0 3 * * *" },
    });
    await cronExecution.projectCronTaskTerminal(
      ownerTask,
      {
        status: "completed",
        text: "x".repeat(900),
        sessionFile: "/sessions/self-improve.jsonl",
      },
      { agentDir, startedAt: "2026-07-17T04:00:00.000Z" },
    );
    await cronExecution.appendCronTaskTerminalHistory(
      ownerTask,
      { status: "completed", text: "duplicate" },
      { agentDir, startedAt: "2026-07-17T04:00:00.000Z" },
    );
    const historyPath = path.join(
      agentDir,
      "self_improve",
      "state",
      "maintenance-history.jsonl",
    );
    const rows = (await fs.readFile(historyPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, `${ownerTask.id}:4`);
    assert.equal(rows[0].kind, "self_improve_review");
    assert.equal(rows[0].status, "completed");
    assert.match(rows[0].outputPreview, /…$/);

    await cronExecution.appendCronTaskTerminalHistory(
      task({
        id: "custom_self_improve",
        target: {
          kind: "agent_prompt",
          prompt: "Read self-improve-distillation.md",
        },
      }),
      { status: "failed", error: "review failed" },
      { agentDir },
    );
    const updated = (await fs.readFile(historyPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(updated.length, 2);
    assert.equal(updated[1].status, "failed");
    assert.equal(updated[1].error, "review failed");

    await fs.writeFile(
      historyPath,
      updated.map((row) => JSON.stringify(row)).join("\n"),
      "utf8",
    );
    await cronExecution.appendCronTaskTerminalHistory(
      selfImproveTask({
        runCount: 8,
      }),
      { status: "completed", text: "valid tail recovery" },
      { agentDir, startedAt: "2026-07-28T20:00:00.000Z" },
    );
    await fs.appendFile(historyPath, "{malformed-tail", "utf8");
    await cronExecution.appendCronTaskTerminalHistory(
      selfImproveTask({
        runCount: 9,
      }),
      { status: "completed", text: "invalid tail recovery" },
      { agentDir, startedAt: "2026-07-28T21:00:00.000Z" },
    );
    const recoveredRows = (await fs.readFile(historyPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(recoveredRows.length, 4);
    await fs.writeFile(historyPath, "{malformed-record\n", "utf8");
    await cronExecution.appendCronTaskTerminalHistory(
      selfImproveTask({
        runCount: 10,
      }),
      { status: "completed", text: "recover malformed history tail" },
      { agentDir, startedAt: "2026-07-28T22:00:00.000Z" },
    );
  });
});

test("executeCronShellTask owns shell delivery and failure terminals", async () => {
  await withAgentDir(async (agentDir) => {
    const working: any[] = [];
    const sent: any[] = [];
    const shell = task({
      trigger: { expression: "* * * * *" },
      frontend: { kind: "chat", key: "discord/1:2" },
      target: { kind: "shell_command", command: "printf shell-owner" },
    });
    await cronExecution.executeCronShellTask(shell, {
      agentDir,
      chat: {
        setWorkingVisible: async (payload) => working.push(payload),
        send: async (payload) => sent.push(payload),
      },
    });
    assert.match(shell.lastResultText, /stdout:\nshell-owner/);
    assert.deepEqual(working, [
      { chatKey: "discord/1:2", visible: true },
      { chatKey: "discord/1:2", visible: false },
    ]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatKey, "discord/1:2");

    const controllerShell = task({
      trigger: { expression: "* * * * *" },
      frontend: { kind: "tui", key: "terminal" },
      target: { kind: "shell_command", command: "exit 9" },
    });
    await cronExecution.executeCronShellTask(controllerShell, {
      agentDir,
      chat: {
        setWorkingVisible: async (payload) => working.push(payload),
      },
    });
    assert.match(controllerShell.lastError, /Exit: 9/);
    assert.deepEqual(working.slice(2), [
      { controllerKey: "tui", visible: true },
      { controllerKey: "tui", visible: false },
    ]);
  });
});
