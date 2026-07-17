import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const capabilitySession = await importBuiltModule<
  typeof import("../../src/core/rin-lib/capability-session.js")
>("dist/core/rin-lib/capability-session.js");

test("capability definitions normalize ownership, tools, hooks, and failures", async () => {
  const recorded: Array<{ type: string; data: any }> = [];
  const calls: string[] = [];
  const firstTool = { name: "read_owner", description: "first" };
  const duplicateTool = { name: "read_owner", description: "duplicate" };
  const set = capabilitySession.createRinCapabilitySet({
    cwd: "/workspace",
    agentDir: "/agent",
    sessionManager: {
      appendCustomEntry(type: string, data: any) {
        recorded.push({ type, data });
      },
    },
    definitions: [
      undefined,
      {
        name: " Disabled ",
        tools: [{ name: "disabled_tool" } as any],
        hooks: { owner_event: [() => calls.push("disabled")] },
      },
      {
        name: "Primary",
        tools: [firstTool as any, { name: "  " } as any],
        hooks: {
          owner_event: [
            async () => {
              calls.push("first");
              return { value: 1 };
            },
            "not-a-handler" as any,
            async () => {
              calls.push("second");
              return undefined;
            },
            async () => {
              throw new Error("ordinary hook failed");
            },
          ],
          "": [async () => undefined],
        },
      },
      {
        name: "Secondary",
        tools: [duplicateTool as any, { name: "write_owner" } as any],
        hooks: {
          owner_event: [async () => ({ value: 2 })],
          session_before_compact: [
            async () => Promise.reject("compact failed"),
          ],
        },
      },
    ],
    disabledNames: [" DISABLED ", "disabled"],
  });

  assert.deepEqual(capabilitySession.normalizeCapabilityNames(null), []);
  assert.deepEqual(
    capabilitySession.normalizeCapabilityNames([" Primary ", "primary", ""]),
    ["primary"],
  );
  assert.equal(set.hasHandlers(" owner_event "), true);
  assert.equal(set.hasHandlers("missing"), false);
  assert.deepEqual(set.getToolDefinitions(), [
    firstTool,
    { name: "write_owner" },
  ]);
  assert.deepEqual(await set.emit({ type: "owner_event" }), { value: 2 });
  assert.deepEqual(calls, ["first", "second"]);
  assert.equal(recorded[0].type, "rin_core_capability_error");
  assert.equal(recorded[0].data.event, "owner_event");
  assert.match(recorded[0].data.error, /ordinary hook failed/);
  assert.match(recorded[0].data.stack, /ordinary hook failed/);
  await assert.rejects(
    () => set.emit({ type: "session_before_compact" }),
    /compact failed/,
  );
  assert.equal(recorded[1].data.stack, undefined);

  const throwingRecorder = capabilitySession.createRinCapabilitySet({
    cwd: "/workspace",
    agentDir: "/agent",
    sessionManager: {
      appendCustomEntry() {
        throw new Error("recording unavailable");
      },
    },
    definitions: [
      {
        hooks: {
          ignored_error: [
            () => {
              throw new Error("ignored hook failure");
            },
          ],
        },
      },
    ],
  });
  assert.equal(
    await throwingRecorder.emit({ type: "ignored_error" }),
    undefined,
  );
});

