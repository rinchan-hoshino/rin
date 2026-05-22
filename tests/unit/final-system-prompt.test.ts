import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";

import { pathToFileURL } from "node:url";

import { buildFinalAppSystemPrompt } from "./helpers/final-system-prompt.js";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const runtimeMod = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "runtime.js"))
    .href
);
const sessionForkMod = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "session", "fork.js")).href
);
const { SessionManager } = await import("@earendil-works/pi-coding-agent");

function makeTempDir(t: TestContext, prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    try {
      if (process.cwd().startsWith(dir)) process.chdir(rootDir);
    } catch {
      process.chdir(rootDir);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("createConfiguredAgentSession keeps system prompt empty until first turn", async (t) => {
  const cwd = makeTempDir(t, "rin-lazy-prompt-cwd-");
  const agentDir = makeTempDir(t, "rin-lazy-prompt-agent-");

  const { session } = await runtimeMod.createConfiguredAgentSession({
    cwd,
    agentDir,
  });

  assert.equal(String(session._baseSystemPrompt || ""), "");
  assert.equal(String(session.agent?.state?.systemPrompt || ""), "");

  const baseSystemPrompt = runtimeMod.ensureSessionBaseSystemPrompt(session);
  assert.ok(
    baseSystemPrompt.startsWith(
      "As the assistant, you must fulfill the user's requests.",
    ),
  );
  assert.ok(baseSystemPrompt.includes("Available tools:"));
  assert.equal(String(session._baseSystemPrompt || ""), baseSystemPrompt);
  assert.equal(
    String(session.agent?.state?.systemPrompt || ""),
    baseSystemPrompt,
  );
});

test("buildFinalAppSystemPrompt includes app-level prompt layers", async () => {
  const { baseSystemPrompt, finalSystemPrompt } =
    await buildFinalAppSystemPrompt();

  assert.ok(baseSystemPrompt.includes("Available tools:"));
  assert.match(baseSystemPrompt, /\nCurrent date: \d{4}-\d{2}-\d{2}$/);
  assert.equal(baseSystemPrompt.includes("Current working directory:"), false);
  assert.ok(baseSystemPrompt.includes("- search_memory:"));
  assert.equal(baseSystemPrompt.includes("- save_prompts:"), false);
  assert.ok(baseSystemPrompt.includes("Guidelines:"));
  assert.equal(baseSystemPrompt.includes("Markdown rich-object syntax"), false);
  assert.equal(
    baseSystemPrompt.includes("Native at: [@name](at:<platform-user-id>)"),
    false,
  );

  assert.ok(
    baseSystemPrompt.startsWith(
      "As the assistant, you must fulfill the user's requests.\nYou are an LLM running inside an agent loop: one bounded turn from input or scheduled trigger to a single final response; after that, work stops until another loop starts.",
    ),
  );
  assert.ok(
    baseSystemPrompt.includes(
      "You are running in the Rin runtime environment.",
    ),
  );
  assert.ok(baseSystemPrompt.includes("Rin and Pi documentation:"));
  assert.ok(
    baseSystemPrompt.includes(
      "Start with Rin README.md, docs/execution-environment.md, and docs/pi-overrides.md",
    ),
  );
  assert.ok(baseSystemPrompt.includes("Session awareness guidance:"));
  assert.ok(baseSystemPrompt.includes("docs/session-awareness.md"));
  assert.ok(baseSystemPrompt.includes("Scheduled task guidance:"));
  assert.ok(baseSystemPrompt.includes("use Rin scheduled tasks first"));
  assert.equal(baseSystemPrompt.includes("condition.kind"), false);
  assert.ok(baseSystemPrompt.includes("Rich text guidance:"));
  assert.ok(baseSystemPrompt.includes("use Rin native rich output syntax"));
  assert.ok(baseSystemPrompt.includes("Chat bridge guidance:"));
  assert.equal(
    baseSystemPrompt.includes("Memory and self-improvement guidance:"),
    false,
  );
  assert.equal(baseSystemPrompt.includes("- Topic map:"), false);

  assert.ok(
    finalSystemPrompt.includes(
      "As the assistant, you must fulfill the user's requests.",
    ),
  );
  assert.ok(!finalSystemPrompt.includes("# Self-improve guidance"));
  assert.equal(
    finalSystemPrompt.includes("Self improve skills guidance:"),
    false,
  );
  assert.equal(
    finalSystemPrompt.includes("Use save_prompts when a durable baseline"),
    false,
  );
});

test("buildFinalAppSystemPrompt injects configured language from settings", async (t) => {
  const cwd = makeTempDir(t, "rin-lang-prompt-cwd-");
  const agentDir = makeTempDir(t, "rin-lang-prompt-agent-");
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ language: "zh_CN" }, null, 2),
    "utf8",
  );

  const { baseSystemPrompt, finalSystemPrompt } =
    await buildFinalAppSystemPrompt({
      cwd,
      agentDir,
    });

  assert.ok(baseSystemPrompt.includes("Configured runtime defaults:"));
  assert.ok(baseSystemPrompt.includes("Preferred language: zh_CN"));
  assert.ok(finalSystemPrompt.includes("Preferred language: zh_CN"));
});

