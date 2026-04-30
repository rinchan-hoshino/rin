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
const { RpcInteractiveSession } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-tui", "runtime.js"))
    .href
);
const { createModelRegistry } = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-tui", "rpc-model-registry.js"),
  ).href
);
const { loadRpcLocalExtensions } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-tui", "extensions.js"))
    .href
);

test("rpc local extensions load settings-configured pi extensions", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-rpc-ext-"));
  const agentDir = path.join(dir, "agent");
  const extensionPath = path.join(dir, "hello-extension.ts");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    extensionPath,
    "export default function(pi: any) { pi.registerCommand('hello', { description: 'hello command', handler: async () => {} }); }\n",
  );
  await fs.writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ extensions: [extensionPath] }),
  );

  const { SettingsManager } = await import("@mariozechner/pi-coding-agent");
  const target = {
    settingsManager: SettingsManager.create(dir, agentDir),
    sessionManager: {
      getCwd: () => dir,
      getSessionDir: () => path.join(agentDir, "sessions"),
    },
    modelRegistry: {},
    extensionBindings: {},
    getFrontendStatusEvent: () => ({ phase: "idle" }),
    getContextUsage: () => null,
  };

  await loadRpcLocalExtensions(target, false, { cwd: dir, agentDir });

  assert.equal(
    target.extensionRunner.getCommand("hello")?.description,
    "hello command",
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
          return Promise.resolve({ success: true, data: {} });
        default:
          throw new Error(`unexpected command: ${payload.type}`);
      }
    },
  });

  await registry.sync();

  assert.deepEqual(registry.getAll(), allModels);
  assert.deepEqual(registry.getAvailable(), availableModels);
  assert.deepEqual(registry.find("anthropic", "claude-sonnet"), allModels[1]);
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

  assert.deepEqual(sent, [
    { type: "extension_ui_response", id: "select-1", value: "Allow" },
    { type: "extension_ui_response", id: "confirm-1", confirmed: true },
    { type: "extension_ui_response", id: "input-1", value: "typed value" },
    { type: "extension_ui_response", id: "editor-1", value: "edited value" },
    { local: "notify", message: "hello", level: "warning" },
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
  const session = new RpcInteractiveSession({
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
  });

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
  assert.equal(sentTypes.at(-1), "get_resource_diagnostics");
});

test("rpc runtime routes extension slash commands from prompt to daemon", async () => {
  const sent = [];
  const localCalls = [];
  const session = new RpcInteractiveSession({
    send(payload) {
      sent.push(payload);
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

  session.extensionRunner = {
    getCommand(name) {
      return name === "chat"
        ? {
            invocationName: "chat",
            handler: async (args) => {
              localCalls.push(["handler", args]);
            },
          }
        : undefined;
    },
  };

  await session.prompt("/chat telegram", { streamingBehavior: "steer" });

  assert.deepEqual(localCalls, []);
  assert.equal(
    sent.some((payload) => payload.type === "prompt"),
    false,
  );
  assert.deepEqual(
    sent.find((payload) => payload.type === "run_command"),
    { type: "run_command", commandLine: "/chat telegram" },
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
    },
  );
  assert.deepEqual(session.getSteeringMessages(), []);
  assert.equal(session.pendingMessageCount, 0);
});

test("rpc runtime resumes a session through select_session", async () => {
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
  assert.equal(sent[0]?.type, "select_session");
  assert.equal(sent[0]?.sessionPath, "/tmp/s2.jsonl");
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
