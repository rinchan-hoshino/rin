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
const agentDir = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "self-improve", "agent-dir.js"),
  ).href
);
const onboarding = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "self-improve", "onboarding.js"),
  ).href
);
const store = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "self-improve", "store.js"))
    .href
);
const selfImproveDocs = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "self-improve", "docs.js"))
    .href
);
const asyncJobs = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "self-improve", "async-jobs.js"),
  ).href
);
const selfImprovePaths = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "self-improve", "paths.js"))
    .href
);
const processing = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "self-improve", "processing.js"),
  ).href
);
const selfImproveIndex = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "self-improve", "index.js"))
    .href
);
const maintainer = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "self-improve", "maintainer.js"),
  ).href
);
const skillUsage = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "self-improve", "skill-usage.js"),
  ).href
);

async function withTempRoot(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-memory-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function queuePath(root) {
  return selfImprovePaths.maintenanceQueuePath(root);
}

function assistantFinal(text = "done") {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function assistantToolMessage(text = "I will check") {
  return {
    role: "assistant",
    content: [
      { type: "text", text },
      { type: "toolCall", name: "bash" },
    ],
  };
}

function userFrontend() {
  return { kind: "chat", key: "telegram/1:2" };
}

async function writeSessionWithAssistantFinals(sessionFile, count) {
  const entries = [];
  let parentId = null;
  for (let i = 0; i < count; i += 1) {
    const id = `assistant-${i + 1}`;
    entries.push({
      type: "message",
      id,
      parentId,
      message: assistantFinal(`done ${i + 1}`),
    });
    parentId = id;
  }
  await fs.writeFile(
    sessionFile,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
}

function historyPath(root) {
  return selfImprovePaths.maintenanceHistoryPath(root);
}

function selfImproveRoot(root) {
  return selfImprovePaths.resolveSelfImproveRoot(root);
}

test("self-improve paths resolve under the agent root", () => {
  const root = "/tmp/rin-agent";
  const selfImproveDir = path.join(root, "self_improve");
  const stateDir = path.join(selfImproveDir, "state");

  assert.equal(selfImproveRoot(root), selfImproveDir);
  assert.equal(
    selfImprovePaths.selfImprovePromptsDir(root),
    path.join(selfImproveDir, "prompts"),
  );
  assert.equal(
    selfImprovePaths.selfImproveSkillsDir(root),
    path.join(selfImproveDir, "skills"),
  );
  assert.equal(selfImprovePaths.selfImproveStateDir(root), stateDir);
  assert.equal(
    selfImprovePaths.initStatePath(root),
    path.join(stateDir, "init-state.json"),
  );
  assert.equal(queuePath(root), path.join(stateDir, "maintenance-queue.json"));
  assert.equal(
    historyPath(root),
    path.join(stateDir, "maintenance-history.jsonl"),
  );
  assert.equal(
    selfImprovePaths.maintenanceLockPath(root),
    path.join(stateDir, "maintenance-worker.lock"),
  );
});

test("self-improve skill usage stats detect and record read skill files", async () => {
  await withTempRoot(async (root) => {
    const skillPath = path.join(
      root,
      "self_improve",
      "skills",
      "demo-skill",
      "SKILL.md",
    );
    assert.deepEqual(
      skillUsage.detectSelfImproveSkillRead({
        agentDir: root,
        cwd: root,
        args: { path: skillPath },
      }),
      { skillName: "demo-skill", skillPath },
    );
    assert.deepEqual(
      skillUsage.detectSelfImproveSkillRead({
        agentDir: root,
        cwd: root,
        args: { path: "self_improve/skills/demo-skill/SKILL.md" },
      }),
      { skillName: "demo-skill", skillPath },
    );
    assert.equal(
      skillUsage.detectSelfImproveSkillRead({
        agentDir: root,
        cwd: root,
        args: {
          path: path.join(root, "self_improve", "prompts", "agent_profile.md"),
        },
      }),
      null,
    );

    await skillUsage.recordSelfImproveSkillUsage({
      agentDir: root,
      skillName: "demo-skill",
      skillPath,
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      timestamp: "2026-05-27T00:00:00.000Z",
    });
    await skillUsage.recordSelfImproveSkillUsage({
      agentDir: root,
      skillName: "demo-skill",
      skillPath,
      sessionId: "session-2",
      timestamp: "2026-05-27T00:01:00.000Z",
    });
    const stats = skillUsage.readSkillUsageStats(root);
    assert.equal(stats.skills["demo-skill"].count, 2);
    assert.equal(
      stats.skills["demo-skill"].firstUsedAt,
      "2026-05-27T00:00:00.000Z",
    );
    assert.equal(
      stats.skills["demo-skill"].lastUsedAt,
      "2026-05-27T00:01:00.000Z",
    );
    assert.equal(stats.skills["demo-skill"].lastSessionId, "session-2");
    assert.equal(stats.skills["demo-skill"].lastPath, skillPath);
  });
});

test("self-improve module records read-tool skill usage", async () => {
  await withTempRoot(async (root) => {
    const mod = selfImproveIndex.default({});
    await mod.hooks.tool_execution_start[0](
      {
        toolName: "read",
        args: {
          path: path.join(
            root,
            "self_improve",
            "skills",
            "active-skill",
            "SKILL.md",
          ),
        },
      },
      { agentDir: root, cwd: root, sessionId: "session-1" },
    );
    assert.equal(
      skillUsage.readSkillUsageStats(root).skills["active-skill"].count,
      1,
    );
  });
});

test("self-improve agent dir resolution follows Rin runtime profile precedence", () => {
  const previousRinDir = process.env.RIN_DIR;

  try {
    delete process.env.RIN_DIR;
    assert.equal(
      agentDir.resolveAgentDir(),
      path.resolve(path.join(os.homedir(), ".rin")),
    );

    process.env.RIN_DIR = "/tmp/rin-agent";
    assert.equal(agentDir.resolveAgentDir(), path.resolve("/tmp/rin-agent"));
    assert.equal(
      selfImprovePaths.resolveSelfImproveRoot(),
      path.join(path.resolve("/tmp/rin-agent"), "self_improve"),
    );
    assert.equal(
      agentDir.resolveAgentDir("/tmp/override-agent"),
      path.resolve("/tmp/override-agent"),
    );
    assert.equal(
      selfImprovePaths.resolveSelfImproveRoot("/tmp/override-agent"),
      path.join(path.resolve("/tmp/override-agent"), "self_improve"),
    );
  } finally {
    if (previousRinDir === undefined) delete process.env.RIN_DIR;
    else process.env.RIN_DIR = previousRinDir;
  }
});

test("buildOnboardingPrompt points initialization to dedicated docs without duplicating mode steps", () => {
  const prompt = onboarding.buildOnboardingPrompt("manual");
  assert.ok(!prompt.includes("[Memory onboarding request]"));
  assert.ok(prompt.includes("The user is requesting Rin initialization."));
  assert.ok(prompt.includes("~/.rin/docs/rin/docs/initialization.md"));
  assert.ok(prompt.includes("as the initialization contract"));
  assert.equal(prompt.includes("hidden initialization instructions"), false);
  assert.equal(prompt.includes("capabilities.md"), false);
  assert.equal(prompt.includes("one question"), false);
  assert.equal(prompt.includes("preferred language"), false);
  assert.equal(prompt.includes("trust the process"), false);
  assert.equal(prompt.includes("in the user's language"), false);
  assert.equal(prompt.includes("after the final answer"), false);
  assert.equal(prompt.includes("onboarding instructions"), false);
});

test("processing describes prompt slots with content and limits", async () => {
  const state = processing.describeSelfImprovePromptSlot({
    slot: "agent_profile",
    existingContent: "Speak concise Chinese by default.",
  });
  assert.equal(state.slot, "agent_profile");
  assert.equal(state.maxLines, 8);
  assert.equal(state.currentLines, 1);
  assert.equal(state.content, "- Speak concise Chinese by default.");
});

test("processing normalizes revised full-slot content and enforces limits", async () => {
  const refined = processing.refineSelfImprovePromptSlot({
    slot: "user_profile",
    incomingContent:
      "Call the user Master by default.\nAvoid markdown in Chat bridge chats.",
  });
  assert.equal(
    refined.content,
    [
      "- Call the user Master by default.",
      "- Avoid markdown in Chat bridge chats.",
    ].join("\n"),
  );
  assert.equal(refined.nextLines, 2);
  assert.throws(
    () =>
      processing.refineSelfImprovePromptSlot({
        slot: "agent_profile",
        incomingContent: Array.from(
          { length: 9 },
          (_, i) => `line ${i + 1}`,
        ).join("\n"),
      }),
    /self_improve_prompt_content_too_long:agent_profile:8/,
  );
});

test("automatic self-improve handlers run periodic reviews synchronously", async () => {
  await withTempRoot(async (root) => {
    const calls = [];
    const definition = selfImproveIndex.default({
      sendMessage() {},
      getThinkingLevel() {
        return "medium";
      },
      async runSelfImproveMaintenanceJobNow(job) {
        calls.push(job);
        return { status: "completed" };
      },
    });
    const messageEnd = definition.hooks.message_end[0];
    const managedSessionFile = path.join(
      root,
      "sessions",
      "managed",
      "task",
      "cron_demo.jsonl",
    );
    await fs.mkdir(path.dirname(managedSessionFile), { recursive: true });
    await fs.writeFile(managedSessionFile, "", "utf8");
    const ctx = {
      agentDir: root,
      frontend: userFrontend(),
      promptContext: { source: "chat-bridge", selfImproveEligible: true },
      sessionManager: {
        getSessionId: () => "managed-task-session-test",
        getSessionFile: () => managedSessionFile,
        getLeafId: () => "leaf-managed-task",
        isPersisted: () => true,
      },
    };

    for (let i = 0; i < 5; i += 1) {
      await messageEnd({ message: { role: "user" } }, ctx);
      await messageEnd({ message: assistantFinal() }, ctx);
    }

    assert.equal(calls.length, 1);
    assert.equal(calls[0].sessionFile, managedSessionFile);
    assert.equal(calls[0].snapshotKey, "review:5");
    assert.equal(calls[0].trigger, "self_improve:periodic_review");
    await assert.rejects(() => fs.readFile(queuePath(root), "utf8"), /ENOENT/);
  });
});

test("automatic self-improve review interval is configurable", async () => {
  await withTempRoot(async (root) => {
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({ selfImprove: { reviewEveryTurns: 3 } }),
      "utf8",
    );
    const calls = [];
    const definition = selfImproveIndex.default({
      sendMessage() {},
      getThinkingLevel() {
        return "medium";
      },
      async runSelfImproveMaintenanceJobNow(job) {
        calls.push(job);
        return { status: "completed" };
      },
    });
    const messageEnd = definition.hooks.message_end[0];
    const sessionFile = path.join(root, "sessions", "configurable.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, "", "utf8");
    const ctx = {
      agentDir: root,
      frontend: userFrontend(),
      promptContext: { source: "chat-bridge", selfImproveEligible: true },
      sessionManager: {
        getSessionId: () => "configurable-review-session-test",
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf-configurable",
        isPersisted: () => true,
      },
    };

    for (let i = 0; i < 3; i += 1) {
      await messageEnd({ message: { role: "user" } }, ctx);
      await messageEnd({ message: assistantFinal() }, ctx);
    }

    assert.equal(calls.length, 1);
    assert.equal(calls[0].snapshotKey, "review:3");
    await assert.rejects(() => fs.readFile(queuePath(root), "utf8"), /ENOENT/);
  });
});

test("automatic self-improve review counts agent final messages, not user turns", async () => {
  await withTempRoot(async (root) => {
    const calls = [];
    const definition = selfImproveIndex.default({
      sendMessage() {},
      getThinkingLevel() {
        return "medium";
      },
      async runSelfImproveMaintenanceJobNow(job) {
        calls.push(job);
        return { status: "completed" };
      },
    });
    const messageEnd = definition.hooks.message_end[0];
    const sessionFile = path.join(
      root,
      "sessions",
      "final-message-count.jsonl",
    );
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, "", "utf8");
    const ctx = {
      agentDir: root,
      frontend: userFrontend(),
      promptContext: { source: "chat-bridge", selfImproveEligible: true },
      sessionManager: {
        getSessionId: () => "final-message-count-session-test",
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf-final-message-count",
        isPersisted: () => true,
      },
    };

    for (let i = 0; i < 5; i += 1) {
      await messageEnd({ message: { role: "user" } }, ctx);
    }
    await assert.rejects(() => fs.readFile(queuePath(root), "utf8"), /ENOENT/);

    for (let i = 0; i < 5; i += 1) {
      await messageEnd({ message: assistantFinal(`done ${i + 1}`) }, ctx);
    }

    assert.equal(calls.length, 1);
    assert.equal(calls[0].snapshotKey, "review:5");
    await assert.rejects(() => fs.readFile(queuePath(root), "utf8"), /ENOENT/);
  });
});

test("automatic self-improve review reuses chat final-message detection for tool-call messages", async () => {
  await withTempRoot(async (root) => {
    const calls = [];
    const definition = selfImproveIndex.default({
      sendMessage() {},
      getThinkingLevel() {
        return "medium";
      },
      async runSelfImproveMaintenanceJobNow(job) {
        calls.push(job);
        return { status: "completed" };
      },
    });
    const messageEnd = definition.hooks.message_end[0];
    const sessionFile = path.join(
      root,
      "sessions",
      "tool-message-ignored.jsonl",
    );
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, "", "utf8");
    const ctx = {
      agentDir: root,
      frontend: userFrontend(),
      promptContext: { source: "chat-bridge", selfImproveEligible: true },
      sessionManager: {
        getSessionId: () => "tool-message-ignored-review-session-test",
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf-tool-message-ignored",
        isPersisted: () => true,
      },
    };

    for (let i = 0; i < 12; i += 1) {
      await messageEnd(
        { message: assistantToolMessage(`checking ${i + 1}`) },
        ctx,
      );
    }
    await assert.rejects(() => fs.readFile(queuePath(root), "utf8"), /ENOENT/);

    for (let i = 0; i < 5; i += 1) {
      await messageEnd({ message: assistantFinal(`done ${i + 1}`) }, ctx);
    }

    assert.equal(calls.length, 1);
    assert.equal(calls[0].snapshotKey, "review:5");
    await assert.rejects(() => fs.readFile(queuePath(root), "utf8"), /ENOENT/);
  });
});

test("automatic self-improve review records its watermark before awaiting distillation", async () => {
  await withTempRoot(async (root) => {
    const calls = [];
    let resolveMaintenanceStarted;
    const maintenanceStarted = new Promise((resolve) => {
      resolveMaintenanceStarted = resolve;
    });
    let releaseMaintenance;
    const releaseSignal = new Promise((resolve) => {
      releaseMaintenance = resolve;
    });
    const definition = selfImproveIndex.default({
      sendMessage() {},
      getThinkingLevel() {
        return "medium";
      },
      async runSelfImproveMaintenanceJobNow(job) {
        calls.push(job);
        resolveMaintenanceStarted();
        await releaseSignal;
        return { status: "completed" };
      },
    });
    const messageEnd = definition.hooks.message_end[0];
    const sessionFile = path.join(
      root,
      "sessions",
      "watermark-before-await.jsonl",
    );
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await writeSessionWithAssistantFinals(sessionFile, 5);
    const ctx = (leafId) => ({
      agentDir: root,
      frontend: userFrontend(),
      promptContext: { source: "chat-bridge", selfImproveEligible: true },
      sessionManager: {
        getSessionId: () => "watermark-before-await-session-test",
        getSessionFile: () => sessionFile,
        getLeafId: () => leafId,
        isPersisted: () => true,
      },
    });

    const first = messageEnd(
      { message: assistantFinal("done 5") },
      ctx("assistant-5"),
    );
    await maintenanceStarted;
    await writeSessionWithAssistantFinals(sessionFile, 6);
    await messageEnd({ message: assistantFinal("done 6") }, ctx("assistant-6"));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].snapshotKey, "review:5");
    releaseMaintenance();
    await first;
  });
});