test("system prompt stays frozen until reload", async (t) => {
  const cwd = makeTempDir(t, "rin-frozen-prompt-cwd-");
  const agentDir = makeTempDir(t, "rin-frozen-prompt-agent-");
  const promptDir = path.join(agentDir, "self_improve", "prompts");
  fs.mkdirSync(promptDir, { recursive: true });
  fs.writeFileSync(
    path.join(promptDir, "user_profile.md"),
    "Original stable preference.\n",
  );

  const { session } = await runtimeMod.createConfiguredAgentSession({
    cwd,
    agentDir,
  });
  const firstPrompt = runtimeMod.ensureSessionBaseSystemPrompt(session);
  assert.ok(firstPrompt.includes("Original stable preference."));

  fs.writeFileSync(
    path.join(promptDir, "user_profile.md"),
    "Updated preference after materialization.\n",
  );
  session.setActiveToolsByName(session.getActiveToolNames());

  assert.equal(String(session._baseSystemPrompt || ""), firstPrompt);
  assert.equal(
    String(session._baseSystemPrompt || "").includes(
      "Updated preference after materialization.",
    ),
    false,
  );

  await session.reload();
  const reloadedPrompt = runtimeMod.ensureSessionBaseSystemPrompt(session);
  assert.ok(
    reloadedPrompt.includes("Updated preference after materialization."),
  );
});

test("persisted system prompt restores across resume and refreshes on reload", async (t) => {
  const cwd = makeTempDir(t, "rin-persist-prompt-cwd-");
  const agentDir = makeTempDir(t, "rin-persist-prompt-agent-");
  const promptDir = path.join(agentDir, "self_improve", "prompts");
  fs.mkdirSync(promptDir, { recursive: true });
  fs.writeFileSync(
    path.join(promptDir, "core_doctrine.md"),
    "Original persisted method.\n",
  );

  const firstRuntime = await runtimeMod.createConfiguredAgentSession({
    cwd,
    agentDir,
  });
  const firstPrompt = runtimeMod.ensureSessionBaseSystemPrompt(
    firstRuntime.session,
  );
  const sessionFile = firstRuntime.session.sessionFile;
  assert.ok(sessionFile);
  assert.ok(firstPrompt.includes("Original persisted method."));

  const entries = firstRuntime.session.sessionManager.getEntries();
  assert.ok(
    entries.some(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === "rin-system-prompt-state" &&
        entry.data?.systemPrompt === firstPrompt,
    ),
  );
  firstRuntime.session.sessionManager.appendMessage({
    role: "assistant",
    content: [],
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: {} },
    stopReason: "end_turn",
    timestamp: Date.now(),
  });
  assert.ok(fs.existsSync(sessionFile));
  await firstRuntime.runtime.dispose();

  fs.writeFileSync(
    path.join(promptDir, "core_doctrine.md"),
    "Updated method after resume.\n",
  );

  const resumedManager = SessionManager.open(
    sessionFile,
    path.dirname(sessionFile),
  );
  const resumedRuntime = await runtimeMod.createConfiguredAgentSession({
    cwd,
    agentDir,
    sessionManager: resumedManager,
  });
  const resumedPrompt = runtimeMod.ensureSessionBaseSystemPrompt(
    resumedRuntime.session,
  );
  assert.equal(resumedPrompt, firstPrompt);
  assert.equal(resumedPrompt.includes("Updated method after resume."), false);

  await resumedRuntime.session.reload();
  const reloadedPrompt = runtimeMod.ensureSessionBaseSystemPrompt(
    resumedRuntime.session,
  );
  assert.notEqual(reloadedPrompt, firstPrompt);
  assert.ok(reloadedPrompt.includes("Updated method after resume."));
  await resumedRuntime.runtime.dispose();
});

