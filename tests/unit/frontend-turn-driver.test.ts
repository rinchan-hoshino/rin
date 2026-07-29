import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const { RinFrontendTurnDriver } = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-frontend-sdk", "turn-driver.js"),
  ).href
);
const { resolveSubmittedTurnFromMessages } = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-frontend-sdk", "submitted-turn.js"),
  ).href
);

function createDriver() {
  const client = createFrontendClient();
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  (driver as any).testClient = client;
  return driver;
}

async function emitDriverEvent(driver: any, payload: any) {
  await driver.handleClientEvent({ type: "ui", payload });
}

function createFrontendClient() {
  const calls: any[] = [];
  let listener: any = null;
  let connected = false;
  let sessionFile = "/tmp/frontend-chat.jsonl";
  let activeTools = ["read", "bash", "edit", "write", "browse"];
  return {
    calls,
    async connect() {
      connected = true;
    },
    async disconnect() {
      connected = false;
    },
    isConnected() {
      return connected;
    },
    subscribe(nextListener: any) {
      listener = nextListener;
      return () => {
        if (listener === nextListener) listener = null;
      };
    },
    async emit(event: any) {
      await listener?.(event);
    },
    async getState() {
      return { sessionFile, sessionId: "frontend-session", isStreaming: false };
    },
    async prompt(text: string, options: any = {}) {
      calls.push({ type: "prompt", text, options });
      await listener?.({
        type: "ui",
        payload: {
          type: "rpc_turn_event",
          event: "complete",
          requestTag: options.requestTag,
          finalText: "frontend final",
          sessionId: "frontend-session",
          sessionFile,
        },
      });
    },
    async runCommand(commandLine: string) {
      calls.push({ type: "runCommand", commandLine });
      return { handled: true, text: "command done", sessionFile };
    },
    async compact(customInstructions?: string, options: any = {}) {
      calls.push({ type: "compact", customInstructions, options });
      return { handled: true, text: "compact done", sessionFile };
    },
    async terminateSession() {
      calls.push({ type: "terminateSession" });
    },
    async resumeSession(nextSessionFile: string) {
      calls.push({ type: "resumeSession", sessionFile: nextSessionFile });
      sessionFile = nextSessionFile;
    },
    async newSession(options: any = {}) {
      calls.push({ type: "newSession", options });
      sessionFile = "/tmp/frontend-managed.jsonl";
      return { cancelled: false, sessionFile, sessionId: "frontend-session" };
    },
    async listModels() {
      return [];
    },
    async setModel(provider: string, modelId: string, options: any = {}) {
      calls.push({ type: "setModel", provider, modelId, options });
    },
    async setThinkingLevel(level: string, options: any = {}) {
      calls.push({ type: "setThinkingLevel", level, options });
    },
    async resetModelOptionsFromSettings() {
      calls.push({ type: "resetModelOptionsFromSettings" });
    },
    async request(command: any) {
      calls.push({ type: "request", command });
      if (command.type === "get_state") return await this.getState();
      if (command.type === "get_messages") {
        return { messages: await this.getMessages() };
      }
      if (command.type === "resolve_submitted_turn") {
        return resolveSubmittedTurnFromMessages(await this.getMessages(), {
          text: String(command.text || ""),
          sentAt: Number(command.sentAt || 0),
          requestTag: String(command.requestTag || ""),
        });
      }
      if (command.type === "run_command") {
        return await this.runCommand(String(command.commandLine || ""));
      }
      if (command.type === "get_active_tools") {
        return { tools: [...activeTools] };
      }
      if (command.type === "set_active_tools") {
        activeTools = Array.isArray(command.toolNames)
          ? [...command.toolNames]
          : [];
        return { tools: [...activeTools] };
      }
      return {};
    },
    async send(command: any) {
      return {
        type: "response",
        command: command.type,
        success: true,
        data: {},
      };
    },
    async submit(text: string) {
      await this.prompt(text);
    },
    async abort() {},
    async getMessages() {
      return [];
    },
    async getCommands() {
      return [];
    },
    async getAutocompleteItems() {
      return [];
    },
    async getCommandArgumentCompletions() {
      return [];
    },
    async listSessions() {
      return [];
    },
    async respondExtensionUi() {},
  };
}

test("frontend client event handler failures are reported without becoming turn errors", async () => {
  const client = createFrontendClient();
  const failures: any[] = [];
  const seen: any[] = [];
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
    onEventHandlingError: (failure: any) => failures.push(failure),
  });
  driver.subscribe((event: any) => {
    seen.push(event);
  });
  driver.subscribe((event: any) => {
    if (event.type === "passive_notice") {
      throw new Error("chat delivery projection failed");
    }
  });
  await driver.connect();

  await client.emit({
    type: "ui",
    payload: {
      type: "compaction_end",
      errorMessage: "backend remains active",
      willRetry: true,
      requestTag: "observable-turn",
    },
  });
  await waitUntil(
    () => failures.length === 1,
    "frontend event handler failure was not reported",
  );

  assert.equal(failures[0].stage, "frontend_listener");
  assert.match(String(failures[0].error?.message), /projection failed/);
  assert.equal(
    seen.some((event) => event.type === "turn_error"),
    false,
  );
  assert.equal(driver.liveTurn, null);
});

test("frontend event reporter failures preserve the original failure context", async () => {
  const client = createFrontendClient();
  const logged: any[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: any[]) => logged.push(args);
  try {
    const driver = new RinFrontendTurnDriver({
      clientFactory: () => client,
      promptSource: "chat-bridge",
      onEventHandlingError: async () => {
        throw new Error("reporter unavailable");
      },
    });
    driver.subscribe((event: any) => {
      if (event.type === "passive_notice") {
        throw new Error("original projection failure");
      }
    });
    await driver.connect();
    await client.emit({
      type: "ui",
      payload: {
        type: "compaction_end",
        errorMessage: "still active",
        willRetry: true,
      },
    });
    await waitUntil(
      () => logged.length === 2,
      "original and reporter failures were not both logged",
    );
    assert.match(String(logged[0][0]), /stage=frontend_listener/);
    assert.match(String(logged[0][1]?.message), /original projection failure/);
    assert.match(String(logged[1][0]), /event error reporter failed/);
    assert.match(String(logged[1][1]?.message), /reporter unavailable/);
  } finally {
    console.error = originalConsoleError;
  }
});

test("unexpected client event failures are reported without inventing turn errors", async () => {
  const client = createFrontendClient();
  const failures: any[] = [];
  const seen: any[] = [];
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
    onEventHandlingError: (failure: any) => failures.push(failure),
  });
  driver.subscribe((event: any) => seen.push(event));
  await driver.connect();
  (driver as any).handleClientEvent = async () => {
    throw new Error("backend event translation exploded");
  };

  await client.emit({
    type: "ui",
    payload: { type: "working_visible", visible: true },
  });
  await waitUntil(
    () => failures.length === 1,
    "unexpected client event failure was not reported",
  );

  assert.equal(failures[0].stage, "client_event");
  assert.equal(failures[0].clientEvent.type, "ui");
  assert.match(String(failures[0].error?.message), /translation exploded/);
  assert.equal(
    seen.some((event) => event.type === "turn_error"),
    false,
  );
  assert.equal(driver.liveTurn, null);
});

test("terminal listener failures remain terminal while becoming observable", async () => {
  const client = createFrontendClient();
  const failures: any[] = [];
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
    onEventHandlingError: (failure: any) => failures.push(failure),
  });
  driver.subscribe((event: any) => {
    if (event.type === "turn_complete") {
      throw new Error("terminal projection failed");
    }
  });

  await assert.rejects(
    driver.runTurn({ text: "finish this turn" }),
    /terminal projection failed/,
  );
  assert.equal(failures.length, 1);
  assert.equal(failures[0].stage, "terminal_listener");
  assert.equal(failures[0].frontendEvent.type, "turn_complete");
});

test("backend working visibility is the only shared frontend Working source", async () => {
  const driver = createDriver();
  const seen: any[] = [];
  driver.subscribe((event: any) => seen.push(event));

  await emitDriverEvent(driver, {
    type: "rpc_turn_event",
    event: "start",
    requestTag: "turn-1",
  });
  await emitDriverEvent(driver, { type: "agent_start" });
  assert.deepEqual(
    seen.filter((event) => event.type === "frontend_status"),
    [],
  );

  await emitDriverEvent(driver, {
    type: "extension_ui_request",
    method: "setWorkingVisible",
    visible: true,
  });
  await emitDriverEvent(driver, { type: "compaction_start" });
  await emitDriverEvent(driver, { type: "compaction_end" });
  await emitDriverEvent(driver, { type: "agent_end" });
  assert.deepEqual(
    seen.filter((event) => event.type === "frontend_status"),
    [{ type: "frontend_status", phase: "working" }],
  );

  await emitDriverEvent(driver, {
    type: "extension_ui_request",
    method: "setWorkingVisible",
    visible: false,
  });

  assert.deepEqual(seen, [
    { type: "turn_accepted", requestTag: "turn-1" },
    { type: "turn_accepted" },
    { type: "frontend_status", phase: "working" },
    { type: "working_visible", visible: true },
    { type: "compaction_start_notice", text: "Compacting..." },
    { type: "frontend_status", phase: "idle" },
    { type: "working_visible", visible: false },
  ]);
});

