import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";

await import("../support/register-tui-patches-owner-fixture.ts");
const patches = await import(
  pathToFileURL(path.resolve("dist/core/pi/tui-patches/index.js")).href
);
const piTui = await import("@earendil-works/pi-tui");
const privateApi = await import(
  pathToFileURL(path.resolve("dist/core/pi/private-api.js")).href
);
const runtimeEnv = await import(
  pathToFileURL(path.resolve("dist/core/tui-runtime-env.js")).href
);

const fixture = (globalThis as any).__rinTuiPatchesOwner as {
  events: any[];
  notice: any;
  currentVersion: string;
  entries: any[];
  newEntries: any[];
  pages: any[];
  extensionStates: any[];
  extensionError?: Error;
  footerLines: string[];
  selector?: any;
  classes: Record<string, any>;
};
const { FooterComponent, InteractiveMode } = fixture.classes;

function resetFixture() {
  fixture.events.length = 0;
  fixture.notice = null;
  fixture.currentVersion = "1.2.3";
  fixture.entries = [];
  fixture.newEntries = [];
  fixture.pages = [];
  fixture.extensionStates = [];
  fixture.extensionError = undefined;
  fixture.footerLines = ["cwd", "stats", "tail"];
  fixture.selector = undefined;
}

function childContainer() {
  const children: any[] = [];
  return {
    children,
    clearCount: 0,
    addChild(child: any) {
      children.push(child);
    },
    removeChild(child: any) {
      const index = children.indexOf(child);
      if (index >= 0) children.splice(index, 1);
    },
    clear() {
      this.clearCount += 1;
      children.length = 0;
    },
  };
}