test("stored system prompt blocks participate in frozen prompts", async (t) => {
  const cwd = makeTempDir(t, "rin-block-prompt-cwd-");
  const agentDir = makeTempDir(t, "rin-block-prompt-agent-");
  const { session, runtime } = await runtimeMod.createConfiguredAgentSession({
    cwd,
    agentDir,
  });

  session.sessionManager.appendCustomEntry("rin-system-prompt-blocks", {
    version: 1,
    blocks: ["Stable chat bridge block."],
  });
  const prompt = runtimeMod.ensureSessionBaseSystemPrompt(session);

  assert.ok(prompt.includes("Stable chat bridge block."));
  assert.equal(
    prompt.indexOf("Stable chat bridge block."),
    prompt.lastIndexOf("Stable chat bridge block."),
  );
  await runtime.dispose();
});

test("temporary cache-equivalent forks disable routine auto compaction through runtime setup", async (t) => {
  const cwd = makeTempDir(t, "rin-temp-fork-cwd-");
  const agentDir = makeTempDir(t, "rin-temp-fork-agent-");
  fs.mkdirSync(path.join(agentDir, "self_improve", "prompts"), {
    recursive: true,
  });

  const sourceRuntime = await runtimeMod.createConfiguredAgentSession({
    cwd,
    agentDir,
  });
  const sessionFile = sourceRuntime.session.sessionFile;
  sourceRuntime.session.sessionManager.appendMessage({
    role: "assistant",
    content: [],
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: {} },
    stopReason: "end_turn",
    timestamp: Date.now(),
  });
  await sourceRuntime.runtime.dispose();

  const forkManager = sessionForkMod.forkSessionManagerCompat(
    SessionManager,
    sessionFile,
    cwd,
    undefined,
    {
      persist: false,
      preserveSourceSessionId: true,
      disableRoutineCompaction: true,
    },
  );
  const forkRuntime = await runtimeMod.createConfiguredAgentSession({
    cwd,
    agentDir,
    sessionManager: forkManager,
  });

  assert.equal(forkRuntime.session.sessionFile, undefined);
  assert.equal(forkRuntime.session.sessionId, sourceRuntime.session.sessionId);
  assert.equal(
    forkRuntime.session[
      sessionForkMod.EPHEMERAL_FORK_DISABLE_ROUTINE_COMPACTION_KEY
    ],
    true,
  );
  await forkRuntime.runtime.dispose();
});

test("forked sessions restore the source persisted system prompt", async (t) => {
  const cwd = makeTempDir(t, "rin-fork-prompt-cwd-");
  const agentDir = makeTempDir(t, "rin-fork-prompt-agent-");
  const promptDir = path.join(agentDir, "self_improve", "prompts");
  fs.mkdirSync(promptDir, { recursive: true });
  fs.writeFileSync(
    path.join(promptDir, "core_doctrine.md"),
    "Original fork method.\n",
  );

  const sourceRuntime = await runtimeMod.createConfiguredAgentSession({
    cwd,
    agentDir,
  });
  const sourcePrompt = runtimeMod.ensureSessionBaseSystemPrompt(
    sourceRuntime.session,
  );
  const sessionFile = sourceRuntime.session.sessionFile;
  sourceRuntime.session.sessionManager.appendMessage({
    role: "assistant",
    content: [],
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: {} },
    stopReason: "end_turn",
    timestamp: Date.now(),
  });
  await sourceRuntime.runtime.dispose();

  fs.writeFileSync(
    path.join(promptDir, "core_doctrine.md"),
    "Updated method after fork.\n",
  );
  const forkManager = sessionForkMod.forkSessionManagerCompat(
    SessionManager,
    sessionFile,
    cwd,
    undefined,
    { persist: false },
  );
  const forkRuntime = await runtimeMod.createConfiguredAgentSession({
    cwd,
    agentDir,
    sessionManager: forkManager,
  });
  const forkPrompt = runtimeMod.ensureSessionBaseSystemPrompt(
    forkRuntime.session,
  );

  assert.equal(forkPrompt, sourcePrompt);
  assert.equal(forkPrompt.includes("Updated method after fork."), false);
  await forkRuntime.runtime.dispose();
});

