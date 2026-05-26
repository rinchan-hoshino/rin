import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const { RpcInteractiveSession } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-tui", "runtime.js"))
    .href
);
const { createModelRegistry } = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-frontend-sdk", "index.js"),
  ).href
);
test("rpc prompt routes extension slash commands using daemon catalog authority", async () => {
  const sent = [];
  const session = new RpcInteractiveSession({
    send(payload) {
      sent.push(payload);
      switch (payload.type) {
        case "get_commands":
          return Promise.resolve({
            success: true,
            data: {
              commands: [
                {
                  name: "local",
                  description: "local command",
                  source: "extension",
                },
              ],
            },
          });
        case "new_session":
          return Promise.resolve({
            success: true,
            data: { sessionFile: "/tmp/s.jsonl", sessionId: "s" },
          });
        case "run_command":
          return Promise.resolve({ success: true, data: { handled: true } });
        case "get_state":
          return Promise.resolve({
            success: true,
            data: { sessionFile: "/tmp/s.jsonl", sessionId: "s" },
          });
        case "get_session_snapshot":
          return Promise.resolve({ success: true, data: { entries: [] } });
        default:
          return Promise.resolve({ success: true, data: {} });
      }
    },
    subscribe() {
      return () => {};
    },
    isConnected() {
      return true;
    },
  });

  await session.prompt("/local hello world");

  assert.equal(
    sent.some((payload) => payload.type === "prompt"),
    false,
  );
  assert.deepEqual(
    sent.find((payload) => payload.type === "run_command"),
    {
      type: "run_command",
      commandLine: "/local hello world",
      sessionFile: "/tmp/s.jsonl",
    },
  );
});

test("rpc prompt routes frontend /new command to local new session", async () => {
  const sent = [];
  const session = new RpcInteractiveSession({
    send(payload) {
      sent.push(payload);
      switch (payload.type) {
        case "new_session":
          return Promise.resolve({
            success: true,
            data: { sessionFile: "/tmp/new.jsonl", sessionId: "new" },
          });
        case "get_state":
          return Promise.resolve({
            success: true,
            data: { sessionFile: "/tmp/new.jsonl", sessionId: "new" },
          });
        case "get_session_snapshot":
          return Promise.resolve({ success: true, data: { entries: [] } });
        default:
          return Promise.resolve({ success: true, data: {} });
      }
    },
    subscribe() {
      return () => {};
    },
    isConnected() {
      return true;
    },
  });

  await session.prompt("/new");

  assert.equal(
    sent.some((payload) => payload.type === "prompt"),
    false,
  );
  assert.equal(
    sent.some((payload) => payload.type === "run_command"),
    false,
  );
  assert.equal(
    sent.some((payload) => payload.type === "get_commands"),
    false,
  );
  assert.equal(
    sent.filter((payload) => payload.type === "new_session").length,
    1,
  );
});

test("rpc prompt routes daemon builtin slash commands without a side registry", async () => {
  const sent = [];
  const session = new RpcInteractiveSession({
    send(payload) {
      sent.push(payload);
      switch (payload.type) {
        case "get_commands":
          return Promise.resolve({
            success: true,
            data: {
              commands: [
                {
                  name: "todos",
                  description: "Show todos",
                  source: "builtin",
                },
              ],
            },
          });
        case "new_session":
          return Promise.resolve({
            success: true,
            data: { sessionFile: "/tmp/s.jsonl", sessionId: "s" },
          });
        case "run_command":
          return Promise.resolve({ success: true, data: { handled: true } });
        case "get_state":
          return Promise.resolve({
            success: true,
            data: { sessionFile: "/tmp/s.jsonl", sessionId: "s" },
          });
        case "get_session_snapshot":
          return Promise.resolve({ success: true, data: { entries: [] } });
        default:
          return Promise.resolve({ success: true, data: {} });
      }
    },
    subscribe() {
      return () => {};
    },
    isConnected() {
      return true;
    },
  });

  await session.prompt("/todos");

  assert.equal(
    sent.some((payload) => payload.type === "prompt"),
    false,
  );
  assert.deepEqual(
    sent.find((payload) => payload.type === "run_command"),
    {
      type: "run_command",
      commandLine: "/todos",
      sessionFile: "/tmp/s.jsonl",
    },
  );
});

test("rpc prompt does not route non-runnable slash catalog entries as commands", async () => {
  const sent = [];
  const session = new RpcInteractiveSession({
    send(payload) {
      sent.push(payload);
      switch (payload.type) {
        case "get_commands":
          return Promise.resolve({
            success: true,
            data: {
              commands: [
                { name: "polish", description: "polish", source: "prompt" },
              ],
            },
          });
        case "new_session":
          return Promise.resolve({
            success: true,
            data: { sessionFile: "/tmp/s.jsonl", sessionId: "s" },
          });
        case "prompt":
          return Promise.resolve({ success: true, data: {} });
        case "get_state":
          return Promise.resolve({
            success: true,
            data: { sessionFile: "/tmp/s.jsonl", sessionId: "s" },
          });
        case "get_session_snapshot":
          return Promise.resolve({ success: true, data: { entries: [] } });
        default:
          return Promise.resolve({ success: true, data: {} });
      }
    },
    subscribe() {
      return () => {};
    },
    isConnected() {
      return true;
    },
  });

  session.rpcConnected = true;

  await session.prompt("/polish");

  assert.equal(
    sent.some((payload) => payload.type === "run_command"),
    false,
  );
  assert.equal(
    sent.some((payload) => payload.type === "prompt"),
    true,
  );
});

