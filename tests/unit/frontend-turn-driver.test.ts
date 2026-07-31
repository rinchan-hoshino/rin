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
          ...(options.chatDeliveryContext
            ? {
                chatDeliveryContext: options.chatDeliveryContext,
                terminalRecord: {
                  terminalId: `terminal-${"a".repeat(64)}`,
                  state: "complete",
                  terminalAt: "2026-07-29T12:57:18.000Z",
                },
              }
            : {}),
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

test("failed terminal projection remains replayable until listeners commit it", async () => {
  const client = createFrontendClient();
  const failures: any[] = [];
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
    onEventHandlingError: (failure: any) => failures.push(failure),
  });
  let attempts = 0;
  driver.subscribe((event: any) => {
    if (event.type !== "turn_complete") return;
    attempts += 1;
    if (attempts === 1) throw new Error("terminal projection failed once");
  });
  const terminal = {
    type: "rpc_turn_event",
    event: "complete",
    requestTag: "replayable-terminal",
    finalText: "durable final",
    sessionId: "frontend-session",
    sessionFile: "/tmp/frontend-chat.jsonl",
    terminalRecord: {
      terminalId: `terminal-${"b".repeat(64)}`,
      state: "complete",
      terminalAt: "2026-07-31T04:00:00.000Z",
    },
  };

  await driver.connect();
  await emitDriverEvent(driver, terminal);
  await emitDriverEvent(driver, terminal);
  await emitDriverEvent(driver, terminal);

  assert.equal(attempts, 2);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].stage, "terminal_listener");
});

test("terminal projection retries only listeners that have not committed", async () => {
  const client = createFrontendClient();
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
    onEventHandlingError() {},
  });
  let committedCalls = 0;
  let retryingCalls = 0;
  driver.subscribe((event: any) => {
    if (event.type === "turn_complete") committedCalls += 1;
  });
  driver.subscribe((event: any) => {
    if (event.type !== "turn_complete") return;
    retryingCalls += 1;
    if (retryingCalls === 1) throw new Error("retry this listener only");
  });

  await driver.connect();
  await emitDriverEvent(driver, {
    type: "rpc_turn_event",
    event: "complete",
    requestTag: "listener-commit-boundary",
    finalText: "durable final",
    sessionId: "frontend-session",
    sessionFile: "/tmp/frontend-chat.jsonl",
    terminalRecord: {
      terminalId: `terminal-${"f".repeat(64)}`,
      state: "complete",
      terminalAt: "2026-07-31T04:00:00.000Z",
    },
  });

  assert.equal(committedCalls, 1);
  assert.equal(retryingCalls, 2);
});

test("terminal projection requires the daemon requestTag", async () => {
  const client = createFrontendClient();
  const failures: any[] = [];
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
    onEventHandlingError: (failure: any) => failures.push(failure),
  });
  let projected = 0;
  driver.subscribe((event: any) => {
    if (event.type === "turn_complete") projected += 1;
  });
  const terminalRecord = {
    terminalId: `terminal-${"9".repeat(64)}`,
    state: "complete",
    terminalAt: "2026-07-31T04:00:00.000Z",
  };
  const base = {
    type: "rpc_turn_event",
    event: "complete",
    finalText: "durable final",
    sessionId: "frontend-session",
    sessionFile: "/tmp/frontend-chat.jsonl",
    terminalRecord,
  };

  await driver.connect();
  await emitDriverEvent(driver, base);
  await emitDriverEvent(driver, {
    ...base,
    requestTag: "full-terminal-request",
  });

  assert.equal(projected, 1);
  assert.equal(failures.length, 1);
  assert.match(String(failures[0].error), /rin_terminal_request_tag_missing/);
});

test("concurrent replay of one requestTag shares one projection task", async () => {
  const client = createFrontendClient();
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  let projected = 0;
  let releaseProjection!: () => void;
  let projectionStarted!: () => void;
  const projectionGate = new Promise<void>((resolve) => {
    releaseProjection = resolve;
  });
  const started = new Promise<void>((resolve) => {
    projectionStarted = resolve;
  });
  driver.subscribe(async (event: any) => {
    if (event.type !== "turn_complete") return;
    projected += 1;
    projectionStarted();
    await projectionGate;
  });
  const terminalRecord = {
    terminalId: `terminal-${"8".repeat(64)}`,
    state: "complete",
    terminalAt: "2026-07-31T04:00:00.000Z",
  };
  const base = {
    type: "rpc_turn_event",
    event: "complete",
    finalText: "durable final",
    sessionId: "frontend-session",
    sessionFile: "/tmp/frontend-chat.jsonl",
  };

  await driver.connect();
  const terminal = {
    ...base,
    requestTag: "concurrent-terminal-request",
    terminalRecord,
  };
  const first = emitDriverEvent(driver, terminal);
  await started;
  const second = emitDriverEvent(driver, terminal);
  const third = emitDriverEvent(driver, terminal);
  releaseProjection();
  await Promise.all([first, second, third]);

  assert.equal(projected, 1);
});

