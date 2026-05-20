import test from "node:test";
import assert from "node:assert/strict";
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
    path.join(rootDir, "dist", "core", "rin-tui", "upstream-overrides.js"),
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
const themeModule = await import(
  pathToFileURL(
    path.join(
      rootDir,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "modes",
      "interactive",
      "theme",
      "theme.js",
    ),
  ).href
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

test("todo tool coalescing hides earlier consecutive checklist results", () => {
  const todoComponent = (toolCallId: string, hidden = false) => ({
    toolName: "todo",
    toolCallId,
    hideComponent: hidden,
    invalidations: 0,
    invalidate() {
      this.invalidations += 1;
    },
  });
  const todoOnlyAssistant = {
    lastMessage: {
      role: "assistant",
      content: [{ type: "toolCall", name: "todo" }],
    },
  };
  const textAssistant = {
    lastMessage: {
      role: "assistant",
      content: [{ type: "text", text: "visible assistant text" }],
    },
  };

  const first = todoComponent("todo-1");
  const second = todoComponent("todo-2");
  const third = todoComponent("todo-3");
  const fourth = todoComponent("todo-4", true);

  const changed = overrides.coalesceTodoToolComponentsInContainer({
    children: [
      first,
      todoOnlyAssistant,
      second,
      textAssistant,
      third,
      todoOnlyAssistant,
      fourth,
      { toolName: "bash" },
    ],
  });

  assert.equal(changed, 3);
  assert.equal(first.hideComponent, true);
  assert.equal(second.hideComponent, false);
  assert.equal(third.hideComponent, true);
  assert.equal(fourth.hideComponent, false);
});

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

  assert.match(header.text, /Rin (?:v0\.0\.0|[0-9a-f]{7,40})/);
  assert.match(header.text, /Rin can explain her own features/);
  assert.match(header.text, /extend Rin/);
  assert.doesNotMatch(header.text, /\bpi v0\.74\.0\b/i);
  assert.doesNotMatch(header.text, /extend Pi/);
  assert.match(
    codingAgentModule.InteractiveMode.prototype.init.toString(),
    /applyRinStartupHeaderBranding/,
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
    /^rin (?:v0\.0\.0|[0-9a-f]{7,40})\nExpanded Rin help\.$/,
  );
  assert.match(
    String(codingAgentModule.InteractiveMode.prototype.init),
    /applyRinStartupHeaderBranding/,
  );
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

test("rpc frontend startup statuses use an animated loader until working starts", async () => {
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
    loadingAnimation: undefined,
    workingVisible: true,
    stopWorkingLoader() {
      this.loadingAnimation?.stop?.();
      this.loadingAnimation = undefined;
      this.statusContainer.clear();
    },
    createWorkingLoader() {
      return new loaderModule.Loader(
        this.ui,
        (value) => value,
        (value) => value,
        "Working...",
      );
    },
  };

  await codingAgentModule.InteractiveMode.prototype.handleEvent.call(instance, {
    type: "rpc_frontend_status",
    phase: "starting",
    label: "Starting",
    connected: true,
  });

  const startupStatus = instance.statusContainer.child;
  assert.ok(startupStatus);
  assert.equal(instance.loadingAnimation, undefined);
  assert.equal(startupStatus.constructor.name, "Loader");
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
    phase: "sending",
    label: "Sending",
    connected: true,
  });
  assert.equal(instance.statusContainer.child, startupStatus);
  assert.notEqual(startupStatus.intervalId, null);
  assert.equal(startupStatus.message, "Sending...");
  const sendingLines = startupStatus.render(40);
  assert.equal(sendingLines[0], "");
  assert.match(sendingLines[1], /Sending\.\.\./);
  assert.equal(additions, 1);

  await codingAgentModule.InteractiveMode.prototype.handleEvent.call(instance, {
    type: "rpc_frontend_status",
    phase: "working",
    label: "Working",
    connected: true,
  });

  assert.equal(instance.loadingAnimation, undefined);
  assert.equal(instance.statusContainer.child, undefined);
  assert.equal(startupStatus.intervalId, null);
  assert.ok(clears >= 1);
});

test("rpc working status only reattaches an existing Pi-owned loader", async () => {
  await overrides.applyRinTuiOverrides();

  let renders = 0;
  const ui = {
    requestRender() {
      renders += 1;
    },
    terminal: { setProgress() {} },
  };
  const existingLoader = new loaderModule.Loader(
    ui,
    (x) => x,
    (x) => x,
    "Working...",
  );
  const instance = {
    isInitialized: true,
    ui,
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
        this.child = undefined;
      },
      addChild(child) {
        this.child = child;
      },
    },
    footer: { invalidate() {} },
    loadingAnimation: existingLoader,
  };

  try {
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

    assert.equal(instance.loadingAnimation, existingLoader);
    assert.equal(instance.statusContainer.child, existingLoader);
    assert.ok(renders >= 1);
  } finally {
    existingLoader.stop();
  }
});