test("rpc frontend exposes local Rin capability renderers for tool cards", () => {
  const session = new RpcInteractiveSession({
    send() {
      return Promise.resolve({ success: true, data: {} });
    },
    subscribe() {
      return () => {};
    },
    isConnected() {
      return true;
    },
  });
  const theme = {
    fg: (_kind, text) => String(text),
    bg: (kind, text) => `<${kind}>${String(text)}</${kind}>`,
    bold: (text) => String(text),
  };
  const renderContext = { state: {}, lastComponent: undefined };

  for (const name of ["web_search", "search_memory", "todo"]) {
    const tool = session.getToolDefinition(name);
    assert.ok(tool, `${name} should be available in the RPC frontend`);
    assert.equal(typeof tool.renderCall, "function");
    assert.equal(typeof tool.renderResult, "function");
  }

  const rendered = session
    .getToolDefinition("web_search")
    .renderCall(
      { q: "RAG retrieval augmented generation", limit: 5 },
      theme,
      renderContext,
    )
    .render(80)
    .join("\n");
  assert.match(rendered, /RAG retrieval augmented generation/);

  const longToolResultLines = session
    .getToolDefinition("search_memory")
    .renderResult(
      {
        content: [
          {
            type: "text",
            text: "L39 assistant: " + "A".repeat(140),
          },
        ],
      },
      { expanded: false },
      theme,
      renderContext,
    )
    .render(40);
  assert.ok(longToolResultLines.length > 1);
  assert.ok(
    longToolResultLines.every((line) => line.length <= 40),
    `expected wrapped tool result lines, got ${JSON.stringify(longToolResultLines)}`,
  );

  const todoTool = session.getToolDefinition("todo");
  assert.equal(todoTool.renderShell, "self");

  const todoCall = todoTool
    .renderCall({ action: "add", text: "Wire core todo" }, theme, renderContext)
    .render(80)
    .join("\n");
  assert.equal(todoCall, "");
  assert.doesNotMatch(todoCall, /Checklist|add|Wire core todo/);

  const todoResultLines = todoTool
    .renderResult(
      {
        content: [{ type: "text", text: "" }],
        details: {
          action: "toggle",
          todos: [
            { id: 1, text: "Wire core todo", done: false },
            { id: 2, text: "Ship renderer", done: true },
          ],
          nextId: 3,
        },
      },
      { expanded: false },
      theme,
      renderContext,
    )
    .render(80);
  assert.match(todoResultLines[0], /^<toolSuccessBg>\s*<\/toolSuccessBg>$/);
  assert.match(
    todoResultLines.at(-1) ?? "",
    /^<toolSuccessBg>\s*<\/toolSuccessBg>$/,
  );
  assert.ok(
    todoResultLines.every(
      (line) =>
        line.startsWith("<toolSuccessBg>") && line.endsWith("</toolSuccessBg>"),
    ),
    `expected every todo line to be painted, got ${JSON.stringify(todoResultLines)}`,
  );
  assert.doesNotMatch(todoResultLines[0], /Wire core todo|Ship renderer/);
  assert.doesNotMatch(
    todoResultLines.at(-1) ?? "",
    /Wire core todo|Ship renderer/,
  );

  const todoResult = todoResultLines.join("\n");
  assert.match(todoResult, /<toolSuccessBg>/);
  assert.match(todoResult, /○ Wire core todo/);
  assert.match(todoResult, /✓ Ship renderer/);
  assert.doesNotMatch(todoResult, /#1|#2|Checklist add|Added todo|completed/);
});

test("rpc extension command facade is backed by the daemon catalog", async () => {
  const sent = [];
  const session = new RpcInteractiveSession({
    send(payload) {
      sent.push(payload);
      if (payload.type === "get_commands") {
        return Promise.resolve({
          success: true,
          data: {
            commands: [
              {
                name: "deploy",
                description: "Deploy app",
                source: "extension",
              },
              { name: "reload", description: "Reload", source: "builtin" },
            ],
          },
        });
      }
      if (payload.type === "get_resource_diagnostics") {
        return Promise.resolve({
          success: true,
          data: {
            extensions: {
              commandDiagnostics: [
                { type: "warning", message: "duplicate command" },
              ],
              shortcutDiagnostics: [
                { type: "warning", message: "duplicate shortcut" },
              ],
            },
          },
        });
      }
      return Promise.resolve({ success: true, data: {} });
    },
    subscribe() {
      return () => {};
    },
    isConnected() {
      return true;
    },
  });

  await session.bindExtensions({});

  const commands = session.extensionRunner.getRegisteredCommands();
  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, "deploy");
  assert.equal(commands[0].description, "Deploy app");
  assert.equal(typeof commands[0].getArgumentCompletions, "function");
  assert.deepEqual(session.extensionRunner.getCommandDiagnostics(), [
    { type: "warning", message: "duplicate command" },
  ]);
  assert.deepEqual(session.extensionRunner.getShortcutDiagnostics(), [
    { type: "warning", message: "duplicate shortcut" },
  ]);
  assert.deepEqual(Array.from(session.extensionRunner.getShortcuts()), []);
  assert.equal(await session.extensionRunner.emitUserBash({}), null);
  assert.equal(session.extensionRunner.getCommand("reload"), undefined);
  assert.equal(
    sent.some((payload) => payload.type === "get_commands"),
    true,
  );
});