function statusApi(instance: any) {
  instance.showStatusIndicator = (indicator: any) => {
    instance.activeStatusIndicator?.dispose?.();
    instance.activeStatusIndicator = indicator;
    instance.statusContainer.clear();
    instance.statusContainer.addChild(indicator);
  };
  instance.clearStatusIndicator = (kind?: string) => {
    if (kind && instance.activeStatusIndicator?.kind !== kind) return;
    instance.activeStatusIndicator?.dispose?.();
    instance.activeStatusIndicator = undefined;
    instance.statusContainer.clear();
  };
  return instance;
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

privateApi.initTheme("dark", false);

test("TUI patch exports preserve fatal, resume, chrome, update, and branding contracts", (t) => {
  resetFixture();
  const fatal = patches.formatRinFatalError(
    "Owner failure",
    new TypeError("broken owner runtime"),
  );
  assert.match(
    fatal,
    /^\nRin fatal error\nOwner failure: broken owner runtime/,
  );
  assert.match(fatal, /TypeError/);
  assert.equal(
    patches.formatRinFatalError("", "plain failure"),
    "\nRin fatal error\nTUI failure: plain failure\n",
  );

  assert.equal(patches.rewriteRinResumeCommandOutput(42), 42);
  assert.equal(
    patches.rewriteRinResumeCommandOutput(
      "To resume this session:\n\u001b[2m  pi --session one\u001b[0m\n" +
        "To resume this session: pi --session two",
    ),
    "To resume this session:\n\u001b[2m  rin --session one\u001b[0m\n" +
      "To resume this session: rin --session two",
  );
  assert.equal(
    patches.rewriteRinResumeCommandOutput(
      "To resume this session: pixel owner",
    ),
    "To resume this session: pixel owner",
  );

  assert.equal(
    patches.rewriteRinStartupHeaderText(
      "pi v0.80.0\nPi can explain its own features and look up its docs. Ask it how to use or extend Pi.",
      "0.80.0",
      "1.2.3",
    ),
    "rin v1.2.3\nRin can explain its own features and look up its docs. Ask Rin how to use or extend Rin.",
  );
  assert.equal(
    patches.rewriteRinStartupHeaderText(
      "pi v0.80.0",
      undefined,
      "nightly-owner",
    ),
    "Rin nightly-owner",
  );
  const previousQuickRun = process.env.RIN_QUICK_RUN;
  t.after(() => {
    if (previousQuickRun === undefined) delete process.env.RIN_QUICK_RUN;
    else process.env.RIN_QUICK_RUN = previousQuickRun;
  });
  process.env.RIN_QUICK_RUN = "1";
  assert.equal(
    patches.rewriteRinStartupHeaderText("pi v0.80.0\nPi owner", "0.80.0"),
    "rin\nRin owner",
  );
  if (previousQuickRun === undefined) delete process.env.RIN_QUICK_RUN;
  else process.env.RIN_QUICK_RUN = previousQuickRun;

  let expanded = false;
  let brandedText = "";
  const expandable = {
    getCollapsedText: () => "pi v0.80.0 collapsed",
    getExpandedText: () => "Pi expanded",
    setExpanded(value: boolean) {
      expanded = value;
      brandedText = this.getExpandedText();
    },
  };
  assert.equal(
    patches.applyRinStartupHeaderBranding({
      builtInHeader: expandable,
      version: "0.80.0",
      getStartupExpansionState: () => true,
    }),
    true,
  );
  assert.equal(expanded, true);
  assert.equal(brandedText, "Rin expanded");
  let staticText = "";
  assert.equal(
    patches.applyRinStartupHeaderBranding({
      builtInHeader: {
        text: "pi v0.80.0",
        setText(value: string) {
          staticText = value;
        },
      },
      version: "0.80.0",
    }),
    true,
  );
  assert.equal(staticText, "rin v1.2.3");
  assert.equal(patches.applyRinStartupHeaderBranding({}), false);
  assert.equal(
    patches.applyRinStartupHeaderBranding({ builtInHeader: {} }),
    false,
  );

  const chromeEvents: string[] = [];
  patches.renderRinInitialSessionChrome({
    showLoadedResources(options: any) {
      chromeEvents.push(
        `resources:${options.force}:${options.showDiagnosticsWhenQuiet}`,
      );
    },
    showStartupNoticesIfNeeded() {
      chromeEvents.push("notices");
    },
  });
  assert.deepEqual(chromeEvents, ["resources:false:true", "notices"]);

  const empty = {
    session: { messages: [] },
    sessionManager: { getEntries: () => [] },
    chatContainer: childContainer(),
    pendingMessagesContainer: childContainer(),
    pendingTools: new Map([["owner", true]]),
    compactionQueuedMessages: ["queued"],
    streamingComponent: {},
    streamingMessage: {},
    showLoadedResources: () => chromeEvents.push("replacement-resources"),
    showStartupNoticesIfNeeded: () => chromeEvents.push("replacement-notices"),
    renderInitialMessages: () => chromeEvents.push("render"),
  };
  patches.renderRinCurrentSessionStateAfterReplacement(empty);
  assert.deepEqual(empty.compactionQueuedMessages, []);
  assert.equal(empty.pendingTools.size, 0);
  assert.equal(empty.streamingComponent, undefined);
  assert.deepEqual(chromeEvents.slice(-3), [
    "replacement-resources",
    "replacement-notices",
    "render",
  ]);
  const historyEvents: string[] = [];
  patches.renderRinCurrentSessionStateAfterReplacement({
    ...empty,
    session: { messages: [{ role: "user" }] },
    showLoadedResources: () => historyEvents.push("resources"),
    showStartupNoticesIfNeeded: () => historyEvents.push("notices"),
    renderInitialMessages: () => historyEvents.push("render"),
  });
  assert.deepEqual(historyEvents, ["render"]);

  const updateInstance = {
    chatContainer: childContainer(),
    ui: {
      renders: 0,
      requestRender() {
        this.renders += 1;
      },
    },
  };
  patches.showRinUpdateNotification(updateInstance, {
    channel: "beta",
    version: "2.0.0-beta.1",
    command: "rin update --beta",
  });
  assert.equal(updateInstance.chatContainer.children.length, 4);
  assert.equal(updateInstance.ui.renders, 1);
  assert.match(
    updateInstance.chatContainer.children[2].text,
    /New beta version/,
  );
  assert.match(
    updateInstance.chatContainer.children[2].text,
    /rin update --beta/,
  );
});

test("TUI initialization builds Pi-native chrome without managed tool fallback", async () => {
  resetFixture();
  const events: any[] = [];
  const makeInstance = (quiet: boolean, verbose: boolean) => {
    const containers = {
      header: childContainer(),
      resources: childContainer(),
      chat: childContainer(),
      pending: childContainer(),
      status: childContainer(),
      above: childContainer(),
      editor: childContainer(),
      below: childContainer(),
    };
    const ui = {
      children: [] as any[],
      addChild(child: any) {
        this.children.push(child);
      },
      setFocus(child: any) {
        events.push(["focus", child]);
      },
      start() {
        events.push(["ui-start"]);
      },
      invalidate() {
        events.push(["invalidate"]);
      },
      requestRender() {
        events.push(["render"]);
      },
    };
    return {
      isInitialized: false,
      session: {
        scopedModels: [
          { model: { id: "owner-a" }, thinkingLevel: "high" },
          { model: { id: "owner-b" } },
        ],
      },
      options: { verbose },
      settingsManager: { getQuietStartup: () => quiet },
      keybindings: {
        getKeys(name: string) {
          return name === "app.model.cycleForward" ? ["ctrl+n"] : [];
        },
      },
      version: "1.2.3",
      headerContainer: containers.header,
      loadedResourcesContainer: containers.resources,
      chatContainer: containers.chat,
      pendingMessagesContainer: containers.pending,
      statusContainer: containers.status,
      widgetContainerAbove: containers.above,
      editorContainer: containers.editor,
      widgetContainerBelow: containers.below,
      footer: { owner: "footer" },
      editor: { owner: "editor" },
      ui,
      footerDataProvider: {
        onBranchChange(callback: () => void) {
          events.push(["branch-callback", callback]);
        },
      },
      registerSignalHandlers: () => events.push(["signals"]),
      getChangelogForDisplay: () => "owner changelog",
      getStartupExpansionState: () => false,
      renderWidgets: () => events.push(["widgets"]),
      setupKeyHandlers: () => events.push(["keys"]),
      setupEditorSubmitHandler: () => events.push(["submit"]),
      rebindCurrentSession: async () => events.push(["rebind"]),
      showLoadedResources: (options: any) =>
        events.push(["resources", options]),
      showStartupNoticesIfNeeded: () => events.push(["notices"]),
      renderInitialMessages: () => events.push(["messages"]),
      updateEditorBorderColor: () => events.push(["border"]),
      updateAvailableProviderCount: async () => events.push(["providers"]),
    };
  };

  const verbose = makeInstance(false, true);
  await patches.initializePiInteractiveModeWithoutManagedToolEnsure(verbose);
  assert.equal(verbose.isInitialized, true);
  assert.equal(verbose.changelogMarkdown, "owner changelog");
  assert.equal(verbose.headerContainer.children.length, 3);
  assert.equal(verbose.ui.children.length, 9);
  assert.equal(
    events.some(([name]) => name === "providers"),
    true,
  );
  const before = events.length;
  await patches.initializePiInteractiveModeWithoutManagedToolEnsure(verbose);
  assert.equal(events.length, before);

  const quiet = makeInstance(true, false);
  quiet.session.scopedModels = [];
  await patches.initializePiInteractiveModeWithoutManagedToolEnsure(quiet);
  assert.equal(quiet.headerContainer.children.length, 1);
  assert.equal(quiet.builtInHeader.text, "");
});

test("patched Pi lifecycle presents Rin identity, changelog, settings, and prompt flow", async (t) => {
  resetFixture();
  await patches.applyRinTuiOverrides();
  await patches.applyRinTuiOverrides();
  const proto = InteractiveMode.prototype;
  const previousRuntimeRole = runtimeEnv.getRinTuiRuntimeRole();
  t.after(() => runtimeEnv.setRinTuiRuntimeRole(previousRuntimeRole));

  runtimeEnv.setRinTuiRuntimeRole("rpc-frontend");
  fixture.footerLines = ["cwd", "stats", "tail"];
  const reasoningSession = {
    state: {
      model: { id: "owner-model", reasoning: true },
      thinkingLevel: "high",
    },
    sessionManager: { getSessionName: () => "Owner named session" },
  };
  const footer = new FooterComponent(reasoningSession, {});
  assert.deepEqual(footer.render(80), [
    "\u001b[2mOwner named session\u001b[0m",
    "stats",
    "tail",
  ]);
  assert.equal(reasoningSession.state.thinkingLevel, "high");
  reasoningSession.state.model = { id: "plain-model", reasoning: false };
  assert.deepEqual(footer.render(40), [
    "\u001b[2mOwner named session\u001b[0m",
    "stats",
    "tail",
  ]);
  assert.equal(reasoningSession.state.model.id, "plain-model");
  runtimeEnv.setRinTuiRuntimeRole(undefined);

  let terminalTitle = "";
  proto.updateTerminalTitle.call({
    sessionManager: { getSessionName: () => "Owner" },
    ui: {
      terminal: {
        setTitle: (value: string) => {
          terminalTitle = value;
        },
      },
    },
  });
  assert.equal(terminalTitle, "Rin - Owner");
  proto.updateTerminalTitle.call({
    sessionManager: { getSessionName: () => "" },
    ui: {
      terminal: {
        setTitle: (value: string) => {
          terminalTitle = value;
        },
      },
    },
  });
  assert.equal(terminalTitle, "Rin");

  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: any) => {
    writes.push(String(chunk));
    return true;
  }) as any;
  try {
    assert.equal(await proto.shutdown.call({}), "shutdown-owner");
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.match(writes.join(""), /rin --session owner/);
  assert.doesNotMatch(writes.join(""), /\bpi --session/);

  fixture.entries = [
    { version: "1.0.0", content: "First change" },
    { version: "1.2.3", content: "Latest change" },
  ];
  fixture.newEntries = [{ content: "Latest change" }];
  const versions: string[] = [];
  const changelogInstance = {
    session: { state: { messages: [] } },
    settingsManager: {
      getLastChangelogVersion: () => "1.0.0",
      setLastChangelogVersion: (value: string) => versions.push(value),
    },
    chatContainer: childContainer(),
    getMarkdownThemeWithSettings: () => ({}),
    ui: { requestRender: () => versions.push("render") },
  };
  assert.equal(
    proto.getChangelogForDisplay.call(changelogInstance),
    "Latest change",
  );
  assert.deepEqual(versions, ["1.2.3"]);
  proto.handleChangelogCommand.call(changelogInstance);
  assert.equal(changelogInstance.chatContainer.children.length, 6);
  assert.equal(versions.at(-1), "render");
  fixture.entries = [];
  changelogInstance.chatContainer.clear();
  proto.handleChangelogCommand.call(changelogInstance);
  assert.match(
    changelogInstance.chatContainer.children[4].render(80).join("\n"),
    /No changelog entries found\./,
  );

  const prompts: any[] = [];
  let inputs = 0;
  const runInstance = {
    init: async () => prompts.push(["init"]),
    options: {
      rinStartupWarnings: ["warning owner", ""],
      migratedProviders: ["openai"],
      modelFallbackMessage: "fallback owner",
      initialMessage: "initial owner",
      initialImages: [{ type: "image", data: "owner" }],
      initialMessages: ["follow one", "follow two"],
      rinStartHiddenInitialization: true,
    },
    session: {
      modelRegistry: { getError: () => "models owner" },
      async prompt(message: string, options?: any) {
        prompts.push(["prompt", message, options]);
        if (message === "follow one") throw new Error("follow failed");
      },
    },
    showWarning: (message: string) => prompts.push(["warning", message]),
    showError: (message: string) => prompts.push(["error", message]),
    checkTmuxKeyboardSetup: async () => "tmux owner",
    maybeWarnAboutAnthropicSubscriptionAuth: async () =>
      prompts.push(["anthropic"]),
    async getUserInput() {
      inputs += 1;
      if (inputs === 1) return "loop owner";
      throw new Error("stop input loop");
    },
  };
  await assert.rejects(proto.run.call(runInstance), /stop input loop/);
  await flush();
  assert.equal(
    prompts.some(
      ([kind, value]) => kind === "prompt" && value === "loop owner",
    ),
    true,
  );
  assert.equal(
    prompts.some(
      ([kind, value]) => kind === "error" && value === "follow failed",
    ),
    true,
  );
  assert.equal(
    prompts.some(([kind, value]) => kind === "warning" && /openai/.test(value)),
    true,
  );
});

