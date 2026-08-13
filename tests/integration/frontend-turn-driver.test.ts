import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
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
  (driver.testClient || driver.client)?.rememberTerminal?.(payload);
  await driver.handleClientEvent({ type: "ui", payload });
}

function createFrontendClient() {
  const calls: any[] = [];
  let listener: any = null;
  let connected = false;
  let sessionFile = "/tmp/frontend-chat.jsonl";
  let activeTools = ["read", "bash", "edit", "write", "browse"];
  const terminals = new Map<string, any>();
  const terminalWaiters = new Map<string, Array<(terminal: any) => void>>();
  const rememberTerminal = (payload: any) => {
    if (
      payload?.type !== "rpc_turn_event" ||
      (payload.event !== "complete" && payload.event !== "error") ||
      !payload.requestTag
    ) {
      return;
    }
    terminals.set(payload.requestTag, payload);
    for (const resolve of terminalWaiters.get(payload.requestTag) || []) {
      resolve(payload);
    }
    terminalWaiters.delete(payload.requestTag);
  };
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
    rememberTerminal,
    async emit(event: any) {
      rememberTerminal(event?.payload);
      await listener?.(event);
    },
    async getState() {
      return { sessionFile, sessionId: "frontend-session", isStreaming: false };
    },
    async prompt(text: string, options: any = {}) {
      calls.push({ type: "prompt", text, options });
      await this.emit({
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
      return { outcome: "terminalOwner", requestTag: options.requestTag };
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
      if (command.type === "await_turn_terminal") {
        const requestTag = String(command.requestTag || "");
        if (terminals.has(requestTag)) return terminals.get(requestTag);
        return await new Promise((resolve) => {
          const waiters = terminalWaiters.get(requestTag) || [];
          waiters.push(resolve);
          terminalWaiters.set(requestTag, waiters);
        });
      }
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

test("frontend driver reports a prompt that entered the backend queue", async () => {
  const client = createFrontendClient();
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    return { outcome: "terminalOwner", queued: true };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  const seen: any[] = [];
  driver.subscribe((event: any) => seen.push(event));
  await driver.connect();

  const turn = driver.runTurn({ text: "wait for me", requestTag: "queued-1" });
  await new Promise((resolve) => setImmediate(resolve));
  await client.emit({
    type: "ui",
    payload: {
      type: "rpc_turn_event",
      event: "complete",
      requestTag: "queued-1",
      finalText: "done",
      sessionId: "frontend-session",
      sessionFile: "/tmp/frontend-chat.jsonl",
    },
  });
  await turn;

  assert.equal(
    seen.some(
      (event) =>
        event.type === "turn_waiting" && event.requestTag === "queued-1",
    ),
    true,
  );
});

test("frontend driver ignores a late queued admission after this request started", async () => {
  const client = createFrontendClient();
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    await client.emit({
      type: "ui",
      payload: {
        type: "message_start",
        requestTag: options.requestTag,
        message: { role: "user", content: text },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    return { outcome: "terminalOwner", queued: true };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  const seen: any[] = [];
  driver.subscribe((event: any) => seen.push(event));
  await driver.connect();

  const turn = driver.runTurn({
    text: "already starting",
    requestTag: "queued-2",
  });
  await new Promise((resolve) => setImmediate(resolve));
  await client.emit({
    type: "ui",
    payload: {
      type: "rpc_turn_event",
      event: "complete",
      requestTag: "queued-2",
      finalText: "done",
      sessionId: "frontend-session",
      sessionFile: "/tmp/frontend-chat.jsonl",
    },
  });
  await turn;

  assert.equal(
    seen.some((event) => event.type === "turn_waiting"),
    false,
  );
});

test("frontend driver reports when the backend queue becomes idle", async () => {
  const client = createFrontendClient();
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  const seen: any[] = [];
  driver.subscribe((event: any) => seen.push(event));
  await driver.connect();

  await client.emit({
    type: "ui",
    payload: {
      type: "queue_update",
      steering: [],
      followUp: [],
    },
  });

  assert.equal(
    seen.some((event) => event.type === "queue_idle"),
    true,
  );
});

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
    payload: { type: "agent_start", working: true },
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

test("terminal listener failure rejects the exact local turn without an internal retry loop", async () => {
  const client = createFrontendClient();
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
    onEventHandlingError() {},
  });
  let attempts = 0;
  driver.subscribe((event: any) => {
    if (event.type !== "turn_complete") return;
    attempts += 1;
    throw new Error("permanent terminal projection failure");
  });
  await driver.connect();
  const requestTag = "bounded-terminal-projection-failure";
  const liveTurn = (driver as any).startLiveTurn(requestTag);
  const handling = driver.handleClientEvent({
    type: "rpc_turn_event",
    event: "complete",
    requestTag,
    finalText: "durable but not projected",
    sessionId: "frontend-session",
    sessionFile: "/tmp/frontend-chat.jsonl",
    terminalRecord: {
      terminalId: `terminal-${"c".repeat(64)}`,
      state: "complete",
      terminalAt: "2026-08-12T03:47:46.000Z",
    },
  });
  const outcome = await Promise.race([
    liveTurn.promise.then(
      () => ({ state: "resolved" }),
      (error: Error) => ({ state: "rejected", error }),
    ),
    new Promise<{ state: "pending" }>((resolve) =>
      setTimeout(() => resolve({ state: "pending" }), 1_000),
    ),
  ]);
  if (outcome.state === "pending") driver.dispose();
  await handling;

  assert.equal(outcome.state, "rejected");
  assert.match(
    outcome.state === "rejected" ? outcome.error.message : "",
    /rin_terminal_projection_failed/,
  );
  assert.equal(attempts, 1);
  assert.equal(driver.hasActiveTurn(), false);
});

test("terminal projection invokes each listener at most once per delivery attempt", async () => {
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
  assert.equal(retryingCalls, 1);
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

test("frontend presentation updates subsequent compaction lifecycle copy", async () => {
  const driver = createDriver();
  const seen: any[] = [];
  driver.subscribe((event: any) => seen.push(event));

  await emitDriverEvent(driver, {
    type: "extension_ui_request",
    method: "rinChatPresentation",
    presentation: {
      commandResponses: {
        compactionStart: "Localized compacting",
        compactionSummaryLine: "Localized {tokens}",
      },
    },
  });
  await emitDriverEvent(driver, { type: "compaction_start" });
  await emitDriverEvent(driver, {
    type: "compaction_end",
    reason: "threshold",
    result: { tokensBefore: 1234 },
  });

  assert.deepEqual(seen, [
    {
      type: "extension_ui_request",
      method: "rinChatPresentation",
      presentation: {
        commandResponses: {
          compactionStart: "Localized compacting",
          compactionSummaryLine: "Localized {tokens}",
        },
      },
    },
    { type: "compaction_start_notice", text: "Localized compacting" },
    {
      type: "passive_notice",
      text: "[compaction]\n\nLocalized 1,234",
      level: "info",
      deferDuringTurn: false,
      noticeKind: "compaction_end",
    },
  ]);
});

test("backend Working state is the only shared frontend Working source", async () => {
  const driver = createDriver();
  const seen: any[] = [];
  driver.subscribe((event: any) => seen.push(event));

  await emitDriverEvent(driver, {
    type: "rpc_turn_event",
    event: "start",
    requestTag: "turn-1",
    working: true,
  });
  await emitDriverEvent(driver, { type: "agent_start", working: true });
  await emitDriverEvent(driver, {
    type: "extension_ui_request",
    method: "setWorkingVisible",
    visible: false,
  });
  await emitDriverEvent(driver, { type: "compaction_start", working: true });
  await emitDriverEvent(driver, { type: "compaction_end", working: true });
  await emitDriverEvent(driver, { type: "agent_end", working: true });
  await emitDriverEvent(driver, {
    type: "rpc_turn_event",
    event: "complete",
    requestTag: "turn-1",
    working: false,
  });

  assert.deepEqual(seen, [
    { type: "turn_accepted", requestTag: "turn-1" },
    { type: "frontend_status", phase: "working" },
    { type: "working_state", working: true },
    { type: "turn_accepted" },
    { type: "compaction_start_notice", text: "Compacting..." },
    { type: "frontend_status", phase: "idle" },
    { type: "working_state", working: false },
    {
      type: "turn_complete",
      finalText: "",
      result: undefined,
      sessionId: undefined,
      sessionFile: undefined,
      requestTag: "turn-1",
    },
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

test("turn driver projects Pi retry exhaustion once through the frontend SDK", async () => {
  const driver = createDriver();
  const seen: any[] = [];
  driver.subscribe((event: any) => seen.push(event));

  await emitDriverEvent(driver, {
    type: "rpc_turn_event",
    event: "start",
    requestTag: "retry-turn",
  });
  await emitDriverEvent(driver, {
    type: "auto_retry_start",
    attempt: 3,
    maxAttempts: 3,
    delayMs: 8000,
    errorMessage: "fetch failed",
    requestTag: "retry-turn",
  });
  await emitDriverEvent(driver, {
    type: "auto_retry_end",
    success: false,
    attempt: 3,
    finalError: "fetch failed",
    requestTag: "retry-turn",
  });
  await emitDriverEvent(driver, {
    type: "rpc_turn_event",
    event: "error",
    error: "fetch failed",
    retryFailure: {
      attempt: 3,
      finalError: "fetch failed",
    },
    requestTag: "retry-turn",
  });

  assert.deepEqual(
    seen.filter((event) => event.type !== "frontend_status"),
    [
      { type: "turn_accepted", requestTag: "retry-turn" },
      {
        type: "turn_error",
        error: "Retry failed after 3 attempts: fetch failed",
        retryFailure: {
          attempt: 3,
          finalError: "fetch failed",
        },
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
    working: false,
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
    return { outcome: "terminalOwner", requestTag: options.requestTag };
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
      userId: "guest-1",
      nickname: "Guest",
      identity: "OTHER",
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
    userId: "guest-1",
    nickname: "Guest",
    identity: "OTHER",
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

test("frontend SDK carries reload binding context to the worker command", async () => {
  const driver = createDriver();
  const client = (driver as any).testClient;
  const promptContext = {
    source: "chat-bridge",
    chatKey: "discord/owner:room",
    chatName: "Owner room",
    chatType: "group",
  };

  await driver.connect({ restoreSessionFile: "/tmp/frontend-chat.jsonl" });
  await driver.runCommand("/reload", {
    assumeConnected: true,
    assumeSessionReady: true,
    restoreSessionFile: "/tmp/frontend-chat.jsonl",
    promptContext,
  });

  assert.deepEqual(
    client.calls.find(
      (call: any) =>
        call.type === "request" && call.command?.type === "run_command",
    )?.command,
    {
      type: "run_command",
      commandLine: "/reload",
      sessionFile: "/tmp/frontend-chat.jsonl",
      promptContext,
      frontendIdentity: { kind: "chat-bridge" },
    },
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

test("frontend SDK daemon shutdown detach absorbs a connection rejection that finishes late", async () => {
  const client = createFrontendClient();
  const originalDisconnect = client.disconnect;
  let rejectConnect!: (error: Error) => void;
  let connectStarted = false;
  let disconnectCount = 0;
  client.connect = async () => {
    connectStarted = true;
    await new Promise<never>((_resolve, reject) => {
      rejectConnect = reject;
    });
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
  rejectConnect(new Error("late connect rejection"));

  assert.equal(await connecting, false);
  assert.equal(client.isConnected(), false);
  assert.equal(disconnectCount, 2);
});

test("frontend SDK disposal maps a late connection success to lifecycle cancellation", async () => {
  const client = createFrontendClient();
  const originalConnect = client.connect;
  let releaseConnect!: () => void;
  const connectGate = new Promise<void>((resolve) => {
    releaseConnect = resolve;
  });
  let connectStarted = false;
  client.connect = async () => {
    connectStarted = true;
    await connectGate;
    await originalConnect.call(client);
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const connecting = driver.connect().then(
    () => null,
    (error: Error) => error,
  );
  await waitUntil(() => connectStarted, "connect did not start");
  driver.dispose();
  releaseConnect();

  const error = await connecting;
  assert.equal(error?.message, "rin_frontend_turn_cancelled");
  assert.equal(client.isConnected(), false);
});

test("frontend SDK retires a client while its old connection is still pending", async () => {
  const client = createFrontendClient();
  const originalConnect = client.connect;
  let releaseFirstConnect!: () => void;
  const firstConnectGate = new Promise<void>((resolve) => {
    releaseFirstConnect = resolve;
  });
  let connectCalls = 0;
  client.connect = async () => {
    connectCalls += 1;
    if (connectCalls === 1) await firstConnectGate;
    await originalConnect.call(client);
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const staleConnection = driver.connect().then(
    () => null,
    (error: Error) => error,
  );
  await waitUntil(() => connectCalls === 1, "first connection did not start");
  driver.dispose();
  const reusedConnection = await driver.connect();
  releaseFirstConnect();
  const staleError = await staleConnection;

  assert.equal(reusedConnection, false);
  assert.equal(connectCalls, 1);
  assert.equal(staleError?.message, "rin_frontend_turn_cancelled");
  assert.equal(client.isConnected(), false);
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

test("frontend SDK disposal fences session restore state after connection reuse", async () => {
  const client = createFrontendClient();
  const originalResumeSession = client.resumeSession;
  let releaseRestore!: () => void;
  const restoreGate = new Promise<void>((resolve) => {
    releaseRestore = resolve;
  });
  let restoreStarted = false;
  let firstRestore = true;
  client.resumeSession = async (...args) => {
    if (firstRestore) {
      firstRestore = false;
      restoreStarted = true;
      await restoreGate;
    }
    return await originalResumeSession.apply(client, args);
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  await driver.connect();

  const restoring = driver
    .connect({
      restoreSessionFile: "/tmp/stale-restored-session.jsonl",
    })
    .then(
      () => null,
      (error: Error) => error,
    );
  await waitUntil(() => restoreStarted, "session restore did not start");
  driver.dispose();
  const reconnected = await driver.connect();
  const reusedClient = (driver as any).client;
  (driver as any).frontendState = {
    sessionId: "new-epoch-session",
    sessionFile: "/tmp/new-epoch-session.jsonl",
  };
  releaseRestore();
  const restoreError = await restoring;

  assert.equal(restoreError?.message, "rin_frontend_turn_cancelled");
  assert.equal(reconnected, false);
  assert.equal(reusedClient, null);
  assert.equal(driver.currentSessionId(), "new-epoch-session");
  assert.equal(driver.currentSessionFile(), "/tmp/new-epoch-session.jsonl");
});

test("frontend SDK maps a stale successful public session selection to lifecycle cancellation", async (t) => {
  const sessionDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-stale-session-selection-"),
  );
  t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));
  const sessionFile = path.join(sessionDir, "session.jsonl");
  fs.writeFileSync(sessionFile, "");

  const client = createFrontendClient();
  const originalResumeSession = client.resumeSession;
  let releaseSelection!: () => void;
  const selectionGate = new Promise<void>((resolve) => {
    releaseSelection = resolve;
  });
  let selectionStarted = false;
  client.resumeSession = async (...args) => {
    selectionStarted = true;
    await selectionGate;
    return await originalResumeSession.apply(client, args);
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  await driver.connect();

  const selecting = driver.resumeSessionFile(sessionFile).then(
    () => null,
    (error: Error) => error,
  );
  await waitUntil(() => selectionStarted, "session selection did not start");
  driver.dispose();
  releaseSelection();

  const error = await selecting;
  assert.equal(error?.message, "rin_frontend_turn_cancelled");
});

test("frontend SDK retires a client until every concurrent restore finishes", async () => {
  const client = createFrontendClient();
  const originalResumeSession = client.resumeSession;
  let releaseFirstRestore!: () => void;
  const firstRestoreGate = new Promise<void>((resolve) => {
    releaseFirstRestore = resolve;
  });
  let releaseSecondRestore!: () => void;
  const secondRestoreGate = new Promise<void>((resolve) => {
    releaseSecondRestore = resolve;
  });
  let restoreCalls = 0;
  client.resumeSession = async (...args) => {
    const restoreIndex = ++restoreCalls;
    if (restoreIndex === 1) await firstRestoreGate;
    if (restoreIndex === 2) await secondRestoreGate;
    return await originalResumeSession.apply(client, args);
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  await driver.connect();

  const firstRestore = driver.connect({
    restoreSessionFile: "/tmp/concurrent-first-restore.jsonl",
  });
  await waitUntil(() => restoreCalls === 1, "first restore did not start");
  const secondRestore = driver
    .connect({
      restoreSessionFile: "/tmp/concurrent-second-restore.jsonl",
    })
    .then(
      () => null,
      (error: Error) => error,
    );
  await waitUntil(() => restoreCalls === 2, "second restore did not start");
  releaseFirstRestore();
  assert.equal(await firstRestore, true);

  driver.dispose();
  const reconnected = await driver.connect();
  const reusedClient = (driver as any).client;
  (driver as any).frontendState = {
    sessionId: "concurrent-new-epoch-session",
    sessionFile: "/tmp/concurrent-new-epoch-session.jsonl",
  };
  releaseSecondRestore();
  const secondRestoreError = await secondRestore;
  assert.equal(secondRestoreError?.message, "rin_frontend_turn_cancelled");
  await (driver as any).refreshFrontendState();

  assert.equal(reconnected, false);
  assert.equal(reusedClient, null);
  assert.equal(driver.currentSessionId(), "concurrent-new-epoch-session");
  assert.equal(
    driver.currentSessionFile(),
    "/tmp/concurrent-new-epoch-session.jsonl",
  );
});

test("frontend SDK maps a stale restore rejection to lifecycle cancellation", async () => {
  const client = createFrontendClient();
  let rejectRestore!: (error: Error) => void;
  const restoreOutcome = new Promise<never>((_resolve, reject) => {
    rejectRestore = reject;
  });
  let restoreStarted = false;
  client.resumeSession = async (sessionFile: string) => {
    client.calls.push({ type: "resumeSession", sessionFile });
    restoreStarted = true;
    await restoreOutcome;
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const restoring = driver
    .connect({ restoreSessionFile: "/tmp/stale-rejected-restore.jsonl" })
    .then(
      () => null,
      (error: Error) => error,
    );
  await waitUntil(() => restoreStarted, "session restore did not start");
  driver.dispose();
  rejectRestore(new Error("old restore backend failure"));

  const error = await restoring;
  assert.equal(error?.message, "rin_frontend_turn_cancelled");
});

test("frontend SDK maps a stale direct readiness rejection to lifecycle cancellation", async () => {
  const client = createFrontendClient();
  let rejectReadiness!: (error: Error) => void;
  const readinessOutcome = new Promise<never>((_resolve, reject) => {
    rejectReadiness = reject;
  });
  let readinessStarted = false;
  (client as any).ensureSessionReady = async () => {
    readinessStarted = true;
    await readinessOutcome;
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const turn = driver.runTurn({ text: "stale direct readiness" }).then(
    () => null,
    (error: Error) => error,
  );
  await waitUntil(() => readinessStarted, "direct readiness did not start");
  driver.dispose();
  const reconnected = await driver.connect();
  rejectReadiness(new Error("old direct readiness failure"));

  const error = await turn;
  assert.equal(reconnected, false);
  assert.equal(error?.message, "rin_frontend_turn_cancelled");
});

test("frontend SDK maps a stale fallback new-session rejection to lifecycle cancellation", async () => {
  const client = createFrontendClient();
  let rejectNewSession!: (error: Error) => void;
  const newSessionOutcome = new Promise<never>((_resolve, reject) => {
    rejectNewSession = reject;
  });
  let newSessionStarted = false;
  client.newSession = async (options: any = {}) => {
    client.calls.push({ type: "newSession", options });
    newSessionStarted = true;
    await newSessionOutcome;
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const turn = driver
    .runTurn({
      text: "stale fallback new session",
      managedSessionLeaf: "chat",
    })
    .then(
      () => null,
      (error: Error) => error,
    );
  await waitUntil(
    () => newSessionStarted,
    "fallback new session did not start",
  );
  driver.dispose();
  const reconnected = await driver.connect();
  rejectNewSession(new Error("old fallback new-session failure"));

  const error = await turn;
  assert.equal(reconnected, false);
  assert.equal(error?.message, "rin_frontend_turn_cancelled");
});

test("frontend SDK maps a stale command readiness selection rejection to lifecycle cancellation", async () => {
  const client = createFrontendClient();
  let rejectSelection!: (error: Error) => void;
  const selectionOutcome = new Promise<never>((_resolve, reject) => {
    rejectSelection = reject;
  });
  let selectionStarted = false;
  client.resumeSession = async (sessionFile: string) => {
    client.calls.push({ type: "resumeSession", sessionFile });
    selectionStarted = true;
    await selectionOutcome;
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const command = driver
    .runCommand("/compact", {
      restoreSessionFile: "/tmp/stale-command-selection.jsonl",
    })
    .then(
      () => null,
      (error: Error) => error,
    );
  await waitUntil(
    () => selectionStarted,
    "command readiness selection did not start",
  );
  driver.dispose();
  rejectSelection(new Error("old command selection failure"));

  const error = await command;
  assert.equal(error?.message, "rin_frontend_turn_cancelled");
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

test("frontend SDK /abort settles the active turn only from the canonical backend terminal", async () => {
  const client = createFrontendClient();
  let ackAttempts = 0;
  let finishRetryAck: (() => void) | null = null;
  client.request = async (command: any) => {
    client.calls.push({ type: "request", command });
    if (command?.type !== "ack_turn_terminal") return { ok: true };
    ackAttempts += 1;
    if (ackAttempts === 1) throw new Error("ack transport lost");
    if (ackAttempts > 2) throw new Error("duplicate terminal ACK");
    await new Promise<void>((resolve) => {
      finishRetryAck = resolve;
    });
    return { ok: true };
  };
  let promptStarted = false;
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    promptStarted = true;
    await new Promise(() => {});
  };
  client.abort = async () => {
    client.calls.push({ type: "abort" });
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  const projected: any[] = [];
  driver.subscribe((event: any) => projected.push(event));

  let activeTurnSettled = false;
  const activeTurn = driver.runTurn({
    text: "abort me",
    chatDeliveryContext: {
      turnId: "turn-abort-terminal",
      chatKey: "discord/1:2",
      messageId: "message-abort-terminal",
      ownerEpoch: "owner-abort-terminal",
      attempt: 1,
    },
  });
  void activeTurn.then(
    () => {
      activeTurnSettled = true;
    },
    () => {
      activeTurnSettled = true;
    },
  );
  await waitUntil(() => promptStarted, "active turn did not start");
  const requestTag = client.calls.find((call: any) => call.type === "prompt")
    .options.requestTag;

  const commandResult = await driver.runCommand("/abort");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(commandResult.text, "Aborted current operation.");
  assert.deepEqual(
    client.calls.filter((call: any) => call.type === "abort"),
    [{ type: "abort" }],
  );
  assert.equal(
    activeTurnSettled,
    false,
    "the frontend must not settle an accepted turn before the backend terminal",
  );
  assert.equal(
    projected.some((event) => event.type === "turn_error"),
    false,
  );

  const terminalEvent = {
    type: "rpc_turn_event",
    event: "error",
    requestTag,
    error: "Request was aborted",
    terminalRecord: {
      terminalId: "terminal-aborted-turn",
      state: "error",
      terminalAt: "2026-07-31T10:01:42.000Z",
    },
  };
  await emitDriverEvent(driver, terminalEvent);
  await assert.rejects(activeTurn, /Request was aborted/);
  assert.equal(ackAttempts, 1);
  assert.equal(
    projected.some((event) => event.type === "turn_error"),
    false,
    "the command acknowledgement owns intentional-abort presentation",
  );

  const retryOne = emitDriverEvent(driver, terminalEvent);
  await waitUntil(() => ackAttempts === 2, "terminal ACK retry did not start");
  const retryTwo = emitDriverEvent(driver, terminalEvent);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ackAttempts, 2);
  finishRetryAck?.();
  await Promise.all([retryOne, retryTwo]);
  await emitDriverEvent(driver, terminalEvent);
  assert.equal(ackAttempts, 2);

  const acknowledgements = client.calls.filter(
    (call: any) =>
      call.type === "request" && call.command?.type === "ack_turn_terminal",
  );
  assert.equal(acknowledgements.length, 2);
  assert.deepEqual(acknowledgements[1], {
    type: "request",
    command: {
      type: "ack_turn_terminal",
      requestTag,
      terminalId: "terminal-aborted-turn",
    },
  });
});

test("frontend SDK restores ordinary terminal handling when backend /abort fails", async () => {
  const client = createFrontendClient();
  let requestTag = "";
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    requestTag = options.requestTag || "";
    return { outcome: "terminalOwner", requestTag };
  };
  client.abort = async () => {
    client.calls.push({ type: "abort" });
    await client.emit({
      type: "ui",
      payload: {
        type: "rpc_turn_event",
        event: "complete",
        requestTag,
        finalText: "completed after rejected abort",
        sessionFile: "/tmp/frontend-chat.jsonl",
        sessionId: "frontend-session",
        terminalRecord: {
          terminalId: "terminal-rejected-abort-complete",
          state: "complete",
          terminalAt: "2026-08-06T09:05:00.000Z",
        },
      },
    });
    throw new Error("backend abort rejected");
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  const projected: any[] = [];
  driver.subscribe((event: any) => projected.push(event));

  const activeTurn = driver.runTurn({ text: "keep running" });
  await waitUntil(
    () => Boolean(requestTag && driver.liveTurn),
    "active turn did not start",
  );

  const interruptionSeq = (driver as any).turnInterruptionSeq;
  await assert.rejects(driver.runCommand("/abort"), /backend abort rejected/);
  assert.equal((driver as any).turnInterruptionSeq, interruptionSeq);
  assert.equal((await activeTurn).finalText, "completed after rejected abort");
  await waitUntil(
    () => !(driver as any).backendInterruptionsByRequestTag.has(requestTag),
    "rollback target did not release after terminal handling",
  );
  assert.equal(
    projected.some(
      (event) =>
        event.type === "turn_complete" && event.requestTag === requestTag,
    ),
    true,
    `a rejected backend abort must not suppress the old terminal: ${JSON.stringify(projected)}`,
  );
});

test("frontend SDK commits intentional abort presentation before settling a buffered terminal", async () => {
  const client = createFrontendClient();
  let requestTag = "";
  let releaseAbort!: () => void;
  const abortRelease = new Promise<void>((resolve) => {
    releaseAbort = resolve;
  });
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    requestTag = options.requestTag || "";
    return { outcome: "terminalOwner", requestTag };
  };
  client.abort = async () => {
    client.calls.push({ type: "abort" });
    await abortRelease;
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  let activeTurnSettled = false;
  const activeTurn = driver.runTurn({ text: "buffer my abort terminal" });
  void activeTurn
    .finally(() => {
      activeTurnSettled = true;
    })
    .catch(() => {});
  await waitUntil(
    () => Boolean(requestTag && driver.liveTurn),
    "active turn did not start",
  );

  let callbackSawSettled: boolean | undefined;
  const command = driver.runCommand("/abort", {
    onActiveTurnInterruptionCommitted: () => {
      callbackSawSettled = activeTurnSettled;
    },
  });
  await waitUntil(
    () => client.calls.some((call: any) => call.type === "abort"),
    "backend abort did not start",
  );
  const interruptionTarget = (
    driver as any
  ).backendInterruptionsByRequestTag.get(requestTag);
  assert.ok(interruptionTarget, "backend interruption was not prepared");
  await emitDriverEvent(driver, {
    type: "rpc_turn_event",
    event: "error",
    requestTag,
    error: "Request was aborted",
    sessionFile: "/tmp/frontend-chat.jsonl",
    sessionId: "frontend-session",
    terminalRecord: {
      terminalId: "terminal-buffered-abort-error",
      state: "error",
      terminalAt: "2026-08-06T09:05:30.000Z",
    },
  });
  assert.equal(
    interruptionTarget.bufferedTerminal?.requestTag,
    requestTag,
    "the terminal must remain buffered until backend commit",
  );
  assert.equal(activeTurnSettled, false);

  releaseAbort();
  await command;
  assert.equal(callbackSawSettled, false);
  await assert.rejects(activeTurn, /Request was aborted/);
});

test("frontend SDK keeps a successful overlapping interruption committed when the first command rolls back during terminal ACK", async () => {
  const client = createFrontendClient();
  let requestTag = "";
  let rejectAbort!: (error: Error) => void;
  const abortOutcome = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  let resolveNewSession!: (value: any) => void;
  const newSessionOutcome = new Promise<any>((resolve) => {
    resolveNewSession = resolve;
  });
  let releaseAck!: () => void;
  const ackOutcome = new Promise<void>((resolve) => {
    releaseAck = resolve;
  });
  let ackStarted = false;
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    requestTag = options.requestTag || "";
    return { outcome: "terminalOwner", requestTag };
  };
  client.abort = async () => {
    client.calls.push({ type: "abort" });
    await abortOutcome;
  };
  client.newSession = async (options: any = {}) => {
    client.calls.push({ type: "newSession", options });
    return await newSessionOutcome;
  };
  client.request = async (command: any) => {
    client.calls.push({ type: "request", command });
    if (command?.type !== "ack_turn_terminal") return { ok: true };
    ackStarted = true;
    await ackOutcome;
    return { ok: true };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  const projected: any[] = [];
  driver.subscribe((event: any) => projected.push(event));

  const activeTurn = driver.runTurn({ text: "overlapping interruption" });
  void activeTurn.catch(() => {});
  await waitUntil(
    () => Boolean(requestTag && driver.liveTurn),
    "active turn did not start",
  );

  const abortCommand = driver.runCommand("/abort");
  await waitUntil(
    () => client.calls.some((call: any) => call.type === "abort"),
    "backend abort did not start",
  );
  const newCommand = driver.runCommand("/new", {
    managedSessionLeaf: "chat",
  });
  await waitUntil(
    () => client.calls.some((call: any) => call.type === "newSession"),
    "backend new_session did not start",
  );

  const terminalDelivery = emitDriverEvent(driver, {
    type: "rpc_turn_event",
    event: "error",
    requestTag,
    error: "Request was aborted",
    sessionFile: "/tmp/frontend-chat.jsonl",
    sessionId: "frontend-session",
    terminalRecord: {
      terminalId: "terminal-overlapping-command-error",
      state: "error",
      terminalAt: "2026-08-06T09:05:45.000Z",
    },
  });
  await waitUntil(() => ackStarted, "terminal ACK did not start");

  resolveNewSession({
    cancelled: false,
    sessionFile: "/tmp/frontend-managed.jsonl",
    sessionId: "frontend-session",
  });
  assert.equal((await newCommand).text, "Started a new session.");
  rejectAbort(new Error("backend abort rejected"));
  await assert.rejects(abortCommand, /backend abort rejected/);

  releaseAck();
  await terminalDelivery;
  await assert.rejects(activeTurn, /Request was aborted/);
  assert.equal(
    projected.some(
      (event) => event.type === "turn_error" && event.requestTag === requestTag,
    ),
    false,
    "one successful overlapping backend interruption must retain suppression",
  );
  assert.equal((driver as any).turnInterruptionSeq, 1);
  assert.equal(
    client.calls.filter(
      (call: any) =>
        call.type === "request" &&
        call.command?.type === "ack_turn_terminal" &&
        call.command?.requestTag === requestTag,
    ).length,
    1,
  );
});

test("frontend SDK reserves the first conflicting terminal before ACK", async () => {
  const client = createFrontendClient();
  let releaseFirstAck!: () => void;
  const firstAckGate = new Promise<void>((resolve) => {
    releaseFirstAck = resolve;
  });
  let firstAckStarted = false;
  client.request = async (command: any) => {
    client.calls.push({ type: "request", command });
    if (
      command?.type === "ack_turn_terminal" &&
      command.terminalId === "terminal-delayed-first-envelope"
    ) {
      firstAckStarted = true;
      await firstAckGate;
    }
    return { ok: true };
  };
  let releaseAbort!: () => void;
  const abortGate = new Promise<void>((resolve) => {
    releaseAbort = resolve;
  });
  client.abort = async () => {
    client.calls.push({ type: "abort" });
    await abortGate;
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  await driver.connect();
  const requestTag = "delayed-first-envelope-request";
  const liveTurn = (driver as any).startLiveTurn(requestTag);
  const command = driver.runCommand("/abort");
  await waitUntil(
    () => client.calls.some((call: any) => call.type === "abort"),
    "backend abort did not start",
  );

  const firstHandling = driver.handleClientEvent({
    type: "rpc_turn_event",
    event: "complete",
    requestTag,
    finalText: "first authoritative envelope",
    terminalRecord: {
      terminalId: "terminal-delayed-first-envelope",
      state: "complete",
      terminalAt: "2026-08-06T09:06:06.100Z",
    },
  });
  await waitUntil(() => firstAckStarted, "first terminal ACK did not start");
  await driver.handleClientEvent({
    type: "rpc_turn_event",
    event: "complete",
    requestTag,
    finalText: "later conflicting envelope",
    terminalRecord: {
      terminalId: "terminal-fast-second-envelope",
      state: "complete",
      terminalAt: "2026-08-06T09:06:06.200Z",
    },
  });
  releaseAbort();
  await command;
  releaseFirstAck();
  await firstHandling;

  assert.equal(
    (await liveTurn.promise).finalText,
    "first authoritative envelope",
  );
});

test("frontend SDK snapshots the first terminal envelope before delayed ACK", async () => {
  const client = createFrontendClient();
  let releaseAck!: () => void;
  const ackGate = new Promise<void>((resolve) => {
    releaseAck = resolve;
  });
  let ackStarted = false;
  client.request = async (command: any) => {
    client.calls.push({ type: "request", command });
    if (
      command?.type === "ack_turn_terminal" &&
      command.terminalId === "terminal-immutable-envelope"
    ) {
      ackStarted = true;
      await ackGate;
    }
    return { ok: true };
  };
  let releaseAbort!: () => void;
  const abortGate = new Promise<void>((resolve) => {
    releaseAbort = resolve;
  });
  client.abort = async () => {
    client.calls.push({ type: "abort" });
    await abortGate;
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  await driver.connect();
  const requestTag = "immutable-envelope-request";
  const liveTurn = (driver as any).startLiveTurn(requestTag);
  const command = driver.runCommand("/abort");
  await waitUntil(
    () => client.calls.some((call: any) => call.type === "abort"),
    "backend abort did not start",
  );

  const payload: any = {
    type: "rpc_turn_event",
    event: "complete",
    requestTag,
    finalText: "immutable envelope final",
    sessionId: "session-immutable-envelope",
    sessionFile: "/tmp/session-immutable-envelope.jsonl",
    result: { messages: [{ text: "original result" }] },
    chatDeliveryContext: {
      turnId: "original-turn",
      replyToMessageId: "original-reply",
    },
    terminalRecord: {
      terminalId: "terminal-immutable-envelope",
      state: "complete",
      terminalAt: "2026-08-07T00:30:00.000Z",
      metadata: { source: "original terminal" },
    },
  };
  const handling = driver.handleClientEvent(payload);
  await waitUntil(() => ackStarted, "terminal ACK did not start");
  payload.result.messages[0].text = "mutated result";
  payload.chatDeliveryContext.turnId = "mutated-turn";
  payload.chatDeliveryContext.replyToMessageId = "mutated-reply";
  payload.terminalRecord.state = "error";
  payload.terminalRecord.metadata.source = "mutated terminal";

  releaseAbort();
  await command;
  releaseAck();
  await handling;
  const completion = await liveTurn.promise;

  assert.equal(completion.result.messages[0].text, "original result");
  assert.equal(completion.sessionId, "session-immutable-envelope");
  assert.equal(completion.sessionFile, "/tmp/session-immutable-envelope.jsonl");
  assert.equal(completion.chatDeliveryContext.turnId, "original-turn");
  assert.equal(
    completion.chatDeliveryContext.replyToMessageId,
    "original-reply",
  );
  assert.equal(completion.terminalRecord.state, "complete");
  assert.equal(completion.terminalRecord.metadata.source, "original terminal");
});

test("frontend SDK keeps the first reserved terminal when rollback crosses delayed ACK", async () => {
  const client = createFrontendClient();
  let releaseFirstAck!: () => void;
  const firstAckGate = new Promise<void>((resolve) => {
    releaseFirstAck = resolve;
  });
  let firstAckStarted = false;
  client.request = async (command: any) => {
    client.calls.push({ type: "request", command });
    if (
      command?.type === "ack_turn_terminal" &&
      command.terminalId === "terminal-rollback-delayed-first"
    ) {
      firstAckStarted = true;
      await firstAckGate;
    }
    return { ok: true };
  };
  let rejectAbort!: (error: Error) => void;
  const abortOutcome = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  client.abort = async () => {
    client.calls.push({ type: "abort" });
    await abortOutcome;
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  const projected: any[] = [];
  driver.subscribe((event: any) => projected.push(event));
  await driver.connect();
  const requestTag = "rollback-delayed-first-envelope-request";
  const liveTurn = (driver as any).startLiveTurn(requestTag);
  const command = driver.runCommand("/abort");
  const commandFailure = assert.rejects(command, /backend abort rejected/);
  await waitUntil(
    () => client.calls.some((call: any) => call.type === "abort"),
    "backend abort did not start",
  );

  const firstHandling = driver.handleClientEvent({
    type: "rpc_turn_event",
    event: "complete",
    requestTag,
    finalText: "first rollback envelope",
    terminalRecord: {
      terminalId: "terminal-rollback-delayed-first",
      state: "complete",
      terminalAt: "2026-08-06T09:06:06.300Z",
    },
  });
  await waitUntil(() => firstAckStarted, "first terminal ACK did not start");
  rejectAbort(new Error("backend abort rejected"));
  await commandFailure;

  await driver.handleClientEvent({
    type: "rpc_turn_event",
    event: "complete",
    requestTag,
    finalText: "later rollback conflict",
    terminalRecord: {
      terminalId: "terminal-rollback-fast-conflict",
      state: "complete",
      terminalAt: "2026-08-06T09:06:06.400Z",
    },
  });
  assert.equal(
    projected.some(
      (event) =>
        event.type === "turn_complete" && event.requestTag === requestTag,
    ),
    false,
    "a conflicting terminal cannot project before the reserved envelope",
  );

  releaseFirstAck();
  await firstHandling;
  assert.equal((await liveTurn.promise).finalText, "first rollback envelope");
  assert.deepEqual(
    projected
      .filter(
        (event) =>
          event.type === "turn_complete" && event.requestTag === requestTag,
      )
      .map((event) => event.finalText),
    ["first rollback envelope"],
  );

  await driver.handleClientEvent({
    type: "rpc_turn_event",
    event: "complete",
    requestTag,
    finalText: "post-release rollback conflict",
    sessionFile: "/tmp/conflicting-session.jsonl",
    sessionId: "conflicting-session",
    terminalRecord: {
      terminalId: "terminal-rollback-post-release-conflict",
      state: "complete",
      terminalAt: "2026-08-06T09:06:06.450Z",
    },
  });
  assert.equal(driver.latestAssistantText, "first rollback envelope");
  assert.deepEqual(
    projected
      .filter(
        (event) =>
          event.type === "turn_complete" && event.requestTag === requestTag,
      )
      .map((event) => event.finalText),
    ["first rollback envelope"],
  );
});

test("frontend SDK retains an exact successful ACK through buffered rollback projection", async () => {
  const client = createFrontendClient();
  const requestTag = "buffered-rollback-ack-retention-request";
  const terminal = {
    type: "rpc_turn_event",
    event: "complete",
    requestTag,
    finalText: "buffered rollback ACK final",
    terminalRecord: {
      terminalId: "terminal-buffered-rollback-ack-retention",
      state: "complete",
      terminalAt: "2026-08-06T09:06:06.500Z",
    },
  };
  let ackAttempts = 0;
  client.request = async (command: any) => {
    client.calls.push({ type: "request", command });
    if (command?.type === "ack_turn_terminal") ackAttempts += 1;
    return { ok: true };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  client.abort = async () => {
    client.calls.push({ type: "abort" });
    await driver.handleClientEvent(terminal);
    throw new Error("buffered rollback abort rejected");
  };
  const projected: any[] = [];
  driver.subscribe((event: any) => projected.push(event));
  await driver.connect();
  const liveTurn = (driver as any).startLiveTurn(requestTag);

  await assert.rejects(
    driver.runCommand("/abort"),
    /buffered rollback abort rejected/,
  );
  assert.equal((await liveTurn.promise).finalText, terminal.finalText);
  assert.equal(ackAttempts, 1);

  await driver.handleClientEvent(terminal);
  assert.equal(ackAttempts, 1, "an exact successful ACK must not be retried");
  assert.equal(
    projected.filter(
      (event) =>
        event.type === "turn_complete" && event.requestTag === requestTag,
    ).length,
    1,
  );
});

test("frontend SDK keeps the first immutable terminal across pushed and direct duplicates", async () => {
  const client = createFrontendClient();
  let requestTag = "";
  let releaseAbort!: () => void;
  const abortOutcome = new Promise<void>((resolve) => {
    releaseAbort = resolve;
  });
  let releaseAck!: () => void;
  const ackOutcome = new Promise<void>((resolve) => {
    releaseAck = resolve;
  });
  let ackStarted = false;
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    requestTag = options.requestTag || "";
    return { outcome: "terminalOwner", requestTag };
  };
  client.abort = async () => {
    client.calls.push({ type: "abort" });
    await abortOutcome;
  };
  client.request = async (command: any) => {
    client.calls.push({ type: "request", command });
    if (command?.type !== "ack_turn_terminal") return { ok: true };
    ackStarted = true;
    await ackOutcome;
    return { ok: true };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const activeTurn = driver.runTurn({ text: "immutable duplicate terminal" });
  void activeTurn.catch(() => {});
  await waitUntil(
    () => Boolean(requestTag && driver.liveTurn),
    "active turn did not start",
  );
  const command = driver.runCommand("/abort");
  await waitUntil(
    () => client.calls.some((call: any) => call.type === "abort"),
    "backend abort did not start",
  );

  const terminalRecord = {
    terminalId: "terminal-pushed-direct-immutable",
    state: "error",
    terminalAt: "2026-08-06T09:05:50.000Z",
  };
  const pushedDelivery = driver.handleClientEvent({
    type: "ui",
    payload: {
      type: "rpc_turn_event",
      event: "error",
      requestTag,
      error: "first immutable error",
      sessionFile: "/tmp/frontend-chat.jsonl",
      sessionId: "frontend-session",
      terminalRecord,
    },
  });
  const directDelivery = driver.handleClientEvent({
    type: "rpc_turn_event",
    event: "error",
    requestTag,
    error: "conflicting duplicate error",
    sessionFile: "/tmp/frontend-chat.jsonl",
    sessionId: "frontend-session",
    terminalRecord,
  });
  await waitUntil(() => ackStarted, "terminal ACK did not start");
  releaseAck();
  await Promise.all([pushedDelivery, directDelivery]);

  releaseAbort();
  await command;
  await assert.rejects(activeTurn, /first immutable error/);
  assert.equal(
    client.calls.filter(
      (call: any) =>
        call.type === "request" &&
        call.command?.type === "ack_turn_terminal" &&
        call.command?.requestTag === requestTag,
    ).length,
    1,
  );
});

test("frontend SDK coalesces pushed and direct terminal delivery when all overlapping commands roll back", async () => {
  const client = createFrontendClient();
  let requestTag = "";
  let rejectAbort!: (error: Error) => void;
  const abortOutcome = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  let rejectNewSession!: (error: Error) => void;
  const newSessionOutcome = new Promise<never>((_resolve, reject) => {
    rejectNewSession = reject;
  });
  let releaseAck!: () => void;
  const ackOutcome = new Promise<void>((resolve) => {
    releaseAck = resolve;
  });
  let ackStarted = false;
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    requestTag = options.requestTag || "";
    return { outcome: "terminalOwner", requestTag };
  };
  client.abort = async () => {
    client.calls.push({ type: "abort" });
    await abortOutcome;
  };
  client.newSession = async (options: any = {}) => {
    client.calls.push({ type: "newSession", options });
    await newSessionOutcome;
  };
  client.request = async (command: any) => {
    client.calls.push({ type: "request", command });
    if (command?.type !== "ack_turn_terminal") return { ok: true };
    ackStarted = true;
    await ackOutcome;
    return { ok: true };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  const projected: any[] = [];
  driver.subscribe((event: any) => projected.push(event));

  const activeTurn = driver.runTurn({ text: "all interruptions roll back" });
  void activeTurn.catch(() => {});
  await waitUntil(
    () => Boolean(requestTag && driver.liveTurn),
    "active turn did not start",
  );
  const abortCommand = driver.runCommand("/abort");
  const abortFailure = assert.rejects(abortCommand, /abort rollback/);
  await waitUntil(
    () => client.calls.some((call: any) => call.type === "abort"),
    "backend abort did not start",
  );
  const newCommand = driver.runCommand("/new", {
    managedSessionLeaf: "chat",
  });
  const newFailure = assert.rejects(newCommand, /new rollback/);
  await waitUntil(
    () => client.calls.some((call: any) => call.type === "newSession"),
    "backend new_session did not start",
  );

  const terminal = {
    type: "rpc_turn_event",
    event: "error",
    requestTag,
    error: "ordinary terminal after rollback",
    sessionFile: "/tmp/frontend-chat.jsonl",
    sessionId: "frontend-session",
    terminalRecord: {
      terminalId: "terminal-all-overlapping-rollback",
      state: "error",
      terminalAt: "2026-08-06T09:05:55.000Z",
    },
  };
  const pushedDelivery = driver.handleClientEvent({
    type: "ui",
    payload: terminal,
  });
  const directDelivery = driver.handleClientEvent(terminal);
  await waitUntil(() => ackStarted, "terminal ACK did not start");
  const interruptionTarget = (
    driver as any
  ).backendInterruptionsByRequestTag.get(requestTag);
  assert.equal(
    interruptionTarget?.activeTerminalHandlers,
    1,
    "one immutable terminal must have one active handler",
  );

  rejectAbort(new Error("abort rollback"));
  rejectNewSession(new Error("new rollback"));
  await Promise.all([abortFailure, newFailure]);
  releaseAck();
  await Promise.all([pushedDelivery, directDelivery]);
  await assert.rejects(activeTurn, /ordinary terminal after rollback/);
  assert.equal(
    projected.filter(
      (event) => event.type === "turn_error" && event.requestTag === requestTag,
    ).length,
    1,
  );
  assert.equal(
    client.calls.filter(
      (call: any) =>
        call.type === "request" &&
        call.command?.type === "ack_turn_terminal" &&
        call.command?.requestTag === requestTag,
    ).length,
    1,
  );
});

test("frontend SDK keeps the first buffered terminal across sequential pushed and direct delivery before commit", async () => {
  const client = createFrontendClient();
  let requestTag = "";
  let releaseAbort!: () => void;
  const abortOutcome = new Promise<void>((resolve) => {
    releaseAbort = resolve;
  });
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    requestTag = options.requestTag || "";
    return { outcome: "terminalOwner", requestTag };
  };
  client.abort = async () => {
    client.calls.push({ type: "abort" });
    await abortOutcome;
  };
  client.request = async (command: any) => {
    client.calls.push({ type: "request", command });
    return { ok: true };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const activeTurn = driver.runTurn({ text: "sequential commit duplicate" });
  void activeTurn.catch(() => {});
  await waitUntil(
    () => Boolean(requestTag && driver.liveTurn),
    "active turn did not start",
  );
  const command = driver.runCommand("/abort");
  await waitUntil(
    () => client.calls.some((call: any) => call.type === "abort"),
    "backend abort did not start",
  );

  const terminalRecord = {
    terminalId: "terminal-sequential-commit",
    state: "error",
    terminalAt: "2026-08-06T09:06:00.000Z",
  };
  await driver.handleClientEvent({
    type: "ui",
    payload: {
      type: "rpc_turn_event",
      event: "error",
      requestTag,
      error: "first sequential error",
      sessionFile: "/tmp/frontend-chat.jsonl",
      sessionId: "frontend-session",
      terminalRecord,
    },
  });
  await driver.handleClientEvent({
    type: "rpc_turn_event",
    event: "error",
    requestTag,
    error: "later sequential error",
    sessionFile: "/tmp/frontend-chat.jsonl",
    sessionId: "frontend-session",
    terminalRecord,
  });

  releaseAbort();
  await command;
  await assert.rejects(activeTurn, /first sequential error/);
});

test("frontend SDK ignores a sequential direct duplicate after all interruption participants roll back", async () => {
  const client = createFrontendClient();
  let requestTag = "";
  let rejectAbort!: (error: Error) => void;
  const abortOutcome = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  let releaseAck!: () => void;
  const ackOutcome = new Promise<void>((resolve) => {
    releaseAck = resolve;
  });
  let ackStarted = false;
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    requestTag = options.requestTag || "";
    return { outcome: "terminalOwner", requestTag };
  };
  client.abort = async () => {
    client.calls.push({ type: "abort" });
    await abortOutcome;
  };
  client.request = async (command: any) => {
    client.calls.push({ type: "request", command });
    if (command?.type !== "ack_turn_terminal") return { ok: true };
    ackStarted = true;
    await ackOutcome;
    return { ok: true };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  const projected: any[] = [];
  driver.subscribe((event: any) => projected.push(event));

  const activeTurn = driver.runTurn({ text: "sequential rollback duplicate" });
  await waitUntil(
    () => Boolean(requestTag && driver.liveTurn),
    "active turn did not start",
  );
  const abortCommand = driver.runCommand("/abort");
  const abortFailure = assert.rejects(abortCommand, /abort rollback/);
  await waitUntil(
    () => client.calls.some((call: any) => call.type === "abort"),
    "backend abort did not start",
  );

  const terminalRecord = {
    terminalId: "terminal-sequential-rollback",
    state: "complete",
    terminalAt: "2026-08-06T09:06:05.000Z",
  };
  const pushedDelivery = driver.handleClientEvent({
    type: "ui",
    payload: {
      type: "rpc_turn_event",
      event: "complete",
      requestTag,
      finalText: "first sequential final",
      sessionFile: "/tmp/frontend-chat.jsonl",
      sessionId: "frontend-session",
      terminalRecord,
    },
  });
  await waitUntil(() => ackStarted, "terminal ACK did not start");
  rejectAbort(new Error("abort rollback"));
  await abortFailure;
  releaseAck();
  await pushedDelivery;
  assert.equal((await activeTurn).finalText, "first sequential final");
  assert.equal(driver.latestAssistantText, "first sequential final");

  await driver.handleClientEvent({
    type: "rpc_turn_event",
    event: "complete",
    requestTag,
    finalText: "later sequential final",
    sessionFile: "/tmp/conflicting-session.jsonl",
    sessionId: "conflicting-session",
    terminalRecord,
  });
  assert.equal(driver.latestAssistantText, "first sequential final");
  assert.equal(
    projected.filter(
      (event) =>
        event.type === "turn_complete" && event.requestTag === requestTag,
    ).length,
    1,
  );
});

test("frontend SDK fences a terminal after rollback projection fails post-mutation", async () => {
  const client = createFrontendClient();
  let requestTag = "";
  let rejectAbort!: (error: Error) => void;
  const abortOutcome = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  let releaseAck!: () => void;
  const ackOutcome = new Promise<void>((resolve) => {
    releaseAck = resolve;
  });
  let ackStarted = false;
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    requestTag = options.requestTag || "";
    return { outcome: "terminalOwner", requestTag };
  };
  client.abort = async () => {
    client.calls.push({ type: "abort" });
    await abortOutcome;
  };
  client.request = async (command: any) => {
    client.calls.push({ type: "request", command });
    if (command?.type !== "ack_turn_terminal") return { ok: true };
    ackStarted = true;
    await ackOutcome;
    return { ok: true };
  };
  const failures: any[] = [];
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
    onEventHandlingError: (failure: any) => failures.push(failure),
  });
  const projected: any[] = [];
  driver.subscribe((event: any) => projected.push(event));
  let stateMutations = 0;
  const originalUpdateFrontendStateFrom = (
    driver as any
  ).updateFrontendStateFrom.bind(driver);
  (driver as any).updateFrontendStateFrom = (event: any) => {
    if (event?.type === "turn_complete" || event?.type === "turn_error") {
      stateMutations += 1;
    }
    return originalUpdateFrontendStateFrom(event);
  };
  let projectionAttempts = 0;
  const originalProjectIgnoredTerminal = (
    driver as any
  ).projectIgnoredTerminal.bind(driver);
  (driver as any).projectIgnoredTerminal = async (terminal: any) => {
    projectionAttempts += 1;
    await originalProjectIgnoredTerminal(terminal);
    throw new Error("projection failed after terminal mutation");
  };

  const activeTurn = driver.runTurn({ text: "post-mutation failure fence" });
  await waitUntil(
    () => Boolean(requestTag && driver.liveTurn),
    "active turn did not start",
  );
  const command = driver.runCommand("/abort");
  const commandFailure = assert.rejects(command, /backend abort failed/);
  await waitUntil(
    () => client.calls.some((call: any) => call.type === "abort"),
    "backend abort did not start",
  );

  const terminalRecord = {
    terminalId: "terminal-post-mutation-projection-failure",
    state: "complete",
    terminalAt: "2026-08-06T09:06:06.000Z",
  };
  const terminalHandling = emitDriverEvent(driver, {
    type: "rpc_turn_event",
    event: "complete",
    requestTag,
    finalText: "first projected final",
    sessionFile: "/tmp/frontend-chat.jsonl",
    sessionId: "frontend-session",
    terminalRecord,
  });
  await waitUntil(() => ackStarted, "terminal ACK did not start");
  rejectAbort(new Error("backend abort failed"));
  await commandFailure;
  releaseAck();
  await assert.rejects(
    terminalHandling,
    /projection failed after terminal mutation/,
  );
  assert.equal((await activeTurn).finalText, "first projected final");

  await driver.handleClientEvent({
    type: "rpc_turn_event",
    event: "complete",
    requestTag,
    finalText: "later conflicting final",
    sessionFile: "/tmp/conflicting-session.jsonl",
    sessionId: "conflicting-session",
    terminalRecord,
  });

  assert.equal(projectionAttempts, 1);
  assert.equal(stateMutations, 1);
  assert.equal(driver.latestAssistantText, "first projected final");
  assert.equal(
    projected.filter(
      (event) =>
        event.type === "turn_complete" && event.requestTag === requestTag,
    ).length,
    1,
  );
  assert.equal(failures.length, 0);
});

test("frontend SDK starts every rollback projection before returning the backend failure", async () => {
  const client = createFrontendClient();
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  await driver.connect();
  const firstRequestTag = "parallel-rollback-first-target";
  const secondRequestTag = "parallel-rollback-second-target";
  (driver as any).pendingSubmissionSettlements.set(firstRequestTag, {
    cancel() {},
    settleTerminal() {},
  });
  const liveTurn = (driver as any).startLiveTurn(secondRequestTag);
  let releaseFirstProjection!: () => void;
  const firstProjectionGate = new Promise<void>((resolve) => {
    releaseFirstProjection = resolve;
  });
  let firstProjectionStarted = false;
  let markSecondProjectionStarted!: () => void;
  const secondProjectionStarted = new Promise<void>((resolve) => {
    markSecondProjectionStarted = resolve;
  });
  const originalProjectIgnoredTerminal = (
    driver as any
  ).projectIgnoredTerminal.bind(driver);
  (driver as any).projectIgnoredTerminal = async (terminal: any) => {
    if (terminal.requestTag === firstRequestTag) {
      firstProjectionStarted = true;
      await firstProjectionGate;
    } else if (terminal.requestTag === secondRequestTag) {
      markSecondProjectionStarted();
    }
    await originalProjectIgnoredTerminal(terminal);
  };
  client.abort = async () => {
    client.calls.push({ type: "abort" });
    for (const target of (
      driver as any
    ).backendInterruptionsByRequestTag.values()) {
      target.bufferedTerminal = {
        requestTag: target.requestTag,
        terminalId: `terminal-${target.requestTag}`,
        event: "complete",
        error: "",
        finalText: `final ${target.requestTag}`,
        terminalRecord: {
          terminalId: `terminal-${target.requestTag}`,
          state: "complete",
          terminalAt: "2026-08-06T09:06:06.475Z",
        },
      };
    }
    throw new Error("parallel rollback backend failure");
  };

  const commandOutcome = driver.runCommand("/abort").then(
    () => null,
    (error: Error) => error,
  );
  await waitUntil(
    () => firstProjectionStarted,
    "first rollback projection did not start",
  );
  const earlyOutcome = await Promise.race([
    Promise.all([secondProjectionStarted, commandOutcome]).then(
      ([, error]) => error,
    ),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
  ]);

  releaseFirstProjection();
  const finalOutcome = await commandOutcome;
  assert.equal((await liveTurn.promise).finalText, `final ${secondRequestTag}`);
  assert.match(
    finalOutcome?.message || "",
    /parallel rollback backend failure/,
  );
  assert.match(
    earlyOutcome?.message || "",
    /parallel rollback backend failure/,
    "one blocked target cannot delay later rollback attempts or the backend error",
  );
});

test("frontend SDK rollback projects every target and preserves the backend command failure", async () => {
  const client = createFrontendClient();
  const failures: any[] = [];
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
    onEventHandlingError: (failure: any) => failures.push(failure),
  });
  await driver.connect();
  const pendingRequestTag = "rollback-pending-target";
  const liveRequestTag = "rollback-live-target";
  (driver as any).pendingSubmissionSettlements.set(pendingRequestTag, {
    cancel() {},
    settleTerminal() {},
  });
  const liveTurn = (driver as any).startLiveTurn(liveRequestTag);
  const projectedRequestTags: string[] = [];
  const originalProjectIgnoredTerminal = (
    driver as any
  ).projectIgnoredTerminal.bind(driver);
  (driver as any).projectIgnoredTerminal = async (terminal: any) => {
    projectedRequestTags.push(terminal.requestTag);
    if (terminal.requestTag === pendingRequestTag) {
      throw new Error("first rollback projection failed");
    }
    await originalProjectIgnoredTerminal(terminal);
  };
  client.abort = async () => {
    client.calls.push({ type: "abort" });
    for (const target of (
      driver as any
    ).backendInterruptionsByRequestTag.values()) {
      target.bufferedTerminal = {
        requestTag: target.requestTag,
        terminalId: `terminal-${target.requestTag}`,
        event: "complete",
        error: "",
        finalText: `final ${target.requestTag}`,
        sessionFile: "/tmp/frontend-chat.jsonl",
        sessionId: "frontend-session",
        terminalRecord: {
          terminalId: `terminal-${target.requestTag}`,
          state: "complete",
          terminalAt: "2026-08-06T09:06:06.500Z",
        },
      };
    }
    throw new Error("original backend command failure");
  };

  const commandError = await driver.runCommand("/abort").then(
    () => null,
    (error: Error) => error,
  );

  assert.match(commandError?.message || "", /original backend command failure/);
  assert.deepEqual(projectedRequestTags, [pendingRequestTag, liveRequestTag]);
  assert.equal((await liveTurn.promise).finalText, `final ${liveRequestTag}`);
  assert.equal(failures.length, 1);
  assert.match(
    String(failures[0]?.error?.message || ""),
    /first rollback projection failed/,
  );
});

for (const terminalEvent of ["complete", "error"] as const) {
  test(`frontend SDK rollback settles a pending submission from its exact ${terminalEvent} terminal`, async () => {
    const client = createFrontendClient();
    let requestTag = "";
    let rejectAbort!: (error: Error) => void;
    const abortOutcome = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    client.prompt = async (text: string, options: any = {}) => {
      client.calls.push({ type: "prompt", text, options });
      requestTag = options.requestTag || "";
      await new Promise(() => {});
    };
    client.abort = async () => {
      client.calls.push({ type: "abort" });
      await abortOutcome;
    };
    const driver = new RinFrontendTurnDriver({
      clientFactory: () => client,
      promptSource: "chat-bridge",
    });
    const projected: any[] = [];
    driver.subscribe((event: any) => projected.push(event));

    const oldTurn = driver.runTurn({
      text: `pending ${terminalEvent} rollback`,
    });
    const oldOutcome = oldTurn.then(
      (value: any) => ({ value, error: null }),
      (error: Error) => ({ value: null, error }),
    );
    await waitUntil(
      () =>
        Boolean(
          requestTag &&
          (driver as any).pendingSubmissionSettlements.has(requestTag),
        ),
      "pending submission did not start",
    );
    assert.equal(driver.liveTurn, null);

    const command = driver.runCommand("/abort");
    await waitUntil(
      () => client.calls.some((call: any) => call.type === "abort"),
      "backend abort did not start",
    );
    await emitDriverEvent(driver, {
      type: "rpc_turn_event",
      event: terminalEvent,
      requestTag,
      ...(terminalEvent === "complete"
        ? { finalText: "pending rollback final" }
        : { error: "pending rollback terminal error" }),
      sessionFile: "/tmp/frontend-chat.jsonl",
      sessionId: "frontend-session",
      terminalRecord: {
        terminalId: `terminal-pending-rollback-${terminalEvent}`,
        state: terminalEvent,
        terminalAt: "2026-08-06T09:06:06.750Z",
      },
    });
    rejectAbort(new Error("pending rollback backend failure"));
    await assert.rejects(command, /pending rollback backend failure/);

    const settlement = await Promise.race([
      oldOutcome,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("pending submission waiter did not settle")),
          100,
        ),
      ),
    ]);
    if (terminalEvent === "complete") {
      assert.equal(settlement.error, null);
      assert.equal(settlement.value.finalText, "pending rollback final");
    } else {
      assert.equal(settlement.value, null);
      assert.match(
        settlement.error?.message || "",
        /pending rollback terminal error/,
      );
      assert.equal((settlement.error as any)?.rinTurnTerminal, true);
    }
    assert.equal(
      projected.filter(
        (event) =>
          event.requestTag === requestTag &&
          (event.type === "turn_complete" || event.type === "turn_error"),
      ).length,
      1,
    );
    assert.equal(
      (driver as any).pendingSubmissionSettlements.has(requestTag),
      false,
    );
    assert.equal(driver.liveTurn, null);
  });
}

test("frontend SDK fails closed on a suppressed terminal without an exact terminal id", async () => {
  const client = createFrontendClient();
  let requestTag = "";
  let releaseAbort!: () => void;
  const abortOutcome = new Promise<void>((resolve) => {
    releaseAbort = resolve;
  });
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    requestTag = options.requestTag || "";
    return { outcome: "terminalOwner", requestTag };
  };
  client.abort = async () => {
    client.calls.push({ type: "abort" });
    await abortOutcome;
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  const projected: any[] = [];
  driver.subscribe((event: any) => projected.push(event));

  const activeTurn = driver.runTurn({ text: "missing exact terminal id" });
  await waitUntil(
    () => Boolean(requestTag && driver.liveTurn),
    "active turn did not start",
  );
  const command = driver.runCommand("/abort");
  await waitUntil(
    () => client.calls.some((call: any) => call.type === "abort"),
    "backend abort did not start",
  );

  await driver.handleClientEvent({
    type: "ui",
    payload: {
      type: "rpc_turn_event",
      event: "complete",
      requestTag,
      finalText: "malformed final",
      sessionFile: "/tmp/frontend-chat.jsonl",
      sessionId: "frontend-session",
      terminalRecord: {
        state: "complete",
        terminalAt: "2026-08-06T09:06:07.000Z",
      },
    },
  });
  releaseAbort();
  await command;
  const suppressionRetained = (driver as any).ignoredTerminalRequestTags.has(
    requestTag,
  );

  await emitDriverEvent(driver, {
    type: "rpc_turn_event",
    event: "complete",
    requestTag,
    finalText: "exact final",
    sessionFile: "/tmp/frontend-chat.jsonl",
    sessionId: "frontend-session",
    terminalRecord: {
      terminalId: "terminal-after-missing-id",
      state: "complete",
      terminalAt: "2026-08-06T09:06:08.000Z",
    },
  });

  assert.equal(suppressionRetained, true);
  assert.equal((await activeTurn).finalText, "exact final");
  assert.equal(
    client.calls.some(
      (call: any) =>
        call.type === "request" &&
        call.command?.type === "ack_turn_terminal" &&
        !call.command?.terminalId,
    ),
    false,
  );
  assert.equal(
    projected.some(
      (event) =>
        (event.type === "turn_complete" || event.type === "turn_error") &&
        event.requestTag === requestTag,
    ),
    false,
  );
});

for (const backendOutcome of ["complete", "error"] as const) {
  test(`frontend SDK disposal fences generic command backend ${backendOutcome}`, async () => {
    const client = createFrontendClient();
    client.getState = async () => ({});
    let releaseBackend!: () => void;
    const backendGate = new Promise<void>((resolve) => {
      releaseBackend = resolve;
    });
    let backendStarted = false;
    client.runCommand = async (commandLine: string) => {
      client.calls.push({ type: "runCommand", commandLine });
      backendStarted = true;
      await backendGate;
      if (backendOutcome === "error") {
        throw new Error("late generic command failure");
      }
      return {
        handled: true,
        text: "stale generic command result",
        sessionId: "stale-command-session",
        sessionFile: "/tmp/stale-command-session.jsonl",
      };
    };
    const driver = new RinFrontendTurnDriver({
      clientFactory: () => client,
      promptSource: "chat-bridge",
    });
    await driver.connect();

    const command = driver.runCommand("/reload", {
      assumeConnected: true,
      assumeSessionReady: true,
      skipSessionRecovery: true,
    });
    await waitUntil(() => backendStarted, "generic command did not start");
    driver.dispose();
    const reconnected = await driver.connect();
    (driver as any).frontendState = {
      sessionId: "new-epoch-session",
      sessionFile: "/tmp/new-epoch-session.jsonl",
    };
    releaseBackend();
    const commandError = await command.then(
      () => null,
      (error: Error) => error,
    );

    assert.equal(reconnected, false);
    assert.match(commandError?.message || "", /rin_frontend_turn_cancelled/);
    assert.doesNotMatch(
      commandError?.message || "",
      /late generic command failure/,
    );
    assert.equal(driver.currentSessionId(), "new-epoch-session");
    assert.equal(driver.currentSessionFile(), "/tmp/new-epoch-session.jsonl");
  });
}

test("frontend SDK disposal fences a command that began before connection reuse", async () => {
  const client = createFrontendClient();
  const originalConnect = client.connect;
  let connectCount = 0;
  let releaseFirstConnect!: () => void;
  const firstConnectGate = new Promise<void>((resolve) => {
    releaseFirstConnect = resolve;
  });
  client.connect = async () => {
    connectCount += 1;
    if (connectCount === 1) await firstConnectGate;
    await originalConnect.call(client);
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const command = driver.runCommand("/abort");
  await waitUntil(
    () => connectCount === 1,
    "old command connect did not start",
  );
  driver.dispose();
  await driver.connect();
  releaseFirstConnect();
  const commandError = await command.then(
    () => null,
    (error: Error) => error,
  );

  assert.match(commandError?.message || "", /rin_frontend_turn_cancelled/);
  assert.equal(
    client.calls.filter((call: any) => call.type === "abort").length,
    0,
  );
});

for (const commandName of ["/abort", "/new", "/compact"] as const) {
  test(`frontend SDK disposal fences ${commandName} backend rejection`, async () => {
    const client = createFrontendClient();
    let rejectBackend!: (error: Error) => void;
    const backendOutcome = new Promise<never>((_resolve, reject) => {
      rejectBackend = reject;
    });
    let backendStarted = false;
    client.abort = async () => {
      client.calls.push({ type: "abort" });
      backendStarted = true;
      await backendOutcome;
    };
    client.newSession = async (options: any = {}) => {
      client.calls.push({ type: "newSession", options });
      backendStarted = true;
      await backendOutcome;
    };
    client.compact = async (customInstructions?: string) => {
      client.calls.push({ type: "compact", customInstructions });
      backendStarted = true;
      await backendOutcome;
    };
    const driver = new RinFrontendTurnDriver({
      clientFactory: () => client,
      promptSource: "chat-bridge",
    });
    await driver.connect();
    const requestTag = `dispose-during-${commandName.slice(1)}-rejection`;
    const liveTurn = (driver as any).startLiveTurn(requestTag);
    const liveTurnCancellation = assert.rejects(
      liveTurn.promise,
      /rin_frontend_turn_cancelled/,
    );

    const command = driver.runCommand(
      commandName,
      commandName === "/new"
        ? { assumeConnected: true, managedSessionLeaf: "chat" }
        : { assumeConnected: true },
    );
    await waitUntil(() => backendStarted, "backend command did not start");
    driver.dispose();
    const reconnected = await driver.connect();
    rejectBackend(new Error("late backend rejection"));
    const commandError = await command.then(
      () => null,
      (error: Error) => error,
    );
    await liveTurnCancellation;

    assert.equal(reconnected, false);
    assert.match(commandError?.message || "", /rin_frontend_turn_cancelled/);
    assert.doesNotMatch(commandError?.message || "", /late backend rejection/);
  });
}

for (const commandName of ["/abort", "/new"] as const) {
  test(`frontend SDK disposal fences ${commandName} while frontend state refresh is pending`, async () => {
    const client = createFrontendClient();
    let blockRefresh = false;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let refreshStarted!: () => void;
    const refreshStart = new Promise<void>((resolve) => {
      refreshStarted = resolve;
    });
    client.getState = async () => {
      if (!blockRefresh) {
        return {
          sessionId: "frontend-session",
          sessionFile: "/tmp/frontend-chat.jsonl",
        };
      }
      refreshStarted();
      await refreshGate;
      return {
        sessionId: "late-refresh-session",
        sessionFile: "/tmp/late-refresh.jsonl",
      };
    };
    client.newSession = async (options: any = {}) => {
      client.calls.push({ type: "newSession", options });
      return {
        sessionId: "new-session",
        sessionFile: "/tmp/new-session.jsonl",
      };
    };
    const driver = new RinFrontendTurnDriver({
      clientFactory: () => client,
      promptSource: "chat-bridge",
    });
    await driver.connect();
    const requestTag = `dispose-during-${commandName.slice(1)}-refresh`;
    const liveTurn = (driver as any).startLiveTurn(requestTag);
    const liveTurnCancellation = assert.rejects(
      liveTurn.promise,
      /rin_frontend_turn_cancelled/,
    );
    blockRefresh = true;

    const command = driver.runCommand(
      commandName,
      commandName === "/new"
        ? { assumeConnected: true, managedSessionLeaf: "chat" }
        : { assumeConnected: true },
    );
    await refreshStart;
    driver.dispose();
    (driver as any).frontendState = {
      sessionId: "disposed-session",
      sessionFile: "/tmp/disposed-session.jsonl",
    };
    releaseRefresh();
    const commandError = await command.then(
      () => null,
      (error: Error) => error,
    );
    await liveTurnCancellation;

    assert.match(commandError?.message || "", /rin_frontend_turn_cancelled/);
    assert.equal(driver.currentSessionId(), "disposed-session");
    assert.equal(driver.currentSessionFile(), "/tmp/disposed-session.jsonl");
  });
}

test("frontend SDK disposal in /new commit callback fences session replacement", async () => {
  const client = createFrontendClient();
  client.newSession = async (options: any = {}) => {
    client.calls.push({ type: "newSession", options });
    return {
      sessionId: "stale-new-session",
      sessionFile: "/tmp/stale-new-session.jsonl",
    };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  await driver.connect();
  const liveTurn = (driver as any).startLiveTurn(
    "dispose-inside-new-commit-callback",
  );
  const liveTurnCancellation = assert.rejects(
    liveTurn.promise,
    /rin_frontend_turn_cancelled/,
  );
  let committedCallbacks = 0;

  const command = driver.runCommand("/new", {
    assumeConnected: true,
    managedSessionLeaf: "chat",
    onActiveTurnInterruptionCommitted: () => {
      committedCallbacks += 1;
      driver.dispose();
      (driver as any).frontendState = {
        sessionId: "new-epoch-session",
        sessionFile: "/tmp/new-epoch-session.jsonl",
      };
    },
  });
  const commandError = await command.then(
    () => null,
    (error: Error) => error,
  );
  await liveTurnCancellation;

  assert.equal(committedCallbacks, 1);
  assert.match(commandError?.message || "", /rin_frontend_turn_cancelled/);
  assert.equal(driver.currentSessionId(), "new-epoch-session");
  assert.equal(driver.currentSessionFile(), "/tmp/new-epoch-session.jsonl");
});

test("frontend SDK disposal fences an ordinary terminal projection task", async () => {
  const client = createFrontendClient();
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  await driver.connect();
  const requestTag = "dispose-during-ordinary-terminal-projection";
  const liveTurn = (driver as any).startLiveTurn(requestTag);
  const liveTurnCancellation = assert.rejects(
    liveTurn.promise,
    /rin_frontend_turn_cancelled/,
  );
  let releaseProjection!: () => void;
  const projectionGate = new Promise<void>((resolve) => {
    releaseProjection = resolve;
  });
  let projectionStarted!: () => void;
  const projectionStart = new Promise<void>((resolve) => {
    projectionStarted = resolve;
  });
  driver.subscribe(async (event: any) => {
    if (event.type !== "turn_complete" || event.requestTag !== requestTag) {
      return;
    }
    projectionStarted();
    await projectionGate;
  });

  const handling = driver.handleClientEvent({
    type: "rpc_turn_event",
    event: "complete",
    requestTag,
    finalText: "ordinary dispose race final",
    sessionFile: "/tmp/frontend-chat.jsonl",
    sessionId: "frontend-session",
    terminalRecord: {
      terminalId: "terminal-dispose-ordinary-projection",
      state: "complete",
      terminalAt: "2026-08-06T09:06:08.500Z",
    },
  });
  await projectionStart;
  assert.equal((driver as any).terminalProjectionTasks.size, 1);

  driver.dispose();
  const tasksClearedAtDispose =
    (driver as any).terminalProjectionTasks.size === 0;
  releaseProjection();
  await handling;
  await liveTurnCancellation;

  assert.equal(tasksClearedAtDispose, true);
  assert.equal((driver as any).terminalProjectionTasks.size, 0);
  assert.equal((driver as any).committedTerminalProjections.size, 0);
});

test("frontend SDK disposal fences rollback before terminal projection", async () => {
  const client = createFrontendClient();
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  const projected: any[] = [];
  driver.subscribe((event: any) => projected.push(event));
  await driver.connect();
  const requestTag = "dispose-before-rollback-terminal-projection";
  const liveTurn = (driver as any).startLiveTurn(requestTag);
  const liveTurnCancellation = assert.rejects(
    liveTurn.promise,
    /rin_frontend_turn_cancelled/,
  );
  let releaseProjection!: () => void;
  const projectionGate = new Promise<void>((resolve) => {
    releaseProjection = resolve;
  });
  let projectionStarted!: () => void;
  const projectionStart = new Promise<void>((resolve) => {
    projectionStarted = resolve;
  });
  const originalProjectIgnoredTerminal = (
    driver as any
  ).projectIgnoredTerminal.bind(driver);
  (driver as any).projectIgnoredTerminal = async (
    terminal: any,
    projectionEpoch?: number,
  ) => {
    projectionStarted();
    await projectionGate;
    await originalProjectIgnoredTerminal(terminal, projectionEpoch);
  };
  client.abort = async () => {
    client.calls.push({ type: "abort" });
    const target = (driver as any).backendInterruptionsByRequestTag.get(
      requestTag,
    );
    target.bufferedTerminal = {
      requestTag,
      terminalId: "terminal-dispose-rollback-projection",
      event: "complete",
      error: "",
      finalText: "late rollback final",
      sessionFile: "/tmp/late-rollback.jsonl",
      sessionId: "late-rollback-session",
      terminalRecord: {
        terminalId: "terminal-dispose-rollback-projection",
        state: "complete",
        terminalAt: "2026-08-06T09:06:08.750Z",
      },
    };
    throw new Error("rollback backend command failure");
  };

  const command = driver.runCommand("/abort");
  await projectionStart;
  driver.dispose();
  (driver as any).frontendState = {
    sessionId: "disposed-session",
    sessionFile: "/tmp/disposed-session.jsonl",
  };
  driver.latestAssistantText = "disposed final sentinel";
  releaseProjection();
  const commandError = await command.then(
    () => null,
    (error: Error) => error,
  );
  await liveTurnCancellation;

  assert.match(commandError?.message || "", /rin_frontend_turn_cancelled/);
  assert.doesNotMatch(
    commandError?.message || "",
    /rollback backend command failure/,
  );
  assert.equal(driver.currentSessionId(), "disposed-session");
  assert.equal(driver.currentSessionFile(), "/tmp/disposed-session.jsonl");
  assert.equal(driver.latestAssistantText, "disposed final sentinel");
  assert.equal(
    projected.some(
      (event) => event.type === "turn_complete" || event.type === "turn_error",
    ),
    false,
  );
  assert.equal((driver as any).terminalProjectionTasks.size, 0);
  assert.equal((driver as any).committedTerminalProjections.size, 0);
});

test("frontend SDK disposal fences stale terminal cleanup from reused epoch state", async () => {
  const client = createFrontendClient();
  let releaseAck!: () => void;
  const ackOutcome = new Promise<void>((resolve) => {
    releaseAck = resolve;
  });
  let ackStarted = false;
  client.request = async (command: any) => {
    client.calls.push({ type: "request", command });
    if (command?.type !== "ack_turn_terminal") return { ok: true };
    ackStarted = true;
    await ackOutcome;
    return { ok: true };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  await driver.connect();
  const requestTag = "dispose-old-ack-before-reuse";
  const liveTurn = (driver as any).startLiveTurn(requestTag);
  const liveTurnCancellation = assert.rejects(
    liveTurn.promise,
    /rin_frontend_turn_cancelled/,
  );
  (driver as any).prepareActiveTurnForBackendInterruption();

  const handling = driver.handleClientEvent({
    type: "rpc_turn_event",
    event: "complete",
    requestTag,
    finalText: "old epoch terminal",
    sessionFile: "/tmp/frontend-chat.jsonl",
    sessionId: "frontend-session",
    terminalRecord: {
      terminalId: "terminal-old-ack-before-reuse",
      state: "complete",
      terminalAt: "2026-08-06T09:06:08.875Z",
    },
  });
  await waitUntil(() => ackStarted, "terminal ACK did not start");
  driver.dispose();
  await driver.connect();

  const retainedTag = "new-epoch-suppression-0000";
  for (let index = 0; index < 1025; index += 1) {
    (driver as any).ignoredTerminalRequestTags.add(
      `new-epoch-suppression-${String(index).padStart(4, "0")}`,
    );
  }
  const retainedIdentity = JSON.stringify([
    retainedTag,
    "terminal-new-epoch-retained",
  ]);
  (driver as any).acknowledgedIgnoredTerminalIdentities.add(retainedIdentity);
  releaseAck();
  await handling;
  await liveTurnCancellation;

  assert.equal((driver as any).ignoredTerminalRequestTags.size, 1025);
  assert.equal(
    (driver as any).ignoredTerminalRequestTags.has(retainedTag),
    true,
  );
  assert.equal(
    (driver as any).acknowledgedIgnoredTerminalIdentities.has(retainedIdentity),
    true,
  );
});

test("frontend SDK disposal fences a terminal handler blocked in ACK", async () => {
  const client = createFrontendClient();
  let releaseAck!: () => void;
  const ackOutcome = new Promise<void>((resolve) => {
    releaseAck = resolve;
  });
  let ackStarted = false;
  client.request = async (command: any) => {
    client.calls.push({ type: "request", command });
    if (command?.type !== "ack_turn_terminal") return { ok: true };
    ackStarted = true;
    await ackOutcome;
    return { ok: true };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  await driver.connect();
  const requestTag = "dispose-during-terminal-ack";
  (driver as any).ignoredTerminalRequestTags.add(requestTag);

  const handling = driver.handleClientEvent({
    type: "rpc_turn_event",
    event: "complete",
    requestTag,
    finalText: "dispose race final",
    sessionFile: "/tmp/frontend-chat.jsonl",
    sessionId: "frontend-session",
    terminalRecord: {
      terminalId: "terminal-dispose-during-ack",
      state: "complete",
      terminalAt: "2026-08-06T09:06:09.000Z",
    },
  });
  await waitUntil(() => ackStarted, "terminal ACK did not start");
  driver.dispose();
  releaseAck();
  await handling;

  assert.equal((driver as any).completedIgnoredTerminalIdentities.size, 0);
  assert.equal((driver as any).ignoredTerminalHandlingTasks.size, 0);
});

test("frontend SDK disposal fences late ACK and backend interruption commit", async () => {
  const client = createFrontendClient();
  let releaseAbort!: () => void;
  const abortOutcome = new Promise<void>((resolve) => {
    releaseAbort = resolve;
  });
  let releaseAck!: () => void;
  const ackOutcome = new Promise<void>((resolve) => {
    releaseAck = resolve;
  });
  let abortStarted = false;
  let ackStarted = false;
  client.abort = async () => {
    client.calls.push({ type: "abort" });
    abortStarted = true;
    await abortOutcome;
  };
  client.request = async (command: any) => {
    client.calls.push({ type: "request", command });
    if (command?.type !== "ack_turn_terminal") return { ok: true };
    ackStarted = true;
    await ackOutcome;
    return { ok: true };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  const projected: any[] = [];
  driver.subscribe((event: any) => projected.push(event));
  await driver.connect();
  const requestTag = "dispose-pending-backend-interruption";
  const liveTurn = (driver as any).startLiveTurn(requestTag);
  const liveTurnCancellation = assert.rejects(
    liveTurn.promise,
    /rin_frontend_turn_cancelled/,
  );
  let committedCallbacks = 0;
  const interruptionSeq = (driver as any).turnInterruptionSeq;
  const command = driver.runCommand("/abort", {
    onActiveTurnInterruptionCommitted: () => {
      committedCallbacks += 1;
    },
  });
  await waitUntil(() => abortStarted, "backend abort did not start");

  const handling = driver.handleClientEvent({
    type: "rpc_turn_event",
    event: "complete",
    requestTag,
    finalText: "late dispose final",
    sessionFile: "/tmp/frontend-chat.jsonl",
    sessionId: "frontend-session",
    terminalRecord: {
      terminalId: "terminal-dispose-pending-backend-interruption",
      state: "complete",
      terminalAt: "2026-08-06T09:06:09.500Z",
    },
  });
  await waitUntil(() => ackStarted, "terminal ACK did not start");

  driver.dispose();
  releaseAck();
  releaseAbort();
  await handling;
  await liveTurnCancellation;
  const commandError = await command.then(
    () => null,
    (error: Error) => error,
  );

  assert.match(commandError?.message || "", /rin_frontend_turn_cancelled/);
  assert.equal((driver as any).turnInterruptionSeq, interruptionSeq);
  assert.equal(committedCallbacks, 0);
  assert.equal((driver as any).ignoredTerminalRequestTags.size, 0);
  assert.equal((driver as any).acknowledgedIgnoredTerminalIdentities.size, 0);
  assert.equal((driver as any).ignoredTerminalAckTasks.size, 0);
  assert.equal((driver as any).ignoredTerminalHandlingTasks.size, 0);
  assert.equal((driver as any).backendInterruptionsByRequestTag.size, 0);
  assert.equal((driver as any).completedIgnoredTerminalIdentities.size, 0);
  assert.equal(driver.latestAssistantText, "");
  assert.equal(
    projected.some(
      (event) => event.type === "turn_complete" || event.type === "turn_error",
    ),
    false,
  );
});

test("frontend SDK retains successful terminal ACKs by exact identity", async () => {
  const client = createFrontendClient();
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  await driver.connect();
  const requestTag = "exact-ack-retention-request";
  (driver as any).ignoredTerminalRequestTags.add(requestTag);

  for (const terminalId of [
    "terminal-exact-ack-a",
    "terminal-exact-ack-b",
    "terminal-exact-ack-a",
  ]) {
    await emitDriverEvent(driver, {
      type: "rpc_turn_event",
      event: "complete",
      requestTag,
      finalText: terminalId,
      sessionFile: "/tmp/frontend-chat.jsonl",
      sessionId: "frontend-session",
      terminalRecord: {
        terminalId,
        state: "complete",
        terminalAt: "2026-08-06T09:06:09.250Z",
      },
    });
  }

  assert.deepEqual(
    client.calls
      .filter(
        (call: any) =>
          call.type === "request" && call.command?.type === "ack_turn_terminal",
      )
      .map((call: any) => call.command.terminalId),
    ["terminal-exact-ack-a", "terminal-exact-ack-b"],
  );
});

test("frontend SDK retains successful ACK identities only after exact handling completes", async () => {
  const client = createFrontendClient();
  let releaseAcks!: () => void;
  const ackGate = new Promise<void>((resolve) => {
    releaseAcks = resolve;
  });
  let acknowledgementsStarted = 0;
  client.request = async (command: any) => {
    client.calls.push({ type: "request", command });
    if (command?.type === "ack_turn_terminal") {
      acknowledgementsStarted += 1;
      await ackGate;
    }
    return { ok: true };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  await driver.connect();

  const requestTags = Array.from(
    { length: 1025 },
    (_, index) => `ack-before-completion-${index}`,
  );
  for (const requestTag of requestTags) {
    (driver as any).pendingSubmissionSettlements.set(requestTag, {
      cancel() {},
      settleTerminal() {},
    });
  }
  const interruption = (
    driver as any
  ).prepareActiveTurnForBackendInterruption();
  let releaseProjections!: () => void;
  const projectionGate = new Promise<void>((resolve) => {
    releaseProjections = resolve;
  });
  let projectionsStarted = 0;
  (driver as any).projectIgnoredTerminal = async () => {
    projectionsStarted += 1;
    await projectionGate;
  };

  const handlings = requestTags.map((requestTag, index) =>
    driver.handleClientEvent({
      type: "rpc_turn_event",
      event: "complete",
      requestTag,
      finalText: `ack retention ${index}`,
      terminalRecord: {
        terminalId: `terminal-ack-before-completion-${index}`,
        state: "complete",
        terminalAt: "2026-08-06T09:06:09.750Z",
      },
    }),
  );
  await waitUntil(
    () => acknowledgementsStarted === requestTags.length,
    "terminal ACKs did not start",
  );
  await (driver as any).rollbackBackendInterruption(interruption);
  releaseAcks();
  await waitUntil(
    () => projectionsStarted === requestTags.length,
    "rollback projections did not start",
  );

  assert.equal(
    (driver as any).acknowledgedIgnoredTerminalIdentities.size,
    0,
    "successful ACK retention must wait for exact handling completion",
  );
  assert.equal((driver as any).completedIgnoredTerminalIdentities.size, 0);

  releaseProjections();
  await Promise.all(handlings);
  assert.equal((driver as any).completedIgnoredTerminalIdentities.size, 1024);
  assert.equal(
    (driver as any).acknowledgedIgnoredTerminalIdentities.size,
    1024,
  );
  for (const identity of (driver as any)
    .acknowledgedIgnoredTerminalIdentities) {
    assert.equal(
      (driver as any).completedIgnoredTerminalIdentities.has(identity),
      true,
    );
  }
});

test("frontend SDK bounds committed terminal projection identities", async () => {
  const client = createFrontendClient();
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  await driver.connect();

  for (let index = 0; index < 1025; index += 1) {
    await driver.projectAuthoritativeTerminal({
      type: "rpc_turn_event",
      event: "complete",
      requestTag: `projection-retention-${index}`,
      finalText: `projection ${index}`,
      terminalRecord: {
        terminalId: `terminal-projection-retention-${index}`,
        state: "complete",
        terminalAt: "2026-08-06T09:06:09.500Z",
      },
    });
  }

  assert.equal((driver as any).committedTerminalProjections.size, 1024);
  assert.equal(
    (driver as any).committedTerminalProjections.has(
      "request:projection-retention-0",
    ),
    false,
  );
  assert.equal(
    (driver as any).committedTerminalProjections.has(
      "request:projection-retention-1024",
    ),
    true,
  );
});

test("frontend SDK bounds completed terminal identities and clears them on dispose", async () => {
  const client = createFrontendClient();
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  await driver.connect();

  for (let index = 0; index < 1025; index += 1) {
    const requestTag = `cleanup-request-${index}`;
    (driver as any).ignoredTerminalRequestTags.add(requestTag);
    await driver.handleClientEvent({
      type: "rpc_turn_event",
      event: "complete",
      requestTag,
      finalText: `cleanup final ${index}`,
      sessionFile: "/tmp/frontend-chat.jsonl",
      sessionId: "frontend-session",
      terminalRecord: {
        terminalId: `cleanup-terminal-${index}`,
        state: "complete",
        terminalAt: "2026-08-06T09:06:10.000Z",
      },
    });
  }

  assert.equal((driver as any).completedIgnoredTerminalIdentities.size, 1024);
  assert.equal(
    (driver as any).completedIgnoredTerminalIdentities.has(
      JSON.stringify(["cleanup-request-0", "cleanup-terminal-0"]),
    ),
    false,
  );
  assert.equal(
    (driver as any).completedIgnoredTerminalIdentities.has(
      JSON.stringify(["cleanup-request-1024", "cleanup-terminal-1024"]),
    ),
    true,
  );
  assert.equal(
    (driver as any).acknowledgedIgnoredTerminalIdentities.size,
    1024,
  );
  assert.equal(
    (driver as any).acknowledgedIgnoredTerminalIdentities.has(
      JSON.stringify(["cleanup-request-0", "cleanup-terminal-0"]),
    ),
    false,
  );
  assert.equal(
    (driver as any).acknowledgedIgnoredTerminalIdentities.has(
      JSON.stringify(["cleanup-request-1024", "cleanup-terminal-1024"]),
    ),
    true,
  );

  driver.dispose();
  assert.equal((driver as any).completedIgnoredTerminalIdentities.size, 0);
});

test("frontend SDK preserves the old turn and Working when backend /new is cancelled", async () => {
  const client = createFrontendClient();
  let requestTag = "";
  client.getState = async () => ({
    sessionFile: "/tmp/frontend-chat.jsonl",
    sessionId: "frontend-session",
    isStreaming: false,
    working: true,
  });
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    requestTag = options.requestTag || "";
    return { outcome: "terminalOwner", requestTag };
  };
  client.newSession = async (options: any = {}) => {
    client.calls.push({ type: "newSession", options });
    return { cancelled: true };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  const projected: any[] = [];
  driver.subscribe((event: any) => projected.push(event));

  const activeTurn = driver.runTurn({ text: "preserve cancelled new" });
  await waitUntil(
    () => Boolean(requestTag && driver.liveTurn),
    "active turn did not start",
  );
  const oldLiveTurn = driver.liveTurn;
  const interruptionSeq = (driver as any).turnInterruptionSeq;

  const commandResult = await driver.runCommand("/new", {
    managedSessionLeaf: "chat",
  });
  assert.equal(commandResult.cancelled, true);
  assert.equal(driver.liveTurn, oldLiveTurn);
  assert.equal((driver as any).turnInterruptionSeq, interruptionSeq);
  assert.equal(driver.isWorking(), true);
  assert.equal(
    (driver as any).ignoredTerminalRequestTags.has(requestTag),
    false,
  );

  await emitDriverEvent(driver, {
    type: "rpc_turn_event",
    event: "complete",
    requestTag,
    finalText: "completed after cancelled new",
    sessionFile: "/tmp/frontend-chat.jsonl",
    sessionId: "frontend-session",
    terminalRecord: {
      terminalId: "terminal-cancelled-new-complete",
      state: "complete",
      terminalAt: "2026-08-06T09:06:15.000Z",
    },
  });
  assert.equal((await activeTurn).finalText, "completed after cancelled new");
  assert.equal(
    projected.filter(
      (event) =>
        event.type === "turn_complete" && event.requestTag === requestTag,
    ).length,
    1,
  );
});

test("frontend SDK preserves the old turn and Working when /abort disconnects", async () => {
  const client = createFrontendClient();
  let requestTag = "";
  client.getState = async () => ({
    sessionFile: "/tmp/frontend-chat.jsonl",
    sessionId: "frontend-session",
    isStreaming: false,
    working: true,
  });
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    requestTag = options.requestTag || "";
    return { outcome: "terminalOwner", requestTag };
  };
  client.abort = async () => {
    client.calls.push({ type: "abort" });
    throw new Error("rin_disconnected");
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  const projected: any[] = [];
  driver.subscribe((event: any) => projected.push(event));

  const activeTurn = driver.runTurn({ text: "preserve disconnected abort" });
  await waitUntil(
    () => Boolean(requestTag && driver.liveTurn),
    "active turn did not start",
  );
  const oldLiveTurn = driver.liveTurn;
  const interruptionSeq = (driver as any).turnInterruptionSeq;

  await assert.rejects(driver.runCommand("/abort"), /rin_disconnected/);
  assert.equal(driver.liveTurn, oldLiveTurn);
  assert.equal((driver as any).turnInterruptionSeq, interruptionSeq);
  assert.equal(driver.isWorking(), true);
  assert.equal(
    (driver as any).ignoredTerminalRequestTags.has(requestTag),
    false,
  );

  await emitDriverEvent(driver, {
    type: "rpc_turn_event",
    event: "complete",
    requestTag,
    finalText: "completed after disconnected abort",
    sessionFile: "/tmp/frontend-chat.jsonl",
    sessionId: "frontend-session",
    terminalRecord: {
      terminalId: "terminal-disconnected-abort-complete",
      state: "complete",
      terminalAt: "2026-08-06T09:06:20.000Z",
    },
  });
  assert.equal(
    (await activeTurn).finalText,
    "completed after disconnected abort",
  );
  assert.equal(
    projected.filter(
      (event) =>
        event.type === "turn_complete" && event.requestTag === requestTag,
    ).length,
    1,
  );
});

test("frontend SDK ignores a sequential conflicting complete after committed interruption", async () => {
  const client = createFrontendClient();
  let requestTag = "";
  let releaseAbort!: () => void;
  const abortOutcome = new Promise<void>((resolve) => {
    releaseAbort = resolve;
  });
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    requestTag = options.requestTag || "";
    return { outcome: "terminalOwner", requestTag };
  };
  client.abort = async () => {
    client.calls.push({ type: "abort" });
    await abortOutcome;
  };
  client.request = async (command: any) => {
    client.calls.push({ type: "request", command });
    return { ok: true };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  const projected: any[] = [];
  driver.subscribe((event: any) => projected.push(event));

  const activeTurn = driver.runTurn({ text: "committed complete duplicate" });
  await waitUntil(
    () => Boolean(requestTag && driver.liveTurn),
    "active turn did not start",
  );
  const command = driver.runCommand("/abort");
  await waitUntil(
    () => client.calls.some((call: any) => call.type === "abort"),
    "backend abort did not start",
  );

  const terminalRecord = {
    terminalId: "terminal-committed-sequential-complete",
    state: "complete",
    terminalAt: "2026-08-06T09:06:25.000Z",
  };
  await driver.handleClientEvent({
    type: "ui",
    payload: {
      type: "rpc_turn_event",
      event: "complete",
      requestTag,
      finalText: "first committed final",
      sessionFile: "/tmp/frontend-chat.jsonl",
      sessionId: "frontend-session",
      terminalRecord,
    },
  });
  releaseAbort();
  await command;
  assert.equal((await activeTurn).finalText, "first committed final");
  assert.equal(driver.latestAssistantText, "first committed final");
  const sessionFile = driver.currentSessionFile();

  await driver.handleClientEvent({
    type: "rpc_turn_event",
    event: "complete",
    requestTag,
    finalText: "later committed final",
    sessionFile: "/tmp/conflicting-session.jsonl",
    sessionId: "conflicting-session",
    terminalRecord,
  });
  assert.equal(driver.latestAssistantText, "first committed final");
  assert.equal(driver.currentSessionFile(), sessionFile);
  assert.equal(
    projected.some(
      (event) =>
        event.type === "turn_complete" && event.requestTag === requestTag,
    ),
    false,
  );
});

test("frontend SDK /new lets daemon new_session own active-turn interruption", async () => {
  const client = createFrontendClient();
  let requestTag = "";
  let activeTurnSettled = false;
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    requestTag = options.requestTag || "";
    await new Promise(() => {});
  };
  client.abort = async () => {
    client.calls.push({ type: "abort" });
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const activeTurn = driver.runTurn({ text: "still running" });
  void activeTurn.then(
    () => {
      activeTurnSettled = true;
    },
    () => {
      activeTurnSettled = true;
    },
  );
  await waitUntil(() => Boolean(requestTag), "active turn did not start");

  const result = await driver.runCommand("/new", {
    managedSessionLeaf: "chat",
  });
  const newSessionFile = driver.currentSessionFile();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.text, "Started a new session.");
  assert.equal(activeTurnSettled, false);
  assert.deepEqual(
    client.calls
      .filter((call: any) => ["abort", "newSession"].includes(call.type))
      .map((call: any) => call.type),
    ["newSession"],
  );

  await emitDriverEvent(driver, {
    type: "rpc_turn_event",
    event: "error",
    requestTag,
    error: "Request was aborted",
    sessionFile: "/tmp/frontend-chat.jsonl",
    sessionId: "frontend-session",
    terminalRecord: {
      terminalId: "terminal-new-session-abort",
      state: "error",
      terminalAt: "2026-08-06T08:48:00.000Z",
    },
  });

  await assert.rejects(activeTurn, /Request was aborted/);
  assert.equal(driver.currentSessionFile(), newSessionFile);
});

test("frontend SDK restores ordinary terminal handling when backend /new fails", async () => {
  const client = createFrontendClient();
  let requestTag = "";
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    requestTag = options.requestTag || "";
    return { outcome: "terminalOwner", requestTag };
  };
  client.newSession = async (options: any = {}) => {
    client.calls.push({ type: "newSession", options });
    throw new Error("backend new session rejected");
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  const projected: any[] = [];
  driver.subscribe((event: any) => projected.push(event));

  const activeTurn = driver.runTurn({ text: "keep old session" });
  await waitUntil(
    () => Boolean(requestTag && driver.liveTurn),
    "active turn did not start",
  );

  const interruptionSeq = (driver as any).turnInterruptionSeq;
  await assert.rejects(
    driver.runCommand("/new", { managedSessionLeaf: "chat" }),
    /backend new session rejected/,
  );
  assert.equal((driver as any).turnInterruptionSeq, interruptionSeq);
  assert.equal(
    (driver as any).ignoredTerminalRequestTags.has(requestTag),
    false,
  );
  await emitDriverEvent(driver, {
    type: "rpc_turn_event",
    event: "complete",
    requestTag,
    finalText: "completed after rejected new session",
    sessionFile: "/tmp/frontend-chat.jsonl",
    sessionId: "frontend-session",
    terminalRecord: {
      terminalId: "terminal-rejected-new-complete",
      state: "complete",
      terminalAt: "2026-08-06T09:06:00.000Z",
    },
  });

  assert.equal(
    (await activeTurn).finalText,
    "completed after rejected new session",
  );
  assert.equal(
    projected.some(
      (event) =>
        event.type === "turn_complete" && event.requestTag === requestTag,
    ),
    true,
    "a rejected backend new_session must not suppress the old terminal",
  );
});

test("frontend SDK settles a pending old completion after the new-session turn starts", async () => {
  const client = createFrontendClient();
  let oldRequestTag = "";
  let newRequestTag = "";
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    if (text === "old pending admission") {
      oldRequestTag = options.requestTag || "";
      await new Promise(() => {});
    }
    newRequestTag = options.requestTag || "";
    return { outcome: "terminalOwner", requestTag: newRequestTag };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  const projected: any[] = [];
  driver.subscribe((event: any) => projected.push(event));

  const oldTurn = driver.runTurn({ text: "old pending admission" });
  await waitUntil(() => Boolean(oldRequestTag), "old admission did not start");
  await driver.runCommand("/new", { managedSessionLeaf: "chat" });

  const newTurn = driver.runTurn({ text: "new session turn" });
  await waitUntil(
    () =>
      Boolean(newRequestTag && driver.liveTurn?.requestTag === newRequestTag),
    "new-session turn did not become live",
  );

  await emitDriverEvent(driver, {
    type: "rpc_turn_event",
    event: "complete",
    requestTag: oldRequestTag,
    finalText: "old completion won the race",
    sessionFile: "/tmp/frontend-chat.jsonl",
    sessionId: "frontend-session",
    terminalRecord: {
      terminalId: "terminal-old-pending-complete",
      state: "complete",
      terminalAt: "2026-08-06T09:07:00.000Z",
    },
  });

  const oldResult = await Promise.race([
    oldTurn,
    new Promise<never>((_resolve, reject) =>
      setTimeout(
        () => reject(new Error("old requestTag waiter did not settle")),
        100,
      ),
    ),
  ]);
  assert.equal(oldResult.finalText, "old completion won the race");
  assert.equal(
    projected.some(
      (event) =>
        event.type === "turn_complete" && event.requestTag === oldRequestTag,
    ),
    false,
  );

  await emitDriverEvent(driver, {
    type: "rpc_turn_event",
    event: "complete",
    requestTag: newRequestTag,
    finalText: "new session final",
    sessionFile: "/tmp/frontend-managed.jsonl",
    sessionId: "frontend-session",
  });
  assert.equal((await newTurn).finalText, "new session final");
});

for (const oldTerminalEvent of ["complete", "error"] as const) {
  test(`frontend SDK fences a retried admitted old ${oldTerminalEvent} terminal from a newer public turn`, async () => {
    const client = createFrontendClient();
    let sessionFile = "/tmp/frontend-chat.jsonl";
    let oldRequestTag = "";
    let newRequestTag = "";
    let reportStaleOldActive = false;
    client.getState = async () => ({
      sessionFile,
      sessionId: "frontend-session",
      isStreaming: reportStaleOldActive,
      turnActive: reportStaleOldActive,
      ...(reportStaleOldActive ? { requestTag: oldRequestTag } : {}),
    });
    client.newSession = async (options: any = {}) => {
      client.calls.push({ type: "newSession", options });
      sessionFile = "/tmp/frontend-managed.jsonl";
      return { cancelled: false, sessionFile, sessionId: "frontend-session" };
    };
    client.prompt = async (text: string, options: any = {}) => {
      client.calls.push({ type: "prompt", text, options });
      if (text === "admitted old turn") {
        oldRequestTag = options.requestTag || "";
        return { outcome: "terminalOwner", requestTag: oldRequestTag };
      }
      newRequestTag = options.requestTag || "";
      return { outcome: "terminalOwner", requestTag: newRequestTag };
    };
    const driver = new RinFrontendTurnDriver({
      clientFactory: () => client,
      promptSource: "chat-bridge",
    });

    const oldTurn = driver.runTurn({ text: "admitted old turn" });
    const oldSettlement = oldTurn.then(
      (value: any) => ({ kind: "complete" as const, value }),
      (error: Error) => ({ kind: "error" as const, error }),
    );
    await waitUntil(
      () =>
        Boolean(
          oldRequestTag &&
          client.calls.some(
            (call: any) =>
              call.type === "request" &&
              call.command?.type === "await_turn_terminal" &&
              call.command?.requestTag === oldRequestTag,
          ),
        ),
      "admitted old waiter did not start",
    );
    await driver.runCommand("/new", { managedSessionLeaf: "chat" });

    const oldTerminal = {
      type: "rpc_turn_event",
      event: oldTerminalEvent,
      requestTag: oldRequestTag,
      ...(oldTerminalEvent === "complete"
        ? { finalText: "exact old final" }
        : { error: "exact old failure" }),
      sessionFile: "/tmp/frontend-chat.jsonl",
      sessionId: "frontend-session",
      terminalRecord: {
        terminalId: `terminal-admitted-old-${oldTerminalEvent}`,
        state: oldTerminalEvent,
        terminalAt: "2026-08-06T09:08:00.000Z",
      },
    };
    await emitDriverEvent(driver, oldTerminal);

    const settledOld = await Promise.race([
      oldSettlement,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () =>
            reject(new Error("admitted old requestTag waiter did not settle")),
          100,
        ),
      ),
    ]);
    assert.equal(settledOld.kind, oldTerminalEvent);
    if (settledOld.kind === "complete") {
      assert.equal(settledOld.value.finalText, "exact old final");
    } else {
      assert.match(settledOld.error.message, /exact old failure/);
    }

    reportStaleOldActive = true;
    const newTurn = driver.runTurn({ text: "new public turn" });
    let newTurnSettled = false;
    void newTurn.then(
      () => {
        newTurnSettled = true;
      },
      () => {
        newTurnSettled = true;
      },
    );
    await waitUntil(
      () =>
        Boolean(
          newRequestTag &&
          client.calls.some(
            (call: any) =>
              call.type === "request" &&
              call.command?.type === "await_turn_terminal" &&
              call.command?.requestTag === newRequestTag,
          ),
        ),
      "new public waiter did not start",
    );

    await emitDriverEvent(driver, oldTerminal);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      newTurnSettled,
      false,
      `retried old ${oldTerminalEvent} settled the newer public waiter`,
    );

    reportStaleOldActive = false;
    await emitDriverEvent(driver, {
      type: "rpc_turn_event",
      event: "complete",
      requestTag: newRequestTag,
      finalText: "new public final",
      sessionFile,
      sessionId: "frontend-session",
      terminalRecord: {
        terminalId: "terminal-new-public-complete",
        state: "complete",
        terminalAt: "2026-08-06T09:09:00.000Z",
      },
    });
    assert.equal((await newTurn).finalText, "new public final");
  });
}

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

test("frontend SDK displays only the backend Working decision", async () => {
  const client = createFrontendClient();
  client.getState = async () => ({
    sessionFile: "/tmp/frontend-chat.jsonl",
    sessionId: "frontend-session",
    isStreaming: false,
    turnActive: false,
    isCompacting: true,
    sessionRecovering: true,
    working: false,
  });
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  await driver.connect();

  assert.equal(driver.hasActiveTurn(), false);
  assert.equal(driver.isWorking(), false);
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
    return { outcome: "terminalOwner", requestTag: options.requestTag };
  };

  let settled = false;
  const pending = driver
    .runTurn({
      text: "current turn",
      requestTag: "current-request-tag",
    })
    .finally(() => {
      settled = true;
    });
  await waitUntil(
    () => client.calls.some((call: any) => call.type === "prompt"),
    "current prompt did not start",
  );
  await emitDriverEvent(driver, {
    type: "rpc_turn_event",
    event: "start",
    requestTag: "current-request-tag",
    working: true,
  });
  assert.equal(driver.isWorking(), true);

  await emitRpcTurnComplete(driver, "stale-request-tag", "stale final");
  assert.equal(settled, false, "stale terminal settled the current turn");
  assert.equal(driver.isWorking(), true);

  await emitRpcTurnComplete(driver, "current-request-tag", "current final");
  assert.equal((await pending).finalText, "current final");
});

test("frontend SDK settles Pi-native steering without taking terminal ownership", async () => {
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
    return { outcome: "nonterminal" };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  const events: any[] = [];
  const acceptanceOrder: string[] = [];
  let releaseAcceptance!: () => void;
  const acceptanceGate = new Promise<void>((resolve) => {
    releaseAcceptance = resolve;
  });
  driver.subscribe((event: any) => {
    events.push(event);
    if (event.type === "turn_accepted") acceptanceOrder.push("event");
  });

  const pending = driver.runTurn({
    text: "restored job",
    requestTag: "nonterminal-input",
    streamingBehavior: "steer",
    promptContext: { source: "chat-bridge", chatKey: "telegram/1:2" },
    commitNonterminalAcceptance: async (acceptance: any) => {
      assert.equal(acceptance.requestTag, "nonterminal-input");
      assert.equal(acceptance.sessionFile, "/tmp/frontend-chat.jsonl");
      acceptanceOrder.push("commit-start");
      await acceptanceGate;
      acceptanceOrder.push("commit");
    },
  });
  await waitUntil(
    () => client.calls.some((call: any) => call.type === "prompt"),
    "ordinary submission did not reach backend",
  );
  let settled = false;
  const observed = pending.then((result: any) => {
    settled = true;
    return result;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(acceptanceOrder, ["commit-start"]);
  assert.equal(
    events.some((event) => event.type === "turn_accepted"),
    false,
  );
  releaseAcceptance();
  const result = await withTimeout(
    observed,
    250,
    "Pi-native steering admission did not settle",
  );
  assert.equal(result.outcome, "nonterminal");
  assert.equal(result.superseded, true);
  assert.equal(result.finalText, undefined);
  assert.deepEqual(events, [
    { type: "frontend_status", phase: "sending" },
    { type: "turn_accepted", requestTag: "nonterminal-input" },
  ]);
  assert.deepEqual(acceptanceOrder, ["commit-start", "commit", "event"]);
  const promptCall = client.calls.find((call: any) => call.type === "prompt");
  assert.equal(promptCall.text, "restored job");
  assert.equal(promptCall.options.streamingBehavior, "steer");
});

test("frontend SDK retries an uncommitted nonterminal acceptance as a native rejoin", async () => {
  const client = createFrontendClient();
  let submission = 0;
  client.getState = async () => ({
    sessionFile: "/tmp/frontend-chat.jsonl",
    sessionId: "frontend-session",
    isStreaming: true,
    turnActive: true,
    requestTag: "backend-terminal-owner",
  });
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    submission += 1;
    return submission === 1
      ? { outcome: "nonterminal", requestTag: options.requestTag }
      : {
          outcome: "rejoined",
          originalOutcome: "nonterminal",
          requestTag: options.requestTag,
        };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  const events: any[] = [];
  driver.subscribe((event: any) => events.push(event));

  await assert.rejects(
    driver.runTurn({
      text: "joined input",
      requestTag: "stable-nonterminal-input",
      commitNonterminalAcceptance: async () => {
        throw new Error("simulated_acceptance_commit_crash");
      },
    }),
    /simulated_acceptance_commit_crash/,
  );
  assert.equal(
    events.some((event) => event.type === "turn_accepted"),
    false,
  );

  let committed = 0;
  const result = await driver.runTurn({
    text: "joined input",
    requestTag: "stable-nonterminal-input",
    commitNonterminalAcceptance: async () => {
      committed += 1;
    },
  });
  assert.equal(result.outcome, "rejoined");
  assert.equal(result.originalOutcome, "nonterminal");
  assert.equal(committed, 1);
  assert.equal(
    events.filter((event) => event.type === "turn_accepted").length,
    1,
  );
  assert.equal(
    client.calls.filter((call: any) => call.type === "prompt").length,
    2,
  );
});

test("frontend SDK rejects a missing Pi admission instead of assuming prompt", async () => {
  const client = createFrontendClient();
  client.prompt = async () => undefined;
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  await assert.rejects(
    driver.submitTurn({ text: "missing admission" }),
    /rin_prompt_outcome_invalid/,
  );
});

test("frontend SDK lets Pi classify steering through the ordinary prompt RPC", async () => {
  const client = createFrontendClient();
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    return { outcome: "nonterminal", requestTag: options.requestTag };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  await driver.submitTurn({
    text: "steer now",
    streamingBehavior: "steer",
    requestTag: "tag-steer",
    promptContext: { source: "chat-bridge", chatKey: "telegram/1:2" },
  });

  const promptCall = client.calls.find((call: any) => call.type === "prompt");
  assert.ok(promptCall);
  assert.equal(promptCall.options.streamingBehavior, "steer");
  assert.equal(promptCall.options.requestTag, "tag-steer");
});

test("frontend SDK exposes native rejection without waiting for a terminal", async () => {
  const client = createFrontendClient();
  client.prompt = async (_text: string, options: any = {}) => ({
    outcome: "rejected",
    requestTag: options.requestTag,
  });
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const result = await driver.runTurn({
    text: "rejected input",
    requestTag: "tag-rejected",
  });

  assert.equal(result.outcome, "rejected");
  assert.equal(result.superseded, true);
  assert.equal(result.requestTag, "tag-rejected");
});

test("frontend SDK continues a rejoined indeterminate outcome without resubmission", async () => {
  const client = createFrontendClient();
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    return {
      outcome: "rejoined",
      originalOutcome: "indeterminate",
      requestTag: options.requestTag,
    };
  };
  client.request = async (command: any) => {
    client.calls.push({ type: "request", command });
    if (command.type !== "await_turn_terminal") return { ok: true };
    return {
      type: "rpc_turn_event",
      event: "complete",
      requestTag: command.requestTag,
      finalText: "durable continuation result",
      terminalRecord: {
        terminalId: "terminal-ambiguous",
        state: "complete",
        terminalAt: "2026-08-10T09:34:53.118Z",
      },
    };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const result = await driver.runTurn({
    text: "ambiguous input",
    requestTag: "tag-ambiguous",
  });
  assert.equal(result.finalText, "durable continuation result");
  assert.equal(
    client.calls.filter((call: any) => call.type === "prompt").length,
    1,
  );
  assert.equal(
    client.calls.filter(
      (call: any) => call.command?.type === "await_turn_terminal",
    ).length,
    1,
  );
});

test("frontend SDK waits for an existing local turn before continuing an indeterminate submission", async () => {
  const client = createFrontendClient();
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    return {
      outcome: "rejoined",
      originalOutcome: "indeterminate",
      requestTag: options.requestTag,
    };
  };
  client.request = async (command: any) => {
    client.calls.push({ type: "request", command });
    if (command.type !== "await_turn_terminal") return { ok: true };
    return {
      type: "rpc_turn_event",
      event: "complete",
      requestTag: command.requestTag,
      finalText: "continued after local turn",
      terminalRecord: {
        terminalId: "terminal-after-local-turn",
        state: "complete",
        terminalAt: "2026-08-10T09:34:53.118Z",
      },
    };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  const existing = (driver as any).startLiveTurn("tag-existing-local");

  const pending = driver.runTurn({
    text: "ambiguous input",
    requestTag: "tag-after-local",
  });
  await waitUntil(
    () => client.calls.some((call: any) => call.type === "prompt"),
    "indeterminate submission did not reach backend",
  );
  await emitRpcTurnComplete(
    driver,
    "tag-existing-local",
    "existing local final",
  );
  await existing.promise;

  const result = await pending;
  assert.equal(result.finalText, "continued after local turn");
});

test("frontend SDK continues a thrown indeterminate submission without replaying it", async () => {
  const client = createFrontendClient();
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    throw new Error("rin_prompt_outcome_indeterminate");
  };
  client.request = async (command: any) => {
    client.calls.push({ type: "request", command });
    if (command.type !== "await_turn_terminal") return { ok: true };
    return {
      type: "rpc_turn_event",
      event: "complete",
      requestTag: command.requestTag,
      finalText: "continued after uncertain transport",
      terminalRecord: {
        terminalId: "terminal-thrown-ambiguous",
        state: "complete",
        terminalAt: "2026-08-10T09:34:53.118Z",
      },
    };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const result = await driver.runTurn({
    text: "ambiguous input",
    requestTag: "tag-thrown-ambiguous",
  });
  assert.equal(result.finalText, "continued after uncertain transport");
  assert.equal(
    client.calls.filter((call: any) => call.type === "prompt").length,
    1,
  );
  assert.equal(
    client.calls.filter(
      (call: any) => call.command?.type === "await_turn_terminal",
    ).length,
    1,
  );
});

test("frontend SDK runTurn settles when Pi reports nonterminal admission without a prior local turn", async () => {
  const client = createFrontendClient();
  client.prompt = async (_text: string, options: any = {}) => ({
    outcome: "nonterminal",
    requestTag: options.requestTag,
  });
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const result = await Promise.race([
    driver.runTurn({
      text: "remote steering",
      streamingBehavior: "steer",
      requestTag: "tag-remote-steer",
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("runTurn hung")), 250),
    ),
  ]);

  assert.equal(result.outcome, "nonterminal");
  assert.equal(result.superseded, true);
});

test("frontend SDK turn driver leaves terminal ownership with the backend after a queued steer starts", async () => {
  const driver = createDriver();
  const client = (driver as any).testClient;
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
    return { outcome: "terminalOwner", requestTag: options.requestTag };
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
  await emitRpcTurnComplete(driver, "tag-first", "steered final");

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
    return { outcome: "nonterminal", requestTag: options.requestTag };
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

test("frontend SDK accepts Pi-native steering during a backend tool gap", async () => {
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
    return { outcome: "nonterminal" };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const pending = driver.runTurn({
    text: "input between tools",
    streamingBehavior: "steer",
    promptContext: { source: "chat-bridge", chatKey: "telegram/1:2" },
  });
  await waitUntil(
    () => client.calls.some((call: any) => call.type === "prompt"),
    "ordinary tool-gap input did not reach backend",
  );
  const result = await pending;
  assert.equal(result.outcome, "nonterminal");
  assert.equal(result.superseded, true);
  const promptCall = client.calls.find((call: any) => call.type === "prompt");
  assert.equal(promptCall.text, "input between tools");
  assert.equal(promptCall.options.streamingBehavior, "steer");
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
    return { outcome: "nonterminal" };
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
  const result = await pending;
  assert.equal(result.outcome, "nonterminal");
  assert.equal(result.superseded, true);
});

test("frontend SDK disposal fences a stale compaction refresh before prompt", async () => {
  const oldClient = createFrontendClient();
  const newClient = createFrontendClient();
  let factoryCalls = 0;
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => (factoryCalls++ === 0 ? oldClient : newClient),
    promptSource: "chat-bridge",
  });
  await driver.connect();
  (driver as any).frontendState = {
    sessionFile: "/tmp/frontend-chat.jsonl",
    sessionId: "old-session",
    isStreaming: true,
    turnActive: true,
    isCompacting: true,
  };

  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let refreshStarted = false;
  oldClient.getState = async () => {
    refreshStarted = true;
    await refreshGate;
    return {
      sessionFile: "/tmp/frontend-chat.jsonl",
      sessionId: "old-session",
      isStreaming: false,
      turnActive: false,
      isCompacting: false,
    };
  };
  oldClient.prompt = async (text: string, options: any = {}) => {
    oldClient.calls.push({ type: "prompt", text, options });
    return { outcome: "nonterminal" };
  };

  const pending = driver.runTurn({
    text: "stale input after disposal",
    assumeConnected: true,
    assumeSessionReady: true,
    promptContext: { source: "chat-bridge", chatKey: "telegram/1:2" },
  });
  await waitUntil(() => refreshStarted, "compaction refresh did not start");
  driver.dispose();
  await assert.rejects(pending, /rin_frontend_turn_cancelled/);
  assert.equal(await driver.connect(), true);

  releaseRefresh();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    oldClient.calls.some((call: any) => call.type === "prompt"),
    false,
  );
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
    return { outcome: "terminalOwner", requestTag: options.requestTag };
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
    return { outcome: "terminalOwner", requestTag: options.requestTag };
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
    return { outcome: "terminalOwner", requestTag: options.requestTag };
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
    return { outcome: "terminalOwner", requestTag: options.requestTag };
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
    return { outcome: "terminalOwner", requestTag: options.requestTag };
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
    return { outcome: "terminalOwner", requestTag: options.requestTag };
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
    return { outcome: "terminalOwner", requestTag: options.requestTag };
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
    return {
      outcome: "rejoined",
      originalOutcome: "terminalOwner",
      requestTag: options.requestTag,
    };
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
test("frontend SDK leaves an existing backend owner untouched after native nonterminal input", async () => {
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
    return { outcome: "nonterminal" };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const result = await driver.runTurn({ text: "follow existing turn" });
  assert.equal(result.outcome, "nonterminal");
  assert.equal(result.superseded, true);
  assert.equal(getStateCount >= 1, true);
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
    return { outcome: "terminalOwner", requestTag: options.requestTag };
  };

  const result = await driver.runTurn({ text: "hello" });

  assert.equal(result.finalText, "rpc final");
});

test("frontend SDK turn driver rejects an empty rpc completion without scanning session history", async () => {
  const driver = createDriver();
  const client = (driver as any).testClient;
  client.getMessages = async () => [
    { role: "user", content: "hello" },
    { role: "assistant", content: "session text must not be a fallback" },
  ];
  client.prompt = async (_text: string, options: any = {}) => {
    await emitDriverEvent(driver, { type: "agent_start" });
    await emitRpcTurnComplete(driver, options.requestTag, "");
    return { outcome: "terminalOwner", requestTag: options.requestTag };
  };

  await assert.rejects(
    driver.runTurn({ text: "hello" }),
    /Agent returned an empty response/,
  );
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
    return { outcome: "terminalOwner", requestTag: options.requestTag };
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
    return { outcome: "terminalOwner", requestTag: options.requestTag };
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
    return { outcome: "terminalOwner", requestTag: options.requestTag };
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
    return { outcome: "terminalOwner", requestTag: options.requestTag };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  await assert.rejects(
    driver.runTurn({ text: "new prompt" }),
    /Agent returned an empty response/,
  );
  assert.notEqual("", oldFinal);
});

test("frontend projects an authoritative terminal without current-session filtering", async () => {
  const driver: any = createDriver();
  const seen: any[] = [];
  driver.subscribe((event: any) => seen.push(event));
  await driver.connect();
  driver.frontendState.sessionFile = "/tmp/newer-session.jsonl";

  assert.equal(
    await driver.projectAuthoritativeTerminal({
      type: "rpc_turn_event",
      event: "complete",
      requestTag: "detached-terminal-request",
      sessionFile: "/tmp/older-session.jsonl",
      sessionId: "older-session",
      finalText: "detached terminal final",
      chatDeliveryContext: {
        turnId: "detached-terminal-turn",
        chatKey: "discord/1:2",
        messageId: "detached-terminal-message",
      },
      terminalRecord: {
        terminalId: `terminal-${"c".repeat(64)}`,
        state: "complete",
        terminalAt: "2026-07-31T17:00:00.000Z",
      },
    }),
    true,
  );
  assert.equal(
    seen.some(
      (event) =>
        event.type === "turn_complete" &&
        event.finalText === "detached terminal final",
    ),
    true,
  );
});

test("frontend recovery enters the shared terminal gate during backend interruption", async () => {
  const client = createFrontendClient();
  const requestTag = "recovery-interruption-gate-request";
  let releaseAbort!: () => void;
  const abortGate = new Promise<void>((resolve) => {
    releaseAbort = resolve;
  });
  let abortStarted = false;
  client.abort = async () => {
    client.calls.push({ type: "abort" });
    abortStarted = true;
    await abortGate;
  };
  client.request = async (command: any) => {
    client.calls.push({ type: "request", command });
    if (command?.type === "list_unacknowledged_chat_terminals") {
      return {
        terminals: [
          {
            type: "rpc_turn_event",
            event: "complete",
            requestTag,
            finalText: "recovered interrupted final",
            chatDeliveryContext: {
              turnId: "recovery-interruption-turn",
              chatKey: "discord/1:2",
              messageId: "recovery-interruption-message",
            },
            terminalRecord: {
              terminalId: "terminal-recovery-interruption-gate",
              state: "complete",
              terminalAt: "2026-08-06T09:06:10.250Z",
            },
          },
        ],
      };
    }
    return { ok: true };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  const projected: any[] = [];
  driver.subscribe((event: any) => projected.push(event));
  await driver.connect();
  const liveTurn = (driver as any).startLiveTurn(requestTag);
  const command = driver.runCommand("/abort");
  await waitUntil(() => abortStarted, "backend abort did not start");

  assert.equal(
    await driver.recoverUnacknowledgedChatTerminals("discord/1:2"),
    1,
  );
  const projectedBeforeCommit = projected.some(
    (event) =>
      event.type === "turn_complete" && event.requestTag === requestTag,
  );
  const acknowledgementsBeforeCommit = client.calls.filter(
    (call: any) =>
      call.type === "request" &&
      call.command?.type === "ack_turn_terminal" &&
      call.command.requestTag === requestTag,
  ).length;

  releaseAbort();
  await command;
  assert.equal(
    (await liveTurn.promise).finalText,
    "recovered interrupted final",
  );
  assert.equal(projectedBeforeCommit, false);
  assert.equal(acknowledgementsBeforeCommit, 1);
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

test("frontend recovery cancels when unacknowledged listing crosses disposal", async () => {
  const client = createFrontendClient();
  let releaseListing!: () => void;
  const listingGate = new Promise<void>((resolve) => {
    releaseListing = resolve;
  });
  let listingStarted = false;
  client.request = async (command: any) => {
    client.calls.push({ type: "request", command });
    if (command?.type === "list_unacknowledged_chat_terminals") {
      listingStarted = true;
      await listingGate;
      return {
        terminals: [
          {
            type: "rpc_turn_event",
            event: "complete",
            requestTag: "stale-recovery-request",
            finalText: "stale recovery final",
            terminalRecord: {
              terminalId: "terminal-stale-recovery",
              state: "complete",
              terminalAt: "2026-08-06T09:06:10.000Z",
            },
          },
        ],
      };
    }
    return { ok: true };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  const projected: any[] = [];
  driver.subscribe((event: any) => projected.push(event));
  await driver.connect();

  const recovery = driver.recoverUnacknowledgedChatTerminals("discord/1:2");
  await waitUntil(() => listingStarted, "terminal listing did not start");
  driver.dispose();
  await driver.connect();
  releaseListing();
  const recoveryError = await recovery.then(
    () => null,
    (error: Error) => error,
  );

  assert.match(recoveryError?.message || "", /rin_frontend_turn_cancelled/);
  assert.equal(
    projected.some(
      (event) => event.type === "turn_complete" || event.type === "turn_error",
    ),
    false,
  );
});

test("frontend recovery maps a stale listing rejection to lifecycle cancellation", async () => {
  const client = createFrontendClient();
  let rejectListing!: (error: Error) => void;
  const listingOutcome = new Promise<never>((_resolve, reject) => {
    rejectListing = reject;
  });
  let listingStarted = false;
  client.request = async (command: any) => {
    client.calls.push({ type: "request", command });
    if (command?.type === "list_unacknowledged_chat_terminals") {
      listingStarted = true;
      await listingOutcome;
    }
    return { ok: true };
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  await driver.connect();

  const recovery = driver
    .recoverUnacknowledgedChatTerminals("discord/1:2")
    .then(
      () => null,
      (error: Error) => error,
    );
  await waitUntil(() => listingStarted, "terminal listing did not start");
  driver.dispose();
  rejectListing(new Error("old terminal listing failure"));

  const error = await recovery;
  assert.equal(error?.message, "rin_frontend_turn_cancelled");
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
