import "../support/require-test-sandbox.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";

import { fileURLToPath, pathToFileURL } from "node:url";

import { buildFinalAppSystemPrompt } from "./helpers/final-system-prompt.js";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
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
const { createRpcResourceCommandHandlers } = await import(
  pathToFileURL(
    path.join(
      rootDir,
      "dist",
      "core",
      "rin-daemon",
      "rpc-resource-command-handler.js",
    ),
  ).href
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

test("Rin materializes its prompt without mutating Pi's base prompt", async (t) => {
  const cwd = makeTempDir(t, "rin-lazy-prompt-cwd-");
  const agentDir = makeTempDir(t, "rin-lazy-prompt-agent-");

  const configured = await runtimeMod.createConfiguredAgentSession({
    cwd,
    agentDir,
  });
  t.after(() => configured.runtime.dispose());

  const piBasePrompt = String(configured.session.systemPrompt || "");
  assert.match(piBasePrompt, /expert coding assistant operating inside pi/);

  const baseSystemPrompt = runtimeMod.ensureSessionBaseSystemPrompt(
    configured.session,
  );
  assert.ok(
    baseSystemPrompt.startsWith(
      "You are running in the Rin runtime environment.",
    ),
  );
  assert.ok(baseSystemPrompt.includes("Available tools:"));
  assert.doesNotMatch(baseSystemPrompt, /expert coding assistant/);
  assert.equal(String(configured.session.systemPrompt || ""), piBasePrompt);
});

test("buildFinalAppSystemPrompt includes app-level prompt layers", async () => {
  const { baseSystemPrompt, finalSystemPrompt } =
    await buildFinalAppSystemPrompt();

  assert.ok(baseSystemPrompt.includes("Available tools:"));
  assert.equal(baseSystemPrompt.includes("Current date:"), false);
  const factualGroundingRequirement =
    "Factual claims require evidence, not model knowledge alone. Check Rin memory for historical events; search current authoritative web sources for facts not established by authoritative local evidence.";
  assert.ok(baseSystemPrompt.includes(factualGroundingRequirement));
  assert.ok(
    baseSystemPrompt.indexOf(factualGroundingRequirement) <
      baseSystemPrompt.indexOf("Available tools:"),
  );
  assert.equal(baseSystemPrompt.includes("Current working directory:"), false);
  assert.ok(baseSystemPrompt.includes("- recall:"));
  assert.ok(
    baseSystemPrompt.includes("- recall: Archived session-history search."),
  );
  assert.ok(
    baseSystemPrompt.includes(
      "Use recall when past conversations, original wording, chronology, or cross-session continuity matters",
    ),
  );
  assert.equal(
    baseSystemPrompt.includes("better to search and confirm than to guess"),
    false,
  );
  assert.equal(baseSystemPrompt.includes("- save_prompts:"), false);
  assert.ok(baseSystemPrompt.includes("Guidelines:"));
  assert.equal(baseSystemPrompt.includes("smallest cohesive change"), false);
  assert.equal(
    baseSystemPrompt.includes("When modifying files, prefer targeted edits"),
    false,
  );
  assert.equal(baseSystemPrompt.includes("Use note for verified state"), false);
  assert.equal(baseSystemPrompt.includes("Omit todos to read"), false);
  assert.equal(
    baseSystemPrompt.includes("complete desired todos array"),
    false,
  );
  assert.equal(baseSystemPrompt.includes("Pi-native optional offset"), false);
  assert.equal(baseSystemPrompt.includes("write for full replacement"), false);
  assert.equal(baseSystemPrompt.includes("Markdown rich-object syntax"), false);
  assert.equal(
    baseSystemPrompt.includes("Native at: [@name](at:<platform-user-id>)"),
    false,
  );

  assert.ok(
    baseSystemPrompt.startsWith(
      "You are running in the Rin runtime environment.",
    ),
  );
  assert.ok(
    baseSystemPrompt.includes(
      "You are running in the Rin runtime environment.",
    ),
  );
  assert.ok(finalSystemPrompt.includes(factualGroundingRequirement));
  assert.ok(baseSystemPrompt.includes("Rin and Pi documentation:"));
  assert.ok(
    baseSystemPrompt.includes(
      "Read only the narrow Rin topic documents needed for the task, following the routes below.",
    ),
  );
  assert.equal(baseSystemPrompt.includes("Session awareness guidance:"), false);
  assert.equal(baseSystemPrompt.includes("Subagent guidance:"), false);
  assert.equal(baseSystemPrompt.includes("Scheduled task guidance:"), false);
  assert.equal(baseSystemPrompt.includes("Rich text guidance:"), false);
  assert.ok(
    baseSystemPrompt.includes(
      "execution target or live capability uncertainty -> docs/execution-environment.md; Rin/Pi behavior differences -> docs/pi-overrides.md",
    ),
  );
  assert.equal(baseSystemPrompt.includes("session-awareness"), false);
  assert.ok(
    baseSystemPrompt.includes(
      "subagents -> docs/non-interactive-cli.md; scheduled tasks -> docs/scheduled-tasks.md; SDK imports, execution, and generic errors -> docs/agent-sdk.md",
    ),
  );
  assert.ok(
    baseSystemPrompt.includes(
      "rich chat output -> docs/rich-text-output-format.md",
    ),
  );
  assert.equal(baseSystemPrompt.includes("Core scheduled tasks:"), false);
  assert.equal(
    baseSystemPrompt.includes("is a lazy reference under the current"),
    false,
  );
  assert.equal(baseSystemPrompt.includes("rin.chat.messages.get"), false);
  assert.equal(
    baseSystemPrompt.includes("nested quote nodes only as needed"),
    false,
  );
  assert.equal(
    baseSystemPrompt.match(/\[quote:<message-id>\]/g)?.length ?? 0,
    0,
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
      "You are running in the Rin runtime environment.",
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

test("resumed sessions retire persisted prompts that advertise the removed note tool", async (t) => {
  const cwd = makeTempDir(t, "rin-retired-note-prompt-cwd-");
  const agentDir = makeTempDir(t, "rin-retired-note-prompt-agent-");
  const { session, runtime } = await runtimeMod.createConfiguredAgentSession({
    cwd,
    agentDir,
  });
  t.after(() => runtime.dispose());
  const retiredPrompt = [
    "Frozen prompt.",
    "Available tools:",
    "- note: Session-branch scratchpad for exact cross-compaction state.",
    "",
    "Guidelines:",
    "- Use note for verified state that must survive compaction; use todo for execution checklists.",
  ].join("\n");
  session.sessionManager.appendCustomEntry("rin-system-prompt-state", {
    version: 1,
    systemPrompt: retiredPrompt,
  });

  const prompt = runtimeMod.ensureSessionBaseSystemPrompt(session);

  assert.notEqual(prompt, retiredPrompt);
  assert.match(prompt, /Available tools:/);
  assert.doesNotMatch(prompt, /^- note:/m);
  assert.doesNotMatch(prompt, /^- Use note /m);
  assert.equal(
    session.sessionManager
      .getBranch()
      .filter((entry: any) => entry.customType === "rin-system-prompt-state")
      .at(-1)?.data?.systemPrompt,
    prompt,
  );
});

test("persisted prompts preserve copied retired note text outside generated contract sections", async (t) => {
  const cwd = makeTempDir(t, "rin-copied-note-prompt-cwd-");
  const agentDir = makeTempDir(t, "rin-copied-note-prompt-agent-");
  const { session, runtime } = await runtimeMod.createConfiguredAgentSession({
    cwd,
    agentDir,
  });
  t.after(() => runtime.dispose());
  const copiedPrompt = [
    "User-provided copy:",
    "- note: Session-branch scratchpad for exact cross-compaction state.",
    "- Use note for verified state that must survive compaction; use todo for execution checklists.",
  ].join("\n");
  session.sessionManager.appendCustomEntry("rin-system-prompt-state", {
    version: 1,
    systemPrompt: copiedPrompt,
  });

  assert.equal(runtimeMod.ensureSessionBaseSystemPrompt(session), copiedPrompt);
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

test("persisted prompt cleanup recognizes every historical language-only locale", async (t) => {
  for (const languageTag of [
    "ar_SA",
    "de_DE",
    "es_ES",
    "fr_FR",
    "hi_IN",
    "ja_JP",
    "ko_KR",
    "pt_BR",
    "ru_RU",
  ]) {
    const cwd = makeTempDir(t, `rin-locale-${languageTag}-cwd-`);
    const agentDir = makeTempDir(t, `rin-locale-${languageTag}-agent-`);
    const { session, runtime } = await runtimeMod.createConfiguredAgentSession({
      cwd,
      agentDir,
    });
    session.sessionManager.appendCustomEntry("rin-system-prompt-state", {
      version: 1,
      systemPrompt: `${LEGACY_RIN_DOCS_BLOCK}\n\n${legacyConfiguredLanguageBlock(languageTag)}`,
    });
    assert.doesNotMatch(
      runtimeMod.ensureSessionBaseSystemPrompt(session),
      /Preferred language:/,
    );
    await runtime.dispose();
  }
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

  const sealedPrompt = runtimeMod.ensureSessionBaseSystemPrompt(session);
  assert.equal(
    sealedPrompt,
    `Prefix.\n\n${LEGACY_RIN_DOCS_BLOCK}\n\n\n\n\n\nStable stored block.`,
  );
  assert.equal(
    session.sessionManager
      .getBranch()
      .filter((entry: any) => entry.customType === "rin-system-prompt-state")
      .at(-1)?.data?.systemPrompt,
    sealedPrompt,
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

test("Pi public system prompt options track Rin lazy prompt tool changes", async (t) => {
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
  assert.deepEqual(
    runtimeMod.ensureSessionBaseSystemPrompt(session).match(/^- read:/gm),
    ["- read:"],
  );
  await runtime.dispose();
});

test("active tool changes reload the frozen system prompt", async (t) => {
  const cwd = makeTempDir(t, "rin-tool-reload-cwd-");
  const agentDir = makeTempDir(t, "rin-tool-reload-agent-");
  const { session, runtime } = await runtimeMod.createConfiguredAgentSession({
    cwd,
    agentDir,
  });
  t.after(() => runtime.dispose());
  const firstPrompt = runtimeMod.ensureSessionBaseSystemPrompt(session);
  assert.match(firstPrompt, /^- bash:/m);

  const originalReload = session.reload.bind(session);
  let reloadCount = 0;
  session.reload = async (...args) => {
    reloadCount += 1;
    return await originalReload(...args);
  };
  const handlers = createRpcResourceCommandHandlers({
    getSession: () => session,
    turnCoordinator: { assertAdmissionOpen() {} },
    createExtensionUiContext: () => ({}),
    SessionManager,
    runtime,
  });

  const changed = await handlers.set_active_tools({
    id: "changed",
    type: "set_active_tools",
    command: { toolNames: ["read"] },
  });
  const reloadedPrompt = runtimeMod.ensureSessionBaseSystemPrompt(session);
  const unchanged = await handlers.set_active_tools({
    id: "unchanged",
    type: "set_active_tools",
    command: { toolNames: ["read"] },
  });

  assert.equal(changed.success, true);
  assert.equal(unchanged.success, true);
  assert.equal(reloadCount, 1);
  assert.notEqual(reloadedPrompt, firstPrompt);
  assert.match(reloadedPrompt, /^- read:/m);
  assert.doesNotMatch(reloadedPrompt, /^- bash:/m);
  assert.equal(
    session.sessionManager
      .getEntries()
      .filter(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === "rin-system-prompt-state",
      )
      .at(-1)?.data?.systemPrompt,
    reloadedPrompt,
  );
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

  assert.equal(runtimeMod.ensureSessionBaseSystemPrompt(session), firstPrompt);
  assert.equal(
    runtimeMod
      .ensureSessionBaseSystemPrompt(session)
      .includes("Updated preference after materialization."),
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

  const replacementManager = SessionManager.open(
    sessionFile,
    path.dirname(sessionFile),
  );
  const replacementRuntime = await runtimeMod.createConfiguredAgentSession({
    cwd,
    agentDir,
    sessionManager: replacementManager,
  });
  const replacementPrompt = runtimeMod.ensureSessionBaseSystemPrompt(
    replacementRuntime.session,
  );
  assert.equal(replacementPrompt, reloadedPrompt);
  await replacementRuntime.runtime.dispose();
});

test("legacy sidecar state is sealed once into the whole frozen prompt", async (t) => {
  const cwd = makeTempDir(t, "rin-block-prompt-cwd-");
  const agentDir = makeTempDir(t, "rin-block-prompt-agent-");
  const { session, runtime } = await runtimeMod.createConfiguredAgentSession({
    cwd,
    agentDir,
  });

  session.sessionManager.appendCustomEntry("rin-system-prompt-state", {
    version: 1,
    systemPrompt: "Frozen base prompt.",
  });
  session.sessionManager.appendCustomEntry("rin-system-prompt-blocks", {
    version: 1,
    blocks: ["Stale chat bridge block."],
  });
  session.sessionManager.appendCustomEntry("rin-system-prompt-blocks", {
    version: 1,
    blocks: ["Current chat bridge block."],
  });
  const prompt = runtimeMod.ensureSessionBaseSystemPrompt(session);

  assert.equal(prompt, "Frozen base prompt.\n\nCurrent chat bridge block.");
  const promptStates = session.sessionManager
    .getBranch()
    .filter((entry: any) => entry.customType === "rin-system-prompt-state");
  assert.equal(promptStates.length, 2);
  assert.equal(promptStates.at(-1)?.data?.systemPrompt, prompt);

  runtimeMod.clearSessionBaseSystemPrompt(session);
  assert.equal(runtimeMod.ensureSessionBaseSystemPrompt(session), prompt);
  assert.equal(
    session.sessionManager
      .getBranch()
      .filter((entry: any) => entry.customType === "rin-system-prompt-state")
      .length,
    2,
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

test("buildFinalAppSystemPrompt keeps structured context and skills before self-improve prompts", async (t) => {
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
    "Standing role, voice, and response contract.",
  );
  const agentProfileIdx = finalSystemPrompt.indexOf("Agent profile:");
  const promptsIdx = finalSystemPrompt.indexOf("User profile:");
  const methodologyPrefaceIdx = finalSystemPrompt.indexOf(
    "Standing method and decision contract.",
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