test("unbound capability contexts expose exact defensive defaults", async () => {
  const set = capabilitySession.createRinCapabilitySet({
    cwd: "/workspace",
    agentDir: "/agent",
    definitions: [],
  });
  set.bindCore();
  set.setUIContext(undefined, "invalid" as any);
  set.bindCommandContext();

  const context = set.createContext();
  assert.equal(context.cwd, "/workspace");
  assert.equal(context.agentDir, "/agent");
  assert.equal(context.mode, "print");
  assert.equal(context.hasUI, false);
  assert.equal(context.model, undefined);
  assert.equal(context.frontend, undefined);
  assert.equal(context.isIdle(), true);
  assert.equal(context.signal, undefined);
  assert.equal(context.hasPendingMessages(), false);
  assert.equal(context.getContextUsage(), undefined);
  assert.equal(context.getSystemPrompt(), "");
  assert.deepEqual(context.getSystemPromptOptions(), {});
  assert.equal(context.getThinkingLevel(), "medium");
  context.abort();
  context.shutdown();
  context.compact();
  context.emitEvent({ type: "ignored" });

  assert.equal(await context.ui.select(), undefined);
  assert.equal(await context.ui.confirm(), false);
  assert.equal(await context.ui.input(), undefined);
  assert.equal(await context.ui.custom(), undefined);
  const removeInputHandler = context.ui.onTerminalInput();
  assert.equal(typeof removeInputHandler, "function");
  removeInputHandler();
  context.ui.notify();
  context.ui.setStatus();
  context.ui.setWorkingMessage();
  context.ui.setHiddenThinkingLabel();
  context.ui.setWidget();
  context.ui.setFooter();
  context.ui.setHeader();
  context.ui.setTitle();
  context.ui.pasteToEditor();
  context.ui.setEditorText();
  assert.equal(context.ui.getEditorText(), "");
  context.ui.setEditorComponent();

  const command = set.createCommandContext();
  assert.deepEqual(command.getSystemPromptOptions(), {});
  await command.waitForIdle();
  assert.deepEqual(await command.newSession(), { cancelled: false });
  assert.deepEqual(await command.fork("entry"), { cancelled: false });
  assert.deepEqual(await command.navigateTree("target"), { cancelled: false });
  assert.deepEqual(await command.switchSession("session"), {
    cancelled: false,
  });
  await command.reload();
});

test("bound contexts retain snapshot and live lookup semantics", async () => {
  const calls: any[] = [];
  const options: Parameters<
    typeof capabilitySession.createRinCapabilitySet
  >[0] = {
    cwd: "/workspace",
    agentDir: "/agent",
    sessionManager: { __rinFrontend: { kind: "tui", id: "first" } },
    modelRegistry: { id: "registry" },
    definitions: [],
  };
  const set = capabilitySession.createRinCapabilitySet(options);
  const firstSignal = new AbortController().signal;
  set.bindCore(
    {
      getThinkingLevel: () => "high",
      emitEvent: (event) => calls.push(["event", event]),
    },
    {
      getModel: () => "first-model",
      isIdle: () => false,
      getSignal: () => firstSignal,
      abort: () => calls.push(["abort"]),
      hasPendingMessages: () => true,
      shutdown: () => calls.push(["shutdown"]),
      getContextUsage: () => ({ tokens: 12 }),
      compact: (compactOptions) => calls.push(["compact", compactOptions]),
      getSystemPrompt: () => "owner prompt",
      getSystemPromptOptions: () => ({ cwd: "/workspace" }),
    },
  );
  set.bindCommandContext({
    waitForIdle: async () => calls.push(["wait"]),
    newSession: async (sessionOptions) => {
      calls.push(["new", sessionOptions]);
      return { cancelled: true };
    },
    fork: async (entryId) => {
      calls.push(["fork", entryId]);
      return { cancelled: true };
    },
    navigateTree: async (targetId, navigationOptions) => {
      calls.push(["navigate", targetId, navigationOptions]);
      return { cancelled: true };
    },
    switchSession: async (sessionPath) => {
      calls.push(["switch", sessionPath]);
      return { cancelled: true };
    },
    reload: async () => calls.push(["reload"]),
  });
  const ui = { confirm: async () => true };
  set.setUIContext(ui, "rpc");

  const context = set.createContext();
  assert.equal(context.model, "first-model");
  assert.equal(context.isIdle(), false);
  assert.equal(context.signal, firstSignal);
  assert.equal(context.hasPendingMessages(), true);
  assert.deepEqual(context.getContextUsage(), { tokens: 12 });
  assert.equal(context.getSystemPrompt(), "owner prompt");
  assert.deepEqual(context.getSystemPromptOptions(), { cwd: "/workspace" });
  assert.equal(context.getThinkingLevel(), "high");
  assert.equal(context.ui, ui);
  assert.equal(context.hasUI, true);
  assert.equal(context.mode, "rpc");
  assert.equal(context.sessionManager, options.sessionManager);
  assert.equal(context.modelRegistry, options.modelRegistry);
  assert.deepEqual(context.frontend, { kind: "tui", id: "first" });

  options.sessionManager = { __rinFrontend: { kind: "rpc", id: "second" } };
  assert.deepEqual(context.frontend, { kind: "rpc", id: "second" });
  assert.notEqual(context.sessionManager, options.sessionManager);

  context.abort();
  context.shutdown();
  context.compact({ customInstructions: "compact" });
  context.emitEvent({ type: "owner" });
  const command = set.createCommandContext();
  await command.waitForIdle();
  assert.deepEqual(await command.newSession({ name: "next" }), {
    cancelled: true,
  });
  assert.deepEqual(await command.fork("entry-1"), { cancelled: true });
  assert.deepEqual(await command.navigateTree("entry-2", { summarize: true }), {
    cancelled: true,
  });
  assert.deepEqual(await command.switchSession("next.jsonl"), {
    cancelled: true,
  });
  await command.reload();

  assert.deepEqual(calls, [
    ["abort"],
    ["shutdown"],
    ["compact", { customInstructions: "compact" }],
    ["event", { type: "owner" }],
    ["wait"],
    ["new", { name: "next" }],
    ["fork", "entry-1"],
    ["navigate", "entry-2", { summarize: true }],
    ["switch", "next.jsonl"],
    ["reload"],
  ]);
});

