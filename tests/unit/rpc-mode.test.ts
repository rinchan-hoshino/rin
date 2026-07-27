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

function parseRpcOutput(lines: unknown[]) {
  return lines
    .flatMap((chunk) => String(chunk).split(/\n+/))
    .map((line) => {
      const starts = [line.indexOf('{"id"'), line.indexOf('{"type"')].filter(
        (index) => index >= 0,
      );
      if (!starts.length) return null;
      try {
        return JSON.parse(line.slice(Math.min(...starts)));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function testSessionManager(getMessages = () => []) {
  const getBranch = () =>
    getMessages().map((message, index) => ({
      id: `test-message-${index}`,
      parentId: index > 0 ? `test-message-${index - 1}` : null,
      type: "message",
      message,
    }));
  return {
    buildSessionContext: () => ({ messages: getMessages() }),
    getEntries: () => [],
    getBranch,
    getTree: () => [],
    getLeafId: () => getBranch().at(-1)?.id ?? null,
    getCwd: () => process.cwd(),
    getSessionDir: () => process.cwd(),
  };
}

test("rpc mode exposes Pi-compatible session entries and tree", async () => {
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
    const entries = [
      { type: "message", id: "entry-1", parentId: null },
      { type: "message", id: "entry-2", parentId: "entry-1" },
    ];
    const tree = [
      { entry: entries[0], children: [{ entry: entries[1], children: [] }] },
    ];
    const session = {
      isStreaming: false,
      isCompacting: false,
      agent: { waitForIdle: async () => {} },
      bindExtensions: async () => {},
      subscribe: () => () => {},
      sessionManager: {
        ...testSessionManager(),
        getEntries: () => entries,
        getTree: () => tree,
        getLeafId: () => "entry-2",
      },
    };

    void runCustomRpcMode(session, {
      SessionManager: { listAll: async () => [], list: async () => [] },
    });
    await wait(0);
    const onData = handlers.get("data");
    assert.equal(typeof onData, "function");
    onData(
      Buffer.from(
        `${JSON.stringify({ id: "1", type: "get_entries", since: "entry-1" })}\n`,
      ),
    );
    onData(Buffer.from(`${JSON.stringify({ id: "2", type: "get_tree" })}\n`));
    onData(
      Buffer.from(
        `${JSON.stringify({ id: "3", type: "get_entries", since: "missing" })}\n`,
      ),
    );
    await wait(0);

    const responses = lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((line) => line?.type === "response");
    assert.deepEqual(responses.find((line) => line.id === "1")?.data, {
      entries: [entries[1]],
      leafId: "entry-2",
    });
    assert.deepEqual(responses.find((line) => line.id === "2")?.data, {
      tree,
      leafId: "entry-2",
    });
    assert.equal(responses.find((line) => line.id === "3")?.success, false);
  } finally {
    process.stdin.on = stdinOn;
    process.stdout.write = stdoutWrite;
  }
});

test(
  "rpc mode publishes Pi working visibility before agent lifecycle events",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines: string[] = [];
    let emitSessionEvent: ((event: any) => void) | undefined;
    let boundUiContext: any;

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
        agent: { waitForIdle: async () => {} },
        bindExtensions: async ({ uiContext }) => {
          boundUiContext = uiContext;
        },
        subscribe: (handler) => {
          emitSessionEvent = handler;
          return () => {};
        },
        sessionManager: testSessionManager(),
      };

      void runCustomRpcMode(session, {
        SessionManager: { listAll: async () => [], list: async () => [] },
      });
      await wait(0);
      assert.equal(typeof emitSessionEvent, "function");

      session.isStreaming = true;
      emitSessionEvent?.({ type: "agent_start" });
      session.isStreaming = false;
      emitSessionEvent?.({ type: "agent_end" });
      boundUiContext.setWorkingVisible(false);
      session.isStreaming = true;
      emitSessionEvent?.({ type: "agent_start" });

      const events = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .filter(
          (event) =>
            event.type === "agent_start" ||
            event.type === "agent_end" ||
            (event.type === "extension_ui_request" &&
              event.method === "setWorkingVisible"),
        )
        .map((event) =>
          event.type === "extension_ui_request"
            ? { type: event.type, method: event.method, visible: event.visible }
            : { type: event.type },
        );

      assert.deepEqual(events, [
        {
          type: "extension_ui_request",
          method: "setWorkingVisible",
          visible: true,
        },
        { type: "agent_start" },
        {
          type: "extension_ui_request",
          method: "setWorkingVisible",
          visible: false,
        },
        { type: "agent_end" },
        {
          type: "extension_ui_request",
          method: "setWorkingVisible",
          visible: false,
        },
        {
          type: "extension_ui_request",
          method: "setWorkingVisible",
          visible: false,
        },
        { type: "agent_start" },
      ]);
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode leaves Pi assistant progress untagged",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines: string[] = [];
    const subscribers = new Set<(event: any) => void>();
    const messages: any[] = [];

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    try {
      const emit = (event: any) => {
        for (const subscriber of subscribers) subscriber(event);
      };
      const session = {
        isStreaming: false,
        isCompacting: false,
        sessionFile: "/tmp/test-session.jsonl",
        sessionId: "session-1",
        agent: { waitForIdle: async () => {}, state: { messages } },
        bindExtensions: async () => {},
        subscribe: (handler) => {
          subscribers.add(handler);
          return () => subscribers.delete(handler);
        },
        prompt: async (message: string) => {
          session.isStreaming = true;
          emit({ type: "agent_start" });
          emit({
            type: "message_start",
            message: {
              role: "user",
              content: [{ type: "text", text: message }],
            },
          });
          emit({
            type: "message_update",
            message: { role: "assistant", content: [] },
            assistantMessageEvent: {
              type: "thinking_end",
              content: "Checking ownership",
            },
          });
          const assistantMessage = {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          };
          messages.push(assistantMessage);
          emit({ type: "message_end", message: assistantMessage });
          session.isStreaming = false;
          emit({ type: "agent_end" });
        },
        sessionManager: testSessionManager(() => messages),
      };

      void runCustomRpcMode(session, {
        SessionManager: { listAll: async () => [], list: async () => [] },
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "prompt", type: "prompt", message: "hello", requestTag: "turn-tag" })}\n`,
        ),
      );
      await wait(20);
      emit({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: {
          type: "thinking_end",
          content: "Late stale progress",
        },
      });

      const events = parseRpcOutput(lines);
      const progress = events.filter(
        (event) => event.type === "message_update",
      );
      assert.equal(progress[0]?.requestTag, undefined);
      assert.equal(progress[1]?.requestTag, undefined);
      assert.equal(
        events.find((event) => event.type === "agent_start")?.requestTag,
        undefined,
      );
      assert.equal(
        events.find((event) => event.type === "agent_end")?.requestTag,
        undefined,
      );
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode shutdown_session terminalizes an active turn without a final",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const processExit = process.exit;
    const handlers = new Map();
    const calls: string[] = [];
    const lines: string[] = [];
    let rejectPrompt: ((error: Error) => void) | undefined;
    let promptStarted = false;

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
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
        agent: { waitForIdle: async () => {}, state: { messages: [] } },
        bindExtensions: async () => {},
        subscribe: () => () => {},
        prompt: async () => {
          promptStarted = true;
          return await new Promise((_resolve, reject) => {
            rejectPrompt = reject;
          });
        },
        abort: async () => {
          calls.push("session.abort");
          rejectPrompt?.(new Error("Request was aborted"));
        },
        dispose: () => {
          calls.push("session.dispose");
        },
        sessionManager: {
          ...testSessionManager(() => []),
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
        Buffer.from(
          `${JSON.stringify({ id: "prompt", type: "prompt", message: "active turn", requestTag: "active-tag" })}\n`,
        ),
      );
      while (!promptStarted) await wait(1);
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "1", type: "shutdown_session" })}\n`,
        ),
      );
      await wait(20);

      const terminalEvents = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(
          (line) =>
            line?.type === "rpc_turn_event" &&
            (line.event === "complete" || line.event === "error"),
        );
      assert.equal(terminalEvents.length, 1);
      assert.equal(terminalEvents[0]?.event, "error");
      assert.equal(terminalEvents[0]?.error, "Request was aborted");
      assert.deepEqual(calls, [
        "session.abort",
        "runtime.dispose",
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
  "rpc mode sleep_session delivers a final committed during graceful abort",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const processExit = process.exit;
    const handlers = new Map();
    const lines: string[] = [];
    const subscribers = new Set<(event: any) => void>();
    let rejectPrompt: ((error: Error) => void) | undefined;
    let promptStarted = false;

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };
    process.exit = (() => undefined as never) as unknown as typeof process.exit;

    try {
      const session = {
        isStreaming: false,
        isCompacting: false,
        sessionFile: "/tmp/test-session.jsonl",
        sessionId: "session-1",
        agent: { waitForIdle: async () => {}, state: { messages: [] } },
        bindExtensions: async () => {},
        subscribe: (handler) => {
          subscribers.add(handler);
          return () => subscribers.delete(handler);
        },
        prompt: async () => {
          promptStarted = true;
          await new Promise<void>((_resolve, reject) => {
            rejectPrompt = reject;
          });
        },
        abort: async () => {
          const message = {
            role: "assistant",
            content: [{ type: "text", text: "committed final" }],
          };
          session.messages.push(message);
          for (const subscriber of subscribers) {
            subscriber({ type: "message_end", message });
          }
          rejectPrompt?.(new Error("Request was aborted"));
        },
        dispose: () => {},
        messages: [],
        sessionManager: {
          ...testSessionManager(() => session.messages),
          _rewriteFile: () => {},
        },
      };
      const runtime = { session, dispose: async () => {} };

      void runCustomRpcMode(runtime, {
        SessionManager: {
          listAll: async () => [],
          list: async () => [],
          open: () => ({ appendSessionInfo() {} }),
        },
      });
      await wait(0);

      const onData = handlers.get("data");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "prompt", type: "prompt", message: "active turn", requestTag: "active-tag" })}\n`,
        ),
      );
      while (!promptStarted) await wait(1);
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "sleep", type: "sleep_session" })}\n`,
        ),
      );
      await wait(20);

      const terminalEvents = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(
          (line) =>
            line?.type === "rpc_turn_event" &&
            (line.event === "complete" || line.event === "error"),
        );
      assert.equal(terminalEvents.length, 1);
      assert.equal(terminalEvents[0]?.event, "complete");
      assert.equal(terminalEvents[0]?.finalText, "committed final");
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
      process.exit = processExit;
    }
  },
);

