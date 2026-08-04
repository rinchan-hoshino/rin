import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
const selfImproveMaintainerMod = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "self-improve", "maintainer.js"),
  ).href
);
function waitForTimers() {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

function pruningTailPadding(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    role: "assistant",
    content: `tail padding ${index + 1}`,
  }));
}

test("provider-bound pruning is the sole builtin context-transform capability", () => {
  const definitions = runtimeMod.createRinCapabilityDefinitions({
    cwd: rootDir,
    agentDir: rootDir,
  });
  const contextCapabilities = definitions
    .filter((definition) => definition.hooks?.context?.length)
    .map((definition) => definition.name);

  assert.deepEqual(contextCapabilities.slice(-1), [
    "rin_provider_bound_context",
  ]);
  assert.equal(contextCapabilities.includes("self_improve"), false);
});

test("self-improve forks preserve raw tool output throughout the active turn window", async () => {
  const definitions = runtimeMod.createRinCapabilityDefinitions({
    cwd: rootDir,
    agentDir: rootDir,
  });
  const context = definitions.find(
    (definition) => definition.name === "rin_provider_bound_context",
  )?.hooks?.context?.[0];
  assert.equal(typeof context, "function");
  const openingToolResult = {
    role: "toolResult",
    content: "x".repeat(25_000),
  };
  const event = {
    type: "context",
    messages: [
      { role: "user", content: "turn 1" },
      openingToolResult,
      ...pruningTailPadding(20),
      { role: "assistant", content: "done 1" },
      { role: "user", content: "turn 2" },
      { role: "assistant", content: "done 2" },
      { role: "user", content: "turn 3" },
      { role: "assistant", content: "done 3" },
      { role: "user", content: "turn 4" },
      { role: "assistant", content: "done 4" },
      { role: "user", content: "distill the completed source window" },
    ],
  };

  const ordinarilyPruned = await context(event, { cwd: rootDir });
  assert.equal(ordinarilyPruned.messages[1].content, "old tool result omitted");
  const preserved = await context(event, {
    cwd: rootDir,
    sessionManager: {
      [sessionForkMod.EPHEMERAL_FORK_PROTECT_SOURCE_WINDOW_TURNS_KEY]: 4,
    },
  });
  assert.equal(preserved, undefined);
  assert.equal(event.messages[1], openingToolResult);
});

test("getManagedSkillPaths includes agent memory skills and builtin skills", () => {
  const paths = runtimeMod.getManagedSkillPaths("/tmp/rin-home");
  assert.deepEqual(paths, [
    "/tmp/rin-home/self_improve/skills",
    "/tmp/rin-home/docs/rin/builtin-skills",
  ]);
});

test("Rin core registers the private session note capability", () => {
  const definitions = runtimeMod.createRinCapabilityDefinitions({
    cwd: "/tmp/rin-note-capability",
    agentDir: "/tmp/rin-note-capability-agent",
    getThinkingLevel: () => "medium",
    sendMessage: () => {},
  });

  const note = definitions.find((definition) => definition.name === "note");
  assert.ok(note);
  assert.deepEqual(
    note.tools?.map((tool) => tool.name),
    ["note"],
  );
});

