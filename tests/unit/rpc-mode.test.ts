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
const { runCustomRpcMode } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-daemon", "rpc-mode.js"))
    .href
);

function wait(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function testSessionManager(getMessages = () => []) {
  return {
    buildSessionContext: () => ({ messages: getMessages() }),
    getEntries: () => [],
    getTree: () => [],
    getLeafId: () => null,
    getCwd: () => process.cwd(),
    getSessionDir: () => process.cwd(),
  };
}

test(
  "rpc mode sleep_session disposes the session without emitting runtime shutdown",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const processExit = process.exit;
    const handlers = new Map();
    const calls: string[] = [];

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function () {
      return true;
    };
    process.exit = (() => {
      calls.push("process.exit");
      return undefined as never;
    }) as unknown as typeof process.exit;

    try {
      const session = {
        isStreaming: false,
        isCompacting: false,
        sessionFile: "/tmp/test-session.jsonl",
        sessionId: "session-1",
        agent: { waitForIdle: async () => {} },
        bindExtensions: async () => {},
        subscribe: () => () => {},
        abort: async () => {
          calls.push("session.abort");
        },
        dispose: () => {
          calls.push("session.dispose");
        },
        sessionManager: {
          _rewriteFile: () => {
            calls.push("session.flush");
          },
        },
      };
      const runtime = {
        session,
        dispose: async () => {
          calls.push("runtime.dispose");
        },
      };

      void runCustomRpcMode(runtime, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(`${JSON.stringify({ id: "1", type: "sleep_session" })}\n`),
      );
      await wait(20);

      assert.deepEqual(calls, [
        "session.abort",
        "session.flush",
        "session.dispose",
        "process.exit",
      ]);
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
      process.exit = processExit;
    }
  },
);