test("patched settings, selectors, signals, and event bridge keep one native owner", async (t) => {
  resetFixture();
  await patches.applyRinTuiOverrides();
  const proto = InteractiveMode.prototype;

  const forwarded: any[] = [];
  const settingsList: any = {
    items: [{ id: "upstream" }],
    filteredItems: [],
    onChange(id: string, value: string) {
      forwarded.push([id, value]);
    },
  };
  fixture.extensionStates = [
    {
      id: "todo",
      label: "Todo",
      description: "Owner todo",
      enabled: true,
    },
  ];
  const settingEvents: any[] = [];
  const settingsInstance = {
    editorContainer: {
      children: [{ getSettingsList: () => settingsList }],
    },
    settingsManager: { owner: true },
    session: { reload: async () => settingEvents.push(["reload"]) },
    setupAutocompleteProvider: () => settingEvents.push(["autocomplete"]),
    showStatus: (value: string) => settingEvents.push(["status", value]),
    showError: (value: string) => settingEvents.push(["error", value]),
  };
  proto.showSettingsSelector.call(settingsInstance);
  assert.equal(settingsList.items.at(-1).id, "rin-built-in-extension:todo");
  settingsList.onChange("upstream", "value");
  settingsList.onChange("rin-built-in-extension:todo", "false");
  await flush();
  assert.deepEqual(forwarded, [["upstream", "value"]]);
  assert.deepEqual(settingEvents, [
    ["reload"],
    ["autocomplete"],
    ["status", "Built-in extension settings reloaded."],
  ]);
  proto.showSettingsSelector.call(settingsInstance);
  assert.equal(settingsList.items.length, 2);
  fixture.extensionError = new Error("owner extension rejected");
  settingsList.onChange("rin-built-in-extension:todo", "true");
  await flush();
  assert.deepEqual(settingEvents.at(-1), ["error", "owner extension rejected"]);

  fixture.pages = [
    {
      sessions: [{ id: "one", path: "/owner/one.jsonl" }],
      offset: 0,
      limit: 30,
      total: 2,
      nextOffset: 1,
      hasMore: true,
    },
    {
      sessions: [
        { id: "one", path: "/owner/one.jsonl" },
        { id: "two", path: "/owner/two.jsonl" },
      ],
      offset: 1,
      limit: 30,
      total: 2,
      nextOffset: 2,
      hasMore: false,
    },
  ];
  let selectorResult: any;
  const selectorEvents: any[] = [];
  const selectorInstance = {
    session: {},
    sessionManager: {
      getCwd: () => "/owner/work",
      getSessionFile: () => "/owner/current.jsonl",
    },
    keybindings: { owner: true },
    ui: { requestRender: () => selectorEvents.push(["render"]) },
    showSelector(factory: any) {
      selectorResult = factory(() => selectorEvents.push(["done"]));
    },
    handleResumeSession: async (sessionPath: string) =>
      selectorEvents.push(["resume", sessionPath]),
    shutdown: async () => selectorEvents.push(["shutdown"]),
  };
  proto.showSessionSelector.call(selectorInstance);
  const selector = selectorResult.component;
  assert.equal(selectorResult.focus, selector);
  assert.equal(selector.sessionList.showCwd, true);
  assert.equal(selector.options.showRenameHint, true);
  assert.equal((await selector.currentLoader()).length, 1);
  selector.sessionList.filteredSessions = [{ id: "one" }];
  selector.sessionList.selectedIndex = 0;
  selector.sessionList.handleInput("down");
  await flush();
  assert.equal(selector.currentSessions.length, 2);
  assert.equal(selector.header.render(50).length, 3);
  await selector.options.renameSession("/owner/one.jsonl", " Owner renamed ");
  await selector.options.renameSession("/owner/one.jsonl", "   ");
  assert.equal(fixture.events.filter(([name]) => name === "rename").length, 1);
  await selector.onSelect("/owner/two.jsonl");
  selector.onCancel();
  selector.onExit();
  assert.deepEqual(selectorEvents.slice(-5), [
    ["done"],
    ["resume", "/owner/two.jsonl"],
    ["done"],
    ["render"],
    ["shutdown"],
  ]);

  const signalEvents: string[] = [];
  const signalInstance = {
    signalCleanupHandlers: [] as Array<() => void>,
    ui: { stopped: false },
    handleCtrlC: () => signalEvents.push("ctrl-c"),
    emergencyTerminalExit: () => signalEvents.push("terminal-exit"),
  };
  proto.registerSignalHandlers.call(signalInstance);
  t.after(() => {
    for (const cleanup of signalInstance.signalCleanupHandlers) cleanup();
  });
  const sigint = process.listeners("SIGINT").at(-1) as () => void;
  sigint();
  signalInstance.ui.stopped = true;
  sigint();
  signalInstance.ui.stopped = false;
  const stdinEnd = process.stdin.listeners("end").at(-1) as () => void;
  stdinEnd();
  assert.deepEqual(signalEvents, ["ctrl-c", "terminal-exit"]);
  for (const cleanup of signalInstance.signalCleanupHandlers) cleanup();
});