test("terminal identity never borrows an unrelated live requestTag", async () => {
  const client = createFrontendClient();
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  let resolved = 0;
  (driver as any).liveTurn = {
    requestTag: "current-live-request",
    resolve() {
      resolved += 1;
    },
  };

  await driver.connect();
  await emitDriverEvent(driver, {
    type: "rpc_turn_event",
    event: "complete",
    requestTag: "older-durable-request",
    finalText: "older durable terminal",
    sessionId: "frontend-session",
    sessionFile: "/tmp/frontend-chat.jsonl",
    terminalRecord: {
      terminalId: `terminal-${"a".repeat(64)}`,
      state: "complete",
      terminalAt: "2026-07-31T04:00:00.000Z",
    },
  });

  assert.equal(resolved, 0);
});

test("frontend terminal identity ignores replacement-worker generation reuse", async () => {
  const client = createFrontendClient();
  const projected: string[] = [];
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  driver.subscribe((event: any) => {
    if (event.type === "turn_complete") {
      projected.push(event.requestTag);
    }
  });
  const terminal = (requestTag: string, terminalId: string) => ({
    type: "rpc_turn_event",
    event: "complete",
    requestTag,
    turnGeneration: 1,
    finalText: requestTag,
    sessionId: "frontend-session",
    sessionFile: "/tmp/frontend-chat.jsonl",
    terminalRecord: {
      terminalId,
      state: "complete",
      terminalAt: "2026-07-31T04:00:00.000Z",
    },
  });
  const recovered = terminal(
    "chat-inbox-recovered",
    `terminal-${"c".repeat(64)}`,
  );
  const current = terminal("chat-inbox-current", `terminal-${"d".repeat(64)}`);

  await driver.connect();
  await emitDriverEvent(driver, recovered);
  await emitDriverEvent(driver, current);
  await emitDriverEvent(driver, { ...current, turnGeneration: 2 });

  assert.deepEqual(projected, ["chat-inbox-recovered", "chat-inbox-current"]);
});

