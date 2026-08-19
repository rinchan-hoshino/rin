import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { RpcAuthCommandContext } from "../../src/core/rin-daemon/rpc-auth-command-handler.js";
import type {
  RpcCommand,
  RpcCommandRequest,
} from "../../src/core/rin-daemon/rpc-command-handler-context.js";
import type { RpcExtensionUiCommandContext } from "../../src/core/rin-daemon/rpc-extension-ui-command-handler.js";
import type { RpcResourceCommandContext } from "../../src/core/rin-daemon/rpc-resource-command-handler.js";
import type { RpcSessionCommandContext } from "../../src/core/rin-daemon/rpc-session-command-handler.js";
import type { RpcTurnCommandContext } from "../../src/core/rin-daemon/rpc-turn-command-handler.js";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const load = async (name: string) =>
  await import(
    pathToFileURL(
      path.join(rootDir, "dist", "core", "rin-daemon", `${name}.js`),
    ).href
  );
const extensionModule = await load("rpc-extension-ui-command-handler");
const resourceModule = await load("rpc-resource-command-handler");
const sessionModule = await load("rpc-session-command-handler");
const authModule = await load("rpc-auth-command-handler");
const turnModule = await load("rpc-turn-command-handler");
const turnCoordinatorModule = await load("rpc-turn-coordinator");
const rpcModeModule = await load("rpc-mode");

const request = (
  type: string,
  command: Record<string, unknown> = {},
): RpcCommandRequest => ({
  command: { ...command, type },
  id: `id-${type}`,
  type,
});
const wait = async () => await new Promise((resolve) => setTimeout(resolve, 0));

// Pi's AgentSession is an external class with runtime-initialized members. Keep
// the unsafe test seam here instead of weakening production handler contexts.
const fakeSession = (members: Record<string, unknown>): AgentSession =>
  members as unknown as AgentSession;

const createTurnContext = (session: AgentSession): RpcTurnCommandContext => ({
  getSession: () => session,
  turnCoordinator: new turnCoordinatorModule.RpcTurnCoordinator(),
  turnState: {
    nativeInputAdmissionTail: Promise.resolve(),
    gracefulSessionShutdown: false,
  },
  observeNativeInput: () => undefined,
  startInterruptTurnTask: async () => undefined,
  startTurnTask: () => undefined,
  output: () => undefined,
  terminateProcess: () => {
    throw new Error("unexpected process termination");
  },
  runtime: { dispose: async () => undefined },
});

test(
  "RPC lifecycle reports malformed and untyped commands through its response boundary",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map<string, (chunk: Buffer) => void>();
    const lines: string[] = [];
    process.stdin.on = function (
      event: string,
      handler: (chunk: Buffer) => void,
    ) {
      handlers.set(event, handler);
      return this;
    } as typeof process.stdin.on;
    process.stdout.write = function (chunk: unknown) {
      lines.push(String(chunk));
      return true;
    } as typeof process.stdout.write;

    try {
      const session = {
        agent: { waitForIdle: async () => undefined },
        bindExtensions: async () => undefined,
        subscribe: () => () => undefined,
      };
      void rpcModeModule.runCustomRpcMode(session, {
        SessionManager: { listAll: async () => [], list: async () => [] },
      });
      await wait();
      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData?.(Buffer.from('not-json\nnull\n{"id":"missing-type"}\n'));
      await wait();

      const responses = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return undefined;
          }
        })
        .filter((line) => line?.type === "response");
      assert.equal(
        responses.some((line) => line.command === "parse"),
        true,
      );
      assert.equal(
        responses.some(
          (line) => line.id === undefined && line.command === "unknown",
        ),
        true,
      );
      const untyped = responses.find((line) => line.id === "missing-type");
      assert.equal(untyped?.command, "unknown");
      assert.match(untyped?.error, /Unknown command: unknown/);
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test("RPC protocol handlers expose narrow extension, resource, and session boundaries", async () => {
  const resolved: RpcCommand[] = [];
  const extensionContext: RpcExtensionUiCommandContext = {
    resolvePendingExtensionUiRequest: (response) => {
      resolved.push(response);
      return true;
    },
  };
  const extension =
    extensionModule.createRpcExtensionUiCommandHandlers(extensionContext);
  const extensionResult = await extension.extension_ui_response(
    request("extension_ui_response", {
      requestId: "ui-1",
      value: "chosen",
      cancelled: false,
    }),
  );
  assert.equal(resolved[0]?.requestId, "ui-1");
  assert.equal(extensionResult.data, undefined);

  const resourceContext: RpcResourceCommandContext = {
    getSession: () => fakeSession({}),
    turnCoordinator: new turnCoordinatorModule.RpcTurnCoordinator(),
    createExtensionUiContext: () => ({}),
    SessionManager: {},
    runtime: {},
  };
  const resource =
    resourceModule.createRpcResourceCommandHandlers(resourceContext);
  const resourceResult = await resource.get_resource_diagnostics(
    request("get_resource_diagnostics"),
  );
  assert.deepEqual(resourceResult.data.skills, {
    skills: [],
    diagnostics: [],
  });

  let sessionName = "";
  const sessionContext: RpcSessionCommandContext = {
    getSession: () =>
      fakeSession({
        setSessionName: (value: string) => {
          sessionName = value;
        },
      }),
    SessionManager: {},
    bindCurrentSession: async () => undefined,
    runtime: {
      importFromJsonl: async () => ({}),
      fork: async () => ({}),
    },
  };
  const session = sessionModule.createRpcSessionCommandHandlers(sessionContext);
  await session.set_session_name(
    request("set_session_name", { name: "  independent owner  " }),
  );
  assert.equal(sessionName, "independent owner");
  await assert.rejects(
    () => session.set_session_name(request("set_session_name", { name: " " })),
    /Session name cannot be empty/,
  );
});

