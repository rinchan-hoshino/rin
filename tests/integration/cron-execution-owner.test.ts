import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const cronExecution = await importBuiltModule<
  typeof import("../../src/core/rin-daemon/cron-execution.js")
>("dist/core/rin-daemon/cron-execution.js");

function task(overrides: Record<string, any> = {}) {
  return {
    id: "cron_owner",
    name: "Owner task",
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    enabled: true,
    trigger: { runAt: "2099-07-17T00:00:00.000Z" },
    session: { mode: "none" },
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

test("cron session resolution accepts only valid owned session modes", async () => {
  await withAgentDir(async (agentDir) => {
    const sessionFile = path.join(agentDir, "sessions", "owner.jsonl");
    const dedicated = task({
      session: { mode: "dedicated" },
      dedicatedSessionFile: sessionFile,
    });
    assert.equal(
      await cronExecution.resolveCronSessionFile(dedicated),
      undefined,
    );
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, "{}\n");
    assert.equal(
      await cronExecution.resolveCronSessionFile(dedicated),
      sessionFile,
    );
    assert.equal(await cronExecution.resolveCronSessionFile(task()), undefined);
    await assert.rejects(
      cronExecution.resolveCronSessionFile(task({ session: { mode: "bad" } })),
      /cron_invalid_session_mode:bad/,
    );
  });
});

test("cron shell execution reports command output and failures", async () => {
  await withAgentDir(async (agentDir) => {
    const success = await cronExecution.executeCronShellTask(
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
      cronExecution.executeCronShellTask(
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
      cronExecution.executeCronShellTask(task(), { agentDir }),
      /cron_invalid_shell_task/,
    );

    await fs.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ shellPath: "/missing/owner-shell" }),
    );
    await assert.rejects(
      cronExecution.executeCronShellTask(
        task({ target: { kind: "shell_command", command: "true" } }),
        { agentDir },
      ),
      /Custom shell path not found/,
    );

    await fs.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ shellPath: "/bin/sh" }),
    );
    const custom = await cronExecution.executeCronShellTask(
      task({ target: { kind: "shell_command", command: "printf custom" } }),
      { agentDir },
    );
    assert.match(custom, /stdout:\ncustom/);
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
      frontend: { kind: "tui", key: "terminal" },
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