test("turn driver carries canonical retry and compaction failures to chat without early settlement", async () => {
  const driver = createDriver();
  const seen: any[] = [];
  driver.subscribe((event: any) => seen.push(event));

  await emitDriverEvent(driver, {
    type: "rpc_turn_event",
    event: "start",
    requestTag: "retry-turn",
  });
  await emitDriverEvent(driver, {
    type: "compaction_start",
    reason: "threshold",
    requestTag: "retry-turn",
  });
  await emitDriverEvent(driver, {
    type: "summarization_retry_scheduled",
    attempt: 1,
    maxAttempts: 3,
    delayMs: 2000,
    errorMessage: "Compaction failed: overloaded",
    requestTag: "retry-turn",
  });
  assert.equal(driver.frontendState.turnActive, true);

  await emitDriverEvent(driver, {
    type: "summarization_retry_attempt_start",
    source: "compaction",
    reason: "threshold",
    requestTag: "retry-turn",
  });
  await emitDriverEvent(driver, {
    type: "compaction_end",
    reason: "threshold",
    aborted: false,
    willRetry: false,
    errorMessage: "Compaction failed after retries",
    requestTag: "retry-turn",
  });
  assert.equal(driver.frontendState.turnActive, true);

  await emitDriverEvent(driver, {
    type: "rpc_turn_event",
    event: "error",
    error: "Compaction failed after retries",
    requestTag: "retry-turn",
  });

  assert.deepEqual(
    seen.filter((event) => event.type !== "frontend_status"),
    [
      { type: "turn_accepted", requestTag: "retry-turn" },
      { type: "compaction_start_notice", text: "Compacting..." },
      {
        type: "passive_notice",
        text: "Compaction failed: overloaded",
        level: "error",
        deferDuringTurn: false,
        noticeKind: "lifecycle_error",
        requestTag: "retry-turn",
      },
      {
        type: "assistant_summary",
        text: "Retrying (1/3) in 2s... (/abort to stop)",
        requestTag: "retry-turn",
      },
      {
        type: "assistant_summary",
        text: "Compacting context...",
        requestTag: "retry-turn",
      },
      {
        type: "passive_notice",
        text: "Compaction failed after retries",
        level: "error",
        deferDuringTurn: false,
        noticeKind: "lifecycle_error",
        requestTag: "retry-turn",
      },
      {
        type: "turn_error",
        error: "Compaction failed after retries",
        sessionId: undefined,
        sessionFile: undefined,
        requestTag: "retry-turn",
      },
    ],
  );
});

async function emitRpcTurnComplete(
  driver: any,
  requestTag: string,
  finalText: string,
  sessionFile = "/tmp/frontend-chat.jsonl",
  sessionId = "frontend-session",
) {
  await emitDriverEvent(driver, {
    type: "rpc_turn_event",
    event: "complete",
    requestTag,
    finalText,
    result: {
      messages: finalText ? [{ type: "text", text: finalText }] : [],
    },
    sessionId,
    sessionFile,
  });
}

async function waitUntil(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("frontend SDK turn driver runs turns through a frontend client", async () => {
  const client = createFrontendClient();
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
    frontendIdentity: { kind: "chat", key: "telegram/1:2" },
  });

  const result = await driver.runTurn({
    text: "hello",
    managedSessionLeaf: "telegram/1:2",
    promptContext: {
      source: "chat-bridge",
      selfImproveEligible: true,
      chatKey: "telegram/1:2",
    },
  });

  assert.equal(result.finalText, "frontend final");
  assert.equal(result.sessionFile, "/tmp/frontend-managed.jsonl");
  assert.deepEqual(
    client.calls
      .filter((call: any) => ["newSession", "prompt"].includes(call.type))
      .map((call: any) => call.type),
    ["newSession", "prompt"],
  );
  const newSessionCall = client.calls.find(
    (call: any) => call.type === "newSession",
  );
  assert.equal(newSessionCall.options.managedSessionLeaf, "telegram/1:2");
  assert.deepEqual(newSessionCall.options.frontendIdentity, {
    kind: "chat",
    key: "telegram/1:2",
  });
  const promptCall = client.calls.find((call: any) => call.type === "prompt");
  assert.equal(promptCall.text, "hello");
  assert.equal(promptCall.options.sessionFile, "/tmp/frontend-managed.jsonl");
  assert.deepEqual(promptCall.options.frontendIdentity, {
    kind: "chat",
    key: "telegram/1:2",
  });
  assert.deepEqual(promptCall.options.promptContext, {
    source: "chat-bridge",
    selfImproveEligible: true,
    chatKey: "telegram/1:2",
  });
});

test("frontend SDK turn driver persists sender prompt context in submitted prompt text", async () => {
  const client = createFrontendClient();
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  await driver.runTurn({
    text: "who am I?",
    managedSessionLeaf: "telegram/1:2",
    promptContext: {
      source: "chat-bridge",
      sentAt: 1710000000000,
      chatKey: "telegram/1:2",
      chatType: "group",
      userId: "guest-1",
      nickname: "Guest",
      identity: "OTHER",
    },
  });

  const promptCall = client.calls.find((call: any) => call.type === "prompt");
  assert.ok(promptCall.text.startsWith("time: "));
  assert.ok(
    promptCall.text.includes("runtime metadata: rin prompt context v1"),
  );
  assert.ok(promptCall.text.includes("sender user id: guest-1"));
  assert.ok(promptCall.text.includes("sender nickname: Guest"));
  assert.ok(promptCall.text.includes("sender trust: other chat user"));
  assert.ok(promptCall.text.endsWith("---\nwho am I?"));
});

test("frontend SDK turn driver applies startup session names before prompt submission", async () => {
  const client = createFrontendClient();
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const result = await driver.runTurn({
    text: "hello",
    managedSessionLeaf: "telegram/1:2",
    sessionName: "daily audit",
  });

  assert.equal(result.finalText, "frontend final");
  const renameIndex = client.calls.findIndex(
    (call: any) =>
      call.type === "request" && call.command?.type === "set_session_name",
  );
  const promptIndex = client.calls.findIndex(
    (call: any) => call.type === "prompt",
  );
  assert.ok(renameIndex >= 0);
  assert.ok(promptIndex > renameIndex);
  assert.deepEqual(client.calls[renameIndex], {
    type: "request",
    command: { type: "set_session_name", name: "daily audit" },
  });
  assert.equal((driver as any).frontendState.sessionName, "daily audit");
});

test("frontend SDK turn driver applies Pi startup options before prompt submission", async () => {
  const client = createFrontendClient();
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const result = await driver.runTurn({
    text: "hello",
    managedSessionLeaf: "telegram/1:2",
    tools: ["read", "grep"],
    excludeTools: ["grep"],
    noTools: "builtin",
    piStartupOptions: { projectTrustOverride: true },
  });

  assert.equal(result.finalText, "frontend final");
  const newSessionCall = client.calls.find(
    (call: any) => call.type === "newSession",
  );
  assert.deepEqual(newSessionCall.options.resourceOptions, {
    tools: ["read", "grep"],
    excludeTools: ["grep"],
    noTools: "builtin",
    piStartupOptions: { projectTrustOverride: true },
  });
  const setToolsIndex = client.calls.findIndex(
    (call: any) =>
      call.type === "request" && call.command?.type === "set_active_tools",
  );
  const promptIndex = client.calls.findIndex(
    (call: any) => call.type === "prompt",
  );
  assert.ok(setToolsIndex >= 0);
  assert.ok(promptIndex > setToolsIndex);
  assert.deepEqual(client.calls[setToolsIndex].command, {
    type: "set_active_tools",
    toolNames: ["read"],
    sessionFile: "/tmp/frontend-managed.jsonl",
  });
});

test("frontend SDK turn driver reuses the controller-restored command session", async () => {
  const driver = createDriver();
  const client = (driver as any).testClient;
  let stateCalls = 0;
  const originalGetState = client.getState.bind(client);
  client.getState = async () => {
    stateCalls += 1;
    return await originalGetState();
  };

  await driver.connect({ restoreSessionFile: "/tmp/frontend-chat.jsonl" });
  const result = await driver.runCommand("/usage", {
    assumeConnected: true,
    assumeSessionReady: true,
    restoreSessionFile: "/tmp/frontend-chat.jsonl",
  });

  assert.equal(result.text, "command done");
  assert.equal(stateCalls, 1);
  assert.deepEqual(
    client.calls.filter((call: any) => call.type === "resumeSession"),
    [{ type: "resumeSession", sessionFile: "/tmp/frontend-chat.jsonl" }],
  );
});

test("frontend SDK turn driver reuses the controller-restored prompt session", async () => {
  const driver = createDriver();
  const client = (driver as any).testClient;
  let stateCalls = 0;
  const originalGetState = client.getState.bind(client);
  client.getState = async () => {
    stateCalls += 1;
    return await originalGetState();
  };

  await driver.connect({ restoreSessionFile: "/tmp/frontend-chat.jsonl" });
  const result = await driver.runTurn({
    text: "hello",
    assumeConnected: true,
    assumeSessionReady: true,
    restoreSessionFile: "/tmp/frontend-chat.jsonl",
  });

  assert.equal(result.finalText, "frontend final");
  assert.equal(stateCalls, 2);
  assert.deepEqual(
    client.calls.filter((call: any) => call.type === "resumeSession"),
    [{ type: "resumeSession", sessionFile: "/tmp/frontend-chat.jsonl" }],
  );
});

test("frontend SDK turn driver routes compact through the native compact client method", async () => {
  const driver = createDriver();
  const client = (driver as any).testClient;

  const result = await driver.runCommand("/compact keep recent plan");

  assert.equal(result.text, "Compacted session.");
  assert.deepEqual(
    client.calls.filter((call: any) =>
      ["compact", "runCommand"].includes(call.type),
    ),
    [
      {
        type: "compact",
        customInstructions: "keep recent plan",
        options: { sessionFile: "/tmp/frontend-chat.jsonl" },
      },
    ],
  );
});

test("frontend SDK turn driver handles /resume without worker run_command", async () => {
  const driver = createDriver();
  const client = (driver as any).testClient;
  client.listSessions = async () => [
    { id: "abc", title: "Previous", path: "/tmp/resume-target.jsonl" },
  ];

  const result = await driver.runCommand("/resume abc");

  assert.equal(result.text, "Resumed session: abc");
  assert.equal(result.sessionFile, "/tmp/resume-target.jsonl");
  assert.deepEqual(
    client.calls.filter((call: any) =>
      ["resumeSession", "runCommand"].includes(call.type),
    ),
    [{ type: "resumeSession", sessionFile: "/tmp/resume-target.jsonl" }],
  );
});

test("frontend SDK turn driver reports missing /resume targets as errors", async () => {
  const driver = createDriver();
  const client = (driver as any).testClient;
  client.listSessions = async () => [
    { id: "abc", title: "Previous", path: "/tmp/resume-target.jsonl" },
  ];

  await assert.rejects(() => driver.runCommand("/resume missing"), {
    message: "session not found: missing",
  });
});

