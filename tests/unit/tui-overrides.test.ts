import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);

const overrides = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "pi", "tui-patches", "index.js"),
  ).href
);
const loaderModule = await import(
  pathToFileURL(
    path.join(
      rootDir,
      "node_modules",
      "@earendil-works",
      "pi-tui",
      "dist",
      "components",
      "loader.js",
    ),
  ).href
);
const piTuiModule = await import("@earendil-works/pi-tui");
const codingAgentModule = await import("@earendil-works/pi-coding-agent");
const { RpcInteractiveSession } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-tui", "runtime.js"))
    .href
);
const themeModule = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "pi", "private-api.js")).href
);
const tuiRuntimeEnv = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "tui-runtime-env.js")).href
);

const ESC = "\u001b";

const settingsManagerWithoutTerminalProgress = {
  getShowTerminalProgress() {
    return false;
  },
};

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-tui-overrides-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function showStatusIndicatorForTest(indicator) {
  this.activeStatusIndicator?.dispose?.();
  this.activeStatusIndicator = indicator;
  this.statusContainer?.clear?.();
  this.statusContainer?.addChild?.(indicator);
}

function clearStatusIndicatorForTest(kind) {
  if (kind && this.activeStatusIndicator?.kind !== kind) return;
  this.activeStatusIndicator?.dispose?.();
  this.activeStatusIndicator = undefined;
  this.statusContainer?.clear?.();
}

function createRealInteractiveModeResyncInstance(overrides = {}) {
  const entries = [];
  const prototype = codingAgentModule.InteractiveMode.prototype;
  const instance = Object.create(prototype);
  const values = {
    isInitialized: true,
    session: {
      getFrontendStatusEvent() {
        return null;
      },
    },
    sessionManager: {
      buildContextEntries() {
        return entries;
      },
      getEntries() {
        return entries;
      },
      getCwd() {
        return "/tmp";
      },
    },
    settingsManager: {
      getShowCacheMissNotices() {
        return false;
      },
      getShowTerminalProgress() {
        return false;
      },
      isProjectTrusted() {
        return true;
      },
    },
    ui: {
      requestRender() {},
      terminal: { setProgress() {} },
    },
    chatContainer: {
      children: [],
      clear() {
        this.children = [];
      },
      addChild(child) {
        this.children.push(child);
      },
      removeChild() {},
    },
    pendingMessagesContainer: { clear() {} },
    pendingTools: new Map(),
    defaultEditor: { onEscape() {} },
    footer: { invalidate() {} },
    statusContainer: { clear() {}, addChild() {} },
    updateEditorBorderColor() {},
    flushCompactionQueue() {},
    showError() {},
    showStatus() {},
    handleRuntimeSessionChange: async () => {},
    ...overrides,
  };
  Object.defineProperties(
    instance,
    Object.fromEntries(
      Object.entries(values).map(([name, value]) => [
        name,
        {
          value,
          writable: true,
          configurable: true,
          enumerable: true,
        },
      ]),
    ),
  );
  return instance;
}

function createZeroExtensionCustomEntryRenderInstance() {
  const rpcSession = new RpcInteractiveSession(
    {
      send() {
        return Promise.resolve({ success: true, data: {} });
      },
      subscribe() {
        return () => {};
      },
      isConnected() {
        return true;
      },
    },
    { noExtensions: true },
  );
  const historyMessage = {
    role: "user",
    content: [{ type: "text", text: "history after custom state" }],
  };
  const entries = [
    {
      type: "custom",
      customType: "rin-system-prompt-state",
      data: { version: 1, systemPrompt: "core state" },
    },
    { type: "message", message: historyMessage },
  ];
  const renderedItems = [];
  const addedMessages = [];
  let chatClears = 0;
  let footerInvalidations = 0;
  const proto = codingAgentModule.InteractiveMode.prototype;

  rpcSession.messages = [historyMessage];
  rpcSession.state.messages = rpcSession.messages;
  rpcSession.getFrontendStatusEvent = () => null;

  const instance = {
    isInitialized: true,
    session: rpcSession,
    sessionManager: {
      buildContextEntries() {
        return entries;
      },
      getEntries() {
        return entries;
      },
    },
    settingsManager: settingsManagerWithoutTerminalProgress,
    ui: {
      terminal: { setProgress() {} },
      requestRender() {},
    },
    chatContainer: {
      clear() {
        chatClears += 1;
      },
      addChild() {},
      removeChild() {},
    },
    pendingMessagesContainer: { clear() {} },
    pendingTools: new Map(),
    defaultEditor: { onEscape() {} },
    footer: {
      invalidate() {
        footerInvalidations += 1;
      },
    },
    statusContainer: { clear() {}, addChild() {} },
    activeStatusIndicator: undefined,
    compactionQueuedMessages: [],
    streamingComponent: undefined,
    streamingMessage: undefined,
    renderInitialMessages: proto.renderInitialMessages,
    renderSessionEntries: proto.renderSessionEntries,
    addCustomEntryToChat: proto.addCustomEntryToChat,
    rebuildChatFromMessages: proto.rebuildChatFromMessages,
    renderSessionItems(items) {
      for (const item of items) {
        if (item?.type === "custom") {
          this.addCustomEntryToChat(item);
        } else {
          renderedItems.push(item);
        }
      }
    },
    addMessageToChat(message) {
      addedMessages.push(message);
    },
    renderProjectTrustWarningIfNeeded() {},
    showStatus() {},
    showError() {},
    showStatusIndicator: showStatusIndicatorForTest,
    clearStatusIndicator: clearStatusIndicatorForTest,
    flushCompactionQueue() {},
  };

  return {
    instance,
    renderedItems,
    addedMessages,
    getChatClears: () => chatClears,
    getFooterInvalidations: () => footerInvalidations,
  };
}