test(
  "rpc mode shutdown_session disposes runtime with stable frontend identity and flushes the session file",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const processExit = process.exit;
    const handlers = new Map();
    const calls: string[] = [];

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function () {
      return true;
    };
    process.exit = (() => {
      calls.push("process.exit");
      return undefined as never;
    }) as unknown as typeof process.exit;

    try {
      const session = {
        isStreaming: false,
        isCompacting: false,
        sessionFile: "/tmp/test-session.jsonl",
        sessionId: "session-1",
        agent: { waitForIdle: async () => {} },
        bindExtensions: async () => {},
        subscribe: () => () => {},
        sessionManager: {
          _rewriteFile: () => {
            calls.push("session.flush");
          },
        },
      };
      const runtime = {
        session,
        dispose: async () => {
          calls.push(
            `runtime.dispose:${session.sessionManager.__rinFrontend?.kind || ""}`,
          );
        },
      };

      void runCustomRpcMode(runtime, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "1", type: "shutdown_session", frontendIdentity: { kind: "tui" } })}\n`,
        ),
      );
      await wait(20);

      assert.deepEqual(calls, [
        "runtime.dispose:tui",
        "session.flush",
        "process.exit",
      ]);
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
      process.exit = processExit;
    }
  },
);

test(
  "rpc mode abort cancels active compaction before aborting the agent",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const calls: string[] = [];

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function () {
      return true;
    };

    try {
      const session = {
        isStreaming: false,
        isCompacting: true,
        sessionFile: "/tmp/test-session.jsonl",
        sessionId: "session-1",
        agent: { waitForIdle: async () => {} },
        bindExtensions: async () => {},
        subscribe: () => () => {},
        abortCompaction: () => {
          calls.push("session.abortCompaction");
        },
        abort: async () => {
          calls.push("session.abort");
        },
      };
      const runtime = { session };

      void runCustomRpcMode(runtime, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(Buffer.from(`${JSON.stringify({ id: "1", type: "abort" })}\n`));
      await wait(20);

      assert.deepEqual(calls, ["session.abortCompaction", "session.abort"]);
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode bridges extension UI dialog requests and responses",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    let boundUiContext;

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    try {
      const session = {
        isStreaming: false,
        isCompacting: false,
        sessionFile: "/tmp/test-session.jsonl",
        sessionId: "session-1",
        agent: { waitForIdle: async () => {} },
        bindExtensions: async (bindings) => {
          boundUiContext = bindings.uiContext;
        },
        subscribe: () => () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: testSessionManager(() => session.messages || []),
        messages: [],
        prompt: async () => {},
        sendCustomMessage: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        getSessionStats: () => ({}),
        getUserMessagesForForking: () => [],
        getLastAssistantText: () => "",
        setThinkingLevel: () => {},
        cycleThinkingLevel: () => undefined,
        setSteeringMode: () => {},
        setFollowUpMode: () => {},
        compact: async () => {},
        setAutoCompactionEnabled: () => {},
        setAutoRetryEnabled: () => {},
        abortRetry: () => {},
        executeBash: async () => {},
        abortBash: async () => {},
        fork: async () => ({ cancelled: false, selectedText: "" }),
        navigateTree: async () => ({ cancelled: false }),
        exportToHtml: async () => "",
        exportToJsonl: () => "",
        importFromJsonl: async () => true,
        newSession: async () => true,
        switchSession: async () => true,
        setModel: async () => {},
        reload: async () => {},
        setSessionName: () => {},
      };

      void runCustomRpcMode(session, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
      });
      await wait(0);
      assert.equal(typeof boundUiContext?.confirm, "function");

      const confirmation = boundUiContext.confirm("Confirm", "Proceed?");
      await wait(0);
      const jsonLines = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const request = jsonLines.find(
        (line) => line.type === "extension_ui_request",
      );
      assert.equal(request.method, "confirm");
      assert.equal(request.title, "Confirm");
      assert.equal(request.message, "Proceed?");

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: request.id, type: "extension_ui_response", confirmed: true })}\n`,
        ),
      );

      assert.equal(await confirmation, true);
      boundUiContext.setWorkingMessage("Thinking");
      boundUiContext.setWorkingVisible(false);
      boundUiContext.setWorkingIndicator({ frames: ["*"], intervalMs: 100 });
      boundUiContext.setHiddenThinkingLabel("Planning");
      boundUiContext.setToolsExpanded(true);
      await wait(0);
      const parsedLines = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const response = parsedLines.find(
        (line) =>
          line.type === "response" && line.command === "extension_ui_response",
      );
      assert.equal(response.success, true);
      const requests = parsedLines.filter(
        (line) => line.type === "extension_ui_request",
      );
      assert.deepEqual(
        requests.slice(1).map((line) => ({
          method: line.method,
          message: line.message,
          visible: line.visible,
          options: line.options,
          label: line.label,
          expanded: line.expanded,
        })),
        [
          {
            method: "setWorkingMessage",
            message: "Thinking",
            visible: undefined,
            options: undefined,
            label: undefined,
            expanded: undefined,
          },
          {
            method: "setWorkingVisible",
            message: undefined,
            visible: false,
            options: undefined,
            label: undefined,
            expanded: undefined,
          },
          {
            method: "setWorkingIndicator",
            message: undefined,
            visible: undefined,
            options: { frames: ["*"], intervalMs: 100 },
            label: undefined,
            expanded: undefined,
          },
          {
            method: "setHiddenThinkingLabel",
            message: undefined,
            visible: undefined,
            options: undefined,
            label: "Planning",
            expanded: undefined,
          },
          {
            method: "setToolsExpanded",
            message: undefined,
            visible: undefined,
            options: undefined,
            label: undefined,
            expanded: true,
          },
        ],
      );
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode command context passes session replacement options through",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const calls = [];
    let bindCount = 0;
    let actions;

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function () {
      return true;
    };

    try {
      const session = {
        isStreaming: false,
        isCompacting: false,
        sessionFile: "/tmp/test-session.jsonl",
        sessionId: "session-1",
        agent: { waitForIdle: async () => {} },
        bindExtensions: async (bindings) => {
          bindCount += 1;
          actions = bindings.commandContextActions;
        },
        subscribe: () => () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: testSessionManager(() => session.messages || []),
        messages: [],
        prompt: async () => {},
        sendCustomMessage: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        getSessionStats: () => ({}),
        getUserMessagesForForking: () => [],
        getLastAssistantText: () => "",
        setThinkingLevel: () => {},
        cycleThinkingLevel: () => undefined,
        setSteeringMode: () => {},
        setFollowUpMode: () => {},
        compact: async () => {},
        setAutoCompactionEnabled: () => {},
        setAutoRetryEnabled: () => {},
        abortRetry: () => {},
        executeBash: async () => {},
        abortBash: async () => {},
        fork: async () => ({ cancelled: false, selectedText: "" }),
        navigateTree: async () => ({ cancelled: false }),
        exportToHtml: async () => "",
        exportToJsonl: () => "",
        importFromJsonl: async () => true,
        newSession: async () => true,
        switchSession: async () => true,
        setModel: async () => {},
        reload: async () => {},
        setSessionName: () => {},
      };
      const runtime = {
        session,
        newSession: async (options) => {
          calls.push(["newSession", options]);
          return { cancelled: false };
        },
        fork: async (entryId, options) => {
          calls.push(["fork", entryId, options]);
          return { cancelled: false };
        },
        switchSession: async (sessionPath, options) => {
          calls.push(["switchSession", sessionPath, options]);
          return { cancelled: false };
        },
        importFromJsonl: async () => ({ cancelled: false }),
      };

      void runCustomRpcMode(runtime, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
      });
      await wait(0);
      assert.equal(typeof actions?.newSession, "function");

      const setup = async () => {};
      const withSession = async () => {};
      const newSessionOptions = { setup, withSession };
      const forkOptions = { position: "at", withSession };
      const switchOptions = { withSession };

      assert.deepEqual(await actions.newSession(newSessionOptions), {
        cancelled: false,
      });
      assert.deepEqual(await actions.fork("entry-1", forkOptions), {
        cancelled: false,
      });
      assert.deepEqual(
        await actions.switchSession("/tmp/next.jsonl", switchOptions),
        { cancelled: false },
      );

      assert.deepEqual(calls, [
        ["newSession", newSessionOptions],
        ["fork", "entry-1", forkOptions],
        ["switchSession", "/tmp/next.jsonl", switchOptions],
      ]);
      assert.equal(bindCount, 4);
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode exposes daemon session tools and extension message actions",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const calls = [];

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    try {
      const session = {
        isStreaming: false,
        isCompacting: false,
        sessionFile: "/tmp/test-session.jsonl",
        sessionId: "session-1",
        agent: { waitForIdle: async () => {} },
        bindExtensions: async () => {},
        subscribe: () => () => {},
        getActiveToolNames: () => ["bash"],
        getAllTools: () => [
          { name: "bash", description: "Run shell", parameters: {} },
          { name: "read", description: "Read file", parameters: {} },
        ],
        setActiveToolsByName: (toolNames) => {
          calls.push(["setActiveToolsByName", toolNames]);
        },
        _refreshToolRegistry: () => {
          calls.push(["refreshTools"]);
        },
        sessionManager: {
          appendCustomEntry: (customType, data) => {
            calls.push(["appendCustomEntry", customType, data]);
          },
          getEntries: () => [],
          getTree: () => [],
          getLeafId: () => null,
          getCwd: () => process.cwd(),
          getSessionDir: () => process.cwd(),
        },
        sendCustomMessage: async (message, options) => {
          calls.push(["sendCustomMessage", message, options]);
        },
        sendUserMessage: async (content, options) => {
          calls.push(["sendUserMessage", content, options]);
        },
        prompt: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        messages: [],
        getSessionStats: () => ({}),
        getUserMessagesForForking: () => [],
        getLastAssistantText: () => "",
        setThinkingLevel: () => {},
        cycleThinkingLevel: () => undefined,
        setSteeringMode: () => {},
        setFollowUpMode: () => {},
        compact: async () => {},
        setAutoCompactionEnabled: () => {},
        setAutoRetryEnabled: () => {},
        abortRetry: () => {},
        executeBash: async (command, _onChunk, options) => {
          calls.push(["executeBash", command, options]);
        },
        abortBash: async () => {},
        fork: async () => ({ cancelled: false, selectedText: "" }),
        navigateTree: async () => ({ cancelled: false }),
        exportToHtml: async () => "",
        exportToJsonl: () => "",
        importFromJsonl: async () => true,
        newSession: async () => true,
        switchSession: async () => true,
        setModel: async () => {},
        reload: async () => {},
        setSessionName: () => {},
      };

      void runCustomRpcMode(session, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      const commands = [
        { id: "1", type: "get_active_tools" },
        { id: "2", type: "get_all_tools" },
        { id: "3", type: "set_active_tools", toolNames: ["read"] },
        { id: "4", type: "refresh_tools" },
        {
          id: "5",
          type: "append_custom_entry",
          customType: "demo",
          data: { ok: true },
        },
        {
          id: "6",
          type: "send_custom_message",
          message: { customType: "notice", content: "hello" },
          options: { triggerTurn: false },
        },
        {
          id: "7",
          type: "send_user_message",
          content: [{ type: "text", text: "hi" }],
          options: { deliverAs: "followUp" },
        },
        {
          id: "8",
          type: "bash",
          command: "echo hidden",
          excludeFromContext: true,
        },
      ];
      onData(
        Buffer.from(
          commands.map((command) => JSON.stringify(command)).join("\n") + "\n",
        ),
      );
      await wait(40);

      const responses = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((line) => line?.type === "response");
      const byId = new Map(responses.map((line) => [line.id, line]));
      assert.deepEqual(byId.get("1")?.data, { tools: ["bash"] });
      assert.equal(byId.get("2")?.data.tools.length, 2);
      assert.deepEqual(byId.get("3")?.data, { tools: ["bash"] });
      assert.equal(byId.get("4")?.data.tools.length, 2);
      assert.deepEqual(byId.get("5")?.success, true);
      assert.deepEqual(byId.get("6")?.data, { sent: true });
      assert.deepEqual(byId.get("7")?.data, { sent: true });
      assert.equal(byId.get("8")?.success, true);
      assert.deepEqual(calls, [
        ["setActiveToolsByName", ["read"]],
        ["refreshTools"],
        ["appendCustomEntry", "demo", { ok: true }],
        [
          "sendCustomMessage",
          { customType: "notice", content: "hello" },
          { triggerTurn: false },
        ],
        [
          "sendUserMessage",
          [{ type: "text", text: "hi" }],
          { deliverAs: "followUp" },
        ],
        ["executeBash", "echo hidden", { excludeFromContext: true }],
      ]);
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode applies non-persistent model changes without calling the settings-backed setter or extension events",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const appendedModels: string[] = [];
    const extensionEvents: any[] = [];

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    try {
      const targetModel = {
        provider: "openai-codex",
        id: "gpt-5.5",
        reasoning: true,
      };
      const session = {
        isStreaming: false,
        isCompacting: false,
        sessionFile: "/tmp/test-session.jsonl",
        sessionId: "session-1",
        get thinkingLevel() {
          return this.agent.state.thinkingLevel;
        },
        agent: {
          state: { model: null, thinkingLevel: "high" },
          waitForIdle: async () => {},
        },
        _extensionRunner: {
          emit: async (event: any) => {
            extensionEvents.push(event);
            await new Promise(() => {});
          },
        },
        bindExtensions: async () => {},
        subscribe: () => () => {},
        modelRegistry: {
          getAvailable: async () => [targetModel],
          hasConfiguredAuth: () => true,
        },
        sessionManager: {
          appendModelChange(provider: string, modelId: string) {
            appendedModels.push(`${provider}/${modelId}`);
          },
          appendThinkingLevelChange: () => {},
          getEntries: () => [],
          getTree: () => [],
          getLeafId: () => null,
          getCwd: () => process.cwd(),
          getSessionDir: () => process.cwd(),
        },
        messages: [],
        prompt: async () => {},
        sendCustomMessage: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        getSessionStats: () => ({}),
        getUserMessagesForForking: () => [],
        getLastAssistantText: () => "",
        getAvailableThinkingLevels: () => ["off", "low", "medium", "high"],
        setModel: () => {
          throw new Error("persistent setter should not be called");
        },
        setThinkingLevel: () => {
          throw new Error("persistent thinking setter should not be called");
        },
        cycleThinkingLevel: () => undefined,
        setSteeringMode: () => {},
        setFollowUpMode: () => {},
        compact: async () => {},
        setAutoCompactionEnabled: () => {},
        setAutoRetryEnabled: () => {},
        abortRetry: () => {},
        executeBash: async () => {},
        abortBash: async () => {},
        fork: async () => ({ cancelled: false, selectedText: "" }),
        navigateTree: async () => ({ cancelled: false }),
        exportToHtml: async () => "",
        exportToJsonl: () => "",
        importFromJsonl: async () => true,
        newSession: async () => true,
        switchSession: async () => true,
        reload: async () => {},
        setSessionName: () => {},
      };

      void runCustomRpcMode(session, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "1", type: "set_model", provider: "openai-codex", modelId: "gpt-5.5", persistSettings: false })}\n`,
        ),
      );
      await wait(20);

      assert.equal(session.agent.state.model, targetModel);
      assert.deepEqual(appendedModels, ["openai-codex/gpt-5.5"]);
      assert.deepEqual(extensionEvents, []);
      const response = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .find((line) => line.type === "response" && line.id === "1");
      assert.equal(response.success, true);
      assert.deepEqual(response.data, targetModel);
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode resets model options from settings without full session reload or extension events",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const appendedModels: string[] = [];
    const appendedLevels: string[] = [];
    const calls: string[] = [];
    const extensionEvents: any[] = [];

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    try {
      const targetModel = {
        provider: "openai-codex",
        id: "gpt-5.5",
        reasoning: true,
      };
      const session = {
        isStreaming: false,
        isCompacting: false,
        sessionFile: "/tmp/test-session.jsonl",
        sessionId: "session-1",
        get model() {
          return this.agent.state.model;
        },
        get thinkingLevel() {
          return this.agent.state.thinkingLevel;
        },
        agent: {
          state: { model: null, thinkingLevel: "low" },
          waitForIdle: async () => {},
        },
        _extensionRunner: {
          emit: async (event: any) => {
            extensionEvents.push(event);
            await new Promise(() => {});
          },
        },
        bindExtensions: async () => {},
        subscribe: () => () => {},
        settingsManager: {
          settings: {},
          reload: async () => {
            calls.push("settings.reload");
          },
          getDefaultProvider: () => "openai-codex",
          getDefaultModel: () => "gpt-5.5",
          getDefaultThinkingLevel: () => "high",
        },
        modelRegistry: {
          getAvailable: async () => [targetModel],
          hasConfiguredAuth: () => true,
        },
        sessionManager: {
          appendModelChange(provider: string, modelId: string) {
            appendedModels.push(`${provider}/${modelId}`);
          },
          appendThinkingLevelChange(level: string) {
            appendedLevels.push(level);
          },
          getEntries: () => [],
          getTree: () => [],
          getLeafId: () => null,
          getCwd: () => process.cwd(),
          getSessionDir: () => process.cwd(),
        },
        messages: [],
        prompt: async () => {},
        sendCustomMessage: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        getSessionStats: () => ({}),
        getUserMessagesForForking: () => [],
        getLastAssistantText: () => "",
        getAvailableThinkingLevels: () => ["off", "low", "medium", "high"],
        setModel: () => {
          throw new Error("persistent model setter should not be called");
        },
        setThinkingLevel: () => {
          throw new Error("persistent thinking setter should not be called");
        },
        cycleThinkingLevel: () => undefined,
        setSteeringMode: () => {},
        setFollowUpMode: () => {},
        compact: async () => {},
        setAutoCompactionEnabled: () => {},
        setAutoRetryEnabled: () => {},
        abortRetry: () => {},
        executeBash: async () => {},
        abortBash: async () => {},
        fork: async () => ({ cancelled: false, selectedText: "" }),
        navigateTree: async () => ({ cancelled: false }),
        exportToHtml: async () => "",
        exportToJsonl: () => "",
        importFromJsonl: async () => true,
        newSession: async () => true,
        switchSession: async () => true,
        reload: async () => {
          throw new Error("full session reload should not be called");
        },
        setSessionName: () => {},
      };

      void runCustomRpcMode(session, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "1", type: "reset_model_options_from_settings" })}\n`,
        ),
      );
      await wait(20);

      assert.deepEqual(calls, ["settings.reload"]);
      assert.deepEqual(extensionEvents, []);
      assert.equal(session.agent.state.model, targetModel);
      assert.equal(session.agent.state.thinkingLevel, "high");
      assert.deepEqual(appendedModels, ["openai-codex/gpt-5.5"]);
      assert.deepEqual(appendedLevels, ["high"]);
      const response = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .find((line) => line.type === "response" && line.id === "1");
      assert.equal(response.success, true);
      assert.deepEqual(response.data, {
        model: targetModel,
        thinkingLevel: "high",
      });
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode applies non-persistent thinking level changes without calling the settings-backed setter",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const appendedLevels: string[] = [];

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    try {
      const session = {
        isStreaming: false,
        isCompacting: false,
        sessionFile: "/tmp/test-session.jsonl",
        sessionId: "session-1",
        get thinkingLevel() {
          return this.agent.state.thinkingLevel;
        },
        agent: {
          state: { thinkingLevel: "high" },
          waitForIdle: async () => {},
        },
        bindExtensions: async () => {},
        subscribe: () => () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: {
          appendThinkingLevelChange(level: string) {
            appendedLevels.push(level);
          },
          getEntries: () => [],
          getTree: () => [],
          getLeafId: () => null,
          getCwd: () => process.cwd(),
          getSessionDir: () => process.cwd(),
        },
        messages: [],
        prompt: async () => {},
        sendCustomMessage: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        getSessionStats: () => ({}),
        getUserMessagesForForking: () => [],
        getLastAssistantText: () => "",
        getAvailableThinkingLevels: () => ["off", "low", "medium", "high"],
        setThinkingLevel: () => {
          throw new Error("persistent setter should not be called");
        },
        cycleThinkingLevel: () => undefined,
        setSteeringMode: () => {},
        setFollowUpMode: () => {},
        compact: async () => {},
        setAutoCompactionEnabled: () => {},
        setAutoRetryEnabled: () => {},
        abortRetry: () => {},
        executeBash: async () => {},
        abortBash: async () => {},
        fork: async () => ({ cancelled: false, selectedText: "" }),
        navigateTree: async () => ({ cancelled: false }),
        exportToHtml: async () => "",
        exportToJsonl: () => "",
        importFromJsonl: async () => true,
        newSession: async () => true,
        switchSession: async () => true,
        setModel: async () => {},
        reload: async () => {},
        setSessionName: () => {},
      };

      void runCustomRpcMode(session, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "1", type: "set_thinking_level", level: "low", persistSettings: false })}\n`,
        ),
      );
      await wait(20);

      assert.equal(session.agent.state.thinkingLevel, "low");
      assert.equal(session.thinkingLevel, "low");
      assert.deepEqual(appendedLevels, ["low"]);
      const response = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .find((line) => line.type === "response" && line.id === "1");
      assert.equal(response.success, true);
      assert.deepEqual(response.data, { level: "low" });
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode executes extension slash commands on the daemon session",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const prompted = [];

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    try {
      const session = {
        isStreaming: false,
        isCompacting: false,
        sessionFile: "/tmp/test-session.jsonl",
        sessionId: "session-1",
        agent: { waitForIdle: async () => {} },
        bindExtensions: async () => {},
        subscribe: () => () => {},
        extensionRunner: {
          getCommand(name) {
            return name === "hello" ? { invocationName: "hello" } : undefined;
          },
        },
        prompt: async (message) => {
          prompted.push(message);
        },
        sendCustomMessage: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: testSessionManager(() => session.messages || []),
        messages: [],
        getSessionStats: () => ({}),
        getUserMessagesForForking: () => [],
        getLastAssistantText: () => "",
        setThinkingLevel: () => {},
        cycleThinkingLevel: () => undefined,
        setSteeringMode: () => {},
        setFollowUpMode: () => {},
        compact: async () => {},
        setAutoCompactionEnabled: () => {},
        setAutoRetryEnabled: () => {},
        abortRetry: () => {},
        executeBash: async () => {},
        abortBash: async () => {},
        fork: async () => ({ cancelled: false, selectedText: "" }),
        navigateTree: async () => ({ cancelled: false }),
        exportToHtml: async () => "",
        exportToJsonl: () => "",
        importFromJsonl: async () => true,
        newSession: async () => true,
        switchSession: async () => true,
        setModel: async () => {},
        reload: async () => {},
        setSessionName: () => {},
      };

      void runCustomRpcMode(session, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "1", type: "run_command", commandLine: "/hello world" })}\n`,
        ),
      );
      await wait(20);

      assert.deepEqual(prompted, ["/hello world"]);
      const response = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .find((line) => line.type === "response" && line.id === "1");
      assert.equal(response.success, true);
      assert.deepEqual(response.data, { handled: true });
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode executes /todos through the daemon builtin command path",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    try {
      const session = {
        isStreaming: false,
        isCompacting: false,
        sessionFile: "/tmp/test-session.jsonl",
        sessionId: "session-1",
        agent: { waitForIdle: async () => {}, state: { messages: [] } },
        bindExtensions: async () => {},
        subscribe: () => () => {},
        extensionRunner: { getCommand: () => undefined },
        prompt: async () => {
          throw new Error("builtin command should not re-enter prompt");
        },
        sendCustomMessage: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: testSessionManager(() => session.messages || []),
        messages: [],
        getSessionStats: () => ({}),
        getUserMessagesForForking: () => [],
        getLastAssistantText: () => "",
        setThinkingLevel: () => {},
        cycleThinkingLevel: () => undefined,
        setSteeringMode: () => {},
        setFollowUpMode: () => {},
        compact: async () => {},
        setAutoCompactionEnabled: () => {},
        setAutoRetryEnabled: () => {},
        abortRetry: () => {},
        executeBash: async () => {},
        abortBash: async () => {},
        fork: async () => ({ cancelled: false, selectedText: "" }),
        navigateTree: async () => ({ cancelled: false }),
        exportToHtml: async () => "",
        exportToJsonl: () => "",
        importFromJsonl: async () => true,
        newSession: async () => true,
        switchSession: async () => true,
        setModel: async () => {},
        reload: async () => {},
        setSessionName: () => {},
      };

      void runCustomRpcMode(session, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "1", type: "run_command", commandLine: "/todos" })}\n`,
        ),
      );
      await wait(20);

      const response = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .find((line) => line.type === "response" && line.id === "1");
      assert.equal(response.success, true);
      assert.deepEqual(response.data, { handled: true });
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode returns extension command argument completions from daemon session",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    try {
      const session = {
        isStreaming: false,
        isCompacting: false,
        sessionFile: "/tmp/test-session.jsonl",
        sessionId: "session-1",
        agent: { waitForIdle: async () => {} },
        bindExtensions: async () => {},
        subscribe: () => () => {},
        extensionRunner: {
          getCommand(name) {
            return name === "deploy"
              ? {
                  getArgumentCompletions: async (prefix) => [
                    { value: `${prefix}-prod`, label: "production" },
                  ],
                }
              : undefined;
          },
        },
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: testSessionManager(() => session.messages || []),
        messages: [],
        prompt: async () => {},
        sendCustomMessage: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        getSessionStats: () => ({}),
        getUserMessagesForForking: () => [],
        getLastAssistantText: () => "",
        setThinkingLevel: () => {},
        cycleThinkingLevel: () => undefined,
        setSteeringMode: () => {},
        setFollowUpMode: () => {},
        compact: async () => {},
        setAutoCompactionEnabled: () => {},
        setAutoRetryEnabled: () => {},
        abortRetry: () => {},
        executeBash: async () => {},
        abortBash: async () => {},
        fork: async () => ({ cancelled: false, selectedText: "" }),
        navigateTree: async () => ({ cancelled: false }),
        exportToHtml: async () => "",
        exportToJsonl: () => "",
        importFromJsonl: async () => true,
        newSession: async () => true,
        switchSession: async () => true,
        setModel: async () => {},
        reload: async () => {},
        setSessionName: () => {},
      };

      void runCustomRpcMode(session, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "1", type: "get_command_argument_completions", commandName: "deploy", argumentPrefix: "app" })}\n`,
        ),
      );
      await wait(20);

      const response = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .find((line) => line.type === "response" && line.id === "1");
      assert.equal(response.success, true);
      assert.deepEqual(response.data, {
        items: [{ id: "app-prod", value: "app-prod", label: "production" }],
      });
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode emits canonical finalText on turn completion",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const sessionSubscribers = new Set();

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    try {
      const session = {
        isStreaming: false,
        isCompacting: false,
        sessionFile: "/tmp/test-session.jsonl",
        sessionId: "session-1",
        agent: { waitForIdle: async () => {} },
        bindExtensions: async () => {},
        subscribe: (handler) => {
          sessionSubscribers.add(handler);
          return () => sessionSubscribers.delete(handler);
        },
        prompt: async () => {
          const assistantMessage = {
            role: "assistant",
            content: [{ type: "text", text: "final from rpc mode" }],
          };
          session.messages = [
            { role: "user", content: [{ type: "text", text: "hello" }] },
            assistantMessage,
          ];
          for (const handler of sessionSubscribers) {
            handler({ type: "message_end", message: assistantMessage });
          }
        },
        sendCustomMessage: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: testSessionManager(() => session.messages || []),
        messages: [],
        getSessionStats: () => ({}),
        getUserMessagesForForking: () => [],
        getLastAssistantText: () => "",
        setThinkingLevel: () => {},
        cycleThinkingLevel: () => undefined,
        setSteeringMode: () => {},
        setFollowUpMode: () => {},
        compact: async () => {},
        setAutoCompactionEnabled: () => {},
        setAutoRetryEnabled: () => {},
        abortRetry: () => {},
        executeBash: async () => {},
        abortBash: async () => {},
        fork: async () => ({ cancelled: false, selectedText: "" }),
        navigateTree: async () => ({ cancelled: false }),
        exportToHtml: async () => "",
        exportToJsonl: () => "",
        importFromJsonl: async () => true,
        newSession: async () => true,
        switchSession: async () => true,
        setModel: async () => {},
        reload: async () => {},
        setSessionName: () => {},
      };

      void runCustomRpcMode(session, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
        builtinSlashCommands: [],
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "1", type: "prompt", message: "hello", requestTag: "tag-1" })}\n`,
        ),
      );
      await wait(20);

      const events = lines
        .join("")
        .trim()
        .split(/\n+/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const completion = events.find(
        (event) =>
          event.type === "rpc_turn_event" && event.event === "complete",
      );
      assert.equal(completion?.requestTag, "tag-1");
      assert.equal(completion?.finalText, "final from rpc mode");
      assert.deepEqual(completion?.result, {
        messages: [{ type: "text", text: "final from rpc mode" }],
      });
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode waits for prompt lifecycle before resolving turn messages",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines: string[] = [];
    const sessionSubscribers = new Set<(event: any) => void>();
    let resolvePostAgentQueue: (() => void) | undefined;

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk: any) {
      lines.push(String(chunk));
      return true;
    };

    try {
      const postAgentQueue = new Promise<void>((resolve) => {
        resolvePostAgentQueue = resolve;
      });
      let waitForIdleCalled = false;
      let promptSettled = false;
      const session = {
        isStreaming: false,
        isCompacting: true,
        sessionFile: "/tmp/test-session.jsonl",
        sessionId: "session-1",
        agent: {
          waitForIdle: async () => {
            waitForIdleCalled = true;
            await postAgentQueue;
          },
        },
        _agentEventQueue: postAgentQueue,
        bindExtensions: async () => {},
        subscribe: (handler) => {
          sessionSubscribers.add(handler);
          return () => sessionSubscribers.delete(handler);
        },
        prompt: async () => {
          const assistantMessage = {
            role: "assistant",
            content: [{ type: "text", text: "final before compaction" }],
          };
          session.messages = [
            { role: "user", content: [{ type: "text", text: "hello" }] },
            assistantMessage,
          ];
          for (const handler of sessionSubscribers) {
            handler({ type: "message_end", message: assistantMessage });
          }
          await postAgentQueue;
          promptSettled = true;
        },
        sendCustomMessage: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: testSessionManager(() => session.messages || []),
        messages: [],
        getSessionStats: () => ({}),
        getUserMessagesForForking: () => [],
        getLastAssistantText: () => "",
        setThinkingLevel: () => {},
        cycleThinkingLevel: () => undefined,
        setSteeringMode: () => {},
        setFollowUpMode: () => {},
        compact: async () => {},
        setAutoCompactionEnabled: () => {},
        setAutoRetryEnabled: () => {},
        abortRetry: () => {},
        executeBash: async () => {},
        abortBash: async () => {},
        fork: async () => ({ cancelled: false, selectedText: "" }),
        navigateTree: async () => ({ cancelled: false }),
        exportToHtml: async () => "",
        exportToJsonl: () => "",
        importFromJsonl: async () => true,
        newSession: async () => true,
        switchSession: async () => true,
        setModel: async () => {},
        reload: async () => {},
        setSessionName: () => {},
      };

      void runCustomRpcMode(session, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
        builtinSlashCommands: [],
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "1", type: "prompt", message: "hello", requestTag: "tag-1" })}\n`,
        ),
      );
      await wait(20);

      const parseEvents = () =>
        lines
          .join("")
          .trim()
          .split(/\n+/)
          .filter(Boolean)
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .filter(Boolean);

      assert.equal(
        parseEvents().some(
          (event) =>
            event.type === "rpc_turn_event" && event.event === "complete",
        ),
        false,
      );
      assert.equal(promptSettled, false);

      resolvePostAgentQueue?.();
      await wait(20);

      const events = parseEvents();
      const completion = events.find(
        (event) =>
          event.type === "rpc_turn_event" && event.event === "complete",
      );
      assert.equal(completion?.requestTag, "tag-1");
      assert.equal(completion?.finalText, "final before compaction");
      assert.deepEqual(completion?.result, {
        messages: [{ type: "text", text: "final before compaction" }],
      });
      assert.equal(waitForIdleCalled, false);
      assert.equal(promptSettled, true);
    } finally {
      resolvePostAgentQueue?.();
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode emits agent failure messages instead of missing-final sentinels",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const sessionSubscribers = new Set();

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    try {
      const failureMessage = "Retry failed after 3 attempts: fetch failed";
      const stateMessages = [];
      const session = {
        isStreaming: false,
        isCompacting: false,
        sessionFile: "/tmp/test-session.jsonl",
        sessionId: "session-1",
        agent: {
          state: { messages: stateMessages, errorMessage: "" },
          waitForIdle: async () => {},
        },
        bindExtensions: async () => {},
        subscribe: (handler) => {
          sessionSubscribers.add(handler);
          return () => sessionSubscribers.delete(handler);
        },
        prompt: async () => {
          stateMessages.push({
            role: "assistant",
            content: [{ type: "text", text: "" }],
            stopReason: "error",
            errorMessage: failureMessage,
          });
          session.agent.state.errorMessage = failureMessage;
          for (const handler of sessionSubscribers) {
            handler({
              type: "agent_end",
              messages: stateMessages.slice(-1),
            });
          }
        },
        sendCustomMessage: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: testSessionManager(() => session.messages || []),
        messages: stateMessages,
        getSessionStats: () => ({}),
        getUserMessagesForForking: () => [],
        getLastAssistantText: () => "",
        setThinkingLevel: () => {},
        cycleThinkingLevel: () => undefined,
        setSteeringMode: () => {},
        setFollowUpMode: () => {},
        compact: async () => {},
        setAutoCompactionEnabled: () => {},
        setAutoRetryEnabled: () => {},
        abortRetry: () => {},
        executeBash: async () => {},
        abortBash: async () => {},
        fork: async () => ({ cancelled: false, selectedText: "" }),
        navigateTree: async () => ({ cancelled: false }),
        exportToHtml: async () => "",
        exportToJsonl: () => "",
        importFromJsonl: async () => true,
        newSession: async () => true,
        switchSession: async () => true,
        setModel: async () => {},
        reload: async () => {},
        setSessionName: () => {},
      };

      void runCustomRpcMode(session, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
        builtinSlashCommands: [],
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "1", type: "prompt", message: "hello", requestTag: "tag-1" })}\n`,
        ),
      );
      await wait(20);

      const events = lines
        .join("")
        .trim()
        .split(/\n+/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const error = events.find(
        (event) => event.type === "rpc_turn_event" && event.event === "error",
      );
      assert.equal(error?.requestTag, "tag-1");
      assert.equal(error?.error, failureMessage);
      assert.equal(
        events.some(
          (event) =>
            event.type === "rpc_turn_event" && event.event === "complete",
        ),
        false,
      );
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode surfaces websocket errors instead of waiting for continuation",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const sessionSubscribers = new Set();
    const stateMessages = [];

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    try {
      const emit = (event) => {
        for (const handler of sessionSubscribers) handler(event);
      };
      const session = {
        isStreaming: false,
        isCompacting: false,
        sessionFile: "/tmp/test-session.jsonl",
        sessionId: "session-1",
        agent: {
          state: { messages: stateMessages, errorMessage: "" },
          waitForIdle: async () => {},
        },
        bindExtensions: async () => {},
        subscribe: (handler) => {
          sessionSubscribers.add(handler);
          return () => sessionSubscribers.delete(handler);
        },
        prompt: async () => {
          const errorMessage = {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "WebSocket closed 1009",
          };
          stateMessages.push(errorMessage);
          emit({ type: "message_end", message: errorMessage });
          setTimeout(() => {
            const finalMessage = {
              role: "assistant",
              content: [{ type: "text", text: "recovered final" }],
              stopReason: "stop",
              errorMessage: "",
            };
            stateMessages.push(finalMessage);
            emit({ type: "compaction_end", result: { summary: "ok" } });
            emit({ type: "message_end", message: finalMessage });
          }, 5);
        },
        sendCustomMessage: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: testSessionManager(() => session.messages || []),
        messages: stateMessages,
        getSessionStats: () => ({}),
        getUserMessagesForForking: () => [],
        getLastAssistantText: () => "recovered final",
        setThinkingLevel: () => {},
        cycleThinkingLevel: () => undefined,
        setSteeringMode: () => {},
        setFollowUpMode: () => {},
        compact: async () => {},
        setAutoCompactionEnabled: () => {},
        setAutoRetryEnabled: () => {},
        abortRetry: () => {},
        executeBash: async () => {},
        abortBash: async () => {},
        fork: async () => ({ cancelled: false, selectedText: "" }),
        navigateTree: async () => ({ cancelled: false }),
        exportToHtml: async () => "",
        exportToJsonl: () => "",
        importFromJsonl: async () => true,
        newSession: async () => true,
        switchSession: async () => true,
        setModel: async () => {},
        reload: async () => {},
        setSessionName: () => {},
      };

      void runCustomRpcMode(session, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
        builtinSlashCommands: [],
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "1", type: "prompt", message: "hello", requestTag: "tag-1" })}\n`,
        ),
      );
      await wait(40);

      const events = lines
        .join("")
        .trim()
        .split(/\n+/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const error = events.find(
        (event) => event.type === "rpc_turn_event" && event.event === "error",
      );
      assert.equal(error?.requestTag, "tag-1");
      assert.match(String(error?.error || ""), /WebSocket closed 1009/);
      assert.equal(
        events.some(
          (event) =>
            event.type === "rpc_turn_event" && event.event === "complete",
        ),
        false,
      );
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode waits for Pi-native overflow recovery inside prompt lifecycle",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const sessionSubscribers = new Set();
    const stateMessages = [];

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    try {
      const emit = (event) => {
        for (const handler of sessionSubscribers) handler(event);
      };
      const session = {
        isStreaming: false,
        isCompacting: false,
        sessionFile: "/tmp/test-session.jsonl",
        sessionId: "session-1",
        agent: {
          state: { messages: stateMessages, errorMessage: "" },
          waitForIdle: async () => {},
        },
        bindExtensions: async () => {},
        subscribe: (handler) => {
          sessionSubscribers.add(handler);
          return () => sessionSubscribers.delete(handler);
        },
        prompt: async () => {
          const errorMessage = {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "Codex error: context_length_exceeded",
              },
            ],
            stopReason: "error",
            errorMessage: "context_length_exceeded",
          };
          stateMessages.push(errorMessage);
          emit({ type: "message_end", message: errorMessage });
          emit({ type: "agent_end" });
          emit({ type: "compaction_start", reason: "overflow" });
          emit({
            type: "compaction_end",
            reason: "overflow",
            aborted: false,
            willRetry: true,
            result: { summary: "ok" },
          });
          const finalMessage = {
            role: "assistant",
            content: [{ type: "text", text: "continued final" }],
            stopReason: "stop",
            errorMessage: "",
          };
          stateMessages.push(finalMessage);
          emit({ type: "agent_start" });
          emit({ type: "message_end", message: finalMessage });
          emit({ type: "agent_end" });
        },
        sendCustomMessage: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: testSessionManager(() => session.messages || []),
        messages: stateMessages,
        getSessionStats: () => ({}),
        getUserMessagesForForking: () => [],
        getLastAssistantText: () => "continued final",
        setThinkingLevel: () => {},
        cycleThinkingLevel: () => undefined,
        setSteeringMode: () => {},
        setFollowUpMode: () => {},
        compact: async () => {},
        setAutoCompactionEnabled: () => {},
        setAutoRetryEnabled: () => {},
        abortRetry: () => {},
        executeBash: async () => {},
        abortBash: async () => {},
        fork: async () => ({ cancelled: false, selectedText: "" }),
        navigateTree: async () => ({ cancelled: false }),
        exportToHtml: async () => "",
        exportToJsonl: () => "",
        importFromJsonl: async () => true,
        newSession: async () => true,
        switchSession: async () => true,
        setModel: async () => {},
        reload: async () => {},
        setSessionName: () => {},
      };

      void runCustomRpcMode(session, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
        builtinSlashCommands: [],
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "1", type: "prompt", message: "hello", requestTag: "tag-1" })}\n`,
        ),
      );
      await wait(40);

      const emitted = lines
        .join("")
        .trim()
        .split(/\n+/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const completion = emitted.find(
        (event) =>
          event.type === "rpc_turn_event" && event.event === "complete",
      );
      assert.equal(completion?.requestTag, "tag-1");
      assert.equal(completion?.finalText, "continued final");
      assert.equal(
        emitted.some(
          (event) => event.type === "rpc_turn_event" && event.event === "error",
        ),
        false,
      );
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode completes the original prompt without hidden todo continuation",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const sessionSubscribers = new Set();
    const branch = [];
    const promptSources = [];

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    try {
      const emit = (event) => {
        for (const handler of sessionSubscribers) handler(event);
      };
      const session = {
        isStreaming: false,
        isCompacting: false,
        sessionFile: "/tmp/test-session.jsonl",
        sessionId: "session-1",
        agent: { waitForIdle: async () => {} },
        bindExtensions: async () => {},
        subscribe: (handler) => {
          sessionSubscribers.add(handler);
          return () => sessionSubscribers.delete(handler);
        },
        prompt: async (_message, options) => {
          promptSources.push(options?.source || "");
          const assistantMessage = {
            role: "assistant",
            content: [{ type: "text", text: "original final" }],
          };
          branch.push({
            type: "message",
            message: {
              role: "toolResult",
              toolName: "todo",
              details: {
                action: "list",
                todos: [{ id: 1, text: "unfinished work", done: false }],
                nextId: 2,
              },
            },
          });
          branch.push({ type: "message", message: assistantMessage });
          emit({
            type: "message_end",
            message: assistantMessage,
          });
        },
        sendCustomMessage: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: {
          getBranch: () => branch,
          getEntries: () => branch,
          getTree: () => [],
          getLeafId: () => null,
          getCwd: () => process.cwd(),
          getSessionDir: () => process.cwd(),
        },
        messages: [],
        getSessionStats: () => ({}),
        getUserMessagesForForking: () => [],
        getLastAssistantText: () => "stale final must not be used",
        setThinkingLevel: () => {},
        cycleThinkingLevel: () => undefined,
        setSteeringMode: () => {},
        setFollowUpMode: () => {},
        compact: async () => {},
        setAutoCompactionEnabled: () => {},
        setAutoRetryEnabled: () => {},
        abortRetry: () => {},
        executeBash: async () => {},
        abortBash: async () => {},
        fork: async () => ({ cancelled: false, selectedText: "" }),
        navigateTree: async () => ({ cancelled: false }),
        exportToHtml: async () => "",
        exportToJsonl: () => "",
        importFromJsonl: async () => true,
        newSession: async () => true,
        switchSession: async () => true,
        setModel: async () => {},
        reload: async () => {},
        setSessionName: () => {},
      };

      void runCustomRpcMode(session, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
        builtinSlashCommands: [],
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "1", type: "prompt", message: "hello", requestTag: "tag-1" })}\n`,
        ),
      );
      await wait(20);

      const events = lines
        .join("")
        .trim()
        .split(/\n+/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const completions = events.filter(
        (event) =>
          event.type === "rpc_turn_event" && event.event === "complete",
      );
      const visibleMessageEnds = events
        .filter((event) => event.type === "message_end")
        .map((event) => event.message?.content?.[0]?.text);
      assert.equal(completions.length, 1);
      assert.equal(completions[0]?.finalText, "original final");
      assert.deepEqual(visibleMessageEnds, ["original final"]);
      assert.deepEqual(promptSources, ["rpc"]);
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode does not reuse a stale pre-turn final after session compaction",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    let latestAssistantText = "";

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    try {
      const oldAssistant = {
        role: "assistant",
        timestamp: new Date(Date.now() - 60_000).toISOString(),
        content: [{ type: "text", text: "stale previous final" }],
      };
      const session = {
        isStreaming: false,
        isCompacting: false,
        sessionFile: "/tmp/test-session.jsonl",
        sessionId: "session-1",
        agent: { waitForIdle: async () => {} },
        bindExtensions: async () => {},
        subscribe: () => () => {},
        prompt: async () => {
          session.messages = [oldAssistant];
          latestAssistantText = "stale previous final";
        },
        sendCustomMessage: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: testSessionManager(() => session.messages || []),
        messages: [],
        getSessionStats: () => ({}),
        getUserMessagesForForking: () => [],
        getLastAssistantText: () => latestAssistantText,
        setThinkingLevel: () => {},
        cycleThinkingLevel: () => undefined,
        setSteeringMode: () => {},
        setFollowUpMode: () => {},
        compact: async () => {},
        setAutoCompactionEnabled: () => {},
        setAutoRetryEnabled: () => {},
        abortRetry: () => {},
        executeBash: async () => {},
        abortBash: async () => {},
        fork: async () => ({ cancelled: false, selectedText: "" }),
        navigateTree: async () => ({ cancelled: false }),
        exportToHtml: async () => "",
        exportToJsonl: () => "",
        importFromJsonl: async () => true,
        newSession: async () => true,
        switchSession: async () => true,
        setModel: async () => {},
        reload: async () => {},
        setSessionName: () => {},
      };

      void runCustomRpcMode(session, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
        builtinSlashCommands: [],
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "1", type: "prompt", message: "hello", requestTag: "tag-1" })}\n`,
        ),
      );
      await wait(20);

      const events = lines
        .join("")
        .trim()
        .split(/\n+/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      assert.equal(
        events.some(
          (event) =>
            event.type === "rpc_turn_event" && event.event === "complete",
        ),
        false,
      );
      const error = events.find(
        (event) => event.type === "rpc_turn_event" && event.event === "error",
      );
      assert.equal(error?.requestTag, "tag-1");
      assert.equal(error?.error, "rpc_turn_final_output_missing");
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode does not complete from message_end when the branch source has no final",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const sessionSubscribers = new Set();

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    try {
      const session = {
        isStreaming: false,
        isCompacting: false,
        sessionFile: "/tmp/test-session.jsonl",
        sessionId: "session-1",
        agent: { waitForIdle: async () => {} },
        bindExtensions: async () => {},
        subscribe: (handler) => {
          sessionSubscribers.add(handler);
          return () => sessionSubscribers.delete(handler);
        },
        prompt: async () => {
          const assistantMessage = {
            role: "assistant",
            content: [{ type: "text", text: "late final text" }],
          };
          for (const handler of sessionSubscribers) {
            handler({ type: "message_end", message: assistantMessage });
          }
        },
        sendCustomMessage: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: testSessionManager(() => session.messages || []),
        messages: [],
        getSessionStats: () => ({}),
        getUserMessagesForForking: () => [],
        getLastAssistantText: () => "",
        setThinkingLevel: () => {},
        cycleThinkingLevel: () => undefined,
        setSteeringMode: () => {},
        setFollowUpMode: () => {},
        compact: async () => {},
        setAutoCompactionEnabled: () => {},
        setAutoRetryEnabled: () => {},
        abortRetry: () => {},
        executeBash: async () => {},
        abortBash: async () => {},
        fork: async () => ({ cancelled: false, selectedText: "" }),
        navigateTree: async () => ({ cancelled: false }),
        exportToHtml: async () => "",
        exportToJsonl: () => "",
        importFromJsonl: async () => true,
        newSession: async () => true,
        switchSession: async () => true,
        setModel: async () => {},
        reload: async () => {},
        setSessionName: () => {},
      };

      void runCustomRpcMode(session, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
        builtinSlashCommands: [],
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "1", type: "prompt", message: "hello", requestTag: "tag-1" })}\n`,
        ),
      );
      await wait(20);

      const events = lines
        .join("")
        .trim()
        .split(/\n+/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const completion = events.find(
        (event) =>
          event.type === "rpc_turn_event" && event.event === "complete",
      );
      assert.equal(completion, undefined);
      const error = events.find(
        (event) => event.type === "rpc_turn_event" && event.event === "error",
      );
      assert.equal(error?.requestTag, "tag-1");
      assert.equal(error?.error, "rpc_turn_final_output_missing");
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode waits one turn-completion tick for a delayed branch write",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const sessionSubscribers = new Set();

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    try {
      const session = {
        isStreaming: false,
        isCompacting: false,
        sessionFile: "/tmp/test-session.jsonl",
        sessionId: "session-1",
        agent: { waitForIdle: async () => {} },
        bindExtensions: async () => {},
        subscribe: (handler) => {
          sessionSubscribers.add(handler);
          return () => sessionSubscribers.delete(handler);
        },
        prompt: async () => {
          const assistantMessage = {
            role: "assistant",
            content: [{ type: "text", text: "delayed final text" }],
          };
          setImmediate(() => {
            session.messages = [assistantMessage];
            for (const handler of sessionSubscribers) {
              handler({ type: "message_end", message: assistantMessage });
            }
          });
        },
        sendCustomMessage: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: testSessionManager(() => session.messages || []),
        messages: [],
        getSessionStats: () => ({}),
        getUserMessagesForForking: () => [],
        getLastAssistantText: () => "delayed final text",
        setThinkingLevel: () => {},
        cycleThinkingLevel: () => undefined,
        setSteeringMode: () => {},
        setFollowUpMode: () => {},
        compact: async () => {},
        setAutoCompactionEnabled: () => {},
        setAutoRetryEnabled: () => {},
        abortRetry: () => {},
        executeBash: async () => {},
        abortBash: async () => {},
        fork: async () => ({ cancelled: false, selectedText: "" }),
        navigateTree: async () => ({ cancelled: false }),
        exportToHtml: async () => "",
        exportToJsonl: () => "",
        importFromJsonl: async () => true,
        newSession: async () => true,
        switchSession: async () => true,
        setModel: async () => {},
        reload: async () => {},
        setSessionName: () => {},
      };

      void runCustomRpcMode(session, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
        builtinSlashCommands: [],
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "1", type: "prompt", message: "hello", requestTag: "tag-1" })}\n`,
        ),
      );
      await wait(20);

      const events = lines
        .join("")
        .trim()
        .split(/\n+/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const completion = events.find(
        (event) =>
          event.type === "rpc_turn_event" && event.event === "complete",
      );
      assert.equal(completion?.requestTag, "tag-1");
      assert.equal(completion?.finalText, "delayed final text");
      assert.deepEqual(completion?.result, {
        messages: [{ type: "text", text: "delayed final text" }],
      });
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode resolves persisted final text after prompt settles without message_end",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const stateMessages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "previous final must not leak" }],
      },
    ];

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    try {
      const session = {
        isStreaming: false,
        isCompacting: false,
        sessionFile: "/tmp/test-session.jsonl",
        sessionId: "session-1",
        agent: {
          state: { messages: stateMessages, errorMessage: "" },
          waitForIdle: async () => {},
        },
        bindExtensions: async () => {},
        subscribe: () => () => {},
        prompt: async () => {
          const assistantMessage = {
            role: "assistant",
            content: [{ type: "text", text: "final from stored session" }],
          };
          stateMessages.push(assistantMessage);
          session.messages = stateMessages;
        },
        sendCustomMessage: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: testSessionManager(() => session.messages || []),
        messages: stateMessages,
        getSessionStats: () => ({}),
        getUserMessagesForForking: () => [],
        getLastAssistantText: () => "",
        setThinkingLevel: () => {},
        cycleThinkingLevel: () => undefined,
        setSteeringMode: () => {},
        setFollowUpMode: () => {},
        compact: async () => {},
        setAutoCompactionEnabled: () => {},
        setAutoRetryEnabled: () => {},
        abortRetry: () => {},
        executeBash: async () => {},
        abortBash: async () => {},
        fork: async () => ({ cancelled: false, selectedText: "" }),
        navigateTree: async () => ({ cancelled: false }),
        exportToHtml: async () => "",
        exportToJsonl: () => "",
        importFromJsonl: async () => true,
        newSession: async () => true,
        switchSession: async () => true,
        setModel: async () => {},
        reload: async () => {},
        setSessionName: () => {},
      };

      void runCustomRpcMode(session, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
        builtinSlashCommands: [],
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "1", type: "prompt", message: "hello", requestTag: "tag-1" })}\n`,
        ),
      );
      await wait(100);

      const events = lines
        .join("")
        .trim()
        .split(/\n+/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const completion = events.find(
        (event) =>
          event.type === "rpc_turn_event" && event.event === "complete",
      );
      assert.equal(completion?.requestTag, "tag-1");
      assert.equal(completion?.finalText, "final from stored session");
      assert.deepEqual(completion?.result, {
        messages: [{ type: "text", text: "final from stored session" }],
      });
      assert.equal(
        events.some(
          (event) => event.type === "rpc_turn_event" && event.event === "error",
        ),
        false,
      );
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode routes steer through session.steer",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const calls = [];

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    try {
      const session = {
        isStreaming: false,
        isCompacting: false,
        sessionFile: "/tmp/test-session.jsonl",
        agent: { waitForIdle: async () => {} },
        bindExtensions: async () => {},
        subscribe: () => {},
        prompt: async () => {},
        steer: async (message, images) => {
          calls.push(["steer", message, images]);
        },
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: testSessionManager(() => session.messages || []),
        messages: [],
        getSessionStats: () => ({}),
        getUserMessagesForForking: () => [],
        getLastAssistantText: () => "",
        setThinkingLevel: () => {},
        cycleThinkingLevel: () => undefined,
        setSteeringMode: () => {},
        setFollowUpMode: () => {},
        compact: async () => {},
        setAutoCompactionEnabled: () => {},
        setAutoRetryEnabled: () => {},
        abortRetry: () => {},
        executeBash: async () => {},
        abortBash: async () => {},
        fork: async () => ({ cancelled: false, selectedText: "" }),
        navigateTree: async () => ({ cancelled: false }),
        exportToHtml: async () => "",
        exportToJsonl: () => "",
        importFromJsonl: async () => true,
        newSession: async () => true,
        switchSession: async () => true,
        setModel: async () => {},
        reload: async () => {},
        setSessionName: () => {},
      };

      void runCustomRpcMode(session, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
        builtinSlashCommands: [],
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "1", type: "steer", message: "hello", images: ["img"], requestTag: "tag-1" })}\n`,
        ),
      );
      await wait(10);

      assert.deepEqual(calls, [["steer", "hello", ["img"]]]);
      assert.ok(lines.join("").includes('"command":"steer"'));
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode prompt streamingBehavior keeps Pi prompt queue path during tracked non-streaming gaps",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const calls = [];
    const agentState = { isStreaming: false };

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    try {
      const session = {
        get isStreaming() {
          return this.agent.state.isStreaming;
        },
        isCompacting: false,
        sessionFile: "/tmp/test-session.jsonl",
        sessionId: "session-1",
        agent: { state: agentState, waitForIdle: async () => {} },
        bindExtensions: async () => {},
        subscribe: () => () => {},
        async prompt(message, options) {
          calls.push(["prompt", message, options, this.isStreaming]);
          if (!options?.streamingBehavior) {
            await new Promise(() => {});
          }
        },
        steer: async (message, images) => {
          calls.push(["steer", message, images]);
        },
        followUp: async (message, images) => {
          calls.push(["followUp", message, images]);
        },
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: testSessionManager(() => session.messages || []),
        messages: [],
        getSessionStats: () => ({}),
        getUserMessagesForForking: () => [],
        getLastAssistantText: () => "",
        setThinkingLevel: () => {},
        cycleThinkingLevel: () => undefined,
        setSteeringMode: () => {},
        setFollowUpMode: () => {},
        compact: async () => {},
        setAutoCompactionEnabled: () => {},
        setAutoRetryEnabled: () => {},
        abortRetry: () => {},
        executeBash: async () => {},
        abortBash: async () => {},
        fork: async () => ({ cancelled: false, selectedText: "" }),
        navigateTree: async () => ({ cancelled: false }),
        exportToHtml: async () => "",
        exportToJsonl: () => "",
        importFromJsonl: async () => true,
        newSession: async () => true,
        switchSession: async () => true,
        setModel: async () => {},
        reload: async () => {},
        setSessionName: () => {},
      };

      void runCustomRpcMode(session, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
        builtinSlashCommands: [],
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "turn-1", type: "prompt", message: "first" })}\n`,
        ),
      );
      await wait(10);
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "queue-1", type: "prompt", message: "steer me", streamingBehavior: "steer", requestTag: "tag-2" })}\n`,
        ),
      );
      await wait(20);

      assert.deepEqual(calls, [
        [
          "prompt",
          "first",
          {
            images: undefined,
            streamingBehavior: undefined,
            source: "rpc",
          },
          false,
        ],
        [
          "prompt",
          "steer me",
          {
            images: undefined,
            streamingBehavior: "steer",
            source: "rpc",
            requestTag: "tag-2",
          },
          true,
        ],
      ]);
      assert.equal(agentState.isStreaming, false);
      assert.ok(lines.join("").includes('"id":"queue-1"'));
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode prompt streamingBehavior uses native queue without starting a second tracked turn",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const calls = [];
    let waitForIdleCalls = 0;

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    try {
      const session = {
        isStreaming: true,
        isCompacting: false,
        sessionFile: "/tmp/test-session.jsonl",
        agent: {
          waitForIdle: async () => {
            waitForIdleCalls += 1;
          },
        },
        bindExtensions: async () => {},
        subscribe: () => {},
        prompt: async (message, options) => {
          calls.push([message, options]);
        },
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: testSessionManager(() => session.messages || []),
        messages: [],
        getSessionStats: () => ({}),
        getUserMessagesForForking: () => [],
        getLastAssistantText: () => "",
        setThinkingLevel: () => {},
        cycleThinkingLevel: () => undefined,
        setSteeringMode: () => {},
        setFollowUpMode: () => {},
        compact: async () => {},
        setAutoCompactionEnabled: () => {},
        setAutoRetryEnabled: () => {},
        abortRetry: () => {},
        executeBash: async () => {},
        abortBash: async () => {},
        fork: async () => ({ cancelled: false, selectedText: "" }),
        navigateTree: async () => ({ cancelled: false }),
        exportToHtml: async () => "",
        exportToJsonl: () => "",
        importFromJsonl: async () => true,
        newSession: async () => true,
        switchSession: async () => true,
        setModel: async () => {},
        reload: async () => {},
        setSessionName: () => {},
      };

      void runCustomRpcMode(session, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
        builtinSlashCommands: [],
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "1", type: "prompt", message: "steer me", streamingBehavior: "steer", requestTag: "tag-1" })}\n`,
        ),
      );
      await wait(50);

      assert.deepEqual(calls, [
        [
          "steer me",
          {
            images: undefined,
            streamingBehavior: "steer",
            source: "rpc",
            requestTag: "tag-1",
          },
        ],
      ]);
      assert.equal(waitForIdleCalls, 0);
      const events = lines
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      assert.equal(
        events.some((event) => event.type === "rpc_turn_event"),
        false,
      );
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode reuses an already-fresh worker session for the first new_session command",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    let newSessionCalls = 0;

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    try {
      const session = {
        isStreaming: false,
        isCompacting: false,
        sessionFile: "/tmp/fresh-session.jsonl",
        sessionId: "fresh-session-id",
        agent: { waitForIdle: async () => {} },
        bindExtensions: async () => {},
        subscribe: () => () => {},
        prompt: async () => {},
        sendCustomMessage: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: testSessionManager(() => session.messages || []),
        messages: [],
        getSessionStats: () => ({}),
        getUserMessagesForForking: () => [],
        getLastAssistantText: () => "",
        setThinkingLevel: () => {},
        cycleThinkingLevel: () => undefined,
        setSteeringMode: () => {},
        setFollowUpMode: () => {},
        compact: async () => {},
        setAutoCompactionEnabled: () => {},
        setAutoRetryEnabled: () => {},
        abortRetry: () => {},
        executeBash: async () => {},
        abortBash: async () => {},
        fork: async () => ({ cancelled: false, selectedText: "" }),
        navigateTree: async () => ({ cancelled: false }),
        exportToHtml: async () => "",
        exportToJsonl: () => "",
        importFromJsonl: async () => ({ cancelled: false }),
        setModel: async () => {},
        reload: async () => {},
        setSessionName: () => {},
      };
      const runtime = {
        session,
        async newSession() {
          newSessionCalls += 1;
          return { cancelled: false };
        },
        async switchSession() {
          throw new Error("unexpected");
        },
        async fork() {
          throw new Error("unexpected");
        },
        async importFromJsonl() {
          throw new Error("unexpected");
        },
      };

      void runCustomRpcMode(runtime, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
        builtinSlashCommands: [],
        reuseFreshSessionForInitialNewSession: true,
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "3", type: "new_session", frontendIdentity: { kind: "tui" } })}\n`,
        ),
      );
      await wait(20);

      assert.equal(newSessionCalls, 0);
      assert.ok(lines.join("").includes('"id":"3"'));
      assert.ok(
        lines.join("").includes('"sessionFile":"/tmp/fresh-session.jsonl"'),
      );
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode honors managed session leaf for new_session directories",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const switchCalls = [];
    const createRuntimeCalls = [];
    let newSessionCalls = 0;
    let currentSession;

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    const createSession = (sessionFile, sessionId) => ({
      isStreaming: false,
      isCompacting: false,
      sessionFile,
      sessionId,
      agent: { waitForIdle: async () => {} },
      bindExtensions: async () => {},
      subscribe: () => () => {},
      prompt: async () => {},
      sendCustomMessage: async () => {},
      steer: async () => {},
      followUp: async () => {},
      abort: async () => {},
      modelRegistry: { getAvailable: async () => [] },
      sessionManager: {
        getEntries: () => [],
        getTree: () => [],
        getLeafId: () => null,
        getCwd: () => process.cwd(),
        getSessionDir: () => path.dirname(sessionFile),
      },
      messages: [],
      getSessionStats: () => ({}),
      getUserMessagesForForking: () => [],
      getLastAssistantText: () => "",
      setThinkingLevel: () => {},
      cycleThinkingLevel: () => undefined,
      setSteeringMode: () => {},
      setFollowUpMode: () => {},
      compact: async () => {},
      setAutoCompactionEnabled: () => {},
      setAutoRetryEnabled: () => {},
      abortRetry: () => {},
      executeBash: async () => {},
      abortBash: async () => {},
      fork: async () => ({ cancelled: false, selectedText: "" }),
      navigateTree: async () => ({ cancelled: false }),
      exportToHtml: async () => "",
      exportToJsonl: () => "",
      importFromJsonl: async () => ({ cancelled: false }),
      setModel: async () => {},
      reload: async () => {},
      setSessionName: () => {},
    });

    try {
      currentSession = createSession("/tmp/rin/sessions/root.jsonl", "root-id");
      const runtime = {
        get session() {
          return currentSession;
        },
        services: { agentDir: "/tmp/rin" },
        async newSession() {
          newSessionCalls += 1;
          throw new Error(
            "managed new_session should not call default newSession",
          );
        },
        async switchSession(sessionFile) {
          switchCalls.push(sessionFile);
          currentSession = createSession(sessionFile, "target-id");
          return { cancelled: false };
        },
        async fork() {
          throw new Error("unexpected");
        },
        async importFromJsonl() {
          throw new Error("unexpected");
        },
        async emitBeforeSwitch(reason) {
          assert.equal(reason, "new");
          return { cancelled: false };
        },
        async teardownCurrent(reason, targetSessionFile) {
          assert.equal(reason, "new");
          assert.match(targetSessionFile, /\/sessions\/managed\/chat\//);
        },
        async createRuntime(args) {
          createRuntimeCalls.push(args);
          currentSession = createSession(
            args.sessionManager.getSessionFile(),
            "created-id",
          );
          return { session: currentSession, services: {} };
        },
        apply(result) {
          currentSession = result.session;
        },
        async finishSessionReplacement() {},
      };

      void runCustomRpcMode(runtime, {
        SessionManager: {
          create: (cwd, sessionDir) => ({
            getCwd: () => cwd,
            getSessionDir: () => sessionDir,
            getSessionFile: () => path.join(sessionDir, "created.jsonl"),
            newSession() {},
          }),
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
        builtinSlashCommands: [],
        reuseFreshSessionForInitialNewSession: true,
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({
            id: "managed-new",
            type: "new_session",
            managedSessionLeaf: "chat",
            frontendIdentity: { kind: "tui" },
          })}\n`,
        ),
      );
      await wait(20);

      assert.deepEqual(switchCalls, []);
      assert.equal(createRuntimeCalls.length, 1);
      assert.match(
        createRuntimeCalls[0].sessionManager.getSessionDir(),
        /\/sessions\/managed\/chat$/,
      );
      assert.equal(newSessionCalls, 0);
      assert.ok(lines.join("").includes('"id":"managed-new"'));
      assert.ok(
        lines.join("").includes('"sessionFile":"') &&
          lines.join("").includes("/sessions/managed/chat/created.jsonl"),
      );
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode new_session response includes the rebound session selector",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    let currentSession;
    let abortCalls = 0;

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    try {
      const createSession = (name) => ({
        name,
        isStreaming: name === "first",
        isCompacting: false,
        sessionFile: `/tmp/${name}.jsonl`,
        sessionId: `${name}-id`,
        agent: { waitForIdle: async () => {} },
        bindExtensions: async () => {},
        subscribe: () => () => {},
        prompt: async () => {},
        sendCustomMessage: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {
          abortCalls += 1;
        },
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: {
          getEntries: () => [{ id: `${name}-header` }],
          getTree: () => [],
          getLeafId: () => null,
          getCwd: () => process.cwd(),
          getSessionDir: () => process.cwd(),
        },
        messages: [],
        getSessionStats: () => ({}),
        getUserMessagesForForking: () => [],
        getLastAssistantText: () => "",
        setThinkingLevel: () => {},
        cycleThinkingLevel: () => undefined,
        setSteeringMode: () => {},
        setFollowUpMode: () => {},
        compact: async () => {},
        setAutoCompactionEnabled: () => {},
        setAutoRetryEnabled: () => {},
        abortRetry: () => {},
        executeBash: async () => {},
        abortBash: async () => {},
        fork: async () => ({ cancelled: false, selectedText: "" }),
        navigateTree: async () => ({ cancelled: false }),
        exportToHtml: async () => "",
        exportToJsonl: () => "",
        importFromJsonl: async () => ({ cancelled: false }),
        setModel: async () => {},
        reload: async () => {},
        setSessionName: () => {},
      });

      currentSession = createSession("first");
      const runtime = {
        get session() {
          return currentSession;
        },
        async newSession() {
          currentSession = createSession("second");
          return { cancelled: false };
        },
        async switchSession() {
          throw new Error("unexpected");
        },
        async fork() {
          throw new Error("unexpected");
        },
        async importFromJsonl() {
          throw new Error("unexpected");
        },
      };

      void runCustomRpcMode(runtime, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
        builtinSlashCommands: [],
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "resp-1", type: "new_session", frontendIdentity: { kind: "tui" } })}\n`,
        ),
      );
      await wait(20);

      const responseLine = lines.find((line) => line.includes('"id":"resp-1"'));
      assert.ok(responseLine);
      const payload = JSON.parse(responseLine);
      assert.equal(payload.success, true);
      assert.equal(payload.data.cancelled, false);
      assert.equal(payload.data.sessionFile, "/tmp/second.jsonl");
      assert.equal(payload.data.sessionId, "second-id");
      assert.equal(abortCalls, 1);
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode rebinds to runtime.session after session replacement",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const prompts = [];
    const bindCalls = [];
    let currentSession;
    let unsubscribeCount = 0;

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    try {
      const createSession = (name) => ({
        name,
        isStreaming: false,
        isCompacting: false,
        sessionFile: `/tmp/${name}.jsonl`,
        sessionId: `${name}-id`,
        agent: { waitForIdle: async () => {} },
        bindExtensions: async () => {
          bindCalls.push(name);
        },
        subscribe: () => () => {
          unsubscribeCount += 1;
        },
        prompt: async (message, options) => {
          prompts.push([name, message, options]);
        },
        sendCustomMessage: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: testSessionManager(() => []),
        messages: [],
        getSessionStats: () => ({}),
        getUserMessagesForForking: () => [],
        getLastAssistantText: () => "",
        setThinkingLevel: () => {},
        cycleThinkingLevel: () => undefined,
        setSteeringMode: () => {},
        setFollowUpMode: () => {},
        compact: async () => {},
        setAutoCompactionEnabled: () => {},
        setAutoRetryEnabled: () => {},
        abortRetry: () => {},
        executeBash: async () => {},
        abortBash: async () => {},
        fork: async () => ({ cancelled: false, selectedText: "" }),
        navigateTree: async () => ({ cancelled: false }),
        exportToHtml: async () => "",
        exportToJsonl: () => "",
        importFromJsonl: async () => ({ cancelled: false }),
        setModel: async () => {},
        reload: async () => {},
        setSessionName: () => {},
      });

      currentSession = createSession("first");
      const runtime = {
        get session() {
          return currentSession;
        },
        async newSession() {
          currentSession = createSession("second");
          return { cancelled: false };
        },
        async switchSession() {
          throw new Error("unexpected");
        },
        async fork() {
          throw new Error("unexpected");
        },
        async importFromJsonl() {
          throw new Error("unexpected");
        },
      };

      void runCustomRpcMode(runtime, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
        builtinSlashCommands: [],
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "3", type: "new_session", frontendIdentity: { kind: "tui" } })}\n`,
        ),
      );
      await wait(20);
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "4", type: "prompt", message: "after swap", requestTag: "tag-4" })}\n`,
        ),
      );
      await wait(20);

      assert.deepEqual(bindCalls, ["first", "second"]);
      assert.equal(unsubscribeCount, 1);
      assert.deepEqual(prompts, [
        [
          "second",
          "after swap",
          {
            images: undefined,
            streamingBehavior: undefined,
            source: "rpc",
            requestTag: "tag-4",
          },
        ],
      ]);
      assert.ok(lines.join("").includes('"id":"3"'));
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode explicit interrupted-turn resume still persists interruption context before continuing",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const calls = [];

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    try {
      const stateMessages = [];
      const session = {
        isStreaming: false,
        isCompacting: false,
        sessionFile: "/tmp/test-session.jsonl",
        agent: {
          waitForIdle: async () => {},
          state: { messages: stateMessages },
          continue: async () => {
            calls.push(["continue"]);
          },
        },
        bindExtensions: async () => {},
        subscribe: () => {},
        prompt: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: {
          appendMessage: (message) => {
            calls.push(["appendMessage", message]);
          },
          getEntries: () => [],
          getTree: () => [],
          getLeafId: () => null,
          getCwd: () => process.cwd(),
          getSessionDir: () => process.cwd(),
        },
        messages: [],
        getSessionStats: () => ({}),
        getUserMessagesForForking: () => [],
        getLastAssistantText: () => "",
        setThinkingLevel: () => {},
        cycleThinkingLevel: () => undefined,
        setSteeringMode: () => {},
        setFollowUpMode: () => {},
        compact: async () => {},
        setAutoCompactionEnabled: () => {},
        setAutoRetryEnabled: () => {},
        abortRetry: () => {},
        executeBash: async () => {},
        abortBash: async () => {},
        fork: async () => ({ cancelled: false, selectedText: "" }),
        navigateTree: async () => ({ cancelled: false }),
        exportToHtml: async () => "",
        exportToJsonl: () => "",
        importFromJsonl: async () => true,
        newSession: async () => true,
        switchSession: async () => true,
        setModel: async () => {},
        reload: async () => {},
        setSessionName: () => {},
      };

      void runCustomRpcMode(session, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
        builtinSlashCommands: [],
      });
      await wait(0);

      stateMessages.push({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tool-1",
            name: "bash",
            arguments: { command: "sleep 1" },
          },
        ],
      });

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "2", type: "resume_interrupted_turn", requestTag: "tag-2", source: "rpc-reconnect" })}\n`,
        ),
      );
      await wait(10);

      assert.equal(calls.length, 3);
      assert.equal(calls[0][0], "appendMessage");
      assert.equal(calls[0][1].role, "assistant");
      assert.equal(calls[0][1].content[0].id, "tool-1");
      assert.equal(calls[1][0], "appendMessage");
      assert.equal(calls[1][1].role, "toolResult");
      assert.equal(calls[1][1].toolCallId, "tool-1");
      assert.equal(calls[1][1].toolName, "bash");
      assert.equal(calls[1][1].isError, true);
      assert.equal(
        calls[1][1].content[0].text,
        "The tool was interrupted because the daemon exited.",
      );
      assert.deepEqual(calls[1][1].details, {
        interrupted: true,
        reason: "daemon_exit",
      });
      assert.deepEqual(calls[2], ["continue"]);
      assert.equal(stateMessages.length, 2);
      assert.equal(stateMessages[1].role, "toolResult");
      assert.ok(lines.join("").includes('"command":"resume_interrupted_turn"'));
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode repairs orphan tool results before binding a resumed session",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines: string[] = [];
    let rewrites = 0;

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    try {
      const entries: any[] = [
        { type: "session", version: 3 },
        {
          type: "message",
          id: "user-1",
          parentId: null,
          message: { role: "user", content: [{ type: "text", text: "go" }] },
        },
        {
          type: "message",
          id: "orphan-result",
          parentId: "missing-assistant",
          message: {
            role: "toolResult",
            toolCallId: "call-missing",
            toolName: "bash",
            content: [{ type: "text", text: "interrupted" }],
            isError: true,
          },
        },
        {
          type: "message",
          id: "valid-user",
          parentId: "orphan-result",
          message: { role: "user", content: [{ type: "text", text: "ok" }] },
        },
      ];
      const byId = new Map(
        entries.filter((entry) => entry.id).map((entry) => [entry.id, entry]),
      );
      let manager: any;
      const session = {
        isStreaming: false,
        isCompacting: false,
        sessionFile: "/tmp/test-session.jsonl",
        agent: {
          waitForIdle: async () => {},
          state: {
            messages: entries
              .filter((entry) => entry.message)
              .map((entry) => entry.message),
          },
          continue: async () => {},
        },
        bindExtensions: async () => {},
        subscribe: () => {},
        prompt: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        dispose: () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: (manager = {
          byId,
          leafId: "valid-user",
          getEntries: () => entries,
          _rewriteFile: () => {
            rewrites += 1;
          },
          buildSessionContext: () => ({
            messages: entries
              .filter((entry) => entry.type === "message")
              .map((entry) => entry.message),
          }),
          getTree: () => [],
          getLeafId: () => manager.leafId,
          getCwd: () => process.cwd(),
          getSessionDir: () => process.cwd(),
        }),
        messages: [],
        getSessionStats: () => ({}),
        getUserMessagesForForking: () => [],
        getLastAssistantText: () => "",
        setThinkingLevel: () => {},
        cycleThinkingLevel: () => undefined,
        setSteeringMode: () => {},
        setFollowUpMode: () => {},
        compact: async () => {},
        setAutoCompactionEnabled: () => {},
        setAutoRetryEnabled: () => {},
        abortRetry: () => {},
        executeBash: async () => {},
        abortBash: async () => {},
        fork: async () => ({ cancelled: false, selectedText: "" }),
        navigateTree: async () => ({ cancelled: false }),
        exportToHtml: async () => "",
        exportToJsonl: () => "",
        importFromJsonl: async () => true,
        newSession: async () => true,
        switchSession: async () => true,
        setModel: async () => {},
        reload: async () => {},
        setSessionName: () => {},
      };

      void runCustomRpcMode(session, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
        builtinSlashCommands: [],
      }).catch((error) => lines.push(`rpcError:${String(error)}`));
      await wait(0);

      assert.equal(rewrites, 1);
      assert.deepEqual(entries.map((entry) => entry.id).filter(Boolean), [
        "user-1",
        "valid-user",
      ]);
      assert.equal(byId.has("orphan-result"), false);
      assert.equal(entries[1].parentId, null);
      assert.equal(entries[2].parentId, "user-1");
      assert.equal(session.sessionManager.leafId, "valid-user");
      assert.deepEqual(
        session.agent.state.messages.map((message) => message.role),
        ["user", "user"],
      );
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode resume_interrupted_turn emits liveness events without requestTag",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines: string[] = [];

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    try {
      const session = {
        sessionId: "session-1",
        sessionFile: "/tmp/session-1.jsonl",
        isStreaming: false,
        isCompacting: false,
        messages: [],
        agent: { state: { messages: [] } },
        subscribe: () => () => {},
        appendMessage: () => {},
        continue: async () => {},
        getSessionStats: () => ({}),
        getUserMessagesForForking: () => [],
        getLastAssistantText: () => "",
        setThinkingLevel: () => {},
        cycleThinkingLevel: () => undefined,
        setSteeringMode: () => {},
        setFollowUpMode: () => {},
        compact: async () => {},
        setAutoCompactionEnabled: () => {},
        setAutoRetryEnabled: () => {},
        abortRetry: () => {},
        executeBash: async () => {},
        abortBash: async () => {},
        fork: async () => ({ cancelled: false, selectedText: "" }),
        navigateTree: async () => ({ cancelled: false }),
        exportToHtml: async () => "",
        exportToJsonl: () => "",
        importFromJsonl: async () => true,
        newSession: async () => true,
        switchSession: async () => true,
        setModel: async () => {},
        reload: async () => {},
        setSessionName: () => {},
        bindExtensions: async () => {},
      };

      void runCustomRpcMode(session, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
        builtinSlashCommands: [],
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "2", type: "resume_interrupted_turn", source: "daemon-restart" })}\n`,
        ),
      );
      await wait(10);

      const events = lines
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const start = events.find(
        (event) => event.type === "rpc_turn_event" && event.event === "start",
      );
      const finished = events.find(
        (event) =>
          event.type === "rpc_turn_event" &&
          (event.event === "complete" || event.event === "error"),
      );
      assert.ok(start);
      assert.equal(start.requestTag, undefined);
      assert.ok(finished);
      assert.equal(finished.requestTag, undefined);
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode session bind does not auto-resume an interrupted turn",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const calls = [];
    const lines = [];

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    try {
      const stateMessages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-1",
              name: "bash",
              arguments: { command: "sleep 1" },
            },
          ],
        },
      ];
      const session = {
        isStreaming: false,
        isCompacting: false,
        sessionFile: "/tmp/test-session.jsonl",
        agent: {
          waitForIdle: async () => {},
          state: { messages: stateMessages },
          continue: async () => {
            calls.push(["continue"]);
          },
        },
        bindExtensions: async () => {},
        subscribe: () => {},
        prompt: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: {
          appendMessage: (message) => {
            calls.push(["appendMessage", message]);
          },
          getEntries: () => [],
          getTree: () => [],
          getLeafId: () => null,
          getCwd: () => process.cwd(),
          getSessionDir: () => process.cwd(),
        },
        messages: [],
        getSessionStats: () => ({}),
        getUserMessagesForForking: () => [],
        getLastAssistantText: () => "",
        setThinkingLevel: () => {},
        cycleThinkingLevel: () => undefined,
        setSteeringMode: () => {},
        setFollowUpMode: () => {},
        compact: async () => {},
        setAutoCompactionEnabled: () => {},
        setAutoRetryEnabled: () => {},
        abortRetry: () => {},
        executeBash: async () => {},
        abortBash: async () => {},
        fork: async () => ({ cancelled: false, selectedText: "" }),
        navigateTree: async () => ({ cancelled: false }),
        exportToHtml: async () => "",
        exportToJsonl: () => "",
        importFromJsonl: async () => true,
        newSession: async () => true,
        switchSession: async () => true,
        setModel: async () => {},
        reload: async () => {},
        setSessionName: () => {},
      };

      void runCustomRpcMode(session, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
        builtinSlashCommands: [],
      });
      await wait(0);

      await wait(10);

      assert.deepEqual(calls, []);
      assert.equal(stateMessages.length, 1);
      assert.equal(stateMessages[0].role, "assistant");
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode switch_session binds without auto-resuming interrupted work",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const calls = [];

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    const makeSession = (name, messages = []) => ({
      isStreaming: false,
      isCompacting: false,
      sessionFile: `/tmp/${name}.jsonl`,
      sessionId: name,
      agent: {
        waitForIdle: async () => {},
        state: { messages },
        continue: async () => {
          calls.push(["continue", name]);
        },
      },
      bindExtensions: async () => {},
      subscribe: () => () => {},
      prompt: async () => {},
      steer: async () => {},
      followUp: async () => {},
      abort: async () => {},
      modelRegistry: { getAvailable: async () => [] },
      sessionManager: {
        appendMessage: (message) => {
          messages.push(message);
        },
        getEntries: () => [],
        getTree: () => [],
        getLeafId: () => null,
        getCwd: () => process.cwd(),
        getSessionDir: () => process.cwd(),
      },
      messages,
      getSessionStats: () => ({}),
      getUserMessagesForForking: () => [],
      getLastAssistantText: () => "",
      setThinkingLevel: () => {},
      cycleThinkingLevel: () => undefined,
      setSteeringMode: () => {},
      setFollowUpMode: () => {},
      compact: async () => {},
      setAutoCompactionEnabled: () => {},
      setAutoRetryEnabled: () => {},
      abortRetry: () => {},
      executeBash: async () => {},
      abortBash: async () => {},
      fork: async () => ({ cancelled: false, selectedText: "" }),
      navigateTree: async () => ({ cancelled: false }),
      exportToHtml: async () => "",
      exportToJsonl: () => "",
      importFromJsonl: async () => true,
      newSession: async () => true,
      switchSession: async () => true,
      setModel: async () => {},
      reload: async () => {},
      setSessionName: () => {},
    });

    try {
      const initialSession = makeSession("initial", [
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ]);
      const interruptedSession = makeSession("interrupted", [
        { role: "toolResult", toolCallId: "tool-1", content: [] },
      ]);
      const runtime = {
        session: initialSession,
        switchSession: async () => {
          runtime.session = interruptedSession;
          return { cancelled: false };
        },
        newSession: async () => ({ cancelled: false }),
        fork: async () => ({ cancelled: false, selectedText: "" }),
        importFromJsonl: async () => ({ cancelled: false }),
      };

      void runCustomRpcMode(runtime, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
        builtinSlashCommands: [],
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "switch-1", type: "switch_session", sessionPath: interruptedSession.sessionFile, frontendIdentity: { kind: "tui" } })}\n`,
        ),
      );
      await wait(100);

      const output = lines.join("");
      assert.ok(output.includes('"id":"switch-1"'));
      assert.ok(output.includes('"success":true'));
      assert.deepEqual(calls, []);
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode get_state keeps turnActive true across internal non-streaming gaps",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    let releasePrompt;

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    try {
      const promptGate = new Promise((resolve) => {
        releasePrompt = resolve;
      });
      const session = {
        isStreaming: false,
        isCompacting: false,
        sessionFile: "/tmp/test-session.jsonl",
        sessionId: "session-1",
        agent: { waitForIdle: async () => {} },
        bindExtensions: async () => {},
        subscribe: () => () => {},
        prompt: async () => {
          await promptGate;
        },
        sendCustomMessage: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: testSessionManager(() => session.messages || []),
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          },
        ],
        getSessionStats: () => ({}),
        getUserMessagesForForking: () => [],
        getLastAssistantText: () => "done",
        setThinkingLevel: () => {},
        cycleThinkingLevel: () => undefined,
        setSteeringMode: () => {},
        setFollowUpMode: () => {},
        compact: async () => {},
        setAutoCompactionEnabled: () => {},
        setAutoRetryEnabled: () => {},
        abortRetry: () => {},
        executeBash: async () => {},
        abortBash: async () => {},
        fork: async () => ({ cancelled: false, selectedText: "" }),
        navigateTree: async () => ({ cancelled: false }),
        exportToHtml: async () => "",
        exportToJsonl: () => "",
        importFromJsonl: async () => true,
        newSession: async () => true,
        switchSession: async () => true,
        setModel: async () => {},
        reload: async () => {},
        setSessionName: () => {},
      };

      void runCustomRpcMode(session, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
        builtinSlashCommands: [],
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "1", type: "prompt", message: "hello", requestTag: "tag-1" })}\n`,
        ),
      );
      await wait(10);
      onData(
        Buffer.from(`${JSON.stringify({ id: "2", type: "get_state" })}\n`),
      );
      await wait(10);
      releasePrompt();
      await wait(20);

      const responses = lines
        .join("")
        .trim()
        .split(/\n+/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((payload) => payload?.type === "response");
      const stateResponse = responses.find((payload) => payload.id === "2");
      assert.equal(stateResponse?.data?.turnActive, true);
      assert.equal(stateResponse?.data?.isStreaming, false);
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);
