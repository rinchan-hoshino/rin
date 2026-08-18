import "../support/require-test-sandbox.ts";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const { RpcInteractiveSession } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-tui", "runtime.js"))
    .href
);
const { createRpcModelBridge } = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-frontend-sdk", "index.js"),
  ).href
);
const createRpcModelRuntime = (client) =>
  createRpcModelBridge(client).modelRuntime;

test("rpc connection loss contains reconnect rejection after disposal", async () => {
  const session = new RpcInteractiveSession({
    send() {
      return Promise.resolve({ success: true, data: {} });
    },
    subscribe() {
      return () => {};
    },
    isConnected() {
      return false;
    },
  });
  let reconnectAttempts = 0;
  (session as any).ensureReconnectLoop = () => {
    reconnectAttempts += 1;
    return Promise.reject(new Error("rin_tui_disposed"));
  };

  session.handleSessionUnavailable({ transportClosed: true });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(reconnectAttempts, 1);
});

test("rpc reconnect replaces an ephemeral session lost with the daemon", async () => {
  const sent: any[] = [];
  const session = new RpcInteractiveSession({
    connect: async () => {},
    send(payload: any) {
      sent.push(payload);
      if (payload.type === "select_session") {
        return Promise.resolve({
          success: false,
          error: "rin_no_attached_session",
        });
      }
      if (payload.type === "new_session") {
        return Promise.resolve({
          success: true,
          data: { sessionId: "replacement-ephemeral" },
        });
      }
      if (payload.type === "get_state") {
        return Promise.resolve({
          success: true,
          data: { sessionId: "replacement-ephemeral" },
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
  (session as any).sessionId = "lost-ephemeral";
  (session as any).recoveryPending = true;

  await (session as any).handleConnectionRestored();

  assert.deepEqual(
    sent
      .filter((payload) =>
        ["select_session", "new_session"].includes(payload.type),
      )
      .map((payload) => payload.type),
    ["select_session", "new_session"],
  );
  assert.equal((session as any).sessionId, "replacement-ephemeral");
  assert.equal((session as any).recoveryPending, false);
});

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

test("rpc bash forwards Pi exclude-from-context option to daemon", async () => {
  const sent = [];
  const session = new RpcInteractiveSession({
    send(payload) {
      sent.push(payload);
      switch (payload.type) {
        case "bash":
          return Promise.resolve({ success: true, data: { exitCode: 0 } });
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

  await session.executeBash("echo hidden", undefined, {
    excludeFromContext: true,
  });

  assert.deepEqual(
    sent.find((payload) => payload.type === "bash"),
    {
      type: "bash",
      command: "echo hidden",
      excludeFromContext: true,
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

test("rpc prompt routes extension slash commands from command metadata", async () => {
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
                  name: "usage",
                  description: "Show Codex usage",
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

  await session.prompt("/usage");

  assert.equal(
    sent.some((payload) => payload.type === "prompt"),
    false,
  );
  assert.deepEqual(
    sent.find((payload) => payload.type === "run_command"),
    {
      type: "run_command",
      commandLine: "/usage",
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

test("rpc frontend exposes local Rin capability renderers for tool cards", async () => {
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

  assert.equal(session.getToolDefinition("browse"), undefined);

  for (const name of ["recall", "todo"]) {
    const tool = session.getToolDefinition(name);
    assert.ok(tool, `${name} should be available in the RPC frontend`);
    assert.equal(typeof tool.renderCall, "function");
    assert.equal(typeof tool.renderResult, "function");
    assert.equal(tool.execute, undefined);
    assert.equal(tool.parameters, undefined);
  }

  const longToolResultLines = session
    .getToolDefinition("recall")
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

  assert.equal(session.getToolDefinition("note"), undefined);

  const todoTool = session.getToolDefinition("todo");
  assert.equal(todoTool.renderShell, undefined);

  const todoCall = todoTool
    .renderCall(
      { action: "add", items: [{ text: "Wire core todo" }] },
      theme,
      renderContext,
    )
    .render(80)
    .join("\n");
  assert.match(todoCall, /todo add/);

  const todoResultLines = todoTool
    .renderResult(
      {
        content: [{ type: "text", text: "" }],
        details: {
          action: "read",
          items: [
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
  assert.equal(todoResultLines.length, 2);
  assert.match(todoResultLines[0], /○ Wire core todo/);
  assert.match(todoResultLines[1], /✓ Ship renderer/);

  const todoResult = todoResultLines.join("\n");
  assert.doesNotMatch(todoResult, /<toolSuccessBg>|#1|#2/);
  assert.doesNotMatch(todoResult, /Added todo|completed/);
});

test("rpc zero-extension frontend provides Pi's custom entry renderer lookup", () => {
  const session = new RpcInteractiveSession(
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

  assert.equal(session.extensionOptions.noExtensions, true);
  assert.ok(session.getToolDefinition("todo"));
  assert.equal(session.getToolDefinition("note"), undefined);
  assert.ok(session.getToolDefinition("recall"));
  assert.equal(typeof session.extensionRunner.getEntryRenderer, "function");
  assert.equal(
    session.extensionRunner.getEntryRenderer("rin-system-prompt-state"),
    undefined,
  );
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
  const bridge = createRpcModelBridge({
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
              modelProviders: [
                {
                  id: "openai",
                  name: "OpenAI",
                  auth: { oauth: { name: "OpenAI account" } },
                },
                {
                  id: "anthropic",
                  name: "Anthropic",
                  auth: {
                    apiKey: { name: "Anthropic API key", interactive: true },
                  },
                },
              ],
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
  const { modelRuntime, modelRegistry } = bridge;

  await modelRuntime.sync();

  assert.deepEqual(modelRegistry.getAll(), allModels);
  assert.deepEqual(modelRuntime.getModels(), allModels);
  assert.deepEqual(modelRuntime.getModels("anthropic"), [allModels[1]]);
  assert.deepEqual(modelRegistry.getAvailable(), availableModels);
  assert.deepEqual(modelRuntime.getAvailableSnapshot(), availableModels);
  assert.deepEqual(
    modelRegistry.find("anthropic", "claude-sonnet"),
    allModels[1],
  );
  assert.deepEqual(
    modelRuntime.getModel("anthropic", "claude-sonnet"),
    allModels[1],
  );
  assert.equal(
    modelRuntime.getProviders()[0].auth.oauth.name,
    "OpenAI account",
  );
  assert.equal(
    typeof modelRuntime.getProviders()[1].auth.apiKey.login,
    "function",
  );
  modelRuntime.authStorage.applyState({
    credentials: { anthropic: { type: "api_key" } },
    providers: [],
    providerDisplayNames: { anthropic: "Anthropic" },
    providerAuthStatuses: {
      openai: { configured: true, source: "environment" },
    },
  });
  assert.deepEqual(modelRegistry.getAvailable(), [
    ...availableModels,
    allModels[1],
  ]);
  assert.equal(modelRuntime.getProviderDisplayName("anthropic"), "Anthropic");
  assert.deepEqual(modelRuntime.getProviderAuthStatus("openai"), {
    configured: true,
    source: "environment",
  });
  assert.equal(await modelRuntime.getAuth("anthropic"), undefined);
  assert.deepEqual(await modelRuntime.listCredentials(), [
    { providerId: "anthropic", type: "api_key" },
  ]);
  assert.deepEqual(sent, [
    "get_all_models",
    "get_available_models",
    "get_oauth_state",
  ]);
});

test("rpc model runtime checks auth against current daemon state", async () => {
  const sent = [];
  const registry = createRpcModelRuntime({
    send(payload) {
      sent.push(payload.type);
      if (payload.type === "get_oauth_state") {
        return Promise.resolve({
          success: true,
          data: {
            credentials: { openai: { type: "oauth" } },
            providers: [{ id: "openai", name: "OpenAI" }],
          },
        });
      }
      return Promise.resolve({ success: true, data: { models: [] } });
    },
  });

  assert.deepEqual(await registry.checkAuth("openai"), { type: "oauth" });
  assert.deepEqual(sent, [
    "get_all_models",
    "get_available_models",
    "get_oauth_state",
  ]);

  const unavailable = createRpcModelRuntime({
    send() {
      return Promise.reject(new Error("daemon unavailable"));
    },
  });
  await assert.rejects(unavailable.checkAuth("openai"), /daemon unavailable/);
});

test("rpc model runtime reports daemon refresh failures", async () => {
  const registry = createRpcModelRuntime({
    send() {
      return Promise.reject(new Error("daemon unavailable"));
    },
  });

  const result = await registry.refresh();

  assert.equal(result.aborted, false);
  assert.equal(result.errors.get("rin-daemon")?.message, "daemon unavailable");
  assert.equal(registry.getError(), "daemon unavailable");
  assert.deepEqual(await registry.refresh({ signal: AbortSignal.abort() }), {
    aborted: true,
    errors: new Map(),
  });
});

test("rpc model runtime aborts a pending refresh without committing its snapshot", async () => {
  let resolveResponse;
  const response = new Promise((resolve) => {
    resolveResponse = resolve;
  });
  const registry = createRpcModelRuntime({
    send() {
      return response;
    },
  });
  const controller = new AbortController();

  const refresh = registry.refresh({ signal: controller.signal });
  controller.abort();

  assert.deepEqual(await refresh, {
    aborted: true,
    errors: new Map(),
  });
  resolveResponse({
    success: true,
    data: { models: [{ provider: "openai", id: "late-model" }] },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(registry.getModels(), []);
});

test("rpc interactive session exposes the Pi model runtime read contract", () => {
  const session = new RpcInteractiveSession({
    send() {
      return Promise.resolve({ success: true, data: {} });
    },
    subscribe() {
      return () => {};
    },
  });

  assert.notEqual(session.modelRuntime, session.modelRegistry);
  assert.equal(typeof session.modelRuntime.getAvailableSnapshot, "function");
  assert.equal(typeof session.modelRuntime.getModel, "function");
  assert.equal(typeof session.modelRuntime.refresh, "function");
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
  await session.handleExtensionUiRequest({
    type: "extension_ui_request",
    id: "catalog-1",
    method: "setMessageCatalog",
    catalog: {
      "session.new.completed": "Localized new",
      "session.new.cancelled": "Localized cancelled",
    },
  });
  assert.equal(
    session.applyBuiltinCommandText("new", {
      handled: true,
      command: "new",
      data: { cancelled: true },
    }).text,
    "Localized cancelled",
  );

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

test("rpc runtime contains extension UI error reporter failures", async () => {
  const session = new RpcInteractiveSession({
    send() {
      return Promise.resolve({ success: true });
    },
    subscribe() {
      return () => {};
    },
  });
  session.extensionBindings = {
    uiContext: {
      async select() {
        throw new Error("selector failed");
      },
    },
    async onError() {
      throw new Error("error reporter failed");
    },
  };

  const events = [];
  session.subscribe((event) => events.push(event));
  session.handleRpcEvent({
    type: "extension_ui_request",
    id: "select-failure",
    method: "select",
    title: "Pick",
    options: ["Allow", "Block"],
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    events.filter((event) => event.type === "status"),
    [
      {
        type: "status",
        level: "error",
        text: "Extension UI request failed: selector failed. Error reporter also failed: error reporter failed",
      },
    ],
  );
});

test("rpc runtime keeps control methods bound and leaves settings persistence to the daemon", async () => {
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
  await Promise.all([
    setSteeringMode("one-at-a-time"),
    setFollowUpMode("all"),
    setAutoCompactionEnabled(true),
  ]);

  assert.deepEqual(session.model, model);
  assert.deepEqual(session.state.model, model);
  assert.equal(session.steeringMode, "one-at-a-time");
  assert.equal(session.followUpMode, "all");
  assert.equal(session.settingsManager.getSteeringMode(), "all");
  assert.equal(session.settingsManager.getFollowUpMode(), "one-at-a-time");
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

test("rpc runtime routes extension slash commands from prompt to daemon", async () => {
  const sent = [];
  const session = new RpcInteractiveSession({
    send(payload) {
      sent.push(payload);
      if (payload.type === "get_commands") {
        return Promise.resolve({
          success: true,
          data: { commands: [{ name: "usage", source: "extension" }] },
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

  await session.prompt("/usage", { streamingBehavior: "steer" });

  assert.equal(
    sent.some((payload) => payload.type === "prompt"),
    false,
  );
  assert.deepEqual(
    sent.find((payload) => payload.type === "run_command"),
    {
      type: "run_command",
      commandLine: "/usage",
      sessionFile: "/tmp/rpc-session.jsonl",
    },
  );
  assert.deepEqual(session.getSteeringMessages(), []);
  assert.equal(session.pendingMessageCount, 0);
});

test("rpc runtime lets daemon admission decide ordinary steer prompt mode", async () => {
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
      streamingBehavior: undefined,
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

test("rpc runtime refreshes switched session state using the rebound session file", async () => {
  const sent = [];
  const session = new RpcInteractiveSession({
    send(payload) {
      sent.push(payload);
      if (payload.type === "switch_session") {
        return Promise.resolve({
          success: true,
          data: {
            cancelled: false,
            sessionFile: "/tmp/new.jsonl",
            sessionId: "new-session",
          },
        });
      }
      if (payload.type === "get_state") {
        return Promise.resolve({
          success: true,
          data: {
            sessionId: "new-session",
            sessionFile: "/tmp/new.jsonl",
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
          data: {
            entries: [
              {
                id: "entry-1",
                type: "message",
                message: { role: "user", content: "fresh history" },
              },
            ],
            tree: [],
            leafId: "entry-1",
          },
        });
      }
      if (payload.type === "get_available_models") {
        return Promise.resolve({ success: true, data: { models: [] } });
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

  session.sessionFile = "/tmp/old.jsonl";
  session.sessionId = "old-session";
  session.rpcConnected = true;
  session.startupPending = false;

  const completed = await session.switchSession("/tmp/new.jsonl");

  assert.equal(completed, true);
  const stateRequest = sent.find((payload) => payload.type === "get_state");
  const snapshotRequest = sent.find(
    (payload) => payload.type === "get_session_snapshot",
  );
  assert.equal(stateRequest?.sessionFile, "/tmp/new.jsonl");
  assert.equal(snapshotRequest?.sessionFile, "/tmp/new.jsonl");
  assert.equal(session.sessionFile, "/tmp/new.jsonl");
  assert.equal(session.sessionId, "new-session");
  assert.deepEqual(
    session.state.messages.map((message) => message.content),
    ["fresh history"],
  );
});

test("rpc runtime refreshes new session state using the created session file", async () => {
  const sent = [];
  const session = new RpcInteractiveSession({
    send(payload) {
      sent.push(payload);
      if (payload.type === "new_session") {
        return Promise.resolve({
          success: true,
          data: {
            cancelled: false,
            sessionFile: "/tmp/created.jsonl",
            sessionId: "created-session",
          },
        });
      }
      if (payload.type === "get_state") {
        return Promise.resolve({
          success: true,
          data: {
            sessionId: "created-session",
            sessionFile: "/tmp/created.jsonl",
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

  session.sessionFile = "/tmp/old.jsonl";
  session.sessionId = "old-session";
  session.rpcConnected = true;
  session.startupPending = false;

  const completed = await session.newSession();

  assert.equal(completed, true);
  const stateRequest = sent.find((payload) => payload.type === "get_state");
  const snapshotRequest = sent.find(
    (payload) => payload.type === "get_session_snapshot",
  );
  assert.equal(stateRequest?.sessionFile, "/tmp/created.jsonl");
  assert.equal(snapshotRequest?.sessionFile, "/tmp/created.jsonl");
  assert.equal(session.sessionFile, "/tmp/created.jsonl");
  assert.equal(session.sessionId, "created-session");
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

test("rpc runtime rebuilds Pi session context and active entries from snapshot state", () => {
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
    {
      id: "m3",
      parentId: "m1",
      type: "message",
      message: { role: "assistant", content: "inactive sibling" },
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
  assert.deepEqual(
    session.sessionManager
      .buildContextEntries()
      .map((entry: { id: string }) => entry.id),
    ["m1", "m2"],
  );
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

  await session.connect();
  assert.equal(session.sessionId, "temporary");
  assert.equal(session.sessionFile, undefined);

  await session.prompt("hello");

  const newSessionPayload = sent.find(
    (payload) => payload.type === "new_session",
  );
  assert.ok(newSessionPayload);
  assert.deepEqual(newSessionPayload.frontendIdentity, { kind: "tui" });
  assert.equal(
    sent.find((payload) => payload.type === "prompt")?.sessionFile,
    "/tmp/real.jsonl",
  );
});

test("rpc runtime keeps local steer prompt state while daemon admits the message", async () => {
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
  assert.equal(sent[0]?.streamingBehavior, undefined);
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

test("rpc runtime renders a connecting prompt locally and submits it after recovery", async () => {
  const sent = [];
  let connected = false;
  let releaseRecovery;
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
      return connected;
    },
    disconnect() {
      return Promise.resolve();
    },
  });

  session.rpcConnected = false;
  session.startupPending = false;
  session.waitForDaemonAvailable = () =>
    new Promise((resolve) => {
      releaseRecovery = () => {
        connected = true;
        session.rpcConnected = true;
        resolve();
      };
    });
  session.ensureRemoteSession = () => Promise.resolve();

  const seen = [];
  session.subscribe((event) => seen.push(event));
  seen.length = 0;

  const promptPromise = session.prompt("hello", {
    expandPromptTemplates: false,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.type, "rpc_local_user_message");
  assert.equal(seen[0]?.text, "hello");
  assert.match(seen[0]?.requestTag || "", /^rin-tui-/);
  assert.equal(sent.length, 0);

  releaseRecovery();
  await promptPromise;

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.type, "prompt");
  assert.equal(sent[0]?.message, "hello");
});

test("rpc runtime emits the local user message before remote prompt submission finishes", async () => {
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
  assert.equal(seen[0]?.type, "rpc_local_user_message");
  assert.equal(seen[0]?.text, "hello");
  assert.match(seen[0]?.requestTag || "", /^rin-tui-/);
  assert.deepEqual(seen.slice(1), [
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