test("rpc reload delegates to the daemon session and refreshes catalog", async () => {
  const sent = [];
  let reloaded = false;
  const session = new RpcInteractiveSession({
    send(payload) {
      sent.push(payload);
      switch (payload.type) {
        case "reload":
          reloaded = true;
          return Promise.resolve({ success: true, data: {} });
        case "get_commands":
          return Promise.resolve({
            success: true,
            data: {
              commands: reloaded
                ? [{ name: "after", source: "extension" }]
                : [{ name: "before", source: "extension" }],
            },
          });
        case "get_resource_diagnostics":
          return Promise.resolve({ success: true, data: {} });
        case "get_state":
          return Promise.resolve({
            success: true,
            data: { sessionFile: "/tmp/s.jsonl", sessionId: "s" },
          });
        case "get_session_snapshot":
          return Promise.resolve({ success: true, data: { entries: [] } });
        default:
          return Promise.resolve({ success: true, data: {} });
      }
    },
    subscribe() {
      return () => {};
    },
    isConnected() {
      return true;
    },
  });

  await session.reload();

  assert.equal(
    sent.some((payload) => payload.type === "reload"),
    true,
  );
  assert.deepEqual(
    session.extensionRunner
      .getRegisteredCommands()
      .map((command) => command.name),
    ["after"],
  );
});

test("rpc model registry exposes all models for login provider selection", async () => {
  const sent = [];
  const allModels = [
    { provider: "openai", id: "gpt-5" },
    { provider: "anthropic", id: "claude-sonnet" },
  ];
  const availableModels = [{ provider: "openai", id: "gpt-5" }];
  const registry = createModelRegistry({
    send(payload) {
      sent.push(payload.type);
      switch (payload.type) {
        case "get_all_models":
          return Promise.resolve({
            success: true,
            data: { models: allModels },
          });
        case "get_available_models":
          return Promise.resolve({
            success: true,
            data: { models: availableModels },
          });
        case "get_oauth_state":
          return Promise.resolve({
            success: true,
            data: {
              providerDisplayNames: { anthropic: "Anthropic" },
              providerAuthStatuses: {
                openai: { configured: true, source: "environment" },
              },
            },
          });
        default:
          throw new Error(`unexpected command: ${payload.type}`);
      }
    },
  });

  await registry.sync();

  assert.deepEqual(registry.getAll(), allModels);
  assert.deepEqual(registry.getAvailable(), availableModels);
  assert.deepEqual(registry.find("anthropic", "claude-sonnet"), allModels[1]);
  registry.authStorage.applyState({
    credentials: { anthropic: { type: "api_key" } },
    providers: [],
    providerDisplayNames: { anthropic: "Anthropic" },
    providerAuthStatuses: {
      openai: { configured: true, source: "environment" },
    },
  });
  assert.deepEqual(registry.getAvailable(), [...availableModels, allModels[1]]);
  assert.equal(registry.getProviderDisplayName("anthropic"), "Anthropic");
  assert.deepEqual(registry.getProviderAuthStatus("openai"), {
    configured: true,
    source: "environment",
  });
  assert.deepEqual(sent, [
    "get_all_models",
    "get_available_models",
    "get_oauth_state",
  ]);
});

test("rpc runtime answers daemon extension UI requests through the bound UI context", async () => {
  const sent = [];
  const session = new RpcInteractiveSession({
    send(payload) {
      sent.push(payload);
      return Promise.resolve({ success: true });
    },
    subscribe() {
      return () => {};
    },
  });
  session.extensionBindings = {
    uiContext: {
      select: async () => "Allow",
      confirm: async () => true,
      input: async () => "typed value",
      editor: async () => "edited value",
      notify(message, level) {
        sent.push({ local: "notify", message, level });
      },
      setWorkingMessage(message) {
        sent.push({ local: "setWorkingMessage", message });
      },
      setWorkingVisible(visible) {
        sent.push({ local: "setWorkingVisible", visible });
      },
      setWorkingIndicator(options) {
        sent.push({ local: "setWorkingIndicator", options });
      },
      setHiddenThinkingLabel(label) {
        sent.push({ local: "setHiddenThinkingLabel", label });
      },
      setToolsExpanded(expanded) {
        sent.push({ local: "setToolsExpanded", expanded });
      },
    },
  };

  await session.handleExtensionUiRequest({
    type: "extension_ui_request",
    id: "select-1",
    method: "select",
    title: "Pick",
    options: ["Allow", "Block"],
  });
  await session.handleExtensionUiRequest({
    type: "extension_ui_request",
    id: "confirm-1",
    method: "confirm",
    title: "Confirm",
    message: "Proceed?",
  });
  await session.handleExtensionUiRequest({
    type: "extension_ui_request",
    id: "input-1",
    method: "input",
    title: "Input",
  });
  await session.handleExtensionUiRequest({
    type: "extension_ui_request",
    id: "editor-1",
    method: "editor",
    title: "Edit",
  });
  await session.handleExtensionUiRequest({
    type: "extension_ui_request",
    id: "notify-1",
    method: "notify",
    message: "hello",
    notifyType: "warning",
  });
  await session.handleExtensionUiRequest({
    type: "extension_ui_request",
    id: "working-message-1",
    method: "setWorkingMessage",
    message: "Thinking",
  });
  await session.handleExtensionUiRequest({
    type: "extension_ui_request",
    id: "working-visible-1",
    method: "setWorkingVisible",
    visible: false,
  });
  await session.handleExtensionUiRequest({
    type: "extension_ui_request",
    id: "working-indicator-1",
    method: "setWorkingIndicator",
    options: { frames: ["*"], intervalMs: 100 },
  });
  await session.handleExtensionUiRequest({
    type: "extension_ui_request",
    id: "thinking-label-1",
    method: "setHiddenThinkingLabel",
    label: "Planning",
  });
  await session.handleExtensionUiRequest({
    type: "extension_ui_request",
    id: "tools-expanded-1",
    method: "setToolsExpanded",
    expanded: true,
  });

  assert.deepEqual(sent, [
    { type: "extension_ui_response", id: "select-1", value: "Allow" },
    { type: "extension_ui_response", id: "confirm-1", confirmed: true },
    { type: "extension_ui_response", id: "input-1", value: "typed value" },
    { type: "extension_ui_response", id: "editor-1", value: "edited value" },
    { local: "notify", message: "hello", level: "warning" },
    { local: "setWorkingMessage", message: "Thinking" },
    { local: "setWorkingVisible", visible: false },
    {
      local: "setWorkingIndicator",
      options: { frames: ["*"], intervalMs: 100 },
    },
    { local: "setHiddenThinkingLabel", label: "Planning" },
    { local: "setToolsExpanded", expanded: true },
  ]);
});

