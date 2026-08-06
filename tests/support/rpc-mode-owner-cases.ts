import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

await import("../support/register-rpc-mode-owner-fixture.ts");

const execFileAsync = promisify(execFile);

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const rpcModeModule = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-daemon", "rpc-mode.js"))
    .href
);
const { runCustomRpcMode } = rpcModeModule;
await Promise.all([
  import("../integration/rpc-mode.test.js"),
  import("../integration/rpc-auth.test.js"),
  import("../integration/rpc-model-runtime.test.js"),
  import("../integration/rpc-runtime-binding.test.js"),
  import("../integration/rpc-settings-persistence.test.js"),
]);

function wait(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function testSessionManager(getMessages = () => []) {
  return {
    buildSessionContext: () => ({ messages: getMessages() }),
    getEntries: () => [],
    getTree: () => [],
    getBranch: () => [],
    getLeafId: () => null,
    getCwd: () => process.cwd(),
    getSessionDir: () => process.cwd(),
  };
}

test("rpc mode private protocol normalizers preserve sparse response boundaries", () => {
  const seam = rpcModeModule as any;
  const parseDefault =
    seam.__rinOwnerCreateExtensionUiResponseParser("fallback");
  assert.equal(parseDefault(undefined), "fallback");
  assert.equal(parseDefault({ cancelled: true, value: "x" }), "fallback");
  assert.equal(parseDefault({ confirmed: true }), true);
  assert.equal(parseDefault({ value: "owner" }), "owner");

  assert.equal(seam.__rinOwnerStableJson(undefined), undefined);
  assert.equal(seam.__rinOwnerStableJson({ b: 2, a: 1 }), '{"b":2,"a":1}');
  assert.equal(seam.__rinOwnerStableJson({ value: 1n }), undefined);
  assert.equal(seam.__rinOwnerRpcRequestTag(null), "");
  assert.equal(seam.__rinOwnerRpcRequestTag(" owner "), " owner ");
  assert.equal(seam.__rinOwnerRpcRequestTag(7), "");
  assert.equal(seam.__rinOwnerWithCompactionEventMetadata(null, null), null);
  const ordinary = { type: "message" };
  assert.equal(
    seam.__rinOwnerWithCompactionEventMetadata(null, ordinary),
    ordinary,
  );
  const complete = { type: "compaction_end", tokensBefore: 7 };
  assert.equal(
    seam.__rinOwnerWithCompactionEventMetadata(null, complete),
    complete,
  );
  assert.deepEqual(
    seam.__rinOwnerWithCompactionEventMetadata(
      { entries: [] },
      { type: "compaction_end" },
    ),
    { type: "compaction_end" },
  );

  assert.deepEqual(seam.__rinOwnerGetSessionEntries(null), []);
  const entries = [{ id: "one" }, { id: "two" }];
  const session = {
    sessionManager: {
      getEntries: () => entries,
      getLeafId: () => undefined,
      getTree: () => "bad",
    },
  };
  assert.equal(seam.__rinOwnerGetSessionEntries(session), entries);
  assert.deepEqual(seam.__rinOwnerGetSessionEntriesSince(session, ""), {
    entries,
  });
  assert.deepEqual(seam.__rinOwnerGetSessionEntriesSince(session, "one"), {
    entries: [{ id: "two" }],
  });
  assert.deepEqual(seam.__rinOwnerGetSessionEntriesSince(session, "missing"), {
    error: "Unknown session entry cursor: missing",
  });
  assert.equal(seam.__rinOwnerGetSessionLeafId(session), null);
  assert.deepEqual(seam.__rinOwnerGetSessionTree(session), []);
  assert.deepEqual(
    seam.__rinOwnerGetSessionTree({
      sessionManager: { getTree: () => entries },
    }),
    entries,
  );
  const thinkingSession = (levels: string[]) => ({
    getAvailableThinkingLevels: () => levels,
  });
  assert.equal(
    seam.__rinOwnerClampSessionThinkingLevel(thinkingSession(["high"]), "high"),
    "high",
  );
  assert.equal(
    seam.__rinOwnerClampSessionThinkingLevel(thinkingSession([]), "medium"),
    "medium",
  );
  assert.equal(
    seam.__rinOwnerClampSessionThinkingLevel(
      thinkingSession(["low"]),
      "unknown",
    ),
    "low",
  );
  assert.equal(
    seam.__rinOwnerClampSessionThinkingLevel(thinkingSession(["high"]), "low"),
    "high",
  );
  assert.equal(
    seam.__rinOwnerClampSessionThinkingLevel(thinkingSession(["low"]), "high"),
    "low",
  );
  assert.equal(
    seam.__rinOwnerClampSessionThinkingLevel(
      thinkingSession(["alien"]),
      "medium",
    ),
    "alien",
  );
  assert.equal(
    seam.__rinOwnerClampSessionThinkingLevel({}, "medium"),
    "medium",
  );

  const first = new AbortController();
  const second = new AbortController();
  const combined = seam.__rinOwnerCombinedLoginPromptSignal(
    first.signal,
    second.signal,
  );
  assert.equal(combined.aborted, false);
  first.abort();
  assert.equal(combined.aborted, true);
  assert.equal(
    seam.__rinOwnerCombinedLoginPromptSignal(undefined, undefined),
    undefined,
  );
  assert.equal(
    seam.__rinOwnerCombinedLoginPromptSignal(undefined, second.signal),
    second.signal,
  );
  const duplicate = seam.__rinOwnerCombinedLoginPromptSignal(
    second.signal,
    second.signal,
  );
  assert.notEqual(duplicate, second.signal);
  assert.equal(duplicate.aborted, false);
  assert.equal(
    seam.__rinOwnerIsWorkerLocalSessionReplacementCommand(" /new "),
    true,
  );
  assert.equal(
    seam.__rinOwnerIsWorkerLocalSessionReplacementCommand("/resume old"),
    true,
  );
  assert.equal(
    seam.__rinOwnerIsWorkerLocalSessionReplacementCommand("/help"),
    false,
  );
});

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
  "rpc mode forwards user events without legacy append correlation",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines: string[] = [];
    let emitSessionEvent: ((event: any) => void) | undefined;

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
        subscribe: (handler) => {
          emitSessionEvent = handler;
          return () => {};
        },
        sessionManager: {
          ...testSessionManager(),
          getLeafId: () => "unused-global-leaf",
          appendMessage: (message) =>
            message.content[0].text === "first"
              ? "first-user-entry"
              : "second-user-entry",
        },
      };

      void runCustomRpcMode(session, {
        SessionManager: { listAll: async () => [], list: async () => [] },
      });
      await wait(0);
      assert.equal(typeof emitSessionEvent, "function");
      const firstMessage = {
        role: "user",
        content: [{ type: "text", text: "first" }],
      };
      const secondMessage = {
        role: "user",
        content: [{ type: "text", text: "second" }],
      };
      emitSessionEvent?.({ type: "message_start", message: firstMessage });
      emitSessionEvent?.({ type: "message_start", message: secondMessage });
      emitSessionEvent?.({ type: "message_end", message: secondMessage });
      session.sessionManager.appendMessage(secondMessage);
      emitSessionEvent?.({ type: "message_end", message: firstMessage });
      session.sessionManager.appendMessage(firstMessage);
      session.sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "untracked" }],
      });

      const events = lines.map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      });
      const starts = events.filter((line) => line?.type === "message_start");
      const persisted = events.filter(
        (line) => line?.type === "rin_user_message_persisted",
      );
      const firstStart = starts.find(
        (event) => event.message?.content?.[0]?.text === "first",
      );
      const secondStart = starts.find(
        (event) => event.message?.content?.[0]?.text === "second",
      );
      assert.deepEqual(persisted, []);
      assert.equal(firstStart?.userMessageId, undefined);
      assert.equal(secondStart?.userMessageId, undefined);
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode sleep_session terminalizes and disposes an active turn",
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
          ...testSessionManager(),
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
        Buffer.from(`${JSON.stringify({ id: "1", type: "sleep_session" })}\n`),
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
      const branch: any[] = [];
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
          branch.push({
            type: "message",
            id: "committed-final",
            parentId: null,
            message,
          });
          for (const subscriber of subscribers) {
            subscriber({ type: "message_end", message });
          }
          rejectPrompt?.(new Error("Request was aborted"));
        },
        dispose: () => {},
        sessionManager: {
          ...testSessionManager(() => branch.map((entry) => entry.message)),
          getBranch: () => branch,
          getLeafId: () => branch.at(-1)?.id ?? null,
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
          ...testSessionManager(),
          appendCustomEntry: (customType, data) => {
            calls.push(["appendCustomEntry", customType, data]);
          },
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
          const assistantMessage = {
            role: "assistant",
            timestamp: Date.now(),
            content: [{ type: "text", text: "final from rpc mode" }],
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
        sessionManager: {
          ...testSessionManager(() => session.messages || []),
          getBranch: () =>
            stateMessages.map((message, index) => ({
              id: `failure-entry-${index}`,
              parentId: index > 0 ? `failure-entry-${index - 1}` : null,
              type: "message",
              message,
            })),
          getLeafId: () =>
            stateMessages.length > 0
              ? `failure-entry-${stateMessages.length - 1}`
              : null,
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
          getBranch: () => durableEntries,
          getLeafId: () => durableEntries.at(-1)?.id ?? null,
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
          getBranch: () => durableEntries,
          getLeafId: () => durableEntries.at(-1)?.id ?? null,
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
  "rpc mode rejects nonempty branch fallback without a manager leaf api",
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
      const durableEntries = [
        {
          id: "older-entry",
          parentId: null,
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "old prompt" }],
          },
        },
        {
          id: "actual-baseline-leaf",
          parentId: "older-entry",
          type: "message",
          message: oldAssistant,
        },
      ];
      const session = {
        isStreaming: false,
        isCompacting: false,
        sessionFile: "/tmp/test-session.jsonl",
        sessionId: "session-1",
        agent: { waitForIdle: async () => {} },
        bindExtensions: async () => {},
        subscribe: () => () => {},
        prompt: async () => {
          const currentAssistant = {
            role: "assistant",
            content: [
              { type: "text", text: "must not recover from invalid baseline" },
            ],
          };
          session.messages = [oldAssistant, currentAssistant];
          durableEntries.push({
            id: "current-final-entry",
            parentId: "actual-baseline-leaf",
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
      assert.equal(error, undefined);
      const promptResponse = events.find(
        (event) => event.type === "response" && event.id === "1",
      );
      assert.equal(promptResponse, undefined);
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
  "rpc mode completes prompt turns from observed current assistant message_end",
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
  "rpc mode compares settlement branch leaf ids as opaque strings",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const sessionSubscribers = new Set();
    const durableEntries: any[] = [
      {
        id: " baseline-entry ",
        parentId: null,
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "previous prompt" }],
        },
      },
    ];
    let managerLeafId = " baseline-entry ";

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
          durableEntries.push({
            id: " unselected-final-entry ",
            parentId: " baseline-entry ",
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "not on the manager leaf" }],
            },
          });
          managerLeafId = "unselected-final-entry";
        },
        sendCustomMessage: async () => {},
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        modelRegistry: { getAvailable: async () => [] },
        sessionManager: {
          ...testSessionManager(() => session.messages || []),
          getBranch: () => durableEntries,
          getLeafId: () => managerLeafId,
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
  "rpc mode resolves final text from current assistant message_end instead of durable entries",
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
  "rpc mode resolves a first-turn branch final when prompt settles without message_end",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const durableEntries: any[] = [];
    const stateMessages: any[] = [];

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
            timestamp: Date.now(),
            content: [{ type: "text", text: "final from stored session" }],
          };
          stateMessages.push(assistantMessage);
          durableEntries.push({
            id: "stored-final-entry",
            parentId: null,
            type: "message",
            message: assistantMessage,
          });
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
      assert.equal(completion?.requestTag, "tag-1");
      assert.equal(completion?.finalText, "final from stored session");
      assert.deepEqual(completion?.result, {
        messages: [{ type: "text", text: "final from stored session" }],
      });
      assert.equal(error, undefined);
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
  "rpc mode prompt streamingBehavior keeps Pi prompt queue path during active-run non-streaming gaps",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const calls = [];
    const activeRunSignal = new AbortController().signal;
    const agentState = { isStreaming: false, activeRun: false };
    let resolveFirstPrompt: (() => void) | undefined;

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
        subscribe: () => () => {},
        async prompt(message, options) {
          void this.sessionId;
          calls.push(["prompt", message, options, this.isStreaming]);
          if (calls.length === 1) {
            agentState.activeRun = true;
            await new Promise<void>((resolve) => {
              resolveFirstPrompt = resolve;
            });
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
            streamingBehavior: "steer",
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
          false,
        ],
      ]);
      assert.equal(agentState.isStreaming, false);
      assert.ok(lines.join("").includes('"id":"queue-1"'));
      agentState.activeRun = false;
      resolveFirstPrompt?.();
      await wait(10);
    } finally {
      agentState.activeRun = false;
      resolveFirstPrompt?.();
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode prompt admission steers during tracked-turn signal gaps",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines = [];
    const calls = [];
    const activeRunSignal = new AbortController().signal;
    const agentState = { isStreaming: false, activeRun: false };
    let resolveFirstPrompt: (() => void) | undefined;

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
        subscribe: () => () => {},
        async prompt(message, options) {
          calls.push(["prompt", message, options, this.isStreaming]);
          if (calls.length === 1) {
            agentState.activeRun = true;
            await new Promise<void>((resolve) => {
              resolveFirstPrompt = resolve;
            });
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
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "queue-1", type: "prompt", message: "plain follow-in", requestTag: "tag-2" })}\n`,
        ),
      );
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
      resolveFirstPrompt?.();
      await wait(10);
    } finally {
      resolveFirstPrompt?.();
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode prompt admission trusts the Pi active run during an untracked recovery gap",
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
          if (!this.agent.signal || options?.streamingBehavior !== "steer") {
            throw new Error(
              "Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
            );
          }
          return {
            messages: [{ type: "text", text: "accepted recovery input" }],
          };
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
      const output = lines.join("");
      assert.match(output, /"acceptedAs":"prompt"/);
      assert.doesNotMatch(output, /"event":"error"/);
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc mode tracks a native queue request through one canonical turn",
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
          signal: new AbortController().signal,
          waitForIdle: async () => {
            waitForIdleCalls += 1;
          },
        },
        bindExtensions: async () => {},
        subscribe: () => {},
        prompt: async (message, options) => {
          calls.push([message, options]);
          return {
            messages: [{ type: "text", text: "queued through Pi" }],
          };
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
      const turnEvents = events.filter(
        (event) => event.type === "rpc_turn_event",
      );
      assert.match(lines.join(""), /"event":"start"/);
      assert.deepEqual(
        turnEvents.map((event) => event.event),
        ["complete"],
      );
      assert.equal(turnEvents[0]?.finalText, "queued through Pi");
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
      const circularPersistedMessage: any = { role: "assistant" };
      circularPersistedMessage.self = circularPersistedMessage;
      const persistedEntries: any[] = [
        {
          id: "persisted-assistant",
          parentId: null,
          type: "message",
          message: circularPersistedMessage,
        },
      ];
      const session = {
        isStreaming: false,
        isCompacting: false,
        sessionFile: "/tmp/test-session.jsonl",
        agent: {
          waitForIdle: async () => {},
          state: { messages: stateMessages },
        },
        _runAgentPrompt: async (messages: any[]) => {
          assert.deepEqual(messages, []);
          calls.push(["continue"]);
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
            const previous = persistedEntries.at(-1);
            persistedEntries.push({
              id: `persisted-${persistedEntries.length}`,
              parentId: previous?.id ?? null,
              type: "message",
              message,
            });
          },
          getEntries: () => persistedEntries,
          getBranch: () => persistedEntries,
          getTree: () => [],
          getLeafId: () => persistedEntries.at(-1)?.id ?? null,
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

      calls.length = 0;
      const alreadyPersisted = {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tool-2",
            name: "read",
            arguments: { path: "/owner" },
          },
        ],
      };
      stateMessages.splice(0, stateMessages.length, alreadyPersisted);
      session.sessionManager.getEntries = () => [
        { type: "custom" },
        { type: "message", message: alreadyPersisted },
      ];
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "3", type: "resume_interrupted_turn", requestTag: "tag-3" })}\n`,
        ),
      );
      await wait(10);
      assert.equal(calls.length, 2);
      assert.equal(calls[0][1].role, "toolResult");
      assert.deepEqual(calls[1], ["continue"]);
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
      const complete = events.find(
        (event) =>
          event.type === "rpc_turn_event" && event.event === "complete",
      );
      const error = events.find(
        (event) => event.type === "rpc_turn_event" && event.event === "error",
      );
      assert.equal(continued, false);
      assert.equal(complete, undefined);
      assert.equal(error, undefined);
      assert.match(lines.join(""), /"resumed":false/);
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
      const stateResponse = events.find(
        (event) => event.type === "response" && event.id === "3",
      );
      assert.equal(start, undefined);
      assert.equal(finished, undefined);
      assert.match(lines.join(""), /"resumed":false/);
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
  "rpc mode rejoins an active turn with the same durable request tag",
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
          `${JSON.stringify({ id: "turn-1", type: "prompt", message: "hello", requestTag: "chat-inbox-stable" })}\n`,
        ),
      );
      await wait(10);
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "rejoin-1", type: "prompt", message: "hello", requestTag: "chat-inbox-stable" })}\n`,
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
        .find((line) => line?.id === "rejoin-1");
      assert.equal(response?.data?.acceptedAs, "rejoin");
      assert.equal(response?.data?.requestTag, "chat-inbox-stable");
      assert.equal(calls.length, 1);

      releasePrompt();
      await wait(60);
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

const rpcModeOwner = (globalThis as any).__rpcModeOwner as {
  outputs: any[];
  overrides: Record<string, (...args: any[]) => any>;
};

async function createRpcModeOwnerHarness(
  customize: (input: {
    calls: any[];
    session: any;
    runtime: any;
  }) => void = () => {},
) {
  const stdinOn = process.stdin.on;
  const stdoutWrite = process.stdout.write;
  const handlers = new Map<string, (chunk: Buffer) => void>();
  const lines: string[] = [];
  const calls: any[] = [];
  const bindings: any[] = [];
  const subscribers = new Set<(event: any) => void>();
  rpcModeOwner.outputs = [];
  const entries = [
    {
      id: "entry-1",
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    },
    {
      id: "compact-1",
      type: "compaction",
      tokensBefore: 321,
      summary: "owner",
      firstKeptEntryId: "entry-1",
    },
  ];
  const models = [
    { provider: "owner", id: "model" },
    { provider: "other", id: "fallback" },
  ];
  const sessionManager = {
    getEntries: () => entries,
    getTree: () => [{ entry: entries[0], children: [] }],
    getLeafId: () => "compact-1",
    getBranch: () => entries,
    getCwd: () => "/owner/cwd",
    appendMessage(message: any) {
      calls.push(["appendMessage", message]);
      return message?.role === "user" ? "owner-user-entry" : "owner-entry";
    },
    appendThinkingLevelChange: (level: string) =>
      calls.push(["appendThinkingLevelChange", level]),
    appendModelChange: (provider: string, id: string) =>
      calls.push(["appendModelChange", provider, id]),
    appendLabelChange: (entryId: string, label: string | undefined) => (
      calls.push(["appendLabelChange", entryId, label]),
      { entryId, label }
    ),
    appendCustomEntry: (customType: string, data: any) =>
      calls.push(["appendCustomEntry", customType, data]),
  };
  const authStorage = {
    login: async () => {},
    set: (providerId: string, value: any) =>
      calls.push(["auth.set", providerId, value]),
    logout: (providerId: string) => calls.push(["auth.logout", providerId]),
  };
  const session: any = {
    isStreaming: false,
    isCompacting: false,
    isRetrying: false,
    retryAttempt: 0,
    sessionFile: "/owner/session.jsonl",
    sessionId: "owner-session",
    entries,
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "owner final" }],
        stopReason: "stop",
      },
    ],
    thinkingLevel: "medium",
    agent: {
      state: { messages: [], thinkingLevel: "medium", model: models[0] },
      waitForIdle: async () => calls.push(["waitForIdle"]),
      continue: async () => ({
        role: "assistant",
        content: [{ type: "text", text: "continued" }],
      }),
    },
    sessionManager,
    modelRegistry: {
      getAll: () => models,
      getAvailable: async () => models,
      hasConfiguredAuth: () => true,
      authStorage,
      refresh: () => calls.push(["modelRegistry.refresh"]),
    },
    extensionRunner: {
      getCommand: (name: string) => (name === "owner" ? { name } : undefined),
    },
    bindExtensions: async (options: any) => {
      bindings.push(options);
      calls.push(["bindExtensions", options.mode]);
    },
    subscribe(handler: (event: any) => void) {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
        calls.push(["unsubscribe"]);
      };
    },
    prompt: async (message: string, options?: any) => (
      calls.push(["prompt", message, options]),
      undefined
    ),
    sendUserMessage: async (content: any, options?: any) => (
      calls.push(["sendUserMessage", content, options]),
      {
        role: "assistant",
        content: [{ type: "text", text: "sent final" }],
      }
    ),
    sendCustomMessage: async (message: any, options?: any) =>
      calls.push(["sendCustomMessage", message, options]),
    steer: async (...args: any[]) => (
      calls.push(["steer", ...args]),
      "steered"
    ),
    followUp: async (...args: any[]) => (
      calls.push(["followUp", ...args]),
      "followed"
    ),
    clearQueue: () => (calls.push(["clearQueue"]), { cleared: true }),
    abortCompaction: () => calls.push(["abortCompaction"]),
    abort: async () => calls.push(["abort"]),
    dispose: () => calls.push(["session.dispose"]),
    cycleModel: () => (calls.push(["cycleModel"]), models[1]),
    setModel: async (model: any) => {
      calls.push(["setModel", model]);
      session.agent.state.model = model;
    },
    setThinkingLevel: (level: string) => {
      calls.push(["setThinkingLevel", level]);
      session.thinkingLevel = level;
      session.agent.state.thinkingLevel = level;
      return { level };
    },
    getAvailableThinkingLevels: () => ["low", "high"],
    cycleThinkingLevel: () => (calls.push(["cycleThinkingLevel"]), "high"),
    setSteeringMode: (mode: string) => calls.push(["setSteeringMode", mode]),
    setFollowUpMode: (mode: string) => calls.push(["setFollowUpMode", mode]),
    compact: async (instructions: string) => (
      calls.push(["compact", instructions]),
      { compacted: true }
    ),
    setAutoCompactionEnabled: (enabled: boolean) =>
      calls.push(["setAutoCompactionEnabled", enabled]),
    setAutoRetryEnabled: (enabled: boolean) =>
      calls.push(["setAutoRetryEnabled", enabled]),
    abortRetry: () => calls.push(["abortRetry"]),
    executeBash: async (...args: any[]) => (
      calls.push(["executeBash", ...args]),
      { output: "owner" }
    ),
    abortBash: async () => calls.push(["abortBash"]),
    getSessionStats: () => ({ turns: 2 }),
    navigateTree: async (targetId: string, options: any) => (
      calls.push(["navigateTree", targetId, options]),
      { cancelled: false }
    ),
    exportToHtml: async (outputPath: string) => `${outputPath}.html`,
    exportToJsonl: (outputPath: string) => `${outputPath}.jsonl`,
    getUserMessagesForForking: () => ["hello"],
    getLastAssistantText: () => "owner final",
    getActiveToolNames: () => ["read"],
    getAllTools: () => ["read", "bash"],
    setActiveToolsByName: (names: string[]) =>
      calls.push(["setActiveToolsByName", names]),
    reload: async () => calls.push(["reload"]),
    setSessionName: (name: string) => calls.push(["setSessionName", name]),
  };
  const runtime: any = {
    session,
    cwd: "/owner/runtime-cwd",
    services: { agentDir: "/owner/agent" },
    fork: async (entryId: string, options?: any) => (
      calls.push(["runtime.fork", entryId, options]),
      {
        selectedText: "forked",
        cancelled: false,
      }
    ),
    importFromJsonl: async (inputPath: string) => (
      calls.push(["runtime.importFromJsonl", inputPath]),
      {
        cancelled: false,
      }
    ),
    dispose: async () => calls.push(["runtime.dispose"]),
  };
  customize({ calls, session, runtime });
  process.stdin.on = function (event: string, handler: any) {
    handlers.set(event, handler);
    return this;
  } as any;
  process.stdout.write = function (chunk: any) {
    lines.push(String(chunk));
    return true;
  } as any;
  void runCustomRpcMode(runtime, { SessionManager: { owner: true } });
  await wait(0);

  const payloads = () => [...rpcModeOwner.outputs];
  const sendRaw = async (text: string) => {
    const handler = handlers.get("data");
    assert.equal(typeof handler, "function");
    handler?.(Buffer.from(text));
    await wait(8);
  };
  const send = async (...commands: any[]) =>
    sendRaw(
      `${commands.map((command) => JSON.stringify(command)).join("\n")}\n`,
    );
  return {
    session,
    runtime,
    calls,
    bindings,
    payloads,
    send,
    sendRaw,
    emit(event: any) {
      for (const subscriber of subscribers) subscriber(event);
    },
    restore() {
      rpcModeOwner.overrides = {};
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    },
  };
}

test(
  "rpc mode directly integrates the complete request and session command lifecycle",
  { concurrency: false },
  async () => {
    rpcModeOwner.overrides = {
      getSessionState: (_session, options) => ({
        ownerState: true,
        ...options,
      }),
      getOAuthState: () => ({ providers: ["owner"] }),
      getResourceDiagnostics: () => ({ resources: "owner" }),
      getCommandArgumentCompletions: (_session, name, prefix) => [name, prefix],
      getSlashCommands: () => [{ name: "owner" }],
      runBuiltinCommand: async (_runtime, commandLine) => ({
        handled: commandLine === "/builtin",
        commandLine,
      }),
      listBoundSessionPage: async (options) => ({ sessions: [], ...options }),
      listBoundSessions: async () => [{ sessionId: "listed" }],
      renameBoundSession: async (_command, name) => {
        if (name === "bad") throw new Error("rename rejected");
      },
      refreshPiSessionToolRegistry: (session) =>
        session.setActiveToolsByName(["refreshed"]),
    };
    const harness = await createRpcModeOwnerHarness();
    try {
      await harness.sendRaw("{not-json}\n");
      const commands = [
        ["ui-unknown", "extension_ui_response"],
        ["steer", "steer", { message: "s", images: ["i"] }],
        ["follow", "follow_up", { message: "f", images: [] }],
        ["clear", "clear_queue"],
        ["abort", "abort"],
        ["attach", "attach_session"],
        ["state", "get_state"],
        ["cycle-model", "cycle_model"],
        ["all-models", "get_all_models"],
        ["available-models", "get_available_models"],
        ["oauth-state", "get_oauth_state"],
        ["diagnostics", "get_resource_diagnostics"],
        [
          "completions",
          "get_command_argument_completions",
          { commandName: " owner ", argumentPrefix: "x" },
        ],
        [
          "thinking-transient",
          "set_thinking_level",
          { level: "medium", persistSettings: false },
        ],
        ["thinking-cycle", "cycle_thinking_level"],
        ["steering-mode", "set_steering_mode", { mode: "all" }],
        ["follow-mode", "set_follow_up_mode", { mode: "all" }],
        ["compact", "compact", { customInstructions: "owner" }],
        ["auto-compact", "set_auto_compaction", { enabled: 1 }],
        ["auto-retry", "set_auto_retry", { enabled: 0 }],
        ["abort-retry", "abort_retry"],
        ["bash", "bash", { command: "printf owner", excludeFromContext: true }],
        ["abort-bash", "abort_bash"],
        ["stats", "get_session_stats"],
        ["snapshot", "get_session_snapshot"],
        ["entries", "get_entries"],
        ["tree", "get_tree"],
        ["label", "set_entry_label", { entryId: "entry-1", label: " " }],
        ["navigate", "navigate_tree", { targetId: "entry-1" }],
        ["html", "export_html", { outputPath: "/owner/out" }],
        ["jsonl", "export_jsonl", { outputPath: "/owner/out" }],
        ["import", "import_jsonl", { inputPath: "/owner/in.jsonl" }],
        ["fork-messages", "get_fork_messages"],
        ["last-text", "get_last_assistant_text"],
        ["messages", "get_messages"],
        ["resolved", "resolve_submitted_turn", { text: "hello", sentAt: 0 }],
        ["active-tools", "get_active_tools"],
        ["all-tools", "get_all_tools"],
        ["set-tools", "set_active_tools", { toolNames: [" read ", "", 3] }],
        ["set-tools-fallback", "set_active_tools", { toolNames: null }],
        ["refresh-tools", "refresh_tools"],
        ["custom", "append_custom_entry", { customType: " owner ", data: 1 }],
        ["custom-error", "append_custom_entry", { customType: " " }],
        ["custom-message", "send_custom_message", { message: { owner: true } }],
        ["commands", "get_commands"],
        ["builtin", "run_command", { commandLine: "/builtin" }],
        ["extension", "run_command", { commandLine: "/owner value" }],
        ["unhandled", "run_command", { commandLine: "plain" }],
        ["fork", "fork", { entryId: "entry-1" }],
        ["list", "list_sessions"],
        ["page", "list_sessions", { limit: 2, offset: 1 }],
        ["set-model", "set_model", { provider: "owner", modelId: "model" }],
        [
          "missing-model",
          "set_model",
          { provider: "none", modelId: "missing" },
        ],
        ["rename", "rename_session", { name: "owner" }],
        ["rename-error", "rename_session", { name: "bad" }],
        ["name", "set_session_name", { name: " owner " }],
        ["name-error", "set_session_name", { name: " " }],
        [
          "api-provider-error",
          "oauth_set_api_key",
          { providerId: "", key: "x" },
        ],
        [
          "api-key-error",
          "oauth_set_api_key",
          { providerId: "owner", key: "" },
        ],
        [
          "api-key",
          "oauth_set_api_key",
          { providerId: "owner", key: "secret" },
        ],
        ["logout-error", "oauth_logout", { providerId: "" }],
        ["logout", "oauth_logout", { providerId: "owner" }],
        ["unknown", "owner_unknown"],
      ].map(([id, type, fields = {}]) => ({ id, type, ...(fields as object) }));
      await harness.send(...commands);
      await wait(30);

      const submittedAt = Date.now();
      harness.session.messages = [
        {
          role: "user",
          timestamp: submittedAt,
          content: [{ type: "text", text: "submitted owner" }],
        },
        {
          role: "assistant",
          timestamp: submittedAt + 1,
          content: [{ type: "text", text: "resolved owner" }],
          stopReason: "stop",
        },
      ];
      await harness.send({
        id: "resolved-final",
        type: "resolve_submitted_turn",
        text: "submitted owner",
        sentAt: submittedAt,
      });

      await harness.send(
        {
          id: "thinking-known",
          type: "set_thinking_level",
          level: "high",
          persistSettings: false,
        },
        {
          id: "thinking-unknown",
          type: "set_thinking_level",
          level: "unknown",
          persistSettings: false,
        },
        {
          id: "thinking-down",
          type: "set_thinking_level",
          level: "max",
          persistSettings: false,
        },
        {
          id: "thinking-empty",
          type: "set_thinking_level",
          level: "",
          persistSettings: false,
        },
      );
      const activeTools = harness.session.getActiveToolNames;
      const allTools = harness.session.getAllTools;
      const setActiveTools = harness.session.setActiveToolsByName;
      harness.session.getActiveToolNames = undefined;
      harness.session.getAllTools = undefined;
      harness.session.setActiveToolsByName = undefined;
      await harness.send(
        { id: "active-tools-empty", type: "get_active_tools" },
        { id: "all-tools-empty", type: "get_all_tools" },
        {
          id: "set-tools-empty",
          type: "set_active_tools",
          toolNames: ["owner"],
        },
      );
      harness.session.getActiveToolNames = activeTools;
      harness.session.getAllTools = allTools;
      harness.session.setActiveToolsByName = setActiveTools;

      const entries = harness.session.entries;
      harness.session.entries = undefined;
      await harness.send({
        id: "compact-empty",
        type: "compact",
        customInstructions: "empty",
      });
      harness.session.entries = entries;

      const getEntries = harness.session.sessionManager.getEntries;
      const getTree = harness.session.sessionManager.getTree;
      const getLeafId = harness.session.sessionManager.getLeafId;
      harness.session.sessionManager.getEntries = () => null;
      harness.session.sessionManager.getTree = () => null;
      harness.session.sessionManager.getLeafId = undefined;
      await harness.send(
        { id: "snapshot-empty", type: "get_session_snapshot" },
        { id: "entries-empty", type: "get_entries" },
        { id: "tree-empty", type: "get_tree" },
      );
      harness.session.sessionManager.getEntries = getEntries;
      harness.session.sessionManager.getTree = getTree;
      harness.session.sessionManager.getLeafId = getLeafId;

      const prompt = harness.session.prompt;
      harness.session.prompt = undefined;
      await harness.send({
        id: "prompt-missing-handler",
        type: "prompt",
        message: "owner prompt without handler",
        requestTag: 42,
      });
      await wait(0);
      harness.session.prompt = prompt;

      const byId = new Map(
        harness
          .payloads()
          .filter((payload) => payload.type === "response")
          .map((payload) => [payload.id, payload]),
      );
      for (const id of [
        "steer",
        "abort",
        "attach",
        "compact",
        "import",
        "fork",
        "list",
        "page",
        "set-model",
        "rename",
        "name",
        "api-key",
        "logout",
      ]) {
        assert.equal(byId.get(id)?.success, true, id);
      }
      for (const id of [
        "custom-error",
        "missing-model",
        "rename-error",
        "name-error",
        "api-provider-error",
        "api-key-error",
        "logout-error",
        "unknown",
      ]) {
        assert.equal(byId.get(id)?.success, false, id);
      }
      assert.ok(
        harness
          .payloads()
          .some(
            (payload) =>
              payload.type === "response" &&
              payload.command === "parse" &&
              payload.success === false,
          ),
      );
      assert.equal(byId.get("attach")?.data.ownerState, true);
      assert.equal(
        byId.get("resolved-final")?.data.finalText,
        "resolved owner",
      );
      assert.equal(byId.get("compact")?.data.tokensBefore, 321);
      assert.deepEqual(byId.get("html")?.data, { path: "/owner/out.html" });
      assert.equal(harness.bindings.length, 3);
      assert.ok(harness.calls.some((call) => call[0] === "abortCompaction"));
    } finally {
      harness.restore();
    }
  },
);

test(
  "rpc mode directly bridges extension UI actions, rebinding, and event metadata",
  { concurrency: false },
  async () => {
    const harness = await createRpcModeOwnerHarness();
    try {
      const binding = harness.bindings[0];
      const ui = binding.uiContext;
      const aborted = new AbortController();
      aborted.abort();
      assert.equal(
        await ui.confirm("aborted", "message", { signal: aborted.signal }),
        false,
      );

      for (const [method, args, response, expected] of [
        ["select", ["select", ["a", "b"]], { value: "b" }, "b"],
        ["confirm", ["confirm", "message"], { confirmed: 1 }, true],
        ["input", ["input", "placeholder"], { cancelled: true }, undefined],
      ] as any[]) {
        const pending = ui[method](...args);
        await wait(0);
        const request = harness
          .payloads()
          .find((payload) => payload.method === method);
        assert.ok(request, JSON.stringify(harness.payloads()));
        await harness.send({
          type: "extension_ui_response",
          id: request.id,
          ...response,
        });
        assert.equal(await pending, expected);
      }
      const defaulted = ui.select("default", ["a"]);
      await wait(0);
      const defaultRequest = harness
        .payloads()
        .find(
          (payload) =>
            payload.method === "select" && payload.title === "default",
        );
      await harness.send({
        type: "extension_ui_response",
        id: defaultRequest.id,
      });
      assert.equal(await defaulted, undefined);
      await harness.send({ type: "extension_ui_response" });

      const controller = new AbortController();
      const edited = ui.editor("editor", "prefill", {
        signal: controller.signal,
        timeout: 100,
      });
      controller.abort();
      assert.equal(await edited, undefined);
      assert.equal(await ui.input("timeout", "", { timeout: 1 }), undefined);

      ui.notify("notice", "info");
      ui.onTerminalInput()();
      ui.setStatus("owner", "ready");
      ui.setWorkingMessage("working");
      ui.setWorkingVisible(true);
      ui.setWorkingIndicator({ text: "owner" });
      ui.setHiddenThinkingLabel("thinking");
      ui.setWidget("bad", "not-lines");
      ui.setWidget("owner", ["line"], { placement: "above" });
      ui.setFooter(() => {});
      ui.setFooter();
      ui.setHeader(() => {});
      ui.setHeader();
      ui.setTitle("Owner title");
      assert.equal(await ui.custom(), undefined);
      ui.pasteToEditor("paste");
      ui.setEditorText("set");
      assert.equal(ui.getEditorText(), "");
      ui.addAutocompleteProvider();
      ui.setEditorComponent();
      assert.deepEqual(ui.getAllThemes(), []);
      assert.equal(ui.getTheme(), undefined);
      assert.equal(ui.setTheme("owner").success, false);
      assert.equal(ui.getToolsExpanded(), false);
      ui.setToolsExpanded(true);

      assert.equal(
        (await binding.commandContextActions.newSession()).cancelled,
        true,
      );
      assert.equal(
        (await binding.commandContextActions.switchSession()).cancelled,
        true,
      );
      await binding.commandContextActions.waitForIdle();
      assert.equal(
        (await binding.commandContextActions.fork("entry-1", { owner: true }))
          .cancelled,
        false,
      );
      assert.equal(
        (
          await harness.bindings
            .at(-1)
            .commandContextActions.navigateTree("entry-1", {
              summarize: true,
              customInstructions: "owner",
              replaceInstructions: true,
              label: "label",
            })
        ).cancelled,
        false,
      );
      await harness.bindings.at(-1).commandContextActions.reload();
      harness.bindings.at(-1).onError({
        extensionPath: "/owner/extension.ts",
        event: "owner-event",
        error: "owner-error",
      });

      const userMessage = {
        role: "user",
        content: [{ type: "text", text: "event owner" }],
      };
      harness.emit({ type: "auto_retry_start" });
      harness.emit({
        type: "auto_retry_end",
        success: false,
        attempt: 2,
        finalError: "failed",
      });
      harness.emit({ type: "auto_retry_end", success: true, attempt: 2 });
      harness.emit({ type: "message_start", message: userMessage });
      harness.session.sessionManager.appendMessage(userMessage);
      harness.emit({ type: "compaction_end", aborted: false });
      harness.emit({
        type: "compaction_end",
        aborted: false,
        tokensBefore: 123,
      });
      const entries = harness.session.entries;
      harness.session.entries = [];
      harness.emit({ type: "compaction_end", aborted: false });
      harness.session.entries = entries;
      harness.emit("owner-non-event");
      harness.emit(null);

      const payloads = harness.payloads();
      assert.ok(payloads.some((payload) => payload?.method === "setFooter"));
      assert.ok(
        payloads.some((payload) => payload?.type === "extension_error"),
      );
      assert.ok(
        payloads.some(
          (payload) =>
            payload?.type === "compaction_end" && payload.tokensBefore === 321,
        ),
      );
      assert.ok(payloads.some((payload) => payload?.type === "message_start"));
      assert.equal(
        payloads.some(
          (payload) => payload?.type === "rin_user_message_persisted",
        ),
        false,
      );
      assert.ok(harness.calls.some((call) => call[0] === "unsubscribe"));
    } finally {
      harness.restore();
    }
  },
);

test(
  "rpc mode directly owns OAuth login prompts, cancellation, and failures",
  { concurrency: false },
  async () => {
    rpcModeOwner.overrides = { getOAuthState: () => ({ authenticated: true }) };
    const harness = await createRpcModeOwnerHarness(({ session }) => {
      session.modelRegistry.authStorage.login = async (
        _providerId,
        options,
      ) => {
        options.onAuth({
          url: "https://owner.invalid/auth",
          instructions: "owner",
        });
        options.onDeviceCode({
          userCode: "CODE",
          verificationUri: "https://owner.invalid/device",
          intervalSeconds: 1,
          expiresInSeconds: 60,
        });
        options.onProgress("progress");
        const prompt = await options.onPrompt({
          message: "prompt",
          placeholder: "value",
          allowEmpty: false,
        });
        const selected = await options.onSelect({
          message: "select",
          options: [{ id: "one", label: "One" }],
        });
        const manual = await options.onManualCodeInput({
          message: "manual",
          placeholder: "code",
        });
        assert.deepEqual([prompt, selected, manual], ["p", "s", "m"]);
      };
    });
    try {
      await harness.send({
        id: "missing-provider",
        type: "oauth_login_start",
        providerId: "",
      });
      await harness.send({
        id: "start",
        type: "oauth_login_start",
        providerId: "owner",
      });
      const start = harness
        .payloads()
        .find(
          (payload) => payload.id === "start" && payload.type === "response",
        );
      const loginId = start.data.loginId;
      for (const [event, value] of [
        ["prompt", "p"],
        ["select", "s"],
        ["manual_code", "m"],
      ]) {
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const request = harness
            .payloads()
            .find(
              (payload) =>
                payload.type === "oauth_login_event" &&
                payload.loginId === loginId &&
                payload.event === event,
            );
          if (request) {
            await harness.send({
              id: `respond-${event}`,
              type: "oauth_login_respond",
              loginId,
              requestId: request.requestId,
              value,
            });
            break;
          }
          await wait(2);
        }
      }
      await wait(20);
      assert.ok(
        harness
          .payloads()
          .some(
            (payload) =>
              payload.type === "oauth_login_event" &&
              payload.loginId === loginId &&
              payload.event === "complete" &&
              payload.success === true,
          ),
        JSON.stringify(harness.payloads().slice(-20)),
      );
      await harness.send({
        id: "late-response",
        type: "oauth_login_respond",
        loginId,
        requestId: "missing",
      });
      assert.equal(
        harness.payloads().find((payload) => payload.id === "late-response")
          ?.success,
        false,
      );

      harness.session.modelRegistry.authStorage.login = async () => {
        throw new Error("login rejected");
      };
      await harness.send({
        id: "failed",
        type: "oauth_login_start",
        providerId: "owner",
      });
      await wait(10);
      assert.ok(
        harness
          .payloads()
          .some(
            (payload) =>
              payload.type === "oauth_login_event" &&
              payload.event === "complete" &&
              payload.success === false &&
              /login rejected/.test(payload.error),
          ),
      );

      harness.session.modelRegistry.authStorage.login = async (
        _providerId,
        options,
      ) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () =>
            reject(new Error("cancelled")),
          );
        });
      await harness.send({
        id: "cancel-start",
        type: "oauth_login_start",
        providerId: "owner",
      });
      const cancelStart = harness
        .payloads()
        .find(
          (payload) =>
            payload.id === "cancel-start" && payload.type === "response",
        );
      await harness.send({
        id: "cancel",
        type: "oauth_login_cancel",
        loginId: cancelStart.data.loginId,
      });
      await harness.send({
        id: "cancel-missing",
        type: "oauth_login_cancel",
        loginId: "missing",
      });
      assert.equal(
        harness.payloads().find((payload) => payload.id === "cancel")?.success,
        true,
      );
      assert.equal(
        harness.payloads().find((payload) => payload.id === "cancel-missing")
          ?.success,
        false,
      );
    } finally {
      harness.restore();
    }
  },
);

test("rpc mode owner directly covers response parsing and outcome normalization branches", async () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const rootDir = process.env.RIN_REPO_ROOT;
    const mod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "rin-daemon", "rpc-mode.js")).href);
    const parse = mod.__rinOwnerCreateExtensionUiResponseParser("fallback");
    assert.equal(parse(null), "fallback");
    assert.equal(parse({}), "fallback");
    assert.equal(parse({ cancelled: false }), "fallback");
    assert.equal(parse({ cancelled: true, value: "ignored" }), "fallback");
    assert.equal(parse({ confirmed: 0 }), false);
    assert.equal(parse({ confirmed: 1 }), true);
    assert.equal(parse({ value: 0 }), 0);
    assert.equal(mod.__rinOwnerStableJson({ owner: true }), '{"owner":true}');
    const cyclic = {};
    cyclic.owner = cyclic;
    assert.equal(mod.__rinOwnerStableJson(cyclic), undefined);
    assert.equal(mod.__rinOwnerRpcRequestTag(7), "");
    assert.equal(mod.__rinOwnerRpcRequestTag("   "), "   ");
    assert.equal(mod.__rinOwnerRpcRequestTag("owner"), "owner");
    assert.deepEqual(
      mod.__rinOwnerNativeInputOutcome(
        { sessionFile: "/owner.jsonl", sessionId: "owner", isStreaming: 1 },
        "accepted",
        "owner-tag",
        { originalOutcome: "queued", turnActive: true },
      ),
      {
        outcome: "accepted",
        originalOutcome: "queued",
        requestTag: "owner-tag",
        sessionFile: "/owner.jsonl",
        sessionId: "owner",
        turnActive: true,
        isStreaming: true,
      },
    );
    assert.deepEqual(
      mod.__rinOwnerNativeInputOutcome(undefined, "indeterminate", 7, {
        turnActive: false,
      }),
      {
        outcome: "indeterminate",
        sessionFile: undefined,
        sessionId: undefined,
        turnActive: false,
        isStreaming: false,
      },
    );
    assert.equal(mod.__rinOwnerLatestCompactionTokensBefore(undefined), undefined);
    assert.equal(mod.__rinOwnerLatestCompactionTokensBefore({ entries: "bad" }), undefined);
    assert.equal(mod.__rinOwnerWithCompactionEventMetadata({}, null), null);
    assert.equal(mod.__rinOwnerWithCompactionEventMetadata({}, "event"), "event");
    assert.deepEqual(
      mod.__rinOwnerWithCompactionEventMetadata({ entries: [] }, { type: "owner" }),
      { type: "owner" },
    );
    assert.deepEqual(
      mod.__rinOwnerWithCompactionEventMetadata(
        { entries: [] },
        { type: "compaction_end", tokensBefore: 1 },
      ),
      { type: "compaction_end", tokensBefore: 1 },
    );
    assert.deepEqual(
      mod.__rinOwnerWithCompactionEventMetadata(
        { entries: [] },
        { type: "compaction_end" },
      ),
      { type: "compaction_end" },
    );
    assert.deepEqual(
      mod.__rinOwnerWithCompactionEventMetadata(
        { entries: [{ id: "compact", type: "compaction", tokensBefore: 321 }] },
        { type: "compaction_end" },
      ),
      { type: "compaction_end", tokensBefore: 321 },
    );
    assert.deepEqual(mod.__rinOwnerGetSessionEntries({ entries: [1] }), []);
    assert.deepEqual(
      mod.__rinOwnerGetSessionEntries({ sessionManager: { getEntries: () => [2] } }),
      [2],
    );
    assert.deepEqual(mod.__rinOwnerGetSessionEntries({}), []);
    assert.deepEqual(mod.__rinOwnerGetSessionEntries({ sessionManager: {} }), []);
    const entrySession = {
      sessionManager: { getEntries: () => [{ id: "one" }, { id: "two" }] },
    };
    assert.deepEqual(mod.__rinOwnerGetSessionEntriesSince(entrySession, ""), {
      entries: [{ id: "one" }, { id: "two" }],
    });
    assert.deepEqual(mod.__rinOwnerGetSessionEntriesSince(entrySession, "missing"), {
      error: "Unknown session entry cursor: missing",
    });
    assert.deepEqual(mod.__rinOwnerGetSessionEntriesSince(entrySession, "one"), {
      entries: [{ id: "two" }],
    });
    assert.deepEqual(
      mod.__rinOwnerGetSessionEntries({ sessionManager: { getEntries: () => "bad" } }),
      [],
    );
    assert.deepEqual(mod.__rinOwnerGetSessionTree({ tree: [1] }), []);
    assert.deepEqual(
      mod.__rinOwnerGetSessionTree({ sessionManager: { getTree: () => [2] } }),
      [2],
    );
    assert.deepEqual(mod.__rinOwnerGetSessionTree({}), []);
    assert.deepEqual(mod.__rinOwnerGetSessionTree({ sessionManager: {} }), []);
    assert.deepEqual(
      mod.__rinOwnerGetSessionTree({ sessionManager: { getTree: () => "bad" } }),
      [],
    );
    assert.equal(mod.__rinOwnerGetSessionLeafId({ leafId: "one" }), null);
    assert.equal(
      mod.__rinOwnerGetSessionLeafId({ sessionManager: { getLeafId: () => "two" } }),
      "two",
    );
    assert.equal(
      mod.__rinOwnerGetSessionLeafId({ entries: [{ id: "three" }] }),
      null,
    );
    assert.equal(mod.__rinOwnerGetSessionLeafId({ sessionManager: {} }), null);
    assert.equal(
      mod.__rinOwnerGetSessionLeafId({ sessionManager: { getLeafId: () => undefined } }),
      null,
    );
    const withEntries = (entries) => ({
      sessionManager: { getEntries: () => entries },
    });
    const validIdentityEntries = [
      { id: "user-one", type: "message", message: { role: "user" } },
      {
        id: "identity-one",
        type: "custom",
        customType: "rin_request_identity",
        data: {
          requestId: "owner-request",
          messageEntryId: "user-one",
          observedRole: "terminalOwner",
        },
      },
    ];
    assert.equal(mod.__rinOwnerPersistedNativeIdentityOutcome(withEntries([]), ""), undefined);
    assert.equal(
      mod.__rinOwnerPersistedNativeIdentityOutcome(
        withEntries(validIdentityEntries),
        "owner-request",
      ),
      "terminalOwner",
    );
    assert.equal(
      mod.__rinOwnerPersistedNativeIdentityOutcome(
        withEntries([
          ...validIdentityEntries,
          { ...validIdentityEntries[1], id: "identity-two" },
        ]),
        "owner-request",
      ),
      undefined,
    );
    const rejectedEntries = [
      {
        type: "custom",
        customType: "rin_request_outcome",
        data: { requestId: "owner-rejected", outcome: "rejected" },
      },
    ];
    assert.equal(
      mod.__rinOwnerPersistedNativeRequestOutcome(
        withEntries(rejectedEntries),
        "owner-rejected",
      ),
      "rejected",
    );
    assert.equal(
      mod.__rinOwnerNativeRequestReceiptState(withEntries([]), "missing"),
      "missing",
    );
    assert.equal(
      mod.__rinOwnerNativeRequestReceiptState(
        withEntries(rejectedEntries),
        "owner-rejected",
      ),
      "valid",
    );
    assert.equal(
      mod.__rinOwnerNativeRequestReceiptState(
        withEntries([...validIdentityEntries, ...rejectedEntries.map((entry) => ({ ...entry, data: { ...entry.data, requestId: "owner-request" } }))]),
        "owner-request",
      ),
      "conflict",
    );
  `;
  await execFileAsync(
    process.execPath,
    [
      "--import",
      path.join(
        rootDir,
        "tests",
        "support",
        "register-rpc-mode-private-owner-fixture.mjs",
      ),
      "--input-type=module",
      "-e",
      script,
    ],
    {
      cwd: rootDir,
      env: { ...process.env, RIN_REPO_ROOT: rootDir },
      timeout: 10_000,
    },
  );
});