test("frontend SDK turn driver uses configured built-in command responses", async () => {
  const client = createFrontendClient();
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
    commandResponses: { new: "\u5df2\u5f00\u59cb\u65b0\u4f1a\u8bdd\u3002" },
  });

  const result = await driver.runCommand("/new", {
    managedSessionLeaf: "chat",
  });

  assert.equal(result.text, "\u5df2\u5f00\u59cb\u65b0\u4f1a\u8bdd\u3002");
  assert.deepEqual(
    client.calls.find((call: any) => call.type === "newSession"),
    {
      type: "newSession",
      options: {
        managedSessionLeaf: "chat",
        frontendIdentity: { kind: "chat-bridge" },
      },
    },
  );
});

test("frontend SDK /new replaces logical session identity even before a session file exists", async () => {
  const client = createFrontendClient();
  let selectedState: Record<string, unknown> = {
    sessionId: "session-old",
    sessionFile: "/tmp/old-chat.jsonl",
    isStreaming: false,
  };
  client.getState = async () => selectedState;
  client.newSession = async (options: any = {}) => {
    client.calls.push({ type: "newSession", options });
    selectedState = {
      sessionId: "session-empty-new",
      isStreaming: false,
    };
    return { cancelled: false, sessionId: "session-empty-new" };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  await driver.runCommand("/new", { managedSessionLeaf: "chat" });

  assert.equal(driver.currentSessionId(), "session-empty-new");
  assert.equal(driver.currentSessionFile(), "");
  assert.equal(
    client.calls.some(
      (call: any) =>
        call.type === "request" &&
        call.command?.type === "get_state" &&
        call.command?.sessionFile === "/tmp/old-chat.jsonl",
    ),
    false,
  );
});

test("frontend SDK dispose settles an active turn with internal lifecycle cancellation", async () => {
  const client = createFrontendClient();
  let promptStarted = false;
  client.prompt = async () => {
    promptStarted = true;
    await new Promise(() => {});
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const activeTurn = driver.runTurn({ text: "still running" });
  activeTurn.catch(() => {});
  await waitUntil(() => promptStarted, "active turn did not start");

  driver.dispose();

  await assert.rejects(activeTurn, (error: any) => {
    assert.equal(error?.message, "rin_frontend_turn_cancelled");
    assert.notEqual(error?.message, "frontend_turn_driver_disposed");
    assert.equal(error?.silentChatRetry, undefined);
    return true;
  });
});

test("frontend SDK daemon shutdown detach leaves an active turn recoverable without reconnecting", async () => {
  const client = createFrontendClient();
  const originalConnect = client.connect;
  const originalDisconnect = client.disconnect;
  let connectCount = 0;
  let promptStarted = false;
  let rejectPrompt;
  client.connect = async () => {
    connectCount += 1;
    await originalConnect.call(client);
  };
  client.prompt = async () => {
    promptStarted = true;
    await new Promise((_resolve, reject) => {
      rejectPrompt = reject;
    });
  };
  client.disconnect = async () => {
    await originalDisconnect.call(client);
    rejectPrompt?.(new Error("rin_disconnected:daemon_shutdown"));
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  let settled = false;
  const activeTurn = driver.runTurn({ text: "still running" }).finally(() => {
    settled = true;
  });
  activeTurn.catch(() => {});
  await waitUntil(() => promptStarted, "active turn did not start");

  await driver.detachForDaemonShutdown();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(client.isConnected(), false);
  assert.equal(connectCount, 1);
  assert.equal(settled, false);
});

test("frontend SDK daemon shutdown detach stops an in-flight recovery reconnect", async () => {
  const client = createFrontendClient();
  const originalConnect = client.connect;
  const originalDisconnect = client.disconnect;
  let connectCount = 0;
  let recoveryConnectStarted = false;
  let releaseRecoveryConnect;
  let replayRequests = 0;
  client.connect = async () => {
    connectCount += 1;
    if (connectCount > 1) {
      recoveryConnectStarted = true;
      await new Promise((resolve) => {
        releaseRecoveryConnect = resolve;
      });
    }
    await originalConnect.call(client);
  };
  client.prompt = async () => {
    await originalDisconnect.call(client);
    throw new Error("rin_disconnected:daemon_restart");
  };
  const originalRequest = client.request;
  client.request = async (command) => {
    if (command.type === "replay_pending_terminal_turn_event") {
      replayRequests += 1;
    }
    return await originalRequest.call(client, command);
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  let settled = false;
  const activeTurn = driver.runTurn({ text: "still running" }).finally(() => {
    settled = true;
  });
  activeTurn.catch(() => {});
  await waitUntil(
    () => recoveryConnectStarted,
    "recovery reconnect did not start",
  );

  await driver.detachForDaemonShutdown();
  releaseRecoveryConnect();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal((driver as any).reconnectingTurnPromise, null);
  assert.equal(client.isConnected(), false);
  assert.equal(connectCount, 2);
  assert.equal(replayRequests, 0);
  assert.equal(settled, false);
});

test("frontend SDK daemon shutdown detach closes a connection that finishes late", async () => {
  const client = createFrontendClient();
  const originalConnect = client.connect;
  const originalDisconnect = client.disconnect;
  let releaseConnect;
  let connectStarted = false;
  let disconnectCount = 0;
  client.connect = async () => {
    connectStarted = true;
    await new Promise((resolve) => {
      releaseConnect = resolve;
    });
    await originalConnect.call(client);
  };
  client.disconnect = async () => {
    disconnectCount += 1;
    await originalDisconnect.call(client);
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const connecting = driver.connect();
  await waitUntil(() => connectStarted, "connect did not start");
  await driver.detachForDaemonShutdown();
  releaseConnect();
  await connecting;

  assert.equal(client.isConnected(), false);
  assert.equal(disconnectCount, 2);
});

test("frontend SDK daemon shutdown detach stops a session restore continuation", async () => {
  const client = createFrontendClient();
  const originalResumeSession = client.resumeSession;
  let releaseResume;
  let resumeStarted = false;
  client.resumeSession = async (...args) => {
    resumeStarted = true;
    await new Promise((resolve) => {
      releaseResume = resolve;
    });
    return await originalResumeSession.apply(client, args);
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  await driver.connect();

  const restoring = driver.connect({
    restoreSessionFile: "/tmp/frontend-restored.jsonl",
  });
  await waitUntil(() => resumeStarted, "session restore did not start");
  await driver.detachForDaemonShutdown();
  releaseResume();
  await restoring;

  assert.equal(client.isConnected(), false);
  assert.equal(
    client.calls.some(
      (call) => call.type === "request" && call.command.type === "get_state",
    ),
    false,
  );
});

test("frontend SDK shutdown session follows TUI shutdown without lifecycle cancellation", async () => {
  const client = createFrontendClient();
  let promptStarted = false;
  client.prompt = async () => {
    promptStarted = true;
    await new Promise(() => {});
  };
  (client as any).shutdownSession = async () => {
    client.calls.push({ type: "shutdownSession" });
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  let settled = false;
  const activeTurn = driver.runTurn({ text: "still running" }).finally(() => {
    settled = true;
  });
  activeTurn.catch(() => {});
  await waitUntil(() => promptStarted, "active turn did not start");

  await driver.shutdownSession();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(
    client.calls.filter((call: any) => call.type === "shutdownSession"),
    [{ type: "shutdownSession" }],
  );
  assert.equal(client.isConnected(), false);
  assert.equal(settled, false);
});

test("frontend SDK /new interrupts an active turn before creating the new session", async () => {
  const client = createFrontendClient();
  let promptStarted = false;
  let abortCalls = 0;
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    promptStarted = true;
    await new Promise(() => {});
  };
  client.abort = async () => {
    abortCalls += 1;
    client.calls.push({ type: "abort" });
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const activeTurn = driver.runTurn({ text: "still running" });
  activeTurn.catch(() => {});
  await waitUntil(() => promptStarted, "active turn did not start");

  const result = await driver.runCommand("/new", {
    managedSessionLeaf: "chat",
  });

  assert.equal(result.text, "Started a new session.");
  assert.equal(abortCalls, 1);
  await assert.rejects(
    activeTurn,
    /chat_turn_aborted/,
    "the previous live turn should be settled as aborted",
  );
  assert.deepEqual(
    client.calls
      .filter((call: any) => ["abort", "newSession"].includes(call.type))
      .map((call: any) => call.type),
    ["abort", "newSession"],
  );
});

test("frontend SDK /new does not wait for backend abort before creating the new session", async () => {
  const client = createFrontendClient();
  let promptStarted = false;
  let resolveAbort!: () => void;
  const abortReady = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    promptStarted = true;
    await new Promise(() => {});
  };
  client.abort = async () => {
    client.calls.push({ type: "abort:start" });
    await abortReady;
    client.calls.push({ type: "abort:end" });
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const activeTurn = driver.runTurn({ text: "still running" });
  activeTurn.catch(() => {});
  await waitUntil(() => promptStarted, "active turn did not start");

  const result = await driver.runCommand("/new", {
    managedSessionLeaf: "chat",
  });

  assert.equal(result.text, "Started a new session.");
  await assert.rejects(activeTurn, /chat_turn_aborted/);
  assert.deepEqual(
    client.calls
      .filter((call: any) =>
        ["abort:start", "abort:end", "newSession"].includes(call.type),
      )
      .map((call: any) => call.type),
    ["abort:start", "newSession"],
  );

  resolveAbort();
  await new Promise((resolve) => setImmediate(resolve));
});

test("frontend SDK /new aborts a turn that has not submitted its prompt yet", async () => {
  const client = createFrontendClient();
  const originalRequest = client.request.bind(client);
  let releaseToolRefresh!: () => void;
  const toolRefreshReleased = new Promise<void>((resolve) => {
    releaseToolRefresh = resolve;
  });
  let toolRefreshStarted = false;
  let promptCalled = false;
  client.request = async (command: any) => {
    client.calls.push({ type: "request", command });
    if (command?.type === "get_active_tools" && !toolRefreshStarted) {
      toolRefreshStarted = true;
      await toolRefreshReleased;
      return { tools: [] };
    }
    return await originalRequest(command);
  };
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    promptCalled = true;
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const activeTurn = driver.runTurn({ text: "old turn", excludeTools: [] });
  activeTurn.catch(() => {});
  await waitUntil(
    () => toolRefreshStarted,
    "turn did not reach pre-submit wait",
  );

  const result = await driver.runCommand("/new", {
    managedSessionLeaf: "chat",
  });
  releaseToolRefresh();

  assert.equal(result.text, "Started a new session.");
  await assert.rejects(activeTurn, /chat_turn_aborted/);
  assert.equal(promptCalled, false);
});

test("frontend SDK ignores stale terminal events from the aborted turn after /new", async () => {
  const client = createFrontendClient();
  let requestTag = "";
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    requestTag = options.requestTag || "";
    await new Promise(() => {});
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const activeTurn = driver.runTurn({ text: "old turn" });
  activeTurn.catch(() => {});
  await waitUntil(() => Boolean(requestTag), "active turn did not submit");

  const result = await driver.runCommand("/new", {
    managedSessionLeaf: "chat",
  });
  const newSessionFile = driver.currentSessionFile();
  await emitDriverEvent(driver, {
    type: "rpc_turn_event",
    event: "error",
    requestTag,
    error: "chat_turn_aborted",
    sessionFile: "/tmp/old-chat.jsonl",
    sessionId: "old-session",
  });

  assert.equal(result.text, "Started a new session.");
  await assert.rejects(activeTurn, /chat_turn_aborted/);
  assert.equal(driver.currentSessionFile(), newSessionFile);
});

test("frontend SDK keeps non-reset commands from interrupting active turns", async () => {
  const client = createFrontendClient();
  let abortCalls = 0;
  client.getState = async () => ({
    sessionFile: "/tmp/frontend-chat.jsonl",
    sessionId: "frontend-session",
    isStreaming: true,
    turnActive: true,
  });
  client.abort = async () => {
    abortCalls += 1;
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const result = await driver.runCommand("/compact keep important facts");

  assert.equal(result.text, "Compacted session.");
  assert.equal(abortCalls, 0);
  assert.deepEqual(
    client.calls.filter((call: any) => call.type === "compact"),
    [
      {
        type: "compact",
        customInstructions: "keep important facts",
        options: { sessionFile: "/tmp/frontend-chat.jsonl" },
      },
    ],
  );
});

test("frontend SDK turn driver reports an explicit missing session target", async () => {
  const driver = createDriver();

  await assert.rejects(
    () =>
      driver.runTurn({
        text: "hello",
        sessionFile: "/tmp/missing-frontend-session.jsonl",
      }),
    /Session record is missing or expired/,
  );
});

test("frontend SDK turn driver can create an explicit missing session target", async () => {
  const driver = createDriver();
  const client = (driver as any).testClient;
  const sessionFile = "/tmp/new-explicit-frontend-session.jsonl";

  const result = await driver.runTurn({
    text: "hello",
    sessionFile,
    createSessionFileIfMissing: true,
  });

  assert.equal(result.finalText, "frontend final");
  assert.equal(result.sessionFile, sessionFile);
  assert.deepEqual(
    client.calls.filter((call: any) => call.type === "resumeSession"),
    [{ type: "resumeSession", sessionFile }],
  );
});

test("frontend SDK turn driver terminates the attached daemon session", async () => {
  const driver = createDriver();
  const client = (driver as any).testClient;

  await driver.connect();
  await (driver as any).terminateSession();

  assert.deepEqual(
    client.calls.filter((call: any) => call.type === "terminateSession"),
    [{ type: "terminateSession" }],
  );
});

test("frontend SDK turn driver clears active state after terminating the attached daemon session", async () => {
  const driver = createDriver();
  await driver.connect();
  (driver as any).frontendState = {
    sessionFile: "/tmp/frontend-chat.jsonl",
    sessionId: "frontend-session",
    isStreaming: true,
    turnActive: true,
  };

  assert.equal(driver.hasActiveTurn(), true);
  await (driver as any).terminateSession();

  assert.equal(driver.hasActiveTurn(), false);
  assert.equal(driver.currentSessionFile(), "");
});

test("frontend SDK turn driver applies turn-scoped model without persisting defaults", async () => {
  const driver = createDriver();
  const client = (driver as any).testClient;
  client.listModels = async () => [
    { provider: "openai-codex", id: "gpt-5.5", label: "GPT-5.5" },
  ];

  const result = await driver.runTurn({
    text: "hello",
    model: "openai-codex/gpt-5.5",
  });

  assert.equal(result.finalText, "frontend final");
  const modelCall = client.calls.find(
    (call: any) => call.type === "request" && call.command.type === "set_model",
  );
  assert.deepEqual(modelCall.command, {
    type: "set_model",
    provider: "openai-codex",
    modelId: "gpt-5.5",
    persistSettings: false,
    sessionFile: "/tmp/frontend-chat.jsonl",
  });
});

test("frontend SDK turn driver can reset model options from settings before prompting", async () => {
  const driver = createDriver();
  const client = (driver as any).testClient;

  const result = await driver.runTurn({
    text: "hello",
    resetModelOptionsFromSettings: true,
  });

  assert.equal(result.finalText, "frontend final");
  assert.deepEqual(
    client.calls
      .filter(
        (call: any) =>
          (call.type === "request" &&
            call.command.type === "reset_model_options_from_settings") ||
          call.type === "prompt",
      )
      .map((call: any) =>
        call.type === "request" ? call.command.type : call.type,
      ),
    ["reset_model_options_from_settings", "prompt"],
  );
});

test("frontend SDK turn driver applies turn-scoped thinking without persisting defaults", async () => {
  const driver = createDriver();

  const result = await driver.runTurn({
    text: "hello",
    thinkingLevel: "low",
  });

  assert.equal(result.finalText, "frontend final");
  const thinkingCall = (driver as any).testClient.calls.find(
    (call: any) =>
      call.type === "request" && call.command.type === "set_thinking_level",
  );
  assert.deepEqual(thinkingCall.command, {
    type: "set_thinking_level",
    level: "low",
    persistSettings: false,
    sessionFile: "/tmp/frontend-chat.jsonl",
  });
});

test("frontend SDK turn driver resolves an already submitted restored turn without resubmitting", async () => {
  const client = createFrontendClient();
  client.getMessages = async () => [
    {
      role: "user",
      timestamp: 1778774583000,
      content: "restored job",
    },
    {
      role: "assistant",
      timestamp: 1778774590000,
      content: "already finished",
    },
  ];
  client.prompt = async () => {
    throw new Error("prompt_should_not_be_resubmitted");
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const result = await driver.runTurn({
    text: "restored job",
    restoreSessionFile: "/tmp/frontend-chat.jsonl",
    promptContext: {
      source: "chat-bridge",
      chatKey: "telegram/1:2",
      sentAt: 1778774580000,
    },
  });

  assert.equal(result.finalText, "already finished");
  assert.equal(
    client.calls.some((call: any) => call.type === "prompt"),
    false,
  );
});

test("frontend SDK turn driver clears active state when recovered submitted turn has final text", async () => {
  const client = createFrontendClient();
  let resolveCount = 0;
  client.request = async (command: any) => {
    client.calls.push({ type: "request", command });
    if (command.type === "get_state") {
      const active = resolveCount > 1;
      return {
        sessionFile: "/tmp/frontend-chat.jsonl",
        sessionId: "frontend-session",
        isStreaming: active,
        turnActive: active,
      };
    }
    if (command.type === "resolve_submitted_turn") {
      resolveCount += 1;
      if (resolveCount < 3) return { submitted: true };
      return {
        finalText: "already finished while worker still active",
        sessionId: "frontend-session",
        sessionFile: "/tmp/frontend-chat.jsonl",
      };
    }
    return {};
  };
  client.prompt = async () => {
    throw new Error("prompt_should_not_be_resubmitted");
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const result = await driver.runTurn({
    text: "restored job",
    restoreSessionFile: "/tmp/frontend-chat.jsonl",
    promptContext: {
      source: "chat-bridge",
      chatKey: "telegram/1:2",
      sentAt: 1778774580000,
    },
  });

  assert.equal(result.finalText, "already finished while worker still active");
  assert.equal(driver.hasWorkerActiveTurn(), false);
  assert.equal(
    client.calls.some((call: any) => call.type === "prompt"),
    false,
  );
});

test("frontend SDK visible chat working excludes standalone compaction and recovery state", async () => {
  const client = createFrontendClient();
  client.getState = async () => ({
    sessionFile: "/tmp/frontend-chat.jsonl",
    sessionId: "frontend-session",
    isStreaming: false,
    turnActive: false,
    isCompacting: true,
    sessionRecovering: true,
    workingVisible: false,
  });
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  await driver.connect();

  assert.equal(driver.hasActiveTurn(), false);
  assert.equal(driver.hasVisibleChatWorkingTurn(), false);
});

test("submitted turn resolution treats earlier steered inputs as superseded by the latest pre-final user input", () => {
  const messages = [
    {
      role: "user",
      timestamp: 1778774581000,
      content: "first restored input",
    },
    {
      role: "user",
      timestamp: 1778774582000,
      content: "latest restored input",
    },
    {
      role: "assistant",
      timestamp: 1778774590000,
      content: [{ type: "text", text: "one recovered final" }],
    },
  ];

  assert.deepEqual(
    resolveSubmittedTurnFromMessages(messages, {
      text: "first restored input",
      sentAt: 1778774580000,
    }),
    { superseded: true },
  );
  assert.deepEqual(
    resolveSubmittedTurnFromMessages(messages, {
      text: "latest restored input",
      sentAt: 1778774580000,
    }),
    {
      finalText: "one recovered final",
      result: { messages: [{ type: "text", text: "one recovered final" }] },
    },
  );
});

test("submitted turn resolution disambiguates identical steers by durable request tag", () => {
  const messages = [
    {
      role: "user",
      timestamp: 1778774581000,
      requestTag: "first-identical-tag",
      content: "same restored input",
    },
    {
      role: "user",
      timestamp: 1778774581000,
      requestTag: "second-identical-tag",
      content: "same restored input",
    },
    {
      role: "assistant",
      timestamp: 1778774590000,
      content: [{ type: "text", text: "latest identical final" }],
    },
  ];

  assert.deepEqual(
    resolveSubmittedTurnFromMessages(messages, {
      text: "same restored input",
      requestTag: "first-identical-tag",
    }),
    { superseded: true },
  );
  assert.deepEqual(
    resolveSubmittedTurnFromMessages(messages, {
      text: "same restored input",
      requestTag: "second-identical-tag",
    }),
    {
      finalText: "latest identical final",
      result: { messages: [{ type: "text", text: "latest identical final" }] },
    },
  );
  assert.equal(
    resolveSubmittedTurnFromMessages(messages, {
      text: "same restored input",
      sentAt: 1778774580000,
      requestTag: "missing-tag",
    }),
    null,
  );
  assert.deepEqual(
    resolveSubmittedTurnFromMessages(
      [
        {
          role: "user",
          timestamp: 1778774581000,
          content: "legacy identical input",
        },
      ],
      {
        text: "legacy identical input",
        sentAt: 1778774580000,
        requestTag: "modern-request-tag",
      },
    ),
    { submitted: true },
  );
});

test("submitted turn resolution ignores summary markers on outer message wrappers", () => {
  const resolved = resolveSubmittedTurnFromMessages(
    [
      {
        type: "message",
        message: {
          role: "user",
          requestTag: "wrapped-summary-tag",
          content: "restored job",
        },
      },
      {
        type: "compaction",
        summaryEntry: { id: "summary" },
        message: {
          role: "assistant",
          content: [{ type: "text", text: "not a final" }],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "actual final" }],
        },
      },
    ],
    { text: "restored job", requestTag: "wrapped-summary-tag" },
  );

  assert.deepEqual(resolved, {
    finalText: "actual final",
    result: { messages: [{ type: "text", text: "actual final" }] },
  });
});

test("submitted turn resolution preserves provider failure instead of final-missing", () => {
  const resolved = resolveSubmittedTurnFromMessages(
    [
      {
        role: "user",
        timestamp: 1778774583000,
        content: "restored job",
      },
      {
        role: "assistant",
        timestamp: 1778774590000,
        stopReason: "error",
        errorMessage: "WebSocket error",
        content: [
          { type: "thinking", thinking: "working" },
          { type: "toolCall", name: "write", arguments: {} },
        ],
      },
    ],
    { text: "restored job", sentAt: 1778774580000 },
  );

  assert.deepEqual(resolved, { error: "WebSocket error" });
});

test("submitted turn resolution does not surface provider failure while the submitted turn is active", () => {
  const resolved = (resolveSubmittedTurnFromMessages as any)(
    [
      {
        role: "user",
        timestamp: 1778774583000,
        content: "restored job",
      },
      {
        role: "assistant",
        timestamp: 1778774590000,
        stopReason: "error",
        errorMessage: "Codex SSE response headers timed out after 20000ms",
        content: [
          { type: "thinking", thinking: "working" },
          { type: "toolCall", name: "write", arguments: {} },
        ],
      },
    ],
    { text: "restored job", sentAt: 1778774580000 },
    { turnActive: true },
  );

  assert.deepEqual(resolved, { submitted: true });
});

test("submitted turn resolution uses the last empty or media terminal after a failed retry", () => {
  const resolved = resolveSubmittedTurnFromMessages(
    [
      {
        role: "user",
        requestTag: "retry-tag",
        content: "restored job",
      },
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "retry failed",
        content: [],
      },
      {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "image", data: "ZGVtbw==", mimeType: "image/png" }],
      },
      {
        role: "user",
        requestTag: "later-tag",
        content: "later follow-up",
      },
    ],
    { text: "restored job", requestTag: "retry-tag" },
  );

  assert.deepEqual(resolved, {
    finalText: "",
    result: {
      messages: [{ type: "image", data: "ZGVtbw==", mimeType: "image/png" }],
    },
  });
});

test("frontend SDK turn driver surfaces restored submitted provider errors", async () => {
  const originalNow = Date.now;
  let now = 1778774600000;
  (Date as any).now = () => now;

  try {
    const client = createFrontendClient();
    client.getState = async () => {
      now += 121_000;
      return {
        sessionFile: "/tmp/frontend-chat.jsonl",
        sessionId: "frontend-session",
        isStreaming: false,
        turnActive: false,
      };
    };
    client.getMessages = async () => [
      {
        role: "user",
        timestamp: 1778774583000,
        content: "restored job",
      },
      {
        role: "assistant",
        timestamp: 1778774590000,
        stopReason: "error",
        errorMessage: "WebSocket error",
        content: [
          { type: "thinking", thinking: "working" },
          { type: "toolCall", name: "write", arguments: {} },
        ],
      },
    ];
    client.prompt = async () => {
      throw new Error("prompt_should_not_be_resubmitted");
    };
    const driver = new RinFrontendTurnDriver({
      clientFactory: () => client,
      promptSource: "chat-bridge",
    });

    await assert.rejects(
      () =>
        driver.runTurn({
          text: "restored job",
          restoreSessionFile: "/tmp/frontend-chat.jsonl",
          promptContext: {
            source: "chat-bridge",
            chatKey: "telegram/1:2",
            sentAt: 1778774580000,
          },
        }),
      (error: any) =>
        error?.message === "WebSocket error" && error?.rinTurnTerminal === true,
    );
    assert.equal(
      client.calls.some((call: any) => call.type === "prompt"),
      false,
    );
  } finally {
    (Date as any).now = originalNow;
  }
});

test("frontend SDK turn driver reselects a restored session even when cached state matches", async () => {
  const client = createFrontendClient();
  const sessionFile = "/tmp/frontend-chat.jsonl";
  client.getState = async () => ({
    sessionFile,
    sessionId: "frontend-session",
    isStreaming: false,
  });
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const result = await driver.runTurn({
    text: "hello",
    restoreSessionFile: sessionFile,
  });

  assert.equal(result.finalText, "frontend final");
  assert.deepEqual(
    client.calls.filter((call: any) => call.type === "resumeSession"),
    [{ type: "resumeSession", sessionFile }],
  );
});

test("frontend SDK turn driver carries sessionFile on restored turn RPCs", async () => {
  const client = createFrontendClient();
  const sessionFile = "/tmp/frontend-chat.jsonl";
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  await driver.runTurn({
    text: "hello",
    restoreSessionFile: sessionFile,
  });

  const scopedCommands = client.calls
    .filter((call: any) => call.type === "request")
    .map((call: any) => call.command)
    .filter((command: any) =>
      ["get_state", "resolve_submitted_turn"].includes(command.type),
    );
  assert.ok(scopedCommands.length >= 2);
  assert.ok(
    scopedCommands.every((command: any) => command.sessionFile === sessionFile),
  );
  assert.equal(
    client.calls.some(
      (call: any) =>
        call.type === "request" && call.command.type === "get_messages",
    ),
    false,
  );
  const promptCall = client.calls.find((call: any) => call.type === "prompt");
  assert.equal(promptCall.options.sessionFile, sessionFile);
});

test("frontend SDK turn driver carries sessionFile on restored commands", async () => {
  const client = createFrontendClient();
  const sessionFile = "/tmp/frontend-chat.jsonl";
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  await driver.runCommand("/compact", { restoreSessionFile: sessionFile });

  assert.deepEqual(
    client.calls.find((call: any) => call.type === "compact"),
    {
      type: "compact",
      customInstructions: undefined,
      options: { sessionFile },
    },
  );
});

test("frontend SDK turn driver rejoins an active already-submitted turn without resubmitting", async () => {
  const client = createFrontendClient();
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  const sessionFile = "/tmp/frontend-active-submitted.jsonl";
  let resolveCalls = 0;
  client.getState = async () => ({
    sessionFile,
    sessionId: "frontend-session",
    isStreaming: true,
    turnActive: true,
  });
  client.request = async (command: any) => {
    client.calls.push({ type: "request", command });
    if (command.type === "get_state") return await client.getState();
    if (command.type === "resolve_submitted_turn") {
      resolveCalls += 1;
      if (resolveCalls === 1) {
        setImmediate(() => {
          void emitDriverEvent(driver as any, {
            type: "rpc_turn_event",
            event: "complete",
            requestTag: "persisted-active-tag",
            finalText: "recovered active final",
            result: {
              messages: [{ type: "text", text: "recovered active final" }],
            },
            sessionId: "frontend-session",
            sessionFile,
          });
        });
        return { submitted: true };
      }
      return {
        finalText: "recovered active final",
        sessionId: "frontend-session",
        sessionFile,
      };
    }
    if (command.type === "replay_pending_terminal_turn_event") {
      return { replayed: false };
    }
    if (command.type === "get_active_tools") return { tools: [] };
    if (command.type === "set_active_tools") return { tools: [] };
    return {};
  };
  client.prompt = async () => {
    throw new Error("prompt_should_not_be_resubmitted");
  };

  const result = await driver.runTurn({
    text: "restored active job",
    requestTag: "persisted-active-tag",
    restoreSessionFile: sessionFile,
    promptContext: {
      source: "chat-bridge",
      chatKey: "telegram/1:2",
      sentAt: 1778774580000,
    },
  });

  assert.equal(result.finalText, "recovered active final");
  assert.ok(
    client.calls
      .filter(
        (call: any) =>
          call.type === "request" &&
          call.command.type === "resolve_submitted_turn",
      )
      .every((call: any) => call.command.requestTag === "persisted-active-tag"),
  );
  assert.equal(
    client.calls.some((call: any) => call.type === "prompt"),
    false,
  );
});

test("frontend SDK treats active-state input as an ordinary submission and waits for Pi terminal", async () => {
  const client = createFrontendClient();
  client.getState = async () => ({
    sessionFile: "/tmp/frontend-chat.jsonl",
    sessionId: "frontend-session",
    isStreaming: true,
    turnActive: true,
  });
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    return { acceptedAs: "steer" };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const pending = driver.runTurn({
    text: "restored job",
    promptContext: { source: "chat-bridge", chatKey: "telegram/1:2" },
  });
  await waitUntil(
    () => client.calls.some((call: any) => call.type === "prompt"),
    "ordinary submission did not reach backend",
  );
  await emitRpcTurnComplete(
    driver,
    "backend-terminal-owner",
    "Pi terminal",
    "/tmp/frontend-chat.jsonl",
    "frontend-session",
  );

  const result = await pending;
  assert.equal(result.finalText, "Pi terminal");
  const promptCall = client.calls.find((call: any) => call.type === "prompt");
  assert.equal(promptCall.text, "restored job");
  assert.equal(promptCall.options.streamingBehavior, undefined);
});

test("frontend SDK turn driver leaves terminal ownership with the backend after a queued steer starts", async () => {
  const driver = createDriver();
  const client = (driver as any).testClient;
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
  };

  const turn = driver.runTurn({
    text: "first",
    requestTag: "tag-first",
    promptContext: { source: "chat-bridge", chatKey: "telegram/1:2" },
  });
  await waitUntil(
    () => Boolean((driver as any).liveTurn),
    "initial live turn did not start",
  );

  await emitDriverEvent(driver, {
    type: "message_start",
    requestTag: "tag-steer",
    message: {
      role: "user",
      content: [{ type: "text", text: "steer now" }],
    },
  });
  await emitRpcTurnComplete(driver, "tag-steer", "steered final");

  assert.equal((await turn).finalText, "steered final");
});

test("frontend SDK projects a backend terminal after ordinary submission without a local waiter", async () => {
  const client = createFrontendClient();
  client.getState = async () => ({
    sessionFile: "/tmp/frontend-chat.jsonl",
    sessionId: "frontend-session",
    isStreaming: true,
    turnActive: true,
  });
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    return { acceptedAs: "steer", requestTag: options.requestTag };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  const completed: any[] = [];
  driver.subscribe((event: any) => {
    if (event.type === "turn_complete") completed.push(event);
  });

  await driver.submitTurn({
    text: "ordinary input after reconnect",
    requestTag: "tag-remote-input",
    promptContext: { source: "chat-bridge", chatKey: "telegram/1:2" },
  });
  await emitRpcTurnComplete(
    driver,
    "backend-terminal-owner",
    "remote final",
    "/tmp/frontend-chat.jsonl",
    "frontend-session",
  );

  assert.equal(
    client.calls.find((call: any) => call.type === "prompt")?.options
      ?.streamingBehavior,
    undefined,
  );
  assert.deepEqual(completed, [
    {
      type: "turn_complete",
      finalText: "remote final",
      result: { messages: [{ type: "text", text: "remote final" }] },
      sessionId: "frontend-session",
      sessionFile: "/tmp/frontend-chat.jsonl",
      requestTag: "backend-terminal-owner",
    },
  ]);
});

test("frontend SDK submits ordinary input unchanged during a backend tool gap", async () => {
  const client = createFrontendClient();
  client.getState = async () => ({
    sessionFile: "/tmp/frontend-chat.jsonl",
    sessionId: "frontend-session",
    isStreaming: false,
    turnActive: true,
  });
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    return { acceptedAs: "steer" };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const pending = driver.runTurn({
    text: "input between tools",
    promptContext: { source: "chat-bridge", chatKey: "telegram/1:2" },
  });
  await waitUntil(
    () => client.calls.some((call: any) => call.type === "prompt"),
    "ordinary tool-gap input did not reach backend",
  );
  await emitRpcTurnComplete(driver, "backend-terminal-owner", "tool-gap final");

  assert.equal((await pending).finalText, "tool-gap final");
  const promptCall = client.calls.find((call: any) => call.type === "prompt");
  assert.equal(promptCall.text, "input between tools");
  assert.equal(promptCall.options.streamingBehavior, undefined);
});

test("frontend SDK keeps ordinary input transport-pending until compaction ends", async () => {
  const client = createFrontendClient();
  let compacting = true;
  client.getState = async () => ({
    sessionFile: "/tmp/frontend-chat.jsonl",
    sessionId: "frontend-session",
    isStreaming: true,
    turnActive: true,
    isCompacting: compacting,
  });
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    return { acceptedAs: "prompt" };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const pending = driver.runTurn({
    text: "input after compaction",
    promptContext: { source: "chat-bridge", chatKey: "telegram/1:2" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    client.calls.some((call: any) => call.type === "prompt"),
    false,
  );
  compacting = false;
  await waitUntil(
    () => client.calls.some((call: any) => call.type === "prompt"),
    "transport-pending input did not submit after compaction",
  );
  await emitRpcTurnComplete(
    driver,
    "backend-terminal-owner",
    "post-compaction final",
  );

  assert.equal((await pending).finalText, "post-compaction final");
});

test("frontend SDK turn driver waits for standalone compaction before prompting", async () => {
  const client = createFrontendClient();
  let compacting = true;
  client.getState = async () => ({
    sessionFile: "/tmp/frontend-chat.jsonl",
    sessionId: "frontend-session",
    isStreaming: false,
    turnActive: false,
    isCompacting: compacting,
  });
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const resultPromise = driver.runTurn({
    text: "message after compaction",
    promptContext: { source: "chat-bridge", chatKey: "telegram/1:2" },
  });
  setImmediate(() => {
    compacting = false;
  });

  const result = await resultPromise;

  assert.equal(result.finalText, "frontend final");
  const promptCall = client.calls.find((call: any) => call.type === "prompt");
  assert.equal(promptCall.text, "message after compaction");
});

test("frontend SDK turn driver does not relabel untagged progress with mutable turn state", async () => {
  const driver = createDriver();
  const progress: any[] = [];
  driver.subscribe((event: any) => {
    if (event.type === "assistant_interim") progress.push(event);
  });
  (driver as any).backendTurnRequestTag = "replacement-tag";

  await emitDriverEvent(driver, {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "old progress" },
        { type: "toolCall", id: "old-call", name: "read" },
      ],
    },
  });

  assert.deepEqual(progress, [
    {
      type: "assistant_interim",
      text: "old progress",
      requestTag: undefined,
    },
  ]);
});

test("frontend SDK turn driver forwards a completed summary without assistant content", async () => {
  const driver = createDriver();
  const summaries: string[] = [];
  driver.subscribe((event: any) => {
    if (event.type === "assistant_summary") summaries.push(event.text);
  });

  (driver as any).testClient.prompt = async (
    _text: string,
    options: any = {},
  ) => {
    await emitDriverEvent(driver, { type: "agent_start" });
    const partial = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Inspecting current frontend state" },
        { type: "text", text: "Final content" },
      ],
    };
    await emitDriverEvent(driver, {
      type: "message_update",
      message: partial,
      assistantMessageEvent: {
        type: "thinking_end",
        contentIndex: 0,
        content: "Inspecting current frontend state",
        partial,
      },
    });
    await emitRpcTurnComplete(driver, options.requestTag, "Final content");
  };

  const result = await driver.runTurn({ text: "hello" });

  assert.equal(result.finalText, "Final content");
  assert.deepEqual(summaries, ["Inspecting current frontend state"]);
});

test("frontend SDK turn driver does not leak growing final-answer prefixes as interim", async () => {
  const driver = createDriver();
  const interimTexts: string[] = [];
  driver.subscribe((event: any) => {
    if (event.type === "assistant_interim") interimTexts.push(event.text);
  });

  (driver as any).testClient.prompt = async (
    _text: string,
    options: any = {},
  ) => {
    await emitDriverEvent(driver, { type: "agent_start" });
    for (const text of ["I", "I will", "I will check", "I will check this"]) {
      await emitDriverEvent(driver, {
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
        },
      });
    }
    await emitRpcTurnComplete(
      driver,
      options.requestTag,
      "I will check this; here are the results",
    );
  };

  const result = await driver.runTurn({ text: "hello" });

  assert.equal(result.finalText, "I will check this; here are the results");
  assert.deepEqual(interimTexts, []);
});

