import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";

await import("../support/register-rin-tui-runtime-owner-fixture.ts");
const { RpcInteractiveSession } = await import(
  pathToFileURL(path.resolve("dist/core/rin-tui/runtime.js")).href
);

const ownerGlobal = globalThis as any;
const fixture = ownerGlobal.__rinTuiRuntimeOwner as {
  profile: { cwd: string; agentDir: string };
  events: any[];
};

type Handler =
  | unknown
  | ((payload: Record<string, unknown>) => unknown | Promise<unknown>);

class OwnerRpcClient {
  connected = true;
  sent: Array<Record<string, any>> = [];
  handlers = new Map<string, Handler>();
  listeners = new Set<(event: any) => void>();
  connectCalls = 0;
  disconnectCalls = 0;
  abortCalls = 0;
  abortRetryCalls = 0;
  abortCompactionCalls = 0;
  compactCalls: unknown[] = [];

  constructor() {
    this.handlers.set("get_state", () => ({
      sessionFile: "/owner/sessions/active.jsonl",
      sessionId: "active",
      sessionName: "Owner session",
      model: {
        provider: "openai",
        id: "owner-model",
        reasoning: true,
      },
      thinkingLevel: "medium",
      steeringMode: "all",
      followUpMode: "one-at-a-time",
      autoCompactionEnabled: true,
      turnActive: false,
      isCompacting: false,
      pendingMessageCount: 0,
    }));
    this.handlers.set("get_session_snapshot", () => ({
      entries: [
        {
          id: "user-1",
          type: "message",
          timestamp: "2026-07-18T00:00:00.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "owner question" }],
          },
        },
        {
          id: "assistant-1",
          parentId: "user-1",
          type: "message",
          timestamp: "2026-07-18T00:00:01.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "owner answer" }],
          },
        },
      ],
      leafId: "assistant-1",
    }));
    this.handlers.set("get_resource_diagnostics", () => ({
      skills: { skills: [{ name: "owner-skill" }], diagnostics: ["skill-ok"] },
      prompts: { prompts: [{ name: "owner-prompt" }], diagnostics: [] },
      themes: { themes: [{ name: "owner-theme" }], diagnostics: [] },
      extensions: {
        extensions: [{ path: "/owner/extension.ts" }],
        errors: [],
        diagnostics: ["extension-ok"],
        commandDiagnostics: ["command-ok"],
        shortcutDiagnostics: ["shortcut-ok"],
      },
    }));
    this.handlers.set("get_all_models", () => ({ models: [] }));
    this.handlers.set("get_available_models", () => ({ models: [] }));
    this.handlers.set("get_oauth_state", () => ({}));
  }

  set(type: string, handler: Handler) {
    this.handlers.set(type, handler);
  }

  async send(payload: Record<string, any>) {
    this.sent.push(payload);
    const handler = this.handlers.get(payload.type);
    if (handler instanceof Error) throw handler;
    const data =
      typeof handler === "function" ? await handler(payload) : (handler ?? {});
    if (data && typeof data === "object" && "success" in (data as any)) {
      return data as any;
    }
    return { success: true, data };
  }

  subscribe(listener: (event: any) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: any) {
    for (const listener of [...this.listeners]) listener(event);
  }

  isConnected() {
    return this.connected;
  }

  async connect() {
    this.connectCalls += 1;
    this.connected = true;
  }

  async disconnect() {
    this.disconnectCalls += 1;
    this.connected = false;
  }

  async abort() {
    this.abortCalls += 1;
  }

  async abortRetry() {
    this.abortRetryCalls += 1;
  }

  async abortCompaction() {
    this.abortCompactionCalls += 1;
  }

  async compact(instructions?: string) {
    this.compactCalls.push(instructions);
    return { compacted: true, instructions };
  }
}

function makeSession(
  client = new OwnerRpcClient(),
  options: Record<string, unknown> | string[] = {},
) {
  const session = new RpcInteractiveSession(
    client as any,
    options as any,
    undefined,
    { kind: "tui", key: "owner-instance" },
  );
  session.settingsManager = {
    getCompactionEnabled: () => true,
    setSteeringMode() {},
    setFollowUpMode() {},
  };
  return { session: session as any, client };
}