test("rpc mode owner fixture private helpers execute in the owner process", () => {
  const mod = rpcModeModule as Record<string, (...args: any[]) => any>;
  const parse = mod.__rinOwnerCreateExtensionUiResponseParser("fallback");
  assert.equal(parse(null), "fallback");
  assert.equal(parse({}), "fallback");
  assert.equal(parse({ cancelled: true }), "fallback");
  assert.equal(parse({ confirmed: false }), false);
  assert.equal(parse({ confirmed: true }), true);
  assert.equal(parse({ value: 0 }), 0);
  assert.equal(mod.__rinOwnerRpcRequestTag(1), "");
  assert.equal(mod.__rinOwnerRpcRequestTag("owner"), "owner");
  assert.deepEqual(mod.__rinOwnerGetSessionEntries({}), []);
  assert.deepEqual(
    mod.__rinOwnerGetSessionEntries({
      sessionManager: { getEntries: () => [1] },
    }),
    [1],
  );
  assert.deepEqual(
    mod.__rinOwnerGetSessionEntries({
      sessionManager: { getEntries: () => "bad" },
    }),
    [],
  );
  assert.deepEqual(mod.__rinOwnerGetSessionTree({}), []);
  assert.deepEqual(
    mod.__rinOwnerGetSessionTree({ sessionManager: { getTree: () => [1] } }),
    [1],
  );
  assert.equal(mod.__rinOwnerGetSessionLeafId({}), null);
  assert.equal(
    mod.__rinOwnerGetSessionLeafId({
      sessionManager: { getLeafId: () => "leaf" },
    }),
    "leaf",
  );
  assert.equal(mod.__rinOwnerClampSessionThinkingLevel({}, "off"), "off");
  assert.equal(
    mod.__rinOwnerClampSessionThinkingLevel(
      { getAvailableThinkingLevels: () => ["high", "low"] },
      "high",
    ),
    "high",
  );
  assert.equal(
    mod.__rinOwnerClampSessionThinkingLevel(
      { getAvailableThinkingLevels: () => ["low"] },
      "invalid",
    ),
    "low",
  );
  assert.equal(
    mod.__rinOwnerIsWorkerLocalSessionReplacementCommand("/new"),
    true,
  );
  assert.equal(
    mod.__rinOwnerIsWorkerLocalSessionReplacementCommand("/resume owner"),
    true,
  );
  assert.equal(
    mod.__rinOwnerIsWorkerLocalSessionReplacementCommand("/resume   "),
    false,
  );
  assert.equal(
    mod.__rinOwnerIsWorkerLocalSessionReplacementCommand("/status"),
    false,
  );
});
