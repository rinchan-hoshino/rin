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
const messageStoreMod = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js"))
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
    assert.deepEqual(calls, [
      {
        chatKey: undefined,
        controllerKey: "cron_none",
        deliveryEnabled: false,
        affectChatBinding: false,
        disposeAfterTurn: true,
        shutdownAfterTurn: true,
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
    assert.equal(calls[0].promptMeta?.taskId, "cron_chat_bound");
    assert.equal(calls[0].shutdownAfterTurn, true);
    assert.equal(calls[0].promptMeta?.taskName, "Chat Bound Task");
    assert.equal("triggerKind" in (calls[0].promptMeta || {}), false);
    assert.equal("taskRunId" in (calls[0].promptMeta || {}), false);
    assert.equal("taskSessionMode" in (calls[0].promptMeta || {}), false);
    assert.equal(calls[0].systemPromptBlocks, undefined);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron current-session instruction derives chat binding from session file metadata", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const sessionFile = path.join(
    agentDir,
    "sessions",
    "managed",
    "chat",
    "current.jsonl",
  );
  const task = {
    id: "cron_current_session",
    name: "Current Session Follow-up",
    session: { mode: "session_instruction", sessionFile },
    model: "openai-codex/gpt-5.5",
    thinkingLevel: "low",
    target: {
      kind: "agent_prompt",
      prompt: "Ask for the review status.",
    },
  };
  const calls = [];
  try {
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, "session", "utf8");
    messageStoreMod.saveChatMessage(agentDir, {
      chatKey: "telegram/demo:1",
      platform: "telegram",
      botId: "1",
      chatId: "demo",
      chatType: "private",
      messageId: "m-bound",
      role: "assistant",
      receivedAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      text: "previous reply",
      sessionFile,
    });

    const result = await execMod.executeCronSessionInstructionTask(task, {
      agentDir,
      runId: "run-current-1",
      chat: {
        runTurn: async (payload) => {
          calls.push(payload);
          return {
            finalText: "asked",
            sessionId: "s-current",
            sessionFile,
          };
        },
      },
    });
    assert.equal(result.text, "asked");
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
        model: calls[0].model,
        thinkingLevel: calls[0].thinkingLevel,
      },
      {
        chatKey: "telegram/demo:1",
        controllerKey: undefined,
        deliveryEnabled: true,
        affectChatBinding: true,
        disposeAfterTurn: false,
        text: "Ask for the review status.",
        sessionFile,
        model: "openai-codex/gpt-5.5",
        thinkingLevel: "low",
      },
    );
    assert.equal(calls[0].promptMeta?.source, "scheduled-task");
    assert.equal(calls[0].promptMeta?.taskId, "cron_current_session");
    assert.equal(calls[0].promptMeta?.taskName, "Current Session Follow-up");
    assert.equal(calls[0].promptMeta?.scheduledTaskInitiator, "agent");
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron current-session instruction relies on bound delivery without duplicate send", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const sessionFile = path.join(
    agentDir,
    "sessions",
    "managed",
    "chat",
    "current.jsonl",
  );
  const calls = [];
  const sent = [];
  const task = {
    id: "cron_bound_instruction",
    session: { mode: "session_instruction", sessionFile },
    trigger: { runAt: new Date(Date.now() - 1000).toISOString() },
    target: {
      kind: "agent_prompt",
      prompt: "Continue in this session.",
    },
    runCount: 1,
  };
  try {
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, "session", "utf8");
    messageStoreMod.saveChatMessage(agentDir, {
      chatKey: "telegram/demo:1",
      platform: "telegram",
      botId: "1",
      chatId: "demo",
      chatType: "private",
      messageId: "m-bound",
      role: "assistant",
      receivedAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      text: "previous reply",
      sessionFile,
    });

    await execMod.executeCronTask(task, {
      agentDir,
      chat: {
        runTurn: async (payload) => {
          calls.push(payload);
          return {
            finalText: "done",
            sessionFile,
          };
        },
        send: async (payload) => {
          sent.push(payload);
        },
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].chatKey, "telegram/demo:1");
    assert.equal(calls[0].sessionFile, sessionFile);
    assert.equal(sent.length, 0);
    assert.equal(task.lastResultText, "done");
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler validates current-session instruction bindings", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const scheduler = new cronMod.CronScheduler({ agentDir });
  try {
    assert.throws(
      () =>
        scheduler.upsertTask({
          id: "cron_instruction_no_session",
          trigger: { runAt: "2099-01-01T00:00:00.000Z" },
          session: { mode: "session_instruction" },
          target: {
            kind: "agent_prompt",
            prompt: "Continue here.",
          },
        }),
      /cron_session_file_required/,
    );
    assert.throws(
      () =>
        scheduler.upsertTask({
          id: "cron_instruction_chat_key",
          chatKey: "telegram/demo:1",
          trigger: { runAt: "2099-01-01T00:00:00.000Z" },
          session: {
            mode: "session_instruction",
            sessionFile: "/tmp/session.jsonl",
          },
          target: {
            kind: "agent_prompt",
            prompt: "Continue here.",
          },
        }),
      /cron_session_instruction_chat_key_forbidden/,
    );
    assert.throws(
      () =>
        scheduler.upsertTask({
          id: "cron_instruction_shell",
          trigger: { runAt: "2099-01-01T00:00:00.000Z" },
          session: {
            mode: "session_instruction",
            sessionFile: "/tmp/session.jsonl",
          },
          target: {
            kind: "shell_command",
            command: "echo nope",
          },
        }),
      /cron_session_instruction_requires_agent_prompt/,
    );
    assert.throws(
      () =>
        scheduler.upsertTask({
          id: "cron_instruction_cron",
          trigger: { expression: "*/1 * * * *", timezone: "local" },
          session: {
            mode: "session_instruction",
            sessionFile: "/tmp/session.jsonl",
          },
          target: {
            kind: "agent_prompt",
            prompt: "Continue here.",
          },
        }),
      /cron_session_instruction_requires_once/,
    );
    const task = scheduler.upsertTask({
      id: "cron_instruction_ok",
      trigger: { runAt: "2099-01-01T00:00:00.000Z" },
      session: {
        mode: "session_instruction",
        sessionFile: "/tmp/session.jsonl",
      },
      target: {
        kind: "agent_prompt",
        prompt: "Continue here.",
      },
    });
    assert.equal(task.chatKey, undefined);
    assert.equal(task.session.mode, "session_instruction");
    assert.equal(task.session.sessionFile, "/tmp/session.jsonl");
    assert.equal(task.target.kind, "agent_prompt");
    assert.equal(task.target.prompt, "Continue here.");
  } finally {
    scheduler.stop();
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
      `Follow the maintenance requirements in ${path.join(agentDir, "docs", "rin", "docs", "self-improve-memory-maintenance.md")} to improve the entire current self-improve memory library under ${path.join(agentDir, "self_improve")}: prompt baselines, reusable skills, memory-index skills, and short-term memory skills. Optimize, consolidate, correct, merge, move, delete, and prune all reachable improvement points in one cohesive pass.`,
    );
    assert.doesNotMatch(sleep.target.prompt, /Trigger:/);
    assert.doesNotMatch(sleep.target.prompt, /conversation above/);
    assert.doesNotMatch(sleep.target.prompt, /conversation transcript/);
    assert.doesNotMatch(sleep.target.prompt, /Review priorities:/);
    assert.doesNotMatch(sleep.target.prompt, /explicit owner corrections/);
    assert.doesNotMatch(
      sleep.target.prompt,
      /patch the skill that was in play/,
    );
    assert.match(sleep.target.prompt, /prompt baselines/);
    assert.match(sleep.target.prompt, /reusable skills/);
    assert.match(sleep.target.prompt, /memory-index skills/);
    assert.match(sleep.target.prompt, /short-term memory skills/);
    assert.match(sleep.target.prompt, /merge, move, delete, and prune/);
    assert.doesNotMatch(sleep.target.prompt, /one concise no-op reason/);
    assert.doesNotMatch(sleep.target.prompt, /read-only guidance/);
    assert.doesNotMatch(sleep.target.prompt, /## Basic concepts/);
  } finally {
    scheduler.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("cron scheduler persists built-in task state across restarts while hiding it publicly", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const tasksFile = path.join(agentDir, "data", "scheduler", "tasks.json");
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

test("cron scheduler reschedule-once rejects recurring tasks", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cron-agent-"));
  const scheduler = new cronMod.CronScheduler({ agentDir });
  try {
    scheduler.start();
    scheduler.upsertTask({
      id: "cron_recurring",
      trigger: { expression: "*/1 * * * *", timezone: "local" },
      session: { mode: "none" },
      target: { kind: "shell_command", command: "echo ok" },
    });
    assert.throws(
      () =>
        scheduler.rescheduleOneTimeTask(
          "cron_recurring",
          "2099-01-02T00:00:00.000Z",
        ),
      /cron_task_not_once:cron_recurring/,
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
