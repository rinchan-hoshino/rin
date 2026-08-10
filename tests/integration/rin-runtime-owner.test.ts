import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

await import("../support/register-rin-runtime-owner-fixture.ts");
const runtime = await import(
  pathToFileURL(path.resolve("dist/core/rin-lib/runtime.js")).href
);

const owner = (globalThis as any).__rinRuntimeOwner as Record<string, any>;
const lazyPromptKey = Symbol.for("rin.lazySystemPromptState");
const ephemeralForkKey = Symbol.for(
  "rin.ephemeralFork.disableRoutineCompaction",
);

function resetOwner() {
  owner.events.length = 0;
  owner.moduleOptions = {};
  owner.profile = { cwd: process.cwd(), agentDir: "/owner/agent" };
  owner.language = "zh_CN";
  owner.selfImproveCompiled = { prompt: "Self improve owner" };
  owner.selfImproveError = undefined;
  owner.completeSimpleError = undefined;
  owner.completeSimpleResponse = {
    stopReason: "stop",
    content: [
      { type: "text", text: " owner summary " },
      { type: "image", data: "ignored" },
      { type: "text", text: "tail" },
    ],
  };
  owner.contextOverflow = false;
  owner.estimatedContextTokens = { tokens: 12 };
  owner.mappedMessages = undefined;
  owner.compactionAuth = {
    apiKey: "owner-key",
    headers: { owner: "yes" },
  };
  owner.promptToolStateError = undefined;
  owner.promptToolState = {
    validToolNames: ["read", "bash", "unknown"],
    toolSnippets: { read: "Read owner", bash: "Run owner" },
    promptGuidelines: [
      "Owner guideline.",
      "Be concise in your responses",
      "Owner guideline",
    ],
  };
  owner.resourcePromptState = {
    agentDir: "/owner/agent",
    systemPrompt: "",
    appendSystemPrompt: ["Appended owner"],
    skills: [
      {
        name: "owner<&\"'",
        description: "description<&\"'",
        baseDir: "/owner/skill<&\"'",
      },
      { name: "hidden", disableModelInvocation: true },
      {},
      null,
    ],
    agentsFiles: [
      { path: "/owner/AGENTS.md", content: " Owner project " },
      { path: "/owner/EMPTY.md" },
    ],
  };
  owner.servicesSettingsManager = {
    settings: {},
    getSteeringMode: () => "native-steering",
  };
  owner.knownModels = new Map();
  owner.diagnostics = [{ level: "owner" }];
  owner.resourceLoader = {
    getExtensions: () => [{ id: "owner-extension" }],
  };
  owner.toolDefinitions = [{ name: "owner_tool" }];
  owner.capabilityHandlerTypes = new Set(["session_shutdown"]);
  owner.sessionStartEvent = {
    reason: "resume",
    previousSessionFile: "/owner/previous.jsonl",
  };
  owner.modelFallbackMessage = "owner fallback";
  owner.teardownResult = "owner teardown";
  owner.disposeResult = "owner dispose";
  owner.currentSessionName = "";
  owner.providerMessages = [{ role: "user", content: "provider owner" }];
  owner.sessionMessages = [{ role: "user", content: "session owner" }];
  owner.contextUsage = { tokens: 10, contextWindow: 100, percent: 10 };
  owner.sessionModel = {
    provider: "owner",
    id: "model",
    contextWindow: 20_000,
    maxTokens: 2_000,
    reasoning: true,
  };
  owner.activeToolNames = ["read", "bash"];
  owner.nativePrompt = "native owner prompt";
  owner.nativeCheckResult = "native-check-owner";
  owner.autoCompactionResult = "owner-compacted";
  owner.autoCompactionError = undefined;
  owner.promptResult = "owner-prompted";
  owner.promptPreflightResult = true;
  owner.reloadResult = "owner-reloaded";
  owner.compactResult = "owner-manual-compacted";
  owner.customMessageError = undefined;
  owner.streamFn = undefined;
  owner.isCompacting = false;
  owner.createSessionError = undefined;
  owner.listener = undefined;
  owner.runtime = undefined;
  owner.session = undefined;
  owner.services = undefined;
  owner.capabilityOptions = undefined;
  owner.capabilityDefinitions = undefined;
  owner.attachOptions = undefined;
}

function makeManager() {
  return owner.makeSessionManager(process.cwd(), "/owner/sessions");
}

function eventNames() {
  return owner.events.map((entry: any[]) => entry[0]);
}

function makeThresholdSession(overrides: Record<string, any> = {}) {
  return {
    settingsManager: {
      getCompactionSettings: () => ({ enabled: true, triggerPercent: 0.85 }),
    },
    model: { provider: "owner", id: "model", contextWindow: 1000 },
    sessionManager: { getBranch: () => [] },
    agent: {
      state: { messages: [{ role: "user", content: "owner" }] },
      prepareNextTurn: async () => ({ owner: "native" }),
    },
    async _checkCompaction() {
      return "native";
    },
    async _runAutoCompaction() {
      return "compacted";
    },
    ...overrides,
  } as any;
}