test("RPC auth handler owns validation and login state behind two runtime capabilities", async () => {
  const outputs: Array<Record<string, unknown>> = [];
  const modelRuntime = {
    getAvailableProviders: () => [
      { id: "provider-1", auth: [{ type: "oauth" }] },
    ],
    login: async (
      providerId: string,
      _authType: string,
      callbacks: {
        notify: (event: Record<string, unknown>) => void;
        prompt: (input: any) => Promise<string>;
      },
    ) => {
      callbacks.notify({ type: "auth_url", url: "https://auth.invalid" });
      callbacks.notify({
        type: "device_code",
        userCode: "owner-code",
        verificationUri: "https://device.invalid",
      });
      callbacks.notify({ type: "info", message: "Owner info" });
      callbacks.notify({ type: "progress", message: "Owner progress" });
      if (providerId === "provider-select") {
        return await callbacks.prompt({
          type: "select",
          message: "Choose account",
          options: [{ id: "owner", label: "Owner account" }],
        });
      }
      return await callbacks.prompt({ type: "text", message: "Approval code" });
    },
  };
  const authContext: RpcAuthCommandContext = {
    getSession: () => fakeSession({ modelRuntime }),
    output: (value) => outputs.push(value as Record<string, unknown>),
  };
  const auth = authModule.createRpcAuthCommandHandlers(authContext);
  await assert.rejects(
    () => auth.oauth_login_start(request("oauth_login_start")),
    /providerId is required/,
  );
  await assert.rejects(
    () => auth.oauth_logout(request("oauth_logout", { providerId: " " })),
    /providerId is required/,
  );
  await assert.rejects(
    () =>
      auth.oauth_login_respond(
        request("oauth_login_respond", {
          loginId: "unknown",
          requestId: "request-1",
        }),
      ),
    /Unknown OAuth login: unknown/,
  );

  const start = await auth.oauth_login_start(
    request("oauth_login_start", { providerId: "provider-1" }),
  );
  await wait();
  const loginId = String(start.data.loginId);
  assert.equal(
    outputs.some(
      (event) => event.event === "prompt" && event.loginId === loginId,
    ),
    true,
  );
  for (const event of ["auth", "device_code", "info", "progress"]) {
    assert.equal(
      outputs.some(
        (candidate) =>
          candidate.event === event && candidate.loginId === loginId,
      ),
      true,
    );
  }
  await auth.oauth_login_cancel(request("oauth_login_cancel", { loginId }));
  await wait();
  assert.equal(
    outputs.some(
      (event) => event.event === "prompt_cancel" && event.loginId === loginId,
    ),
    true,
  );
  const selectStart = await auth.oauth_login_start(
    request("oauth_login_start", { providerId: "provider-select" }),
  );
  await wait();
  const selectLoginId = String(selectStart.data.loginId);
  const selectEvent = outputs.find(
    (event) => event.event === "select" && event.loginId === selectLoginId,
  );
  assert.ok(selectEvent);
  await auth.oauth_login_respond(
    request("oauth_login_respond", {
      loginId: selectLoginId,
      requestId: selectEvent.requestId,
      value: "owner",
    }),
  );
  await wait();
  assert.equal(
    outputs.some(
      (event) =>
        event.event === "complete" &&
        event.loginId === selectLoginId &&
        event.success === true,
    ),
    true,
  );
});