test("frontend SDK turn driver does not treat a preview as interim when a tool boundary follows", async () => {
  const driver = createDriver();
  const interimTexts: string[] = [];
  driver.subscribe((event: any) => {
    if (event.type === "assistant_interim") interimTexts.push(event.text);
  });

  (driver as any).testClient.prompt = async (
    _text: string,
    options: any = {},
  ) => {
    await emitDriverEvent(driver, { type: "agent_start" });
    await emitDriverEvent(driver, {
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "I will check this" }],
      },
    });
    await emitDriverEvent(driver, {
      type: "tool_execution_start",
      toolName: "read",
    });
    await emitRpcTurnComplete(driver, options.requestTag, "Final answer");
  };

  const result = await driver.runTurn({ text: "hello" });

  assert.equal(result.finalText, "Final answer");
  assert.deepEqual(interimTexts, []);
});

test("frontend SDK turn driver emits leading tool-call text as the only interim source", async () => {
  const driver = createDriver();
  const interimTexts: string[] = [];
  driver.subscribe((event: any) => {
    if (event.type === "assistant_interim") interimTexts.push(event.text);
  });

  (driver as any).testClient.prompt = async (
    _text: string,
    options: any = {},
  ) => {
    await emitDriverEvent(driver, { type: "agent_start" });
    await emitDriverEvent(driver, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "I will check this" },
          { type: "toolCall", name: "read", id: "call-1" },
          { type: "text", text: "not part of the interim" },
        ],
      },
    });
    assert.deepEqual(interimTexts, ["I will check this"]);
    await emitDriverEvent(driver, {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "read",
    });
    assert.deepEqual(interimTexts, ["I will check this"]);
    await emitRpcTurnComplete(driver, options.requestTag, "Final answer");
  };

  const result = await driver.runTurn({ text: "hello" });

  assert.equal(result.finalText, "Final answer");
  assert.deepEqual(interimTexts, ["I will check this"]);
});