test("runtime private compatibility guards cover locale, fence, and active-tool boundaries", () => {
  const seam = runtime as any;
  for (const tag of [
    "ar_SA",
    "de_DE",
    "en_US",
    "es_ES",
    "fr_FR",
    "hi_IN",
    "ja_JP",
    "ko_KR",
    "pt_BR",
    "ru_RU",
    "zh_CN",
    "nl_NL",
  ]) {
    assert.equal(seam.__rinOwnerIsLegacyGeneratedLanguageTag(tag), true, tag);
  }
  assert.equal(seam.__rinOwnerIsLegacyGeneratedLanguageTag(""), false);
  assert.equal(seam.__rinOwnerIsLegacyGeneratedLanguageTag(null), false);
  assert.equal(seam.__rinOwnerIsLegacyGeneratedLanguageTag("en-bad"), false);
  assert.equal(
    seam.__rinOwnerIsLegacyGeneratedLanguageTag("en_123456789"),
    false,
  );

  assert.equal(seam.__rinOwnerIsInsideMarkdownFence("plain", 5), false);
  assert.equal(seam.__rinOwnerIsInsideMarkdownFence("```ts\nowner", 11), true);
  assert.equal(
    seam.__rinOwnerIsInsideMarkdownFence("```ts\nowner\n```\n", 16),
    false,
  );
  assert.equal(
    seam.__rinOwnerIsInsideMarkdownFence("~~~~ts\nowner\n~~~\n", 18),
    true,
  );
  assert.equal(
    seam.__rinOwnerIsInsideMarkdownFence("~~~~ts\nowner\n~~~~\n", 18),
    false,
  );
  assert.equal(
    seam.__rinOwnerIsInsideMarkdownFence("```ts\nowner\n~~~\n", 17),
    true,
  );

  assert.equal(seam.__rinOwnerHistoricalPromptLineValue(undefined, "- "), "");
  assert.equal(
    seam.__rinOwnerHistoricalPromptLineValue("- C:\\owner", "- "),
    "C:/owner",
  );
  assert.equal(
    seam.__rinOwnerHistoricalReadmeRoot("docs/rin/README.md", "docs/rin"),
    "docs/rin",
  );
  assert.equal(
    seam.__rinOwnerHistoricalReadmeRoot("xdocs/rin/README.md", "docs/rin"),
    "",
  );
  assert.equal(
    seam.__rinOwnerHistoricalJoinedRoot(
      "docs/rin/README.md and docs/rin/docs",
      "docs/rin",
    ),
    "docs/rin",
  );
  assert.equal(
    seam.__rinOwnerHistoricalJoinedRoot(
      "xdocs/rin/README.md and xdocs/rin/docs",
      "docs/rin",
    ),
    "",
  );
  assert.equal(
    seam.__rinOwnerHistoricalAgentRoot("/a/docs/rin", "docs/rin"),
    "/a/",
  );
  assert.equal(
    seam.__rinOwnerHistoricalAgentRoot("/a/docs/pi", "docs/rin"),
    "",
  );
  assert.equal(seam.__rinOwnerStripLegacyConfiguredLanguagePrompt(null), "");
  assert.equal(seam.__rinOwnerFindPersistedSessionBaseSystemPrompt(null), "");
  assert.equal(
    seam.__rinOwnerFindPersistedSessionBaseSystemPrompt([
      { type: "other" },
      {
        type: "custom",
        customType: "rin-system-prompt-state",
        data: { systemPrompt: " " },
      },
      {
        type: "custom",
        customType: "rin-system-prompt-state",
        data: { systemPrompt: "owner" },
      },
    ]),
    "owner",
  );

  assert.equal(seam.__rinOwnerHasLegacyPromptLayerBoundary("abc", 0, 3), true);
  assert.equal(
    seam.__rinOwnerHasLegacyPromptLayerBoundary("abc\n\nnext", 0, 3),
    true,
  );
  assert.equal(
    seam.__rinOwnerHasLegacyPromptLayerBoundary(
      "abc\nCurrent date: 2026-07-27",
      0,
      3,
    ),
    true,
  );
  assert.equal(
    seam.__rinOwnerHasLegacyPromptLayerBoundary("abc\nnext", 0, 3),
    false,
  );

  assert.deepEqual(seam.__rinOwnerGetSessionActiveToolNames(null), []);
  assert.deepEqual(
    seam.__rinOwnerGetSessionActiveToolNames({
      getActiveToolNames: () => ["read"],
    }),
    ["read"],
  );
  assert.deepEqual(
    seam.__rinOwnerGetSessionActiveToolNames({
      getActiveToolNames: () => "read",
    }),
    [],
  );
  assert.deepEqual(
    seam.__rinOwnerGetSessionActiveToolNames({
      getActiveToolNames() {
        throw new Error("owner");
      },
    }),
    [],
  );
});

test("runtime capability definitions integrate owner modules and hook payloads", async () => {
  resetOwner();
  const definitions = runtime.createRinCapabilityDefinitions({
    cwd: "/owner/cwd",
    agentDir: "/owner/agent",
  });

  assert.deepEqual(
    definitions.map((definition: any) => definition.name),
    [
      "note",
      "todo-owner",
      "memory-owner",
      "self-improve-owner",
      "task-owner",
      "chat-owner",
      "rin_provider_bound_context",
    ],
  );
  assert.equal(owner.moduleOptions.memory.cwd, "/owner/cwd");

  const noCompactor = runtime.createRinCapabilityDefinitions({
    cwd: "",
    agentDir: "/owner/agent",
  });
  assert.ok(
    noCompactor.some(
      (definition: any) => definition.name === "rin_provider_bound_context",
    ),
  );

  const compacting = runtime.createRinCapabilityDefinitions({
    cwd: "/owner/cwd",
    agentDir: "/owner/agent",
    compactWithPiNative: async (event: any) => ({ event, owner: true }),
  });
  assert.ok(
    compacting.some(
      (definition: any) => definition.name === "rin_provider_bound_context",
    ),
  );
});