test("rpc runtime keeps control methods bound to the session instance", async () => {
  const sent = [];
  const model = { provider: "test", id: "demo-model", name: "Demo Model" };
  const session = new RpcInteractiveSession({
    send(payload) {
      sent.push(payload);
      switch (payload.type) {
        case "set_model":
          return Promise.resolve({ success: true, data: {} });
        case "get_state":
          return Promise.resolve({
            success: true,
            data: {
              sessionId: "s1",
              sessionFile: "/tmp/s1.jsonl",
              model,
              thinkingLevel: "medium",
              steeringMode: "all",
              followUpMode: "one-at-a-time",
              autoCompactionEnabled: false,
            },
          });
        case "get_all_models":
        case "get_available_models":
          return Promise.resolve({ success: true, data: { models: [model] } });
        case "get_oauth_state":
          return Promise.resolve({ success: true, data: {} });
        default:
          return Promise.resolve({ success: true, data: {} });
      }
    },
    subscribe() {
      return () => {};
    },
    abort() {
      return Promise.resolve();
    },
    isConnected() {
      return true;
    },
    connect() {
      return Promise.resolve();
    },
    disconnect() {
      return Promise.resolve();
    },
  });

  session.sessionId = "s1";
  session.sessionFile = "/tmp/s1.jsonl";
  session.settingsManager = {
    steeringMode: "all",
    followUpMode: "one-at-a-time",
    setSteeringMode(mode) {
      this.steeringMode = mode;
    },
    getSteeringMode() {
      return this.steeringMode;
    },
    setFollowUpMode(mode) {
      this.followUpMode = mode;
    },
    getFollowUpMode() {
      return this.followUpMode;
    },
  };

  const {
    setModel,
    setSteeringMode,
    setFollowUpMode,
    setAutoCompactionEnabled,
  } = session;

  await setModel(model);
  setSteeringMode("one-at-a-time");
  setFollowUpMode("all");
  setAutoCompactionEnabled(true);

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(session.model, model);
  assert.deepEqual(session.state.model, model);
  assert.equal(session.steeringMode, "one-at-a-time");
  assert.equal(session.followUpMode, "all");
  assert.equal(session.settingsManager.getSteeringMode(), "one-at-a-time");
  assert.equal(session.settingsManager.getFollowUpMode(), "all");
  assert.deepEqual(
    sent.map((entry) => entry.type),
    [
      "set_model",
      "get_state",
      "get_all_models",
      "get_available_models",
      "get_oauth_state",
      "set_steering_mode",
      "set_follow_up_mode",
      "set_auto_compaction",
    ],
  );
});