test("frontend SDK turn driver waits for real final after interim and compaction events", async () => {
  const driver = createDriver();
  const interimTexts: string[] = [];
  driver.subscribe((event: any) => {
    if (event.type === "assistant_interim") interimTexts.push(event.text);
  });

  (driver as any).testClient.prompt = async (
    _text: string,
    options: any = {},
  ) => {
    await emitDriverEvent(driver, { type: "agent_start" });
    await emitDriverEvent(driver, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "interim before compaction" },
          { type: "toolCall", name: "todo", id: "call-1" },
        ],
      },
    });
    await emitDriverEvent(driver, { type: "agent_end" });
    await emitDriverEvent(driver, { type: "compaction_start" });
    await emitDriverEvent(driver, { type: "compaction_end" });
    setTimeout(() => {
      void (async () => {
        await emitDriverEvent(driver, { type: "agent_start" });
        await emitDriverEvent(driver, {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "real final after compaction" }],
          },
        });
        await emitDriverEvent(driver, { type: "agent_end" });
        await emitRpcTurnComplete(
          driver,
          options.requestTag,
          "real final after compaction",
        );
      })();
    }, 5);
  };

  const result = await driver.runTurn({ text: "hello" });

  assert.equal(result.finalText, "real final after compaction");
  assert.deepEqual(interimTexts, ["interim before compaction"]);
});