function sentOf(client: OwnerRpcClient, type: string) {
  return client.sent.filter((payload) => payload.type === type);
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("rpc runtime composes real local session, resource, and capability contracts", async () => {
  fixture.events.length = 0;
  const flags = new Map([["owner-flag", "enabled"]]);
  const { session, client } = makeSession(new OwnerRpcClient(), {
    tools: ["read", "bash"],
    excludeTools: ["bash"],
    noTools: false,
    additionalExtensionPaths: ["/owner/ext"],
    extensionFlagValues: flags,
    additionalSkillPaths: ["/owner/skills"],
    additionalPromptTemplatePaths: ["/owner/prompts"],
    additionalThemePaths: ["/owner/themes"],
    noExtensions: false,
    noSkills: false,
    noPromptTemplates: false,
    noThemes: false,
    noContextFiles: true,
    systemPrompt: "owner system",
    appendSystemPrompt: ["owner append"],
  });

  assert.equal(session.getToolDefinition("missing"), undefined);
  assert.equal(session.getToolDefinition(""), undefined);
  assert.equal(session.sessionManager.getCwd(), "/owner/work");
  assert.equal(session.sessionManager.getSessionDir(), "/owner/agent/sessions");
  assert.deepEqual(fixture.events, [
    ["session-dir", "/owner/work", "/owner/agent"],
  ]);
  assert.deepEqual(session.resourceLoader.getSkills(), {
    skills: [],
    diagnostics: [],
  });
  assert.deepEqual(session.resourceLoader.getAgentsFiles(), {
    agentsFiles: [],
  });
  assert.deepEqual([...session.resourceLoader.getPathMetadata()], []);

  client.set("new_session", {
    sessionFile: "/owner/sessions/new.jsonl",
    sessionId: "new",
  });
  assert.equal(await session.newSession({ parentSession: "parent" }), true);
  const createPayload = sentOf(client, "new_session")[0];
  assert.equal(createPayload.parentSession, "parent");
  assert.deepEqual(createPayload.resourceOptions, {
    tools: ["read", "bash"],
    excludeTools: ["bash"],
    additionalExtensionPaths: ["/owner/ext"],
    noExtensions: false,
    extensionFlagValues: [["owner-flag", "enabled"]],
    additionalSkillPaths: ["/owner/skills"],
    noSkills: false,
    additionalPromptTemplatePaths: ["/owner/prompts"],
    noPromptTemplates: false,
    additionalThemePaths: ["/owner/themes"],
    noThemes: false,
    noContextFiles: true,
    systemPrompt: "owner system",
    appendSystemPrompt: ["owner append"],
  });
  assert.equal(
    session.sessionManager.getSessionFile(),
    "/owner/sessions/active.jsonl",
  );
  assert.equal(session.sessionManager.getSessionId(), "active");
  assert.equal(session.sessionManager.isPersisted(), true);
  assert.equal(session.sessionManager.usesDefaultSessionDir(), false);
  assert.equal(session.sessionManager.getHeader(), null);
  assert.equal(session.sessionManager.getSessionName(), "Owner session");
  assert.equal(session.sessionManager.getLeafId(), "assistant-1");
  assert.deepEqual(session.sessionManager.buildSessionContext().messages, [
    {
      role: "user",
      content: [{ type: "text", text: "owner question" }],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "owner answer" }],
    },
  ]);
  assert.equal(session.getLastAssistantText(), "owner answer");
  assert.equal(session.getUserMessagesForForking()[0].text, "owner question");
  assert.equal(session.getSessionStats().sessionId, "active");
  assert.equal(session.getContextUsage(), undefined);

  const arrayOptions = makeSession(new OwnerRpcClient(), ["/a", "/b"]).session;
  assert.deepEqual(arrayOptions.extensionOptions.additionalExtensionPaths, [
    "/a",
    "/b",
  ]);
  const arrayClient = arrayOptions.client as OwnerRpcClient;
  arrayOptions.settingsManager = { getCompactionEnabled: () => false };
  arrayClient.set("new_session", { cancelled: true });
  assert.equal(await arrayOptions.newSession(), false);
  await arrayOptions.prepareForInteractiveStartup();
  assert.equal(arrayOptions.autoCompactionEnabled, false);
});