test("frontend turn driver propagates canonical run identity through terminal projection", async () => {
  const driver = createDriver() as any;
  const seen: any[] = [];
  driver.subscribe((event: any) => seen.push(event));
  const chatDeliveryContext = {
    turnId: "turn-protocol",
    chatKey: "discord/1:2",
    messageId: "message-protocol",
  };
  const result = await driver.runTurn({
    text: "canonical prompt",
    requestTag: "request-protocol",
    chatDeliveryContext,
  });
  const promptCall = driver.testClient.calls.find(
    (call) => call.type === "prompt",
  );
  assert.deepEqual(promptCall.options.chatDeliveryContext, chatDeliveryContext);
  assert.equal(result.finalText, "frontend final");
  assert.equal(
    seen.find((event) => event.type === "turn_complete")?.terminalRecord
      ?.terminalAt,
    "2026-07-29T12:57:18.000Z",
  );
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

test("frontend SDK turn driver settles from daemon terminal wait when the pushed terminal is missed", async () => {
  const client = createFrontendClient();
  const originalRequest = client.request.bind(client);
  let resolveTerminalWait: ((value: any) => void) | undefined;
  let terminalRequestTag = "";
  client.request = async (command: any) => {
    if (command.type !== "await_turn_terminal") {
      return await originalRequest(command);
    }
    terminalRequestTag = String(command.requestTag || "");
    return await new Promise((resolve) => {
      resolveTerminalWait = resolve;
    });
  };
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const turn = driver.runTurn({
    text: "wait durably",
    managedSessionLeaf: "telegram/1:2",
  });
  await waitUntil(
    () => Boolean(resolveTerminalWait && terminalRequestTag),
    "terminal wait was not registered before completion",
  );
  resolveTerminalWait!({
    type: "rpc_turn_event",
    event: "complete",
    requestTag: terminalRequestTag,
    finalText: "waited final",
    sessionId: "frontend-session",
    sessionFile: "/tmp/frontend-managed.jsonl",
  });

  const result = await withTimeout(
    turn,
    1000,
    "daemon terminal wait did not settle the turn",
  );
  assert.equal(result.finalText, "waited final");
});

test("frontend SDK turn driver follows daemon terminal after its worker request exits", async () => {
  const client = createFrontendClient();
  const originalRequest = client.request.bind(client);
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    throw new Error("rin_worker_exit");
  };
  client.request = async (command: any) => {
    if (command.type !== "await_turn_terminal") {
      return await originalRequest(command);
    }
    return {
      type: "rpc_turn_event",
      event: "complete",
      requestTag: command.requestTag,
      finalText: "replacement worker final",
      sessionId: "frontend-session",
      sessionFile: "/tmp/frontend-managed.jsonl",
      terminalRecord: {
        terminalId: `terminal-${"e".repeat(64)}`,
        state: "complete",
        terminalAt: "2026-07-31T04:00:00.000Z",
      },
    };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const result = await driver.runTurn({
    text: "survive worker exit",
    managedSessionLeaf: "telegram/1:2",
    requestTag: "worker-exit-ledger-owned",
  });

  assert.equal(result.finalText, "replacement worker final");
  assert.equal(
    client.calls.filter((call: any) => call.type === "prompt").length,
    1,
  );
});

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

test("frontend SDK ignores a stale terminal request tag while the current turn is live", async () => {
  const driver = createDriver();
  const client = (driver as any).testClient;
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    return { acceptedAs: "prompt", requestTag: options.requestTag };
  };

  const pending = driver.runTurn({
    text: "current turn",
    requestTag: "current-request-tag",
  });
  await waitUntil(
    () => Boolean((driver as any).liveTurn),
    "current live turn did not start",
  );
  await emitRpcTurnComplete(driver, "stale-request-tag", "stale final");
  assert.ok(
    (driver as any).liveTurn,
    "stale terminal settled the current turn",
  );

  await emitRpcTurnComplete(driver, "current-request-tag", "current final");
  assert.equal((await pending).finalText, "current final");
});

test("frontend SDK treats active-state input as an ordinary submission and waits for Pi terminal", async () => {
  const client = createFrontendClient();
  client.getState = async () => ({
    sessionFile: "/tmp/frontend-chat.jsonl",
    sessionId: "frontend-session",
    isStreaming: true,
    turnActive: true,
    requestTag: "backend-terminal-owner",
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

  const result = await withTimeout(
    pending,
    250,
    "backend-owned terminal did not settle the active frontend turn",
  );
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
    requestTag: "backend-terminal-owner",
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
    requestTag: "backend-terminal-owner",
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
      requestTag: "backend-reconnect-request",
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
    requestTag: "backend-reconnect-request",
    finalText: "final after reconnect",
    result: { messages: [{ type: "text", text: "final after reconnect" }] },
    sessionId: "frontend-session",
    sessionFile: "/tmp/frontend-chat.jsonl",
  });

  const result = await resultPromise;
  assert.equal(result.finalText, "final after reconnect");
  assert.equal(getStateCount >= 3, true);
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

test("frontend replays one durable terminal record and acknowledges it explicitly", async () => {
  const driver: any = createDriver();
  const seen: any[] = [];
  driver.subscribe((event: any) => seen.push(event));
  await driver.connect();
  const client = driver.testClient;
  const originalRequest = client.request.bind(client);
  client.request = async (command: any) => {
    if (command.type === "list_unacknowledged_chat_terminals") {
      return {
        terminals: [
          {
            type: "rpc_turn_event",
            event: "complete",
            requestTag: "replayed-request",
            sessionFile: "/tmp/frontend-chat.jsonl",
            sessionId: "frontend-session",
            finalText: "replayed final",
            chatDeliveryContext: {
              turnId: "transport-turn-replayed",
              chatKey: "discord/1:2",
              messageId: "message-replayed",
            },
            terminalRecord: {
              terminalId: `terminal-${"b".repeat(64)}`,
              state: "complete",
              terminalAt: "2026-07-30T09:00:00.000Z",
            },
          },
        ],
      };
    }
    return await originalRequest(command);
  };

  assert.equal(
    await driver.recoverUnacknowledgedChatTerminals("discord/1:2"),
    1,
  );
  const terminal = seen.find((event) => event.type === "turn_complete");
  assert.equal(terminal?.finalText, "replayed final");
  assert.equal(terminal?.terminalRecord?.state, "complete");

  await driver.acknowledgeTerminal(
    "replayed-request",
    `terminal-${"b".repeat(64)}`,
  );
  assert.equal(
    client.calls.some(
      (call: any) =>
        call.type === "request" &&
        call.command.type === "ack_turn_terminal" &&
        call.command.requestTag === "replayed-request",
    ),
    true,
  );
});

test("terminal reconnect stops on permanent ledger failure instead of retrying forever", async () => {
  const driver: any = createDriver();
  await driver.connect();
  const liveTurn = driver.startLiveTurn("missing-ledger-request");
  driver.liveTurnRecoveryContext = { sessionFile: "/tmp/missing-ledger.jsonl" };
  driver.testClient.request = async () => {
    throw new Error("rin_turn_ledger_record_missing");
  };

  await driver.interruptLiveTurnAfterDisconnect();
  await assert.rejects(liveTurn.promise, /frontend_turn_interrupted/);
  assert.equal(driver.liveTurn, null);
  assert.equal(driver.disconnectedTurnRecovery, null);
});
