import "../support/require-test-sandbox.ts";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
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

async function exerciseResumeInterruptedTurn(
  stateMessages: any[],
  options: {
    maxRetries?: number;
    retryableError?: boolean;
    onRunAgentPrompt?: (context: {
      emit: (event: any) => void;
      retryAttempt: number;
      stateMessages: any[];
    }) => Promise<void> | void;
  } = {},
) {
  const stdinOn = process.stdin.on;
  const stdoutWrite = process.stdout.write;
  const handlers = new Map();
  const lines: string[] = [];
  const calls: any[] = [];
  const durableMessages = [...stateMessages];
  const sessionSubscribers = new Set<(event: any) => void>();
  const emit = (event: any) => {
    if (event?.type === "message_end" && event.message) {
      durableMessages.push(event.message);
    }
    for (const handler of sessionSubscribers) handler(event);
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
      subscribe: (handler: (event: any) => void) => {
        sessionSubscribers.add(handler);
        return () => sessionSubscribers.delete(handler);
      },
      settingsManager: {
        getRetrySettings: () => ({
          enabled: true,
          maxRetries: options.maxRetries ?? 3,
        }),
      },
      _isRetryableError: (message: any) =>
        options.retryableError === true &&
        message?.role === "assistant" &&
        message?.stopReason === "error",
      _retryAttempt: 0,
      _runAgentPrompt: async (messages: any[]) => {
        calls.push(["runAgentPrompt", messages]);
        await options.onRunAgentPrompt?.({
          emit,
          retryAttempt: session._retryAttempt,
          stateMessages: session.agent.state.messages,
        });
      },
      prompt: async () => {},
      steer: async () => {},
      followUp: async () => {},
      abort: async () => {},
      modelRegistry: { getAvailable: async () => [] },
      sessionManager: {
        appendMessage: (message: any) => {
          calls.push(["appendMessage", message]);
          durableMessages.push(message);
        },
        getEntries: () => [],
        getBranch: () =>
          durableMessages.map((message: any, index: number) => ({
            id: `message-${index}`,
            parentId: index > 0 ? `message-${index - 1}` : null,
            type: "message",
            message,
          })),
        getTree: () => [],
        getLeafId: () =>
          durableMessages.length > 0
            ? `message-${durableMessages.length - 1}`
            : null,
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
    assert.deepEqual(normal.calls[2], ["runAgentPrompt", []]);
    assert.equal(normalStateMessages.length, 2);
    assert.equal(normalStateMessages[1].role, "toolResult");
    assert.ok(
      normal.lines.join("").includes('"command":"resume_interrupted_turn"'),
    );

    for (const stopReason of ["error", "aborted"] as const) {
      const baseMessage = { role: "user", content: [] };
      const stateMessages = [
        baseMessage,
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

      const finalMessage = {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: `continued after ${stopReason}` }],
      };
      const result = await exerciseResumeInterruptedTurn(stateMessages, {
        onRunAgentPrompt: ({ emit, stateMessages: messages }) => {
          assert.deepEqual(messages, [baseMessage]);
          messages.push(finalMessage);
          emit({ type: "message_end", message: finalMessage });
          emit({ type: "agent_settled" });
        },
      });

      assert.deepEqual(result.calls, [["runAgentPrompt", []]]);
      assert.deepEqual(stateMessages, [baseMessage, finalMessage]);
      const events = result.lines
        .join("")
        .trim()
        .split(/\n+/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const response = events.find(
        (event) => event.type === "response" && event.id === "2",
      );
      assert.equal(response?.data?.resumed, true);
      assert.equal(
        events.filter(
          (event) =>
            event.type === "rpc_turn_event" && event.event === "complete",
        ).length,
        1,
      );
    }
  },
);

test(
  "rpc interrupted-turn recovery continues a failure tail without reconstructing Pi retry budget",
  { concurrency: false },
  async () => {
    const baseMessage = { role: "toolResult", content: [] };
    const providerError = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "fetch failed",
      content: [],
    };
    const finalMessage = {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "recovered" }],
    };
    const { calls, lines } = await exerciseResumeInterruptedTurn(
      [baseMessage, providerError],
      {
        retryableError: true,
        onRunAgentPrompt: ({ emit, retryAttempt, stateMessages }) => {
          assert.equal(retryAttempt, 0);
          assert.deepEqual(stateMessages, [baseMessage]);
          stateMessages.push(finalMessage);
          emit({ type: "message_end", message: finalMessage });
          emit({ type: "agent_settled" });
        },
      },
    );

    assert.deepEqual(
      calls.filter(([name]) => name === "runAgentPrompt"),
      [["runAgentPrompt", []]],
    );
    const payloads = lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return undefined;
        }
      })
      .filter(Boolean);
    assert.equal(
      payloads.find((payload) => payload?.id === "2")?.data?.resumed,
      true,
    );
    assert.equal(
      payloads.filter(
        (payload) =>
          payload?.type === "rpc_turn_event" && payload?.event === "complete",
      ).length,
      1,
    );
  },
);

