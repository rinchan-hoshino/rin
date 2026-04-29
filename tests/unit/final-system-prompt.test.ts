import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
const { SessionManager } = await import("@mariozechner/pi-coding-agent");

test("createConfiguredAgentSession keeps system prompt empty until first turn", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rin-lazy-prompt-cwd-"));
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-lazy-prompt-agent-"),
  );

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
  assert.ok(baseSystemPrompt.includes("- search_memory:"));
  assert.ok(baseSystemPrompt.includes("- save_prompts:"));
  assert.ok(baseSystemPrompt.includes("Guidelines:"));
  assert.ok(baseSystemPrompt.includes("Chat rich content Markdown syntax:"));
  assert.ok(
    baseSystemPrompt.includes("Native at: [@name](at:<platform-user-id>)"),
  );
  assert.ok(
    baseSystemPrompt.includes(
      "Image/file/video/audio/sticker: [image: name](url)",
    ),
  );

  assert.ok(
    finalSystemPrompt.includes(
      "As the assistant, you must fulfill the user's requests.",
    ),
  );
  assert.ok(!finalSystemPrompt.includes("# Self-improve guidance"));
  assert.ok(
    finalSystemPrompt.includes(
      "Use save_prompts when a durable baseline about the assistant, the user, durable methods and values, or durable facts and operating conventions should remain available by default in future turns rather than only for session-local progress or one-off task state",
    ),
  );
});

test("buildFinalAppSystemPrompt injects configured language from settings", async () => {
  const cwd = fs.mkdtempSync(path.join(rootDir, ".tmp-rin-lang-prompt-cwd-"));
  const agentDir = fs.mkdtempSync(
    path.join(rootDir, ".tmp-rin-lang-prompt-agent-"),
  );
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ language: "zh-CN" }, null, 2),
    "utf8",
  );

  const { baseSystemPrompt, finalSystemPrompt } =
    await buildFinalAppSystemPrompt({
      cwd,
      agentDir,
    });

  assert.ok(baseSystemPrompt.includes("Configured runtime defaults:"));
  assert.ok(baseSystemPrompt.includes("Preferred language: zh-CN"));
  assert.ok(finalSystemPrompt.includes("Preferred language: zh-CN"));
});

test("buildFinalAppSystemPrompt injects a continuation prompt after automatic compaction", async () => {
  const { session, baseSystemPrompt } = await buildFinalAppSystemPrompt();
  runtimeMod.writeCompactionContinuationMarker(session, {
    reason: "threshold",
    assistantPreview: "Need to continue editing tests.",
  });

  const beforeStart = await session.__rinCapabilities?.emitBeforeAgentStart(
    "",
    undefined,
    baseSystemPrompt,
  );
  const finalSystemPrompt = String(
    beforeStart?.systemPrompt || baseSystemPrompt,
  );

  assert.ok(
    finalSystemPrompt.includes(
      "Context compacted; treat this as a routine internal checkpoint.",
    ),
  );
  assert.ok(
    finalSystemPrompt.includes(
      "Execute the next concrete step directly without narration",
    ),
  );
  assert.equal(
    finalSystemPrompt.includes(
      "Reserve status updates for when the user asked for one, the task is actually complete, or you are blocked and need input.",
    ),
    false,
  );

  const afterConsume = await session.__rinCapabilities?.emitBeforeAgentStart(
    "",
    undefined,
    baseSystemPrompt,
  );
  const secondPrompt = String(afterConsume?.systemPrompt || baseSystemPrompt);
  assert.equal(
    secondPrompt.includes(
      "Context compacted; treat this as a routine internal checkpoint.",
    ),
    false,
  );
});

test("system prompt stays frozen until reload", async () => {
  const cwd = fs.mkdtempSync(path.join(rootDir, ".tmp-rin-frozen-prompt-cwd-"));
  const agentDir = fs.mkdtempSync(
    path.join(rootDir, ".tmp-rin-frozen-prompt-agent-"),
  );
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

test("persisted system prompt restores across resume and refreshes on reload", async () => {
  const cwd = fs.mkdtempSync(
    path.join(rootDir, ".tmp-rin-persist-prompt-cwd-"),
  );
  const agentDir = fs.mkdtempSync(
    path.join(rootDir, ".tmp-rin-persist-prompt-agent-"),
  );
  const promptDir = path.join(agentDir, "self_improve", "prompts");
  fs.mkdirSync(promptDir, { recursive: true });
  fs.writeFileSync(
    path.join(promptDir, "core_facts.md"),
    "Original persisted fact.\n",
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
  assert.ok(firstPrompt.includes("Original persisted fact."));

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
    path.join(promptDir, "core_facts.md"),
    "Updated fact after resume.\n",
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
  assert.equal(resumedPrompt.includes("Updated fact after resume."), false);

  await resumedRuntime.session.reload();
  const reloadedPrompt = runtimeMod.ensureSessionBaseSystemPrompt(
    resumedRuntime.session,
  );
  assert.notEqual(reloadedPrompt, firstPrompt);
  assert.ok(reloadedPrompt.includes("Updated fact after resume."));
  await resumedRuntime.runtime.dispose();
});

test("stored system prompt blocks participate in frozen prompts", async () => {
  const cwd = fs.mkdtempSync(path.join(rootDir, ".tmp-rin-block-prompt-cwd-"));
  const agentDir = fs.mkdtempSync(
    path.join(rootDir, ".tmp-rin-block-prompt-agent-"),
  );
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

test("forked sessions restore the source persisted system prompt", async () => {
  const cwd = fs.mkdtempSync(path.join(rootDir, ".tmp-rin-fork-prompt-cwd-"));
  const agentDir = fs.mkdtempSync(
    path.join(rootDir, ".tmp-rin-fork-prompt-agent-"),
  );
  const promptDir = path.join(agentDir, "self_improve", "prompts");
  fs.mkdirSync(promptDir, { recursive: true });
  fs.writeFileSync(
    path.join(promptDir, "core_facts.md"),
    "Original fork fact.\n",
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
    path.join(promptDir, "core_facts.md"),
    "Updated fact after fork.\n",
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
  assert.equal(forkPrompt.includes("Updated fact after fork."), false);
  await forkRuntime.runtime.dispose();
});

test("buildFinalAppSystemPrompt keeps self-improve prompts before skills", async () => {
  const cwd = fs.mkdtempSync(path.join(rootDir, ".tmp-rin-final-prompt-cwd-"));
  const agentDir = fs.mkdtempSync(
    path.join(rootDir, ".tmp-rin-final-prompt-agent-"),
  );
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