test("frontend SDK turn driver starts managed leaf sessions even after connect reports a default session", async () => {
  const driver = createDriver();
  const calls: string[] = [];
  const newSessionOptions: any[] = [];
  const client = (driver as any).testClient;
  let sessionFile = "/tmp/root-session.jsonl";
  client.getState = async () => ({
    sessionFile,
    sessionId: "session-driver",
    isStreaming: false,
  });
  client.newSession = async (options: any = {}) => {
    newSessionOptions.push(options);
    calls.push(
      `newSession:${options.managedSessionLeaf}:${JSON.stringify(options.frontendIdentity)}`,
    );
    sessionFile = "/tmp/rin/sessions/managed/task/created.jsonl";
    return { cancelled: false, sessionFile, sessionId: "session-driver" };
  };
  client.prompt = async (_text: string, options: any = {}) => {
    calls.push("prompt");
    await emitRpcTurnComplete(
      driver,
      options.requestTag,
      "done",
      sessionFile,
      "session-driver",
    );
  };

  const result = await driver.runTurn({
    text: "hello",
    managedSessionLeaf: "task",
  });

  assert.equal(result.finalText, "done");
  assert.deepEqual(calls, ['newSession:task:{"kind":"chat-bridge"}', "prompt"]);
  assert.equal(newSessionOptions[0].resourceOptions, undefined);
  assert.equal(
    result.sessionFile,
    "/tmp/rin/sessions/managed/task/created.jsonl",
  );
});