test("rpc runtime maps command methods to exact daemon requests and state transitions", async () => {
  const { session, client } = makeSession();
  session.applyState({
    sessionFile: "/owner/sessions/current.jsonl",
    sessionId: "current",
    model: { provider: "openai", id: "owner", reasoning: true },
  });
  session.setRpcConnected(true);
  client.set("list_sessions", {
    sessions: [
      {
        id: "resume-me",
        path: "/owner/sessions/resume.jsonl",
        name: "Resume me",
        firstMessage: "Owner first",
        modified: "2026-07-18T00:00:00.000Z",
        messageCount: 2,
        allMessagesText: "Owner first Owner answer",
      },
    ],
    offset: 2,
    limit: 5,
    total: 9,
    nextOffset: 3,
    hasMore: false,
  });
  client.set("switch_session", {
    sessionFile: "/owner/sessions/resume.jsonl",
    sessionId: "resume-me",
  });
  client.set("fork", { cancelled: false, text: "selected owner text" });
  client.set("navigate_tree", {
    cancelled: false,
    aborted: true,
    editorText: "owner editor",
    summaryEntry: { id: "summary" },
  });
  client.set("export_html", { path: "/owner/export.html" });
  client.set("export_jsonl", { path: "/owner/export.jsonl" });
  client.set("get_active_tools", { tools: ["read"] });
  client.set("get_all_tools", { tools: [{ name: "read" }] });
  client.set("set_active_tools", { tools: ["read"] });
  client.set("refresh_tools", { tools: [{ name: "bash" }] });

  const page = await session.listSessionPage("all", { offset: 2, limit: 5 });
  assert.deepEqual(page, {
    sessions: [
      {
        id: "resume-me",
        path: "/owner/sessions/resume.jsonl",
        name: "Resume me",
        firstMessage: "Owner first",
        modified: new Date("2026-07-18T00:00:00.000Z"),
        messageCount: 2,
        cwd: undefined,
        allMessagesText: "Owner first Owner answer",
      },
    ],
    offset: 2,
    limit: 5,
    total: 9,
    hasMore: true,
    nextOffset: 3,
  });
  assert.equal((await session.listSessions())[0].id, "resume-me");
  assert.equal(
    await session.switchSession("/owner/sessions/resume.jsonl"),
    true,
  );
  await session.renameSession("/owner/sessions/resume.jsonl", "Renamed");
  assert.deepEqual(await session.fork("user-1"), {
    cancelled: false,
    selectedText: "selected owner text",
  });
  assert.deepEqual(
    await session.navigateTree("assistant-1", {
      summarize: true,
      customInstructions: "short",
      replaceInstructions: true,
      label: "owner branch",
    }),
    {
      cancelled: false,
      aborted: true,
      editorText: "owner editor",
      summaryEntry: { id: "summary" },
    },
  );
  assert.equal(await session.exportToHtml(), "/owner/export.html");
  assert.equal(
    await session.exportToJsonl("/wanted.jsonl"),
    "/owner/export.jsonl",
  );
  assert.equal(await session.importFromJsonl("/owner/import.jsonl"), true);

  assert.deepEqual(await session.getActiveTools(), ["read"]);
  assert.deepEqual(await session.getAllTools(), [{ name: "read" }]);
  await session.setActiveToolsByName(["read", "bash"]);
  assert.deepEqual(session.activeToolsCache, ["read"]);
  client.set("set_active_tools", {});
  await session.setActiveToolsByName(["bash"]);
  assert.deepEqual(session.activeToolsCache, ["bash"]);
  assert.deepEqual(await session.refreshTools(), [{ name: "bash" }]);
  await session.appendEntry("owner-entry", { value: 1 });
  await session.sendCustomMessage(
    { role: "assistant", content: "owner" },
    {
      triggerTurn: false,
    },
  );
  await session.sendUserMessage("owner input", { requestTag: "owner-tag" });

  assert.deepEqual(
    await session.executeBash("printf owner", undefined, {
      excludeFromContext: true,
    }),
    {},
  );
  assert.equal(session.isBashRunning, false);
  await session.abortBash();
  session.abortRetry();
  await flush();
  assert.equal(session.isRetrying, false);
  assert.equal(session.autoRetryEnabled, false);
  assert.equal(session.setAutoRetryEnabled(true), undefined);
  assert.equal(session.recordBashResult("owner", {}, {}), undefined);
  assert.equal(session.abortBranchSummary(), undefined);
  session.abortCompaction();
  await flush();
  assert.equal(client.abortCalls, 0);
  assert.equal(client.abortRetryCalls, 1);
  assert.equal(client.abortCompactionCalls, 1);

  assert.deepEqual(await session.runCommand("/abort"), {
    handled: true,
    text: "Aborted current operation.",
  });
  client.set("new_session", { cancelled: true });
  assert.deepEqual(await session.runCommand("/new"), {
    handled: true,
    cancelled: true,
    text: "Session switch cancelled.",
  });
  assert.deepEqual(await session.runCommand("/compact owner focus"), {
    compacted: true,
    instructions: "owner focus",
    handled: true,
    text: "Compacted session.",
  });
  assert.deepEqual(await session.runCommand("/resume missing"), {
    handled: true,
    text: "Session not found: missing",
  });
  assert.deepEqual(await session.runCommand("/resume resume-me"), {
    handled: true,
    text: "Resumed session: resume-me",
  });
  client.set("run_command", { handled: true, text: "daemon owner" });
  assert.deepEqual(await session.runCommand("/usage"), {
    handled: true,
    text: "daemon owner",
  });

  await session.setSessionName("Owner renamed");
  await session.setEntryLabel("assistant-1", "Important");
  await session.detachSession();
  await session.shutdownSession();
  await session.terminateSession();
  client.connected = false;
  const before = client.sent.length;
  await session.shutdownSession();
  await session.terminateSession();
  assert.equal(client.sent.length, before);

  assert.deepEqual(sentOf(client, "bash").at(-1), {
    type: "bash",
    command: "printf owner",
    excludeFromContext: true,
  });
  assert.deepEqual(sentOf(client, "set_entry_label").at(-1), {
    type: "set_entry_label",
    entryId: "assistant-1",
    label: "Important",
  });
});