test("rpc runtime loads worker resource diagnostics after remote session setup", async () => {
  const sent = [];
  let remoteCreated = false;
  const skillPath = "/tmp/rin-test/self_improve/skills/broken/SKILL.md";
  const session = new RpcInteractiveSession(
    {
      send(payload) {
        sent.push(payload);
        switch (payload.type) {
          case "new_session":
            remoteCreated = true;
            return Promise.resolve({
              success: true,
              data: { sessionId: "s1", sessionFile: "/tmp/s1.jsonl" },
            });
          case "get_resource_diagnostics":
            return Promise.resolve({
              success: true,
              data: {
                skills: {
                  skills: [],
                  diagnostics: [
                    {
                      type: "warning",
                      message: "Nested mappings are not allowed",
                      path: skillPath,
                    },
                  ],
                },
                prompts: { prompts: [], diagnostics: [] },
                themes: { themes: [], diagnostics: [] },
                extensions: { extensions: [], errors: [] },
              },
            });
          case "get_state":
            return Promise.resolve({
              success: true,
              data: {
                sessionId: remoteCreated ? "s1" : "",
                sessionFile: remoteCreated ? "/tmp/s1.jsonl" : undefined,
                thinkingLevel: "medium",
                steeringMode: "all",
                followUpMode: "one-at-a-time",
                autoCompactionEnabled: false,
              },
            });
          case "get_session_snapshot":
            return Promise.resolve({
              success: true,
              data: { entries: [], tree: [], leafId: null },
            });
          case "get_all_models":
            return Promise.resolve({ success: true, data: { models: [] } });
          case "get_available_models":
            return Promise.resolve({ success: true, data: { models: [] } });
          case "get_oauth_state":
            return Promise.resolve({ success: true, data: {} });
          default:
            return Promise.resolve({ success: true, data: {} });
        }
      },
      subscribe() {
        return () => {};
      },
      abort() {
        return Promise.resolve();
      },
      isConnected() {
        return true;
      },
      connect() {
        return Promise.resolve();
      },
      disconnect() {
        return Promise.resolve();
      },
    },
    {
      additionalSkillPaths: ["/tmp/extra-skill"],
      noSkills: true,
      additionalPromptTemplatePaths: ["/tmp/extra-prompt"],
      noPromptTemplates: true,
      additionalThemePaths: ["/tmp/extra-theme"],
      noThemes: true,
      additionalExtensionPaths: ["/tmp/extra-extension"],
      noExtensions: true,
      noContextFiles: true,
      systemPrompt: "system prompt",
      appendSystemPrompt: ["append prompt"],
      extensionFlagValues: new Map([["flag", true]]),
    },
  );

  await session.connect();
  await session.ensureSessionReady();

  assert.deepEqual(session.resourceLoader.getSkills().diagnostics, [
    {
      type: "warning",
      message: "Nested mappings are not allowed",
      path: skillPath,
    },
  ]);
  const sentTypes = sent.map((entry) => entry.type);
  assert.ok(sentTypes.includes("new_session"));
  assert.deepEqual(
    sent.find((entry) => entry.type === "new_session")?.frontendIdentity,
    { kind: "tui" },
  );
  assert.deepEqual(
    sent.find((entry) => entry.type === "new_session")?.resourceOptions,
    {
      additionalExtensionPaths: ["/tmp/extra-extension"],
      noExtensions: true,
      extensionFlagValues: [["flag", true]],
      additionalSkillPaths: ["/tmp/extra-skill"],
      noSkills: true,
      additionalPromptTemplatePaths: ["/tmp/extra-prompt"],
      noPromptTemplates: true,
      additionalThemePaths: ["/tmp/extra-theme"],
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "system prompt",
      appendSystemPrompt: ["append prompt"],
    },
  );
  assert.equal(sentTypes.at(-1), "get_resource_diagnostics");
});

test("rpc runtime routes daemon builtin slash commands from prompt to daemon", async () => {
  const sent = [];
  const session = new RpcInteractiveSession({
    send(payload) {
      sent.push(payload);
      if (payload.type === "get_commands") {
        return Promise.resolve({
          success: true,
          data: { commands: [{ name: "chat", source: "builtin" }] },
        });
      }
      if (payload.type === "run_command") {
        return Promise.resolve({ success: true, data: { handled: true } });
      }
      if (payload.type === "get_state") {
        return Promise.resolve({
          success: true,
          data: { sessionFile: "/tmp/rpc-session.jsonl" },
        });
      }
      if (payload.type === "get_session_snapshot") {
        return Promise.resolve({ success: true, data: { entries: [] } });
      }
      return Promise.resolve({ success: true, data: {} });
    },
    subscribe() {
      return () => {};
    },
    abort() {
      return Promise.resolve();
    },
    isConnected() {
      return true;
    },
    connect() {
      return Promise.resolve();
    },
    disconnect() {
      return Promise.resolve();
    },
  });
  session.sessionFile = "/tmp/rpc-session.jsonl";

  await session.prompt("/chat telegram", { streamingBehavior: "steer" });

  assert.equal(
    sent.some((payload) => payload.type === "prompt"),
    false,
  );
  assert.deepEqual(
    sent.find((payload) => payload.type === "run_command"),
    {
      type: "run_command",
      commandLine: "/chat telegram",
      sessionFile: "/tmp/rpc-session.jsonl",
    },
  );
  assert.deepEqual(session.getSteeringMessages(), []);
  assert.equal(session.pendingMessageCount, 0);
});

test("rpc runtime forwards prompt streamingBehavior through prompt mode", async () => {
  const sent = [];
  const session = new RpcInteractiveSession({
    send(payload) {
      sent.push(payload);
      return Promise.resolve({ success: true, data: {} });
    },
    subscribe() {
      return () => {};
    },
    abort() {
      return Promise.resolve();
    },
    isConnected() {
      return true;
    },
    connect() {
      return Promise.resolve();
    },
    disconnect() {
      return Promise.resolve();
    },
  });

  session.sessionId = "s1";
  session.sessionFile = "/tmp/rpc-session.jsonl";
  session.rpcConnected = true;
  session.startupPending = false;
  await session.prompt("hello", { streamingBehavior: "steer" });

  assert.equal(sent.length, 1);
  assert.deepEqual(
    {
      ...sent[0],
      requestTag:
        typeof sent[0]?.requestTag === "string"
          ? "<auto>"
          : sent[0]?.requestTag,
    },
    {
      type: "prompt",
      message: "hello",
      images: undefined,
      streamingBehavior: "steer",
      source: undefined,
      requestTag: "<auto>",
      sessionFile: "/tmp/rpc-session.jsonl",
    },
  );
  assert.deepEqual(session.getSteeringMessages(), []);
  assert.equal(session.pendingMessageCount, 0);
});