test("patched event bridge coordinates RPC transport, resync, local echo, and thinking", async () => {
  resetFixture();
  await patches.applyRinTuiOverrides();
  const proto = InteractiveMode.prototype;
  const errors: string[] = [];
  const renders: string[] = [];
  const instance = statusApi({
    isInitialized: true,
    session: {
      isStreaming: true,
      getFrontendStatusEvent: () => ({
        phase: "connecting",
        label: "Connecting",
      }),
      cycleThinkingLevel: async () => "high",
      subscribe(callback: any) {
        this.callback = callback;
        return () => renders.push("unsubscribe");
      },
    },
    sessionManager: {
      buildSessionContext: () => ({ messages: [] }),
    },
    settingsManager: { getShowTerminalProgress: () => false },
    ui: {
      terminal: { setProgress() {} },
      stopped: false,
      requestRender: () => renders.push("render"),
    },
    statusContainer: childContainer(),
    activeStatusIndicator: undefined,
    workingVisible: true,
    setWorkingVisible: (value: boolean) => renders.push(`working:${value}`),
    showError: (value: string) => errors.push(value),
    showStatus: (value: string) => renders.push(`status:${value}`),
    footer: { invalidate: () => renders.push("footer") },
    updateEditorBorderColor: () => renders.push("border"),
    chatContainer: childContainer(),
    pendingMessagesContainer: childContainer(),
    pendingTools: new Map(),
    compactionQueuedMessages: [],
    renderSessionContext: (_context: any, options: any) =>
      renders.push(`history:${options.populateHistory}`),
    handleRuntimeSessionChange: async () => renders.push("session-change"),
  });

  await proto.handleEvent.call(instance, {
    type: "rpc_frontend_status",
    phase: "connecting",
    label: "Connecting",
  });
  const firstIndicator = instance.activeStatusIndicator;
  assert.equal(firstIndicator.kind, "rinRpcTransport");
  await proto.handleEvent.call(instance, {
    type: "rpc_frontend_status",
    phase: "sending",
    label: "Sending",
  });
  assert.equal(instance.activeStatusIndicator, firstIndicator);
  assert.equal(firstIndicator.message, "Sending...");
  await proto.handleEvent.call(instance, {
    type: "rpc_frontend_status",
    phase: "working",
    label: "Working",
  });
  assert.equal(instance.activeStatusIndicator, undefined);
  assert.equal(renders.includes("working:true"), true);

  await proto.handleEvent.call(instance, {
    type: "rpc_settings_mutation_error",
    error: "owner mutation",
  });
  assert.deepEqual(errors, ["Failed to save setting: owner mutation"]);
  await proto.handleEvent.call(instance, {
    type: "rpc_local_user_message",
    text: " owner local ",
  });
  assert.equal(
    fixture.events.some(
      ([name, event]) =>
        name === "original-event" &&
        event?.message?.content?.[0]?.text === "owner local",
    ),
    true,
  );
  const beforeEcho = fixture.events.length;
  await proto.handleEvent.call(instance, {
    type: "message_start",
    message: { role: "user", content: [{ type: "text", text: "owner local" }] },
  });
  assert.equal(fixture.events.length, beforeEcho);
  await proto.handleEvent.call(instance, { type: "rpc_session_resynced" });
  assert.equal(renders.includes("session-change"), true);
  assert.equal(renders.includes("history:true"), true);

  const local = {
    ...instance,
    session: { isStreaming: true },
    setWorkingVisible: (value: boolean) =>
      renders.push(`local-working:${value}`),
  };
  await proto.handleEvent.call(local, { type: "compaction_end" });
  assert.equal(renders.includes("local-working:true"), true);

  instance.handleEvent = proto.handleEvent;
  proto.subscribeToAgent.call(instance);
  await instance.session.callback({ type: "owner_event" });
  await flush();
  assert.equal(
    fixture.events.some(
      ([name, event]) =>
        name === "original-event" && event?.type === "owner_event",
    ),
    true,
  );

  assert.equal(proto.cycleThinkingLevel.call({}), "local-level");
  await proto.cycleThinkingLevel.call(instance);
  assert.equal(renders.includes("status:Thinking level: high"), true);
  instance.session.cycleThinkingLevel = async () => undefined;
  await proto.cycleThinkingLevel.call(instance);
  assert.equal(
    renders.includes("status:Current model does not support thinking"),
    true,
  );
  instance.session.cycleThinkingLevel = async () => {
    throw new Error("owner thinking failed");
  };
  await proto.cycleThinkingLevel.call(instance);
  assert.match(errors.at(-1) || "", /Failed to save thinking level/);

  await proto.handleEvent.call(instance, {
    type: "rpc_frontend_status",
    phase: "starting",
  });
  const startingIndicator = instance.activeStatusIndicator;
  await proto.handleEvent.call(instance, {
    type: "rpc_frontend_status",
    phase: "starting",
  });
  assert.equal(instance.activeStatusIndicator, startingIndicator);
  await proto.handleEvent.call(instance, {
    type: "rpc_frontend_status",
    phase: "compacting",
  });
  assert.equal(instance.activeStatusIndicator, undefined);
  await proto.handleEvent.call(instance, {
    type: "rpc_frontend_status",
    phase: "retrying",
  });
  await proto.handleEvent.call(instance, {
    type: "rpc_frontend_status",
    phase: "idle",
  });
  await proto.handleEvent.call(instance, {
    type: "rpc_frontend_status",
    phase: "unknown",
  });
  await proto.handleEvent.call(instance, {
    type: "rpc_settings_mutation_error",
  });
  assert.equal(errors.at(-1), "Failed to save setting: unknown error");
  const beforeBlankLocal = fixture.events.length;
  await proto.handleEvent.call(instance, {
    type: "rpc_local_user_message",
    text: "   ",
  });
  assert.equal(fixture.events.length, beforeBlankLocal);

  instance.activeStatusIndicator?.dispose?.();
});