test("rpc runtime owns prompt admission, queue visibility, and recovery without losing turns", async () => {
  const { session, client } = makeSession();
  const events: any[] = [];
  const unsubscribe = session.subscribe((event: any) => events.push(event));
  session.applyState({
    sessionFile: "/owner/sessions/current.jsonl",
    sessionId: "current",
    model: { provider: "openai", id: "owner", reasoning: true },
  });
  session.setRpcConnected(true);
  const unsubscribeThrowingListener = session.subscribe(() => {
    throw new Error("owner listener failure");
  });
  unsubscribeThrowingListener();
  client.set("get_commands", {
    commands: [
      { name: "owner-ext", source: "extension", description: "Owner ext" },
      { name: "usage", source: "extension", description: "Codex usage" },
      { name: "template", source: "prompt", description: "Template" },
    ],
  });
  client.set("run_command", { handled: true });

  await session.prompt("/owner-ext hello");
  assert.equal(
    sentOf(client, "run_command").at(-1)?.commandLine,
    "/owner-ext hello",
  );
  const promptCount = sentOf(client, "prompt").length;
  await session.prompt("/template hello");
  assert.equal(sentOf(client, "prompt").length, promptCount + 1);
  await session.prompt("owner prompt", {
    images: [{ type: "image", data: "owner" }],
    source: "owner-source",
    requestTag: "owner-request",
  });
  assert.deepEqual(sentOf(client, "prompt").at(-1), {
    type: "prompt",
    message: "owner prompt",
    images: [{ type: "image", data: "owner" }],
    source: "owner-source",
    requestTag: "owner-request",
    frontendIdentity: { kind: "tui", key: "owner-instance" },
    streamingBehavior: undefined,
  });
  assert.equal(
    events.some(
      (event) =>
        event.type === "rpc_local_user_message" &&
        event.text === "owner prompt",
    ),
    true,
  );

  const localEchoCount = events.filter(
    (event) => event.type === "rpc_local_user_message",
  ).length;
  await session.prompt("   ", { expandPromptTemplates: false });
  assert.equal(
    events.filter((event) => event.type === "rpc_local_user_message").length,
    localEchoCount,
  );

  await session.steer("owner steer", undefined, { source: "owner" });
  await session.followUp("owner followup", undefined, { requestTag: "follow" });
  assert.deepEqual(sentOf(client, "prompt").slice(-2), [
    {
      type: "prompt",
      message: "owner steer",
      images: undefined,
      source: "owner",
      requestTag: sentOf(client, "prompt").at(-2)?.requestTag,
      frontendIdentity: { kind: "tui", key: "owner-instance" },
      streamingBehavior: undefined,
    },
    {
      type: "prompt",
      message: "owner followup",
      images: undefined,
      source: undefined,
      requestTag: "follow",
      frontendIdentity: { kind: "tui", key: "owner-instance" },
      streamingBehavior: undefined,
    },
  ]);
  await (session as any).sendOrQueue({
    mode: "steer",
    message: "owner private steer",
    images: undefined,
    source: "owner-private",
    requestTag: "owner-private-request",
    streamingBehavior: "steer",
  });
  assert.equal(sentOf(client, "steer").at(-1)?.message, "owner private steer");
  client.set("prompt", new Error("owner generic prompt failure"));
  await assert.rejects(
    session.prompt("owner generic failure"),
    /owner generic prompt failure/,
  );
  assert.equal(session.isStreaming, false);
  client.set("prompt", { accepted: true });

  client.connected = false;
  session.setRpcConnected(false);
  let reconnectCalls = 0;
  session.ensureReconnectLoop = async () => {
    reconnectCalls += 1;
    client.connected = true;
    session.setRpcConnected(true);
  };
  const reconnectEchoCount = events.filter(
    (event) => event.type === "rpc_local_user_message",
  ).length;
  await session.prompt("wait for daemon");
  assert.equal(
    events.filter((event) => event.type === "rpc_local_user_message").length,
    reconnectEchoCount + 1,
  );
  assert.equal(sentOf(client, "prompt").at(-1)?.message, "wait for daemon");
  assert.equal(reconnectCalls, 1);

  client.connected = false;
  session.setRpcConnected(false);
  await assert.rejects(
    session.steer("queued steer"),
    /rin_frontend_disconnected/,
  );
  await assert.rejects(
    session.followUp("queued follow"),
    /rin_frontend_disconnected/,
  );
  assert.deepEqual(session.getSteeringMessages(), []);
  assert.deepEqual(session.getFollowUpMessages(), []);
  assert.equal(session.pendingMessageCount, 0);
  assert.equal(reconnectCalls, 1);
  assert.deepEqual(session.clearQueue(), {
    steering: [],
    followUp: [],
  });
  assert.equal(session.pendingMessageCount, 0);

  session.applyQueueUpdate({
    steering: [" one ", null, ""],
    followUp: [" two ", 3],
  });
  assert.deepEqual(session.getSteeringMessages(), [" one "]);
  assert.deepEqual(session.getFollowUpMessages(), [" two ", "3"]);
  client.connected = true;
  session.setRpcConnected(true);
  session.clearQueue();
  await flush();
  assert.equal(sentOf(client, "clear_queue").length > 0, true);

  client.set("prompt", new Error("rin_disconnected:owner"));
  await assert.rejects(session.prompt("retry me"), /rin_disconnected:owner/);
  assert.deepEqual(session.getSteeringMessages(), []);
  assert.equal(session.pendingMessageCount, 0);
  assert.equal(session.isStreaming, false);

  session.queuedOfflineOps = [];
  session.recoveryPending = false;
  session.setRpcConnected(true);
  client.set("prompt", new Error("timeout: prompt"));
  await assert.rejects(session.prompt("timeout me"), /timeout: prompt/);
  assert.equal(session.recoveryPending, true);
  assert.equal(reconnectCalls >= 1, true);

  session.disposed = false;
  session.recoveryPending = true;
  session.rpcConnected = true;
  session.remoteTurnRunning = false;
  session.isCompacting = false;
  session.queuedOfflineOps = [];
  session.refreshState = async () => {};
  session.emitSessionResynced = () => events.push({ type: "resynced" });
  session.emitFrontendStatus = () => {};
  session.replayPendingTerminalTurnEventForTarget = undefined;
  client.set("prompt", {});
  session.timedOutPromptOps = [
    { mode: "prompt", message: "timeout me", requestTag: "timed" },
  ];
  await session.handleConnectionRestored();
  assert.equal(session.recoveryPending, false);
  assert.equal(sentOf(client, "select_session").length, 0);
  assert.equal(sentOf(client, "get_state").length > 0, true);
  assert.equal(sentOf(client, "prompt").at(-1)?.message, "timeout me");

  unsubscribe();
  const eventCount = events.length;
  session.emitEvent({ type: "status", level: "info", text: "ignored" });
  assert.equal(events.length, eventCount);
});