test("automatic self-improve review resumes from persisted session count after restart", async () => {
  await withTempRoot(async (root) => {
    const sessionFile = path.join(root, "sessions", "persisted-count.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await writeSessionWithAssistantFinals(sessionFile, 6);

    const createContext = (sessionId, leafId) => ({
      agentDir: root,
      frontend: userFrontend(),
      promptContext: { source: "chat-bridge", selfImproveEligible: true },
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => sessionFile,
        getLeafId: () => leafId,
        isPersisted: () => true,
      },
    });

    const calls = [];
    const firstDefinition = selfImproveIndex.default({
      sendMessage() {},
      getThinkingLevel() {
        return "medium";
      },
      async runSelfImproveMaintenanceJobNow(job) {
        calls.push(job);
        return { status: "completed" };
      },
    });
    await firstDefinition.hooks.message_end[0](
      { message: assistantFinal("done 6") },
      createContext("persisted-count-session-test", "assistant-6"),
    );
    await assert.rejects(() => fs.readFile(queuePath(root), "utf8"), /ENOENT/);

    await writeSessionWithAssistantFinals(sessionFile, 10);
    const restartedDefinition = selfImproveIndex.default({
      sendMessage() {},
      getThinkingLevel() {
        return "medium";
      },
      async runSelfImproveMaintenanceJobNow(job) {
        calls.push(job);
        return { status: "completed" };
      },
    });
    await restartedDefinition.hooks.message_end[0](
      { message: assistantFinal("done 10") },
      createContext("persisted-count-session-test-restarted", "assistant-10"),
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].snapshotKey, "review:10");
    await assert.rejects(() => fs.readFile(queuePath(root), "utf8"), /ENOENT/);
  });
});