async function writeTuiSessionRecord(agentDir, options) {
  const sessionDir = path.join(agentDir, "sessions");
  await fs.mkdir(sessionDir, { recursive: true });
  const sessionPath = path.join(sessionDir, `${options.id}.jsonl`);
  await fs.writeFile(
    sessionPath,
    [
      {
        type: "session",
        version: 3,
        id: options.id,
        timestamp: "2026-04-18T00:00:00.000Z",
        cwd: options.cwd,
      },
      {
        type: "message",
        id: `${options.id}-user`,
        timestamp: "2026-04-18T00:01:00.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: options.firstMessage }],
        },
      },
      {
        type: "message",
        id: `${options.id}-assistant`,
        timestamp: "2026-04-18T00:02:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "assistant reply" }],
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  return sessionPath;
}

test("terminal title override shows only session name", async () => {
  await overrides.applyRinTuiOverrides();

  let title;
  codingAgentModule.InteractiveMode.prototype.updateTerminalTitle.call({
    sessionManager: { getSessionName: () => "demo" },
    ui: {
      terminal: {
        setTitle(value) {
          title = value;
        },
      },
    },
  });

  assert.equal(title, "Rin - demo");
});

test("shutdown resume hint uses rin command name", async () => {
  await overrides.applyRinTuiOverrides();
  await withTempDir(async (dir) => {
    const sessionId = "019e8caf-eeca-79c8-bf3d-a9603adceae2";
    const sessionFile = path.join(dir, `${sessionId}.jsonl`);
    await fs.writeFile(sessionFile, "{}\n");

    const writes = [];
    const originalWrite = process.stdout.write;
    const originalExit = process.exit;
    const originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
    process.stdout.write = function write(chunk, ...args) {
      writes.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      const callback = args.find((arg) => typeof arg === "function");
      callback?.();
      return true;
    };
    process.exit = ((code) => {
      throw new Error(`exit:${code}`);
    }) as never;

    try {
      await assert.rejects(
        codingAgentModule.InteractiveMode.prototype.shutdown.call({
          isShuttingDown: false,
          unregisterSignalHandlers() {},
          ui: { terminal: { async drainInput() {} } },
          stop() {},
          themeController: { disableAutoSync() {} },
          runtimeHost: { async dispose() {} },
          sessionManager: {
            isPersisted: () => true,
            getSessionFile: () => sessionFile,
            usesDefaultSessionDir: () => false,
            getSessionDir: () => dir,
            getSessionId: () => sessionId,
          },
        }),
        /exit:0/,
      );
    } finally {
      process.stdout.write = originalWrite;
      process.exit = originalExit;
      Object.defineProperty(process.stdout, "isTTY", {
        value: originalIsTTY,
        configurable: true,
      });
    }

    const output = writes.join("");
    assert.match(output, /To resume this session:/);
    assert.ok(
      output.includes(`rin --session-dir ${dir} --session ${sessionId}`),
      output,
    );
    assert.doesNotMatch(output, /(^|\s)pi --session-dir/);
  });
});

test("recoverable runtime errors stay in the TUI without stopping it", () => {
  const overridesUrl = pathToFileURL(
    path.join(rootDir, "dist", "core", "pi", "tui-patches", "index.js"),
  ).href;
  const script = `
    const overrides = await import(${JSON.stringify(overridesUrl)});
    const codingAgent = await import("@earendil-works/pi-coding-agent");
    await overrides.applyRinTuiOverrides();
    const outcome = await codingAgent.InteractiveMode.prototype.handleFatalRuntimeError.call({
      session: { getFrontendStatusEvent() { return { phase: "ready" }; } },
      stop() { process.stderr.write("terminal-stopped\\n"); },
      showError(message) { process.stderr.write(\`shown: \${message}\\n\`); },
    }, "Failed to resume session", new Error("renderer exploded"));
    process.stderr.write(\`outcome: \${JSON.stringify(outcome)}\\n\`);
    process.stderr.write("tui-still-running\\n");
  `;

  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    { cwd: rootDir, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stderr,
    /shown: Failed to resume session: renderer exploded/,
  );
  assert.match(result.stderr, /outcome: \{"cancelled":true\}/);
  assert.match(result.stderr, /tui-still-running/);
  assert.doesNotMatch(result.stderr, /terminal-stopped|Rin fatal error/);
});

test("rpc transport failures defer to Connecting without showing an error", () => {
  const overridesUrl = pathToFileURL(
    path.join(rootDir, "dist", "core", "pi", "tui-patches", "index.js"),
  ).href;
  const script = `
    const overrides = await import(${JSON.stringify(overridesUrl)});
    const codingAgent = await import("@earendil-works/pi-coding-agent");
    await overrides.applyRinTuiOverrides();
    const outcome = await codingAgent.InteractiveMode.prototype.handleFatalRuntimeError.call({
      session: { getFrontendStatusEvent() { return { phase: "connecting" }; } },
      stop() { process.stderr.write("terminal-stopped\\n"); },
      showError(message) { process.stderr.write(\`shown: \${message}\\n\`); },
    }, "Failed to resume session", new Error("rin_disconnected:get_state:req_1"));
    process.stderr.write(\`outcome: \${JSON.stringify(outcome)}\\n\`);
    process.stderr.write("tui-still-running\\n");
  `;

  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    { cwd: rootDir, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /outcome: \{"cancelled":true\}/);
  assert.match(result.stderr, /tui-still-running/);
  assert.doesNotMatch(
    result.stderr,
    /shown:|terminal-stopped|Rin TUI error|rin_disconnected/,
  );
});

test("runtime error reporting failures fall back without exiting", () => {
  const overridesUrl = pathToFileURL(
    path.join(rootDir, "dist", "core", "pi", "tui-patches", "index.js"),
  ).href;
  const script = `
    const overrides = await import(${JSON.stringify(overridesUrl)});
    const codingAgent = await import("@earendil-works/pi-coding-agent");
    await overrides.applyRinTuiOverrides();
    await codingAgent.InteractiveMode.prototype.handleFatalRuntimeError.call({
      stop() { process.stderr.write("terminal-stopped\\n"); },
      showError() { throw new Error("error panel failed"); },
    }, "Failed to resume session", new Error("renderer exploded"));
    process.stderr.write("tui-still-running\\n");
  `;

  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    { cwd: rootDir, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Rin TUI error/);
  assert.match(result.stderr, /Failed to resume session: renderer exploded/);
  assert.match(
    result.stderr,
    /Unable to render this error: error panel failed/,
  );
  assert.match(result.stderr, /tui-still-running/);
  assert.doesNotMatch(result.stderr, /terminal-stopped|Rin fatal error/);
});

test("async runtime error reporting failures fall back without exiting", () => {
  const overridesUrl = pathToFileURL(
    path.join(rootDir, "dist", "core", "pi", "tui-patches", "index.js"),
  ).href;
  const script = `
    const overrides = await import(${JSON.stringify(overridesUrl)});
    const codingAgent = await import("@earendil-works/pi-coding-agent");
    await overrides.applyRinTuiOverrides();
    await codingAgent.InteractiveMode.prototype.handleFatalRuntimeError.call({
      stop() { process.stderr.write("terminal-stopped\\n"); },
      showError() { return Promise.reject(new Error("async error panel failed")); },
    }, "Failed to resume session", new Error("renderer exploded"));
    await new Promise((resolve) => setImmediate(resolve));
    process.stderr.write("tui-still-running\\n");
  `;

  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    { cwd: rootDir, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Rin TUI error/);
  assert.match(result.stderr, /Failed to resume session: renderer exploded/);
  assert.match(
    result.stderr,
    /Unable to render this error: async error panel failed/,
  );
  assert.match(result.stderr, /tui-still-running/);
  assert.doesNotMatch(result.stderr, /terminal-stopped|Rin fatal error/);
});

test("startup header override replaces upstream Pi branding with Rin", async () => {
  await overrides.applyRinTuiOverrides();

  const header = {
    text: "",
    getCollapsedText() {
      return "pi v0.74.0\nshort help\n\nPi can explain its own features and look up its docs. Ask it how to use or extend Pi.";
    },
    getExpandedText() {
      return "pi v0.74.0\nexpanded help\n\nPi can explain its own features and look up its docs. Ask it how to use or extend Pi.";
    },
    setText(value) {
      this.text = value;
    },
    setExpanded(expanded) {
      this.setText(expanded ? this.getExpandedText() : this.getCollapsedText());
    },
  };

  assert.equal(
    overrides.applyRinStartupHeaderBranding({
      builtInHeader: header,
      getStartupExpansionState: () => false,
    }),
    true,
  );

  assert.match(header.text, /Rin (?:unknown|[0-9a-f]{7,40})/);
  assert.match(header.text, /Rin can explain its own features/);
  assert.match(header.text, /Ask Rin how to use or extend Rin/);
  assert.doesNotMatch(header.text, /\bpi v0\.74\.0\b/i);
  assert.doesNotMatch(header.text, /extend Pi/);
  assert.match(
    codingAgentModule.InteractiveMode.prototype.init.toString(),
    /applyRinStartupHeaderBranding/,
  );
});

test("Rin update notice appends like the upstream Pi update notification", () => {
  themeModule.initTheme("dark", false);
  const chatContainer = new piTuiModule.Container();
  const renderText = () =>
    chatContainer.render(100).join("\n").replace(/\s+$/gm, "");
  let renderRequests = 0;
  const instance = {
    chatContainer,
    ui: {
      requestRender() {
        renderRequests += 1;
      },
    },
  };

  chatContainer.addChild(new piTuiModule.Text("startup line", 1, 0));
  chatContainer.addChild(new piTuiModule.Text("later async output", 1, 0));

  assert.equal(renderText(), " startup line\n later async output");

  overrides.showRinUpdateNotification(instance, {
    version: "1.2.3",
    channel: "stable",
    currentVersion: "1.2.2",
    command: "rin update",
  });

  const rendered = renderText();
  assert.ok(rendered.includes(`${ESC}[`));
  assert.ok(rendered.includes("─".repeat(20)));
  assert.ok(rendered.includes("Update Available"));
  assert.ok(rendered.includes("New version 1.2.3 is available. Run"));
  assert.ok(rendered.includes("rin update"));
  assert.ok(!rendered.includes("pi update"));
  assert.ok(rendered.includes("Changelog:"));
  assert.ok(rendered.includes("github.com/rinchan-hoshino/rin"));
  assert.ok(!rendered.includes("pi.dev/changelog"));
  assert.ok(!rendered.includes("Warning: Rin update available"));
  assert.ok(
    rendered.indexOf("startup line") < rendered.indexOf("later async output"),
  );
  assert.ok(
    rendered.indexOf("later async output") <
      rendered.indexOf("Update Available"),
  );
  assert.equal(renderRequests, 1);
});

function createResourceChromeInstance() {
  const chatContainer = new piTuiModule.Container();
  const loadedResourcesContainer = new piTuiModule.Container();
  const historyMessage = {
    role: "user",
    content: [{ type: "text", text: "history line" }],
  };
  const proto = codingAgentModule.InteractiveMode.prototype;
  const instance = {
    chatContainer,
    loadedResourcesContainer,
    options: { verbose: true },
    toolOutputExpanded: false,
    settingsManager: {
      getQuietStartup() {
        return false;
      },
    },
    session: {
      promptTemplates: [],
      resourceLoader: {
        getAgentsFiles() {
          return { agentsFiles: [] };
        },
        getSkills() {
          return {
            skills: [
              {
                name: "sample-skill",
                description: "sample skill",
                filePath: "/tmp/sample-skill/SKILL.md",
              },
            ],
            diagnostics: [],
          };
        },
        getPrompts() {
          return { prompts: [], diagnostics: [] };
        },
        getThemes() {
          return { themes: [], diagnostics: [] };
        },
        getExtensions() {
          return { extensions: [], errors: [] };
        },
      },
      extensionRunner: {
        getRegisteredCommands() {
          return [];
        },
        getCommandDiagnostics() {
          return [];
        },
        getShortcutDiagnostics() {
          return [];
        },
      },
    },
    sessionManager: {
      getCwd() {
        return "/tmp";
      },
      getEntries() {
        return [];
      },
      buildContextEntries() {
        return [{ type: "message", message: historyMessage }];
      },
    },
    renderSessionEntries(entries) {
      const messages = entries.flatMap((entry) =>
        entry.type === "message" ? [entry.message] : [],
      );
      for (const message of messages) {
        const text = Array.isArray(message.content)
          ? message.content.map((part) => part.text || "").join("")
          : String(message.content || "");
        this.chatContainer.addChild(new piTuiModule.Text(text, 1, 0));
      }
    },
    renderProjectTrustWarningIfNeeded() {},
    showStatus() {},
    ...Object.fromEntries(
      [
        "formatDisplayPath",
        "formatExtensionDisplayPath",
        "formatContextPath",
        "getStartupExpansionState",
        "getShortPath",
        "getCompactPathLabel",
        "getCompactPackageSourceLabel",
        "getCompactExtensionLabel",
        "getCompactDisplayPathSegments",
        "getCompactNonPackageExtensionLabel",
        "getCompactExtensionLabels",
        "getDisplaySourceInfo",
        "getScopeGroup",
        "isPackageSource",
        "buildScopeGroups",
        "formatScopeGroups",
        "findSourceInfoForPath",
        "formatPathWithSource",
        "formatDiagnostics",
        "getBuiltInCommandConflictDiagnostics",
        "showLoadedResources",
      ].map((name) => [name, proto[name]]),
    ),
  };
  return instance;
}

test("Rin update notice is transient when chat redraw clears startup chrome", () => {
  themeModule.initTheme("dark", false);
  const chatContainer = new piTuiModule.Container();
  const renderText = () =>
    chatContainer.render(100).join("\n").replace(/\s+$/gm, "");
  const instance = {
    chatContainer,
    ui: {
      requestRender() {},
    },
  };

  overrides.showRinUpdateNotification(instance, {
    version: "1.2.3",
    channel: "stable",
    currentVersion: "1.2.2",
    command: "rin update",
  });
  assert.ok(renderText().includes("Update Available"));

  chatContainer.clear();
  chatContainer.addChild(new piTuiModule.Text("new session line", 1, 0));

  const rendered = renderText();
  assert.ok(!rendered.includes("Update Available"));
  assert.ok(rendered.includes("new session line"));
});

test("chat rebuild preserves loaded resources while clearing Rin update notice", async () => {
  await overrides.applyRinTuiOverrides();
  themeModule.initTheme("dark", false);

  const instance = createResourceChromeInstance();
  const renderText = () =>
    [
      instance.loadedResourcesContainer.render(100).join("\n"),
      instance.chatContainer.render(100).join("\n"),
    ]
      .join("\n")
      .replace(/\s+$/gm, "");

  codingAgentModule.InteractiveMode.prototype.showLoadedResources.call(
    instance,
    { force: true },
  );
  overrides.showRinUpdateNotification(instance, {
    version: "1.2.3",
    channel: "stable",
    currentVersion: "1.2.2",
    command: "rin update",
  });

  assert.ok(renderText().includes("sample-skill"));
  assert.ok(renderText().includes("Update Available"));

  codingAgentModule.InteractiveMode.prototype.rebuildChatFromMessages.call(
    instance,
  );

  const rendered = renderText();
  assert.ok(rendered.includes("sample-skill"));
  assert.ok(!rendered.includes("Update Available"));
  assert.ok(rendered.includes("history line"));
});

test("direct initial-message redraw preserves loaded resources while clearing Rin update notice", async () => {
  await overrides.applyRinTuiOverrides();
  themeModule.initTheme("dark", false);

  const instance = createResourceChromeInstance();
  const renderText = () =>
    [
      instance.loadedResourcesContainer.render(100).join("\n"),
      instance.chatContainer.render(100).join("\n"),
    ]
      .join("\n")
      .replace(/\s+$/gm, "");

  codingAgentModule.InteractiveMode.prototype.showLoadedResources.call(
    instance,
    { force: true },
  );
  overrides.showRinUpdateNotification(instance, {
    version: "1.2.3",
    channel: "stable",
    currentVersion: "1.2.2",
    command: "rin update",
  });
  instance.chatContainer.clear();

  codingAgentModule.InteractiveMode.prototype.renderInitialMessages.call(
    instance,
  );

  const rendered = renderText();
  assert.ok(rendered.includes("sample-skill"));
  assert.ok(!rendered.includes("Update Available"));
  assert.ok(rendered.includes("history line"));
});

test("session rebind does not own chat startup decoration rendering", async () => {
  await overrides.applyRinTuiOverrides();

  const calls: string[] = [];
  const instance = {
    unsubscribe() {
      calls.push("unsubscribe");
    },
    applyRuntimeSettings() {
      calls.push("settings");
    },
    async bindCurrentSessionExtensions() {
      calls.push("bind");
      this.showLoadedResources({ force: false });
      this.showStartupNoticesIfNeeded();
    },
    subscribeToAgent() {
      calls.push("subscribe");
    },
    async updateAvailableProviderCount() {
      calls.push("providers");
    },
    updateEditorBorderColor() {
      calls.push("border");
    },
    updateTerminalTitle() {
      calls.push("title");
    },
    showLoadedResources() {
      calls.push("resources");
    },
    showStartupNoticesIfNeeded() {
      calls.push("startup-notices");
    },
  };

  await codingAgentModule.InteractiveMode.prototype.rebindCurrentSession.call(
    instance,
  );

  assert.deepEqual(calls, [
    "unsubscribe",
    "settings",
    "bind",
    "subscribe",
    "providers",
    "border",
    "title",
  ]);
});

test("session rebind preserves render-before-bind replacement redraw", async () => {
  await overrides.applyRinTuiOverrides();

  const calls: string[] = [];
  const instance = {
    unsubscribe() {
      calls.push("unsubscribe");
    },
    applyRuntimeSettings() {
      calls.push("settings");
    },
    renderCurrentSessionState() {
      calls.push("render");
    },
    subscribeToAgent() {
      calls.push("subscribe");
    },
    async bindCurrentSessionExtensions() {
      calls.push("bind");
    },
    async updateAvailableProviderCount() {
      calls.push("providers");
    },
    updateEditorBorderColor() {
      calls.push("border");
    },
    updateTerminalTitle() {
      calls.push("title");
    },
    showLoadedResources() {
      calls.push("resources");
    },
    showStartupNoticesIfNeeded() {
      calls.push("startup-notices");
    },
  };

  await codingAgentModule.InteractiveMode.prototype.rebindCurrentSession.call(
    instance,
    { renderBeforeBind: true },
  );

  assert.deepEqual(calls, [
    "unsubscribe",
    "settings",
    "render",
    "subscribe",
    "bind",
    "providers",
    "border",
    "title",
  ]);
});

test("session replacement final render owns startup decorations for empty sessions", () => {
  const calls: string[] = [];
  const instance = {
    chatContainer: { clear() {} },
    pendingMessagesContainer: { clear() {} },
    pendingTools: new Map([["tool", true]]),
    session: { messages: [] },
    showLoadedResources(options: unknown) {
      calls.push(`resources:${JSON.stringify(options)}`);
    },
    showStartupNoticesIfNeeded() {
      calls.push("startup-notices");
    },
    renderInitialMessages() {
      calls.push("messages");
    },
  };

  overrides.renderRinCurrentSessionStateAfterReplacement(instance);

  assert.deepEqual(calls, [
    'resources:{"force":false,"showDiagnosticsWhenQuiet":true}',
    "startup-notices",
    "messages",
  ]);
  assert.equal(instance.pendingTools.size, 0);
});

test("session replacement final render does not inject startup decorations into history", () => {
  const calls: string[] = [];
  const instance = {
    chatContainer: { clear() {} },
    pendingMessagesContainer: { clear() {} },
    pendingTools: new Map(),
    session: { messages: [{ role: "user", content: "hello" }] },
    showLoadedResources() {
      calls.push("resources");
    },
    showStartupNoticesIfNeeded() {
      calls.push("startup-notices");
    },
    renderInitialMessages() {
      calls.push("messages");
    },
  };

  overrides.renderRinCurrentSessionStateAfterReplacement(instance);

  assert.deepEqual(calls, ["messages"]);
});

test("zero-extension session replacement renders history after Rin core custom entries", async () => {
  await overrides.applyRinTuiOverrides();
  const { instance, renderedItems } =
    createZeroExtensionCustomEntryRenderInstance();

  overrides.renderRinCurrentSessionStateAfterReplacement(instance);

  assert.equal(instance.session.extensionOptions.noExtensions, true);
  assert.deepEqual(
    renderedItems.map((message) => message.role),
    ["user"],
  );
});

test("update overrides replace startup update path and keep single changelog version state", async () => {
  await overrides.applyRinTuiOverrides();

  await withTempDir(async (dir) => {
    const previousRinDir = process.env.RIN_DIR;
    let writtenVersion;
    try {
      process.env.RIN_DIR = dir;
      await fs.writeFile(
        path.join(dir, "installer.json"),
        `${JSON.stringify({
          currentRelease: {
            release: { version: "1.1.0-beta.20260519+abc1234" },
          },
        })}\n`,
        "utf8",
      );
      const changelogPath = path.join(dir, "docs", "release", "CHANGELOG.md");
      await fs.mkdir(path.dirname(changelogPath), { recursive: true });
      await fs.writeFile(
        changelogPath,
        [
          "# Rin Changelog",
          "",
          "## 1.1.0-beta.20260518",
          "",
          "- old beta",
          "",
          "## 1.1.0-beta.20260519+abc1234",
          "",
          "- beta fix",
          "",
        ].join("\n"),
        "utf8",
      );

      const changelog =
        codingAgentModule.InteractiveMode.prototype.getChangelogForDisplay.call(
          {
            settingsManager: {
              getLastChangelogVersion: () => "1.1.0-beta.20260518",
              setLastChangelogVersion: (version) => {
                writtenVersion = version;
              },
            },
            session: { state: { messages: [] } },
          },
        );

      assert.match(changelog, /beta fix/);
      assert.equal(writtenVersion, "1.1.0-beta.20260519+abc1234");
      assert.match(
        String(codingAgentModule.InteractiveMode.prototype.run),
        /scheduleRinUpdateNotificationWhenReady/,
      );
    } finally {
      if (previousRinDir === undefined) delete process.env.RIN_DIR;
      else process.env.RIN_DIR = previousRinDir;
    }
  });
});

test("startup header branding replaces upstream Pi name and version", async () => {
  assert.equal(
    overrides.rewriteRinStartupHeaderText(
      `${ESC}[38;5;109mpi${ESC}[39m${ESC}[38;5;241m v0.74.0${ESC}[39m\nPi can explain Pi.`,
      "0.74.0",
      "0.2.0-nightly.20260512+dc82e36",
    ),
    `${ESC}[38;5;109mrin${ESC}[39m${ESC}[38;5;241m v0.2.0-nightly.20260512+dc82e36${ESC}[39m\nRin can explain Rin.`,
  );

  let currentText = "";
  const header = {
    getCollapsedText: () => "pi v0.74.0\nPi can help.",
    getExpandedText: () => "pi v0.74.0\nExpanded Pi help.",
    setExpanded(expanded) {
      currentText = expanded ? this.getExpandedText() : this.getCollapsedText();
    },
  };
  overrides.applyRinStartupHeaderBranding({
    builtInHeader: header,
    version: "0.74.0",
    getStartupExpansionState: () => true,
  });

  assert.match(
    currentText,
    /^rin (?:unknown|[0-9a-f]{7,40})\nExpanded Rin help\.$/,
  );
  assert.match(
    String(codingAgentModule.InteractiveMode.prototype.init),
    /applyRinStartupHeaderBranding/,
  );
});

test("TUI exits when the input terminal closes", async () => {
  const source = await fs.readFile(
    path.join(rootDir, "src", "core", "pi", "tui-patches", "index.ts"),
    "utf8",
  );

  assert.doesNotMatch(source, /handleCtrlCWithQuickRunExit/);
  assert.match(source, /process\.stdin\.once\("end", terminalClosedHandler\)/);
  assert.match(
    source,
    /process\.stdin\.once\("close", terminalClosedHandler\)/,
  );
  assert.match(source, /this\.emergencyTerminalExit\?\.\(\)/);
});

test("quick run startup header hides Rin version", async () => {
  const previous = process.env.RIN_QUICK_RUN;
  try {
    process.env.RIN_QUICK_RUN = "1";
    assert.equal(
      overrides.rewriteRinStartupHeaderText(
        "pi v0.74.0\nPi can help.",
        "0.74.0",
        "0.0.0",
      ),
      "rin\nRin can help.",
    );
    assert.equal(
      overrides.rewriteRinStartupHeaderText(
        "pi v0.74.0\nPi can help.",
        undefined,
        "0.0.0",
      ),
      "Rin\nRin can help.",
    );
  } finally {
    if (previous === undefined) delete process.env.RIN_QUICK_RUN;
    else process.env.RIN_QUICK_RUN = previous;
  }
});

test("footer appends runtime mode to the model label before rendering", async () => {
  await overrides.applyRinTuiOverrides();
  themeModule.initTheme("dark", false);

  const session = {
    state: {
      model: {
        id: "gpt-demo",
        provider: "openai",
        contextWindow: 200000,
        reasoning: true,
      },
      thinkingLevel: "medium",
    },
    sessionManager: {
      getEntries: () => [],
      getCwd: () => "/tmp/project",
      getSessionName: () => undefined,
    },
    getContextUsage: () => ({ contextWindow: 200000, percent: 12.3 }),
    modelRegistry: { isUsingOAuth: () => false },
  };
  const footerData = {
    getGitBranch: () => "main",
    getAvailableProviderCount: () => 1,
    getExtensionStatuses: () => new Map([["demo", "syncing"]]),
  };
  const footer = new codingAgentModule.FooterComponent(session, footerData);

  try {
    tuiRuntimeEnv.setRinTuiRuntimeRole("rpc-frontend");
    let lines = footer.render(60);
    assert.match(lines.at(-1), /syncing/);
    assert.match(lines[0], /daemon/);
    assert.match(lines[0], /medium/);
    assert.doesNotMatch(lines[0], /mode:|rpc|std/);
    for (const line of lines) {
      assert.ok(piTuiModule.visibleWidth(line) <= 60);
    }

    session.state.model.id = "gpt-5.1-codex-max-2026-04-30";
    session.state.thinkingLevel = "high";
    footerData.getExtensionStatuses = () => new Map();
    lines = footer.render(80);
    assert.match(lines.at(-1), /gpt-5\.1-codex-max-2026-04-30/);
    assert.match(lines.at(-1), /high • daemon/);
    assert.ok(piTuiModule.visibleWidth(lines.at(-1)) <= 80);

    session.state.model.id = "gpt-demo";
    session.state.thinkingLevel = "medium";
    tuiRuntimeEnv.setRinTuiRuntimeRole("maintenance-tui");
    lines = footer.render(60);
    assert.match(lines[0], /medium • maint/);
    assert.doesNotMatch(lines[0], /mode:|rpc|std/);
    for (const line of lines) {
      assert.ok(piTuiModule.visibleWidth(line) <= 60);
    }
  } finally {
    tuiRuntimeEnv.setRinTuiRuntimeRole(undefined);
  }
});

test("full redraw override preserves terminal scrollback", async () => {
  await overrides.applyRinTuiOverrides();

  let captured = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk, ...args) => {
    captured += String(chunk);
    const callback = args.find((arg) => typeof arg === "function");
    if (callback) callback();
    return true;
  }) as typeof process.stdout.write;

  try {
    const terminal = new piTuiModule.ProcessTerminal();
    terminal.write("\u001b[?2026h\u001b[2J\u001b[H\u001b[3Jdemo");
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.equal(captured, "\u001b[?2026h\u001b[2J\u001b[Hdemo");
});

test("loader stop clears render interval", () => {
  let renders = 0;
  const loader = new loaderModule.Loader(
    {
      requestRender() {
        renders += 1;
      },
    },
    (x) => x,
    (x) => x,
    "demo",
  );
  assert.notEqual(loader.intervalId, null);
  loader.stop();
  assert.equal(loader.intervalId, null);
  assert.ok(renders >= 1);
});

test("rpc frontend startup statuses use one animated loader until working starts", async () => {
  await overrides.applyRinTuiOverrides();
  themeModule.initTheme("dark", false);

  let renders = 0;
  let clears = 0;
  let additions = 0;
  const instance = {
    isInitialized: true,
    settingsManager: settingsManagerWithoutTerminalProgress,
    session: {
      getFrontendStatusEvent() {
        return {
          type: "rpc_frontend_status",
          phase: "working",
          label: "Working",
          connected: true,
        };
      },
    },
    statusContainer: {
      child: undefined,
      clear() {
        clears += 1;
        this.child = undefined;
      },
      addChild(child) {
        additions += 1;
        this.child = child;
      },
    },
    ui: {
      requestRender() {
        renders += 1;
      },
      terminal: { setProgress() {} },
    },
    footer: { invalidate() {} },
    pendingTools: { clear() {} },
    retryCountdown: undefined,
    retryLoader: undefined,
    workingVisible: true,
    showStatusIndicator: showStatusIndicatorForTest,
    clearStatusIndicator: clearStatusIndicatorForTest,
    activeStatusIndicator: undefined,
  };

  await codingAgentModule.InteractiveMode.prototype.handleEvent.call(instance, {
    type: "rpc_frontend_status",
    phase: "starting",
    label: "Starting",
    connected: true,
  });

  const startupStatus = instance.statusContainer.child;
  assert.ok(startupStatus);
  assert.equal(
    startupStatus.constructor.name,
    "RinRpcTransportStatusIndicator",
  );
  assert.notEqual(startupStatus.intervalId, null);
  assert.ok(startupStatus.frames.length > 1);
  assert.equal(startupStatus.message, "Starting...");
  assert.equal(typeof startupStatus.stop, "function");
  const startupLines = startupStatus.render(40);
  assert.equal(startupLines.length, 2);
  assert.equal(startupLines[0], "");
  assert.equal(piTuiModule.visibleWidth(startupLines[0]), 0);
  assert.equal(piTuiModule.visibleWidth(startupLines[1]), 40);
  assert.match(startupLines[1], /Starting\.\.\./);
  assert.equal(additions, 1);
  assert.ok(renders >= 1);

  const rendersAfterStarting = renders;
  await codingAgentModule.InteractiveMode.prototype.handleEvent.call(instance, {
    type: "rpc_frontend_status",
    phase: "starting",
    label: "Starting",
    connected: true,
  });
  assert.equal(instance.statusContainer.child, startupStatus);
  assert.equal(additions, 1);
  assert.equal(renders, rendersAfterStarting);

  await codingAgentModule.InteractiveMode.prototype.handleEvent.call(instance, {
    type: "rpc_frontend_status",
    phase: "connecting",
    label: "Connecting",
    connected: true,
  });
  assert.equal(instance.statusContainer.child, startupStatus);
  assert.notEqual(startupStatus.intervalId, null);
  assert.equal(startupStatus.message, "Connecting...");
  const connectingLines = startupStatus.render(40);
  assert.equal(connectingLines[0], "");
  assert.match(connectingLines[1], /Connecting\.\.\./);
  assert.equal(additions, 1);

  await codingAgentModule.InteractiveMode.prototype.handleEvent.call(instance, {
    type: "rpc_frontend_status",
    phase: "working",
    label: "Working",
    connected: true,
  });

  assert.equal(instance.statusContainer.child, undefined);
  assert.equal(startupStatus.intervalId, null);
  assert.ok(clears >= 1);
});

test("rpc transport status remains visible after ordinary events while reconnecting", async () => {
  await overrides.applyRinTuiOverrides();
  themeModule.initTheme("dark", false);

  let additions = 0;
  const instance = {
    isInitialized: true,
    settingsManager: settingsManagerWithoutTerminalProgress,
    session: {
      getFrontendStatusEvent() {
        return {
          type: "rpc_frontend_status",
          phase: "connecting",
          label: "Connecting",
          connected: false,
        };
      },
    },
    statusContainer: {
      child: undefined,
      clear() {
        this.child = undefined;
      },
      addChild(child) {
        additions += 1;
        this.child = child;
      },
    },
    ui: {
      requestRender() {},
      terminal: { setProgress() {} },
    },
    footer: { invalidate() {} },
    pendingTools: { clear() {} },
    retryCountdown: undefined,
    retryLoader: undefined,
    workingVisible: false,
    showStatusIndicator: showStatusIndicatorForTest,
    clearStatusIndicator: clearStatusIndicatorForTest,
    activeStatusIndicator: undefined,
  };

  try {
    await codingAgentModule.InteractiveMode.prototype.handleEvent.call(
      instance,
      {
        type: "rpc_frontend_status",
        phase: "connecting",
        label: "Connecting",
        connected: false,
      },
    );

    const connectingStatus = instance.statusContainer.child;
    assert.ok(connectingStatus);
    assert.equal(connectingStatus.message, "Connecting...");

    await codingAgentModule.InteractiveMode.prototype.handleEvent.call(
      instance,
      {
        type: "status",
        level: "warning",
        text: "Waiting daemon...",
      },
    );

    assert.ok(instance.statusContainer.child);
    assert.equal(instance.statusContainer.child.message, "Connecting...");
    assert.equal(additions, 2);
  } finally {
    instance.activeStatusIndicator?.dispose?.();
  }
});

test("rpc transport statuses use Pi's status API as the only component owner", async () => {
  await overrides.applyRinTuiOverrides();

  const calls = [];
  const instance = {
    isInitialized: true,
    ui: { requestRender() {} },
    statusContainer: {
      child: undefined,
      clear() {
        this.child = undefined;
      },
      addChild(child) {
        this.child = child;
      },
    },
    session: {
      isStreaming: true,
      getFrontendStatusEvent() {
        return {
          type: "rpc_frontend_status",
          phase: "starting",
          label: "Starting",
          connected: false,
        };
      },
    },
    showStatusIndicator(indicator) {
      calls.push({ method: "showStatusIndicator", kind: indicator.kind });
      this.semanticIndicator = indicator;
    },
    clearStatusIndicator(kind) {
      calls.push({ method: "clearStatusIndicator", kind });
      this.semanticIndicator?.dispose?.();
      this.semanticIndicator = undefined;
    },
    setWorkingVisible(visible) {
      calls.push({ method: "setWorkingVisible", visible });
    },
  };

  try {
    await codingAgentModule.InteractiveMode.prototype.handleEvent.call(
      instance,
      {
        type: "rpc_frontend_status",
        phase: "starting",
        label: "Starting",
        connected: false,
      },
    );
    assert.deepEqual(calls, [
      { method: "showStatusIndicator", kind: "rinRpcTransport" },
    ]);

    calls.length = 0;
    await codingAgentModule.InteractiveMode.prototype.handleEvent.call(
      instance,
      {
        type: "rpc_frontend_status",
        phase: "working",
        label: "Working",
        connected: true,
      },
    );
    assert.deepEqual(calls, [
      { method: "clearStatusIndicator", kind: "rinRpcTransport" },
    ]);
  } finally {
    instance.semanticIndicator?.dispose?.();
    instance.statusContainer.child?.stop?.();
  }
});

test("Rin status coordination does not read Pi private component fields", async () => {
  const source = await fs.readFile(
    path.join(rootDir, "src", "core", "pi", "tui-patches", "index.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /\b(?:activeStatusIndicator|loadingAnimation)\b/);
});

test("rpc transport status cannot synthesize Pi Working", async () => {
  await overrides.applyRinTuiOverrides();
  themeModule.initTheme("dark", false);

  let renders = 0;
  const ui = {
    requestRender() {
      renders += 1;
    },
    terminal: { setProgress() {} },
  };
  const instance = {
    isInitialized: true,
    ui,
    settingsManager: settingsManagerWithoutTerminalProgress,
    session: {
      isStreaming: true,
      getFrontendStatusEvent() {
        return {
          type: "rpc_frontend_status",
          phase: "working",
          label: "Working",
          connected: true,
        };
      },
    },
    workingVisible: true,
    defaultWorkingMessage: "Working...",
    statusContainer: {
      child: undefined,
      clear() {
        this.child = undefined;
      },
      addChild(child) {
        this.child = child;
      },
    },
    footer: { invalidate() {} },
    pendingTools: new Map(),
    showStatusIndicator: showStatusIndicatorForTest,
    clearStatusIndicator: clearStatusIndicatorForTest,
    setWorkingVisible: (codingAgentModule.InteractiveMode.prototype as any)
      .setWorkingVisible,
    activeStatusIndicator: undefined,
  };

  try {
    await codingAgentModule.InteractiveMode.prototype.handleEvent.call(
      instance,
      { type: "agent_start" },
    );
    const initialWorkingIndicator = instance.activeStatusIndicator;
    assert.equal(initialWorkingIndicator?.kind, "working");

    await codingAgentModule.InteractiveMode.prototype.handleEvent.call(
      instance,
      {
        type: "rpc_frontend_status",
        phase: "connecting",
        label: "Connecting",
        connected: false,
      },
    );
    assert.equal(instance.activeStatusIndicator?.kind, "rinRpcTransport");

    renders = 0;
    await codingAgentModule.InteractiveMode.prototype.handleEvent.call(
      instance,
      {
        type: "rpc_frontend_status",
        phase: "working",
        label: "Working",
        connected: true,
      },
    );

    assert.equal(instance.activeStatusIndicator, undefined);
    assert.notEqual(instance.activeStatusIndicator, initialWorkingIndicator);
    assert.equal(instance.statusContainer.child, undefined);
    assert.ok(renders >= 1);
  } finally {
    instance.activeStatusIndicator?.dispose?.();
  }
});

test("rpc backend visibility keeps Pi native agent_start Working disabled", async () => {
  await overrides.applyRinTuiOverrides();
  themeModule.initTheme("dark", false);

  const instance = {
    isInitialized: true,
    ui: {
      requestRender() {},
      terminal: { setProgress() {} },
    },
    settingsManager: settingsManagerWithoutTerminalProgress,
    session: {
      isStreaming: true,
      getFrontendStatusEvent() {
        return null;
      },
    },
    workingVisible: true,
    defaultWorkingMessage: "Working...",
    statusContainer: {
      child: undefined,
      clear() {
        this.child = undefined;
      },
      addChild(child) {
        this.child = child;
      },
    },
    footer: { invalidate() {} },
    pendingTools: new Map(),
    showStatusIndicator: showStatusIndicatorForTest,
    clearStatusIndicator: clearStatusIndicatorForTest,
    setWorkingVisible: (codingAgentModule.InteractiveMode.prototype as any)
      .setWorkingVisible,
    activeStatusIndicator: undefined,
  };

  instance.setWorkingVisible(false);
  await codingAgentModule.InteractiveMode.prototype.handleEvent.call(instance, {
    type: "agent_start",
  });

  assert.equal(instance.workingVisible, false);
  assert.equal(instance.activeStatusIndicator, undefined);
  assert.equal(instance.statusContainer.child, undefined);
});

test("rpc retry completion waits for the next agent_start before Working", async () => {
  await overrides.applyRinTuiOverrides();
  themeModule.initTheme("dark", false);

  const ui = {
    requestRender() {},
    terminal: { setProgress() {} },
  };
  const instance = {
    isInitialized: true,
    ui,
    settingsManager: settingsManagerWithoutTerminalProgress,
    session: {
      isStreaming: true,
      retryAttempt: 0,
      abortRetry() {},
      getFrontendStatusEvent() {
        return {
          type: "rpc_frontend_status",
          phase: this.retryAttempt > 0 ? "retrying" : "working",
          label: this.retryAttempt > 0 ? "Retrying" : "Working",
          connected: true,
        };
      },
    },
    workingVisible: true,
    defaultWorkingMessage: "Working...",
    statusContainer: {
      child: undefined,
      clear() {
        this.child = undefined;
      },
      addChild(child) {
        this.child = child;
      },
    },
    footer: { invalidate() {} },
    pendingTools: new Map(),
    defaultEditor: { onEscape() {} },
    showError() {},
    showStatusIndicator: showStatusIndicatorForTest,
    clearStatusIndicator: clearStatusIndicatorForTest,
    setWorkingVisible: (codingAgentModule.InteractiveMode.prototype as any)
      .setWorkingVisible,
    activeStatusIndicator: undefined,
  };

  try {
    await codingAgentModule.InteractiveMode.prototype.handleEvent.call(
      instance,
      { type: "agent_start" },
    );
    assert.equal(instance.activeStatusIndicator?.kind, "working");

    instance.session.retryAttempt = 1;
    await codingAgentModule.InteractiveMode.prototype.handleEvent.call(
      instance,
      {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 1000,
      },
    );
    assert.equal(instance.activeStatusIndicator?.kind, "retry");

    instance.session.retryAttempt = 0;
    await codingAgentModule.InteractiveMode.prototype.handleEvent.call(
      instance,
      { type: "auto_retry_end", success: true, attempt: 1 },
    );
    assert.equal(instance.activeStatusIndicator, undefined);
  } finally {
    instance.activeStatusIndicator?.dispose?.();
  }
});

test("local session selector reuses bound session helpers for canonicalized list and rename", async () => {
  await overrides.applyRinTuiOverrides();

  await withTempDir(async (agentDir) => {
    const originalRinDir = process.env.RIN_DIR;
    process.env.RIN_DIR = agentDir;
    const renamed = [];
    let selector;
    const originalOpen = codingAgentModule.SessionManager.open;
    const cwd = "/tmp/project";
    const sessionPath = await writeTuiSessionRecord(agentDir, {
      id: "session-1",
      cwd,
      firstMessage: "Legacy title",
    });

    codingAgentModule.SessionManager.open = (targetPath) => ({
      appendSessionInfo(name) {
        renamed.push([targetPath, name]);
      },
    });

    try {
      const instance = {
        sessionManager: {
          getSessionFile: () => sessionPath,
          getCwd: () => cwd,
          getSessionDir: () => path.join(agentDir, "sessions", "encoded"),
        },
        keybindings: {},
        ui: { requestRender() {} },
        showSelector(factory) {
          selector = factory(() => {}).component;
          return selector;
        },
        handleResumeSession: async () => {},
        shutdown: async () => {},
      };

      codingAgentModule.InteractiveMode.prototype.showSessionSelector.call(
        instance,
      );

      const headerLines = selector.header.render(100);
      const headerText = headerLines.join("\n");
      assert.doesNotMatch(headerText, /Current|Folder|Directory/);
      assert.equal(piTuiModule.visibleWidth(headerLines[0]), 100);
      assert.ok(headerLines[0].endsWith(`Threaded${ESC}[39m`));
      selector.sessionList.setSessions([], false);
      assert.doesNotMatch(
        selector.sessionList.render(100).join("\n"),
        /current folder/i,
      );

      const sessions = await selector.currentSessionsLoader();
      await selector.renameSession(sessionPath, "renamed");

      assert.deepEqual(
        {
          id: sessions[0]?.id,
          path: sessions[0]?.path,
          name: sessions[0]?.name,
          firstMessage: sessions[0]?.firstMessage,
          modified: sessions[0]?.modified?.toISOString(),
          messageCount: sessions[0]?.messageCount,
          cwd: sessions[0]?.cwd,
          allMessagesText: sessions[0]?.allMessagesText,
        },
        {
          id: "session-1",
          path: sessionPath,
          name: undefined,
          firstMessage: "Legacy title",
          modified: "2026-04-18T00:02:00.000Z",
          messageCount: 2,
          cwd: undefined,
          allMessagesText: "Legacy title assistant reply",
        },
      );
      assert.deepEqual(renamed, [[sessionPath, "renamed"]]);
    } finally {
      if (originalRinDir === undefined) {
        delete process.env.RIN_DIR;
      } else {
        process.env.RIN_DIR = originalRinDir;
      }
      codingAgentModule.SessionManager.open = originalOpen;
    }
  });
});

test("rpc session selector loads sessions through the daemon instead of local SessionManager", async () => {
  await overrides.applyRinTuiOverrides();

  let listed = 0;
  const renamed = [];
  let selector;
  const instance = {
    session: {
      getFrontendStatusEvent() {
        return {
          type: "rpc_frontend_status",
          phase: "idle",
          label: "Idle",
          connected: true,
        };
      },
      async listSessions() {
        listed += 1;
        return [
          {
            id: "/tmp/demo.jsonl",
            path: "/tmp/demo.jsonl",
            firstMessage: "demo",
            modified: new Date("2026-04-16T00:00:00.000Z"),
            messageCount: 3,
            cwd: "/tmp",
            allMessagesText: "demo follow up",
          },
        ];
      },
      async renameSession(path, name) {
        renamed.push([path, name]);
      },
    },
    sessionManager: {
      getSessionFile: () => "/tmp/demo.jsonl",
      getCwd: () => "/tmp",
      getSessionDir: () => "/tmp/.sessions",
    },
    keybindings: {},
    ui: { requestRender() {} },
    showSelector(factory) {
      selector = factory(() => {}).component;
      return selector;
    },
    handleResumeSession: async () => {},
    shutdown: async () => {},
  };

  codingAgentModule.InteractiveMode.prototype.showSessionSelector.call(
    instance,
  );

  const sessions = await selector.currentSessionsLoader();
  await selector.renameSession("/tmp/demo.jsonl", "renamed");

  assert.equal(listed > 0, true);
  assert.equal(sessions[0].path, "/tmp/demo.jsonl");
  assert.equal(sessions[0].name, undefined);
  assert.equal(sessions[0].firstMessage, "demo");
  assert.equal(sessions[0].modified instanceof Date, true);
  assert.equal(sessions[0].messageCount, 3);
  assert.equal(sessions[0].cwd, undefined);
  assert.equal(sessions[0].allMessagesText, "demo follow up");
  assert.deepEqual(renamed, [["/tmp/demo.jsonl", "renamed"]]);
});

test("rpc session selector can append additional session pages", async () => {
  await overrides.applyRinTuiOverrides();

  const calls = [];
  let selector;
  const instance = {
    session: {
      getFrontendStatusEvent() {
        return {
          type: "rpc_frontend_status",
          phase: "idle",
          connected: true,
        };
      },
      async listSessionPage(_scope, options) {
        calls.push(options);
        const offset = options.offset || 0;
        return {
          sessions: [
            {
              id: `page-${offset + 1}`,
              path: `/tmp/page-${offset + 1}.jsonl`,
              firstMessage: `page ${offset + 1}`,
              modified: new Date(`2026-04-1${offset + 1}T00:00:00.000Z`),
              messageCount: 1,
              allMessagesText: `page ${offset + 1}`,
            },
          ],
          offset,
          limit: options.limit,
          total: 2,
          hasMore: offset === 0,
          nextOffset: offset + 1,
        };
      },
      async renameSession() {},
    },
    sessionManager: {
      getSessionFile: () => "/tmp/demo.jsonl",
      getCwd: () => "/tmp",
      getSessionDir: () => "/tmp/.sessions",
    },
    keybindings: {},
    ui: { requestRender() {} },
    showSelector(factory) {
      selector = factory(() => {}).component;
      return selector;
    },
    handleResumeSession: async () => {},
    shutdown: async () => {},
  };

  codingAgentModule.InteractiveMode.prototype.showSessionSelector.call(
    instance,
  );

  const firstPage = await selector.currentSessionsLoader();
  selector.currentSessions = firstPage;
  selector.sessionList.setSessions(firstPage, true);
  await selector.__rinSessionPagination.current.loadNext(selector, "current");

  assert.equal(
    calls.some((call) => call.offset === 0 && call.limit === 30),
    true,
  );
  assert.equal(
    calls.some((call) => call.offset === 1 && call.limit === 30),
    true,
  );
  assert.deepEqual(
    selector.currentSessions.map((session) => session.id),
    ["page-1", "page-2"],
  );
});

test("session selector rename ignores blank names", async () => {
  await overrides.applyRinTuiOverrides();

  let localRenames = 0;
  let rpcRenames = 0;
  let selector;
  const originalOpen = codingAgentModule.SessionManager.open;
  codingAgentModule.SessionManager.open = () => ({
    appendSessionInfo() {
      localRenames += 1;
    },
  });

  try {
    const baseInstance = {
      sessionManager: {
        getSessionFile: () => "/tmp/demo.jsonl",
        getCwd: () => "/tmp",
        getSessionDir: () => "/tmp/.sessions",
      },
      keybindings: {},
      ui: { requestRender() {} },
      showSelector(factory) {
        selector = factory(() => {}).component;
        return selector;
      },
      handleResumeSession: async () => {},
      shutdown: async () => {},
    };

    codingAgentModule.InteractiveMode.prototype.showSessionSelector.call(
      baseInstance,
    );
    await selector.renameSession("/tmp/demo.jsonl", "   ");

    codingAgentModule.InteractiveMode.prototype.showSessionSelector.call({
      ...baseInstance,
      session: {
        getFrontendStatusEvent() {
          return { type: "rpc_frontend_status", phase: "idle" };
        },
        async listSessions() {
          return [];
        },
        async renameSession() {
          rpcRenames += 1;
        },
      },
    });
    await selector.renameSession("/tmp/demo.jsonl", "\t");

    assert.equal(localRenames, 0);
    assert.equal(rpcRenames, 0);
  } finally {
    codingAgentModule.SessionManager.open = originalOpen;
  }
});

test("rpc session resync uses Pi's real history renderer contract", async () => {
  await overrides.applyRinTuiOverrides();

  let runtimeChanges = 0;
  let contextBuilds = 0;
  let renders = 0;
  let initialStateRenders = 0;
  const instance = createRealInteractiveModeResyncInstance({
    ui: {
      requestRender() {
        renders += 1;
      },
      terminal: { setProgress() {} },
    },
    sessionManager: {
      buildContextEntries() {
        contextBuilds += 1;
        return [];
      },
      getEntries() {
        return [];
      },
      getCwd() {
        return "/tmp";
      },
    },
    handleRuntimeSessionChange: async () => {
      runtimeChanges += 1;
    },
    renderCurrentSessionState() {
      initialStateRenders += 1;
    },
  });

  assert.equal(Object.hasOwn(instance, "renderSessionEntries"), false);
  assert.equal(
    instance.renderSessionEntries,
    codingAgentModule.InteractiveMode.prototype.renderSessionEntries,
  );

  await codingAgentModule.InteractiveMode.prototype.handleEvent.call(instance, {
    type: "rpc_session_resynced",
  });

  assert.equal(runtimeChanges, 1);
  assert.equal(initialStateRenders, 0);
  assert.equal(contextBuilds, 1);
  assert.equal(renders, 1);
});

test("rpc session resync redraw does not replay initial compaction status notice", async () => {
  await overrides.applyRinTuiOverrides();

  const statusMessages = [];
  const entries = [{ type: "compaction" }];
  const instance = createRealInteractiveModeResyncInstance({
    sessionManager: {
      buildContextEntries() {
        return [];
      },
      getEntries() {
        return entries;
      },
      getCwd() {
        return "/tmp";
      },
    },
    showStatus(message) {
      statusMessages.push(message);
    },
  });

  assert.equal(Object.hasOwn(instance, "renderSessionEntries"), false);
  await codingAgentModule.InteractiveMode.prototype.handleEvent.call(instance, {
    type: "rpc_session_resynced",
  });

  assert.deepEqual(statusMessages, []);

  codingAgentModule.InteractiveMode.prototype.renderInitialMessages.call(
    instance,
  );
  assert.deepEqual(statusMessages, ["Session compacted 1 time"]);
});

test("rpc startup submissions are buffered until the input loop starts", async () => {
  await overrides.applyRinTuiOverrides();

  const history = [];
  const instance = {
    session: {
      isStreaming: false,
      isCompacting: false,
      getFrontendStatusEvent() {
        return {
          type: "rpc_frontend_status",
          phase: "starting",
          label: "Starting",
          connected: true,
        };
      },
    },
    defaultEditor: {},
    pendingUserInputs: [],
    editor: {
      addToHistory(text) {
        history.push(text);
      },
    },
    isBashMode: false,
    isExtensionCommand: () => false,
    flushPendingBashComponents() {},
  };

  codingAgentModule.InteractiveMode.prototype.setupEditorSubmitHandler.call(
    instance,
  );

  await instance.defaultEditor.onSubmit(" first ");
  await instance.defaultEditor.onSubmit("second");

  assert.deepEqual(history, ["first", "second"]);
  assert.equal(
    await codingAgentModule.InteractiveMode.prototype.getUserInput.call(
      instance,
    ),
    "first",
  );
  assert.equal(
    await codingAgentModule.InteractiveMode.prototype.getUserInput.call(
      instance,
    ),
    "second",
  );
});

test("rpc startup submission uses an already waiting input callback", async () => {
  await overrides.applyRinTuiOverrides();

  const history = [];
  const instance = {
    session: {
      isStreaming: false,
      isCompacting: false,
      getFrontendStatusEvent() {
        return {
          type: "rpc_frontend_status",
          phase: "starting",
          label: "Starting",
          connected: true,
        };
      },
    },
    defaultEditor: {},
    pendingUserInputs: [],
    editor: {
      addToHistory(text) {
        history.push(text);
      },
    },
    isBashMode: false,
    isExtensionCommand: () => false,
    flushPendingBashComponents() {},
  };

  codingAgentModule.InteractiveMode.prototype.setupEditorSubmitHandler.call(
    instance,
  );

  const pending =
    codingAgentModule.InteractiveMode.prototype.getUserInput.call(instance);
  await instance.defaultEditor.onSubmit("ready");

  assert.equal(await pending, "ready");
  assert.deepEqual(history, ["ready"]);
});

test("rpc local user echo suppresses the matching daemon echo", async () => {
  await overrides.applyRinTuiOverrides();

  const messages = [];
  let renders = 0;
  const instance = {
    isInitialized: true,
    ui: {
      requestRender() {
        renders += 1;
      },
    },
    footer: { invalidate() {} },
    addMessageToChat(message) {
      messages.push(message);
    },
    updatePendingMessagesDisplay() {},
  };

  await codingAgentModule.InteractiveMode.prototype.handleEvent.call(instance, {
    type: "rpc_local_user_message",
    text: "hello",
  });
  await codingAgentModule.InteractiveMode.prototype.handleEvent.call(instance, {
    type: "message_start",
    message: {
      role: "user",
      content: [{ type: "text", text: "hello" }],
    },
  });
  await codingAgentModule.InteractiveMode.prototype.handleEvent.call(instance, {
    type: "message_start",
    message: {
      role: "user",
      content: [{ type: "text", text: "different" }],
    },
  });

  assert.deepEqual(
    messages.map((message) => message.content[0]?.text),
    ["hello", "different"],
  );
  assert.equal(renders, 2);
});

test("rpc session resync clears pending local user echo", async () => {
  await overrides.applyRinTuiOverrides();

  const messages = [];
  let renders = 0;
  const instance = createRealInteractiveModeResyncInstance({
    ui: {
      requestRender() {
        renders += 1;
      },
      terminal: { setProgress() {} },
    },
    addMessageToChat(message) {
      messages.push(message);
    },
    updatePendingMessagesDisplay() {},
  });

  assert.equal(Object.hasOwn(instance, "renderSessionEntries"), false);
  await codingAgentModule.InteractiveMode.prototype.handleEvent.call(instance, {
    type: "rpc_local_user_message",
    text: "hello",
  });
  await codingAgentModule.InteractiveMode.prototype.handleEvent.call(instance, {
    type: "rpc_session_resynced",
  });
  await codingAgentModule.InteractiveMode.prototype.handleEvent.call(instance, {
    type: "message_start",
    message: {
      role: "user",
      content: [{ type: "text", text: "hello" }],
    },
  });

  assert.deepEqual(
    messages.map((message) => message.content[0]?.text),
    ["hello", "hello"],
  );
  assert.ok(renders >= 3);
});

test("rpc compaction start keeps the dedicated compaction status indicator", async () => {
  await overrides.applyRinTuiOverrides();
  themeModule.initTheme("dark", false);

  let renders = 0;
  const ui = {
    requestRender() {
      renders += 1;
    },
    terminal: { setProgress() {} },
  };
  const instance = {
    isInitialized: true,
    ui,
    settingsManager: settingsManagerWithoutTerminalProgress,
    session: {
      isCompacting: true,
      abortCompaction() {},
      getFrontendStatusEvent() {
        return {
          type: "rpc_frontend_status",
          phase: "compacting",
          label: "Compacting context",
          connected: true,
        };
      },
    },
    statusContainer: {
      child: undefined,
      clear() {
        this.child = undefined;
      },
      addChild(child) {
        this.child = child;
      },
    },
    chatContainer: {
      clear() {},
      addChild() {},
      removeChild() {},
    },
    defaultEditor: { onEscape() {} },
    footer: { invalidate() {} },
    flushCompactionQueue() {},
    showError() {},
    showStatus() {},
    showStatusIndicator: showStatusIndicatorForTest,
    clearStatusIndicator: clearStatusIndicatorForTest,
    activeStatusIndicator: undefined,
  };

  try {
    await codingAgentModule.InteractiveMode.prototype.handleEvent.call(
      instance,
      { type: "compaction_start", reason: "threshold" },
    );

    const compactionIndicator = instance.activeStatusIndicator;
    assert.ok(compactionIndicator);
    assert.equal(compactionIndicator.kind, "compaction");
    assert.equal(instance.statusContainer.child, compactionIndicator);

    await codingAgentModule.InteractiveMode.prototype.handleEvent.call(
      instance,
      {
        type: "rpc_frontend_status",
        phase: "compacting",
        label: "Compacting context",
        connected: true,
      },
    );

    assert.equal(instance.statusContainer.child, compactionIndicator);

    await codingAgentModule.InteractiveMode.prototype.handleEvent.call(
      instance,
      { type: "status", level: "warning", text: "Still compacting..." },
    );

    assert.equal(instance.statusContainer.child, compactionIndicator);
    assert.ok(renders >= 1);
  } finally {
    instance.activeStatusIndicator?.dispose?.();
  }
});

test("async TUI transport failures defer to Connecting without showing an error", async () => {
  await overrides.applyRinTuiOverrides();

  let listener;
  const shownErrors = [];
  let stops = 0;
  const instance = {
    session: {
      subscribe(callback) {
        listener = callback;
        return () => {};
      },
      getFrontendStatusEvent() {
        return { phase: "connecting" };
      },
    },
    async handleEvent() {
      throw new Error("rin_disconnected:get_state:req_28");
    },
    showError(message) {
      shownErrors.push(message);
    },
    stop() {
      stops += 1;
    },
  };

  codingAgentModule.InteractiveMode.prototype.subscribeToAgent.call(instance);
  const listenerResult = listener({ type: "rpc_session_resynced" });
  await Promise.resolve(listenerResult).catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(shownErrors, []);
  assert.equal(stops, 0);
});

test("zero-extension compaction end rebuilds history containing Rin core custom entries", async () => {
  await overrides.applyRinTuiOverrides();
  const {
    instance,
    renderedItems,
    addedMessages,
    getChatClears,
    getFooterInvalidations,
  } = createZeroExtensionCustomEntryRenderInstance();

  await codingAgentModule.InteractiveMode.prototype.handleEvent.call(instance, {
    type: "compaction_end",
    reason: "threshold",
    aborted: false,
    result: { summary: "compacted", tokensBefore: 326_000 },
    willRetry: false,
  });

  assert.equal(instance.session.extensionOptions.noExtensions, true);
  assert.deepEqual(
    renderedItems.map((message) => message.role),
    ["user"],
  );
  assert.equal(addedMessages.at(-1)?.role, "compactionSummary");
  assert.ok(getChatClears() >= 2);
  assert.ok(getFooterInvalidations() >= 1);
});

test("rpc compaction end waits for the next agent_start before Working", async () => {
  await overrides.applyRinTuiOverrides();
  themeModule.initTheme("dark", false);

  let renders = 0;
  const ui = {
    requestRender() {
      renders += 1;
    },
    terminal: { setProgress() {} },
  };
  const instance = {
    isInitialized: true,
    ui,
    settingsManager: settingsManagerWithoutTerminalProgress,
    session: {
      isStreaming: true,
      isCompacting: false,
      abortCompaction() {},
      getFrontendStatusEvent() {
        return {
          type: "rpc_frontend_status",
          phase: this.isCompacting ? "compacting" : "working",
          label: this.isCompacting ? "Compacting context" : "Working",
          connected: true,
        };
      },
    },
    workingVisible: true,
    workingMessage: undefined,
    defaultWorkingMessage: "Working...",
    workingIndicatorOptions: undefined,
    statusContainer: {
      child: undefined,
      clear() {
        this.child = undefined;
      },
      addChild(child) {
        this.child = child;
      },
    },
    chatContainer: {
      clear() {},
      addChild() {},
      removeChild() {},
    },
    pendingTools: new Map(),
    defaultEditor: { onEscape() {} },
    footer: { invalidate() {} },
    flushCompactionQueue() {},
    showError() {},
    showStatus() {},
    showStatusIndicator: showStatusIndicatorForTest,
    clearStatusIndicator: clearStatusIndicatorForTest,
    setWorkingVisible: (codingAgentModule.InteractiveMode.prototype as any)
      .setWorkingVisible,
    activeStatusIndicator: undefined,
  };

  try {
    await codingAgentModule.InteractiveMode.prototype.handleEvent.call(
      instance,
      { type: "agent_start" },
    );
    assert.equal(instance.activeStatusIndicator?.kind, "working");

    instance.session.isCompacting = true;
    await codingAgentModule.InteractiveMode.prototype.handleEvent.call(
      instance,
      { type: "compaction_start", reason: "threshold" },
    );
    assert.equal(instance.activeStatusIndicator?.kind, "compaction");

    instance.session.isCompacting = false;
    await codingAgentModule.InteractiveMode.prototype.handleEvent.call(
      instance,
      { type: "compaction_end", aborted: false, willRetry: false },
    );

    assert.equal(instance.activeStatusIndicator, undefined);
    assert.equal(instance.statusContainer.child, undefined);
    assert.ok(renders >= 1);
  } finally {
    instance.activeStatusIndicator?.dispose?.();
  }
});

test("local compaction end renders Pi Working from the streaming session", async () => {
  await overrides.applyRinTuiOverrides();
  themeModule.initTheme("dark", false);

  let renders = 0;
  const ui = {
    requestRender() {
      renders += 1;
    },
    terminal: { setProgress() {} },
  };
  const instance = {
    isInitialized: true,
    ui,
    settingsManager: settingsManagerWithoutTerminalProgress,
    session: {
      isStreaming: true,
      abortCompaction() {},
    },
    workingVisible: true,
    workingMessage: undefined,
    defaultWorkingMessage: "Working...",
    workingIndicatorOptions: undefined,
    statusContainer: {
      child: undefined,
      clear() {
        this.child = undefined;
      },
      addChild(child) {
        this.child = child;
      },
    },
    chatContainer: {
      clear() {},
      addChild() {},
      removeChild() {},
    },
    pendingTools: new Map(),
    defaultEditor: { onEscape() {} },
    footer: { invalidate() {} },
    flushCompactionQueue() {},
    showError() {},
    showStatus() {},
    showStatusIndicator: showStatusIndicatorForTest,
    clearStatusIndicator: clearStatusIndicatorForTest,
    setWorkingVisible: (codingAgentModule.InteractiveMode.prototype as any)
      .setWorkingVisible,
    activeStatusIndicator: undefined,
  };

  try {
    await codingAgentModule.InteractiveMode.prototype.handleEvent.call(
      instance,
      { type: "agent_start" },
    );
    assert.equal(instance.activeStatusIndicator?.kind, "working");

    await codingAgentModule.InteractiveMode.prototype.handleEvent.call(
      instance,
      { type: "compaction_start", reason: "threshold" },
    );
    assert.equal(instance.activeStatusIndicator?.kind, "compaction");

    await codingAgentModule.InteractiveMode.prototype.handleEvent.call(
      instance,
      { type: "compaction_end", aborted: false, willRetry: false },
    );

    assert.equal(instance.activeStatusIndicator?.kind, "working");
    assert.equal(
      instance.statusContainer.child,
      instance.activeStatusIndicator,
    );
    assert.equal(instance.activeStatusIndicator?.message, "Working...");
    assert.ok(renders >= 1);
  } finally {
    instance.activeStatusIndicator?.dispose?.();
  }
});

test("rpc agent end does not leave a stale working status indicator after the turn is done", async () => {
  await overrides.applyRinTuiOverrides();

  const ui = {
    requestRender() {},
    terminal: { setProgress() {} },
  };
  let disposed = false;
  const existingIndicator = {
    kind: "working",
    dispose() {
      disposed = true;
    },
  };
  const instance = {
    isInitialized: true,
    ui,
    settingsManager: settingsManagerWithoutTerminalProgress,
    session: {
      getFrontendStatusEvent() {
        return null;
      },
    },
    statusContainer: {
      clear() {},
      addChild() {},
    },
    chatContainer: { removeChild() {} },
    footer: { invalidate() {} },
    pendingTools: new Map(),
    checkShutdownRequested: async () => {},
    showStatusIndicator: showStatusIndicatorForTest,
    clearStatusIndicator: clearStatusIndicatorForTest,
    activeStatusIndicator: existingIndicator,
  };

  await codingAgentModule.InteractiveMode.prototype.handleEvent.call(instance, {
    type: "agent_end",
  });

  assert.equal(instance.activeStatusIndicator, undefined);
  assert.equal(disposed, true);
});

test("rpc thinking cycle shows success only after daemon acknowledgement", async () => {
  await overrides.applyRinTuiOverrides();

  let acknowledge;
  const statuses = [];
  const instance = {
    session: {
      getFrontendStatusEvent() {
        return null;
      },
      cycleThinkingLevel() {
        return new Promise((resolve) => {
          acknowledge = resolve;
        });
      },
    },
    footer: { invalidate() {} },
    updateEditorBorderColor() {},
    showStatus(message) {
      statuses.push(message);
    },
    showError() {},
  };

  const pending =
    codingAgentModule.InteractiveMode.prototype.cycleThinkingLevel.call(
      instance,
    );
  assert.deepEqual(statuses, []);

  acknowledge("high");
  await pending;

  assert.deepEqual(statuses, ["Thinking level: high"]);
});

test("rpc setting mutation failures are surfaced in the TUI", async () => {
  await overrides.applyRinTuiOverrides();

  const errors = [];
  const instance = {
    isInitialized: true,
    showError(message) {
      errors.push(message);
    },
  };

  await codingAgentModule.InteractiveMode.prototype.handleEvent.call(instance, {
    type: "rpc_settings_mutation_error",
    error: "disconnected: req_7",
  });

  assert.deepEqual(errors, ["Failed to save setting: disconnected: req_7"]);
});

test("signal handler override routes SIGINT through interactive Ctrl+C handling", async () => {
  await overrides.applyRinTuiOverrides();

  const originalOn = process.on;
  const originalOff = process.off;
  const handlers = new Map();

  process.on = function patchedOn(event, handler) {
    const next = handlers.get(event) || [];
    next.push(handler);
    handlers.set(event, next);
    return this;
  };
  process.off = function patchedOff(event, handler) {
    const next = (handlers.get(event) || []).filter((item) => item !== handler);
    if (next.length) handlers.set(event, next);
    else handlers.delete(event);
    return this;
  };

  try {
    let ctrlCCount = 0;
    const instance = {
      signalCleanupHandlers: [],
      ui: { stopped: false },
      handleCtrlC() {
        ctrlCCount += 1;
      },
      unregisterSignalHandlers() {
        return codingAgentModule.InteractiveMode.prototype.unregisterSignalHandlers.call(
          this,
        );
      },
    };

    codingAgentModule.InteractiveMode.prototype.registerSignalHandlers.call(
      instance,
    );

    const sigintHandlers = handlers.get("SIGINT") || [];
    assert.equal(sigintHandlers.length, 1);

    sigintHandlers[0]();
    sigintHandlers[0]();
    assert.equal(ctrlCCount, 2);

    codingAgentModule.InteractiveMode.prototype.unregisterSignalHandlers.call(
      instance,
    );
    assert.equal((handlers.get("SIGINT") || []).length, 0);
  } finally {
    process.on = originalOn;
    process.off = originalOff;
  }
});

test("signal handler override ignores SIGINT while the TUI is stopped", async () => {
  await overrides.applyRinTuiOverrides();

  const originalOn = process.on;
  const originalOff = process.off;
  const handlers = new Map();

  process.on = function patchedOn(event, handler) {
    const next = handlers.get(event) || [];
    next.push(handler);
    handlers.set(event, next);
    return this;
  };
  process.off = function patchedOff(event, handler) {
    const next = (handlers.get(event) || []).filter((item) => item !== handler);
    if (next.length) handlers.set(event, next);
    else handlers.delete(event);
    return this;
  };

  try {
    let ctrlCCount = 0;
    const instance = {
      signalCleanupHandlers: [],
      ui: { stopped: true },
      handleCtrlC() {
        ctrlCCount += 1;
      },
      unregisterSignalHandlers() {
        return codingAgentModule.InteractiveMode.prototype.unregisterSignalHandlers.call(
          this,
        );
      },
    };

    codingAgentModule.InteractiveMode.prototype.registerSignalHandlers.call(
      instance,
    );

    const sigintHandlers = handlers.get("SIGINT") || [];
    assert.equal(sigintHandlers.length, 1);
    sigintHandlers[0]();
    assert.equal(ctrlCCount, 0);
  } finally {
    process.on = originalOn;
    process.off = originalOff;
  }
});