test("prompt exports preserve empty, duplicate, persisted, and lazy fallback behavior", () => {
  resetOwner();
  const plain: any = { _baseSystemPrompt: "base" };
  runtime.applySessionBaseSystemPrompt(plain, "next");
  assert.equal(plain._baseSystemPrompt, "next");
  assert.equal(runtime.ensureSessionBaseSystemPrompt(null), "");
  assert.equal(runtime.ensureSessionBaseSystemPrompt(plain), "next");
  runtime.clearSessionBaseSystemPrompt(null);
  runtime.clearSessionBaseSystemPrompt(plain, { ignorePersistedPrompt: true });
  assert.equal(plain._baseSystemPrompt, "");

  assert.equal(runtime.appendPromptContextSystemPrompt("base", null), "base");
  const withBlock = runtime.appendPromptContextSystemPrompt("base ", {
    owner: true,
  });
  assert.match(withBlock, /^base\n\nPrompt context owner:/);
  assert.equal(
    runtime.appendPromptContextSystemPrompt(withBlock, { owner: true }),
    withBlock,
  );
  assert.match(
    runtime.appendPromptContextSystemPrompt("", { owner: true }),
    /^Prompt context owner:/,
  );

  const manager = makeManager();
  const session: any = { sessionManager: manager };
  assert.equal(
    runtime.persistPromptContextSystemPrompt(session, "base", null),
    "base",
  );
  const persisted = runtime.persistPromptContextSystemPrompt(session, "base", {
    owner: 1,
  });
  assert.match(persisted, /Prompt context owner/);
  runtime.persistPromptContextSystemPrompt(session, persisted, { owner: 1 });
  assert.equal(
    manager.__ownerBranch.filter(
      (entry: any) => entry.customType === "rin-system-prompt-blocks",
    ).length,
    1,
  );
  assert.doesNotThrow(() =>
    runtime.persistPromptContextSystemPrompt({ sessionManager: {} }, "base", {
      owner: 2,
    }),
  );
});

test("configured runtime grants system authority only to the latest accepted prompt binding", async () => {
  resetOwner();
  const manager = makeManager();
  const first = await runtime.createConfiguredAgentSession({
    cwd: process.cwd(),
    agentDir: "/owner/agent",
    sessionManager: manager,
  });
  const contextA = {
    source: "chat-bridge",
    chatKey: "discord/owner:room-a",
    chatName: "Room A",
    chatType: "group",
  };
  const contextB = {
    ...contextA,
    chatKey: "discord/owner:room-b",
    chatName: "Room B",
  };
  const rejectedContext = {
    ...contextA,
    chatKey: "discord/owner:rejected",
    chatName: "Rejected Room",
  };

  await first.session.prompt("from A", { promptContext: contextA });
  await first.session.prompt("from B", { promptContext: contextB });

  const activePrompt = String(first.session._baseSystemPrompt || "");
  assert.doesNotMatch(activePrompt, /Room A/);
  assert.match(activePrompt, /Room B/);
  assert.equal(
    manager.__ownerBranch.filter(
      (entry: any) => entry.customType === "rin-system-prompt-blocks",
    ).length,
    2,
  );

  const resumed = await runtime.createConfiguredAgentSession({
    cwd: process.cwd(),
    agentDir: "/owner/agent",
    sessionManager: manager,
  });
  const resumedPrompt = runtime.ensureSessionBaseSystemPrompt(resumed.session);
  assert.doesNotMatch(resumedPrompt, /Room A/);
  assert.match(resumedPrompt, /Room B/);

  owner.promptPreflightResult = false;
  await resumed.session.prompt("rejected", {
    promptContext: rejectedContext,
  });
  const afterRejectedPrompt = String(resumed.session._baseSystemPrompt || "");
  assert.doesNotMatch(afterRejectedPrompt, /Rejected Room/);
  assert.match(afterRejectedPrompt, /Room B/);
  assert.equal(
    manager.__ownerBranch.filter(
      (entry: any) => entry.customType === "rin-system-prompt-blocks",
    ).length,
    2,
  );

  await first.runtime.dispose();
  await resumed.runtime.dispose();
});