test("rpc runtime binds extension UI and passive extension catalog to daemon authority", async () => {
  const { session, client } = makeSession();
  session.applyState({
    sessionFile: "/owner/sessions/current.jsonl",
    sessionId: "current",
  });
  session.setRpcConnected(true);
  client.set("get_commands", {
    commands: [
      {
        name: "owner-command",
        source: "extension",
        description: "Owner command",
        sourceInfo: { path: "/owner/ext.ts" },
      },
      { name: "builtin", source: "builtin" },
    ],
  });
  client.set("get_command_argument_completions", { items: ["one", "two"] });
  const uiCalls: any[] = [];
  const ui = {
    select: async (...args: any[]) => (
      uiCalls.push(["select", ...args]),
      "two"
    ),
    confirm: async (...args: any[]) => (
      uiCalls.push(["confirm", ...args]),
      true
    ),
    input: async (...args: any[]) => (
      uiCalls.push(["input", ...args]),
      "typed"
    ),
    editor: async (...args: any[]) => (
      uiCalls.push(["editor", ...args]),
      "edited"
    ),
    notify: (...args: any[]) => uiCalls.push(["notify", ...args]),
    setStatus: (...args: any[]) => uiCalls.push(["status", ...args]),
    setWorkingMessage: (...args: any[]) =>
      uiCalls.push(["working-message", ...args]),
    setWorkingVisible: (...args: any[]) =>
      uiCalls.push(["working-visible", ...args]),
    setWorkingIndicator: (...args: any[]) =>
      uiCalls.push(["indicator", ...args]),
    setHiddenThinkingLabel: (...args: any[]) =>
      uiCalls.push(["thinking", ...args]),
    setWidget: (...args: any[]) => uiCalls.push(["widget", ...args]),
    setFooter: (...args: any[]) => uiCalls.push(["footer", ...args]),
    setHeader: (...args: any[]) => uiCalls.push(["header", ...args]),
    setTitle: (...args: any[]) => uiCalls.push(["title", ...args]),
    setToolsExpanded: (...args: any[]) => uiCalls.push(["tools", ...args]),
    setEditorText: (...args: any[]) => uiCalls.push(["editor-text", ...args]),
  };
  await session.bindExtensions({ uiContext: ui });
  const commands = session.extensionRunner.getRegisteredCommands();
  assert.deepEqual(
    commands.map((command: any) => command.name),
    ["owner-command"],
  );
  const ownerCommand = session.extensionRunner.getCommand("owner-command");
  assert.equal(ownerCommand.description, "Owner command");
  assert.deepEqual(await ownerCommand.getArgumentCompletions("o"), [
    "one",
    "two",
  ]);
  assert.equal(session.extensionRunner.getCommand("missing"), undefined);
  assert.deepEqual(session.extensionRunner.getShortcuts(), new Map());
  assert.equal(await session.extensionRunner.emitUserBash(), null);

  const requests = [
    { method: "select", id: "select", title: "Pick", options: ["one", "two"] },
    { method: "confirm", id: "confirm", title: "Sure", message: "Continue?" },
    { method: "input", id: "input", title: "Input", placeholder: "Owner" },
    { method: "editor", id: "editor", title: "Edit", prefill: "Owner" },
    { method: "notify", message: "Notice", notifyType: "info" },
    {
      method: "rinCommandResult",
      result: {
        fallbackText: "Codex usage fallback",
        parts: [{ type: "image", path: "/tmp/codex-usage.png" }],
      },
    },
    { method: "setStatus", statusKey: "owner", statusText: "Ready" },
    { method: "setWorkingMessage", message: "Working owner" },
    { method: "setWorkingVisible", visible: true },
    { method: "setWorkingIndicator", options: { kind: "owner" } },
    { method: "setHiddenThinkingLabel", label: "Thinking owner" },
    {
      method: "setWidget",
      widgetKey: "owner",
      widgetLines: ["line"],
      widgetPlacement: "above",
    },
    { method: "setFooter" },
    { method: "setHeader" },
    { method: "setTitle", title: "Owner title" },
    { method: "setToolsExpanded", expanded: true },
    { method: "set_editor_text", text: "Owner editor" },
    { method: "unknown", id: "unknown" },
  ];
  for (const request of requests) {
    await session.handleExtensionUiRequest(request);
  }
  assert.deepEqual(
    client.sent.filter((payload) => payload.type === "extension_ui_response"),
    [
      { type: "extension_ui_response", id: "select", value: "two" },
      { type: "extension_ui_response", id: "confirm", confirmed: true },
      { type: "extension_ui_response", id: "input", value: "typed" },
      { type: "extension_ui_response", id: "editor", value: "edited" },
      { type: "extension_ui_response", id: "unknown", cancelled: true },
    ],
  );
  assert.deepEqual(uiCalls, [
    ["working-visible", false],
    ["select", "Pick", ["one", "two"]],
    ["confirm", "Sure", "Continue?"],
    ["input", "Input", "Owner"],
    ["editor", "Edit", "Owner"],
    ["notify", "Notice", "info"],
    ["notify", "Codex usage fallback", "info"],
    ["status", "owner", "Ready"],
    ["working-message", "Working owner"],
    ["working-visible", false],
    ["indicator", { kind: "owner" }],
    ["thinking", "Thinking owner"],
    ["widget", "owner", ["line"], { placement: "above" }],
    ["footer", undefined],
    ["header", undefined],
    ["title", "Owner title"],
    ["tools", true],
    ["editor-text", "Owner editor"],
  ]);

  client.set("get_resource_diagnostics", {
    skills: { skills: null, diagnostics: "bad" },
    prompts: undefined,
    themes: {},
    extensions: {
      extensions: null,
      errors: "bad",
      diagnostics: [],
      commandDiagnostics: ["command owner"],
      shortcutDiagnostics: ["shortcut owner"],
    },
  });
  await session.reload();
  assert.deepEqual(session.resourceLoader.getSkills(), {
    skills: [],
    diagnostics: [],
  });
  assert.deepEqual(session.extensionRunner.getCommandDiagnostics(), [
    "command owner",
  ]);
  assert.deepEqual(session.extensionRunner.getShortcutDiagnostics(), [
    "shortcut owner",
  ]);
  assert.equal(await session.shutdownLocalExtensions({}), false);
});

