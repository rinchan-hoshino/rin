import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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
const rpcModeModule = await load("rpc-mode");

const request = (type: string, command: Record<string, unknown> = {}) => ({
  command: { ...command, type },
  id: `id-${type}`,
  type,
});
const done = (id: string, type: string, data?: unknown) => ({
  id,
  type,
  success: true,
  data,
});
const run = async (
  id: string,
  type: string,
  operation: () => unknown | Promise<unknown>,
  map?: (value: unknown) => unknown,
) => {
  const value = await operation();
  return done(id, type, map ? map(value) : value);
};
const wait = async () => await new Promise((resolve) => setTimeout(resolve, 0));

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

test("RPC protocol handlers consume their named extension, resource, and session dependencies", async () => {
  const resolved: unknown[] = [];
  const extension = extensionModule.createRpcExtensionUiCommandHandlers({
    resolvePendingExtensionUiRequest: (...args: unknown[]) => {
      resolved.push(args);
      return true;
    },
    done,
  });
  const extensionResult = await extension.extension_ui_response(
    request("extension_ui_response", {
      requestId: "ui-1",
      value: "chosen",
      cancelled: false,
    }),
  );
  assert.deepEqual(resolved, [
    [
      {
        requestId: "ui-1",
        value: "chosen",
        cancelled: false,
        type: "extension_ui_response",
      },
    ],
  ]);
  assert.equal(extensionResult.data, undefined);

  const resource = resourceModule.createRpcResourceCommandHandlers({
    getSession: () => ({ id: "session-1" }),
    getResourceDiagnostics: (session: { id: string }) => session.id,
    done,
    run,
  } as any);
  const resourceResult = await resource.get_resource_diagnostics(
    request("get_resource_diagnostics"),
  );
  assert.equal(resourceResult.data, "session-1");

  let sessionName = "";
  const session = sessionModule.createRpcSessionCommandHandlers({
    getSession: () => ({
      setSessionName: (value: string) => {
        sessionName = value;
      },
    }),
    done,
  } as any);
  await session.set_session_name(
    request("set_session_name", { name: "  independent owner  " }),
  );
  assert.equal(sessionName, "independent owner");
  await assert.rejects(
    () => session.set_session_name(request("set_session_name", { name: " " })),
    /Session name cannot be empty/,
  );
});

test("RPC auth handler preserves validation, mutation, and cancellation errors", async () => {
  const session = {};
  const activeLogins = new Map([
    [
      "login-1",
      {
        abort: new AbortController(),
        waits: new Map(),
        nextWaitSeq: 0,
      },
    ],
  ]);
  const apiKeys: unknown[] = [];
  const logouts: unknown[] = [];
  const finished: string[] = [];
  const ensureLogin = (id: string) => {
    const login = activeLogins.get(id);
    if (!login) throw new Error(`Unknown OAuth login: ${id}`);
    return login;
  };
  const auth = authModule.createRpcAuthCommandHandlers({
    getSession: () => session,
    getOAuthState: () => ({ providers: [] }),
    authState: { loginSeq: 0, activeLogins },
    deferOAuthLoginStart: () => undefined,
    ensureLogin,
    finishLogin: (id: string) => {
      finished.push(id);
      activeLogins.delete(id);
    },
    setSessionApiKey: async (...args: unknown[]) => apiKeys.push(args),
    logoutSessionProvider: async (...args: unknown[]) => logouts.push(args),
    done,
    run,
  } as any);

  await assert.rejects(
    () => auth.oauth_login_start(request("oauth_login_start")),
    /providerId is required/,
  );
  await assert.rejects(
    () => auth.oauth_logout(request("oauth_logout", { providerId: " " })),
    /providerId is required/,
  );
  const startResult = await auth.oauth_login_start(
    request("oauth_login_start", { providerId: "p", authType: "api_key" }),
  );
  assert.equal(startResult.data.loginId, "login_1");
  await assert.rejects(
    () => auth.oauth_set_api_key(request("oauth_set_api_key", { key: "x" })),
    /providerId is required/,
  );
  await assert.rejects(
    () =>
      auth.oauth_set_api_key(
        request("oauth_set_api_key", { providerId: "p", key: " " }),
      ),
    /key is required/,
  );
  await auth.oauth_set_api_key(
    request("oauth_set_api_key", { providerId: "p", key: "secret" }),
  );
  await auth.oauth_logout(request("oauth_logout", { providerId: "p" }));
  assert.deepEqual(apiKeys, [[session, "p", "secret"]]);
  assert.deepEqual(logouts, [[session, "p"]]);

  await assert.rejects(
    () =>
      auth.oauth_login_respond(
        request("oauth_login_respond", {
          loginId: "login-1",
          requestId: "missing",
        }),
      ),
    /Unknown OAuth login request: missing/,
  );
  const login = ensureLogin("login-1");
  let resolvedLoginValue: string | undefined;
  login.waits.set("request-1", {
    resolve: (value: string) => {
      resolvedLoginValue = value;
    },
  });
  await auth.oauth_login_respond(
    request("oauth_login_respond", {
      loginId: "login-1",
      requestId: "request-1",
      value: "approved",
    }),
  );
  assert.equal(resolvedLoginValue, "approved");
  await auth.oauth_login_cancel(
    request("oauth_login_cancel", { loginId: "login-1" }),
  );
  assert.equal(login.abort.signal.aborted, true);
  assert.deepEqual(finished, ["login-1"]);
});