test("session attachment adapters resolve the current session methods and manager", async () => {
  const calls: any[] = [];
  const nativeListeners = new Set<(event: any) => void>();
  const firstManager = {
    appendCustomEntry: (type: string, data: any) =>
      calls.push(["first-append", type, data]),
    appendSessionInfo: (name: string) => calls.push(["first-name", name]),
    getSessionName: () => "first session",
    appendLabelChange: (entryId: string, label: string | undefined) =>
      calls.push(["first-label", entryId, label]),
  };
  const secondManager = {
    appendCustomEntry: (type: string, data: any) =>
      calls.push(["second-append", type, data]),
    appendSessionInfo: (name: string) => calls.push(["second-name", name]),
    getSessionName: () => "second session",
    appendLabelChange: (entryId: string, label: string | undefined) =>
      calls.push(["second-label", entryId, label]),
  };
  const uiBefore = { label: "before" };
  const uiAfter = { label: "after" };
  const commandBefore = {
    waitForIdle: async () => calls.push(["command-before"]),
  };
  const commandAfter = {
    waitForIdle: async () => calls.push(["command-after"]),
  };
  let compactReject = false;
  const session: any = {
    sessionManager: firstManager,
    modelRegistry: {
      hasConfiguredAuth(model: unknown) {
        return model === "configured";
      },
    },
    model: "model-before",
    thinkingLevel: "medium",
    isStreaming: true,
    pendingMessageCount: 2,
    systemPrompt: "system-before",
    agent: { signal: new AbortController().signal },
    _baseSystemPromptOptions: { cwd: "/prompt-cwd", tools: ["read"] },
    _extensionMode: "tui",
    _extensionUIContext: uiBefore,
    _extensionCommandContextActions: commandBefore,
    _extensionRunner: {
      hasHandlers: () => false,
      emit: async () => undefined,
      getRegisteredCommands: () => [],
    },
    _refreshToolRegistry: () => calls.push(["refresh-before"]),
    _extensionShutdownHandler: () => calls.push(["shutdown-before"]),
    subscribe(listener: (event: any) => void) {
      nativeListeners.add(listener);
      return () => {
        calls.push(["native-unsubscribe"]);
        nativeListeners.delete(listener);
      };
    },
    sendCustomMessage(message: any, sendOptions: any) {
      calls.push(["custom-before", message, sendOptions]);
      return Promise.resolve();
    },
    sendUserMessage(content: any, sendOptions: any) {
      calls.push(["user-before", content, sendOptions]);
      return Promise.resolve();
    },
    getActiveToolNames: () => ["read-before"],
    getAllTools: () => [{ name: "read-before" }],
    setActiveToolsByName: (names: string[]) =>
      calls.push(["tools-before", names]),
    async setModel(model: any) {
      calls.push(["model-before", model]);
      session.model = model;
    },
    setThinkingLevel(level: string) {
      calls.push(["thinking-before", level]);
      session.thinkingLevel = level;
    },
    abort: async () => calls.push(["abort-before"]),
    getContextUsage: () => ({ tokens: 42 }),
    async compact(instructions: unknown) {
      calls.push(["session-compact", instructions]);
      if (compactReject) throw "compact rejection";
      return { summary: "done" };
    },
    async reload(...args: any[]) {
      calls.push(["original-reload", ...args]);
      session._extensionMode = "json";
      session._extensionUIContext = uiAfter;
      session._extensionCommandContextActions = commandAfter;
      return "reload-result";
    },
  };
  const set = capabilitySession.createRinCapabilitySet({
    cwd: "/workspace",
    agentDir: "/agent",
    definitions: [
      {
        name: "owner",
        hooks: {
          session_start: [async (event: any) => calls.push(["start", event])],
          owner_event: [async (event: any) => calls.push(["hook", event.type])],
        },
      },
    ],
  });

  let capturedCore: any;
  let capturedContext: any;
  const bindCore = set.bindCore;
  set.bindCore = (core, context) => {
    capturedCore = core;
    capturedContext = context;
    bindCore(core, context);
  };

  assert.deepEqual(
    await capabilitySession.attachRinCapabilitiesToSession(session, {
      capabilitySet: set,
      reason: "startup",
      previousSessionFile: "/sessions/previous.jsonl",
    }),
    { capabilitySet: set },
  );
  const subscriptionCount = nativeListeners.size;
  await capabilitySession.attachRinCapabilitiesToSession(session, {
    capabilitySet: set,
    reason: "reload",
  });
  assert.equal(nativeListeners.size, subscriptionCount);
  assert.equal(session.__rinCapabilities, set);

  const seen: any[] = [];
  const unsubscribe = session.subscribe((event: any) => seen.push(event));
  const throwingUnsubscribe = session.subscribe(() => {
    throw new Error("subscriber failure");
  });
  capturedCore.emitEvent({ type: "core-event", value: 1 });
  assert.deepEqual(seen, [{ type: "core-event", value: 1 }]);
  unsubscribe();
  throwingUnsubscribe();

  session.sessionManager = secondManager;
  session.sendCustomMessage = (message: any, sendOptions: any) => {
    calls.push(["custom-after", message, sendOptions]);
    return Promise.reject(new Error("delivery ignored"));
  };
  session.sendUserMessage = (content: any, sendOptions: any) => {
    calls.push(["user-after", content, sendOptions]);
    return Promise.reject(new Error("delivery ignored"));
  };
  session.getActiveToolNames = () => ["read-after"];
  session.getAllTools = () => [{ name: "read-after" }];
  session.setActiveToolsByName = (names: string[]) =>
    calls.push(["tools-after", names]);
  session._refreshToolRegistry = () => calls.push(["refresh-after"]);
  session._extensionShutdownHandler = () => calls.push(["shutdown-after"]);
  session.setModel = async (model: any) => {
    calls.push(["model-after", model]);
    session.model = model;
  };
  session.setThinkingLevel = (level: string) => {
    calls.push(["thinking-after", level]);
    session.thinkingLevel = level;
  };
  session.abort = async () => {
    calls.push(["abort-after"]);
    throw new Error("abort ignored");
  };

  capturedCore.sendMessage({ text: "custom" }, { source: "test" });
  capturedCore.sendUserMessage("user", { deliverAs: "followUp" });
  capturedCore.appendEntry("owner_entry", { ok: true });
  capturedCore.setSessionName("renamed");
  assert.equal(capturedCore.getSessionName(), "second session");
  capturedCore.setLabel("entry-1", "label");
  assert.deepEqual(capturedCore.getActiveTools(), ["read-after"]);
  assert.deepEqual(capturedCore.getAllTools(), [{ name: "read-after" }]);
  capturedCore.setActiveTools(["read"]);
  capturedCore.refreshTools();
  assert.equal(await capturedCore.setModel("missing"), false);
  assert.equal(await capturedCore.setModel("configured"), true);
  assert.equal(capturedCore.getThinkingLevel(), "medium");
  capturedCore.setThinkingLevel("high");

  session.model = "model-after";
  session.isStreaming = false;
  session.pendingMessageCount = 0;
  session.systemPrompt = "system-after";
  assert.equal(capturedContext.getModel(), "model-after");
  assert.equal(capturedContext.isIdle(), true);
  assert.equal(capturedContext.getSignal(), session.agent.signal);
  capturedContext.abort();
  assert.equal(capturedContext.hasPendingMessages(), false);
  capturedContext.shutdown();
  assert.deepEqual(capturedContext.getContextUsage(), { tokens: 42 });
  assert.equal(capturedContext.getSystemPrompt(), "system-after");
  assert.deepEqual(capturedContext.getSystemPromptOptions(), {
    cwd: "/prompt-cwd",
    tools: ["read"],
  });

  const complete = new Promise<any>((resolve, reject) => {
    capturedContext.compact({
      customInstructions: "owner compact",
      onComplete: resolve,
      onError: reject,
    });
  });
  assert.deepEqual(await complete, { summary: "done" });
  compactReject = true;
  const failed = new Promise<Error>((resolve) => {
    capturedContext.compact({ onError: resolve });
  });
  assert.match((await failed).message, /compact rejection/);

  for (const event of [
    { type: "input" },
    { type: "before_agent_start" },
    {},
    { type: "owner_event" },
  ]) {
    for (const listener of [...nativeListeners]) listener(event);
  }
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(await session.reload("owner-arg"), "reload-result");
  assert.equal(set.createContext().mode, "json");
  assert.equal(set.createContext().ui, uiAfter);
  await set.createCommandContext().waitForIdle();
  assert.deepEqual(
    calls.filter(([name]) => name === "start").map(([, event]) => event),
    [
      {
        type: "session_start",
        reason: "startup",
        previousSessionFile: "/sessions/previous.jsonl",
      },
      {
        type: "session_start",
        reason: "reload",
        previousSessionFile: undefined,
      },
    ],
  );
  assert.ok(calls.some((entry) => entry[0] === "custom-after"));
  assert.ok(calls.some((entry) => entry[0] === "user-after"));
  assert.ok(calls.some((entry) => entry[0] === "second-append"));
  assert.ok(calls.some((entry) => entry[0] === "second-name"));
  assert.ok(calls.some((entry) => entry[0] === "second-label"));
  assert.ok(calls.some((entry) => entry[0] === "refresh-after"));
  assert.ok(
    calls.some(
      (entry) => entry[0] === "model-after" && entry[1] === "configured",
    ),
  );
  assert.ok(calls.some((entry) => entry[0] === "shutdown-after"));
  assert.ok(calls.some((entry) => entry[0] === "abort-after"));
  assert.ok(calls.some((entry) => entry[0] === "hook"));
  assert.ok(calls.some((entry) => entry[0] === "command-after"));
  assert.equal(session.model, "model-after");
  assert.equal(session.thinkingLevel, "high");
});