test("frontend SDK turn driver forwards disabled Rin capabilities to managed sessions", async () => {
  const driver = createDriver();
  const client = (driver as any).testClient;
  let sessionFile = "/tmp/root-session.jsonl";
  let newSessionOptions: any = undefined;
  client.getState = async () => ({
    sessionFile,
    sessionId: "session-driver",
    isStreaming: false,
  });
  client.newSession = async (options: any = {}) => {
    newSessionOptions = options;
    sessionFile = "/tmp/rin/sessions/managed/task/created.jsonl";
    return { cancelled: false, sessionFile, sessionId: "session-driver" };
  };
  client.prompt = async (_text: string, options: any = {}) => {
    await emitRpcTurnComplete(
      driver,
      options.requestTag,
      "done",
      sessionFile,
      "session-driver",
    );
  };

  await driver.runTurn({
    text: "hello",
    managedSessionLeaf: "task",
    disabledRinCapabilities: ["self_improve"],
  });

  assert.deepEqual(newSessionOptions.resourceOptions, {
    disabledRinCapabilities: ["self_improve"],
  });
});

test("frontend SDK turn driver asks the daemon to replay pending terminal events after joining a submitted turn", async () => {
  const client = createFrontendClient();
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  let replayCalls = 0;
  let liveTurnCreatedBeforeReplay = false;
  client.request = async (command: any) => {
    client.calls.push({ type: "request", command });
    if (command.type === "get_state") {
      return {
        sessionFile: "/tmp/frontend-chat.jsonl",
        sessionId: "frontend-session",
        isStreaming: true,
        turnActive: true,
      };
    }
    if (command.type === "resolve_submitted_turn") return { submitted: true };
    if (command.type === "replay_pending_terminal_turn_event") {
      replayCalls += 1;
      liveTurnCreatedBeforeReplay = Boolean((driver as any).liveTurn);
      await emitDriverEvent(driver as any, {
        type: "rpc_turn_event",
        event: "complete",
        finalText: "replayed pending final",
        result: {
          messages: [{ type: "text", text: "replayed pending final" }],
        },
        sessionId: "frontend-session",
        sessionFile: "/tmp/frontend-chat.jsonl",
      });
      return { replayed: true };
    }
    return {};
  };
  client.prompt = async () => {
    throw new Error("prompt should not be resubmitted");
  };

  const result = await driver.runTurn({
    text: "hello",
    promptContext: { sentAt: Date.now() },
  });

  assert.equal(result.finalText, "replayed pending final");
  assert.equal(replayCalls, 1);
  assert.equal(liveTurnCreatedBeforeReplay, true);
});

test("frontend SDK waits for the native terminal after backend rejoin admission", async () => {
  const client = createFrontendClient();
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  const sessionFile = "/tmp/frontend-restored-active.jsonl";
  const requestTag = "chat-inbox-stable";
  client.getState = async () => ({
    sessionFile,
    sessionId: "frontend-session",
    isStreaming: true,
    turnActive: true,
  });
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    return { acceptedAs: "rejoin", requestTag: options.requestTag };
  };

  const pending = driver.runTurn({
    text: "restored active job",
    requestTag,
    restoreSessionFile: sessionFile,
    promptContext: {
      source: "chat-bridge",
      chatKey: "telegram/1:2",
      sentAt: 1778774580000,
    },
  });
  await waitUntil(
    () => client.calls.some((call: any) => call.type === "prompt"),
    "rejoin submission did not reach backend",
  );
  await emitRpcTurnComplete(
    driver,
    requestTag,
    "restored active final",
    sessionFile,
    "frontend-session",
  );

  const result = await pending;
  assert.equal(result.finalText, "restored active final");
  assert.deepEqual(
    client.calls
      .filter((call: any) => call.type === "prompt")
      .map((call: any) => call.options.requestTag),
    [requestTag],
  );
});
test("frontend SDK turn driver follows active turn across transient reconnect before rpc final", async () => {
  const client = createFrontendClient();
  let getStateCount = 0;
  client.getState = async () => {
    getStateCount += 1;
    if (getStateCount === 2) throw new Error("rin_disconnected:daemon_restart");
    return {
      sessionFile: "/tmp/frontend-chat.jsonl",
      sessionId: "frontend-session",
      isStreaming: true,
      turnActive: true,
    };
  };
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    return { acceptedAs: "prompt" };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const resultPromise = driver.runTurn({ text: "follow existing turn" });
  await new Promise((resolve) => setImmediate(resolve));
  await emitDriverEvent(driver as any, {
    type: "rpc_turn_event",
    event: "complete",
    requestTag: "",
    finalText: "final after reconnect",
    result: { messages: [{ type: "text", text: "final after reconnect" }] },
    sessionId: "frontend-session",
    sessionFile: "/tmp/frontend-chat.jsonl",
  });

  const result = await resultPromise;
  assert.equal(result.finalText, "final after reconnect");
  assert.equal(getStateCount >= 3, true);
});

test("frontend SDK turn driver does not infer empty completion from inactive state before a late rpc final", async () => {
  const client = createFrontendClient();
  client.getState = async () => ({
    sessionFile: "/tmp/frontend-late-final.jsonl",
    sessionId: "frontend-late-final",
    isStreaming: false,
    turnActive: false,
  });
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  await driver.connect();

  const resultPromise = (driver as any).followActiveTurn(
    {
      sessionFile: "/tmp/frontend-late-final.jsonl",
      sessionId: "frontend-late-final",
    },
    "late-final-tag",
  );
  setTimeout(() => {
    void emitRpcTurnComplete(
      driver,
      "late-final-tag",
      "canonical late final",
      "/tmp/frontend-late-final.jsonl",
      "frontend-late-final",
    );
  }, 1_100);

  const result = await withTimeout(
    resultPromise,
    2_000,
    "turn resolved before receiving its canonical terminal event",
  );
  assert.equal(result.finalText, "canonical late final");
});

test("frontend SDK turn driver does not complete from agent_end before rpc final", async () => {
  const driver = createDriver();
  const client = (driver as any).testClient;
  client.getMessages = async () => [
    { role: "user", content: "old prompt" },
    { role: "assistant", content: "old final" },
  ];
  client.prompt = async (_text: string, options: any = {}) => {
    await emitDriverEvent(driver, { type: "agent_start" });
    await emitDriverEvent(driver, { type: "agent_end" });
    await emitRpcTurnComplete(driver, options.requestTag, "rpc final");
  };

  const result = await driver.runTurn({ text: "hello" });

  assert.equal(result.finalText, "rpc final");
});

test("frontend SDK turn driver accepts an empty rpc completion without scanning session history", async () => {
  const driver = createDriver();
  const client = (driver as any).testClient;
  client.getMessages = async () => [
    { role: "user", content: "hello" },
    { role: "assistant", content: "session text must not be a fallback" },
  ];
  client.prompt = async (_text: string, options: any = {}) => {
    await emitDriverEvent(driver, { type: "agent_start" });
    await emitRpcTurnComplete(driver, options.requestTag, "");
  };

  const result = await driver.runTurn({ text: "hello" });
  assert.equal(result.finalText, "");
});

test("frontend SDK turn driver does not emit text-only assistant messages as interim", async () => {
  const driver = createDriver();
  const interimTexts: string[] = [];
  driver.subscribe((event: any) => {
    if (event.type === "assistant_interim") interimTexts.push(event.text);
  });

  (driver as any).testClient.prompt = async (
    _text: string,
    options: any = {},
  ) => {
    await emitDriverEvent(driver, { type: "agent_start" });
    await emitDriverEvent(driver, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "I will check this" }],
      },
    });
    await emitRpcTurnComplete(driver, options.requestTag, "Final answer");
  };

  const result = await driver.runTurn({ text: "hello" });

  assert.equal(result.finalText, "Final answer");
  assert.deepEqual(interimTexts, []);
});