test("RPC turn handler resolves persisted and conflicting native request ownership independently", async () => {
  const session = {};
  const turnCoordinator = {
    isActive: false,
    activeRequestTag: undefined,
    observedRole: () => undefined,
    assertAdmissionOpen: () => undefined,
  };
  const nativeInputOutcome = (
    _session: unknown,
    outcome: string,
    requestTag: string,
    details: unknown,
  ) => ({ outcome, requestTag, details });
  const baseContext = {
    getSession: () => session,
    rpcRequestTag: (value: unknown) => value,
    nativeInputOutcome,
    turnCoordinator,
    done,
    run,
  };

  const persisted = turnModule.createRpcTurnCommandHandlers({
    ...baseContext,
    persistedNativeRequestOutcome: () => "steer",
  } as any);
  const persistedResult = await persisted.prompt(
    request("prompt", { requestTag: "request-1" }),
  );
  assert.equal(persistedResult.data.outcome, "rejoined");
  assert.equal(persistedResult.data.details.originalOutcome, "steer");

  const conflict = turnModule.createRpcTurnCommandHandlers({
    ...baseContext,
    persistedNativeRequestOutcome: () => undefined,
    nativeRequestReceiptState: () => "conflict",
  } as any);
  const conflictResult = await conflict.prompt(
    request("prompt", { requestTag: "request-2" }),
  );
  assert.equal(conflictResult.data.outcome, "indeterminate");

  let persistedCalls = 0;
  const observed = turnModule.createRpcTurnCommandHandlers({
    ...baseContext,
    persistedNativeRequestOutcome: () =>
      ++persistedCalls === 1 ? undefined : "followUp",
    nativeRequestReceiptState: () => "none",
    turnCoordinator: {
      ...turnCoordinator,
      observedRole: () => "followUp",
    },
    waitForPersistedUserRequestTag: async () => undefined,
  } as any);
  const observedResult = await observed.prompt(
    request("prompt", { requestTag: "request-3" }),
  );
  assert.equal(observedResult.data.outcome, "rejoined");
  assert.equal(observedResult.data.details.originalOutcome, "followUp");

  let activePersistedCalls = 0;
  const active = turnModule.createRpcTurnCommandHandlers({
    ...baseContext,
    persistedNativeRequestOutcome: () =>
      ++activePersistedCalls === 1 ? undefined : "steer",
    nativeRequestReceiptState: () => "none",
    turnCoordinator: {
      ...turnCoordinator,
      isActive: true,
      activeRequestTag: "request-4",
    },
    waitForPersistedUserRequestTag: async () => undefined,
  } as any);
  const activeResult = await active.prompt(
    request("prompt", { requestTag: "request-4" }),
  );
  assert.equal(activeResult.data.outcome, "rejoined");
  assert.equal(activeResult.data.details.turnActive, true);

  let interruptedAbortCalls = 0;
  let capturedStart: unknown[] = [];
  const interrupted = turnModule.createRpcTurnCommandHandlers({
    ...baseContext,
    rpcRequestTag: (value: unknown) => value,
    abortInterruptedTurnAfterExecutionLoss: async () => {
      interruptedAbortCalls += 1;
    },
    startTurnTask: (
      _tag: string,
      operation: () => Promise<void>,
      options: unknown,
    ) => {
      capturedStart = [operation, options];
    },
    turnCoordinator: {
      ...turnCoordinator,
      waitForIdle: async () => undefined,
    },
    getSession: () => ({
      sessionFile: "session.jsonl",
      sessionId: "session-1",
    }),
  } as any);
  const interruptedResult = await interrupted.abort_interrupted_turn(
    request("abort_interrupted_turn", { requestTag: "request-5" }),
  );
  await (capturedStart[0] as () => Promise<void>)();
  assert.equal(interruptedAbortCalls, 1);
  assert.deepEqual(interruptedResult.data, {
    sessionFile: "session.jsonl",
    sessionId: "session-1",
  });
  assert.deepEqual(capturedStart[1], { forceTurnEvents: true });
  await assert.rejects(
    () =>
      interrupted.abort_interrupted_turn(
        request("abort_interrupted_turn", { requestTag: "" }),
      ),
    /requestTag is required/,
  );

  const activeState = turnModule.createRpcTurnCommandHandlers({
    ...baseContext,
    getSession: () => ({ agent: { signal: undefined } }),
    getSessionState: () => ({ state: "ready" }),
    turnCoordinator: {
      ...turnCoordinator,
      isActive: true,
      activeRequestTag: "request-6",
      turnGeneration: 4,
    },
  } as any);
  const stateResult = await activeState.get_state(request("get_state"));
  assert.equal(stateResult.data.requestTag, "request-6");
  assert.equal(stateResult.data.turnGeneration, 4);
  await assert.rejects(
    () => activeState.send_user_message(request("send_user_message")),
    /rpc_turn_already_active/,
  );
});