test("RPC turn handler resolves persisted and conflicting request ownership from session state", async () => {
  const persistedSession = fakeSession({
    sessionFile: "persisted.jsonl",
    sessionId: "session-1",
    isStreaming: false,
    sessionManager: {
      getEntries: () => [
        {
          id: "message-1",
          type: "message",
          message: { role: "user" },
        },
        {
          type: "custom",
          customType: "rin_request_identity",
          data: {
            requestId: "request-1",
            messageEntryId: "message-1",
            observedRole: "terminalOwner",
          },
        },
      ],
    },
  });
  const persisted = turnModule.createRpcTurnCommandHandlers(
    createTurnContext(persistedSession),
  );
  const persistedResult = await persisted.prompt(
    request("prompt", { requestTag: "request-1" }),
  );
  assert.equal(persistedResult.data.outcome, "rejoined");
  assert.equal(persistedResult.data.originalOutcome, "terminalOwner");

  const joinedSession = fakeSession({
    sessionFile: "joined.jsonl",
    sessionId: "session-joined",
    isStreaming: false,
    sessionManager: {
      getEntries: () => [
        { id: "message-owner", type: "message", message: { role: "user" } },
        {
          type: "custom",
          customType: "rin_request_identity",
          data: {
            requestId: "request-owner",
            messageEntryId: "message-owner",
            observedRole: "terminalOwner",
          },
        },
        { id: "message-joined", type: "message", message: { role: "user" } },
        {
          type: "custom",
          customType: "rin_request_identity",
          data: {
            requestId: "request-joined",
            messageEntryId: "message-joined",
            observedRole: "nonterminal",
          },
        },
      ],
    },
  });
  const joined = turnModule.createRpcTurnCommandHandlers(
    createTurnContext(joinedSession),
  );
  const joinedResult = await joined.prompt(
    request("prompt", { requestTag: "request-joined" }),
  );
  assert.equal(joinedResult.data.outcome, "rejoined");
  assert.equal(joinedResult.data.originalOutcome, "nonterminal");
  assert.equal(joinedResult.data.joinedRequestTag, "request-owner");

  const conflictingSession = fakeSession({
    sessionFile: "conflict.jsonl",
    sessionId: "session-2",
    isStreaming: false,
    sessionManager: {
      getEntries: () => [
        {
          type: "custom",
          customType: "rin_request_identity",
          data: {
            requestId: "request-2",
            messageEntryId: "missing",
            observedRole: "terminalOwner",
          },
        },
      ],
    },
  });
  const conflict = turnModule.createRpcTurnCommandHandlers(
    createTurnContext(conflictingSession),
  );
  const conflictResult = await conflict.prompt(
    request("prompt", { requestTag: "request-2" }),
  );
  assert.equal(conflictResult.data.outcome, "indeterminate");
});

