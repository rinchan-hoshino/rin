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
      agent: {
        waitForIdle: async () => {},
        state: { messages: stateMessages },
      },
      bindExtensions: async () => {},
      subscribe: (handler: (event: any) => void) => {
        sessionSubscribers.add(handler);
        return () => sessionSubscribers.delete(handler);
      },
      _runAgentPrompt: async (messages: any[]) => {
        calls.push(["runAgentPrompt", messages]);
      },
      prompt: async () => {},
      steer: async () => {},
      followUp: async () => {},
      abort: async () => {},
      modelRegistry: { getAvailable: async () => [] },
      sessionManager: {
        appendMessage: (message: any) => calls.push(["appendMessage", message]),
        getEntries: () =>
          stateMessages.map((message: any, index: number) => ({
            type: "message",
            id: `entry-${index}`,
            message,
          })),
        getBranch: () => [],
        getTree: () => [],
        getLeafId: () => null,
        getCwd: () => process.cwd(),
        getSessionDir: () => process.cwd(),
      },
      messages: [],
      getSessionStats: () => ({}),
      getUserMessagesForForking: () => [],
      getLastAssistantText: () =>
        stateMessages
          .at(-1)
          ?.content?.filter((part: any) => part?.type === "text")
          .map((part: any) => part.text)
          .join("") || "",
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
        `${JSON.stringify({ id: "resume", type: "resume_interrupted_turn", requestTag: "same-turn" })}\n`,
      ),
    );
    await wait(10);
    return { calls, lines };
  } finally {
    process.stdin.on = stdinOn;
    process.stdout.write = stdoutWrite;
  }
}

test(
  "worker recovery appends the canonical daemon-exit tool result and continues Pi",
  { concurrency: false },
  async () => {
    const stateMessages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tool-1",
            name: "read",
            arguments: { path: "/tmp/a" },
          },
          {
            type: "toolCall",
            id: "tool-2",
            name: "bash",
            arguments: { command: "sleep 1" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        content: [{ type: "text", text: "done" }],
        isError: false,
        timestamp: 1,
      },
    ];
    const result = await exerciseResumeInterruptedTurn(stateMessages);

    assert.equal(result.calls[0]?.[0], "appendMessage");
    assert.deepEqual(result.calls[0]?.[1], {
      role: "toolResult",
      toolCallId: "tool-2",
      toolName: "bash",
      content: [
        {
          type: "text",
          text: "The tool was interrupted because the daemon exited.",
        },
      ],
      details: { interrupted: true, reason: "daemon_exit" },
      isError: true,
      timestamp: result.calls[0]?.[1].timestamp,
    });
    assert.deepEqual(result.calls[1], ["runAgentPrompt", []]);
    assert.equal(stateMessages.at(-1)?.role, "toolResult");
    assert.match(result.lines.join(""), /"command":"resume_interrupted_turn"/);
  },
);
