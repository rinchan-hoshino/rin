import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const rawCronExecution = await importBuiltModule<
  typeof import("../../src/core/rin-daemon/cron-execution.js")
>("dist/core/rin-daemon/cron-execution.js");
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
            incomingMessageId: "scheduled-owner-input",
            replyToMessageId: "scheduled-owner-input",
          }),
      }
    : chat;
}
const cronExecution = {
  ...rawCronExecution,
  executeCronAgentTask: (ownerTask: any, options: any) =>
    rawCronExecution.executeCronAgentTask(ownerTask, {
      ...options,
      runId: options?.runId || `test-run:${ownerTask.id}`,
      chat: withScheduledInputDelivery(options?.chat),
    }),
  executeCronSessionInvocation: (invocation: any, options: any) =>
    rawCronExecution.executeCronSessionInvocation(invocation, {
      ...options,
      chat: withScheduledInputDelivery(options?.chat),
    }),
};
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
  const firstDelivery = await cronExecution.sendChatText(
    {
      chat: {
        send: async (payload) => {
          sent.push(payload);
          return { delivered: true, messageIds: ["scheduled-marker"] };
        },
      },
    },
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
      replyToMessageId: "scheduled-marker",
    },
  );

  assert.deepEqual(firstDelivery, {
    delivered: true,
    messageIds: ["scheduled-marker"],
  });
  assert.match(sent[0].createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(sent[0].parts, [{ type: "text", text: "done" }]);
  assert.equal(sent[0].sessionBinding, "conversation");
  assert.equal(sent[0].sessionFile, "/sessions/owner.jsonl");
  assert.equal(sent[1].sessionFile, undefined);
  assert.equal(sent[1].sessionBinding, undefined);
  assert.deepEqual(sent[1].parts, [
    { type: "quote", id: "scheduled-marker" },
    { type: "text", text: "plain" },
  ]);
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
      frontend: { kind: "tui", key: "terminal" },
      taskId: "cron_owner",
      taskName: undefined,
    },
  );
  assert.equal(
    cronExecution.buildCronTaskPromptContext(task({ frontend: undefined }), 789)
      .frontend,
    undefined,
  );
});

test("agent tasks deliver visible input before deferring progress to the current frontend", async () => {
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
      sessionId: "session-owner",
      sessionFile: "/sessions/chat-owner.jsonl",
    });
    assert.equal(calls[0].controllerKey, "default");
    assert.equal(calls[0].chatKey, "discord/1:2");
    assert.equal("affectChatBinding" in calls[0], false);
    assert.equal(calls[0].deliverFinal, true);
    assert.equal(calls[0].quietMode, false);
    assert.equal(calls[0].replyToMessageId, "scheduled-owner-input");
    assert.equal(calls[0].text, "run owner task");
    assert.equal(calls[0].requestTag, undefined);
    assert.equal(
      calls[0].deliveryIdempotencyKey,
      "scheduled-input:scheduled:owner",
    );
    assert.equal("sessionFile" in calls[0], false);
    assert.equal("managedSessionLeaf" in calls[0], false);
    assert.equal("model" in calls[0], false);
    assert.equal("thinkingLevel" in calls[0], false);
    assert.equal("disabledRinCapabilities" in calls[0], false);
    assert.equal(calls[0].frontend, undefined);
    assert.equal(calls[0].promptMeta, undefined);
    assert.equal(calls[0].taskId, "cron_owner");
    assert.equal(calls[0].taskName, "Owner task");
    assert.equal(calls[0].showInput, true);

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
    assert.equal(agentCalls[0].requestTag, undefined);
    assert.equal(
      agentCalls[0].deliveryIdempotencyKey,
      `scheduled-input:${agentInvocation.requestTag}`,
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

test("executeCronShellTask owns shell delivery and failure terminals", async () => {
  await withAgentDir(async (agentDir) => {
    const working: any[] = [];
    const sent: any[] = [];
    const sendOptions: any[] = [];
    const visibleOrder: string[] = [];
    const shell = task({
      trigger: { expression: "* * * * *" },
      frontend: { kind: "chat", key: "discord/1:2" },
      target: { kind: "shell_command", command: "printf shell-owner" },
    });
    await cronExecution.executeCronShellTask(shell, {
      agentDir,
      chat: {
        setWorkingVisible: async (payload) => {
          working.push(payload);
          visibleOrder.push(payload.visible ? "working-start" : "working-end");
        },
        send: async (payload, options) => {
          sent.push(payload);
          sendOptions.push(options);
          visibleOrder.push(sent.length === 1 ? "task-input" : "task-output");
          return {
            delivered: true,
            messageIds: [`shell-message-${sent.length}`],
          };
        },
      },
    });
    assert.match(shell.lastResultText, /stdout:\nshell-owner/);
    assert.deepEqual(working, [
      { chatKey: "discord/1:2", visible: true },
      { chatKey: "discord/1:2", visible: false },
    ]);
    assert.deepEqual(visibleOrder, [
      "task-input",
      "working-start",
      "task-output",
      "working-end",
    ]);
    assert.equal(sent.length, 2);
    assert.equal(sendOptions[0].waitForDeliveryMs, 30_000);
    assert.match(sendOptions[0].idempotencyKey, /^scheduled-input:/);
    assert.equal(sendOptions[1], undefined);
    assert.equal(sent[0].chatKey, "discord/1:2");
    assert.deepEqual(sent[0].parts, [
      {
        type: "text",
        text: "⏰ Scheduled task · Owner task\nprintf shell-owner",
      },
    ]);
    assert.deepEqual(sent[1].parts.slice(0, 1), [
      { type: "quote", id: "shell-message-1" },
    ]);
    assert.match(sent[1].parts[1].text, /stdout:\nshell-owner/);

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
      { controllerKey: "terminal", visible: true },
      { controllerKey: "terminal", visible: false },
    ]);
  });
});
