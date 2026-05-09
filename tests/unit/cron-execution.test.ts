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
      trigger: { intervalMs: 60_000 },
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
      trigger: { intervalMs: 60_000 },
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

test("cron scheduler canonicalizes dedicated session files on load", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const tasksFile = path.join(agentDir, "data", "cron", "tasks.json");
  await fs.mkdir(path.dirname(tasksFile), { recursive: true });
  await fs.writeFile(
    tasksFile,
    JSON.stringify(
      [
        {
          id: "cron_stale_dedicated",
          createdAt: "2026-04-17T00:00:00.000Z",
          updatedAt: "2026-04-17T00:00:00.000Z",
          enabled: true,
          trigger: { intervalMs: 60_000 },
          session: { mode: "dedicated" },
          target: { kind: "agent_prompt", prompt: "hello" },
          dedicatedSessionFile: "/tmp/stale-dedicated.jsonl",
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
    const task = scheduler.getTask("cron_stale_dedicated");
    assert.ok(task);
    assert.equal(task.dedicatedSessionPersistent, true);
    assert.equal(
      task.dedicatedSessionFile,
      path.join(
        agentDir,
        "sessions",
        "managed",
        "task",
        "cron_stale_dedicated.jsonl",
      ),
    );
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
    chatKey: "telegram/demo:1",
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
        deliveryEnabled: item.deliveryEnabled,
        affectChatBinding: item.affectChatBinding,
        disposeAfterTurn: item.disposeAfterTurn,
        text: item.text,
        sessionFile: item.sessionFile,
      })),
      [
        {
          chatKey: "telegram/demo:1",
          controllerKey: "cron_dedicated",
          deliveryEnabled: false,
          affectChatBinding: false,
          disposeAfterTurn: false,
          text: "hello",
          sessionFile: dedicatedSessionFile,
        },
        {
          chatKey: "telegram/demo:1",
          controllerKey: "cron_dedicated",
          deliveryEnabled: false,
          affectChatBinding: false,
          disposeAfterTurn: false,
          text: "hello again",
          sessionFile: dedicatedSessionFile,
        },
      ],
    );
    assert.equal(calls[0].promptMeta?.taskId, "cron_dedicated");
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
    chatKey: "telegram/demo:1",
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
        deliveryEnabled: calls[0].deliveryEnabled,
        affectChatBinding: calls[0].affectChatBinding,
        disposeAfterTurn: calls[0].disposeAfterTurn,
        text: calls[0].text,
        sessionFile: calls[0].sessionFile,
      },
      {
        chatKey: "telegram/demo:1",
        controllerKey: "cron_seeded",
        deliveryEnabled: false,
        affectChatBinding: false,
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
    assert.equal("taskSessionMode" in (calls[0].promptMeta || {}), false);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron unbound no-session agent task disposes and removes its transient session file", async () => {
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
    await assert.rejects(fs.stat(transientSessionFile), /ENOENT/);
    assert.equal(task.dedicatedSessionFile, undefined);
    assert.deepEqual(calls, [
      {
        chatKey: undefined,
        controllerKey: "cron_none",
        deliveryEnabled: false,
        affectChatBinding: false,
        disposeAfterTurn: true,
        text: "hello",
        sessionFile: undefined,
        managedSessionLeaf: "task",
        model: "openai-codex/gpt-5.5",
        thinkingLevel: "low",
      },
    ]);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
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
    chatKey: "telegram/demo:1",
    session: { mode: "none" },
    target: { kind: "agent_prompt", prompt: "hello" },
    trigger: { intervalMs: 60_000 },
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
    assert.equal(calls[0].promptMeta?.taskId, "cron_chat_bound");
    assert.equal(calls[0].promptMeta?.taskName, "Chat Bound Task");
    assert.equal("triggerKind" in (calls[0].promptMeta || {}), false);
    assert.equal("taskRunId" in (calls[0].promptMeta || {}), false);
    assert.equal("taskSessionMode" in (calls[0].promptMeta || {}), false);
    assert.equal(calls[0].systemPromptBlocks, undefined);
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
    chatKey: "telegram/demo:1",
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

test("cron chat-bound agent task delivery records session binding", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const sessionFile = path.join(
    agentDir,
    "sessions",
    "managed",
    "task",
    "cron_delivery.jsonl",
  );
  const sent = [];
  const task = {
    id: "cron_delivery",
    chatKey: "telegram/demo:1",
    session: { mode: "none" },
    trigger: { runAt: new Date(Date.now() - 1000).toISOString() },
    target: { kind: "agent_prompt", prompt: "hello" },
    runCount: 1,
  };
  try {
    await execMod.executeCronTask(task, {
      agentDir,
      chat: {
        runTurn: async () => ({ finalText: "done", sessionFile }),
        send: async (payload) => {
          sent.push(payload);
        },
      },
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].sessionFile, sessionFile);
    assert.equal(sent[0].sessionBinding, "conversation");
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("built-in self-improve cron task writes maintenance history", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const task = {
    id: "builtin_self_improve_sleep_consolidation_daily",
    session: { mode: "none" },
    trigger: { expression: "43 3 * * *", timezone: "local" },
    target: {
      kind: "agent_prompt",
      prompt:
        "Follow the manual at /tmp/rin/docs/rin/docs/self-improve-memory-maintenance.md to optimize memory.",
    },
    runCount: 4,
    lastStartedAt: "2026-05-08T09:33:09.353Z",
  };
  try {
    await execMod.executeCronTask(task, {
      agentDir,
      chat: {
        runTurn: async () => ({ finalText: "maintenance done" }),
      },
    });
    const historyPath = path.join(
      agentDir,
      "self_improve",
      "state",
      "maintenance-history.jsonl",
    );
    const rows = (await fs.readFile(historyPath, "utf8"))
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
    assert.equal(rows[0].outputPreview, "maintenance done");
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
      trigger: { intervalMs: 60_000 },
      session: { mode: "dedicated" },
      target: { kind: "agent_prompt", prompt: "hello" },
    });
    scheduler.upsertTask({
      id: "cron_unbound_stop_me",
      trigger: { intervalMs: 60_000 },
      session: { mode: "none" },
      target: { kind: "agent_prompt", prompt: "hello" },
    });
    scheduler.upsertTask({
      id: "cron_none_complete_me",
      trigger: { intervalMs: 60_000 },
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

test("cron scheduler installs built-in daily memory maintenance tasks", async () => {
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
    assert.equal(builtIn.trigger.expression, "17 4 * * *");
    assert.equal(builtIn.target.kind, "shell_command");
    assert.match(builtIn.target.command, /memory-index repair/);

    const sleep = scheduler.getTask(
      "builtin_self_improve_sleep_consolidation_daily",
      { includeBuiltIn: true },
    );
    assert.ok(sleep);
    assert.equal(sleep.builtIn, true);
    assert.equal(sleep.trigger.expression, "43 3 * * *");
    assert.equal(sleep.session.mode, "none");
    assert.equal(sleep.target.kind, "agent_prompt");
    assert.equal(
      sleep.target.prompt,
      `Follow the maintenance requirements in ${path.join(agentDir, "docs", "rin", "docs", "self-improve-memory-maintenance.md")} to improve the entire self-improve memory library under ${path.join(agentDir, "self_improve")}: prompt baselines, reusable skills, memory-index skills, and short-term memory skills. Inventory all skill directories before selecting edits, prioritize duplicated or over-split ordinary skill clusters over isolated wording fixes, then optimize, consolidate, correct, merge, move, delete, and prune every discovered class of improvement across the library in one cohesive pass. Report the inventory scope and high-impact clusters considered.`,
    );
    assert.doesNotMatch(sleep.target.prompt, /conversation above/);
    assert.match(
      sleep.target.prompt,
      /improve the entire self-improve memory library/,
    );
    assert.match(sleep.target.prompt, /prompt baselines/);
    assert.match(sleep.target.prompt, /reusable skills/);
    assert.match(sleep.target.prompt, /memory-index skills/);
    assert.match(sleep.target.prompt, /short-term memory skills/);
    assert.match(sleep.target.prompt, /merge, move, delete, and prune/);
    assert.match(
      sleep.target.prompt,
      /Inventory all skill directories before selecting edits/,
    );
    assert.match(
      sleep.target.prompt,
      /prioritize duplicated or over-split ordinary skill clusters/,
    );
    assert.match(
      sleep.target.prompt,
      /every discovered class of improvement across the library/,
    );
    assert.match(
      sleep.target.prompt,
      /Report the inventory scope and high-impact clusters considered/,
    );
    assert.doesNotMatch(
      sleep.target.prompt,
      /all reachable improvement points/,
    );
    assert.doesNotMatch(sleep.target.prompt, /read-only guidance/);
    assert.doesNotMatch(sleep.target.prompt, /## Basic concepts/);
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
          trigger: { expression: "0 0 * * *" },
          session: { mode: "dedicated" },
          target: { kind: "shell_command", command: "echo nope" },
        }),
      /cron_builtin_task_protected:builtin_memory_index_repair_daily/,
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

test("cron scheduler can manually run an existing built-in task", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const scheduler = new cronMod.CronScheduler({ agentDir });
  try {
    scheduler.start();
    const taskId = "builtin_memory_index_repair_daily";
    const started = scheduler.runTaskNow(taskId);
    assert.equal(started.id, taskId);
    assert.equal(started.runCount, 1);
    assert.equal(started.running, true);
    assert.ok(started.lastStartedAt);

    for (let i = 0; i < 50; i += 1) {
      if (!scheduler.getTask(taskId, { includeBuiltIn: true })?.running) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const finished = scheduler.getTask(taskId, { includeBuiltIn: true });
    assert.equal(finished?.runCount, 1);
    assert.equal(finished?.running, false);
    assert.ok(finished?.lastFinishedAt);
    assert.match(String(finished?.lastError || ""), /Command:/);
    assert.throws(
      () => scheduler.pauseTask(taskId),
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
      trigger: { intervalMs: 60_000 },
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