test("RPC turn owner persists receipts and repairs interrupted tool continuations", async () => {
  const entries: Array<Record<string, unknown>> = [
    {
      id: "message-3",
      type: "message",
      message: { role: "user" },
    },
    {
      type: "custom",
      customType: "rin_request_identity",
      data: {
        requestId: "request-3",
        messageEntryId: "message-3",
        observedRole: "terminalOwner",
      },
    },
  ];
  const receiptSession = {
    sessionManager: {
      getEntries: () => entries,
      appendCustomEntry: (customType: string, data: unknown) =>
        entries.push({ type: "custom", customType, data }),
    },
  };
  assert.equal(
    turnModule.persistNativeRequestOutcome(
      receiptSession,
      "request-3",
      "terminalOwner",
    ),
    true,
  );
  assert.equal(
    turnModule.persistedNativeRequestOutcome(receiptSession, "request-3"),
    "terminalOwner",
  );
  assert.equal(
    turnModule.persistNativeRequestOutcome(
      receiptSession,
      "request-3",
      "terminalOwner",
    ),
    true,
  );
  assert.equal(
    turnModule.hasPersistedUserRequestTag(receiptSession, ""),
    false,
  );
  assert.equal(
    turnModule.persistNativeRequestOutcome(receiptSession, "", "steer"),
    true,
  );
  assert.equal(
    turnModule.nativeRequestReceiptState(
      { sessionManager: { getEntries: () => [] } },
      "missing-request",
    ),
    "missing",
  );
  await turnModule.waitForPersistedUserRequestTag(receiptSession, "request-3");
  await assert.rejects(
    () =>
      turnModule.waitForPersistedUserRequestTag(
        {
          sessionManager: {
            getEntries: () => [
              {
                type: "custom",
                customType: "rin_request_identity",
                data: {
                  requestId: "conflict-request",
                  messageEntryId: "missing",
                  observedRole: "terminalOwner",
                },
              },
            ],
          },
        },
        "conflict-request",
      ),
    /rin_prompt_outcome_indeterminate/,
  );

  assert.equal(
    turnModule.appendInterruptedToolResults({
      agent: { state: { messages: [] } },
    }),
    false,
  );
  assert.equal(
    turnModule.appendInterruptedToolResults({
      agent: { state: { messages: null } },
    }),
    false,
  );
  assert.equal(
    turnModule.appendInterruptedToolResults({
      agent: {
        state: {
          messages: [{ role: "assistant", stopReason: "stop", content: [] }],
        },
      },
    }),
    false,
  );

  const messages: Array<Record<string, unknown>> = [
    {
      role: "assistant",
      stopReason: "stop",
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "lookup",
          arguments: { query: "value" },
        },
      ],
    },
  ];
  const continuationSession = {
    agent: { state: { messages } },
    sessionManager: {
      appendMessage: (message: Record<string, unknown>) =>
        messages.push(message),
    },
  };
  assert.equal(
    turnModule.appendInterruptedToolResults(continuationSession),
    true,
  );
  assert.equal(messages.at(-1)?.role, "toolResult");
  const inMemoryContinuationMessages = [messages[0]];
  assert.equal(
    turnModule.appendInterruptedToolResults(
      {
        agent: { state: { messages: inMemoryContinuationMessages } },
      },
      { persistToSession: false },
    ),
    true,
  );
  assert.equal(inMemoryContinuationMessages.at(-1)?.role, "toolResult");

  const completedMessages: Array<Record<string, unknown>> = [
    messages[0],
    { role: "toolResult", toolCallId: "call-1" },
  ];
  assert.equal(
    turnModule.appendInterruptedToolResults({
      agent: { state: { messages: completedMessages } },
    }),
    false,
  );

  const failedMessages: Array<Record<string, unknown>> = [
    { role: "user", content: "kept" },
    { role: "assistant", stopReason: "error" },
    { role: "assistant", stopReason: "aborted" },
  ];
  turnModule.discardInterruptedAssistantFailures({
    agent: { state: { messages: failedMessages } },
  });
  assert.deepEqual(failedMessages, [{ role: "user", content: "kept" }]);

  const settledAssistant = {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text: "settled" }],
  };
  assert.equal(
    await turnModule.resumeInterruptedTurn(
      { agent: { state: { messages: [] } } },
      {},
    ),
    undefined,
  );
  assert.deepEqual(
    await turnModule.resumeInterruptedTurn(
      {
        agent: { state: { messages: [settledAssistant] } },
        getLastAssistantText: () => "settled",
      },
      {},
    ),
    {
      finalText: "settled",
      result: { messages: [settledAssistant] },
    },
  );
  assert.deepEqual(
    await turnModule.abortInterruptedTurnAfterExecutionLoss({
      agent: { state: { messages: [settledAssistant] } },
      getLastAssistantText: () => "settled",
    }),
    {
      finalText: "settled",
      result: { messages: [settledAssistant] },
    },
  );

  const commandSession = fakeSession({
    sessionFile: "command.jsonl",
    sessionId: "session-command",
    agent: { signal: undefined },
    messages: [],
    pendingMessageCount: 0,
  });
  let capturedTurnTask: (() => Promise<unknown>) | undefined;
  const interruptedContext: RpcTurnCommandContext = {
    ...createTurnContext(commandSession),
    startTurnTask: (_requestTag, task) => {
      capturedTurnTask = task;
    },
  };
  const interrupted =
    turnModule.createRpcTurnCommandHandlers(interruptedContext);
  const interruptedResult = await interrupted.abort_interrupted_turn(
    request("abort_interrupted_turn", { requestTag: "request-command" }),
  );
  assert.equal(typeof capturedTurnTask, "function");
  assert.deepEqual(interruptedResult.data, {
    sessionFile: "command.jsonl",
    sessionId: "session-command",
  });

  const activeContext = createTurnContext(commandSession);
  activeContext.turnCoordinator.openTurn("active-request");
  const active = turnModule.createRpcTurnCommandHandlers(activeContext);
  const activeState = await active.get_state(request("get_state"));
  assert.equal(activeState.data.requestTag, "active-request");
  await assert.rejects(
    () => active.send_user_message(request("send_user_message")),
    /rpc_turn_already_active/,
  );

  let aborted = false;
  await turnModule.abortInterruptedTurnAfterExecutionLoss({
    agent: { state: { messages: [] } },
    abort: async () => {
      aborted = true;
    },
  });
  assert.equal(aborted, true);
});