test("automatic self-improve review ignores the never-shipped nested interval path", async () => {
  await withTempRoot(async (root) => {
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({ selfImprove: { review: { everyTurns: 3 } } }),
      "utf8",
    );
    const calls = [];
    const definition = selfImproveIndex.default({
      sendMessage() {},
      getThinkingLevel() {
        return "medium";
      },
      async runSelfImproveMaintenanceJobNow(job) {
        calls.push(job);
        return { status: "completed" };
      },
    });
    const messageEnd = definition.hooks.message_end[0];
    const sessionFile = path.join(root, "sessions", "nested-ignored.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, "", "utf8");
    const ctx = {
      agentDir: root,
      frontend: userFrontend(),
      promptContext: { source: "chat-bridge", selfImproveEligible: true },
      sessionManager: {
        getSessionId: () => "nested-ignored-review-session-test",
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf-nested-ignored",
        isPersisted: () => true,
      },
    };

    for (let i = 0; i < 3; i += 1) {
      await messageEnd({ message: assistantFinal(`done ${i + 1}`) }, ctx);
    }
    await assert.rejects(() => fs.readFile(queuePath(root), "utf8"), /ENOENT/);

    for (let i = 0; i < 2; i += 1) {
      await messageEnd({ message: assistantFinal(`done ${i + 4}`) }, ctx);
    }

    assert.equal(calls.length, 1);
    assert.equal(calls[0].snapshotKey, "review:5");
    await assert.rejects(() => fs.readFile(queuePath(root), "utf8"), /ENOENT/);
  });
});

