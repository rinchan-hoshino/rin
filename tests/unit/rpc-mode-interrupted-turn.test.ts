import test from "node:test";
import assert from "node:assert/strict";
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

async function exerciseResumeInterruptedTurn(stateMessages: any[]) {
  const stdinOn = process.stdin.on;
  const stdoutWrite = process.stdout.write;
  const handlers = new Map();
  const lines: string[] = [];
  const calls: any[] = [];

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
        appendMessage: (message: any) => {
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

    const onData = handlers.get("data");
    assert.equal(typeof onData, "function");
    onData(
      Buffer.from(
        `${JSON.stringify({ id: "2", type: "resume_interrupted_turn", requestTag: "tag-2", source: "rpc-reconnect" })}\n`,
      ),
    );
    await wait(10);

    return { calls, lines };
  } finally {
    process.stdin.on = stdinOn;
    process.stdout.write = stdoutWrite;
  }
}

async function exerciseSessionRepair() {
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
        id: "errored-assistant",
        parentId: "user-1",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "WebSocket error",
          content: [
            {
              type: "toolCall",
              id: "call-broken",
              name: "bash",
              arguments: { command: "sleep 1" },
            },
          ],
        },
      },
      {
        type: "message",
        id: "errored-result",
        parentId: "errored-assistant",
        message: {
          role: "toolResult",
          toolCallId: "call-broken",
          toolName: "bash",
          content: [{ type: "text", text: "interrupted" }],
          isError: true,
        },
      },
      {
        type: "message",
        id: "after-error-user",
        parentId: "errored-result",
        message: { role: "user", content: [{ type: "text", text: "after" }] },
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
        leafId: "after-error-user",
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

    return { byId, entries, rewrites, session };
  } finally {
    process.stdin.on = stdinOn;
    process.stdout.write = stdoutWrite;
  }
}

test(
  "rpc interrupted-turn recovery follows Pi provider-visible tool semantics",
  { concurrency: false },
  async () => {
    const normalStateMessages = [
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
    const normal = await exerciseResumeInterruptedTurn(normalStateMessages);

    assert.equal(normal.calls.length, 3);
    assert.equal(normal.calls[0][0], "appendMessage");
    assert.equal(normal.calls[0][1].role, "assistant");
    assert.equal(normal.calls[1][0], "appendMessage");
    assert.equal(normal.calls[1][1].role, "toolResult");
    assert.equal(normal.calls[1][1].toolCallId, "tool-1");
    assert.equal(normal.calls[1][1].toolName, "bash");
    assert.equal(normal.calls[1][1].isError, true);
    assert.equal(
      normal.calls[1][1].content[0].text,
      "The tool was interrupted because the daemon exited.",
    );
    assert.deepEqual(normal.calls[2], ["continue"]);
    assert.equal(normalStateMessages.length, 2);
    assert.equal(normalStateMessages[1].role, "toolResult");
    assert.ok(
      normal.lines.join("").includes('"command":"resume_interrupted_turn"'),
    );

    for (const stopReason of ["error", "aborted"] as const) {
      const stateMessages = [
        {
          role: "assistant",
          stopReason,
          errorMessage: stopReason === "error" ? "WebSocket error" : undefined,
          content: [
            {
              type: "toolCall",
              id: `tool-${stopReason}`,
              name: "bash",
              arguments: { command: "sleep 1" },
            },
          ],
        },
      ];

      const result = await exerciseResumeInterruptedTurn(stateMessages);

      assert.deepEqual(result.calls, []);
      assert.equal(stateMessages.length, 1);
      assert.ok(
        result.lines.join("").includes('"command":"resume_interrupted_turn"'),
      );
    }

    const repair = await exerciseSessionRepair();
    assert.equal(repair.rewrites, 1);
    assert.deepEqual(
      repair.entries.map((entry: any) => entry.id).filter(Boolean),
      ["user-1", "errored-assistant", "after-error-user"],
    );
    assert.equal(repair.byId.has("errored-result"), false);
    assert.equal(repair.entries[1].parentId, null);
    assert.equal(repair.entries[3].parentId, "errored-assistant");
    assert.equal(repair.session.sessionManager.leafId, "after-error-user");
    assert.deepEqual(
      repair.session.agent.state.messages.map((message: any) => message.role),
      ["user", "assistant", "user"],
    );
  },
);