test("rpc runtime routes session-scoped commands by current session file", async () => {
  const sent = [];
  const session = new RpcInteractiveSession({
    send(payload) {
      sent.push(payload);
      return Promise.resolve({ success: true, data: { tools: [] } });
    },
    subscribe() {
      return () => {};
    },
    abort() {
      return Promise.resolve();
    },
    isConnected() {
      return true;
    },
    connect() {
      return Promise.resolve();
    },
    disconnect() {
      return Promise.resolve();
    },
  });

  session.sessionId = "s1";
  session.sessionFile = "/tmp/rpc-session.jsonl";
  session.rpcConnected = true;
  session.startupPending = false;

  await session.getActiveTools();

  assert.deepEqual(sent, [
    { type: "get_active_tools", sessionFile: "/tmp/rpc-session.jsonl" },
  ]);
});

test("rpc runtime switches sessions through the daemon worker", async () => {
  const sent = [];
  const session = new RpcInteractiveSession({
    send(payload) {
      sent.push(payload);
      if (payload.type === "get_state") {
        return Promise.resolve({
          success: true,
          data: {
            sessionId: "s2",
            sessionFile: "/tmp/s2.jsonl",
            thinkingLevel: "medium",
            steeringMode: "all",
            followUpMode: "one-at-a-time",
            autoCompactionEnabled: false,
            isStreaming: false,
            isCompacting: false,
            pendingMessageCount: 0,
          },
        });
      }
      if (payload.type === "get_session_snapshot") {
        return Promise.resolve({
          success: true,
          data: { entries: [], tree: [], leafId: null },
        });
      }
      if (payload.type === "get_available_models") {
        return Promise.resolve({ success: true, data: { models: [] } });
      }
      return Promise.resolve({ success: true, data: { cancelled: false } });
    },
    subscribe() {
      return () => {};
    },
    abort() {
      return Promise.resolve();
    },
    isConnected() {
      return true;
    },
    connect() {
      return Promise.resolve();
    },
    disconnect() {
      return Promise.resolve();
    },
  });

  session.rpcConnected = true;
  session.startupPending = false;

  const completed = await session.switchSession("/tmp/s2.jsonl");

  assert.equal(completed, true);
  assert.equal(sent[0]?.type, "switch_session");
  assert.equal(sent[0]?.sessionPath, "/tmp/s2.jsonl");
  assert.ok(sent[0]?.resourceOptions);
});

test("rpc runtime restores active session history from one daemon snapshot", async () => {
  const sent = [];
  const session = new RpcInteractiveSession({
    send(payload) {
      sent.push(payload);
      if (payload.type === "get_state") {
        return Promise.resolve({
          success: true,
          data: {
            sessionId: "active-session",
            sessionFile: "/tmp/active.jsonl",
            thinkingLevel: "medium",
            steeringMode: "all",
            followUpMode: "one-at-a-time",
            autoCompactionEnabled: false,
            turnActive: true,
            isStreaming: true,
            isCompacting: false,
            pendingMessageCount: 0,
          },
        });
      }
      if (payload.type === "get_session_snapshot") {
        const userEntry = {
          id: "entry-1",
          parentId: null,
          timestamp: "2026-04-27T00:00:00.000Z",
          type: "message",
          message: { role: "user", content: "hello" },
        };
        const assistantEntry = {
          id: "entry-2",
          parentId: "entry-1",
          timestamp: "2026-04-27T00:00:01.000Z",
          type: "message",
          message: { role: "assistant", content: "world" },
        };
        return Promise.resolve({
          success: true,
          data: {
            entries: [userEntry, assistantEntry],
            tree: [
              {
                entry: userEntry,
                children: [{ entry: assistantEntry, children: [] }],
              },
            ],
            leafId: "entry-2",
          },
        });
      }
      return Promise.resolve({ success: true, data: { cancelled: false } });
    },
    subscribe() {
      return () => {};
    },
    abort() {
      return Promise.resolve();
    },
    isConnected() {
      return true;
    },
    connect() {
      return Promise.resolve();
    },
    disconnect() {
      return Promise.resolve();
    },
  });

  session.rpcConnected = true;
  session.startupPending = false;

  const completed = await session.switchSession("/tmp/active.jsonl");

  assert.equal(completed, true);
  assert.deepEqual(session.messages, [
    { role: "user", content: "hello" },
    { role: "assistant", content: "world" },
  ]);
  assert.deepEqual(session.sessionManager.buildSessionContext().messages, [
    { role: "user", content: "hello" },
    { role: "assistant", content: "world" },
  ]);
  const sentTypes = sent.map((payload) => payload.type);
  assert.equal(
    sentTypes.filter((type) => type === "get_session_snapshot").length,
    1,
  );
  assert.equal(sentTypes.includes("get_messages"), false);
});