test("automatic self-improve requires explicit eligible producer", async () => {
  await withTempRoot(async (root) => {
    const calls = [];
    const definition = selfImproveIndex.default({
      sendMessage() {},
      getThinkingLevel() {
        return "medium";
      },
      async runSelfImproveMaintenanceJobNow(job) {
        calls.push(job);
        return { status: "completed" };
      },
    });
    const messageEnd = definition.hooks.message_end[0];
    const shutdown = definition.hooks.session_shutdown[0];
    const sessionFile = path.join(root, "sessions", "background-child.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, "", "utf8");
    const ctx = {
      agentDir: root,
      sessionManager: {
        getSessionId: () => "background-child-session-test",
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf-background-child",
        isPersisted: () => true,
      },
    };

    for (let i = 0; i < 5; i += 1) {
      await messageEnd({ message: assistantFinal(`done ${i + 1}`) }, ctx);
    }
    await shutdown({}, ctx);

    assert.equal(calls.length, 0);
    await assert.rejects(() => fs.readFile(queuePath(root), "utf8"), /ENOENT/);
  });
});

test("automatic self-improve allows scheduled-task turns delivered through chat", async () => {
  await withTempRoot(async (root) => {
    const calls = [];
    const definition = selfImproveIndex.default({
      sendMessage() {},
      getThinkingLevel() {
        return "medium";
      },
      async runSelfImproveMaintenanceJobNow(job) {
        calls.push(job);
        return { status: "completed" };
      },
    });
    const messageEnd = definition.hooks.message_end[0];
    const shutdown = definition.hooks.session_shutdown[0];
    const sessionFile = path.join(root, "sessions", "scheduled-chat.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, "", "utf8");
    const ctx = {
      agentDir: root,
      frontend: userFrontend(),
      promptContext: { source: "scheduled-task", selfImproveEligible: true },
      sessionManager: {
        __rinLastPromptContext: {
          taskContextKind: "scheduled-task",
          selfImproveEligible: true,
        },
        getSessionId: () => "scheduled-chat-session-test",
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf-scheduled-chat",
        isPersisted: () => true,
      },
    };

    for (let i = 0; i < 5; i += 1) {
      await messageEnd({ message: assistantFinal(`done ${i + 1}`) }, ctx);
    }
    await shutdown({}, ctx);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].trigger, "self_improve:periodic_review");
    const queue = JSON.parse(await fs.readFile(queuePath(root), "utf8"));
    assert.equal(queue.length, 1);
    assert.equal(queue[0].trigger, "self_improve:session_shutdown_review");
  });
});

test("automatic self-improve allows scheduled-task source with explicit eligibility", async () => {
  await withTempRoot(async (root) => {
    const calls = [];
    const definition = selfImproveIndex.default({
      sendMessage() {},
      getThinkingLevel() {
        return "medium";
      },
      async runSelfImproveMaintenanceJobNow(job) {
        calls.push(job);
        return { status: "completed" };
      },
    });
    const messageEnd = definition.hooks.message_end[0];
    const sessionFile = path.join(root, "sessions", "scheduled-source.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, "", "utf8");
    const ctx = {
      agentDir: root,
      frontend: userFrontend(),
      promptContext: { source: "scheduled-task", selfImproveEligible: true },
      sessionManager: {
        __rinLastPromptSource: "scheduled-task",
        getSessionId: () => "scheduled-source-session-test",
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf-scheduled-source",
        isPersisted: () => true,
      },
    };

    for (let i = 0; i < 5; i += 1) {
      await messageEnd({ message: assistantFinal(`done ${i + 1}`) }, ctx);
    }

    assert.equal(calls.length, 1);
    assert.equal(calls[0].trigger, "self_improve:periodic_review");
    await assert.rejects(() => fs.readFile(queuePath(root), "utf8"), /ENOENT/);
  });
});

test("automatic self-improve ignores scheduled-task source without explicit eligibility", async () => {
  await withTempRoot(async (root) => {
    const calls = [];
    const definition = selfImproveIndex.default({
      sendMessage() {},
      getThinkingLevel() {
        return "medium";
      },
      async runSelfImproveMaintenanceJobNow(job) {
        calls.push(job);
        return { status: "completed" };
      },
    });
    const messageEnd = definition.hooks.message_end[0];
    const sessionFile = path.join(
      root,
      "sessions",
      "scheduled-source-no-eligibility.jsonl",
    );
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, "", "utf8");
    const ctx = {
      agentDir: root,
      frontend: userFrontend(),
      sessionManager: {
        __rinLastPromptSource: "scheduled-task",
        getSessionId: () => "scheduled-source-no-eligibility-session-test",
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf-scheduled-source-no-eligibility",
        isPersisted: () => true,
      },
    };

    for (let i = 0; i < 5; i += 1) {
      await messageEnd({ message: assistantFinal(`done ${i + 1}`) }, ctx);
    }

    assert.equal(calls.length, 0);
    await assert.rejects(() => fs.readFile(queuePath(root), "utf8"), /ENOENT/);
  });
});