test("local session selector reuses bound session helpers for canonicalized list and rename", async () => {
  await overrides.applyRinTuiOverrides();

  const originalRinDir = process.env.RIN_DIR;
  process.env.RIN_DIR = "/tmp/.rin";
  const listed = [];
  const renamed = [];
  let selector;
  const originalList = codingAgentModule.SessionManager.list;
  const originalOpen = codingAgentModule.SessionManager.open;

  codingAgentModule.SessionManager.list = async (_cwd, dir) => {
    listed.push(dir);
    return [
      {
        id: "session-1",
        title: "Legacy title",
        subtitle: "2026-04-18T00:00:00.000Z",
      },
    ];
  };
  codingAgentModule.SessionManager.open = (sessionPath) => ({
    appendSessionInfo(name) {
      renamed.push([sessionPath, name]);
    },
  });

  try {
    const instance = {
      sessionManager: {
        getSessionFile: () => "/tmp/demo.jsonl",
        getCwd: () => "/tmp/project",
        getSessionDir: () => "/tmp/.rin/sessions/--home-rin--",
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
    await selector.renameSession("/tmp/demo.jsonl", "renamed");

    assert.deepEqual(listed, ["/tmp/.rin/sessions", "/tmp/.rin/sessions"]);
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
        path: "session-1",
        name: undefined,
        firstMessage: "Legacy title",
        modified: "2026-04-18T00:00:00.000Z",
        messageCount: 0,
        cwd: undefined,
        allMessagesText: "Legacy title",
      },
    );
    assert.deepEqual(renamed, [["/tmp/demo.jsonl", "renamed"]]);
  } finally {
    if (originalRinDir === undefined) {
      delete process.env.RIN_DIR;
    } else {
      process.env.RIN_DIR = originalRinDir;
    }
    codingAgentModule.SessionManager.list = originalList;
    codingAgentModule.SessionManager.open = originalOpen;
  }
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

test("rpc session resync rebinds runtime state and redraws history directly", async () => {
  await overrides.applyRinTuiOverrides();

  let runtimeChanges = 0;
  let renders = 0;
  let directHistoryRenders = 0;
  let initialStateRenders = 0;
  const ui = {
    requestRender() {
      renders += 1;
    },
  };
  const instance = {
    isInitialized: true,
    ui,
    session: {
      getFrontendStatusEvent() {
        return null;
      },
    },
    sessionManager: {
      buildSessionContext() {
        return { messages: [] };
      },
    },
    handleRuntimeSessionChange: async () => {
      runtimeChanges += 1;
    },
    renderCurrentSessionState() {
      initialStateRenders += 1;
    },
    renderSessionContext(_context, options) {
      directHistoryRenders += 1;
      assert.deepEqual(options, { updateFooter: true, populateHistory: true });
    },
    statusContainer: {
      clear() {},
      addChild() {},
    },
    chatContainer: { clear() {}, addChild() {}, removeChild() {} },
    pendingMessagesContainer: { clear() {} },
    pendingTools: new Map(),
    defaultEditor: { onEscape() {} },
    footer: { invalidate() {} },
    flushCompactionQueue() {},
    showError() {},
    showStatus() {},
    autoCompactionLoader: { stop() {} },
  };

  await codingAgentModule.InteractiveMode.prototype.handleEvent.call(instance, {
    type: "rpc_session_resynced",
  });

  assert.equal(runtimeChanges, 1);
  assert.equal(initialStateRenders, 0);
  assert.equal(directHistoryRenders, 1);
  assert.ok(renders >= 1);
});

test("rpc session resync redraw does not replay initial compaction status notice", async () => {
  await overrides.applyRinTuiOverrides();

  const statusMessages = [];
  let directHistoryRenders = 0;
  const instance = {
    isInitialized: true,
    ui: { requestRender() {} },
    session: {
      getFrontendStatusEvent() {
        return null;
      },
    },
    handleRuntimeSessionChange: async () => {},
    renderSessionContext() {
      directHistoryRenders += 1;
    },
    sessionManager: {
      buildSessionContext() {
        return { messages: [] };
      },
      getEntries() {
        return [{ type: "compaction" }];
      },
    },
    showStatus(message) {
      statusMessages.push(message);
    },
    chatContainer: { clear() {} },
    pendingMessagesContainer: { clear() {} },
    pendingTools: new Map(),
    statusContainer: { clear() {}, addChild() {} },
  };

  await codingAgentModule.InteractiveMode.prototype.handleEvent.call(instance, {
    type: "rpc_session_resynced",
  });

  assert.equal(directHistoryRenders, 1);
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
  const instance = {
    isInitialized: true,
    ui: {
      requestRender() {
        renders += 1;
      },
    },
    session: {
      getFrontendStatusEvent() {
        return null;
      },
    },
    footer: { invalidate() {} },
    addMessageToChat(message) {
      messages.push(message);
    },
    updatePendingMessagesDisplay() {},
    handleRuntimeSessionChange: async () => {},
    renderSessionContext() {},
    sessionManager: {
      buildSessionContext() {
        return { messages: [] };
      },
    },
    chatContainer: { clear() {} },
    pendingMessagesContainer: { clear() {} },
    pendingTools: new Map(),
  };

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

test("rpc compaction start keeps the dedicated compaction loader", async () => {
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
    loadingAnimation: undefined,
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
    autoCompactionLoader: undefined,
  };

  try {
    await codingAgentModule.InteractiveMode.prototype.handleEvent.call(
      instance,
      { type: "compaction_start", reason: "threshold" },
    );

    const compactionLoader = instance.autoCompactionLoader;
    assert.ok(compactionLoader);
    assert.equal(instance.loadingAnimation, undefined);
    assert.equal(instance.statusContainer.child, compactionLoader);
    assert.match(compactionLoader.message, /Auto-compacting/);
    assert.doesNotMatch(compactionLoader.message, /Working/);

    await codingAgentModule.InteractiveMode.prototype.handleEvent.call(
      instance,
      {
        type: "rpc_frontend_status",
        phase: "compacting",
        label: "Compacting context",
        connected: true,
      },
    );

    assert.equal(instance.loadingAnimation, undefined);
    assert.equal(instance.statusContainer.child, compactionLoader);
    assert.ok(renders >= 1);
  } finally {
    instance.autoCompactionLoader?.stop();
  }
});

test("rpc compaction end reattaches the existing Pi-owned loader", async () => {
  await overrides.applyRinTuiOverrides();

  let renders = 0;
  const ui = {
    requestRender() {
      renders += 1;
    },
    terminal: { setProgress() {} },
  };
  const existingLoader = new loaderModule.Loader(
    ui,
    (x) => x,
    (x) => x,
    "Working...",
  );
  const instance = {
    isInitialized: true,
    ui,
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
    loadingAnimation: existingLoader,
    statusContainer: {
      child: existingLoader,
      clear() {
        this.child = null;
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
    autoCompactionLoader: { stop() {} },
  };

  try {
    await codingAgentModule.InteractiveMode.prototype.handleEvent.call(
      instance,
      { type: "compaction_end", aborted: false, willRetry: false },
    );

    assert.equal(instance.loadingAnimation, existingLoader);
    assert.equal(instance.statusContainer.child, existingLoader);
    assert.equal(instance.loadingAnimation?.message, "Working...");
    assert.ok(renders >= 1);
  } finally {
    existingLoader.stop();
  }
});

test("local compaction end restores the working loader while the turn is still streaming", async () => {
  await overrides.applyRinTuiOverrides();

  let renders = 0;
  const ui = {
    requestRender() {
      renders += 1;
    },
    terminal: { setProgress() {} },
  };
  const existingLoader = new loaderModule.Loader(
    ui,
    (x) => x,
    (x) => x,
    "Working...",
  );
  const instance = {
    isInitialized: true,
    ui,
    settingsManager: settingsManagerWithoutTerminalProgress,
    session: {
      isStreaming: true,
    },
    loadingAnimation: existingLoader,
    defaultWorkingMessage: "Working...",
    statusContainer: {
      child: existingLoader,
      clear() {
        this.child = null;
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
    autoCompactionLoader: { stop() {} },
  };

  try {
    await codingAgentModule.InteractiveMode.prototype.handleEvent.call(
      instance,
      { type: "compaction_end", aborted: false, willRetry: false },
    );

    assert.equal(instance.loadingAnimation, existingLoader);
    assert.equal(instance.statusContainer.child, existingLoader);
    assert.equal(instance.loadingAnimation?.message, "Working...");
    assert.ok(renders >= 1);
  } finally {
    existingLoader.stop();
  }
});

test("rpc agent end does not leave a stale working loader after the turn is done", async () => {
  await overrides.applyRinTuiOverrides();

  const ui = {
    requestRender() {},
    terminal: { setProgress() {} },
  };
  const existingLoader = new loaderModule.Loader(
    ui,
    (x) => x,
    (x) => x,
    "Working...",
  );
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
    loadingAnimation: existingLoader,
  };

  try {
    await codingAgentModule.InteractiveMode.prototype.handleEvent.call(
      instance,
      { type: "agent_end" },
    );

    assert.equal(instance.loadingAnimation, undefined);
  } finally {
    existingLoader.stop();
  }
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