test("rpc runtime normalizes daemon session listings into canonical session metadata", async () => {
  const session = new RpcInteractiveSession({
    send(payload) {
      if (payload.type === "list_sessions") {
        return Promise.resolve({
          success: true,
          data: {
            sessions: [
              {
                id: "session-1",
                title: "Legacy title",
                subtitle: "2026-04-18T00:00:00.000Z",
              },
            ],
          },
        });
      }
      return Promise.resolve({ success: true, data: {} });
    },
    subscribe() {
      return () => {};
    },
    abort() {
      return Promise.resolve();
    },
    isConnected() {
      return true;
    },
    connect() {
      return Promise.resolve();
    },
    disconnect() {
      return Promise.resolve();
    },
  });

  const sessions = await session.listSessions("all");

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
});

test("rpc runtime rebuilds session context from entries when messages are stale", () => {
  const session = new RpcInteractiveSession({
    send() {
      return Promise.resolve({ success: true, data: {} });
    },
    subscribe() {
      return () => {};
    },
    abort() {
      return Promise.resolve();
    },
    isConnected() {
      return true;
    },
    connect() {
      return Promise.resolve();
    },
    disconnect() {
      return Promise.resolve();
    },
  });

  session.messages = [];
  session.thinkingLevel = "medium";
  session.model = { provider: "demo", id: "demo-model" };
  session.entries = [
    {
      id: "m1",
      type: "message",
      message: { role: "user", content: "hello" },
    },
    {
      id: "m2",
      parentId: "m1",
      type: "message",
      message: { role: "assistant", content: "world" },
    },
  ];
  session.entryById = new Map(
    session.entries.map((entry) => [entry.id, entry]),
  );
  session.leafId = "m2";

  const context = session.sessionManager.buildSessionContext();

  assert.deepEqual(context.messages, [
    { role: "user", content: "hello" },
    { role: "assistant", content: "world" },
  ]);
});

test("rpc runtime promotes a temporary worker session before the first prompt", async () => {
  const sent = [];
  let promoted = false;
  const session = new RpcInteractiveSession({
    send(payload) {
      sent.push(payload);
      if (payload.type === "get_state") {
        return Promise.resolve({
          success: true,
          data: promoted
            ? { sessionFile: "/tmp/real.jsonl", sessionId: "real" }
            : { sessionId: "temporary" },
        });
      }
      if (payload.type === "new_session") {
        promoted = true;
        return Promise.resolve({
          success: true,
          data: { sessionFile: "/tmp/real.jsonl", sessionId: "real" },
        });
      }
      if (payload.type === "get_session_snapshot") {
        return Promise.resolve({ success: true, data: {} });
      }
      return Promise.resolve({ success: true, data: {} });
    },
    subscribe() {
      return () => {};
    },
    abort() {
      return Promise.resolve();
    },
    isConnected() {
      return true;
    },
    connect() {
      return Promise.resolve();
    },
    disconnect() {
      return Promise.resolve();
    },
  });

  await session.connect({ flushPendingSelfImproveNotices: false });
  assert.equal(session.sessionId, "temporary");
  assert.equal(session.sessionFile, undefined);

  await session.prompt("hello");

  assert.ok(sent.some((payload) => payload.type === "new_session"));
  assert.equal(
    sent.find((payload) => payload.type === "prompt")?.sessionFile,
    "/tmp/real.jsonl",
  );
});