test("rpc runtime exposes bound Pi facades, model mutations, and refresh queues", async () => {
  const { session, client } = makeSession();
  const events: any[] = [];
  session.subscribe((event: any) => events.push(event));
  session.applyState({
    sessionFile: "/owner/sessions/current.jsonl",
    sessionId: "current",
    model: {
      provider: "openai",
      id: "owner",
      reasoning: true,
      contextWindow: 128000,
    },
    thinkingLevel: "medium",
  });
  session.setRpcConnected(true);
  await session.refreshSessionData();

  assert.deepEqual(session.resourceLoader.getThemes(), {
    themes: [],
    diagnostics: [],
  });
  assert.deepEqual(session.resourceLoader.getPrompts(), {
    prompts: [],
    diagnostics: [],
  });
  assert.deepEqual(session.resourceLoader.getExtensions(), {
    extensions: [],
    errors: [],
    diagnostics: [],
    commandDiagnostics: [],
    shortcutDiagnostics: [],
  });
  assert.equal(session.sessionManager.getEntry("user-1")?.id, "user-1");
  assert.equal(session.sessionManager.getLabel("user-1"), undefined);
  assert.deepEqual(
    session.sessionManager
      .getBranch("assistant-1")
      .map((entry: any) => entry.id),
    ["user-1", "assistant-1"],
  );
  assert.equal(session.sessionManager.buildContextEntries().length, 2);
  assert.equal(session.sessionManager.getEntries().length, 2);
  assert.equal(session.sessionManager.getTree().length, 1);
  session.sessionManager.appendLabelChange("assistant-1", "Owner label");
  session.sessionManager.appendSessionInfo("Owner info");
  await flush();
  assert.equal(sentOf(client, "set_entry_label").length, 1);
  assert.equal(sentOf(client, "set_session_name").length, 1);

  session.agent.abort();
  await flush();
  assert.equal(client.abortCalls, 1);
  assert.equal(await session.agent.setTransport("rpc"), undefined);
  const idle = session.agent.waitForIdle(100);
  client.emit({ type: "ui", payload: { type: "agent_end" } });
  await idle;
  await assert.rejects(
    session.agent.waitForIdle(1),
    /rin_wait_for_idle_timeout/,
  );

  client.set("set_model", { selected: true });
  await session.setModel({ provider: "anthropic", id: "owner-model" });
  assert.equal(sentOf(client, "set_model").at(-1)?.persistSettings, false);
  await session.setModel(
    { provider: "anthropic", id: "owner-model" },
    { persist: true },
  );
  assert.equal("persistSettings" in sentOf(client, "set_model").at(-1), false);
  session.setScopedModels([
    { model: { provider: "openai", id: "a" }, thinkingLevel: "low" },
  ]);
  assert.equal(session.scopedModels[0].model.id, "a");
  client.set("cycle_model", { cycled: true });
  assert.deepEqual(await session.cycleModel("backward"), { cycled: true });
  assert.equal(sentOf(client, "cycle_model").at(-1)?.persistSettings, false);
  client.set("set_thinking_level", {});
  assert.equal(await session.setThinkingLevel("high"), "high");
  assert.equal(
    sentOf(client, "set_thinking_level").at(-1)?.persistSettings,
    false,
  );
  assert.equal(await session.cycleThinkingLevel(), "off");
  assert.equal(
    sentOf(client, "set_thinking_level").at(-1)?.persistSettings,
    false,
  );
  assert.equal(session.getAvailableThinkingLevels().includes("off"), true);
  client.set("set_steering_mode", {});
  client.set("set_follow_up_mode", {});
  client.set("set_auto_compaction", {});
  assert.equal(await session.setSteeringMode("one-at-a-time"), "one-at-a-time");
  assert.equal(await session.setFollowUpMode("all"), "all");
  assert.equal(await session.setAutoCompactionEnabled(false), false);
  assert.deepEqual(
    await session.callRpcSettingsMutation({
      type: "set_thinking_level",
      level: "medium",
    }),
    {},
  );

  const readiness = await session.ensureSessionReady();
  assert.deepEqual(readiness, {
    sessionFile: "/owner/sessions/active.jsonl",
    sessionId: "active",
    sessionName: "Owner session",
  });
  assert.deepEqual(session.resourceLoader.getSkills(), {
    skills: [{ name: "owner-skill" }],
    diagnostics: ["skill-ok"],
  });

  assert.equal(session.extensionRunner.getMessageRenderer("owner"), undefined);
  assert.deepEqual(session.extensionRunner.getMarkdownTransformers(), []);
  assert.equal(session.extensionRunner.getEntryRenderer("owner"), undefined);
  assert.equal(session.extensionRunner.getToolDefinition("owner"), undefined);
  assert.deepEqual(session.extensionRunner.getAllRegisteredTools(), []);
  assert.equal(session.extensionRunner.invalidate(), undefined);

  const messageRenderer = () => "message";
  const markdownTransformer = () => "markdown";
  const entryRenderer = () => "entry";
  const nativeTool = { name: "native-tool" };
  const nativeShortcuts = new Map([["ctrl+n", { description: "Native" }]]);
  const nativeFlags = new Map([["native-flag", { type: "boolean" }]]);
  const nativeFlagValues = new Map([["native-flag", true]]);
  let invalidations = 0;
  session.frontendNativeExtensionRunner = {
    getShortcutDiagnostics: () => ["native shortcut"],
    getShortcuts: () => nativeShortcuts,
    getMessageRenderer: () => messageRenderer,
    getMarkdownTransformers: () => [markdownTransformer],
    getEntryRenderer: () => entryRenderer,
    getFlags: () => nativeFlags,
    getFlagValues: () => nativeFlagValues,
    getToolDefinition: () => nativeTool,
    getAllRegisteredTools: () => [nativeTool],
    invalidate: () => {
      invalidations += 1;
    },
  };
  assert.deepEqual(session.extensionRunner.getShortcutDiagnostics(), [
    "native shortcut",
  ]);
  assert.equal(session.extensionRunner.getShortcuts({}), nativeShortcuts);
  assert.equal(
    session.extensionRunner.getMessageRenderer("owner"),
    messageRenderer,
  );
  assert.deepEqual(session.extensionRunner.getMarkdownTransformers(), [
    markdownTransformer,
  ]);
  assert.equal(
    session.extensionRunner.getEntryRenderer("owner"),
    entryRenderer,
  );
  assert.equal(session.extensionRunner.getFlags(), nativeFlags);
  assert.equal(session.extensionRunner.getFlagValues(), nativeFlagValues);
  assert.equal(
    session.extensionRunner.getToolDefinition("native-tool"),
    nativeTool,
  );
  assert.deepEqual(session.extensionRunner.getAllRegisteredTools(), [
    nativeTool,
  ]);
  session.extensionRunner.invalidate();
  assert.equal(invalidations, 1);
  session.frontendNativeExtensionRunner = undefined;

  session.emitSessionResynced();
  assert.equal(
    events.some((event) => event.type === "rpc_session_resynced"),
    true,
  );
  await session.queueRefreshState({
    messages: true,
    models: true,
    session: true,
  });
  await session.queueRefreshStateAndRender({ messages: true });
  assert.equal(sentOf(client, "get_state").length > 1, true);
});

