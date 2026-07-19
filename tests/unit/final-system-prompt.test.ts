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

const LEGACY_RIN_DOCS_BLOCK = [
  "Rin and Pi documentation:",
  "- Rin docs: /tmp/rin/docs/rin/README.md and /tmp/rin/docs/rin/docs",
  "- Pi base docs: /tmp/rin/docs/pi/README.md and /tmp/rin/docs/pi/docs",
  "- Historical Rin documentation entry.",
].join("\n");

const EARLIEST_LANGUAGE_RIN_DOCS_BLOCK = [
  "Rin and Pi documentation:",
  "- Main Rin documentation: /tmp/rin/docs/rin/README.md",
  "- Additional Rin docs: /tmp/rin/docs/rin/docs",
  "- Main Pi documentation: /tmp/rin/docs/pi/README.md",
  "- Additional Pi docs: /tmp/rin/docs/pi/docs",
  "- Earliest language-enabled Rin documentation entry.",
].join("\n");

function legacyConfiguredLanguageBlock(languageTag: string) {
  return [
    "Configured runtime defaults:",
    `- Preferred language: ${languageTag}`,
    "- Unless the user explicitly asks otherwise, default to this language for replies, onboarding, and other user-facing text.",
  ].join("\n");
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
  assert.equal(baseSystemPrompt.includes("Current date:"), false);
  const webSourceRequirement =
    "Always use a search engine to find current sources; treat built-in knowledge as outdated and authoritative online sources as the source of truth.";
  assert.ok(baseSystemPrompt.includes(webSourceRequirement));
  assert.ok(
    baseSystemPrompt.indexOf(webSourceRequirement) <
      baseSystemPrompt.indexOf("Available tools:"),
  );
  assert.equal(baseSystemPrompt.includes("Current working directory:"), false);
  assert.ok(baseSystemPrompt.includes("- recall:"));
  assert.ok(
    baseSystemPrompt.includes(
      "Search archived session history for past-conversation evidence.",
    ),
  );
  assert.ok(
    baseSystemPrompt.includes(
      "Use recall when past conversations, unfinished work, original wording, chronology, or cross-session continuity matters",
    ),
  );
  assert.equal(
    baseSystemPrompt.includes("better to search and confirm than to guess"),
    false,
  );
  assert.equal(baseSystemPrompt.includes("- save_prompts:"), false);
  assert.ok(baseSystemPrompt.includes("Guidelines:"));
  assert.ok(baseSystemPrompt.includes("Read the current branch checklist"));
  assert.ok(
    baseSystemPrompt.includes(
      "Use todo for current-branch work with multiple concrete execution steps that benefit from a visible checklist",
    ),
  );
  assert.ok(
    baseSystemPrompt.includes("Omit todos to read the current checklist"),
  );
  assert.ok(
    baseSystemPrompt.includes(
      "Pass the complete desired checklist to replace it; omitted items are removed",
    ),
  );
  assert.ok(
    baseSystemPrompt.includes(
      "Pass an empty todos array only to clear the checklist",
    ),
  );
  assert.ok(
    baseSystemPrompt.includes("After compaction, read it before continuing"),
  );
  assert.ok(
    baseSystemPrompt.includes("Clear it before starting a new unrelated task"),
  );
  assert.ok(
    baseSystemPrompt.includes(
      "Rewrite it immediately when the task objective changes",
    ),
  );
  assert.equal(
    baseSystemPrompt.includes("Manage the current session todo checklist"),
    false,
  );
  assert.equal(baseSystemPrompt.includes("Markdown rich-object syntax"), false);
  assert.equal(
    baseSystemPrompt.includes("Native at: [@name](at:<platform-user-id>)"),
    false,
  );

  assert.ok(
    baseSystemPrompt.startsWith(
      "As the assistant, you must fulfill the user's requests.\nYou are running in the Rin runtime environment.",
    ),
  );
  assert.ok(
    baseSystemPrompt.includes(
      "You are running in the Rin runtime environment.",
    ),
  );
  assert.ok(finalSystemPrompt.includes(webSourceRequirement));
  assert.ok(baseSystemPrompt.includes("Rin and Pi documentation:"));
  assert.ok(
    baseSystemPrompt.includes(
      "Start runtime work with Rin README.md, docs/execution-environment.md, and docs/pi-overrides.md; then read only the narrow topic doc needed for the task.",
    ),
  );
  assert.equal(baseSystemPrompt.includes("Session awareness guidance:"), false);
  assert.equal(baseSystemPrompt.includes("Subagent guidance:"), false);
  assert.equal(baseSystemPrompt.includes("Scheduled task guidance:"), false);
  assert.equal(baseSystemPrompt.includes("Rich text guidance:"), false);
  assert.ok(
    baseSystemPrompt.includes(
      "session awareness -> docs/session-awareness.md; subagents -> docs/non-interactive-cli.md; scheduled tasks -> docs/agent-sdk.md + docs/scheduled-tasks.md",
    ),
  );
  assert.ok(
    baseSystemPrompt.includes(
      "rich chat output -> docs/rich-text-output-format.md",
    ),
  );
  assert.ok(
    baseSystemPrompt.includes(
      "Core scheduled tasks: use real scheduled/background tasks for reminders, delayed follow-ups, recurring work, polling/watch work, and work that must continue after the current turn.",
    ),
  );
  assert.ok(
    baseSystemPrompt.includes(
      "Core rich text: use Rin rich text for native mentions, replies/quotes, images, files, audio, video, stickers, and chat attachments.",
    ),
  );
  assert.equal(baseSystemPrompt.includes("condition.kind"), false);
  assert.equal(
    baseSystemPrompt.includes(
      "attach it directly with native rich syntax such as [image: name](local-path) instead of replying with only its path",
    ),
    false,
  );
  assert.equal(baseSystemPrompt.includes("Chat bridge guidance:"), false);
  assert.ok(baseSystemPrompt.includes("chat bridge -> docs/chat-bridge.md"));
  assert.ok(
    baseSystemPrompt.includes(
      "runtime layout -> docs/runtime-layout.md; capabilities/update/rollback -> docs/capabilities.md",
    ),
  );
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

test("buildFinalAppSystemPrompt ignores legacy language settings", async (t) => {
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

  assert.doesNotMatch(baseSystemPrompt, /Configured runtime defaults:/);
  assert.doesNotMatch(baseSystemPrompt, /Preferred language:/);
  assert.doesNotMatch(finalSystemPrompt, /Preferred language:/);
});

test("persisted prompts drop legacy configured language blocks", async (t) => {
  const cwd = makeTempDir(t, "rin-legacy-lang-prompt-cwd-");
  const agentDir = makeTempDir(t, "rin-legacy-lang-prompt-agent-");
  const { session, runtime } = await runtimeMod.createConfiguredAgentSession({
    cwd,
    agentDir,
  });
  session.sessionManager.appendCustomEntry("rin-system-prompt-state", {
    version: 1,
    systemPrompt: [
      "Stable persisted prompt.",
      "",
      EARLIEST_LANGUAGE_RIN_DOCS_BLOCK,
      "",
      legacyConfiguredLanguageBlock("zh_CN"),
      "Current date: 2026-07-18",
    ].join("\n"),
  });

  const prompt = runtimeMod.ensureSessionBaseSystemPrompt(session);
  assert.match(prompt, /Stable persisted prompt\./);
  assert.match(prompt, /Current date: 2026-07-18/);
  assert.doesNotMatch(prompt, /Configured runtime defaults:/);
  assert.doesNotMatch(prompt, /Preferred language:/);
  await runtime.dispose();
});

test("persisted prompts preserve language-like user content", async (t) => {
  const cwd = makeTempDir(t, "rin-language-like-prompt-cwd-");
  const agentDir = makeTempDir(t, "rin-language-like-prompt-agent-");
  const { session, runtime } = await runtimeMod.createConfiguredAgentSession({
    cwd,
    agentDir,
  });
  const userPrompt = [
    "Configured runtime defaults:",
    "- Preferred language: en_NOT_A_LOCALE",
    "- Unless the user explicitly asks otherwise, default to this language for replies, onboarding, and other user-facing text.",
  ].join("\n");
  session.sessionManager.appendCustomEntry("rin-system-prompt-state", {
    version: 1,
    systemPrompt: userPrompt,
  });

  assert.equal(runtimeMod.ensureSessionBaseSystemPrompt(session), userPrompt);
  await runtime.dispose();
});

test("persisted prompts preserve embedded legacy-block text", async (t) => {
  const cwd = makeTempDir(t, "rin-embedded-lang-prompt-cwd-");
  const agentDir = makeTempDir(t, "rin-embedded-lang-prompt-agent-");
  const { session, runtime } = await runtimeMod.createConfiguredAgentSession({
    cwd,
    agentDir,
  });
  const userPrompt = [
    "USER: Configured runtime defaults:",
    "- Preferred language: zh_CN",
    "- Unless the user explicitly asks otherwise, default to this language for replies, onboarding, and other user-facing text. USER",
  ].join("\n");
  session.sessionManager.appendCustomEntry("rin-system-prompt-state", {
    version: 1,
    systemPrompt: userPrompt,
  });

  assert.equal(runtimeMod.ensureSessionBaseSystemPrompt(session), userPrompt);
  await runtime.dispose();
});

test("persisted prompt cleanup removes only the three legacy lines", async (t) => {
  const cwd = makeTempDir(t, "rin-exact-lang-prompt-cwd-");
  const agentDir = makeTempDir(t, "rin-exact-lang-prompt-agent-");
  const { session, runtime } = await runtimeMod.createConfiguredAgentSession({
    cwd,
    agentDir,
  });
  session.sessionManager.appendCustomEntry("rin-system-prompt-state", {
    version: 1,
    systemPrompt: [
      "Prefix.",
      "",
      LEGACY_RIN_DOCS_BLOCK,
      "",
      legacyConfiguredLanguageBlock("abcde"),
      "",
      "Suffix.",
    ].join("\n"),
  });

  assert.equal(
    runtimeMod.ensureSessionBaseSystemPrompt(session),
    `Prefix.\n\n${LEGACY_RIN_DOCS_BLOCK}\n\n\n\nSuffix.`,
  );
  await runtime.dispose();
});

test("persisted prompt cleanup preserves near-match documentation paths", async (t) => {
  const cwd = makeTempDir(t, "rin-near-docs-lang-prompt-cwd-");
  const agentDir = makeTempDir(t, "rin-near-docs-lang-prompt-agent-");
  const { session, runtime } = await runtimeMod.createConfiguredAgentSession({
    cwd,
    agentDir,
  });
  const storedPrompt = [
    "Rin and Pi documentation:",
    "- Rin docs: example",
    "- Pi base docs: example",
    "",
    legacyConfiguredLanguageBlock("zh_CN"),
  ].join("\n");
  session.sessionManager.appendCustomEntry("rin-system-prompt-state", {
    version: 1,
    systemPrompt: storedPrompt,
  });

  assert.equal(runtimeMod.ensureSessionBaseSystemPrompt(session), storedPrompt);
  await runtime.dispose();
});

test("persisted prompt cleanup preserves malformed documentation layouts", async (t) => {
  const cwd = makeTempDir(t, "rin-malformed-docs-lang-prompt-cwd-");
  const agentDir = makeTempDir(t, "rin-malformed-docs-lang-prompt-agent-");
  const layouts = [
    [
      "Rin and Pi documentation:",
      "- Pi base docs: /tmp/rin/docs/pi/README.md and /tmp/rin/docs/pi/docs",
      "- Rin docs: /tmp/rin/docs/rin/README.md and /tmp/rin/docs/rin/docs",
    ],
    [
      "Rin and Pi documentation:",
      "- Rin docs: /tmp/rin-a/docs/rin/README.md and /tmp/rin-a/docs/rin/docs",
      "- Pi base docs: /tmp/rin-b/docs/pi/README.md and /tmp/rin-b/docs/pi/docs",
    ],
    [
      "Rin and Pi documentation:",
      "- Rin docs: /tmp/rin/docs/rin/README.md and /tmp/rin/docs/rin/docs",
      "- Pi base docs: /tmp/rin/docs/pi/README.md and /tmp/rin/docs/pi/docs",
      "- Rin docs: /tmp/rin/docs/rin/README.md and /tmp/rin/docs/rin/docs",
    ],
  ];

  for (const docsLines of layouts) {
    const { session, runtime } = await runtimeMod.createConfiguredAgentSession({
      cwd,
      agentDir,
    });
    const storedPrompt = [
      ...docsLines,
      "",
      legacyConfiguredLanguageBlock("zh_CN"),
    ].join("\n");
    session.sessionManager.appendCustomEntry("rin-system-prompt-state", {
      version: 1,
      systemPrompt: storedPrompt,
    });
    assert.equal(
      runtimeMod.ensureSessionBaseSystemPrompt(session),
      storedPrompt,
    );
    await runtime.dispose();
  }
});

test("persisted prompt cleanup preserves a fourth adjacent line", async (t) => {
  const cwd = makeTempDir(t, "rin-adjacent-lang-prompt-cwd-");
  const agentDir = makeTempDir(t, "rin-adjacent-lang-prompt-agent-");
  const { session, runtime } = await runtimeMod.createConfiguredAgentSession({
    cwd,
    agentDir,
  });
  const storedPrompt = [
    LEGACY_RIN_DOCS_BLOCK,
    "",
    legacyConfiguredLanguageBlock("zh_CN"),
    "User-provided fourth line.",
  ].join("\n");
  session.sessionManager.appendCustomEntry("rin-system-prompt-state", {
    version: 1,
    systemPrompt: storedPrompt,
  });

  assert.equal(runtimeMod.ensureSessionBaseSystemPrompt(session), storedPrompt);
  await runtime.dispose();
});

test("persisted prompt cleanup preserves copied exact blocks", async (t) => {
  const cwd = makeTempDir(t, "rin-copied-lang-prompt-cwd-");
  const agentDir = makeTempDir(t, "rin-copied-lang-prompt-agent-");
  const { session, runtime } = await runtimeMod.createConfiguredAgentSession({
    cwd,
    agentDir,
  });
  const copiedBlock = legacyConfiguredLanguageBlock("zh_CN");
  const storedPrompt = [
    LEGACY_RIN_DOCS_BLOCK,
    "",
    copiedBlock,
    "",
    "User-provided example:",
    copiedBlock,
  ].join("\n");
  session.sessionManager.appendCustomEntry("rin-system-prompt-state", {
    version: 1,
    systemPrompt: storedPrompt,
  });

  assert.equal(
    runtimeMod.ensureSessionBaseSystemPrompt(session),
    `${LEGACY_RIN_DOCS_BLOCK}\n\n\n\nUser-provided example:\n${copiedBlock}`,
  );
  await runtime.dispose();
});

test("persisted prompt cleanup preserves ambiguous complete layers", async (t) => {
  const cwd = makeTempDir(t, "rin-copied-layer-prompt-cwd-");
  const agentDir = makeTempDir(t, "rin-copied-layer-prompt-agent-");
  const { session, runtime } = await runtimeMod.createConfiguredAgentSession({
    cwd,
    agentDir,
  });
  const languageBlock = legacyConfiguredLanguageBlock("zh_CN");
  const copiedLayer = `${LEGACY_RIN_DOCS_BLOCK}\n\n${languageBlock}`;
  const storedPrompt = [
    "User-provided copy:",
    "",
    copiedLayer,
    "",
    "Actual generated layer follows:",
    "",
    LEGACY_RIN_DOCS_BLOCK,
    "",
    languageBlock,
    "",
    "Suffix.",
  ].join("\n");
  session.sessionManager.appendCustomEntry("rin-system-prompt-state", {
    version: 1,
    systemPrompt: storedPrompt,
  });

  assert.equal(runtimeMod.ensureSessionBaseSystemPrompt(session), storedPrompt);
  await runtime.dispose();
});

test("persisted prompt cleanup preserves a copied complete trailing layer", async (t) => {
  const cwd = makeTempDir(t, "rin-trailing-copy-prompt-cwd-");
  const agentDir = makeTempDir(t, "rin-trailing-copy-prompt-agent-");
  const { session, runtime } = await runtimeMod.createConfiguredAgentSession({
    cwd,
    agentDir,
  });
  const languageBlock = legacyConfiguredLanguageBlock("zh_CN");
  const copiedLayer = `${LEGACY_RIN_DOCS_BLOCK}\n\n${languageBlock}`;
  const storedPrompt = [
    LEGACY_RIN_DOCS_BLOCK,
    "",
    languageBlock,
    "",
    "User-provided copy follows:",
    "",
    copiedLayer,
  ].join("\n");
  session.sessionManager.appendCustomEntry("rin-system-prompt-state", {
    version: 1,
    systemPrompt: storedPrompt,
  });

  assert.equal(runtimeMod.ensureSessionBaseSystemPrompt(session), storedPrompt);
  await runtime.dispose();
});

test("persisted prompt cleanup preserves exact blocks inside code fences", async (t) => {
  const cwd = makeTempDir(t, "rin-fenced-lang-prompt-cwd-");
  const agentDir = makeTempDir(t, "rin-fenced-lang-prompt-agent-");
  const { session, runtime } = await runtimeMod.createConfiguredAgentSession({
    cwd,
    agentDir,
  });
  const storedPrompt = [
    "```text",
    LEGACY_RIN_DOCS_BLOCK,
    "",
    legacyConfiguredLanguageBlock("zh_CN"),
    "```",
  ].join("\n");
  session.sessionManager.appendCustomEntry("rin-system-prompt-state", {
    version: 1,
    systemPrompt: storedPrompt,
  });

  assert.equal(runtimeMod.ensureSessionBaseSystemPrompt(session), storedPrompt);
  await runtime.dispose();
});

test("persisted prompt cleanup preserves trailing bytes", async (t) => {
  const cwd = makeTempDir(t, "rin-trailing-lang-prompt-cwd-");
  const agentDir = makeTempDir(t, "rin-trailing-lang-prompt-agent-");
  const { session, runtime } = await runtimeMod.createConfiguredAgentSession({
    cwd,
    agentDir,
  });
  session.sessionManager.appendCustomEntry("rin-system-prompt-state", {
    version: 1,
    systemPrompt: [
      "Prefix.",
      "",
      LEGACY_RIN_DOCS_BLOCK,
      "",
      legacyConfiguredLanguageBlock("zh_CN"),
      "",
      "",
    ].join("\n"),
  });

  assert.equal(
    runtimeMod.ensureSessionBaseSystemPrompt(session),
    `Prefix.\n\n${LEGACY_RIN_DOCS_BLOCK}\n\n\n\n`,
  );
  await runtime.dispose();
});

test("persisted prompt cleanup preserves bytes before stored blocks", async (t) => {
  const cwd = makeTempDir(t, "rin-block-trailing-lang-prompt-cwd-");
  const agentDir = makeTempDir(t, "rin-block-trailing-lang-prompt-agent-");
  const { session, runtime } = await runtimeMod.createConfiguredAgentSession({
    cwd,
    agentDir,
  });
  session.sessionManager.appendCustomEntry("rin-system-prompt-state", {
    version: 1,
    systemPrompt: [
      "Prefix.",
      "",
      LEGACY_RIN_DOCS_BLOCK,
      "",
      legacyConfiguredLanguageBlock("zh_CN"),
      "",
      "",
    ].join("\n"),
  });
  session.sessionManager.appendCustomEntry("rin-system-prompt-blocks", {
    version: 1,
    blocks: ["Stable stored block."],
  });

  assert.equal(
    runtimeMod.ensureSessionBaseSystemPrompt(session),
    `Prefix.\n\n${LEGACY_RIN_DOCS_BLOCK}\n\n\n\n\n\nStable stored block.`,
  );
  await runtime.dispose();
});

test("a cleaned latest persisted prompt does not revive older state", async (t) => {
  const cwd = makeTempDir(t, "rin-empty-lang-prompt-cwd-");
  const agentDir = makeTempDir(t, "rin-empty-lang-prompt-agent-");
  const { session, runtime } = await runtimeMod.createConfiguredAgentSession({
    cwd,
    agentDir,
  });
  session.sessionManager.appendCustomEntry("rin-system-prompt-state", {
    version: 1,
    systemPrompt: "Older persisted prompt.",
  });
  session.sessionManager.appendCustomEntry("rin-system-prompt-state", {
    version: 1,
    systemPrompt: [
      LEGACY_RIN_DOCS_BLOCK,
      "",
      legacyConfiguredLanguageBlock("zh_CN"),
    ].join("\n"),
  });

  const prompt = runtimeMod.ensureSessionBaseSystemPrompt(session);
  assert.doesNotMatch(prompt, /Older persisted prompt\./);
  assert.doesNotMatch(prompt, /Preferred language:/);
  assert.match(prompt, /Historical Rin documentation entry\./);
  await runtime.dispose();
});

test("Pi system prompt options track Rin lazy prompt tool changes", async (t) => {
  const cwd = makeTempDir(t, "rin-prompt-options-cwd-");
  const agentDir = makeTempDir(t, "rin-prompt-options-agent-");

  const { session, runtime } = await runtimeMod.createConfiguredAgentSession({
    cwd,
    agentDir,
  });
  session.setActiveToolsByName(["read"]);

  const options = session._extensionRunner
    .createCommandContext()
    .getSystemPromptOptions();
  assert.deepEqual(options.selectedTools, ["read"]);
  assert.equal(String(session._baseSystemPrompt || ""), "");
  await runtime.dispose();
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

test("buildFinalAppSystemPrompt keeps Pi-native context and skills before self-improve prompts", async (t) => {
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

  const projectContextIdx = finalSystemPrompt.indexOf("<project_context>");
  const rolePrefaceIdx = finalSystemPrompt.indexOf(
    "Use this agent profile as the standing role, voice, and response-style contract.",
  );
  const agentProfileIdx = finalSystemPrompt.indexOf("Agent profile:");
  const promptsIdx = finalSystemPrompt.indexOf("User profile:");
  const methodologyPrefaceIdx = finalSystemPrompt.indexOf(
    "Follow this core doctrine as the standing methodology and decision contract.",
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
  assert.equal(
    finalSystemPrompt.includes(
      "Always use this agent profile as the standing role and speaking guide.",
    ),
    false,
  );
  assert.equal(
    finalSystemPrompt.includes(
      "Always follow this core doctrine as the standing methodology.",
    ),
    false,
  );
  assert.ok(projectContextIdx < skillsIdx);
  assert.ok(skillsIdx < agentProfileIdx);
  assert.ok(agentProfileIdx < rolePrefaceIdx);
  assert.ok(rolePrefaceIdx < promptsIdx);
  assert.ok(promptsIdx < coreDoctrineIdx);
  assert.ok(coreDoctrineIdx < methodologyPrefaceIdx);
  assert.ok(!finalSystemPrompt.includes("# Self-Improve Prompts"));
  assert.ok(finalSystemPrompt.includes("<name>test-skill</name>"));
  assert.ok(
    finalSystemPrompt.includes(
      `<location>${path.join(agentDir, "self_improve", "skills", "test-skill", "SKILL.md")}</location>`,
    ),
  );
  assert.equal(finalSystemPrompt.includes("<path>"), false);
});