test("rpc runtime lets native queue updates own steer prompt state", async () => {
  const sent = [];
  let releaseEnsureRemoteSession;
  const session = new RpcInteractiveSession({
    send(payload) {
      sent.push(payload);
      return Promise.resolve({ success: true, data: {} });
    },
    subscribe() {
      return () => {};
    },
    abort() {
      return Promise.resolve();
    },
    isConnected() {
      return true;
    },
    connect() {
      return Promise.resolve();
    },
    disconnect() {
      return Promise.resolve();
    },
  });

  session.rpcConnected = true;
  session.startupPending = false;
  session.ensureRemoteSession = () =>
    new Promise((resolve) => {
      releaseEnsureRemoteSession = resolve;
    });

  const seen = [];
  session.subscribe((event) => seen.push(event));
  seen.length = 0;

  const promptPromise = session.prompt("hello", {
    expandPromptTemplates: false,
    streamingBehavior: "steer",
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(session.getSteeringMessages(), []);
  assert.equal(session.pendingMessageCount, 0);
  assert.deepEqual(seen, []);
  assert.equal(sent.length, 0);

  releaseEnsureRemoteSession();
  await promptPromise;

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.type, "prompt");
  assert.equal(sent[0]?.streamingBehavior, "steer");
});

test("rpc runtime forwards raw self-improve notices from the daemon", async () => {
  let listener;
  const session = new RpcInteractiveSession({
    send(payload) {
      if (payload.type === "get_state") {
        return Promise.resolve({
          success: true,
          data: { sessionFile: "/tmp/s.jsonl", sessionId: "s" },
        });
      }
      if (payload.type === "get_session_snapshot") {
        return Promise.resolve({ success: true, data: {} });
      }
      return Promise.resolve({ success: true, data: {} });
    },
    subscribe(next) {
      listener = next;
      return () => {};
    },
    abort() {
      return Promise.resolve();
    },
    isConnected() {
      return true;
    },
    connect() {
      return Promise.resolve();
    },
    disconnect() {
      return Promise.resolve();
    },
  });

  const seen = [];
  session.subscribe((event) => seen.push(event));
  await session.connect({ flushPendingSelfImproveNotices: false });
  seen.length = 0;

  listener({
    type: "self_improve_review_notice",
    status: "completed",
    targets: ["memory-index"],
    changedCount: 1,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(seen, [
    {
      type: "self_improve_review_notice",
      status: "completed",
      targets: ["memory-index"],
      changedCount: 1,
    },
  ]);
});

test("rpc runtime defers prompt submission until compaction ends", async () => {
  const sent = [];
  const session = new RpcInteractiveSession({
    send(command) {
      sent.push(command);
      return Promise.resolve({ success: true, data: {} });
    },
    subscribe() {
      return () => {};
    },
    abort() {
      return Promise.resolve();
    },
    isConnected() {
      return true;
    },
    connect() {
      return Promise.resolve();
    },
    disconnect() {
      return Promise.resolve();
    },
  });

  session.sessionId = "s1";
  session.rpcConnected = true;
  session.startupPending = false;
  session.isCompacting = true;
  session.ensureRemoteSession = () => Promise.resolve();

  const promptPromise = session.prompt("hello", {
    expandPromptTemplates: false,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    sent.some((command) => command?.type === "prompt"),
    false,
  );

  session.handleRpcEvent({ type: "compaction_end" });
  await promptPromise;

  const promptCommands = sent.filter((command) => command?.type === "prompt");
  assert.equal(promptCommands.length, 1);
  assert.equal(promptCommands[0]?.message, "hello");
});

test("rpc runtime applies daemon queue updates before the user message starts", async () => {
  const session = new RpcInteractiveSession({
    send() {
      return Promise.resolve({ success: true, data: {} });
    },
    subscribe() {
      return () => {};
    },
    abort() {
      return Promise.resolve();
    },
    isConnected() {
      return true;
    },
    connect() {
      return Promise.resolve();
    },
    disconnect() {
      return Promise.resolve();
    },
  });

  session.sessionId = "s1";
  session.rpcConnected = true;
  session.startupPending = false;

  const seen = [];
  session.subscribe((event) => seen.push(event));
  seen.length = 0;

  await session.prompt("hello", {
    expandPromptTemplates: false,
    streamingBehavior: "steer",
  });
  assert.deepEqual(session.getSteeringMessages(), []);

  session.handleRpcEvent({
    type: "queue_update",
    steering: ["hello"],
    followUp: [],
  });
  assert.deepEqual(session.getSteeringMessages(), ["hello"]);
  seen.length = 0;

  session.handleRpcEvent({ type: "queue_update", steering: [], followUp: [] });
  session.handleRpcEvent({
    type: "message_start",
    message: {
      role: "user",
      content: [{ type: "text", text: "hello" }],
    },
  });

  assert.deepEqual(session.getSteeringMessages(), []);
  assert.equal(session.pendingMessageCount, 0);
  assert.deepEqual(seen, [
    { type: "queue_update", steering: [], followUp: [] },
    {
      type: "message_start",
      message: {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    },
  ]);
});

test("rpc runtime shows a connecting prompt only as steering queue", async () => {
  const session = new RpcInteractiveSession({
    send() {
      return Promise.resolve({ success: true, data: {} });
    },
    subscribe() {
      return () => {};
    },
    abort() {
      return Promise.resolve();
    },
    isConnected() {
      return false;
    },
    connect() {
      return new Promise(() => {});
    },
    disconnect() {
      return Promise.resolve();
    },
  });

  session.rpcConnected = false;
  session.startupPending = false;

  const seen = [];
  session.subscribe((event) => seen.push(event));
  seen.length = 0;

  await session.prompt("hello", {
    expandPromptTemplates: false,
  });

  assert.deepEqual(session.getSteeringMessages(), ["hello"]);
  assert.equal(
    seen.some((event) => event?.type === "rpc_local_user_message"),
    false,
  );
  assert.deepEqual(seen[0], {
    type: "queue_update",
    steering: ["hello"],
    followUp: [],
  });
  assert.deepEqual(
    seen.filter((event) => event?.type === "rpc_frontend_status").at(-1),
    {
      type: "rpc_frontend_status",
      phase: "connecting",
      label: "Connecting",
      connected: false,
    },
  );
});

test("rpc runtime marks a connected prompt as sending before remote session setup finishes", async () => {
  const sent = [];
  let releaseEnsureRemoteSession;
  const session = new RpcInteractiveSession({
    send(payload) {
      sent.push(payload);
      return Promise.resolve({ success: true, data: {} });
    },
    subscribe() {
      return () => {};
    },
    abort() {
      return Promise.resolve();
    },
    isConnected() {
      return true;
    },
    connect() {
      return Promise.resolve();
    },
    disconnect() {
      return Promise.resolve();
    },
  });

  session.rpcConnected = true;
  session.startupPending = false;
  session.ensureRemoteSession = () =>
    new Promise((resolve) => {
      releaseEnsureRemoteSession = resolve;
    });

  const seen = [];
  session.subscribe((event) => seen.push(event));
  seen.length = 0;

  const promptPromise = session.prompt("hello", {
    expandPromptTemplates: false,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(session.getFrontendStatusEvent(), {
    type: "rpc_frontend_status",
    phase: "sending",
    label: "Sending",
    connected: true,
  });
  assert.deepEqual(seen, [
    { type: "rpc_local_user_message", text: "hello" },
    {
      type: "rpc_frontend_status",
      phase: "sending",
      label: "Sending",
      connected: true,
    },
  ]);
  assert.equal(sent.length, 0);

  releaseEnsureRemoteSession();
  await promptPromise;

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.type, "prompt");
});