test("configured runtime integrates profile, services, prompt, compaction, and shutdown ownership", async () => {
  resetOwner();
  const model = {
    provider: "owner",
    id: "model",
    contextWindow: 20_000,
    maxTokens: 1000,
    reasoning: true,
    hasAuth: true,
  };
  owner.knownModels.set("owner/model", model);
  const manager = makeManager();
  manager[ephemeralForkKey] = true;

  const configured = await runtime.createConfiguredAgentSession({
    cwd: process.cwd(),
    agentDir: "/owner/agent",
    sessionManager: manager,
    sessionName: "Owner session",
    modelRef: "owner/model",
    thinkingLevel: "high",
    additionalSkillPaths: [
      "/owner/extra-skill",
      "/owner/agent/self_improve/skills",
    ],
    additionalExtensionPaths: ["/owner/extension"],
    additionalPromptTemplatePaths: ["/owner/prompt"],
    additionalThemePaths: ["/owner/theme"],
    noExtensions: false,
    noSkills: false,
    noPromptTemplates: false,
    noThemes: false,
    noContextFiles: false,
    disabledRinCapabilities: ["disabled-owner"],
    extensionFlagValues: new Map([["owner", true]]),
    tools: ["read", "bash"],
    excludeTools: ["edit"],
    noTools: false,
    piAgentSessionServicesOptions: {
      ownerService: true,
      resourceLoaderOptions: { ownerResource: true },
    } as any,
    piAgentSessionOptions: { ownerSession: true } as any,
  });

  assert.equal(configured.session.model, model);
  assert.equal(configured.runtime.session, configured.session);
  assert.deepEqual(configured.extensionsResult, [{ id: "owner-extension" }]);
  assert.equal(configured.modelFallbackMessage, "owner fallback");
  assert.equal(owner.currentSessionName, "Owner session");
  assert.equal(manager.__ownerPersistencePatched, true);
  assert.equal(configured.session[ephemeralForkKey], true);
  assert.equal(owner.attachOptions.reason, "resume");
  assert.equal(
    owner.attachOptions.previousSessionFile,
    "/owner/previous.jsonl",
  );
  assert.deepEqual(owner.capabilityOptions.disabledNames, ["disabled-owner"]);
  const resourceLoaderOptions = owner.events.find(
    ([name]: any[]) => name === "create-services",
  )[1].resourceLoaderOptions;
  assert.equal(resourceLoaderOptions.extensionFactories.length, 1);
  assert.equal(
    resourceLoaderOptions.extensionFactories[0].name,
    "rin-core-items",
  );
  assert.equal(resourceLoaderOptions.extensionFactories[0].hidden, true);
  assert.equal(
    typeof resourceLoaderOptions.extensionFactories[0].factory,
    "function",
  );
  const { extensionFactories: _extensionFactories, ...ordinaryResources } =
    resourceLoaderOptions;
  assert.deepEqual(ordinaryResources, {
    ownerResource: true,
    additionalExtensionPaths: ["/owner/extension"],
    noExtensions: false,
    additionalSkillPaths: [
      "/owner/agent/self_improve/skills",
      "/owner/agent/docs/rin/builtin-skills",
      "/owner/extra-skill",
    ],
    noSkills: false,
    additionalPromptTemplatePaths: ["/owner/prompt"],
    noPromptTemplates: false,
    additionalThemePaths: ["/owner/theme"],
    noThemes: false,
    noContextFiles: false,
    systemPrompt: undefined,
    appendSystemPrompt: undefined,
  });

  assert.equal(configured.session.settingsManager.getSteeringMode(), "all");
  configured.session.settingsManager.settings.steeringMode = "one-at-a-time";
  assert.equal(
    configured.session.settingsManager.getSteeringMode(),
    "one-at-a-time",
  );
  configured.session.settingsManager.settings.steeringMode = "bad";
  assert.equal(configured.session.settingsManager.getSteeringMode(), "all");

  assert.equal(configured.session._baseSystemPrompt, "");
  assert.equal(
    await configured.session.prompt("hello", {
      source: "chat",
      promptContext: { chat: "owner" },
      frontendIdentity: { kind: "discord", key: "owner" },
    }),
    "owner-prompted",
  );
  const builtPrompt = configured.session._baseSystemPrompt;
  assert.match(
    builtPrompt,
    /^As the assistant, you must fulfill the user's requests\./,
  );
  assert.match(builtPrompt, /You are running in the Rin runtime environment/);
  assert.match(builtPrompt, /Always use a search engine/);
  assert.match(
    builtPrompt,
    /Available tools:\n- read: Read owner\n- bash: Run owner/,
  );
  assert.match(builtPrompt, /Rin and Pi documentation/);
  assert.doesNotMatch(builtPrompt, /Language owner: zh_CN/);
  assert.doesNotMatch(builtPrompt, /Appended owner/);
  assert.doesNotMatch(builtPrompt, /# Project Context/);
  assert.match(builtPrompt, /Self improve owner/);
  assert.doesNotMatch(builtPrompt, /<name>owner&lt;&amp;&quot;&apos;<\/name>/);
  assert.doesNotMatch(builtPrompt, /<name>hidden<\/name>/);
  assert.doesNotMatch(builtPrompt, /Current date: \d{4}-\d{2}-\d{2}/);
  assert.match(builtPrompt, /Prompt context owner/);
  assert.equal(manager.__rinLastPromptSource, "chat");
  assert.deepEqual(manager.__rinLastPromptContext, { chat: "owner" });
  assert.deepEqual(manager.__rinFrontend, {
    kind: "discord",
    key: "owner",
  });
  assert.equal(
    owner.events.some(
      ([name, text]: any[]) =>
        name === "native-prompt" && text.startsWith("[owner-context]"),
    ),
    true,
  );

  await configured.session.prompt("plain", {
    source: "",
    frontendIdentity: { kind: "missing-key" },
  });
  assert.equal(manager.__rinFrontend, undefined);
  assert.match(
    await configured.session._rebuildSystemPrompt(["read"]),
    /Available tools:\n- read: Read owner/,
  );
  assert.equal(await configured.session.reload("owner"), "owner-reloaded");
  assert.match(configured.session._baseSystemPrompt, /Available tools/);
  assert.equal(configured.session[lazyPromptKey].ignorePersistedPrompt, false);
  assert.match(
    runtime.ensureSessionBaseSystemPrompt(configured.session),
    /Available tools/,
  );

  const runtimeCapabilityOptions = owner.moduleOptions.memory;
  assert.equal(runtimeCapabilityOptions.getThinkingLevel(), "high");
  runtimeCapabilityOptions.sendMessage("owner message", { channel: "owner" });
  runtimeCapabilityOptions.emitEvent({ type: "owner_event" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(eventNames().includes("custom-message"), true);
  assert.equal(eventNames().includes("core-event"), true);

  owner.customMessageError = new Error("ignored custom message failure");
  assert.doesNotThrow(() =>
    runtimeCapabilityOptions.sendMessage("ignored", undefined),
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    await configured.runtime.teardownCurrent("new", "/owner/next.jsonl"),
    "owner teardown",
  );
  assert.equal(await configured.runtime.dispose("arg"), "owner dispose");
  const shutdownEvents = owner.events.filter(
    ([name]: any[]) => name === "capability-set-emit",
  );
  assert.deepEqual(
    shutdownEvents.map(([, event]: any[]) => [
      event.type,
      event.reason,
      event.targetSessionFile,
    ]),
    [
      ["session_shutdown", "new", "/owner/next.jsonl"],
      ["session_shutdown", "quit", undefined],
    ],
  );
});

test("configured prompt reuses persisted state and falls back to Pi rebuild on Rin prompt failure", async () => {
  resetOwner();
  const manager = makeManager();
  manager.__ownerBranch.push(
    {
      type: "custom",
      customType: "rin-system-prompt-state",
      data: { systemPrompt: "persisted owner prompt" },
    },
    {
      type: "custom",
      customType: "rin-system-prompt-blocks",
      data: { blocks: ["persisted block", "persisted block", ""] },
    },
    { type: "custom", customType: "other", data: {} },
  );
  const configured = await runtime.createConfiguredAgentSession({
    cwd: process.cwd(),
    agentDir: "/owner/agent",
    sessionManager: manager,
  });
  assert.equal(
    runtime.ensureSessionBaseSystemPrompt(configured.session),
    "persisted owner prompt\n\npersisted block",
  );
  const promptToolCalls = owner.events.filter(
    ([name]: any[]) => name === "prompt-tool-state",
  ).length;
  assert.equal(promptToolCalls, 0);
  runtime.clearSessionBaseSystemPrompt(configured.session, {
    ignorePersistedPrompt: true,
  });
  owner.promptToolStateError = new Error("owner prompt builder failed");
  const fallbackPrompt = runtime.ensureSessionBaseSystemPrompt(
    configured.session,
  );
  assert.match(
    fallbackPrompt,
    /^As the assistant, you must fulfill the user's requests\./,
  );
  assert.match(fallbackPrompt, /persisted block/);
  assert.equal(eventNames().includes("native-rebuild"), true);

  const noRebuilder = { _baseSystemPrompt: "kept" } as any;
  assert.equal(runtime.ensureSessionBaseSystemPrompt(noRebuilder), "kept");
  runtime.clearSessionBaseSystemPrompt(noRebuilder);
  assert.equal(noRebuilder._baseSystemPrompt, "");
});

test("configured prompt keeps loader-owned minimal and missing optional resource fallbacks", async (t) => {
  resetOwner();
  const previousRinDir = process.env.RIN_DIR;
  t.after(() => {
    if (previousRinDir === undefined) delete process.env.RIN_DIR;
    else process.env.RIN_DIR = previousRinDir;
  });
  process.env.RIN_DIR = "/owner/env-agent";
  owner.language = "";
  owner.selfImproveError = new Error("optional self improve unavailable");
  owner.promptToolState = {
    validToolNames: ["unknown"],
    toolSnippets: {},
    promptGuidelines: [null, "", "."],
  };
  owner.resourcePromptState = {
    agentDir: "",
    systemPrompt: "Loader owner prompt",
    appendSystemPrompt: [],
    skills: [],
    agentsFiles: [],
  };
  owner.sessionStartEvent = undefined;
  const configured = await runtime.createConfiguredAgentSession({
    cwd: process.cwd(),
    agentDir: "/owner/agent",
  });
  configured.session.getActiveToolNames = () => "not-an-array";
  const minimalPrompt =
    configured.session[lazyPromptKey].compute("not-an-array");
  assert.match(minimalPrompt, /Available tools:\n\(none\)/);
  assert.match(minimalPrompt, /\/owner\/env-agent\/docs\/rin/);
  assert.doesNotMatch(minimalPrompt, /Loader owner prompt/);
  assert.equal(await configured.session._rebuildSystemPrompt(), "");
  assert.equal(
    await configured.session.prompt("minimal owner"),
    "owner-prompted",
  );
  assert.doesNotMatch(
    configured.session._baseSystemPrompt,
    /Loader owner prompt/,
  );
  assert.match(
    configured.session._baseSystemPrompt,
    /\/owner\/env-agent\/docs\/rin/,
  );
  assert.doesNotMatch(configured.session._baseSystemPrompt, /Language owner/);
  assert.doesNotMatch(
    configured.session._baseSystemPrompt,
    /Self improve owner/,
  );
  assert.doesNotMatch(configured.session._baseSystemPrompt, /available_skills/);
  assert.equal(owner.attachOptions.reason, "startup");
  assert.equal(
    runtime.getManagedSkillPaths(" ")[0],
    "/owner/agent/self_improve/skills",
  );

  runtime.clearSessionBaseSystemPrompt(configured.session, {
    ignorePersistedPrompt: true,
  });
  configured.session.getActiveToolNames = () => {
    throw new Error("owner active tools unavailable");
  };
  configured.session.sessionManager = undefined;
  assert.equal(
    await configured.session.prompt("without manager"),
    "owner-prompted",
  );
});

test("configured session validates model refs and compaction early exits without changing public data", async () => {
  resetOwner();
  for (const [modelRef, pattern] of [
    ["owner", /invalid_model_ref:owner/],
    ["/model", /invalid_model_ref:\/model/],
    ["owner/", /invalid_model_ref:owner\//],
    ["owner/missing", /unknown_model:owner\/missing/],
  ] as const) {
    await assert.rejects(
      runtime.createConfiguredAgentSession({
        cwd: process.cwd(),
        agentDir: "/owner/agent",
        modelRef,
      }),
      pattern,
    );
  }
  owner.knownModels.set("owner/no-auth", {
    provider: "owner",
    id: "no-auth",
    hasAuth: false,
  });
  await assert.rejects(
    runtime.createConfiguredAgentSession({
      cwd: process.cwd(),
      agentDir: "/owner/agent",
      modelRef: "owner/no-auth",
    }),
    /No API key for owner\/no-auth/,
  );

  resetOwner();
  const configured = await runtime.createConfiguredAgentSession({
    cwd: process.cwd(),
    agentDir: "/owner/agent",
    thinkingLevel: "",
  });
  assert.equal(owner.moduleOptions.memory.getThinkingLevel(), "medium");
});

test("pruned usage and provider preflight keep guard, fallback, retry, and dedup semantics", async () => {
  resetOwner();
  assert.doesNotThrow(() => runtime.applyRinPrunedContextUsage(null));
  assert.doesNotThrow(() => runtime.applyRinPrunedContextUsage({}));
  const noEstimator = { getContextUsage: () => ({ tokens: 1 }) };
  runtime.applyRinPrunedContextUsage(noEstimator);
  assert.equal(noEstimator.getContextUsage().tokens, 1);

  const usage: any = {
    model: { contextWindow: 200 },
    messages: [{ role: "user" }],
    current: { tokens: null, contextWindow: 200, percent: 0 },
    getContextUsage() {
      return this.current;
    },
  };
  runtime.applyRinPrunedContextUsage(usage, {
    estimateContextTokens: () => ({ tokens: 50 }),
  });
  runtime.applyRinPrunedContextUsage(usage, {
    estimateContextTokens: () => ({ tokens: 99 }),
  });
  assert.equal(usage.getContextUsage().tokens, null);
  usage.current = { tokens: 5, contextWindow: 0, percent: 5 };
  usage.model.contextWindow = 0;
  assert.equal(usage.getContextUsage().tokens, 5);
  usage.current = { tokens: 5, contextWindow: 200, percent: 5 };
  usage.model.contextWindow = 200;
  assert.deepEqual(usage.getContextUsage(), {
    tokens: 50,
    contextWindow: 200,
    percent: 25,
  });

  for (const invalid of [null, {}, { agent: {} }]) {
    assert.doesNotThrow(() =>
      runtime.applyRinProviderOverflowPreflight(invalid as any, {
        estimateContextTokens: () => 1,
      }),
    );
  }
  const noEstimatorSession: any = {
    agent: { transformContext: async (messages: any[]) => messages },
  };
  runtime.applyRinProviderOverflowPreflight(noEstimatorSession);
  const untouched = [1];
  assert.equal(
    await noEstimatorSession.agent.transformContext(untouched),
    untouched,
  );

  let settings = { enabled: false, triggerPercent: 0.85 };
  let compacting = false;
  let compactResult = false;
  const providerMessages: any[] = [{ role: "user", content: "fallback" }];
  const calls: any[] = [];
  const session: any = {
    settingsManager: { getCompactionSettings: () => settings },
    model: { contextWindow: 100 },
    get isCompacting() {
      return compacting;
    },
    agent: {
      state: { messages: providerMessages },
      async transformContext(messages: any[]) {
        calls.push(["transform", messages]);
        return messages;
      },
    },
    sessionManager: {},
    messages: providerMessages,
    async _runAutoCompaction(reason: string, retry: boolean) {
      calls.push(["compact", reason, retry]);
      return compactResult;
    },
  };
  runtime.applyRinProviderOverflowPreflight(session, {
    estimateContextTokens: () => ({ tokens: 90 }),
  });
  runtime.applyRinProviderOverflowPreflight(session, {
    estimateContextTokens: () => ({ tokens: 90 }),
  });
  const userTail = [{ role: "user", content: "owner" }];
  assert.equal(await session.agent.transformContext(userTail), userTail);
  settings = { enabled: true, triggerPercent: 0.85 };
  compacting = true;
  assert.equal(await session.agent.transformContext(userTail), userTail);
  compacting = false;
  assert.equal(await session.agent.transformContext(userTail), userTail);
  assert.equal(calls.filter(([kind]) => kind === "compact").length, 1);
  compactResult = true;
  assert.equal(await session.agent.transformContext(userTail), userTail);
  assert.equal(
    calls.filter(([kind]) => kind === "compact").length,
    1,
    "same tail is not retried",
  );
  const assistantTail = [{ role: "assistant", content: "done" }];
  assert.equal(
    await session.agent.transformContext(assistantTail),
    assistantTail,
  );
  const newTail = [{ role: "toolResult", content: "new" }];
  session.sessionManager.buildSessionContext = () => ({
    messages: [{ role: "user", content: "refreshed" }],
  });
  assert.deepEqual(await session.agent.transformContext(newTail), [
    { role: "user", content: "refreshed" },
  ]);
  assert.deepEqual(newTail, [{ role: "user", content: "refreshed" }]);
});

test("percent compaction preserves native exits, overflow recovery, thresholds, and mid-turn snapshots", async () => {
  resetOwner();
  for (const invalid of [null, {}, { _checkCompaction() {} }]) {
    assert.doesNotThrow(() =>
      runtime.applyRinCompactionPercentThreshold(invalid as any, {
        calculateContextTokens: () => 1,
        estimateContextTokens: () => 1,
      }),
    );
  }

  const disabled = makeThresholdSession({
    settingsManager: { getCompactionSettings: () => ({ enabled: false }) },
  });
  runtime.applyRinCompactionPercentThreshold(disabled, {
    calculateContextTokens: () => 900,
    estimateContextTokens: () => ({ tokens: 900 }),
  });
  assert.equal(
    await disabled._checkCompaction({ stopReason: "stop" }),
    "native",
  );
  assert.equal(
    await disabled._checkCompaction({ stopReason: "aborted" }, true),
    "native",
  );

  const recent = makeThresholdSession({
    sessionManager: {
      getBranch: () => [
        { type: "compaction", id: "recent", timestamp: "2030-01-01T00:00:00Z" },
      ],
    },
  });
  runtime.applyRinCompactionPercentThreshold(recent, {
    calculateContextTokens: () => 900,
    estimateContextTokens: () => ({ tokens: 900 }),
    getLatestCompactionEntry: (entries: any[]) => entries[0],
  });
  assert.equal(
    await recent._checkCompaction({ timestamp: Date.now() }, false),
    false,
  );

  owner.contextOverflow = true;
  const overflow = makeThresholdSession();
  runtime.applyRinCompactionPercentThreshold(overflow, {
    calculateContextTokens: () => 900,
    estimateContextTokens: () => ({ tokens: 900 }),
  });
  assert.equal(
    await overflow._checkCompaction(
      {
        stopReason: "error",
        provider: "owner",
        model: "model",
        timestamp: Date.now(),
      },
      false,
    ),
    "native",
  );
  assert.equal(
    await overflow._checkCompaction(
      {
        stopReason: "error",
        provider: "other",
        model: "model",
        timestamp: Date.now(),
      },
      true,
    ),
    false,
  );

  let tokens: number = Number.NaN;
  const threshold = makeThresholdSession({
    settingsManager: {
      getCompactionSettings: () => ({
        enabled: true,
        triggerPercent: 2,
        reserveTokens: 20,
      }),
    },
  });
  runtime.applyRinCompactionPercentThreshold(threshold, {
    calculateContextTokens: () => tokens,
    estimateContextTokens: () => ({ tokens }),
  });
  assert.equal(
    await threshold._checkCompaction({ stopReason: "stop" }, true),
    false,
  );
  assert.equal(
    await threshold._checkCompaction({ stopReason: "stop" }, false),
    false,
  );
  tokens = 1;
  threshold.model.contextWindow = 0;
  assert.equal(
    await threshold._checkCompaction({ stopReason: "stop" }, false),
    false,
  );
  threshold.model.contextWindow = 1000;
  assert.equal(
    await threshold._checkCompaction({ stopReason: "stop" }, false),
    false,
  );
  tokens = 980;
  assert.equal(
    await threshold._checkCompaction({ stopReason: "stop" }, false),
    "compacted",
  );

  let branch: any[] = [];
  const midTurn = makeThresholdSession({
    _lastAssistantMessage: {
      stopReason: "toolUse",
      timestamp: Date.now(),
      usage: { totalTokens: 900 },
    },
    agent: {
      state: {
        systemPrompt: "current system",
        messages: [{ role: "toolResult", content: "current" }],
        tools: [{ name: "owner" }],
      },
      async prepareNextTurn() {
        return {
          context: { fallback: true, tools: [{ name: "fallback" }] },
          thinkingLevel: "low",
        };
      },
    },
    sessionManager: {
      getBranch: () => branch,
      buildSessionContext: () => ({
        messages: [{ role: "user", content: "manager" }],
      }),
    },
    async _runAutoCompaction() {
      branch = [
        { type: "compaction", id: "new", timestamp: new Date().toISOString() },
      ];
      return false;
    },
  });
  runtime.applyRinCompactionPercentThreshold(midTurn, {
    calculateContextTokens: () => 900,
    estimateContextTokens: () => ({ tokens: 900 }),
    getLatestCompactionEntry: (entries: any[]) => entries.at(-1),
  });
  assert.deepEqual(await midTurn.agent.prepareNextTurn(), {
    context: {
      fallback: true,
      tools: [{ name: "owner" }],
      systemPrompt: "current system",
      messages: [{ role: "user", content: "manager" }],
    },
    thinkingLevel: "low",
  });

  midTurn._lastAssistantMessage = { stopReason: "stop", timestamp: Date.now() };
  assert.deepEqual(await midTurn.agent.prepareNextTurn(), {
    context: { fallback: true, tools: [{ name: "fallback" }] },
    thinkingLevel: "low",
  });
});

test("compaction reason, reload, shutdown, and settings wrappers remain idempotent and failure-safe", async () => {
  resetOwner();
  for (const invalid of [null, {}, { compact: "no" }]) {
    assert.doesNotThrow(() =>
      runtime.applyRinCompactionReasonTracking(invalid),
    );
  }
  const reasonEvents: any[] = [];
  const reasonSession: any = {
    __rinCurrentCompactionReason: "outer",
    async _runAutoCompaction(reason: string) {
      reasonEvents.push(["auto", reason, this.__rinCurrentCompactionReason]);
      throw new Error("owner auto failed");
    },
    async compact() {
      reasonEvents.push(["manual", this.__rinCurrentCompactionReason]);
      return "manual";
    },
  };
  runtime.applyRinCompactionReasonTracking(reasonSession);
  runtime.applyRinCompactionReasonTracking(reasonSession);
  await assert.rejects(
    reasonSession._runAutoCompaction("overflow"),
    /owner auto failed/,
  );
  assert.equal(reasonSession.__rinCurrentCompactionReason, "outer");
  assert.equal(await reasonSession.compact(), "manual");
  assert.equal(reasonSession.__rinCurrentCompactionReason, "outer");
  assert.deepEqual(reasonEvents, [
    ["auto", "overflow", "overflow"],
    ["manual", "manual"],
  ]);
  const defaultReasonSession: any = {
    async _runAutoCompaction() {
      assert.equal(this.__rinCurrentCompactionReason, "auto");
      return "default-auto";
    },
  };
  runtime.applyRinCompactionReasonTracking(defaultReasonSession);
  assert.equal(
    await defaultReasonSession._runAutoCompaction(""),
    "default-auto",
  );
  assert.equal(defaultReasonSession.__rinCurrentCompactionReason, undefined);

  for (const invalid of [null, {}, { subscribe() {} }, { reload() {} }]) {
    assert.doesNotThrow(() => runtime.applyAutoReloadAfterCompaction(invalid));
  }
  const listeners: any[] = [];
  const reloadEvents: string[] = [];
  const reloadSession: any = {
    subscribe(listener: any) {
      listeners.push(listener);
      return () => reloadEvents.push("unsubscribe");
    },
    async reload() {
      reloadEvents.push("reload");
      if (reloadEvents.length === 1) throw new Error("ignored reload");
    },
    async _runAutoCompaction() {
      listeners[0]({
        type: "compaction_end",
        result: { summary: "auto" },
        aborted: false,
      });
      return "auto";
    },
    async compact() {
      listeners[0]({
        type: "compaction_end",
        result: { summary: "manual" },
        aborted: false,
      });
      return "manual";
    },
  };
  runtime.applyAutoReloadAfterCompaction(reloadSession);
  runtime.applyAutoReloadAfterCompaction(reloadSession);
  listeners[0]({ type: "other" });
  listeners[0]({ type: "compaction_end", result: {}, aborted: true });
  listeners[0]({ type: "compaction_end", result: null, aborted: false });
  assert.equal(await reloadSession._runAutoCompaction(), "auto");
  assert.equal(await reloadSession.compact(), "manual");
  assert.deepEqual(reloadEvents, ["reload", "reload"]);

  assert.doesNotThrow(() => runtime.patchRinRuntimeSessionShutdown(null));
  const shutdownCalls: any[] = [];
  const shutdownRuntime: any = {
    session: {
      __rinCapabilities: {
        hasHandlers: () => false,
        emit: async (event: any) => shutdownCalls.push(["emit", event]),
      },
    },
    async teardownCurrent(...args: any[]) {
      shutdownCalls.push(["teardown", ...args]);
      return "teardown";
    },
  };
  runtime.patchRinRuntimeSessionShutdown(shutdownRuntime);
  runtime.patchRinRuntimeSessionShutdown(shutdownRuntime);
  assert.equal(await shutdownRuntime.teardownCurrent("owner"), "teardown");
  assert.deepEqual(shutdownCalls, [["teardown", "owner", undefined]]);

  const emitWithoutHasHandlers: any[] = [];
  const disposeOnly: any = {
    session: {
      __rinCapabilities: {
        emit: async (event: any) => emitWithoutHasHandlers.push(event),
      },
    },
    async dispose() {
      return "disposed";
    },
  };
  runtime.patchRinRuntimeSessionShutdown(disposeOnly);
  assert.equal(await disposeOnly.dispose(), "disposed");
  assert.equal(emitWithoutHasHandlers[0].reason, "quit");

  assert.doesNotThrow(() => runtime.applyRinSettingsDefaults(null));
  const settings: any = { settings: { steeringMode: "all" } };
  runtime.applyRinSettingsDefaults(settings);
  runtime.applyRinSettingsDefaults(settings);
  assert.equal(settings.__rinSettingsDefaultsApplied, true);
  const noGetter: any = { settings: {} };
  runtime.applyRinSettingsDefaults(noGetter);
  assert.equal(noGetter.getSteeringMode, undefined);
});

test("runtime exposes Rin metadata on extension lifecycle and command contexts", () => {
  const runner = {
    createContext: () => ({ kind: "lifecycle" }),
    createCommandContext: () => ({ kind: "command" }),
  };
  runtime.applyRinExtensionContextApi(
    {
      extensionRunner: runner,
      sessionManager: {
        __rinFrontend: { kind: "chat", key: "discord/1:2" },
      },
    },
    "/agent",
  );
  assert.deepEqual(runner.createContext().rin, {
    agentDir: "/agent",
    frontendIdentity: { kind: "chat", key: "discord/1:2" },
  });
  assert.equal(runner.createCommandContext().rin.agentDir, "/agent");
  runtime.applyRinExtensionContextApi({}, "/agent");
});