test("self-improve maintainer exposes only read and library-scoped mutation tools", async () => {
  const agentDir = await fs.mkdtemp("/tmp/rin-self-improve-tools-");
  const libraryRoot = path.join(agentDir, "self_improve");
  await fs.mkdir(libraryRoot, { recursive: true });
  const outsideFile = path.join(agentDir, "outside.txt");
  const configured = await runtimeMod.createConfiguredAgentSession({
    cwd: rootDir,
    agentDir,
    settingSources: [],
    extensionPaths: [],
    noExtensions: true,
    noSkillDiscovery: true,
    ...selfImproveMaintainerMod.createSelfImproveMaintainerToolOptions(
      agentDir,
    ),
  });
  try {
    assert.deepEqual(configured.session.getActiveToolNames().sort(), [
      "edit",
      "read",
      "write",
    ]);
    const write = configured.session.agent.state.tools.find(
      (tool) => tool.name === "write",
    );
    assert.ok(write);
    await assert.rejects(
      () =>
        write.execute(
          "test-call",
          { path: outsideFile, content: "forbidden" },
          new AbortController().signal,
        ),
      /self_improve_mutation_outside_library/,
    );
  } finally {
    await configured.session.abort().catch(() => undefined);
    await configured.runtime.dispose();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("Rin delegates compaction generation to native Pi without file XML", async () => {
  const nativeResult = {
    summary: "native summary",
    firstKeptEntryId: "keep",
    tokensBefore: 1234,
    details: { readFiles: ["read.ts"], modifiedFiles: ["edit.ts"] },
  };
  const calls: any[] = [];
  const definitions = runtimeMod.createRinCapabilityDefinitions({
    cwd: "/tmp/rin-native-compaction",
    agentDir: "/tmp/rin-native-compaction-agent",
    getThinkingLevel: () => "medium",
    sendMessage: () => {},
    compactWithPiNative: async (event: any) => {
      calls.push(event);
      return nativeResult;
    },
  });
  const definition = definitions.find(
    (entry) => entry.name === "rin_native_compaction",
  );
  const hook = definition?.hooks?.session_before_compact?.[0];
  assert.equal(typeof hook, "function");
  const event = { type: "session_before_compact", reason: "threshold" };
  assert.deepEqual(await hook(event), { compaction: nativeResult });
  assert.deepEqual(calls, [event]);

  const runtimeText = await fs.readFile(
    path.join(rootDir, "dist", "core", "rin-lib", "runtime.js"),
    "utf8",
  );
  assert.equal(runtimeText.includes("RIN_COMPACTION_SYSTEM_PROMPT"), false);
  assert.equal(
    runtimeText.includes("completeRinCompactionSummaryBudgeted"),
    false,
  );
});

test("compaction reason tracking annotates native before-compact hooks", async () => {
  const calls = [];
  const session = {
    async compact() {
      calls.push(`manual:${this.__rinCurrentCompactionReason}`);
    },
    async _runAutoCompaction(reason, willRetry) {
      calls.push(
        `auto:${reason}:${willRetry}:${this.__rinCurrentCompactionReason}`,
      );
    },
  };

  runtimeMod.applyRinCompactionReasonTracking(session);
  await session.compact();
  await session._runAutoCompaction("threshold", false);

  assert.deepEqual(calls, ["manual:manual", "auto:threshold:false:threshold"]);
  assert.equal(session.__rinCurrentCompactionReason, undefined);
});

test("configured Rin sessions install the native Pi compaction delegate", async () => {
  const agentDir = await fs.mkdtemp("/tmp/rin-native-compaction-");
  const configured = await runtimeMod.createConfiguredAgentSession({
    cwd: agentDir,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    noTools: true,
  });
  try {
    assert.equal(
      configured.session.extensionRunner.hasHandlers("session_before_compact"),
      true,
    );
  } finally {
    try {
      await configured.runtime?.dispose?.();
    } catch {}
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("configured Rin sessions disable completion-time threshold compaction only", async () => {
  const agentDir = await fs.mkdtemp("/tmp/rin-percent-session-");
  await fs.writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify(
      {
        defaultProvider: "openai-codex",
        defaultModel: "gpt-5.5",
        compaction: { enabled: true },
      },
      null,
      2,
    ),
  );

  const configured = await runtimeMod.createConfiguredAgentSession({
    cwd: agentDir,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    noTools: true,
  });
  try {
    const session = configured.session;
    const model = {
      provider: "test",
      id: "model",
      contextWindow: 200_000,
    };
    // The isolated agent dir has no provider credentials, so pin the model
    // instead of letting ambient model availability decide this threshold.
    session.agent.state.model = model;
    assert.equal(
      Object.prototype.hasOwnProperty.call(session, "_checkCompaction"),
      true,
    );
    assert.equal(session._checkCompaction?.name, "patchedRinPercentCompaction");

    const calls: Array<[string, boolean]> = [];
    session._runAutoCompaction = async (reason: string, willRetry: boolean) => {
      calls.push([reason, willRetry]);
      return "compacted";
    };

    const assistantMessage = {
      role: "assistant",
      stopReason: "toolUse",
      timestamp: Date.now(),
      provider: model.provider,
      model: model.id,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 179_998,
        cacheWrite: 0,
        totalTokens: 180_000,
      },
    };

    assert.equal(await session._checkCompaction(assistantMessage), false);
    assert.deepEqual(calls, []);

    const result = await session._checkCompaction(assistantMessage, false);

    assert.equal(result, "compacted");
    assert.deepEqual(calls, [["threshold", false]]);
  } finally {
    try {
      await configured.runtime?.dispose?.();
    } catch {}
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("Rin percent compaction defaults to 85 percent", async () => {
  let contextTokens = 849;
  let nativeChecks = 0;
  let autoCompactions = 0;
  const session = {
    settingsManager: {
      getCompactionSettings() {
        return { enabled: true };
      },
    },
    model: { contextWindow: 1000 },
    sessionManager: {
      getBranch() {
        return [];
      },
    },
    async _checkCompaction() {
      nativeChecks += 1;
      return false;
    },
    async _runAutoCompaction(reason: string, retry: boolean) {
      autoCompactions += 1;
      return `${reason}:${retry}`;
    },
  };

  runtimeMod.applyRinCompactionPercentThreshold(session, {
    calculateContextTokens: () => contextTokens,
    estimateContextTokens: () => ({ tokens: contextTokens }),
    getLatestCompactionEntry: () => undefined,
  });

  assert.equal(
    await session._checkCompaction({ timestamp: Date.now() }, false),
    false,
  );
  assert.equal(nativeChecks, 0);
  assert.equal(autoCompactions, 0);

  contextTokens = 850;
  assert.equal(
    await session._checkCompaction({ timestamp: Date.now() }, false),
    "threshold:false",
  );
  assert.equal(nativeChecks, 0);
  assert.equal(autoCompactions, 1);
});

test("Rin percent compaction respects the earlier Pi reserve-token threshold", async () => {
  let contextTokens = 799;
  const calls: string[] = [];
  const session = {
    settingsManager: {
      getCompactionSettings() {
        return { enabled: true, triggerPercent: 0.85, reserveTokens: 200 };
      },
    },
    model: { contextWindow: 1000 },
    sessionManager: {
      getBranch() {
        return [];
      },
    },
    async _checkCompaction() {
      return false;
    },
    async _runAutoCompaction(reason: string, retry: boolean) {
      calls.push(`${reason}:${retry}`);
      return "compacted";
    },
  };

  runtimeMod.applyRinCompactionPercentThreshold(session, {
    calculateContextTokens: () => contextTokens,
    estimateContextTokens: () => ({ tokens: contextTokens }),
    getLatestCompactionEntry: () => undefined,
  });

  assert.equal(
    await session._checkCompaction({ timestamp: Date.now() }, false),
    false,
  );
  contextTokens = 800;
  assert.equal(
    await session._checkCompaction({ timestamp: Date.now() }, false),
    "compacted",
  );
  assert.deepEqual(calls, ["threshold:false"]);
});

test("Rin percent compaction estimates error contexts from pruned provider context", async () => {
  let autoCompactions = 0;
  let nativeChecks = 0;
  const session = {
    settingsManager: {
      getCompactionSettings() {
        return { enabled: true };
      },
    },
    model: { provider: "test", id: "model", contextWindow: 1000 },
    sessionManager: {
      getBranch() {
        return [];
      },
    },
    agent: {
      state: {
        messages: [
          { role: "user", content: "old" },
          { role: "toolResult", content: "huge old output" },
          ...pruningTailPadding(8),
          { role: "user", content: "recent 1" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "recent 2" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "recent 3" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "recent 4" },
          { role: "assistant", content: "temporary upstream error" },
        ],
      },
    },
    async _checkCompaction() {
      nativeChecks += 1;
      return "native";
    },
    async _runAutoCompaction() {
      autoCompactions += 1;
      return "compacted";
    },
  };

  runtimeMod.applyRinCompactionPercentThreshold(session, {
    calculateContextTokens: () => 0,
    estimateContextTokens: (messages: any[]) => ({
      tokens: messages.some((message) => message.content === "huge old output")
        ? 900
        : 10,
    }),
    getLatestCompactionEntry: () => undefined,
  });

  assert.equal(
    await session._checkCompaction(
      {
        stopReason: "error",
        provider: "test",
        model: "model",
        timestamp: Date.now(),
        content: "temporary upstream error",
      },
      false,
    ),
    false,
  );
  assert.equal(nativeChecks, 0);
  assert.equal(autoCompactions, 0);
});

test("Rin context usage reports the pruned provider-bound estimate", () => {
  const session = {
    model: { contextWindow: 1000 },
    messages: [
      { role: "user", content: "old" },
      { role: "toolResult", content: "huge old output" },
      { role: "user", content: "recent 1" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "recent 2" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "recent 3" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "recent 4" },
      { role: "assistant", content: "ok" },
      ...pruningTailPadding(8),
    ],
    getContextUsage() {
      return { tokens: 900, contextWindow: 1000, percent: 90 };
    },
  };

  runtimeMod.applyRinPrunedContextUsage(session, {
    estimateContextTokens: (messages: any[]) => ({
      tokens: messages.some((message) => message.content === "huge old output")
        ? 900
        : 10,
    }),
  });

  assert.deepEqual(session.getContextUsage(), {
    tokens: 10,
    contextWindow: 1000,
    percent: 1,
  });
});

test("Rin 85% provider preflight calls Pi overflow auto-compaction before the provider call", async () => {
  const calls: string[] = [];
  const transformInputs: any[][] = [];
  const originalMessages = [
    { role: "user", content: "turn 1" },
    { role: "toolResult", content: "huge old output" },
    { role: "assistant", content: "done 1" },
    { role: "user", content: "turn 2" },
    { role: "assistant", content: "done 2" },
    { role: "user", content: "turn 3" },
    { role: "assistant", content: "done 3" },
    { role: "user", content: "turn 4" },
    { role: "assistant", content: "done 4" },
    { role: "user", content: "turn 5" },
    { role: "toolResult", content: "fresh tool output" },
  ];
  const compactedMessages = [
    { role: "compactionSummary", summary: "summary" },
    { role: "user", content: "turn 5" },
    { role: "toolResult", content: "fresh tool output" },
  ];
  const session: any = {
    settingsManager: {
      getCompactionSettings() {
        return { enabled: true, triggerPercent: 0.85 };
      },
    },
    model: { contextWindow: 1000 },
    get isCompacting() {
      return false;
    },
    agent: {
      state: { messages: originalMessages },
      transformContext: async (messages: any[]) => {
        transformInputs.push(messages);
        return messages.some((message) => message.content === "huge old output")
          ? messages.map((message) =>
              message.content === "huge old output"
                ? { ...message, content: "old tool result omitted" }
                : message,
            )
          : messages;
      },
    },
    sessionManager: {
      buildSessionContext() {
        return { messages: session.agent.state.messages };
      },
    },
    async _runAutoCompaction(reason: string, willRetry: boolean) {
      calls.push(`${reason}:${willRetry}`);
      this.agent.state.messages = compactedMessages;
      return true;
    },
  };

  runtimeMod.applyRinProviderOverflowPreflight(session, {
    estimateContextTokens: (messages: any[]) => ({
      tokens: messages.some((message) => message.summary === "summary")
        ? 10
        : 900,
    }),
  });

  const loopMessages = originalMessages.slice();
  const providerMessages = await session.agent.transformContext(loopMessages);

  assert.deepEqual(calls, ["overflow:true"]);
  assert.deepEqual(loopMessages, compactedMessages);
  assert.equal(providerMessages, compactedMessages);
  assert.equal(transformInputs.length, 2);
  assert.equal(
    session.agent.state.messages.some(
      (message: any) => message.stopReason === "error",
    ),
    false,
  );
});

test("Rin provider preflight ignores stale assistant usage kept after compaction", async () => {
  const calls: string[] = [];
  const staleAssistant = {
    role: "assistant",
    content: [{ type: "toolCall", name: "bash" }],
    stopReason: "toolUse",
    timestamp: 1000,
    usage: { totalTokens: 900 },
  };
  const messages = [
    { role: "compactionSummary", summary: "summary", timestamp: 2000 },
    staleAssistant,
    { role: "toolResult", content: "fresh output" },
  ];
  const session: any = {
    settingsManager: {
      getCompactionSettings() {
        return { enabled: true, triggerPercent: 0.85 };
      },
    },
    model: { contextWindow: 1000 },
    get isCompacting() {
      return false;
    },
    agent: {
      state: { messages },
      transformContext: async (nextMessages: any[]) => nextMessages,
    },
    sessionManager: {
      buildSessionContext() {
        return { messages: session.agent.state.messages };
      },
    },
    async _runAutoCompaction(reason: string, willRetry: boolean) {
      calls.push(`${reason}:${willRetry}`);
      return true;
    },
  };

  runtimeMod.applyRinProviderOverflowPreflight(session, {
    estimateContextTokens: (nextMessages: any[]) => ({
      tokens: nextMessages.some((message) => message.usage?.totalTokens === 900)
        ? 900
        : 10,
    }),
  });

  assert.equal(await session.agent.transformContext(messages), messages);
  assert.deepEqual(calls, []);
});

test("Rin provider preflight still uses post-compaction assistant usage", async () => {
  const calls: string[] = [];
  const messages = [
    { role: "compactionSummary", summary: "summary", timestamp: 2000 },
    {
      role: "assistant",
      content: "new tool use",
      stopReason: "toolUse",
      timestamp: 3000,
      usage: { totalTokens: 900 },
    },
    { role: "toolResult", content: "fresh output" },
  ];
  const compactedMessages = [{ role: "user", content: "kept" }];
  const session: any = {
    settingsManager: {
      getCompactionSettings() {
        return { enabled: true, triggerPercent: 0.85 };
      },
    },
    model: { contextWindow: 1000 },
    get isCompacting() {
      return false;
    },
    agent: {
      state: { messages },
      transformContext: async (nextMessages: any[]) => nextMessages,
    },
    sessionManager: {
      buildSessionContext() {
        return { messages: session.agent.state.messages };
      },
    },
    async _runAutoCompaction(reason: string, willRetry: boolean) {
      calls.push(`${reason}:${willRetry}`);
      this.agent.state.messages = compactedMessages;
      return true;
    },
  };

  runtimeMod.applyRinProviderOverflowPreflight(session, {
    estimateContextTokens: (nextMessages: any[]) => ({
      tokens: nextMessages.some((message) => message.usage?.totalTokens === 900)
        ? 900
        : 10,
    }),
  });

  const loopMessages = messages.slice();
  const providerMessages = await session.agent.transformContext(loopMessages);

  assert.deepEqual(calls, ["overflow:true"]);
  assert.deepEqual(loopMessages, compactedMessages);
  assert.equal(providerMessages, compactedMessages);
});

test("Rin 85% provider preflight can run again after a new tail message", async () => {
  const calls: string[] = [];
  const firstTail = { role: "toolResult", content: "first huge output" };
  const secondTail = { role: "toolResult", content: "second huge output" };
  const firstMessages = [
    { role: "user", content: "old" },
    { role: "assistant", content: "done" },
    { role: "user", content: "current" },
    firstTail,
  ];
  const secondMessages = [{ role: "user", content: "current" }, secondTail];
  const compactedMessages = [{ role: "user", content: "kept" }];
  const session: any = {
    settingsManager: {
      getCompactionSettings() {
        return { enabled: true, triggerPercent: 0.85 };
      },
    },
    model: { contextWindow: 1000 },
    get isCompacting() {
      return false;
    },
    agent: {
      state: { messages: firstMessages },
      transformContext: async (nextMessages: any[]) => nextMessages,
    },
    sessionManager: {
      buildSessionContext() {
        return { messages: session.agent.state.messages };
      },
    },
    async _runAutoCompaction(reason: string, willRetry: boolean) {
      calls.push(`${reason}:${willRetry}`);
      this.agent.state.messages = compactedMessages;
      return true;
    },
  };

  runtimeMod.applyRinProviderOverflowPreflight(session, {
    estimateContextTokens: (messages: any[]) => ({
      tokens: messages === compactedMessages ? 10 : 900,
    }),
  });

  await session.agent.transformContext(firstMessages);
  session.agent.state.messages = secondMessages;
  await session.agent.transformContext(secondMessages);

  assert.deepEqual(calls, ["overflow:true", "overflow:true"]);
});

test("Rin 85% mid-turn threshold compacts between tool-use turns", async () => {
  const calls: string[] = [];
  let branch: any[] = [];
  const assistantMessage = {
    role: "assistant",
    stopReason: "toolUse",
    timestamp: Date.now(),
    usage: { totalTokens: 900 },
    provider: "openai-codex",
    model: "gpt-5.5",
    content: [{ type: "toolCall", name: "bash" }],
  };
  const compactedMessages = [
    { role: "compactionSummary", summary: "summary" },
    { role: "toolResult", content: "fresh output" },
  ];
  const session: any = {
    settingsManager: {
      getCompactionSettings() {
        return { enabled: true, triggerPercent: 0.85 };
      },
    },
    model: { contextWindow: 1000 },
    get isCompacting() {
      return false;
    },
    agent: {
      state: {
        systemPrompt: "system prompt",
        messages: [assistantMessage],
        tools: [{ name: "bash" }],
      },
      prepareNextTurn: async () => ({ thinkingLevel: "low" }),
    },
    _lastAssistantMessage: assistantMessage,
    sessionManager: {
      getBranch() {
        return branch;
      },
      buildSessionContext() {
        return { messages: session.agent.state.messages };
      },
    },
    async _checkCompaction() {
      return false;
    },
    async _runAutoCompaction(reason: string, willRetry: boolean) {
      calls.push(`${reason}:${willRetry}`);
      branch = [
        {
          type: "compaction",
          id: "compact-1",
          timestamp: new Date().toISOString(),
        },
      ];
      this.agent.state.messages = compactedMessages;
      return false;
    },
  };

  runtimeMod.applyRinCompactionPercentThreshold(session, {
    calculateContextTokens: (usage: any) => usage.totalTokens,
    estimateContextTokens: () => ({ tokens: 900 }),
    getLatestCompactionEntry: (entries: any[]) =>
      entries.find((entry) => entry.type === "compaction") || null,
  });

  const snapshot = await session.agent.prepareNextTurn();

  assert.deepEqual(calls, ["threshold:false"]);
  assert.equal(snapshot.thinkingLevel, "low");
  assert.deepEqual(snapshot.context, {
    systemPrompt: "system prompt",
    messages: compactedMessages,
    tools: [{ name: "bash" }],
  });
});

test("Rin 85% provider preflight does not compact from an assistant-final context", async () => {
  const calls: string[] = [];
  const messages = [
    { role: "user", content: "turn" },
    { role: "assistant", content: "final", stopReason: "stop" },
  ];
  const session: any = {
    settingsManager: {
      getCompactionSettings() {
        return { enabled: true, triggerPercent: 0.85 };
      },
    },
    model: { contextWindow: 1000 },
    get isCompacting() {
      return false;
    },
    agent: {
      state: { messages },
      transformContext: async (nextMessages: any[]) => nextMessages,
    },
    sessionManager: {
      buildSessionContext() {
        return { messages: session.agent.state.messages };
      },
    },
    async _runAutoCompaction(reason: string, willRetry: boolean) {
      calls.push(`${reason}:${willRetry}`);
      return true;
    },
  };

  runtimeMod.applyRinProviderOverflowPreflight(session, {
    estimateContextTokens: () => ({ tokens: 900 }),
  });

  assert.equal(await session.agent.transformContext(messages), messages);
  assert.deepEqual(calls, []);
});

test("runtime session shutdown emits Rin capability hooks without extension-runner bridging", async () => {
  const calls = [];
  const runtime = {
    session: {
      sessionManager: {
        __rinFrontend: { kind: "test", key: "stable-owner" },
      },
      __rinCapabilities: {
        hasHandlers(eventName) {
          calls.push(`has:${eventName}`);
          return eventName === "session_shutdown";
        },
        async emit(event) {
          calls.push(
            `emit:${event.reason}:${event.targetSessionFile || ""}:${event.frontend?.key || ""}`,
          );
        },
      },
    },
    async teardownCurrent(reason, targetSessionFile) {
      calls.push(`teardown:${reason}:${targetSessionFile}`);
    },
    async dispose() {
      calls.push("dispose");
    },
  };

  runtimeMod.patchRinRuntimeSessionShutdown(runtime);
  await runtime.teardownCurrent("new", "/tmp/next-session.jsonl");
  await runtime.dispose();

  assert.deepEqual(calls, [
    "has:session_shutdown",
    "emit:new:/tmp/next-session.jsonl:stable-owner",
    "teardown:new:/tmp/next-session.jsonl",
    "has:session_shutdown",
    "emit:quit::stable-owner",
    "dispose",
  ]);
});

test("applyAutoReloadAfterCompaction reloads after successful compaction only once per session", async () => {
  const listeners = [];
  let subscribeCount = 0;
  let reloadCount = 0;

  const session = {
    subscribe(listener) {
      subscribeCount += 1;
      listeners.push(listener);
      return () => {};
    },
    async reload() {
      reloadCount += 1;
    },
  };

  runtimeMod.applyAutoReloadAfterCompaction(session);
  runtimeMod.applyAutoReloadAfterCompaction(session);

  assert.equal(subscribeCount, 1);

  listeners[0]({ type: "compaction_end", aborted: true, result: undefined });
  await waitForTimers();
  assert.equal(reloadCount, 0);

  listeners[0]({
    type: "compaction_end",
    aborted: false,
    result: { summary: "ok" },
  });
  await waitForTimers();
  assert.equal(reloadCount, 1);
});

test("applyAutoReloadAfterCompaction queues one extra reload while a reload is in flight", async () => {
  const listeners = [];
  let releaseReload;
  let reloadCount = 0;

  const firstReload = new Promise((resolve) => {
    releaseReload = resolve;
  });

  const session = {
    subscribe(listener) {
      listeners.push(listener);
      return () => {};
    },
    async reload() {
      reloadCount += 1;
      if (reloadCount === 1) {
        await firstReload;
      }
    },
  };

  runtimeMod.applyAutoReloadAfterCompaction(session);

  listeners[0]({
    type: "compaction_end",
    aborted: false,
    result: { summary: "first" },
  });
  listeners[0]({
    type: "compaction_end",
    aborted: false,
    result: { summary: "second" },
  });

  await waitForTimers();
  assert.equal(reloadCount, 1);

  releaseReload();
  await waitForTimers();
  await waitForTimers();
  assert.equal(reloadCount, 2);
});

test("Rin runtime no longer exposes todo compaction summary injection", () => {
  assert.equal(runtimeMod.appendRinTodoSnapshotToCompactionSummary, undefined);
});

test("manual compaction waits for refresh before returning", async () => {
  const listeners = [];
  let reloadCount = 0;
  const sequence = [];
  const session = {
    subscribe(listener) {
      listeners.push(listener);
      return () => {};
    },
    async reload() {
      reloadCount += 1;
      sequence.push("reload");
    },
    async compact() {
      for (const listener of listeners) {
        listener({
          type: "compaction_end",
          reason: "manual",
          aborted: false,
          result: { summary: "ok" },
        });
      }
      sequence.push("compact-done");
      return { summary: "ok" };
    },
  };

  runtimeMod.applyAutoReloadAfterCompaction(session);
  await session.compact();

  assert.equal(reloadCount, 1);
  assert.deepEqual(sequence, ["compact-done", "reload"]);
});
