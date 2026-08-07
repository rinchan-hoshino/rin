import { register } from "node:module";

const target = "dist/core/rin-lib/runtime.js";
const sources: Record<string, string> = {
  "@earendil-works/pi-ai/compat": `
    export async function completeSimple(model, context, options) {
      const owner = globalThis.__rinRuntimeOwner;
      owner.events.push(["complete-simple", model, context, options]);
      if (owner.completeSimpleError) throw owner.completeSimpleError;
      return owner.completeSimpleResponse;
    }
    export function isContextOverflow(message, contextWindow) {
      globalThis.__rinRuntimeOwner.events.push(["is-overflow", message, contextWindow]);
      return Boolean(globalThis.__rinRuntimeOwner.contextOverflow);
    }
  `,
  "./todo.js": `
    export default function todoCapability() { return { name: "todo-owner" }; }
  `,
  "../language.js": `
    export function readConfiguredLanguageFromSettings(agentDir) {
      globalThis.__rinRuntimeOwner.events.push(["read-language", agentDir]);
      return globalThis.__rinRuntimeOwner.language;
    }
    export function buildConfiguredLanguageSystemPrompt(language) {
      return language ? "Language owner: " + language : "";
    }
  `,
  "./agent-runtime.js": `
    function owner() { return globalThis.__rinRuntimeOwner; }
    export async function loadRinAgentRuntime() {
      owner().events.push(["load-agent-runtime"]);
      return {
        calculateContextTokens: (usage) => Number(usage?.totalTokens || 0),
        convertToLlm: (messages) => {
          owner().events.push(["convert-to-llm", messages]);
          return messages;
        },
        createAgentSessionRuntime: async (createRuntime, options) => {
          owner().events.push(["create-session-runtime", options]);
          const created = await createRuntime({
            cwd: options.cwd,
            agentDir: options.agentDir,
            sessionManager: options.sessionManager,
            sessionStartEvent: owner().sessionStartEvent,
          });
          const runtime = {
            session: created.session,
            modelFallbackMessage: owner().modelFallbackMessage,
            async teardownCurrent(reason, targetSessionFile) {
              owner().events.push(["runtime-teardown", reason, targetSessionFile]);
              return owner().teardownResult;
            },
            async dispose(...args) {
              owner().events.push(["runtime-dispose", ...args]);
              return owner().disposeResult;
            },
          };
          owner().runtime = runtime;
          return runtime;
        },
        createAgentSessionServices: async (options) => {
          owner().events.push(["create-services", options]);
          const services = {
            settingsManager: owner().servicesSettingsManager,
            modelRegistry: owner().modelRegistry,
            diagnostics: owner().diagnostics,
            resourceLoader: owner().resourceLoader,
          };
          owner().services = services;
          return services;
        },
        createAgentSessionFromServices: async (options) => {
          owner().events.push(["create-session", options]);
          if (owner().createSessionError) throw owner().createSessionError;
          const session = owner().makeSession(options);
          owner().session = session;
          return { session, ownerResult: true };
        },
        estimateContextTokens: (messages) => {
          owner().events.push(["estimate-context", messages]);
          return owner().estimatedContextTokens;
        },
        getLatestCompactionEntry: (entries) =>
          [...(entries || [])].reverse().find((entry) => entry?.type === "compaction") || null,
        serializeConversation: (messages) => {
          owner().events.push(["serialize", messages]);
          return (messages || []).map((message) => String(message?.text || message?.content || message?.role || "")).join("|");
        },
        SettingsManager: {
          create(cwd, agentDir) {
            owner().events.push(["settings-create", cwd, agentDir]);
            return owner().servicesSettingsManager;
          },
        },
        SessionManager: {
          create(cwd, sessionDir) {
            owner().events.push(["session-manager-create", cwd, sessionDir]);
            return owner().makeSessionManager(cwd, sessionDir);
          },
        },
      };
    }
  `,
  "./profile.js": `
    export const RIN_DIR_ENV = "RIN_DIR";
    export function resolveRuntimeProfile(input = {}) {
      const owner = globalThis.__rinRuntimeOwner;
      const result = {
        cwd: input.cwd || owner.profile.cwd,
        agentDir: input.agentDir || owner.profile.agentDir,
      };
      owner.events.push(["resolve-profile", input, result]);
      return result;
    }
    export function applyRuntimeProfileEnvironment(input) {
      globalThis.__rinRuntimeOwner.events.push(["apply-profile", input]);
      globalThis.__rinRuntimeOwner.lastProfile = input;
    }
    export function getRuntimeSessionDir(cwd, agentDir) {
      globalThis.__rinRuntimeOwner.events.push(["session-dir", cwd, agentDir]);
      return agentDir + "/sessions";
    }
  `,
  "../memory/index.js": `export default function memory(options) { globalThis.__rinRuntimeOwner.moduleOptions.memory = options; return { name: "memory-owner" }; }`,
  "../self-improve/index.js": `export default function selfImprove(options) { globalThis.__rinRuntimeOwner.moduleOptions.selfImprove = options; return { name: "self-improve-owner" }; }`,
  "../task/index.js": `export default function task() { return { name: "task-owner" }; }`,
  "../token-usage/index.js": `export default function tokenUsage(options) { globalThis.__rinRuntimeOwner.moduleOptions.tokenUsage = options; return { name: "token-usage-owner" }; }`,
  "../chat/index.js": `export default function chat() { return { name: "chat-owner" }; }`,
  "../rin-frontend-sdk/frontend-identity.js": `
    export function normalizeFrontendIdentity(value) {
      globalThis.__rinRuntimeOwner.events.push(["normalize-frontend", value]);
      return value?.kind && value?.key ? { kind: String(value.kind), key: String(value.key) } : undefined;
    }
  `,
  "./capability-session.js": `
    export function createRinCapabilitySet(options) {
      const owner = globalThis.__rinRuntimeOwner;
      owner.events.push(["create-capability-set", options]);
      owner.capabilityOptions = options;
      owner.capabilityDefinitions = options.definitions;
      return {
        getToolDefinitions() { return owner.toolDefinitions; },
        async emit(event) { owner.events.push(["capability-set-emit", event]); },
        hasHandlers(type) { return owner.capabilityHandlerTypes.has(type); },
      };
    }
    export async function attachRinCapabilitiesToSession(session, options) {
      const owner = globalThis.__rinRuntimeOwner;
      owner.events.push(["attach-capabilities", session, options]);
      session.__rinCapabilities = options.capabilitySet;
      owner.attachOptions = options;
    }
  `,
  "../self-improve/store.js": `
    export function compileSelfImproveSync(options, agentDir) {
      const owner = globalThis.__rinRuntimeOwner;
      owner.events.push(["compile-self-improve", options, agentDir]);
      if (owner.selfImproveError) throw owner.selfImproveError;
      return owner.selfImproveCompiled;
    }
  `,
  "../session/fork.js": `
    export const EPHEMERAL_FORK_DISABLE_ROUTINE_COMPACTION_KEY = Symbol.for("rin.ephemeralFork.disableRoutineCompaction");
    export const EPHEMERAL_FORK_SOURCE_CONTEXT_KEY = Symbol.for("rin.ephemeralFork.sourceContext");
  `,
  "../self-improve/format.js": `
    export function buildSystemPromptSelfImprove(compiled) {
      globalThis.__rinRuntimeOwner.events.push(["format-self-improve", compiled]);
      return compiled?.prompt || "";
    }
  `,
  "../rin-frontend-sdk/prompt-context.js": `
    export function formatPromptContextSystemPromptBlock(value) {
      if (!value || typeof value !== "object" || !Object.keys(value).length) return "";
      return "Prompt context owner: " + JSON.stringify(value);
    }
    export function formatPromptContext(value, text) {
      globalThis.__rinRuntimeOwner.events.push(["inject-context", value, text]);
      return value ? "[owner-context]\\n" + text : text;
    }
  `,
  "./provider-context.js": `
    export function buildProviderBoundContextEvent(event, options) {
      globalThis.__rinRuntimeOwner.events.push(["provider-context-event", event, options]);
      return { ...event, ownerCwd: options.cwd };
    }
    export function estimateProviderBoundContextTokens(messages, estimator) {
      const result = typeof estimator === "function" ? estimator(messages) : undefined;
      return Number(result?.tokens ?? result ?? messages?.length ?? 0);
    }
    export function mapMessagesToProviderBoundContext(messages, providerMessages) {
      globalThis.__rinRuntimeOwner.events.push(["map-provider-context", messages, providerMessages]);
      return globalThis.__rinRuntimeOwner.mappedMessages || messages;
    }
  `,
  "../pi/session-host.js": `
    function owner() { return globalThis.__rinRuntimeOwner; }
    export function getPiSessionPromptToolState(session, toolNames) {
      owner().events.push(["prompt-tool-state", session, toolNames]);
      if (owner().promptToolStateError) throw owner().promptToolStateError;
      return owner().promptToolState;
    }
    export function getPiSessionResourcePromptState(session) {
      owner().events.push(["resource-prompt-state", session]);
      return owner().resourcePromptState;
    }
    export function bindPiSessionSystemPromptRebuilder(session) {
      if (typeof session?._rebuildSystemPrompt !== "function") return undefined;
      return session._rebuildSystemPrompt.bind(session);
    }
    export function replacePiSessionSystemPromptRebuilder(session, fn) { session._rebuildSystemPrompt = fn.bind(session); }
    export function bindPiSessionToolRegistryRefresher(session) { return typeof session?._refreshToolRegistry === "function" ? session._refreshToolRegistry.bind(session) : undefined; }
    export function replacePiSessionToolRegistryRefresher(session, fn) { session._refreshToolRegistry = fn.bind(session); }
    export function readPiSessionBaseSystemPrompt(session) { return String(session?._baseSystemPrompt || ""); }
    export function readPiSessionBaseSystemPromptOptions(session, fallbackCwd = "") { return session?._baseSystemPromptOptions || (fallbackCwd ? { cwd: fallbackCwd } : {}); }
    export function writePiSessionBaseSystemPrompt(session, prompt) {
      owner().events.push(["write-base-prompt", prompt]);
      session._baseSystemPrompt = String(prompt || "");
    }
    export function bindPiSessionCompactionChecker(session) {
      return typeof session?._checkCompaction === "function" ? session._checkCompaction.bind(session) : undefined;
    }
    export function replacePiSessionCompactionChecker(session, fn) { session._checkCompaction = fn.bind(session); }
    export function bindPiSessionAutoCompactor(session) {
      return typeof session?._runAutoCompaction === "function" ? session._runAutoCompaction.bind(session) : undefined;
    }
    export function replacePiSessionAutoCompactor(session, fn) { session._runAutoCompaction = fn.bind(session); }
    export async function runPiSessionAutoCompaction(session, reason, retry) {
      return await session._runAutoCompaction(reason, retry);
    }
    export async function runPiNativeCompactionWithoutFileSummary(session, event) { owner().events.push(["native-compaction", session, event]); return { compacted: true }; }
    export async function getPiSessionCompactionRequestAuth(session, model) {
      owner().events.push(["compaction-auth", session, model]);
      return owner().compactionAuth;
    }
    export function patchPiSessionManagerConversationPersistence(manager) {
      owner().events.push(["patch-persistence", manager]);
      manager.__ownerPersistencePatched = true;
    }
  `,
};

