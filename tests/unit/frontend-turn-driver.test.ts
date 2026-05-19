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
      if (command.type === "run_command") {
        return await this.runCommand(String(command.commandLine || ""));
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

test("external compaction review work drives the frontend working phase", async () => {
  const driver = createDriver();
  const seen: any[] = [];
  driver.subscribe((event: any) => seen.push(event));

  await emitDriverEvent(driver, { type: "rin_working_start" });
  await emitDriverEvent(driver, { type: "rin_working_end" });
  await emitDriverEvent(driver, { type: "compaction_start" });
  await emitDriverEvent(driver, { type: "compaction_end" });

  assert.deepEqual(seen, [
    { type: "frontend_status", phase: "working" },
    { type: "frontend_status", phase: "idle" },
    { type: "frontend_status", phase: "working" },
    { type: "frontend_status", phase: "idle" },
  ]);
});

async function emitRpcTurnComplete(
  driver: any,
  requestTag: string,
  finalText: string,
  sessionFile = "/tmp/chat-driver.jsonl",
) {
  await emitDriverEvent(driver, {
    type: "rpc_turn_event",
    event: "complete",
    requestTag,
    finalText,
    result: {
      messages: finalText ? [{ type: "text", text: finalText }] : [],
    },
    sessionId: "session-driver",
    sessionFile,
  });
}

test("frontend SDK turn driver runs turns through a frontend client", async () => {
  const client = createFrontendClient();
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const result = await driver.runTurn({
    text: "hello",
    managedSessionLeaf: "telegram/1:2",
    promptContext: { source: "chat-bridge", chatKey: "telegram/1:2" },
  });

  assert.equal(result.finalText, "frontend final");
  assert.equal(result.sessionFile, "/tmp/frontend-managed.jsonl");
  assert.deepEqual(
    client.calls
      .filter((call: any) => ["newSession", "prompt"].includes(call.type))
      .map((call: any) => call.type),
    ["newSession", "prompt"],
  );
  assert.equal(client.calls[0].options.managedSessionLeaf, "telegram/1:2");
  const promptCall = client.calls.find((call: any) => call.type === "prompt");
  assert.equal(promptCall.text, "hello");
  assert.equal(promptCall.options.sessionFile, "/tmp/frontend-managed.jsonl");
  assert.deepEqual(promptCall.options.promptContext, {
    source: "chat-bridge",
    chatKey: "telegram/1:2",
  });
});

test("frontend SDK turn driver routes compact through the native compact client method", async () => {
  const driver = createDriver();
  const client = (driver as any).testClient;

  const result = await driver.runCommand("/compact keep recent plan");

  assert.equal(result.text, "compact done");
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
  assert.deepEqual(client.calls[0], {
    type: "newSession",
    options: { managedSessionLeaf: "chat" },
  });
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
      ["get_state", "get_messages"].includes(command.type),
    );
  assert.ok(scopedCommands.length >= 2);
  assert.ok(
    scopedCommands.every((command: any) => command.sessionFile === sessionFile),
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

test("frontend SDK turn driver follows an already active turn by default", async () => {
  const client = createFrontendClient();
  let streaming = true;
  client.getState = async () => ({
    sessionFile: "/tmp/frontend-chat.jsonl",
    sessionId: "frontend-session",
    isStreaming: streaming,
    turnActive: streaming,
  });
  client.prompt = async () => {
    throw new Error("prompt_should_not_be_resubmitted");
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const resultPromise = driver.runTurn({
    text: "restored job",
    promptContext: { source: "chat-bridge", chatKey: "telegram/1:2" },
  });
  setImmediate(() => {
    streaming = false;
    void emitRpcTurnComplete(
      driver,
      "previous-request-tag",
      "recovered active final",
      "/tmp/frontend-chat.jsonl",
    );
  });

  const result = await resultPromise;

  assert.equal(result.finalText, "recovered active final");
  assert.equal(
    client.calls.some((call: any) => call.type === "prompt"),
    false,
  );
});

test("frontend SDK turn driver steers through native prompt streamingBehavior", async () => {
  const client = createFrontendClient();
  client.getState = async () => ({
    sessionFile: "/tmp/frontend-chat.jsonl",
    sessionId: "frontend-session",
    isStreaming: true,
  });
  client.prompt = async (text: string, options: any = {}) => {
    client.calls.push({ type: "prompt", text, options });
  };
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });

  const result = await driver.runTurn({
    text: "steer now",
    promptContext: { source: "chat-bridge", chatKey: "telegram/1:2" },
    streamingBehavior: "steer",
  });

  assert.equal(result.steered, true);
  assert.equal(client.calls[0].type, "prompt");
  assert.equal(client.calls[0].text, "steer now");
  assert.equal(client.calls[0].options.streamingBehavior, "steer");
  assert.equal(client.calls[0].options.source, "chat-bridge");
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

test("frontend SDK turn driver starts managed leaf sessions even after connect reports a default session", async () => {
  const driver = createDriver();
  const calls: string[] = [];
  const client = (driver as any).testClient;
  let sessionFile = "/tmp/root-session.jsonl";
  client.getState = async () => ({
    sessionFile,
    sessionId: "session-driver",
    isStreaming: false,
  });
  client.newSession = async (options: any = {}) => {
    calls.push(`newSession:${options.managedSessionLeaf}`);
    sessionFile = "/tmp/rin/sessions/managed/task/created.jsonl";
    return { cancelled: false, sessionFile, sessionId: "session-driver" };
  };
  client.prompt = async (_text: string, options: any = {}) => {
    calls.push("prompt");
    await emitRpcTurnComplete(driver, options.requestTag, "done", sessionFile);
  };

  const result = await driver.runTurn({
    text: "hello",
    managedSessionLeaf: "task",
  });

  assert.equal(result.finalText, "done");
  assert.deepEqual(calls, ["newSession:task", "prompt"]);
  assert.equal(
    result.sessionFile,
    "/tmp/rin/sessions/managed/task/created.jsonl",
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
  };

  const result = await driver.runTurn({ text: "hello" });

  assert.equal(result.finalText, "Final answer");
  assert.deepEqual(interimTexts, []);
});

test("frontend SDK turn driver follows Pi overflow continuation through shared native events", async () => {
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
        content: [],
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
    await emitDriverEvent(driver, {
      type: "rpc_turn_event",
      event: "error",
      requestTag: options.requestTag,
      error: "context_length_exceeded",
    });
    setTimeout(() => {
      void (async () => {
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
      })();
    }, 5);
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

test("frontend SDK turn driver reconnects and resolves an interrupted prompt from session state", async () => {
  const client = createFrontendClient();
  const originalConnect = client.connect;
  let connectCount = 0;
  client.connect = async () => {
    connectCount += 1;
    await originalConnect.call(client);
  };
  let promptAttempted = false;
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

  const result = await driver.runTurn({ text: "hello" });

  assert.equal(result.finalText, "recovered final");
  assert.equal(result.sessionFile, "/tmp/frontend-chat.jsonl");
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
          !["get_state", "get_messages"].includes(call.command.type) ||
          call.command.sessionFile === "/tmp/frontend-chat.jsonl",
      ),
  );
});