test("frontend SDK keeps the ordinary terminal waiter open across failed assistant messages", async () => {
  const driver = createDriver();
  const client = (driver as any).testClient;
  let releasePrompt!: () => void;
  let requestTag = "";
  const promptGate = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  client.prompt = async (_text: string, options: any = {}) => {
    requestTag = options.requestTag;
    await emitDriverEvent(driver, { type: "agent_start" });
    await emitDriverEvent(driver, {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage:
          'Codex error: {"error":{"code":"context_length_exceeded"}}',
        content: [
          {
            type: "text",
            text: 'Codex error: {"error":{"code":"context_length_exceeded"}}',
          },
        ],
      },
    });
    await promptGate;
  };

  const resultPromise = driver.runTurn({ text: "hello" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(driver.hasActiveTurn(), true);

  await emitRpcTurnComplete(driver, requestTag, "continued after compaction");
  releasePrompt();
  const result = await resultPromise;

  assert.equal(result.finalText, "continued after compaction");
});

test("frontend SDK turn driver completes Pi-native overflow recovery", async () => {
  const driver = createDriver();
  const client = (driver as any).testClient;
  client.prompt = async (_text: string, options: any = {}) => {
    await emitDriverEvent(driver, { type: "agent_start" });
    await emitDriverEvent(driver, {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage:
          'Codex error: {"error":{"code":"context_length_exceeded"}}',
        content: [
          {
            type: "text",
            text: 'Codex error: {"error":{"code":"context_length_exceeded"}}',
          },
        ],
      },
    });
    await emitDriverEvent(driver, { type: "agent_end" });
    await emitDriverEvent(driver, {
      type: "compaction_start",
      reason: "overflow",
    });
    await emitDriverEvent(driver, {
      type: "compaction_end",
      reason: "overflow",
      aborted: false,
      willRetry: true,
      result: { summary: "compacted" },
    });
    await emitDriverEvent(driver, { type: "agent_start" });
    await emitDriverEvent(driver, {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "continued after compaction" }],
      },
    });
    await emitDriverEvent(driver, { type: "agent_end" });
    await emitRpcTurnComplete(
      driver,
      options.requestTag,
      "continued after compaction",
    );
  };

  const result = await driver.runTurn({ text: "hello" });

  assert.equal(result.finalText, "continued after compaction");
});

test("frontend SDK turn driver waits for an already submitted restored prompt instead of resubmitting", async () => {
  const client = createFrontendClient();
  let getMessagesCount = 0;
  client.getMessages = async () => {
    getMessagesCount += 1;
    const messages = [{ role: "user", timestamp: 1001, content: "hello" }];
    if (getMessagesCount >= 2) {
      messages.push({
        role: "assistant",
        timestamp: 1002,
        content: "restored final",
      });
    }
    return messages;
  };
  client.prompt = async () => {
    throw new Error("prompt_should_not_be_resubmitted");
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const result = await driver.runTurn({
    text: "hello",
    promptContext: { sentAt: 1000 },
  });

  assert.equal(result.finalText, "restored final");
  assert.equal(result.sessionFile, "/tmp/frontend-chat.jsonl");
  assert.equal(
    client.calls.some((call: any) => call.type === "prompt"),
    false,
  );
  assert.equal(getMessagesCount, 2);
});

test(
  "frontend SDK turn driver keeps waiting for restored prompts while the session is active",
  { concurrency: false },
  async () => {
    const originalNow = Date.now;
    let now = 0;
    (Date as any).now = () => now;

    try {
      const client = createFrontendClient();
      let getMessagesCount = 0;
      client.getState = async () => ({
        sessionFile: "/tmp/frontend-chat.jsonl",
        sessionId: "frontend-session",
        isStreaming: getMessagesCount >= 2 && getMessagesCount < 3,
        turnActive: getMessagesCount >= 2 && getMessagesCount < 3,
      });
      client.getMessages = async () => {
        getMessagesCount += 1;
        now += 121_000;
        const messages = [
          { role: "user", timestamp: 1001, content: "long restored job" },
        ];
        if (getMessagesCount >= 3) {
          messages.push({
            role: "assistant",
            timestamp: now,
            content: "long restored final",
          });
        }
        return messages;
      };
      client.prompt = async () => {
        throw new Error("prompt_should_not_be_resubmitted");
      };
      const driver = new RinFrontendTurnDriver({
        clientFactory: () => client,
        promptSource: "chat-bridge",
      });

      const result = await driver.runTurn({
        text: "long restored job",
        promptContext: { sentAt: 1000 },
      });

      assert.equal(result.finalText, "long restored final");
      assert.equal(
        client.calls.some((call: any) => call.type === "prompt"),
        false,
      );
      assert.equal(getMessagesCount, 3);
    } finally {
      (Date as any).now = originalNow;
    }
  },
);

test(
  "frontend SDK turn driver recovers disconnected prompt errors through daemon terminal replay",
  { concurrency: false },
  async () => {
    const client = createFrontendClient();
    const originalConnect = client.connect;
    let connectCount = 0;
    client.connect = async () => {
      connectCount += 1;
      await originalConnect.call(client);
    };
    client.getState = async () => ({
      sessionFile: "/tmp/frontend-chat.jsonl",
      sessionId: "frontend-session",
      isStreaming: false,
      turnActive: false,
    });
    let submittedRequestTag = "";
    client.prompt = async (text: string, options: any = {}) => {
      client.calls.push({ type: "prompt", text, options });
      submittedRequestTag = options.requestTag;
      await client.disconnect();
      throw new Error("rin_disconnected:req_1");
    };
    const driver = new RinFrontendTurnDriver({
      clientFactory: () => client,
      promptSource: "chat-bridge",
    });
    client.request = async (command: any) => {
      client.calls.push({ type: "request", command });
      if (command.type === "get_state") return await client.getState();
      if (command.type === "replay_pending_terminal_turn_event") {
        await emitDriverEvent(driver as any, {
          type: "rpc_turn_event",
          event: "complete",
          requestTag: submittedRequestTag,
          finalText: "recovered by daemon replay",
          result: {
            messages: [{ type: "text", text: "recovered by daemon replay" }],
          },
          sessionId: "frontend-session",
          sessionFile: "/tmp/frontend-chat.jsonl",
        });
        return { replayed: true };
      }
      return {};
    };

    const result = await driver.runTurn({ text: "hello" });

    assert.equal(result.finalText, "recovered by daemon replay");
    assert.equal(connectCount, 2);
    assert.equal(
      client.calls.filter((call: any) => call.type === "prompt").length,
      1,
    );
    assert.equal(
      client.calls.some(
        (call: any) =>
          call.type === "request" &&
          call.command.type === "replay_pending_terminal_turn_event",
      ),
      true,
    );
    assert.equal(
      client.calls.some(
        (call: any) =>
          call.type === "request" &&
          call.command.type === "resolve_submitted_turn",
      ),
      false,
    );
  },
);

test("frontend SDK turn driver does not reuse an older final when the current turn has no final yet", async () => {
  const client = createFrontendClient();
  const oldFinal = "previous turn final";
  client.getMessages = async () => [
    {
      role: "user",
      content: "previous prompt",
      timestamp: "2026-05-21T09:13:37.706Z",
    },
    {
      role: "assistant",
      content: oldFinal,
      timestamp: "2026-05-21T09:19:54.183Z",
    },
    {
      role: "user",
      content: "new prompt",
      timestamp: "2026-05-21T14:29:04.389Z",
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", text: "working" },
        { type: "tool-call", name: "bash" },
      ],
      timestamp: "2026-05-21T14:33:34.199Z",
    },
  ];
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    await emitDriverEvent(driver as any, {
      type: "rpc_turn_event",
      event: "complete",
      requestTag: options.requestTag,
      finalText: "",
      result: { messages: [] },
      sessionId: "frontend-session",
      sessionFile: "/tmp/frontend-chat.jsonl",
    });
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const result = await driver.runTurn({ text: "new prompt" });
  assert.equal(result.finalText, "");
  assert.deepEqual(result.result, { messages: [] });
  assert.notEqual(result.finalText, oldFinal);
});

test("frontend SDK turn driver does not recover interrupted prompt errors from session state", async () => {
  const originalNow = Date.now;
  let now = 0;
  (Date as any).now = () => now;

  try {
    const client = createFrontendClient();
    const originalConnect = client.connect;
    let connectCount = 0;
    client.connect = async () => {
      connectCount += 1;
      await originalConnect.call(client);
    };
    let promptAttempted = false;
    client.getState = async () => {
      if (promptAttempted) now += 121_000;
      return {
        sessionFile: "/tmp/frontend-chat.jsonl",
        sessionId: "frontend-session",
        isStreaming: false,
      };
    };
    client.getMessages = async () =>
      promptAttempted
        ? [
            { role: "user", content: "hello" },
            { role: "assistant", content: "recovered final" },
          ]
        : [{ role: "user", content: "hello" }];
    client.prompt = async (text: string, options: any = {}) => {
      client.calls.push({ type: "prompt", text, options });
      promptAttempted = true;
      await client.disconnect();
      throw new Error("rin_disconnected:req_1");
    };
    const driver = new RinFrontendTurnDriver({
      clientFactory: () => client,
      promptSource: "chat-bridge",
    });

    await assert.rejects(
      () => driver.runTurn({ text: "hello" }),
      /frontend_turn_recovery_failed/,
    );
    assert.equal(connectCount, 2);
    assert.equal(
      client.calls.filter((call: any) => call.type === "prompt").length,
      1,
    );
    assert.ok(
      client.calls
        .filter((call: any) => call.type === "request")
        .every(
          (call: any) =>
            !["get_state", "get_messages", "resolve_submitted_turn"].includes(
              call.command.type,
            ) || call.command.sessionFile === "/tmp/frontend-chat.jsonl",
        ),
    );
  } finally {
    (Date as any).now = originalNow;
  }
});