const urls = Object.fromEntries(
  Object.entries(sources).map(([specifier, source]) => [
    specifier,
    `data:text/javascript,${encodeURIComponent(source)}`,
  ]),
);
const hook = `
const target=${JSON.stringify(target)};const urls=${JSON.stringify(urls)};
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith(target) && urls[specifier]) {
    return { url: urls[specifier], shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith(target)) return loaded;
  return {
    ...loaded,
    source: String(loaded.source) + "\\nexport { isLegacyGeneratedLanguageTag as __rinOwnerIsLegacyGeneratedLanguageTag, isInsideMarkdownFence as __rinOwnerIsInsideMarkdownFence, historicalPromptLineValue as __rinOwnerHistoricalPromptLineValue, historicalReadmeRoot as __rinOwnerHistoricalReadmeRoot, historicalJoinedRoot as __rinOwnerHistoricalJoinedRoot, historicalAgentRoot as __rinOwnerHistoricalAgentRoot, stripLegacyConfiguredLanguagePrompt as __rinOwnerStripLegacyConfiguredLanguagePrompt, findPersistedSessionBaseSystemPrompt as __rinOwnerFindPersistedSessionBaseSystemPrompt, hasLegacyPromptLayerBoundary as __rinOwnerHasLegacyPromptLayerBoundary, getSessionActiveToolNames as __rinOwnerGetSessionActiveToolNames };\\n",
    shortCircuit: true,
  };
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);

(globalThis as any).__rinRuntimeOwner ||= {
  events: [],
  moduleOptions: {},
  profile: { cwd: "/owner/work", agentDir: "/owner/agent" },
  language: "zh_CN",
  selfImproveCompiled: { prompt: "Self improve owner" },
  completeSimpleResponse: {
    stopReason: "stop",
    content: [{ type: "text", text: "owner summary" }],
  },
  estimatedContextTokens: { tokens: 12 },
  mappedMessages: undefined,
  compactionAuth: { apiKey: "owner-key", headers: { owner: "yes" } },
  promptToolState: {
    validToolNames: ["read", "bash"],
    toolSnippets: { read: "Read owner", bash: "Run owner" },
    promptGuidelines: ["Owner guideline.", "Be concise in your responses"],
  },
  resourcePromptState: {
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
    ],
    agentsFiles: [{ path: "/owner/AGENTS.md", content: "Owner project" }],
  },
  servicesSettingsManager: { settings: {} },
  modelRegistry: {
    find(provider: string, id: string) {
      const owner = (globalThis as any).__rinRuntimeOwner;
      return owner.knownModels.get(`${provider}/${id}`);
    },
    hasConfiguredAuth(model: any) {
      return model?.hasAuth !== false;
    },
  },
  knownModels: new Map(),
  diagnostics: [{ level: "owner" }],
  resourceLoader: { getExtensions: () => [{ id: "owner-extension" }] },
  toolDefinitions: [{ name: "owner_tool" }],
  capabilityHandlerTypes: new Set(["session_shutdown"]),
  sessionStartEvent: {
    reason: "resume",
    previousSessionFile: "/owner/previous.jsonl",
  },
  modelFallbackMessage: "owner fallback",
  teardownResult: "owner teardown",
  disposeResult: "owner dispose",
  makeSessionManager(cwd: string) {
    const owner = (globalThis as any).__rinRuntimeOwner;
    const branch: any[] = [];
    return {
      __ownerBranch: branch,
      getCwd: () => cwd,
      getBranch: () => branch,
      getSessionName: () => owner.currentSessionName || "",
      appendSessionInfo(name: string) {
        owner.events.push(["session-name", name]);
        owner.currentSessionName = name;
      },
      appendCustomEntry(customType: string, data: any) {
        owner.events.push(["append-custom", customType, data]);
        branch.push({ type: "custom", customType, data });
      },
      buildSessionContext: () => ({ messages: owner.providerMessages || [] }),
    };
  },
  makeSession(options: any) {
    const owner = (globalThis as any).__rinRuntimeOwner;
    const sessionManager = options.sessionManager;
    const session: any = {
      sessionManager,
      settingsManager: owner.servicesSettingsManager,
      resourceLoader: owner.resourceLoader,
      modelRegistry: owner.modelRegistry,
      model: options.model || owner.sessionModel,
      thinkingLevel: options.thinkingLevel || "medium",
      messages: owner.sessionMessages || [],
      _baseSystemPromptOptions: {
        selectedTools: [...(owner.activeToolNames || ["read", "bash"])],
        toolSnippets: { read: "Read owner", bash: "Run owner" },
        promptGuidelines: ["Owner guideline."],
        cwd: options.cwd || process.cwd(),
      },
      agent: {
        state: {
          messages: owner.providerMessages || [],
          tools: [{ name: "owner_tool" }],
          systemPrompt: "owner agent system",
        },
        streamFn: owner.streamFn,
        async transformContext(messages: any[]) {
          owner.events.push(["native-transform", messages]);
          return messages;
        },
        async prepareNextTurn() {
          return { context: { owner: "native" }, thinkingLevel: "low" };
        },
      },
      get isCompacting() {
        return Boolean(owner.isCompacting);
      },
      getActiveToolNames: () => owner.activeToolNames || ["read", "bash"],
      getContextUsage: () => owner.contextUsage,
      _rebuildSystemPrompt(toolNames: string[]) {
        owner.events.push(["native-rebuild", toolNames]);
        this._baseSystemPromptOptions.selectedTools = [...toolNames];
        const snippets = this._baseSystemPromptOptions.toolSnippets;
        const tools =
          toolNames
            .filter((name: string) => snippets[name])
            .map((name: string) => `- ${name}: ${snippets[name]}`)
            .join("\n") || "(none)";
        const prompt = [
          "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
          `Available tools:\n${tools}`,
          "Guidelines:\n- Owner guideline.",
          "Pi documentation owner",
          `Current working directory: ${String(this._baseSystemPromptOptions.cwd).replace(/\\\\/g, "/")}`,
        ].join("\n\n");
        this._baseSystemPrompt = prompt;
        return prompt;
      },
      async _checkCompaction(message: any, skip?: boolean) {
        owner.events.push(["native-check", message, skip]);
        return owner.nativeCheckResult;
      },
      async _runAutoCompaction(reason: string, retry: boolean) {
        owner.events.push([
          "native-auto",
          reason,
          retry,
          this.__rinCurrentCompactionReason,
        ]);
        if (owner.autoCompactionError) throw owner.autoCompactionError;
        return owner.autoCompactionResult;
      },
      async prompt(text: string, promptOptions?: any) {
        owner.events.push(["native-prompt", text, promptOptions]);
        return owner.promptResult;
      },
      async reload(...args: any[]) {
        owner.events.push(["native-reload", ...args]);
        return owner.reloadResult;
      },
      async compact(...args: any[]) {
        owner.events.push([
          "native-compact",
          ...args,
          this.__rinCurrentCompactionReason,
        ]);
        return owner.compactResult;
      },
      subscribe(listener: any) {
        owner.listener = listener;
        owner.events.push(["subscribe"]);
        return () => owner.events.push(["unsubscribe"]);
      },
      async sendCustomMessage(message: any, messageOptions: any) {
        owner.events.push(["custom-message", message, messageOptions]);
        if (owner.customMessageError) throw owner.customMessageError;
      },
      __rinEmitCoreEvent(event: any) {
        owner.events.push(["core-event", event]);
      },
    };
    return session;
  },
  contextUsage: { tokens: 10, contextWindow: 100, percent: 10 },
  sessionModel: {
    provider: "owner",
    id: "model",
    contextWindow: 20_000,
    maxTokens: 2_000,
    reasoning: true,
  },
  activeToolNames: ["read", "bash"],
  nativePrompt: "native owner prompt",
  nativeCheckResult: "native-check-owner",
  autoCompactionResult: "owner-compacted",
  promptResult: "owner-prompted",
  reloadResult: "owner-reloaded",
  compactResult: "owner-manual-compacted",
};