test("patched lifecycle wrappers preserve native fallbacks and cleanup", async (t) => {
  resetFixture();
  await patches.applyRinTuiOverrides();
  const proto = InteractiveMode.prototype;
  const previousRuntimeRole = runtimeEnv.getRinTuiRuntimeRole();
  t.after(() => runtimeEnv.setRinTuiRuntimeRole(previousRuntimeRole));

  runtimeEnv.setRinTuiRuntimeRole("maintenance-tui");
  fixture.footerLines = ["only stats"];
  const maintenanceSession = {
    state: {
      model: { id: "maintenance-model", reasoning: true },
      thinkingLevel: "",
    },
    sessionManager: { getSessionName: () => "" },
  };
  const maintenanceFooter = new FooterComponent(maintenanceSession, {});
  assert.deepEqual(maintenanceFooter.render(30), ["only stats"]);
  assert.deepEqual(fixture.events.at(-1), [
    "footer-render",
    30,
    "maintenance-model",
    "thinking off • maint",
  ]);
  assert.equal(maintenanceSession.state.thinkingLevel, "");
  fixture.footerLines = [];
  assert.deepEqual(maintenanceFooter.render(30), []);
  runtimeEnv.setRinTuiRuntimeRole(undefined);
  fixture.footerLines = ["upstream"];
  assert.deepEqual(new FooterComponent({ state: {} }, {}).render(20), [
    "upstream",
  ]);

  let branded = "";
  const collapsedHeader = {
    getCollapsedText: () => "pi v0.80.0 compact",
    getExpandedText: () => "Pi expanded",
    setText(value: string) {
      branded = value;
    },
  };
  await proto.init.call({
    isInitialized: true,
    builtInHeader: collapsedHeader,
    version: "0.80.0",
  });
  assert.equal(branded, "rin v1.2.3 compact");
  assert.equal(collapsedHeader.getCollapsedText(), "rin v1.2.3 compact");

  const decorations: string[] = [];
  const rebindInstance = {
    showLoadedResources: () => decorations.push("resources"),
    showStartupNoticesIfNeeded: () => decorations.push("notices"),
  };
  const originalResources = rebindInstance.showLoadedResources;
  const originalNotices = rebindInstance.showStartupNoticesIfNeeded;
  assert.equal(
    await proto.rebindCurrentSession.call(rebindInstance, "owner-rebind"),
    "rebound",
  );
  assert.equal(rebindInstance.showLoadedResources, originalResources);
  assert.equal(rebindInstance.showStartupNoticesIfNeeded, originalNotices);
  assert.deepEqual(decorations, []);

  const replacementEvents: string[] = [];
  proto.renderCurrentSessionState.call({
    session: { state: { messages: [] } },
    sessionManager: { getEntries: () => [{ type: "message" }] },
    chatContainer: childContainer(),
    pendingMessagesContainer: childContainer(),
    pendingTools: new Map(),
    compactionQueuedMessages: [],
    showLoadedResources: () => replacementEvents.push("resources"),
    showStartupNoticesIfNeeded: () => replacementEvents.push("notices"),
    renderInitialMessages: () => replacementEvents.push("render"),
  });
  assert.deepEqual(replacementEvents, ["render"]);

  const terminalWrites: Array<string | Uint8Array> = [];
  const originalStdoutWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    terminalWrites.push(chunk);
    return true;
  }) as any;
  try {
    const terminal = new piTui.ProcessTerminal();
    terminal.write("before\u001b[3Jafter");
    terminal.write(Buffer.from("buffer-owner"));
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
  assert.equal(terminalWrites[0], "beforeafter");
  assert.deepEqual(terminalWrites[1], Buffer.from("buffer-owner"));

  const stableUpdate = {
    chatContainer: childContainer(),
    ui: {
      renders: 0,
      requestRender() {
        this.renders += 1;
      },
    },
  };
  patches.showRinUpdateNotification(stableUpdate, {
    channel: "stable",
    version: "2.0.0",
    command: "rin update",
  });
  assert.match(
    stableUpdate.chatContainer.children[2].text,
    /New version 2\.0\.0/,
  );

  const versions: string[] = [];
  const changelogInstance = {
    session: { state: { messages: [{ role: "user" }] } },
    settingsManager: {
      getLastChangelogVersion: () => "1.0.0",
      setLastChangelogVersion: (value: string) => versions.push(value),
    },
  };
  assert.equal(proto.getChangelogForDisplay.call(changelogInstance), undefined);
  changelogInstance.session.state.messages = [];
  fixture.currentVersion = "not-a-version";
  assert.equal(proto.getChangelogForDisplay.call(changelogInstance), undefined);
  fixture.currentVersion = "1.2.3";
  changelogInstance.settingsManager.getLastChangelogVersion = () => "invalid";
  assert.equal(proto.getChangelogForDisplay.call(changelogInstance), undefined);
  assert.deepEqual(versions, ["1.2.3"]);
  changelogInstance.settingsManager.getLastChangelogVersion = () => "1.2.3";
  fixture.newEntries = [];
  assert.equal(proto.getChangelogForDisplay.call(changelogInstance), undefined);

  const runEvents: any[] = [];
  let loopInputs = 0;
  await assert.rejects(
    proto.run.call({
      isInitialized: true,
      init: async () => runEvents.push(["init"]),
      options: {
        initialMessage: "initial-error",
        initialMessages: ["batch-error"],
        rinStartHiddenInitialization: true,
      },
      session: {
        modelRegistry: { getError: () => undefined },
        prompt: async () => {
          throw "plain prompt failure";
        },
      },
      showWarning: (message: string) => runEvents.push(["warning", message]),
      showError: (message: string) => runEvents.push(["error", message]),
      checkTmuxKeyboardSetup: async () => undefined,
      getUserInput: async () => {
        loopInputs += 1;
        if (loopInputs === 1) return "loop-error";
        throw new Error("stop fallback loop");
      },
    }),
    /stop fallback loop/,
  );
  await flush();
  assert.equal(
    runEvents.filter(
      ([kind, message]) =>
        kind === "error" && message === "Unknown error occurred",
    ).length,
    4,
  );
});