test("session attachment tolerates missing optional surfaces", async () => {
  const set = capabilitySession.createRinCapabilitySet({
    cwd: "/workspace",
    agentDir: "/agent",
    definitions: [],
  });
  let core: any;
  let context: any;
  const bindCore = set.bindCore;
  set.bindCore = (nextCore, nextContext) => {
    core = nextCore;
    context = nextContext;
    bindCore(nextCore, nextContext);
  };

  assert.deepEqual(
    await capabilitySession.attachRinCapabilitiesToSession(
      {},
      { capabilitySet: set },
    ),
    { capabilitySet: set },
  );
  core.sendMessage("ignored");
  core.emitEvent({ type: "ignored" });
  core.sendUserMessage("ignored");
  core.appendEntry("ignored");
  core.setSessionName("ignored");
  assert.equal(core.getSessionName(), undefined);
  core.setLabel("ignored", undefined);
  assert.deepEqual(core.getActiveTools(), []);
  assert.deepEqual(core.getAllTools(), []);
  core.setActiveTools([]);
  core.refreshTools();
  assert.equal(await core.setModel("missing"), false);
  assert.equal(core.getThinkingLevel(), undefined);
  core.setThinkingLevel("medium");
  assert.equal(context.getModel(), undefined);
  assert.equal(context.isIdle(), true);
  assert.equal(context.getSignal(), undefined);
  context.abort();
  assert.equal(context.hasPendingMessages(), false);
  context.shutdown();
  assert.equal(context.getContextUsage(), undefined);
  context.compact();
  assert.equal(context.getSystemPrompt(), undefined);
  assert.deepEqual(context.getSystemPromptOptions(), { cwd: "/workspace" });

  await assert.rejects(
    () =>
      capabilitySession.attachRinCapabilitiesToSession(null, {
        capabilitySet: set,
      }),
    TypeError,
  );
});