test("self-improve review prompt keeps a strong manual-backed wrapper", () => {
  const prompt = maintainer.buildSelfImproveReviewPrompt(
    "self_improve:periodic_review",
    "/tmp/rin-agent",
  );
  assert.equal(
    prompt,
    "Use /tmp/rin-agent/docs/rin/docs/self-improve-distillation.md as the self-improve distillation contract. Review /tmp/rin-agent/self_improve with the conversation above as evidence for this scoped pass. Maintain the clean target state of future guidance: apply the manual's evidence, trigger, target behavior, and owning surface checks; delete or rewrite wrong guidance before considering new guidance; reject patch-layer fixes. For correction-based or repeated-failure evidence, run a conflict retrieval pass over prompt baselines, reusable skills, memory-index indexes and transactions, and matching short-term records using the owner's exact trigger wording, behavior keywords, old abstraction names, and likely synonyms; read every plausible active hit and remove or rewrite active conflicting guidance before adding anything. Before reporting unchanged or success, replay the future trigger and confirm the cleaned library routes to one owner and no active hit still recommends the rejected behavior. Merge, move, prune, rewrite, delete, or add self-improve guidance only when it improves future behavior, routing, decisions, execution, recall, or removes guidance that would cause future mistakes. Cover prompt baselines, reusable skills, memory-index pointers, and short-term continuity records in one cohesive pass. Report changed artifacts, cleanup work, conflict-search closure, future-trigger replay, routed candidates, or one concise unchanged reason.",
  );
  assert.doesNotMatch(prompt, /Trigger:/);
  assert.doesNotMatch(prompt, /self_improve:periodic_review/);
  assert.doesNotMatch(prompt, /Review priorities:/);
  assert.doesNotMatch(prompt, /explicit owner corrections/);
  assert.doesNotMatch(prompt, /lower-entropy/);
  assert.match(prompt, /prompt baselines, reusable skills/);
  assert.match(prompt, /as the self-improve distillation contract/);
  assert.match(prompt, /evidence for this scoped pass/);
  assert.match(prompt, /Maintain the clean target state/);
  assert.match(
    prompt,
    /evidence, trigger, target behavior, and owning surface checks/,
  );
  assert.match(prompt, /delete or rewrite wrong guidance/);
  assert.match(prompt, /reject patch-layer fixes/);
  assert.match(prompt, /conflict retrieval pass over prompt baselines/);
  assert.match(prompt, /memory-index indexes and transactions/);
  assert.match(prompt, /read every plausible active hit/);
  assert.match(prompt, /owner's exact trigger wording/);
  assert.match(prompt, /replay the future trigger/);
  assert.match(prompt, /no active hit still recommends the rejected behavior/);
  assert.doesNotMatch(prompt, /recall, transcript, or message-store evidence/);
  assert.doesNotMatch(prompt, /final reusable workflow/);
  assert.match(prompt, /Report changed artifacts/);
  assert.doesNotMatch(prompt, /self_improve_manage/);
  assert.doesNotMatch(prompt, /skill-read contract/);
});

test("self-improve distillation manual codifies review rules", async () => {
  const manual = await fs.readFile(
    path.join(rootDir, "docs", "agent", "docs", "self-improve-distillation.md"),
    "utf8",
  );
  assert.match(
    manual,
    /Memory preserves original evidence and supports retrieval/,
  );
  assert.match(manual, /Self-improve stores distilled target-state guidance/);
  assert.match(manual, /maintains the target state of future guidance/);
  assert.match(manual, /## Prompt brief/);
  assert.doesNotMatch(manual, /Cosmetic wording cleanup/);
  assert.match(manual, /## Core rule/);
  assert.match(manual, /Distill what the conversation teaches future work/);
  assert.match(manual, /## Success criteria/);
  assert.match(manual, /## Behavior contract/);
  assert.match(manual, /## Evaluation checks/);
  assert.match(manual, /skill-usage\.json/);
  assert.match(manual, /\*\*Evidence:\*\*/);
  assert.match(manual, /\*\*Trigger:\*\*/);
  assert.match(manual, /\*\*Target behavior:\*\*/);
  assert.match(manual, /\*\*Owning surface:\*\*/);
  assert.doesNotMatch(
    manual,
    /reusable target behavior rather than incident detail/,
  );
  assert.doesNotMatch(manual, /lower guidance entropy/);
  assert.match(
    manual,
    /change future behavior, routing, decisions, execution, preference application, recall, or remove guidance/,
  );
  assert.match(manual, /read the whole conversation/);
  assert.match(manual, /owner preferences, workflows, and key knowledge/);
  assert.match(manual, /Read beyond the owner's explicit requests/);
  assert.match(manual, /workflows that worked, workflows that failed/);
  assert.match(manual, /pending decision in memory-index/);
  assert.match(manual, /user_profile.*stable facts only/);
  assert.match(manual, /short-term-memory\/records/);
  assert.match(manual, /## Guidance maintenance rule/);
  assert.match(manual, /Corrections are not automatically new guidance/);
  assert.match(manual, /Reject patch-layer fixes/);
  assert.match(manual, /Conflict closure/);
  assert.match(manual, /Future-trigger replay/);
  assert.match(
    manual,
    /exact owner wording, behavior keywords, old abstraction names, and likely synonyms/,
  );
  assert.match(manual, /Read every hit that could be active guidance/);
  assert.match(
    manual,
    /If the replay would still choose the wrong behavior, the pass is not done/,
  );
  assert.match(manual, /No patch layering/);
  assert.match(manual, /Current skill/);
  assert.match(manual, /Umbrella skill/);
  assert.match(manual, /Skill `references\/`/);
  assert.match(manual, /final reusable workflow shape/);
  assert.match(
    manual,
    /only useful for lookup, store it as memory-index evidence rather than executable guidance/,
  );
  assert.match(manual, /verified workflow shapes/);
  assert.match(manual, /procedures recovered through history lookup/);
  assert.match(manual, /verified through a live\/manual operation/);
  assert.match(manual, /memory-index does not carry the executable procedure/);
  assert.match(manual, /reusable workflow shapes/);
  assert.match(
    manual,
    /Create a new ordinary skill when the trigger is reusable/,
  );
  assert.match(manual, /Memory-index transactions are retrieval pointers/);
  assert.match(manual, /Output contract/);
  assert.match(manual, /Report self-improve artifact changes/);
  assert.doesNotMatch(manual, /self-improve memory library/);
  assert.doesNotMatch(manual, /durable memory changes/);
  assert.doesNotMatch(manual, /Passive observability/);
  assert.doesNotMatch(manual, /\u{1f4a1}/u);
  assert.match(manual, /one concise unchanged reason/);
});

test("automatic self-improve handlers require persisted sessions", async () => {
  await withTempRoot(async (root) => {
    const definition = selfImproveIndex.default({
      sendMessage() {},
      getThinkingLevel() {
        return "medium";
      },
    });
    const messageEnd = definition.hooks.message_end[0];
    const shutdown = definition.hooks.session_shutdown[0];
    const sessionFile = path.join(root, "sessions", "short-lived.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, "", "utf8");
    const ctx = {
      agentDir: root,
      sessionManager: {
        getSessionId: () => "non-persisted-session-test",
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf-short-lived",
        isPersisted: () => false,
      },
    };

    for (let i = 0; i < 5; i += 1) {
      await messageEnd({ message: { role: "user" } }, ctx);
      await messageEnd({ message: assistantFinal() }, ctx);
    }
    await shutdown({}, ctx);

    await assert.rejects(() => fs.readFile(queuePath(root), "utf8"), /ENOENT/);
  });
});

test("session reload does not trigger self-improve shutdown distillation", async () => {
  await withTempRoot(async (root) => {
    const definition = selfImproveIndex.default({
      sendMessage() {},
      getThinkingLevel() {
        return "medium";
      },
    });
    const shutdown = definition.hooks.session_shutdown[0];
    const sessionFile = path.join(root, "sessions", "reload-summary.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, "", "utf8");
    const ctx = {
      agentDir: root,
      sessionManager: {
        getSessionId: () => "reload-session-test",
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf-reload-summary",
        isPersisted: () => true,
      },
    };

    await shutdown({ reason: "reload" }, ctx);

    await assert.rejects(() => fs.readFile(queuePath(root), "utf8"), /ENOENT/);
  });
});

test("real session shutdown queues self-improve review distillation without a core notice", async () => {
  await withTempRoot(async (root) => {
    const notices = [];
    const definition = selfImproveIndex.default({
      sendMessage() {},
      getThinkingLevel() {
        return "medium";
      },
    });
    const shutdown = definition.hooks.session_shutdown[0];
    const sessionFile = path.join(root, "sessions", "shutdown-summary.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, "", "utf8");
    const ctx = {
      agentDir: root,
      frontend: userFrontend(),
      promptContext: { source: "chat-bridge", selfImproveEligible: true },
      emitEvent(event) {
        notices.push(event);
      },
      sessionManager: {
        getSessionId: () => "persisted-shutdown-session-test",
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf-shutdown-summary",
        isPersisted: () => true,
      },
    };

    await shutdown({}, ctx);

    const queue = JSON.parse(await fs.readFile(queuePath(root), "utf8"));
    assert.equal(queue.length, 1);
    assert.equal(queue[0].kind, "self_improve_review");
    assert.equal(queue[0].trigger, "self_improve:session_shutdown_review");
    assert.deepEqual(notices, []);
  });
});

test("self-improve module does not expose save_prompts as a user-facing tool", () => {
  const tools =
    selfImproveIndex.default({
      sendMessage() {},
      getThinkingLevel() {
        return "medium";
      },
    }).tools || [];
  assert.equal(
    tools.some((entry) => entry.name === "save_prompts"),
    false,
  );
});

test("store executeSelfImproveAction compiles saved self-improve prompts", async () => {
  await withTempRoot(async (root) => {
    await store.saveSelfImprovePromptDoc(
      {
        name: "agent profile",
        content: "Speak concise Chinese by default.",
        selfImprovePromptSlot: "agent_profile",
        scope: "global",
      },
      root,
    );
    const compiled = await store.executeSelfImproveAction(
      { action: "compile" },
      root,
    );
    assert.ok(
      String(compiled.self_improve_prompt_context).includes(
        "[agent_profile] - Speak concise Chinese by default.",
      ),
    );
  });
});

test("queued self-improve distillation jobs deduplicate by session file", async () => {
  await withTempRoot(async (root) => {
    await asyncJobs.enqueueSelfImproveMaintenanceJob({
      agentDir: root,
      cwd: "/tmp/project-a",
      sessionFile: "/tmp/session-a.jsonl",
      trigger: "first",
    });
    await asyncJobs.enqueueSelfImproveMaintenanceJob({
      agentDir: root,
      cwd: "/tmp/project-a",
      sessionFile: "/tmp/session-a.jsonl",
      trigger: "second",
    });

    const queue = JSON.parse(await fs.readFile(queuePath(root), "utf8"));
    assert.equal(queue.length, 1);
    assert.equal(queue[0].kind, "self_improve_review");
    assert.equal(queue[0].trigger, "second");
    assert.equal(queue[0].sessionFile, path.resolve("/tmp/session-a.jsonl"));
  });
});

test("queued distillation jobs use core self-improve trigger names by default", async () => {
  await withTempRoot(async (root) => {
    await asyncJobs.enqueueSelfImproveMaintenanceJob({
      agentDir: root,
      sessionFile: "/tmp/session-a.jsonl",
    });

    const queue = JSON.parse(await fs.readFile(queuePath(root), "utf8"));
    assert.equal(queue.length, 1);
    assert.equal(queue[0].trigger, "self_improve:review");
  });
});

test("queued distillation refresh clears stale retry metadata and normalizes extension paths", async () => {
  await withTempRoot(async (root) => {
    await asyncJobs.enqueueSelfImproveMaintenanceJob({
      agentDir: root,
      sessionFile: "/tmp/session-a.jsonl",
      trigger: "first",
      additionalExtensionPaths: [
        " /tmp/ext-a ",
        "/tmp/ext-a",
        "",
        " /tmp/ext-b ",
      ],
    });

    const queueFile = queuePath(root);
    const firstQueue = JSON.parse(await fs.readFile(queueFile, "utf8"));
    firstQueue[0].attempts = 2;
    firstQueue[0].lastError = "stale_error";
    firstQueue[0].lastAttemptAt = "2026-01-01T00:00:00.000Z";
    await fs.writeFile(queueFile, JSON.stringify(firstQueue, null, 2), "utf8");

    await asyncJobs.enqueueSelfImproveMaintenanceJob({
      agentDir: root,
      sessionFile: "/tmp/session-a.jsonl",
      trigger: "second",
      additionalExtensionPaths: ["/tmp/ext-b", " /tmp/ext-c ", "/tmp/ext-c"],
    });

    const queue = JSON.parse(await fs.readFile(queueFile, "utf8"));
    assert.equal(queue.length, 1);
    assert.equal(queue[0].trigger, "second");
    assert.equal(queue[0].attempts, undefined);
    assert.equal(queue[0].lastError, undefined);
    assert.equal(queue[0].lastAttemptAt, undefined);
    assert.deepEqual(queue[0].additionalExtensionPaths, [
      "/tmp/ext-b",
      "/tmp/ext-c",
    ]);
  });
});

test("queued distillation drops invalid session jobs into history instead of blocking the queue", async () => {
  await withTempRoot(async (root) => {
    await asyncJobs.enqueueSelfImproveMaintenanceJob({
      agentDir: root,
      sessionFile: path.join(root, "missing-session.jsonl"),
      trigger: "self_improve:periodic_review",
      snapshotKey: "review:5",
    });

    const result = await asyncJobs.processQueuedSelfImproveJobs(root);
    assert.equal(result.failed, 1);
    assert.equal(result.processed, 0);

    const queue = JSON.parse(await fs.readFile(queuePath(root), "utf8"));
    assert.equal(queue.length, 0);

    const history = (await fs.readFile(historyPath(root), "utf8"))
      .trim()
      .split(/\r?\n/g)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(history.length, 1);
    assert.equal(history[0].status, "failed");
    assert.equal(history[0].trigger, "self_improve:periodic_review");
    assert.equal(history[0].passiveNotice, undefined);
    assert.match(
      String(history[0].error || ""),
      /maintenance_job_missing_session_file:/,
    );
  });
});

test("queued distillation reclaims expired worker locks", async () => {
  await withTempRoot(async (root) => {
    await asyncJobs.enqueueSelfImproveMaintenanceJob({
      agentDir: root,
      sessionFile: path.join(root, "missing-session.jsonl"),
      trigger: "self_improve:periodic_review",
    });
    await fs.mkdir(path.dirname(selfImprovePaths.maintenanceLockPath(root)), {
      recursive: true,
    });
    await fs.writeFile(
      selfImprovePaths.maintenanceLockPath(root),
      JSON.stringify({
        pid: process.pid,
        createdAt: "2000-01-01T00:00:00.000Z",
      }),
      "utf8",
    );

    const result = await asyncJobs.processQueuedSelfImproveJobs(root);
    assert.equal(result.failed, 1);
    assert.equal(result.processed, 0);

    const queue = JSON.parse(await fs.readFile(queuePath(root), "utf8"));
    assert.equal(queue.length, 0);
    await assert.rejects(
      () => fs.readFile(selfImprovePaths.maintenanceLockPath(root), "utf8"),
      /ENOENT/,
    );
  });
});

test("queued distillation keeps live worker locks fresh by updatedAt", async () => {
  await withTempRoot(async (root) => {
    await asyncJobs.enqueueSelfImproveMaintenanceJob({
      agentDir: root,
      sessionFile: path.join(root, "missing-session.jsonl"),
      trigger: "self_improve:periodic_review",
    });
    await fs.mkdir(path.dirname(selfImprovePaths.maintenanceLockPath(root)), {
      recursive: true,
    });
    await fs.writeFile(
      selfImprovePaths.maintenanceLockPath(root),
      JSON.stringify({
        pid: process.pid,
        createdAt: "2000-01-01T00:00:00.000Z",
        updatedAt: new Date().toISOString(),
        activeJob: {
          id: "maintenance_job_active",
          kind: "self_improve_review",
          trigger: "self_improve:periodic_review",
          sessionFile: path.join(root, "active-session.jsonl"),
        },
      }),
      "utf8",
    );

    const result = await asyncJobs.processQueuedSelfImproveJobs(root);
    assert.deepEqual(result, { skipped: "locked" });

    const queue = JSON.parse(await fs.readFile(queuePath(root), "utf8"));
    assert.equal(queue.length, 1);
  });
});

test("queued distillation ignores blank agent dir inputs", async () => {
  const result = await asyncJobs.processQueuedSelfImproveJobs("   ");
  assert.deepEqual(result, { skipped: "no-agent-dir" });
});

test("synchronous self-improve distillation records terminal result without queueing", async () => {
  await withTempRoot(async (root) => {
    const sessionFile = path.join(root, "empty-session.jsonl");
    await fs.writeFile(sessionFile, "", "utf8");

    const result = await asyncJobs.runSelfImproveMaintenanceJobNow({
      agentDir: root,
      sessionFile,
      trigger: "self_improve:periodic_review",
      snapshotKey: "review:leaf-sync",
    });

    assert.equal(result.status, "failed");
    await assert.rejects(() => fs.readFile(queuePath(root), "utf8"), /ENOENT/);
    const history = (await fs.readFile(historyPath(root), "utf8"))
      .trim()
      .split(/\r?\n/g)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(history.length, 1);
    assert.equal(history[0].kind, "self_improve_review");
    assert.equal(history[0].status, "failed");
    assert.equal(history[0].snapshotKey, "review:leaf-sync");
    assert.match(
      String(history[0].error || ""),
      /maintenance_job_invalid_session_file:/,
    );
  });
});

test("compaction snapshot jobs stay distinct for the same session", async () => {
  await withTempRoot(async (root) => {
    await asyncJobs.enqueueSelfImproveMaintenanceJob({
      agentDir: root,
      cwd: "/tmp/project-a",
      sessionFile: "/tmp/session-a.jsonl",
      trigger: "compaction-a",
      snapshotKey: "compaction:first-kept-a",
    });
    await asyncJobs.enqueueSelfImproveMaintenanceJob({
      agentDir: root,
      cwd: "/tmp/project-a",
      sessionFile: "/tmp/session-a.jsonl",
      trigger: "compaction-b",
      snapshotKey: "compaction:first-kept-b",
    });

    const queue = JSON.parse(await fs.readFile(queuePath(root), "utf8"));
    assert.equal(queue.length, 2);
    assert.equal(queue[0].snapshotKey, "compaction:first-kept-a");
    assert.equal(queue[1].snapshotKey, "compaction:first-kept-b");
  });
});

test("self-improve save action is unsupported", async () => {
  await withTempRoot(async (root) => {
    await assert.rejects(
      () =>
        store.executeSelfImproveAction(
          {
            action: "save",
            content: "owner identity",
          },
          root,
        ),
      /unsupported_self_improve_action:save/,
    );
  });
});

test("compileSelfImprove includes saved self-improve prompts from markdown source", async () => {
  await withTempRoot(async (root) => {
    await store.saveSelfImprovePromptDoc(
      {
        name: "owner identity",
        content: "Call the user Master by default.",
        description: "Default address for the user.",
        selfImprovePromptSlot: "user_profile",
        scope: "global",
        kind: "instruction",
      },
      root,
    );

    const compiled = await store.compileSelfImprove(
      { query: "how to address the user" },
      root,
    );
    assert.ok(
      String(compiled.self_improve_prompt_context).includes(
        "[user_profile] - Call the user Master by default.",
      ),
    );
  });
});

test("self-improve doc loading uses prompt slot filenames and ignores skill docs", async () => {
  await withTempRoot(async (root) => {
    const skillDir = path.join(selfImproveRoot(root), "skills", "demo-skill");
    await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: demo-skill",
        "description: Demo skill.",
        "---",
        "# Demo Skill",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(skillDir, "references", "guide.md"),
      "# Guide\n",
      "utf8",
    );
    await fs.mkdir(path.join(selfImproveRoot(root), "prompts"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(selfImproveRoot(root), "prompts", "agent_profile.md"),
      "- Speak concise Chinese by default.\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(selfImproveRoot(root), "prompts", "notes.md"),
      "This should be ignored.\n",
      "utf8",
    );

    const docs = await selfImproveDocs.loadSelfImproveDocs(
      selfImproveRoot(root),
    );
    assert.equal(docs.length, 1);
    assert.match(String(docs[0].path || ""), /agent_profile\.md$/);
    assert.equal(
      String(docs[0].self_improve_prompt_slot || ""),
      "agent_profile",
    );
    assert.equal(
      String(docs[0].content || ""),
      "- Speak concise Chinese by default.",
    );
  });
});

test("saveSelfImprovePromptDoc accepts only active prompt baseline slots", async () => {
  await withTempRoot(async (root) => {
    await assert.rejects(
      () =>
        store.saveSelfImprovePromptDoc(
          {
            name: "unsupported slot",
            content: "User prefers concise Chinese replies.",
            selfImprovePromptSlot: "unsupported_slot",
            scope: "global",
          },
          root,
        ),
      /self_improve_prompt_slot_required:agent_profile,user_profile,core_doctrine/,
    );
  });
});

test("removeSelfImprovePromptDoc deletes prompt slot files", async () => {
  await withTempRoot(async (root) => {
    await store.saveSelfImprovePromptDoc(
      {
        name: "core doctrine",
        content: "Prefer concise replies.",
        selfImprovePromptSlot: "core_doctrine",
        scope: "global",
      },
      root,
    );

    const removed = await store.removeSelfImprovePromptDoc(
      { selfImprovePromptSlot: "core_doctrine" },
      root,
    );
    assert.equal(removed.action, "remove_self_improve_prompt");

    const compiled = await store.compileSelfImprove(
      { query: "concise replies" },
      root,
    );
    assert.equal(
      String(compiled.self_improve_prompt_context).includes("[core_doctrine]"),
      false,
    );
  });
});