test("agent tasks preserve owner prompt, frontend, model, and transient session semantics", async () => {
  await withAgentDir(async (agentDir) => {
    const calls: any[] = [];
    const ownerTask = task({
      frontend: { kind: "chat", key: "discord/1:2" },
      deliverFinal: false,
      quiet: false,
      model: { provider: "demo", id: "owner-model" },
      thinkingLevel: "high",
      disabledRinCapabilities: ["memory"],
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
    assert.equal(calls[0].controllerKey, "cron_owner");
    assert.equal(calls[0].chatKey, "discord/1:2");
    assert.equal(calls[0].affectChatBinding, true);
    assert.equal(calls[0].deliverFinal, false);
    assert.equal(calls[0].quietMode, false);
    assert.equal(calls[0].disposeAfterTurn, true);
    assert.equal(calls[0].shutdownAfterTurn, true);
    assert.equal(calls[0].text, "run owner task");
    assert.equal(calls[0].requestTag, "scheduled:owner");
    assert.equal(calls[0].deliveryIdempotencyKey, "delivery-owner");
    assert.deepEqual(calls[0].model, { provider: "demo", id: "owner-model" });
    assert.equal(calls[0].thinkingLevel, "high");
    assert.deepEqual(calls[0].disabledRinCapabilities, ["memory"]);
    assert.equal(calls[0].managedSessionLeaf, "task");
    assert.deepEqual(calls[0].frontend, {
      kind: "chat",
      key: "discord/1:2",
    });

    const detached = await cronExecution.executeCronAgentTask(
      task({ name: undefined, frontend: undefined }),
      {
        agentDir,
        continuing: false,
        chat: {
          runTurn: async (payload) => {
            calls.push(payload);
            return { finalText: "detached", sessionFile: "/temporary.jsonl" };
          },
        },
      },
    );
    assert.equal(detached.text, "detached");
    assert.equal(detached.sessionFile, undefined);
    assert.equal(calls[1].affectChatBinding, false);
    assert.deepEqual(calls[1].frontend, {
      kind: "scheduled-task",
      key: "cron_owner",
    });
  });
});

test("dedicated agent tasks select initial and continuation prompts", async () => {
  await withAgentDir(async (agentDir) => {
    const sessionFile = path.join(agentDir, "sessions", "dedicated.jsonl");
    const prompts: any[] = [];
    const dedicated = task({
      runCount: 1,
      session: { mode: "dedicated" },
      dedicatedSessionFile: sessionFile,
      target: {
        kind: "agent_prompt",
        prompt: "initial",
        continuationPrompt: "continue",
      },
    });
    const first = await cronExecution.executeCronAgentTask(dedicated, {
      agentDir,
      chat: {
        runTurn: async (payload) => {
          prompts.push(payload);
          return { finalText: "first", sessionFile: "/ignored.jsonl" };
        },
      },
    });
    assert.equal(first.sessionFile, sessionFile);
    assert.equal(prompts[0].text, "initial");
    assert.equal(prompts[0].createSessionFileIfMissing, true);
    assert.equal(dedicated.dedicatedSessionPersistent, true);

    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, "{}\n");
    dedicated.runCount = 2;
    const next = await cronExecution.executeCronAgentTask(dedicated, {
      agentDir,
      chat: {
        runTurn: async (payload) => {
          prompts.push(payload);
          return { finalText: "next", sessionId: "dedicated" };
        },
      },
    });
    assert.equal(next.text, "next");
    assert.equal(next.sessionFile, sessionFile);
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
    await assert.rejects(
      cronExecution.executeCronAgentTask(task(), {
        agentDir,
        chat: { runTurn: async () => ({ messages: [] }) },
      }),
      /cron_final_assistant_text_missing/,
    );
  });
});

test("session-continue tasks resolve stored sessions and return final owner output", async () => {
  await withAgentDir(async (agentDir) => {
    const sessionFile = path.join(
      agentDir,
      "sessions",
      "managed",
      "owner.jsonl",
    );
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, "{}\n");
    const continued = task({
      lastStartedAt: "2026-07-17T01:00:00.000Z",
      session: { mode: "session_continue", sessionFile },
      target: { kind: "session_continue" },
    });
    const calls: any[] = [];
    const result = await cronExecution.executeCronSessionContinueTask(
      continued,
      {
        agentDir,
        runId: "scheduled:continue",
        resumeSessionTurn: async (payload) => {
          calls.push(payload);
          return {
            finalText: "continued",
            sessionId: "session-id",
            sessionFile,
          };
        },
      },
    );
    assert.deepEqual(result, {
      text: "continued",
      sessionId: "session-id",
      sessionFile,
    });
    assert.deepEqual(calls, [
      {
        sessionFile,
        source: "scheduled-task",
        requestTag: "scheduled:continue",
      },
    ]);

    await assert.rejects(
      cronExecution.executeCronSessionContinueTask(task(), { agentDir }),
      /cron_invalid_session_continue_task/,
    );
    await assert.rejects(
      cronExecution.executeCronSessionContinueTask(
        task({
          session: { mode: "session_continue", sessionFile },
          target: { kind: "agent_prompt", prompt: "wrong" },
        }),
        { agentDir },
      ),
      /cron_session_continue_requires_target/,
    );
    await assert.rejects(
      cronExecution.executeCronSessionContinueTask(continued, { agentDir }),
      /cron_session_continue_unavailable/,
    );
    await assert.rejects(
      cronExecution.executeCronSessionContinueTask(
        task({
          session: { mode: "session_continue", sessionFile: "missing.jsonl" },
          target: { kind: "session_continue" },
        }),
        { agentDir, resumeSessionTurn: async () => ({}) },
      ),
      /cron_session_file_not_found/,
    );
    await assert.rejects(
      cronExecution.executeCronSessionContinueTask(continued, {
        agentDir,
        resumeSessionTurn: async () => ({ finalText: "" }),
      }),
      /cron_final_assistant_text_missing/,
    );
  });
});