test("buildFinalAppSystemPrompt keeps self-improve prompts before skills", async (t) => {
  const cwd = makeTempDir(t, "rin-final-prompt-cwd-");
  const agentDir = makeTempDir(t, "rin-final-prompt-agent-");
  fs.writeFileSync(
    path.join(cwd, "AGENTS.md"),
    "# Project Rules\n\n- Test rule\n",
  );
  fs.mkdirSync(path.join(agentDir, "self_improve", "prompts"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(agentDir, "self_improve", "skills", "test-skill"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(agentDir, "self_improve", "prompts", "agent_profile.md"),
    "Test role voice.\n",
  );
  fs.writeFileSync(
    path.join(agentDir, "self_improve", "prompts", "user_profile.md"),
    "Test user preference.\n",
  );
  fs.writeFileSync(
    path.join(agentDir, "self_improve", "prompts", "core_doctrine.md"),
    "Test durable method.\n",
  );
  fs.writeFileSync(
    path.join(agentDir, "self_improve", "skills", "test-skill", "SKILL.md"),
    [
      "---",
      "name: test-skill",
      "description: test skill description",
      "---",
      "# Test Skill",
      "",
      "Use this skill for testing.",
      "",
    ].join("\n"),
  );

  const { finalSystemPrompt } = await buildFinalAppSystemPrompt({
    cwd,
    agentDir,
  });

  const projectContextIdx = finalSystemPrompt.indexOf("# Project Context");
  const rolePrefaceIdx = finalSystemPrompt.indexOf(
    "Always use this agent profile as the standing role and speaking guide.",
  );
  const agentProfileIdx = finalSystemPrompt.indexOf("Agent profile:");
  const promptsIdx = finalSystemPrompt.indexOf("User profile:");
  const methodologyPrefaceIdx = finalSystemPrompt.indexOf(
    "Always follow this core doctrine as the standing methodology.",
  );
  const coreDoctrineIdx = finalSystemPrompt.indexOf("Core doctrine:");
  const skillsIdx = finalSystemPrompt.indexOf("<available_skills>");

  assert.notEqual(projectContextIdx, -1);
  assert.notEqual(rolePrefaceIdx, -1);
  assert.notEqual(agentProfileIdx, -1);
  assert.notEqual(promptsIdx, -1);
  assert.notEqual(methodologyPrefaceIdx, -1);
  assert.notEqual(coreDoctrineIdx, -1);
  assert.notEqual(skillsIdx, -1);
  assert.ok(projectContextIdx < agentProfileIdx);
  assert.ok(agentProfileIdx < rolePrefaceIdx);
  assert.ok(rolePrefaceIdx < promptsIdx);
  assert.ok(promptsIdx < coreDoctrineIdx);
  assert.ok(coreDoctrineIdx < methodologyPrefaceIdx);
  assert.ok(coreDoctrineIdx < skillsIdx);
  assert.ok(!finalSystemPrompt.includes("# Self-Improve Prompts"));
  assert.ok(finalSystemPrompt.includes("<name>test-skill</name>"));
  assert.ok(
    finalSystemPrompt.includes(
      `<path>${path.join(agentDir, "self_improve", "skills", "test-skill")}</path>`,
    ),
  );
  assert.equal(finalSystemPrompt.includes("SKILL.md</path>"), false);
});