test("rpc runtime rejects malformed RPC results and covers cancelled UI fallbacks", async () => {
  const { session, client } = makeSession();
  session.applyState({ sessionId: "temporary" });
  session.setRpcConnected(true);

  client.set("new_session", { cancelled: true });
  assert.equal(await session.newSession(), false);
  client.set("switch_session", { cancelled: true });
  client.set("switch_session", { cancelled: true });
  assert.equal(await session.switchSession(""), false);
  client.set("list_sessions", { sessions: [{ id: "only" }] });
  const fallbackPage = await session.listSessionPage();
  assert.equal(fallbackPage.sessions[0].id, "only");
  assert.equal(fallbackPage.sessions[0].path, "only");
  assert.equal(fallbackPage.sessions[0].firstMessage, "only");
  assert.equal(fallbackPage.sessions[0].modified instanceof Date, true);
  assert.deepEqual(
    {
      offset: fallbackPage.offset,
      limit: fallbackPage.limit,
      total: fallbackPage.total,
      hasMore: fallbackPage.hasMore,
      nextOffset: fallbackPage.nextOffset,
    },
    { offset: 0, limit: 1, total: 1, hasMore: false, nextOffset: 1 },
  );

  client.set("get_command_argument_completions", { items: "not-array" });
  session.commandCatalog = [{ name: "owner", source: "extension" }];
  assert.equal(
    await session.extensionRunner
      .getCommand("owner")
      .getArgumentCompletions("prefix"),
    null,
  );

  await session.bindExtensions({ uiContext: undefined });
  for (const request of [
    { method: "select", id: "select" },
    { method: "confirm", id: "confirm" },
    { method: "input", id: "input" },
    { method: "editor", id: "editor" },
    { method: "select" },
    { method: "confirm" },
    { method: "input" },
    { method: "editor" },
    { method: "notify" },
    { method: "setStatus" },
    { method: "setWorkingMessage" },
    { method: "setWorkingVisible" },
    { method: "setWorkingIndicator" },
    { method: "setHiddenThinkingLabel" },
    { method: "setWidget" },
    { method: "setFooter" },
    { method: "setHeader" },
    { method: "setTitle" },
    { method: "setToolsExpanded" },
    { method: "set_editor_text" },
  ]) {
    await session.handleExtensionUiRequest(request);
  }
  assert.deepEqual(
    client.sent.filter((payload) => payload.type === "extension_ui_response"),
    [
      { type: "extension_ui_response", id: "select", cancelled: true },
      { type: "extension_ui_response", id: "confirm", confirmed: false },
      { type: "extension_ui_response", id: "input", cancelled: true },
      { type: "extension_ui_response", id: "editor", cancelled: true },
    ],
  );

  client.set("export_html", {});
  client.set("export_jsonl", {});
  assert.equal(await session.exportToHtml(), "");
  assert.equal(await session.exportToJsonl(), "");
  client.set("fork", {});
  assert.deepEqual(await session.fork("missing"), {
    cancelled: false,
    selectedText: "",
  });
  client.set("navigate_tree", {});
  assert.deepEqual(await session.navigateTree("missing"), {
    cancelled: false,
    aborted: false,
    editorText: "",
    summaryEntry: undefined,
  });

  client.set("new_session", { cancelled: true });
  session.sessionFile = undefined;
  session.sessionId = "";
  assert.equal(await session.newSession(), false);
  client.set("get_state", { success: false, error: "owner failed" });
  await assert.rejects(session.refreshState(), /owner failed/);
  client.set("get_state", { success: false });
  await assert.rejects(session.refreshState(), /rin_request_failed/);
});

