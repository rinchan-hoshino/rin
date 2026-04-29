import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
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

test("cron execution resolves session file preference", async () => {
  assert.equal(
    await execMod.resolveCronSessionFile({
      session: { mode: "current", sessionFile: "/tmp/a" },
    }),
    "/tmp/a",
  );
  assert.equal(
    await execMod.resolveCronSessionFile({
      session: { mode: "dedicated" },
      dedicatedSessionFile: "/tmp/b",
    }),
    "/tmp/b",
  );
  assert.equal(
    await execMod.resolveCronSessionFile({
      session: { mode: "ephemeral" },
    }),
    undefined,
  );
});

test("cron scheduler rejects removed specific session mode", () => {
  const scheduler = new cronMod.CronScheduler({
    agentDir: "/tmp/rin-agent",
    cwd: process.cwd(),
  });
  assert.throws(
    () =>
      scheduler.upsertTask({
        trigger: { kind: "once", runAt: "2026-04-10T00:00:00.000Z" },
        session: { mode: "specific", sessionFile: "/tmp/a" },
        target: { kind: "agent_prompt", prompt: "hello" },
      }),
    /cron_invalid_session_mode:specific/,
  );
});

test("cron scheduler can seed and preserve dedicated session files", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const scheduler = new cronMod.CronScheduler({ agentDir });
  try {
    const seeded = scheduler.upsertTask({
      id: "cron_seeded_dedicated",
      trigger: { kind: "interval", intervalMs: 60_000 },
      session: { mode: "dedicated", sessionFile: "/tmp/seeded-session.jsonl" },
      target: { kind: "agent_prompt", prompt: "hello" },
    });
    assert.equal(
      seeded.dedicatedSessionFile,
      path.resolve("/tmp/seeded-session.jsonl"),
    );
    assert.equal(seeded.dedicatedSessionPersistent, true);
    assert.equal(seeded.session.sessionFile, undefined);

    const updated = scheduler.upsertTask({
      id: "cron_seeded_dedicated",
      trigger: { kind: "interval", intervalMs: 60_000 },
      session: { mode: "dedicated" },
      target: { kind: "agent_prompt", prompt: "hello again" },
    });
    assert.equal(
      updated.dedicatedSessionFile,
      path.resolve("/tmp/seeded-session.jsonl"),
    );
    assert.equal(updated.dedicatedSessionPersistent, true);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler preallocates managed dedicated task session files", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const scheduler = new cronMod.CronScheduler({ agentDir });
  try {
    const task = scheduler.upsertTask({
      id: "cron_managed_dedicated",
      trigger: { kind: "interval", intervalMs: 60_000 },
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

test("cron scheduler preserves dedicated session files on load", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const tasksFile = path.join(agentDir, "data", "cron", "tasks.json");
  await fs.mkdir(path.dirname(tasksFile), { recursive: true });
  await fs.writeFile(
    tasksFile,
    JSON.stringify(
      [
        {
          id: "cron_legacy_dedicated",
          createdAt: "2026-04-17T00:00:00.000Z",
          updatedAt: "2026-04-17T00:00:00.000Z",
          enabled: true,
          trigger: { kind: "interval", intervalMs: 60_000 },
          session: { mode: "dedicated" },
          target: { kind: "agent_prompt", prompt: "hello" },
          dedicatedSessionFile: "/tmp/legacy-dedicated.jsonl",
          runCount: 0,
          running: false,
        },
      ],
      null,
      2,
    ),
  );
  const scheduler = new cronMod.CronScheduler({ agentDir });
  try {
    scheduler.start();
    const task = scheduler.getTask("cron_legacy_dedicated");
    assert.ok(task);
    assert.equal(task.dedicatedSessionPersistent, true);
    assert.equal(task.dedicatedSessionFile, "/tmp/legacy-dedicated.jsonl");
  } finally {
    scheduler.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron dedicated agent task creates and then preserves its bound session", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const firstSessionFile = path.join(agentDir, "dedicated-session.jsonl");
  const secondSessionFile = path.join(agentDir, "dedicated-session-next.jsonl");
  const task = {
    id: "cron_dedicated",
    chatKey: "telegram/demo:1",
    session: { mode: "dedicated" },
    target: { kind: "agent_prompt", prompt: "hello" },
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
    assert.equal(task.dedicatedSessionFile, firstSessionFile);
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
    assert.equal(second.sessionFile, secondSessionFile);
    assert.equal(task.dedicatedSessionFile, secondSessionFile);
    assert.deepEqual(calls, [
      {
        chatKey: "telegram/demo:1",
        controllerKey: "cron_dedicated",
        deliveryEnabled: false,
        affectChatBinding: false,
        disposeAfterTurn: false,
        text: "hello",
        sessionFile: undefined,
      },
      {
        chatKey: "telegram/demo:1",
        controllerKey: "cron_dedicated",
        deliveryEnabled: false,
        affectChatBinding: false,
        disposeAfterTurn: false,
        text: "hello",
        sessionFile: firstSessionFile,
      },
    ]);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron seeded dedicated agent task preserves its bound session", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const task = {
    id: "cron_seeded",
    chatKey: "telegram/demo:1",
    session: { mode: "dedicated" },
    dedicatedSessionFile: "/tmp/seeded-session.jsonl",
    dedicatedSessionPersistent: true,
    target: { kind: "agent_prompt", prompt: "hello" },
  };
  const calls = [];
  try {
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
    assert.equal(task.dedicatedSessionFile, "/tmp/seeded-session-next.jsonl");
    assert.deepEqual(calls, [
      {
        chatKey: "telegram/demo:1",
        controllerKey: "cron_seeded",
        deliveryEnabled: false,
        affectChatBinding: false,
        disposeAfterTurn: false,
        text: "hello",
        sessionFile: "/tmp/seeded-session.jsonl",
      },
    ]);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron ephemeral agent task disposes and removes its transient session file", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const transientSessionFile = path.join(
    agentDir,
    "sessions",
    "managed",
    "task",
    "cron_ephemeral.jsonl",
  );
  const task = {
    id: "cron_ephemeral",
    chatKey: "telegram/demo:1",
    session: { mode: "ephemeral" },
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
    await assert.rejects(fs.stat(transientSessionFile), /ENOENT/);
    assert.equal(task.dedicatedSessionFile, undefined);
    assert.deepEqual(calls, [
      {
        chatKey: "telegram/demo:1",
        controllerKey: "cron_ephemeral",
        deliveryEnabled: false,
        affectChatBinding: false,
        disposeAfterTurn: true,
        text: "hello",
        sessionFile: undefined,
        model: "openai-codex/gpt-5.5",
        thinkingLevel: "low",
      },
    ]);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron agent task falls back to canonical turn result text", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const task = {
    id: "cron_result_fallback",
    chatKey: "telegram/demo:1",
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
    assert.equal(task.dedicatedSessionFile, "/tmp/cron-result-fallback.jsonl");
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron execution shell task returns summarized success body", async () => {
  const text = await execMod.executeCronShellTask(
    {
      target: { kind: "shell_command", command: "printf hello" },
      cwd: process.cwd(),
    },
    { agentDir: process.cwd() },
  );
  assert.ok(text.includes("Command: printf hello"));
  assert.ok(text.includes("stdout:"));
});

test("cron scheduler installs the built-in daily memory index repair task", async () => {
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
    const builtIn = scheduler.getTask("builtin_memory_index_repair_daily", {
      includeBuiltIn: true,
    });
    assert.ok(builtIn);
    assert.equal(builtIn.builtIn, true);
    assert.equal(builtIn.trigger.kind, "cron");
    assert.equal(builtIn.trigger.expression, "17 4 * * *");
    assert.equal(builtIn.target.kind, "shell_command");
    assert.match(builtIn.target.command, /memory-index repair/);
  } finally {
    scheduler.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler persists built-in task state across restarts while hiding it publicly", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const tasksFile = path.join(agentDir, "data", "cron", "tasks.json");
  const builtInId = "builtin_memory_index_repair_daily";
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
    assert.throws(
      () => scheduler.pauseTask("builtin_memory_index_repair_daily"),
      /cron_builtin_task_protected:builtin_memory_index_repair_daily/,
    );
    assert.throws(
      () => scheduler.deleteTask("builtin_memory_index_repair_daily"),
      /cron_builtin_task_protected:builtin_memory_index_repair_daily/,
    );
    assert.throws(
      () =>
        scheduler.upsertTask({
          id: "builtin_memory_index_repair_daily",
          trigger: { kind: "cron", expression: "0 0 * * *" },
          session: { mode: "dedicated" },
          target: { kind: "shell_command", command: "echo nope" },
        }),
      /cron_builtin_task_protected:builtin_memory_index_repair_daily/,
    );
  } finally {
    scheduler.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler derives running from live execution without persisting it", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const tasksFile = path.join(agentDir, "data", "cron", "tasks.json");
  const scheduler = new cronMod.CronScheduler({ agentDir });
  try {
    scheduler.start();
    scheduler.upsertTask({
      id: "cron_running_state",
      trigger: { kind: "interval", intervalMs: 60_000 },
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