test(
  "rpc mode shutdown_session disposes runtime with stable frontend identity",
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

      assert.deepEqual(calls, ["runtime.dispose:tui", "process.exit"]);
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
    let boundMode;

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
          boundMode = bindings.mode;
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
      assert.equal(boundMode, "rpc");

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
  "rpc mode command context does not expose worker-local session replacement",
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
        cancelled: true,
      });
      assert.deepEqual(await actions.fork("entry-1", forkOptions), {
        cancelled: false,
      });
      assert.deepEqual(
        await actions.switchSession("/tmp/next.jsonl", switchOptions),
        { cancelled: true },
      );

      assert.deepEqual(calls, [["fork", "entry-1", forkOptions]]);
      assert.equal(bindCount, 2);
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
          getBranch: () => [],
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
        ["executeBash", "echo hidden", { excludeFromContext: true, id: "8" }],
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
        modelRuntime: {
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
  "rpc mode confirms persistent thinking changes only after the settings write finishes",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const calls: string[] = [];
    let finishFlush: (() => void) | undefined;
    let settingsErrors: any[] = [];

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
        get thinkingLevel() {
          return this.agent.state.thinkingLevel;
        },
        agent: {
          state: { thinkingLevel: "high" },
          waitForIdle: async () => {},
        },
        bindExtensions: async () => {},
        subscribe: () => () => {},
        getAvailableThinkingLevels: () => ["off", "low", "medium", "high"],
        setThinkingLevel(level: string) {
          calls.push(`session.set:${level}`);
        },
        settingsManager: {
          defaultThinkingLevel: "low",
          getDefaultThinkingLevel() {
            return this.defaultThinkingLevel;
          },
          setDefaultThinkingLevel(level: string) {
            calls.push(`settings.set:${level}`);
            this.defaultThinkingLevel = level;
          },
          flush() {
            calls.push("settings.flush");
            return new Promise((resolve) => {
              finishFlush = resolve;
            });
          },
          drainErrors() {
            calls.push("settings.drainErrors");
            const errors = settingsErrors;
            settingsErrors = [];
            return errors;
          },
        },
        sessionManager: testSessionManager(),
      };

      void runCustomRpcMode(session, {
        SessionManager: { listAll: async () => [], list: async () => [] },
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "1", type: "set_thinking_level", level: "high" })}\n`,
        ),
      );
      await wait(0);

      assert.deepEqual(calls, [
        "session.set:high",
        "settings.set:high",
        "settings.flush",
      ]);
      assert.equal(
        lines.some((line) => {
          try {
            return JSON.parse(line)?.id === "1";
          } catch {
            return false;
          }
        }),
        false,
      );

      finishFlush?.();
      await wait(0);

      assert.deepEqual(calls, [
        "session.set:high",
        "settings.set:high",
        "settings.flush",
        "settings.drainErrors",
      ]);
      const response = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .find((line) => line?.type === "response" && line.id === "1");
      assert.equal(response.success, true);
      assert.equal(session.settingsManager.defaultThinkingLevel, "high");

      settingsErrors = [{ scope: "global", error: new Error("disk full") }];
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "2", type: "set_thinking_level", level: "high" })}\n`,
        ),
      );
      await wait(0);
      finishFlush?.();
      await wait(0);

      const failedResponse = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .find((line) => line?.type === "response" && line.id === "2");
      assert.equal(failedResponse.success, false);
      assert.match(
        failedResponse.error,
        /rin_settings_write_failed: disk full/,
      );
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
  "rpc mode exposes available thinking levels",
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
        agent: { waitForIdle: async () => {} },
        bindExtensions: async () => {},
        subscribe: () => () => {},
        sessionManager: testSessionManager(),
        getAvailableThinkingLevels: () => ["off", "low", "medium", "high"],
      };

      void runCustomRpcMode(session, {
        SessionManager: { listAll: async () => [], list: async () => [] },
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "1", type: "get_available_thinking_levels" })}\n`,
        ),
      );
      await wait(0);

      const response = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .find((line) => line?.type === "response" && line.id === "1");
      assert.equal(response.success, true);
      assert.deepEqual(response.data, {
        levels: ["off", "low", "medium", "high"],
      });
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
  "rpc mode refuses worker-local session replacement commands",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const session = {
      isStreaming: false,
      isCompacting: false,
      sessionFile: "/tmp/test-session.jsonl",
      sessionId: "session-1",
      agent: { waitForIdle: async () => {}, state: { messages: [] } },
      bindExtensions: async () => {},
      subscribe: () => () => {},
      extensionRunner: { getCommand: () => undefined },
      modelRegistry: { getAvailable: async () => [] },
      sessionManager: testSessionManager(() => []),
      messages: [],
    };

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    try {
      void runCustomRpcMode(
        {
          session,
          switchSession: async () => {
            throw new Error("switch_session_should_be_daemon_owned");
          },
          newSession: async () => {
            throw new Error("new_session_should_be_daemon_owned");
          },
        },
        {
          SessionManager: {
            listAll: async () => [],
            list: async () => [],
            open: () => ({ appendSessionInfo() {} }),
          },
        },
      );
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "1", type: "run_command", commandLine: "/resume abc" })}\n`,
        ),
      );
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "2", type: "run_command", commandLine: "/new" })}\n`,
        ),
      );
      await wait(20);

      const responses = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((line) => line?.type === "response");
      assert.deepEqual(
        responses.map((line) => [line.id, line.success, line.error]),
        [
          [
            "1",
            false,
            "session replacement commands must be routed through the frontend",
          ],
          [
            "2",
            false,
            "session replacement commands must be routed through the frontend",
          ],
        ],
      );
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode executes /usage through the daemon builtin command path",
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

      const agentDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "rin-rpc-usage-"),
      );
      try {
        await fs.writeFile(
          path.join(agentDir, "auth.json"),
          `${JSON.stringify({
            "google-gemini-cli": {
              type: "api_key",
              email: "gemini@example.test",
            },
          })}\n`,
          "utf8",
        );
        void runCustomRpcMode(
          { session, services: { agentDir } },
          {
            SessionManager: {
              listAll: async () => [],
              list: async () => [],
              open: () => ({ appendSessionInfo() {} }),
            },
          },
        );
        await wait(0);

        const onData = handlers.get("data");
        assert.equal(typeof onData, "function");
        onData(
          Buffer.from(
            `${JSON.stringify({ id: "1", type: "run_command", commandLine: "/usage" })}\n`,
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
        assert.equal(response.data?.handled, true);
        assert.equal(response.data?.text, "");
        assert.equal(
          response.data?.parts?.some((part: any) => part?.type === "text"),
          false,
        );
        const imagePart = response.data?.parts?.find(
          (part: any) => part?.type === "image",
        );
        assert.equal(imagePart?.mimeType, "image/png");
      } finally {
        await fs.rm(agentDir, { recursive: true, force: true });
      }
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
    const durableEntries: any[] = [];
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
          const userMessage = {
            role: "user",
            timestamp: Date.now(),
            content: [{ type: "text", text: "hello" }],
          };
          const assistantMessage = {
            role: "assistant",
            timestamp: Date.now(),
            content: [{ type: "text", text: "final from rpc mode" }],
          };
          durableEntries.push({
            id: "user-entry",
            type: "message",
            message: userMessage,
          });
          durableEntries.push({
            id: "assistant-entry",
            parentId: "user-entry",
            type: "message",
            message: assistantMessage,
          });
          for (const handler of sessionSubscribers) {
            handler({ type: "message_start", message: userMessage });
            handler({ type: "message_end", message: assistantMessage });
          }
        },
        sendCustomMessage: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: {
          ...testSessionManager(() => []),
          getEntries: () => durableEntries,
          getBranch: () => durableEntries,
          getLeafId: () => durableEntries.at(-1)?.id ?? null,
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
      const userStart = events.find(
        (event) =>
          event.type === "message_start" && event.message?.role === "user",
      );
      const assistantEnd = events.find(
        (event) =>
          event.type === "message_end" && event.message?.role === "assistant",
      );
      assert.equal(userStart?.requestTag, "tag-1");
      assert.equal(assistantEnd?.requestTag, undefined);
      assert.equal(
        durableEntries.find((entry) => entry.message?.role === "user")?.message
          ?.requestTag,
        "tag-1",
      );
      assert.equal(completion?.turnGeneration, 1);
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
    const durableEntries: any[] = [];
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
            timestamp: Date.now(),
            content: [{ type: "text", text: "final before compaction" }],
          };
          durableEntries.push({
            id: "user-entry",
            type: "message",
            message: {
              role: "user",
              timestamp: Date.now(),
              content: [{ type: "text", text: "hello" }],
            },
          });
          durableEntries.push({
            id: "assistant-entry",
            parentId: "user-entry",
            type: "message",
            message: assistantMessage,
          });
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
        sessionManager: {
          ...testSessionManager(() => []),
          getEntries: () => durableEntries,
          getBranch: () => durableEntries,
          getLeafId: () => durableEntries.at(-1)?.id ?? null,
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
  "rpc mode includes retry exhaustion in terminal provider failures",
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
      const providerError =
        "Codex SSE response headers timed out after 20000ms";
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
            content: [],
            stopReason: "error",
            errorMessage: providerError,
          });
          emit({
            type: "auto_retry_end",
            success: false,
            attempt: 3,
            finalError: providerError,
          });
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
      assert.equal(
        error?.error,
        "Retry failed after 3 attempts: Codex SSE response headers timed out after 20000ms",
      );
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode includes retry exhaustion when provider failure is thrown",
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
      const providerError =
        "Codex SSE response headers timed out after 20000ms";
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
          emit({
            type: "auto_retry_end",
            success: false,
            attempt: 3,
            finalError: providerError,
          });
          throw new Error(providerError);
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
      assert.equal(error?.sessionFile, "/tmp/test-session.jsonl");
      assert.equal(error?.sessionId, "session-1");
      assert.equal(
        error?.error,
        "Retry failed after 3 attempts: Codex SSE response headers timed out after 20000ms",
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
    const durableEntries: any[] = [];

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
          durableEntries.push({
            id: "websocket-error-entry",
            type: "message",
            message: errorMessage,
          });
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
        sessionManager: {
          ...testSessionManager(() => stateMessages),
          getEntries: () => durableEntries,
        },
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
    const durableEntries: any[] = [];

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
          durableEntries.push({
            id: "overflow-error-entry",
            type: "message",
            message: errorMessage,
          });
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
          durableEntries.push({
            id: "overflow-final-entry",
            parentId: "overflow-error-entry",
            type: "message",
            message: finalMessage,
          });
          emit({ type: "agent_start" });
          emit({ type: "message_end", message: finalMessage });
          emit({ type: "agent_end" });
        },
        sendCustomMessage: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: {
          ...testSessionManager(() => stateMessages),
          getEntries: () => durableEntries,
        },
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
            id: "todo-result-entry",
            parentId: null,
            type: "message",
            message: {
              role: "toolResult",
              toolName: "todo",
              details: {
                action: "write",
                todos: [{ id: 1, text: "unfinished work", done: false }],
                nextId: 2,
              },
            },
          });
          branch.push({
            id: "assistant-final-entry",
            parentId: "todo-result-entry",
            type: "message",
            message: assistantMessage,
          });
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
          getLeafId: () => branch.at(-1)?.id ?? null,
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
  "rpc mode rejects an empty branch adapter without leaf ownership before prompting",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    let latestAssistantText = "";
    let promptCalled = false;

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    try {
      const durableEntries: any[] = [];
      const session = {
        isStreaming: false,
        isCompacting: false,
        sessionFile: "/tmp/test-session.jsonl",
        sessionId: "session-1",
        agent: { waitForIdle: async () => {} },
        bindExtensions: async () => {},
        subscribe: () => () => {},
        prompt: async () => {
          promptCalled = true;
          const currentAssistant = {
            role: "assistant",
            content: [
              { type: "text", text: "must not recover from invalid baseline" },
            ],
          };
          session.messages = [currentAssistant];
          durableEntries.push({
            id: "current-final-entry",
            parentId: null,
            type: "message",
            message: currentAssistant,
          });
          latestAssistantText = "must not recover from invalid baseline";
        },
        sendCustomMessage: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: {
          ...testSessionManager(() => session.messages || []),
          getBranch: () => durableEntries,
          getLeafId: undefined,
        },
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
      await wait(60);
      onData(
        Buffer.from(`${JSON.stringify({ id: "2", type: "get_state" })}\n`),
      );
      await wait(20);

      const events = parseRpcOutput(lines);
      const promptResponse = events.find(
        (event) => event.type === "response" && event.id === "1",
      );
      assert.equal(promptCalled, false);
      assert.equal(promptResponse?.success, false, JSON.stringify(events));
      assert.equal(
        promptResponse?.error,
        "Rin session branch cursor is unavailable before the turn starts.",
      );
      assert.equal(
        events.some((event) => event.type === "rpc_turn_event"),
        false,
      );
      const stateResponse = events.find(
        (event) => event.type === "response" && event.id === "2",
      );
      assert.equal(stateResponse?.data?.turnActive, false);
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode completes prompt turns from the scoped branch with matching message_end evidence",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const baseMessage = {
      role: "assistant",
      timestamp: Date.now() - 10_000,
      content: [{ type: "text", text: "previous final" }],
    };
    const durableEntries: any[] = [
      { id: "base-entry", type: "message", message: baseMessage },
    ];
    const sessionSubscribers = new Set<(event: any) => void>();

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
            timestamp: Date.now(),
            content: [{ type: "text", text: "observed final" }],
          };
          durableEntries.push({
            id: "final-entry",
            parentId: "base-entry",
            type: "message",
            message: assistantMessage,
          });
          for (const handler of sessionSubscribers) {
            handler({ type: "message_end", message: assistantMessage });
          }
        },
        sendCustomMessage: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: {
          buildSessionContext: () => ({
            messages: durableEntries.map((entry) => entry.message),
          }),
          getBranch: () => durableEntries,
          getEntries: () => durableEntries,
          getLeafId: () => durableEntries.at(-1)?.id ?? null,
          getTree: () => [],
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

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "1", type: "prompt", message: "hello", requestTag: "tag-1" })}\n`,
        ),
      );
      await wait(80);

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
      const complete = events.find(
        (event) =>
          event.type === "rpc_turn_event" && event.event === "complete",
      );
      assert.equal(complete?.requestTag, "tag-1");
      assert.equal(complete?.finalText, "observed final");
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
  "rpc mode reports branch ownership changes instead of inventing a missing final",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const sessionSubscribers = new Set();
    const durableEntries: any[] = [];

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
            content: [
              { type: "text", text: "tool preface is not final" },
              { type: "toolCall", name: "read", id: "call-1" },
            ],
          };
          for (const handler of sessionSubscribers) {
            handler({ type: "message_end", message: assistantMessage });
          }
          (session.sessionManager as any).getLeafId = undefined;
        },
        sendCustomMessage: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: {
          ...testSessionManager(() => session.messages || []),
          getBranch: () => durableEntries,
          getLeafId: () => null,
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

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "1", type: "prompt", message: "hello", requestTag: "tag-1" })}\n`,
        ),
      );
      await wait(60);
      onData(
        Buffer.from(`${JSON.stringify({ id: "2", type: "get_state" })}\n`),
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
      const error = events.find(
        (event) => event.type === "rpc_turn_event" && event.event === "error",
      );
      assert.equal(completion, undefined);
      assert.equal(error?.requestTag, "tag-1");
      assert.equal(
        error?.error,
        "Rin session branch ownership changed while the turn was running.",
      );
      const stateResponse = events.find(
        (event) => event.type === "response" && event.id === "2",
      );
      assert.equal(stateResponse?.data?.turnActive, false);
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode resolves final text from the current scoped branch with message_end evidence",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const durableEntries: any[] = [
      {
        type: "message",
        id: "base-entry",
        parentId: null,
        message: {
          role: "assistant",
          timestamp: Date.now() - 10_000,
          content: [{ type: "text", text: "previous final" }],
        },
      },
    ];
    const sessionSubscribers = new Set<(event: any) => void>();

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
        agent: { state: { messages: [] }, waitForIdle: async () => {} },
        bindExtensions: async () => {},
        subscribe: (handler) => {
          sessionSubscribers.add(handler);
          return () => sessionSubscribers.delete(handler);
        },
        prompt: async () => {
          const assistantMessage = {
            role: "assistant",
            timestamp: Date.now(),
            content: [{ type: "text", text: "branch entry final" }],
          };
          session.agent.state.messages = [assistantMessage];
          durableEntries.push({
            type: "message",
            id: "final-entry",
            parentId: "base-entry",
            message: assistantMessage,
          });
          for (const handler of sessionSubscribers) {
            handler({ type: "message_end", message: assistantMessage });
          }
        },
        sendCustomMessage: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: {
          buildSessionContext: () => ({
            messages: durableEntries.map((entry) => entry.message),
          }),
          getBranch: () => durableEntries,
          getLeafId: () => durableEntries.at(-1)?.id ?? null,
          getEntries: () => durableEntries,
          getTree: () => [],
          getCwd: () => process.cwd(),
          getSessionDir: () => process.cwd(),
        },
        messages: [],
        getSessionStats: () => ({}),
        getUserMessagesForForking: () => [],
        getLastAssistantText: () => "branch entry final",
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
      assert.equal(completion?.finalText, "branch entry final");
      assert.deepEqual(completion?.result, {
        messages: [{ type: "text", text: "branch entry final" }],
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
  "rpc mode completes stored branch finals without treating task return as agent settlement",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const durableEntries: any[] = [];
    const stateMessages: any[] = [];
    let promptCount = 0;

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
          promptCount += 1;
          const promptMessages =
            promptCount < 3
              ? [
                  {
                    role: "assistant",
                    timestamp: Date.now(),
                    content: [
                      {
                        type: "text",
                        text:
                          promptCount === 1 ? "final from stored session" : "",
                      },
                    ],
                  },
                ]
              : [
                  {
                    role: "assistant",
                    content: [
                      {
                        type: "text",
                        text: "must stay interim before agent settlement",
                      },
                      {
                        type: "toolCall",
                        name: "todo",
                        id: "task-return-tool",
                      },
                    ],
                    stopReason: "toolUse",
                  },
                  {
                    role: "toolResult",
                    toolCallId: "task-return-tool",
                    content: [],
                    isError: false,
                  },
                  {
                    role: "assistant",
                    content: [],
                    stopReason: "stop",
                  },
                ];
          for (const [index, message] of promptMessages.entries()) {
            stateMessages.push(message);
            durableEntries.push({
              id: `stored-final-entry-${promptCount}-${index}`,
              parentId: durableEntries.at(-1)?.id ?? null,
              type: "message",
              message,
            });
          }
        },
        sendCustomMessage: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: {
          ...testSessionManager(() => stateMessages),
          getEntries: () => durableEntries,
          getBranch: () => durableEntries,
          getLeafId: () => durableEntries.at(-1)?.id ?? null,
        },
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
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "2", type: "prompt", message: "empty", requestTag: "tag-2" })}\n`,
        ),
      );
      await wait(100);
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "3", type: "prompt", message: "task before settled", requestTag: "tag-3" })}\n`,
        ),
      );
      await wait(100);

      const events = parseRpcOutput(lines);
      const completions = events.filter(
        (event) =>
          event.type === "rpc_turn_event" && event.event === "complete",
      );
      const errors = events.filter(
        (event) => event.type === "rpc_turn_event" && event.event === "error",
      );
      assert.equal(completions[0]?.requestTag, "tag-1");
      assert.equal(completions[0]?.finalText, "final from stored session");
      assert.deepEqual(completions[0]?.result, {
        messages: [{ type: "text", text: "final from stored session" }],
      });
      assert.equal(completions[1]?.requestTag, "tag-2");
      assert.equal(completions[1]?.finalText, "");
      assert.deepEqual(completions[1]?.result, { messages: [] });
      assert.equal(completions[2]?.requestTag, "tag-3");
      assert.equal(completions[2]?.finalText, "");
      assert.deepEqual(completions[2]?.result, { messages: [] });
      assert.deepEqual(errors, []);
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
  "rpc mode terminalizes from agent_settled when the outer prompt promise never returns",
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
        sessionFile: "/tmp/settled-terminal-session.jsonl",
        sessionId: "settled-terminal-session",
        agent: {
          signal: undefined,
          state: { isStreaming: false },
          waitForIdle: async () => {},
        },
        bindExtensions: async () => {},
        subscribe: (handler) => {
          sessionSubscribers.add(handler);
          return () => sessionSubscribers.delete(handler);
        },
        async prompt() {
          await new Promise(() => {});
        },
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: testSessionManager(() => session.messages),
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
        abortBash: () => {},
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
          `${JSON.stringify({ id: "turn-settled", type: "prompt", message: "finish durably", requestTag: "tag-settled" })}\n`,
        ),
      );
      await wait(10);

      const finalMessage = {
        role: "assistant",
        content: [{ type: "text", text: "durable settled final" }],
        stopReason: "stop",
      };
      session.messages.push(finalMessage);
      for (const handler of sessionSubscribers) {
        handler({ type: "message_end", message: finalMessage });
      }
      await wait(10);
      assert.equal(
        parseRpcOutput(lines).some(
          (event) =>
            event.type === "rpc_turn_event" && event.event === "complete",
        ),
        false,
      );
      for (const handler of sessionSubscribers) {
        handler({ type: "agent_settled" });
      }
      await wait(20);

      const completions = parseRpcOutput(lines).filter(
        (event) =>
          event.type === "rpc_turn_event" && event.event === "complete",
      );
      assert.deepEqual(
        completions.map((event) => ({
          requestTag: event.requestTag,
          finalText: event.finalText,
        })),
        [{ requestTag: "tag-settled", finalText: "durable settled final" }],
      );
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode settles the current durable tool preface when Pi stops with an empty assistant message",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines: string[] = [];
    const sessionSubscribers = new Set<(event: any) => void>();
    const messages: any[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "stale previous final" }],
        stopReason: "stop",
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
        sessionFile: "/tmp/settled-tool-preface-session.jsonl",
        sessionId: "settled-tool-preface-session",
        agent: {
          signal: undefined,
          state: { isStreaming: false, messages },
          waitForIdle: async () => {},
        },
        bindExtensions: async () => {},
        subscribe: (handler: (event: any) => void) => {
          sessionSubscribers.add(handler);
          return () => sessionSubscribers.delete(handler);
        },
        async prompt() {
          await new Promise(() => {});
        },
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: testSessionManager(() => messages),
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
        abortBash: () => {},
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
          `${JSON.stringify({ id: "turn-tool-preface", type: "prompt", message: "prepare the change", requestTag: "tag-tool-preface" })}\n`,
        ),
      );
      await wait(10);

      const toolPreface = {
        role: "assistant",
        content: [
          { type: "text", text: "Complete owner-facing response" },
          {
            type: "toolCall",
            name: "todo",
            id: "call-todo",
            arguments: { todos: [] },
          },
        ],
        stopReason: "toolUse",
      };
      const toolResult = {
        role: "toolResult",
        toolCallId: "call-todo",
        toolName: "todo",
        content: [{ type: "text", text: "[]" }],
        isError: false,
      };
      const emptyStop = {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stopReason: "stop",
      };
      messages.push(toolPreface, toolResult, emptyStop);
      for (const handler of sessionSubscribers) {
        handler({ type: "message_end", message: toolPreface });
        handler({ type: "message_end", message: toolResult });
        handler({ type: "message_end", message: emptyStop });
        handler({ type: "agent_settled" });
      }
      await wait(20);

      const terminals = parseRpcOutput(lines).filter(
        (event) =>
          event.type === "rpc_turn_event" &&
          (event.event === "complete" || event.event === "error"),
      );
      assert.deepEqual(
        terminals.map((event) => ({
          event: event.event,
          requestTag: event.requestTag,
          finalText: event.finalText,
          result: event.result,
        })),
        [
          {
            event: "complete",
            requestTag: "tag-tool-preface",
            finalText: "Complete owner-facing response",
            result: {
              messages: [
                { type: "text", text: "Complete owner-facing response" },
              ],
            },
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
  "rpc mode rejects an observed-only final that is absent from the settled turn scope",
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
        sessionFile: "/tmp/settled-absent-session.jsonl",
        sessionId: "settled-absent-session",
        agent: {
          signal: undefined,
          state: { isStreaming: false },
          waitForIdle: async () => {},
        },
        bindExtensions: async () => {},
        subscribe: (handler) => {
          sessionSubscribers.add(handler);
          return () => sessionSubscribers.delete(handler);
        },
        async prompt() {
          await new Promise(() => {});
        },
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: testSessionManager(() => session.messages),
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
        abortBash: () => {},
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
          `${JSON.stringify({ id: "turn-absent", type: "prompt", message: "finish silently", requestTag: "tag-absent" })}\n`,
        ),
      );
      await wait(10);
      const observedOnlyFinal = {
        role: "assistant",
        content: [{ type: "text", text: "not durably scoped" }],
      };
      for (const handler of sessionSubscribers) {
        handler({ type: "message_end", message: observedOnlyFinal });
        handler({ type: "agent_settled" });
      }
      await wait(20);

      const terminalEvents = parseRpcOutput(lines).filter(
        (event) =>
          event.type === "rpc_turn_event" &&
          (event.event === "complete" || event.event === "error"),
      );
      assert.deepEqual(
        terminalEvents.map((event) => ({
          event: event.event,
          requestTag: event.requestTag,
          error: event.error,
        })),
        [
          {
            event: "error",
            requestTag: "tag-absent",
            error: "rin_turn_settled_without_terminal",
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
  "rpc mode keeps a recovered terminal open across an admitted steer boundary",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines: string[] = [];
    const sessionSubscribers = new Set<(event: any) => void>();
    const stateMessages: any[] = [
      {
        role: "user",
        content: [{ type: "text", text: "interrupted prompt" }],
      },
    ];
    let rejectRecovery: ((error: Error) => void) | undefined;
    const recoveryGate = new Promise<void>((_resolve, reject) => {
      rejectRecovery = reject;
    });
    let rejectImagePrompt: ((error: Error) => void) | undefined;
    const imagePromptGate = new Promise<void>((_resolve, reject) => {
      rejectImagePrompt = reject;
    });
    let releaseHangingPrompt: (() => void) | undefined;
    const hangingPromptGate = new Promise<void>((resolve) => {
      releaseHangingPrompt = resolve;
    });
    let holdInterruptAbort = false;
    let releaseInterruptAbort: (() => void) | undefined;
    const interruptAbortGate = new Promise<void>((resolve) => {
      releaseInterruptAbort = resolve;
    });

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
        sessionFile: "/tmp/recovered-steer-terminal-session.jsonl",
        sessionId: "recovered-steer-terminal-session",
        agent: {
          signal: undefined,
          state: { messages: stateMessages },
          waitForIdle: async () => {},
        },
        bindExtensions: async () => {},
        subscribe: (handler: (event: any) => void) => {
          sessionSubscribers.add(handler);
          return () => sessionSubscribers.delete(handler);
        },
        _runAgentPrompt: async () => {
          await recoveryGate;
        },
        prompt: async (message: string) => {
          if (message === "") {
            await imagePromptGate;
            return;
          }
          if (message === "settled then rejected") {
            const settledFinal = {
              role: "assistant",
              content: [{ type: "text", text: "settled final" }],
              stopReason: "stop",
            };
            stateMessages.push(settledFinal);
            for (const handler of sessionSubscribers) {
              handler({ type: "message_end", message: settledFinal });
              handler({ type: "agent_settled" });
            }
            throw new Error("late outer rejection");
          }
          if (message === "hanging prompt") {
            session.agent.signal = new AbortController().signal;
            await hangingPromptGate;
            return;
          }
          if (message === "rejected prompt") {
            const rejectedFinal = {
              role: "assistant",
              content: [{ type: "text", text: "must not replace task error" }],
              stopReason: "stop",
            };
            stateMessages.push(rejectedFinal);
            for (const handler of sessionSubscribers) {
              handler({ type: "message_end", message: rejectedFinal });
            }
            throw new Error("ordinary prompt rejected");
          }
          if (message !== "normal prompt") return;
          const normalFinal = {
            role: "assistant",
            content: [{ type: "text", text: "normal final" }],
            stopReason: "stop",
          };
          stateMessages.push(normalFinal);
          for (const handler of sessionSubscribers) {
            handler({ type: "message_end", message: normalFinal });
            handler({ type: "agent_settled" });
          }
        },
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {
          releaseHangingPrompt?.();
          if (holdInterruptAbort) await interruptAbortGate;
        },
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: testSessionManager(() => stateMessages),
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
        abortBash: () => {},
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
          `${JSON.stringify({ id: "resume", type: "resume_interrupted_turn", requestTag: "tag-recovered" })}\n`,
        ),
      );
      await wait(10);
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "steer", type: "prompt", message: "", images: ["image-only"], requestTag: "tag-steer" })}\n`,
        ),
      );
      await wait(10);

      assert.equal(
        parseRpcOutput(lines).some(
          (event) => event.type === "response" && event.id === "steer",
        ),
        false,
      );

      const recoveredFinal = {
        role: "assistant",
        content: [{ type: "text", text: "stale recovered final" }],
        stopReason: "stop",
      };
      stateMessages.push(recoveredFinal);
      for (const handler of sessionSubscribers) {
        handler({ type: "message_end", message: recoveredFinal });
      }
      rejectRecovery?.(new Error("recovered runner failed at boundary"));
      await wait(0);
      for (const handler of sessionSubscribers) {
        handler({ type: "agent_settled" });
      }
      await wait(20);

      assert.equal(
        parseRpcOutput(lines).some(
          (event) =>
            event.type === "rpc_turn_event" &&
            (event.event === "complete" || event.event === "error"),
        ),
        false,
      );

      const unrelatedEmptyUser = {
        role: "user",
        content: [],
      };
      stateMessages.push(unrelatedEmptyUser);
      for (const handler of sessionSubscribers) {
        handler({ type: "message_start", message: unrelatedEmptyUser });
        handler({ type: "agent_settled" });
      }
      await wait(20);
      assert.equal(
        parseRpcOutput(lines).some(
          (event) =>
            event.type === "rpc_turn_event" &&
            (event.event === "complete" || event.event === "error"),
        ),
        false,
      );

      const steeredUser = {
        role: "user",
        content: [{ type: "image", data: "image-only", mimeType: "image/png" }],
      };
      stateMessages.push(steeredUser);
      for (const handler of sessionSubscribers) {
        handler({ type: "message_start", message: steeredUser });
      }
      rejectImagePrompt?.(new Error("late admitted prompt rejection"));
      await wait(20);
      assert.equal(
        parseRpcOutput(lines).some(
          (event) =>
            event.type === "rpc_turn_event" &&
            (event.event === "complete" || event.event === "error"),
        ),
        false,
      );
      for (const handler of sessionSubscribers) {
        handler({ type: "agent_settled" });
      }
      await wait(20);

      const terminals = parseRpcOutput(lines).filter(
        (event) =>
          event.type === "rpc_turn_event" &&
          (event.event === "complete" || event.event === "error"),
      );
      assert.deepEqual(
        terminals.map((event) => ({
          event: event.event,
          requestTag: event.requestTag,
          error: event.error,
        })),
        [
          {
            event: "error",
            requestTag: "tag-recovered",
            error: "recovered runner failed at boundary",
          },
        ],
      );

      onData(
        Buffer.from(
          `${JSON.stringify({ id: "normal", type: "prompt", message: "normal prompt", requestTag: "tag-normal" })}\n`,
        ),
      );
      await wait(20);
      const normalTerminal = parseRpcOutput(lines).find(
        (event) =>
          event.type === "rpc_turn_event" &&
          event.event === "complete" &&
          event.requestTag === "tag-normal",
      );
      assert.equal(normalTerminal?.finalText, "normal final");

      onData(
        Buffer.from(
          `${JSON.stringify({ id: "settled-rejected", type: "prompt", message: "settled then rejected", requestTag: "tag-settled-rejected" })}\n`,
        ),
      );
      await wait(20);
      const settledRejectedTerminal = parseRpcOutput(lines).find(
        (event) =>
          event.type === "rpc_turn_event" &&
          (event.event === "complete" || event.event === "error") &&
          event.requestTag === "tag-settled-rejected",
      );
      assert.equal(settledRejectedTerminal?.event, "complete");
      assert.equal(settledRejectedTerminal?.finalText, "settled final");

      onData(
        Buffer.from(
          `${JSON.stringify({ id: "rejected", type: "prompt", message: "rejected prompt", requestTag: "tag-rejected" })}\n`,
        ),
      );
      await wait(20);
      const rejectedTerminal = parseRpcOutput(lines).find(
        (event) =>
          event.type === "rpc_turn_event" &&
          (event.event === "complete" || event.event === "error") &&
          event.requestTag === "tag-rejected",
      );
      assert.equal(rejectedTerminal?.event, "error");
      assert.equal(rejectedTerminal?.error, "ordinary prompt rejected");

      onData(
        Buffer.from(
          `${JSON.stringify({ id: "hanging", type: "prompt", message: "hanging prompt", requestTag: "tag-hanging" })}\n`,
        ),
      );
      await wait(10);
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "queued-cancel", type: "prompt", message: "queued cancel", requestTag: "tag-queued-cancel" })}\n`,
        ),
      );
      await wait(10);
      const queuedStartedUser = {
        role: "user",
        content: [{ type: "text", text: "queued cancel" }],
      };
      stateMessages.push(queuedStartedUser);
      for (const handler of sessionSubscribers) {
        handler({ type: "message_start", message: queuedStartedUser });
      }
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "queued-pending", type: "prompt", message: "queued pending", requestTag: "tag-queued-pending" })}\n`,
        ),
      );
      await wait(10);
      holdInterruptAbort = true;
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "resume-cancel", type: "resume_interrupted_turn", requestTag: "tag-resume-cancel" })}\n`,
        ),
      );
      await wait(5);
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "during-interrupt", type: "prompt", message: "during interrupt", requestTag: "tag-during-interrupt" })}\n`,
        ),
      );
      await wait(10);
      const duringInterruptResponse = parseRpcOutput(lines).find(
        (event) => event.type === "response" && event.id === "during-interrupt",
      );
      assert.equal(duringInterruptResponse?.success, false);
      releaseInterruptAbort?.();
      await wait(30);
      assert.equal(
        parseRpcOutput(lines).some(
          (event) => event.type === "response" && event.id === "resume-cancel",
        ),
        true,
      );

      onData(
        Buffer.from(
          `${JSON.stringify({ id: "abort-hanging", type: "prompt", message: "hanging prompt", requestTag: "tag-abort-hanging" })}\n`,
        ),
      );
      await wait(10);
      onData(
        Buffer.from(`${JSON.stringify({ id: "abort", type: "abort" })}\n`),
      );
      await wait(20);
      assert.equal(
        parseRpcOutput(lines).some(
          (event) => event.type === "response" && event.id === "abort",
        ),
        true,
      );
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "normal-after-abort", type: "prompt", message: "normal prompt", requestTag: "tag-normal-after-abort" })}\n`,
        ),
      );
      await wait(20);
      const afterAbortEvents = parseRpcOutput(lines);
      assert.equal(
        afterAbortEvents.some(
          (event) =>
            event.type === "rpc_turn_event" &&
            event.event === "complete" &&
            event.requestTag === "tag-normal-after-abort" &&
            event.finalText === "normal final",
        ),
        true,
        JSON.stringify(afterAbortEvents.slice(-12)),
      );
    } finally {
      rejectRecovery?.(new Error("test cleanup"));
      rejectImagePrompt?.(new Error("test cleanup"));
      releaseHangingPrompt?.();
      releaseInterruptAbort?.();
      const onData = handlers.get("data");
      if (typeof onData === "function") {
        onData(
          Buffer.from(
            `${JSON.stringify({ id: "cleanup", type: "clear_queue" })}\n`,
          ),
        );
        await wait(0);
      }
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode keeps Pi prompt ownership immutable across a queued steer",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const sessionSubscribers = new Set();
    let releaseSteeredTurn;
    const steeredTurnGate = new Promise((resolve) => {
      releaseSteeredTurn = resolve;
    });

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
        sessionFile: "/tmp/steer-terminal-session.jsonl",
        sessionId: "steer-terminal-session",
        agent: {
          signal: undefined,
          state: { isStreaming: false },
          waitForIdle: async () => {},
        },
        bindExtensions: async () => {},
        subscribe: (handler) => {
          sessionSubscribers.add(handler);
          return () => sessionSubscribers.delete(handler);
        },
        async prompt() {
          if (this.isStreaming) return;
          this.isStreaming = true;
          await steeredTurnGate;
          this.isStreaming = false;
        },
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: testSessionManager(() => session.messages),
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
        abortBash: () => {},
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
          `${JSON.stringify({ id: "turn-first", type: "prompt", message: "first", requestTag: "tag-first" })}\n`,
        ),
      );
      await wait(10);
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "turn-steer", type: "prompt", message: "steer now", streamingBehavior: "steer", requestTag: "tag-steer" })}\n`,
        ),
      );
      await wait(10);

      const secondAdmission = parseRpcOutput(lines).find(
        (event) => event.type === "response" && event.id === "turn-steer",
      );
      assert.equal(secondAdmission?.data?.acceptedAs, "prompt");

      const steeredUser = {
        role: "user",
        content: [{ type: "text", text: "steer now" }],
      };
      session.messages.push(steeredUser);
      for (const handler of sessionSubscribers) {
        handler({
          type: "message_start",
          message: steeredUser,
        });
      }
      await wait(20);

      const projectedUserStart = parseRpcOutput(lines).find(
        (event) =>
          event.type === "message_start" && event.message?.role === "user",
      );
      assert.equal(projectedUserStart?.requestTag, "tag-steer");
      assert.equal(projectedUserStart?.message?.requestTag, "tag-steer");
      assert.equal(
        parseRpcOutput(lines).some(
          (event) =>
            event.type === "rpc_turn_event" && event.event === "complete",
        ),
        false,
      );

      const finalMessage = {
        role: "assistant",
        content: [{ type: "text", text: "steered final" }],
      };
      session.messages.push(finalMessage);
      for (const handler of sessionSubscribers) {
        handler({ type: "message_end", message: finalMessage });
      }
      releaseSteeredTurn();
      for (const handler of sessionSubscribers) {
        handler({ type: "agent_settled" });
      }
      await wait(20);

      const completions = parseRpcOutput(lines).filter(
        (event) =>
          event.type === "rpc_turn_event" && event.event === "complete",
      );
      assert.deepEqual(
        completions.map((event) => ({
          requestTag: event.requestTag,
          finalText: event.finalText,
        })),
        [{ requestTag: "tag-first", finalText: "steered final" }],
      );
    } finally {
      releaseSteeredTurn?.();
      for (const handler of sessionSubscribers) {
        handler({ type: "agent_settled" });
      }
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode starts a new terminal owner after a tracked turn settles during a signal gap",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const calls = [];
    const sessionSubscribers = new Set();
    const activeRunSignal = new AbortController().signal;
    const agentState = { isStreaming: false, activeRun: false };

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
        agent: {
          get signal() {
            return agentState.activeRun ? activeRunSignal : undefined;
          },
          state: agentState,
          waitForIdle: async () => {},
        },
        bindExtensions: async () => {},
        subscribe: (handler) => {
          sessionSubscribers.add(handler);
          return () => sessionSubscribers.delete(handler);
        },
        async prompt(message, options) {
          calls.push(["prompt", message, options, this.isStreaming]);
          if (!this.isStreaming) {
            agentState.activeRun = true;
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
      agentState.activeRun = false;
      const firstFinal = {
        role: "assistant",
        content: [{ type: "text", text: "first settled final" }],
        stopReason: "stop",
      };
      session.messages.push(firstFinal);
      for (const handler of sessionSubscribers) {
        handler({ type: "message_end", message: firstFinal });
        handler({ type: "agent_settled" });
      }
      await wait(10);
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "queue-1", type: "prompt", message: "plain follow-in", streamingBehavior: "followUp", requestTag: "tag-2" })}\n`,
        ),
      );
      await wait(10);
      agentState.activeRun = false;
      const secondFinal = {
        role: "assistant",
        content: [{ type: "text", text: "second settled final" }],
        stopReason: "stop",
      };
      session.messages.push(secondFinal);
      for (const handler of sessionSubscribers) {
        handler({ type: "message_end", message: secondFinal });
        handler({ type: "agent_settled" });
      }
      await wait(20);

      assert.deepEqual(calls, [
        [
          "prompt",
          "first",
          {
            images: undefined,
            streamingBehavior: "steer",
            source: "rpc",
          },
          false,
        ],
        [
          "prompt",
          "plain follow-in",
          {
            images: undefined,
            streamingBehavior: "steer",
            source: "rpc",
            requestTag: "tag-2",
          },
          false,
        ],
      ]);
      assert.equal(agentState.isStreaming, false);
      const response = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .find((line) => line?.id === "queue-1");
      assert.equal(response?.data?.acceptedAs, "prompt");
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode does not override Pi state during an untracked signal gap",
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
        agent: {
          signal: new AbortController().signal,
          state: { isStreaming: false },
          waitForIdle: async () => {},
        },
        bindExtensions: async () => {},
        subscribe: () => () => {},
        async prompt(message, options) {
          calls.push([message, options, this.isStreaming]);
          if (!this.isStreaming || options?.streamingBehavior !== "steer") {
            throw new Error(
              "Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
            );
          }
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
          `${JSON.stringify({ id: "queue-1", type: "prompt", message: "recovery follow-in", requestTag: "tag-2" })}\n`,
        ),
      );
      await wait(20);

      assert.deepEqual(calls, [
        [
          "recovery follow-in",
          {
            images: undefined,
            streamingBehavior: "steer",
            source: "rpc",
            requestTag: "tag-2",
          },
          false,
        ],
      ]);
      const response = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .find((line) => line?.id === "queue-1");
      assert.equal(response?.success, true);
      const terminal = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .find(
          (line) => line?.type === "rpc_turn_event" && line?.event === "error",
        );
      assert.equal(terminal?.requestTag, "tag-2");
      assert.match(terminal?.error || "", /Agent is already processing/);
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode native queue creates one terminal observer when no local tracker exists",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const calls = [];
    const sessionSubscribers = new Set();
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
          signal: new AbortController().signal,
          waitForIdle: async () => {
            waitForIdleCalls += 1;
          },
        },
        bindExtensions: async () => {},
        subscribe: (handler) => {
          sessionSubscribers.add(handler);
          return () => sessionSubscribers.delete(handler);
        },
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
      const finalMessage = {
        role: "assistant",
        content: [{ type: "text", text: "native queued final" }],
      };
      session.messages.push(finalMessage);
      session.isStreaming = false;
      session.agent.signal = undefined;
      for (const handler of sessionSubscribers) {
        handler({ type: "message_end", message: finalMessage });
        handler({ type: "agent_settled" });
      }
      await wait(20);
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
      assert.deepEqual(
        events
          .filter(
            (event) =>
              event.type === "rpc_turn_event" && event.event === "complete",
          )
          .map((event) => ({
            event: event.event,
            requestTag: event.requestTag,
            finalText: event.finalText,
          })),
        [
          {
            event: "complete",
            requestTag: "tag-1",
            finalText: "native queued final",
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
  "rpc mode does not implement worker-local new_session commands",
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
      const responseLine = lines.find((line) => line.includes('"id":"3"'));
      assert.ok(responseLine);
      const response = JSON.parse(responseLine);
      assert.equal(response.success, false);
      assert.equal(response.error, "Unknown command: new_session");
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode does not create persisted sessions from worker-local new_session",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const createRuntimeCalls = [];
    let defaultNewSessionCalls = 0;
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
        getSessionDir: () => "/tmp/rin/sessions",
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
      currentSession = createSession(undefined, "memory-id");
      const runtime = {
        get session() {
          return currentSession;
        },
        services: { agentDir: "/tmp/rin" },
        async newSession() {
          defaultNewSessionCalls += 1;
          throw new Error(
            "default new_session must create a persisted manager",
          );
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
        async emitBeforeSwitch(reason) {
          assert.equal(reason, "new");
          return { cancelled: false };
        },
        async teardownCurrent(reason, targetSessionFile) {
          assert.equal(reason, "new");
          assert.match(targetSessionFile, /\/sessions\//);
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
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({
            id: "default-new",
            type: "new_session",
            frontendIdentity: { kind: "tui" },
          })}\n`,
        ),
      );
      await wait(20);

      assert.equal(defaultNewSessionCalls, 0);
      assert.equal(createRuntimeCalls.length, 0);
      const responseLine = lines.find((line) =>
        line.includes('"id":"default-new"'),
      );
      assert.ok(responseLine);
      const response = JSON.parse(responseLine);
      assert.equal(response.success, false);
      assert.equal(response.error, "Unknown command: new_session");
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode does not honor managed session leaf inside a worker",
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
      assert.equal(createRuntimeCalls.length, 0);
      assert.equal(newSessionCalls, 0);
      const responseLine = lines.find((line) =>
        line.includes('"id":"managed-new"'),
      );
      assert.ok(responseLine);
      const response = JSON.parse(responseLine);
      assert.equal(response.success, false);
      assert.equal(response.error, "Unknown command: new_session");
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode keeps session selector unchanged for worker-local new_session",
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
      assert.equal(payload.success, false);
      assert.equal(payload.error, "Unknown command: new_session");
      assert.equal(currentSession.name, "first");
      assert.equal(abortCalls, 0);
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode keeps the current session for worker-local new_session",
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

      assert.deepEqual(bindCalls, ["first"]);
      assert.equal(unsubscribeCount, 1);
      assert.deepEqual(prompts, [
        [
          "first",
          "after swap",
          {
            images: undefined,
            streamingBehavior: "steer",
            source: "rpc",
            requestTag: "tag-4",
          },
        ],
      ]);
      const responseLine = lines.find((line) => line.includes('"id":"3"'));
      assert.ok(responseLine);
      const response = JSON.parse(responseLine);
      assert.equal(response.success, false);
      assert.equal(response.error, "Unknown command: new_session");
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
        _runAgentPrompt: async (messages) => {
          calls.push(["runAgentPrompt", messages]);
        },
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
          getBranch: () => [],
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
      assert.deepEqual(calls[2], ["runAgentPrompt", []]);
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
  "rpc mode resume_interrupted_turn does not re-emit a persisted assistant final",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines: string[] = [];
    const messages = [
      { role: "user", content: "restart prompt" },
      {
        role: "assistant",
        content: [{ type: "text", text: "old final must not replay" }],
      },
    ];
    let continued = false;

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
        messages,
        agent: {
          state: { messages },
          continue: async () => {
            continued = true;
          },
        },
        subscribe: () => () => {},
        appendMessage: () => {},
        getSessionStats: () => ({}),
        getUserMessagesForForking: () => [],
        getLastAssistantText: () => "old final must not replay",
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
        sessionManager: testSessionManager(() => messages),
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

      const events = parseRpcOutput(lines);
      const response = events.find(
        (event) => event.type === "response" && event.id === "2",
      );
      assert.equal(continued, false);
      assert.equal(response?.success, true, JSON.stringify(events));
      assert.equal(response?.data?.resumed, false);
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
  "rpc mode resume_interrupted_turn terminates when no resumable result exists",
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
      await wait(60);
      onData(
        Buffer.from(`${JSON.stringify({ id: "3", type: "get_state" })}\n`),
      );
      await wait(20);

      const events = parseRpcOutput(lines);
      const response = events.find(
        (event) => event.type === "response" && event.id === "2",
      );
      const stateResponse = events.find(
        (event) => event.type === "response" && event.id === "3",
      );
      assert.equal(response?.success, true, JSON.stringify(events));
      assert.equal(response?.data?.resumed, false);
      assert.equal(
        events.some((event) => event.type === "rpc_turn_event"),
        false,
      );
      assert.equal(stateResponse?.data?.turnActive, false);
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
  "rpc mode does not implement worker-local switch_session commands",
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
      assert.ok(output.includes('"success":false'));
      assert.ok(output.includes('"Unknown command: switch_session"'));
      assert.deepEqual(calls, []);
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode rejoins an active input with the same durable request tag",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const calls = [];
    const durableEntries: any[] = [];
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
        prompt: async (message, options) => {
          calls.push([message, options]);
          await promptGate;
          durableEntries.push({
            id: "final-entry",
            type: "message",
            message: {
              role: "assistant",
              timestamp: Date.now(),
              content: [{ type: "text", text: "done" }],
            },
          });
        },
        sendCustomMessage: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: {
          ...testSessionManager(() => []),
          getEntries: () => durableEntries,
          getBranch: () => durableEntries,
          getLeafId: () => durableEntries.at(-1)?.id ?? null,
        },
        messages: [],
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
          `${JSON.stringify({ id: "turn-1", type: "prompt", message: "hello", requestTag: "chat-inbox-stable" })}\n${JSON.stringify({ id: "rejoin-1", type: "prompt", message: "hello", requestTag: "chat-inbox-stable" })}\n`,
        ),
      );
      await wait(100);

      const response = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .find((line) => line?.id === "rejoin-1");
      assert.equal(response?.data?.acceptedAs, "rejoin");
      assert.equal(response?.data?.requestTag, "chat-inbox-stable");
      assert.equal(calls.length, 1);
    } finally {
      releasePrompt?.();
      await wait(60);
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
    const durableEntries: any[] = [];
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
          durableEntries.push({
            id: "final-entry",
            type: "message",
            message: {
              role: "assistant",
              timestamp: Date.now(),
              content: [{ type: "text", text: "done" }],
            },
          });
        },
        sendCustomMessage: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: {
          ...testSessionManager(() => []),
          getEntries: () => durableEntries,
          getBranch: () => durableEntries,
          getLeafId: () => durableEntries.at(-1)?.id ?? null,
        },
        messages: [],
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
      await wait(60);

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
      assert.equal(stateResponse?.data?.piActiveRun, false);
      assert.equal(stateResponse?.data?.interruptedTurnResumable, false);
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);