test("rpc runtime connection events expose deterministic frontend phases and cleanup", async () => {
  const { session, client } = makeSession();
  const events: any[] = [];
  session.subscribe((event: any) => events.push(event));
  await session.connect();
  await session.connect();
  assert.equal(client.connectCalls, 2);
  assert.equal(session.rpcConnected, true);
  assert.equal(session.getFrontendStatusEvent(), null);

  session.handleConnectionLost = () => events.push({ type: "lost" });
  client.emit({ type: "ui", name: "connection_lost", payload: {} });
  client.emit({
    type: "extension_ui_request",
    payload: {
      type: "extension_ui_request",
      method: "notify",
      message: "rpc ui",
    },
  });
  client.emit({
    type: "extension_ui_request",
    payload: { type: "extension_ui_request", method: "owner-unknown" },
  });
  client.emit({
    type: "ui",
    name: "oauth",
    payload: { type: "oauth_login_event", event: "unknown" },
  });
  client.emit({ type: "status", text: "ignored" });
  client.emit({ type: "extension_error", payload: {} });
  client.emit({
    type: "extension_error",
    payload: { error: "owner extension failed" },
  });
  client.emit({ type: "ui", name: "ignored", payload: { type: "response" } });
  client.emit({ type: "ui", name: "ignored", payload: null });
  client.emit({
    type: "ui",
    name: "owner",
    payload: { type: "queue_update", steering: ["s"], followUp: ["f"] },
  });
  await flush();
  assert.equal(
    events.some((event) => event.type === "lost"),
    true,
  );
  assert.equal(
    events.some(
      (event) => event.type === "status" && event.text === "Extension error",
    ),
    true,
  );
  assert.equal(
    events.some(
      (event) =>
        event.type === "status" && event.text === "owner extension failed",
    ),
    true,
  );
  assert.deepEqual(session.getSteeringMessages(), ["s"]);
  assert.deepEqual(session.getFollowUpMessages(), ["f"]);

  session.isCompacting = true;
  session.compactionReason = "auto";
  assert.deepEqual(session.getFrontendStatusEvent(), {
    type: "rpc_frontend_status",
    phase: "compacting",
    label: "Auto compacting context",
    connected: true,
  });
  session.isCompacting = false;
  session.retryAttempt = 2;
  assert.equal(session.getFrontendStatusEvent().phase, "retrying");
  session.retryAttempt = 0;
  session.applyState({ turnActive: true });
  assert.equal(session.getFrontendStatusEvent(), null);
  session.applyState({ turnActive: false });
  session.activeTurn = { mode: "prompt", message: "owner" };
  assert.equal(session.getFrontendStatusEvent().phase, "sending");
  session.activeTurn = null;
  session.recoveryPending = true;
  assert.equal(session.getFrontendStatusEvent().phase, "connecting");
  session.recoveryPending = false;
  session.sessionOperationPending = true;
  assert.equal(session.getFrontendStatusEvent().phase, "starting");
  session.sessionOperationPending = false;

  session.abort();
  await flush();
  assert.equal(client.abortCalls, 1);
  assert.equal(session.isStreaming, false);
  await session.disconnect();
  assert.equal(client.disconnectCalls, 1);
  assert.equal(client.listeners.size, 0);
  assert.equal(session.rpcConnected, false);

  const failingClient = new OwnerRpcClient();
  failingClient.connect = async () => {
    failingClient.connectCalls += 1;
    throw new Error("owner connect failed");
  };
  const failingSession = makeSession(failingClient).session;
  let lost = 0;
  failingSession.handleConnectionLost = () => {
    lost += 1;
  };
  await assert.rejects(failingSession.connect(), /owner connect failed/);
  assert.equal(lost, 1);
});