test("remote selectors and extension fallbacks keep bounded ownership", async () => {
  resetFixture();
  await patches.applyRinTuiOverrides();
  const proto = InteractiveMode.prototype;

  const settingEvents: any[] = [];
  const settingsList: any = {
    items: [],
    filteredItems: [],
    onChange: () => settingEvents.push(["upstream"]),
  };
  fixture.extensionStates = [
    {
      id: "memory",
      label: "Memory",
      description: "Owner memory",
      enabled: false,
    },
  ];
  const settingsInstance = {
    editorContainer: {
      children: [{ getSettingsList: () => settingsList }],
    },
    settingsManager: { owner: "remote" },
    session: {
      call: async (name: string) => {
        settingEvents.push(["call", name]);
        throw new Error("reload rejected");
      },
    },
    showError: (message: string) => settingEvents.push(["error", message]),
  };
  proto.showSettingsSelector.call(settingsInstance);
  assert.equal(settingsList.items[0].currentValue, "false");
  settingsList.onChange("rin-built-in-extension:memory", "true");
  await flush();
  assert.deepEqual(settingEvents, [["call", "reload"]]);
  proto.showSettingsSelector.call({ editorContainer: { children: [] } });

  let remoteCalls = 0;
  const selectorEvents: any[] = [];
  let selectorResult: any;
  const remoteSession: any = {
    getFrontendStatusEvent: () => ({ phase: "idle" }),
    async listSessionPage(scope: string, options: any) {
      remoteCalls += 1;
      selectorEvents.push(["page", scope, options]);
      if (remoteCalls === 1) {
        return {
          sessions: [{ id: "remote-one" }],
          offset: "invalid",
          limit: 0,
          total: 2,
          nextOffset: 1,
          hasMore: true,
        };
      }
      throw new Error("remote page rejected");
    },
    async listSessions(scope: string) {
      selectorEvents.push(["list", scope]);
      return [{ id: "remote-all", cwd: "/hidden" }];
    },
    async renameSession(sessionPath: string, name: string) {
      selectorEvents.push(["rename", sessionPath, name]);
    },
  };
  const selectorInstance = {
    session: remoteSession,
    sessionManager: {
      getCwd: () => "/unused",
      getSessionFile: () => "/owner/current.jsonl",
    },
    keybindings: { owner: "remote" },
    ui: { requestRender: () => selectorEvents.push(["render"]) },
    showSelector(factory: any) {
      selectorResult = factory(() => selectorEvents.push(["done"]));
    },
    handleResumeSession: async () => {},
    shutdown: async () => {},
  };
  proto.showSessionSelector.call(selectorInstance);
  const selector = selectorResult.component;
  const progress: any[] = [];
  assert.deepEqual(
    await selector.currentLoader((loaded: number, total: number) =>
      progress.push([loaded, total]),
    ),
    [{ id: "remote-one" }],
  );
  assert.deepEqual(progress, [[1, 2]]);
  selector.sessionList.filteredSessions = [{ id: "remote-one" }];
  selector.sessionList.selectedIndex = Number.NaN;
  selector.sessionList.handleInput("down");
  await flush();
  assert.equal(
    fixture.events.some(
      ([name, status]) =>
        name === "selector-status" &&
        /remote page rejected/.test(status.message),
    ),
    true,
  );

  remoteSession.listSessionPage = undefined;
  const allSessions = await selector.allLoader();
  assert.deepEqual(allSessions, [{ id: "remote-all", cwd: undefined }]);
  await selector.options.renameSession("/owner/remote.jsonl", " Remote name ");
  assert.equal(
    selectorEvents.some(
      ([name, sessionPath, nextName]) =>
        name === "rename" &&
        sessionPath === "/owner/remote.jsonl" &&
        nextName === "Remote name",
    ),
    true,
  );

  const header = selector.header;
  header.sortMode = "recent";
  header.nameFilter = "named";
  header.loading = true;
  header.loadProgress = null;
  assert.match(header.render(80)[0], /Loading/);
  header.loadProgress = { loaded: 1, total: 2 };
  assert.match(header.render(80)[0], /1\/2/);
  header.loading = false;
  header.scope = "all";
  header.sortMode = "fuzzy";
  assert.match(header.render(80)[0], /Fuzzy/);
  header.confirmingDeletePath = "/owner/remote.jsonl";
  assert.match(header.render(80)[1], /Delete session/);
  header.confirmingDeletePath = null;
  header.statusMessage = { type: "error", message: "Owner selector error" };
  assert.match(header.render(80)[1], /Owner selector error/);
  header.statusMessage = { type: "info", message: "Owner selector info" };
  assert.match(header.render(80)[1], /Owner selector info/);
  header.statusMessage = null;
  header.showPath = true;
  header.showRenameHint = false;
  assert.match(header.render(200)[2], /path \(on\)/);
});