test(
  "rpc interrupted-turn recovery treats an unterminated error tail as continuation input",
  { concurrency: false },
  async () => {
    const errors = Array.from({ length: 4 }, (_, index) => ({
      role: "assistant",
      stopReason: "error",
      errorMessage: `fetch failed ${index + 1}`,
      content: [],
    }));
    const baseMessage = { role: "user", content: [] };
    const finalMessage = {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "continued after process loss" }],
    };
    const { calls, lines } = await exerciseResumeInterruptedTurn(
      [baseMessage, ...errors],
      {
        retryableError: true,
        maxRetries: 3,
        onRunAgentPrompt: ({ emit, retryAttempt, stateMessages }) => {
          assert.equal(retryAttempt, 0);
          assert.deepEqual(stateMessages, [baseMessage]);
          stateMessages.push(finalMessage);
          emit({ type: "message_end", message: finalMessage });
          emit({ type: "agent_settled" });
        },
      },
    );

    assert.deepEqual(
      calls.filter(([name]) => name === "runAgentPrompt"),
      [["runAgentPrompt", []]],
    );
    const payloads = lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return undefined;
        }
      })
      .filter(Boolean);
    const terminalCompletes = payloads.filter(
      (payload) =>
        payload?.type === "rpc_turn_event" && payload?.event === "complete",
    );
    assert.equal(terminalCompletes.length, 1);
    assert.equal(
      payloads.some((payload) => payload?.retryFailure),
      false,
    );
  },
);

test(
  "rpc interrupted-turn recovery reports Codex header timeout retry exhaustion",
  { concurrency: false },
  async () => {
    const providerError = "Codex SSE response headers timed out after 300000ms";
    assert.equal(
      isRetryableAssistantError({
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: providerError,
      } as any),
      true,
    );

    const stateMessages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tool-timeout",
            name: "bash",
            arguments: { command: "sleep 1" },
          },
        ],
      },
    ];
    const result = await exerciseResumeInterruptedTurn(stateMessages, {
      onRunAgentPrompt: ({ emit, stateMessages: messages }) => {
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          emit({
            type: "auto_retry_start",
            attempt,
            maxAttempts: 3,
            delayMs: 0,
            errorMessage: providerError,
          });
        }
        const finalMessage = {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: providerError,
        };
        messages.push(finalMessage);
        emit({ type: "message_end", message: finalMessage });
        emit({
          type: "auto_retry_end",
          success: false,
          attempt: 3,
          finalError: providerError,
        });
        emit({ type: "agent_settled" });
      },
    });

    const events = result.lines
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
    assert.deepEqual(
      events
        .filter((event) => event.type === "auto_retry_start")
        .map((event) => event.attempt),
      [1, 2, 3],
    );
    assert.equal(
      events.some(
        (event) =>
          event.type === "auto_retry_end" &&
          event.success === false &&
          event.attempt === 3,
      ),
      true,
    );
    const terminalError = events.find(
      (event) => event.type === "rpc_turn_event" && event.event === "error",
    );
    assert.equal(terminalError?.error, providerError);
    assert.deepEqual(terminalError?.retryFailure, {
      attempt: 3,
      finalError: providerError,
    });
  },
);