test("durable cron invocations snapshot owner execution inputs", async () => {
  await withAgentDir(async (agentDir) => {
    const none = task({
      lastStartedAt: "2026-07-17T02:00:00.000Z",
      nextRunAt: "2026-07-18T02:00:00.000Z",
      frontend: { kind: "chat", key: "discord/1:2" },
      disabledRinCapabilities: ["browse"],
    });
    const invocation = cronExecution.createCronSessionInvocation(
      none,
      agentDir,
    );
    assert.match(invocation.id, /^cron_owner:/);
    assert.equal(invocation.requestTag, `scheduled:${invocation.id}`);
    assert.equal(invocation.taskId, "cron_owner");
    assert.equal(invocation.runCount, 1);
    assert.equal(invocation.scheduledNextRunAt, "2026-07-18T02:00:00.000Z");
    assert.match(invocation.sessionFile, /sessions\/managed\/task\//);
    assert.equal(invocation.continuing, false);
    assert.notEqual(invocation.session, none.session);
    assert.notEqual(invocation.target, none.target);
    assert.notEqual(
      invocation.disabledRinCapabilities,
      none.disabledRinCapabilities,
    );

    const dedicated = cronExecution.createCronSessionInvocation(
      task({
        runCount: 2,
        session: { mode: "dedicated" },
        target: {
          kind: "agent_prompt",
          prompt: "initial",
          continuationPrompt: "next",
        },
      }),
      agentDir,
    );
    assert.equal(dedicated.continuing, true);
    assert.match(
      dedicated.sessionFile,
      /sessions\/managed\/task\/cron_owner\.jsonl$/,
    );

    const sessionFile = path.join(agentDir, "sessions", "owner.jsonl");
    const continued = cronExecution.createCronSessionInvocation(
      task({
        session: { mode: "session_continue", sessionFile },
        target: { kind: "session_continue" },
      }),
      agentDir,
    );
    assert.equal(continued.sessionFile, sessionFile);

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

    const sessionFile = path.join(agentDir, "sessions", "owner.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, "{}\n");
    const continueInvocation = cronExecution.createCronSessionInvocation(
      task({
        session: { mode: "session_continue", sessionFile },
        target: { kind: "session_continue" },
      }),
      agentDir,
    );
    const continued = await cronExecution.executeCronSessionInvocation(
      continueInvocation,
      {
        agentDir,
        resumeSessionTurn: async (payload) => ({
          finalText: payload.requestTag,
          sessionFile,
        }),
      },
    );
    assert.equal(continued.text, continueInvocation.requestTag);
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
    const ownerTask = task({
      id: "builtin_self_improve_sleep_consolidation_daily",
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
      { agentDir },
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
  });
});

test("executeCronTask owns shell, agent, session, delivery, and failure terminals", async () => {
  await withAgentDir(async (agentDir) => {
    const working: any[] = [];
    const sent: any[] = [];
    const shell = task({
      trigger: { expression: "* * * * *" },
      frontend: { kind: "chat", key: "discord/1:2" },
      target: { kind: "shell_command", command: "printf shell-owner" },
    });
    await cronExecution.executeCronTask(shell, {
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
    await cronExecution.executeCronTask(controllerShell, {
      agentDir,
      chat: {
        setWorkingVisible: async (payload) => working.push(payload),
      },
    });
    assert.match(controllerShell.lastError, /Exit: 9/);
    assert.deepEqual(working.slice(-2), [
      { controllerKey: "terminal", visible: true },
      { controllerKey: "terminal", visible: false },
    ]);

    const agent = task({ trigger: { expression: "* * * * *" } });
    await cronExecution.executeCronTask(agent, {
      agentDir,
      chat: { runTurn: async () => ({ finalText: "agent owner" }) },
    });
    assert.equal(agent.lastResultText, "agent owner");

    const sessionFile = path.join(agentDir, "sessions", "continued.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, "{}\n");
    const continued = task({
      trigger: { expression: "* * * * *" },
      session: { mode: "session_continue", sessionFile },
      target: { kind: "session_continue" },
    });
    await cronExecution.executeCronTask(continued, {
      agentDir,
      resumeSessionTurn: async () => ({
        finalText: "continued owner",
        sessionFile,
      }),
    });
    assert.equal(continued.lastResultText, "continued owner");
  });
});
