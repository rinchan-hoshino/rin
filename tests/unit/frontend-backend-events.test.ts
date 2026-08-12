import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const sdk = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-frontend-sdk", "index.js"),
  ).href
);
const NOTICE_CHANGED = "💡 Self-improve review updated demo.";

test("frontend backend event translator exposes user message start", () => {
  const translator = sdk.createRinFrontendBackendEventTranslator();

  assert.deepEqual(
    translator.translate({
      type: "message_start",
      message: {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    }),
    [{ type: "user_message_start", text: "hello" }],
  );
});

test("frontend backend event translator exposes status as a shared frontend event", () => {
  const translator = sdk.createRinFrontendBackendEventTranslator();

  assert.deepEqual(
    translator.translate({
      type: "rpc_frontend_status",
      phase: "working",
      label: "Working",
      connected: true,
      turnActive: true,
    }),
    [
      {
        type: "status",
        phase: "working",
        label: "Working",
        connected: true,
        turnActive: true,
        isStreaming: undefined,
      },
    ],
  );
  assert.deepEqual(
    translator.translate({
      type: "rpc_frontend_status",
      phase: "sending",
      label: "Sending",
      connected: true,
    }),
    [
      {
        type: "status",
        phase: "sending",
        label: "Sending",
        connected: true,
        turnActive: undefined,
        isStreaming: undefined,
      },
    ],
  );
  assert.deepEqual(
    translator.translate({
      type: "rpc_frontend_status",
      phase: "retrying",
      label: "Retrying",
      connected: true,
      turnActive: true,
    }),
    [
      {
        type: "status",
        phase: "retrying",
        label: "Retrying",
        connected: true,
        turnActive: true,
        isStreaming: undefined,
      },
    ],
  );
});

test("shared frontend translation exposes extension UI requests", () => {
  const translator = sdk.createRinFrontendBackendEventTranslator();

  assert.deepEqual(
    translator.translate({
      type: "extension_ui_request",
      id: "ui-1",
      method: "confirm",
      message: "Continue?",
    }),
    [
      {
        type: "extension_ui_request",
        id: "ui-1",
        method: "confirm",
        message: "Continue?",
      },
    ],
  );
  assert.deepEqual(
    translator.translate({
      type: "extension_ui_request",
      method: "rinCommandResult",
      result: {
        fallbackText: "Codex usage",
        parts: [{ type: "image", path: "/tmp/codex-usage.png" }],
      },
    }),
    [
      {
        type: "extension_ui_request",
        method: "rinCommandResult",
        result: {
          fallbackText: "Codex usage",
          parts: [{ type: "image", path: "/tmp/codex-usage.png" }],
        },
      },
    ],
  );
});

test("shared frontend translation ignores TUI visibility preferences", () => {
  const translator = sdk.createRinFrontendBackendEventTranslator();

  assert.deepEqual(
    translator.translate({
      type: "extension_ui_request",
      method: "setWorkingVisible",
      visible: true,
    }),
    [],
  );
  assert.deepEqual(
    translator.translate({
      type: "extension_ui_request",
      method: "setWorkingVisible",
      visible: false,
    }),
    [],
  );
  assert.deepEqual(translator.translate({ type: "rin_working_start" }), []);
  assert.deepEqual(translator.translate({ type: "rin_working_end" }), []);
  assert.deepEqual(translator.translate({ type: "compaction_start" }), [
    { type: "compaction_start_notice", text: "Compacting..." },
  ]);
  assert.deepEqual(translator.translate({ type: "compaction_end" }), []);
});

test("frontend backend event translator leaves manual compact completion to the command response", () => {
  const translator = sdk.createRinFrontendBackendEventTranslator();

  assert.deepEqual(
    translator.translate({
      type: "compaction_end",
      reason: "manual",
      aborted: false,
      tokensBefore: 108642,
      result: { summary: "Summary of conversation must not reach chat" },
    }),
    [],
  );
});

test("frontend backend event translator exposes compact collapsed notice without summary text", () => {
  const translator = sdk.createRinFrontendBackendEventTranslator();

  assert.deepEqual(
    translator.translate({
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      tokensBefore: 1,
      result: {
        summary: "Summary of conversation must not reach chat",
        tokensBefore: 108642,
      },
    }),
    [
      {
        type: "passive_notice",
        text: "[compaction]\n\nCompacted from 108,642 tokens",
        level: "info",
        deferDuringTurn: false,
        noticeKind: "compaction_end",
      },
    ],
  );
});

test("frontend backend event translator adds expand hint only when the caller supplies one", () => {
  const translator = sdk.createRinFrontendBackendEventTranslator({
    compactionExpandKeyText: "ctrl+o",
  });

  assert.deepEqual(
    translator.translate({
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      result: {
        summary: "Summary of conversation must not reach chat",
        tokensBefore: 255166,
      },
    }),
    [
      {
        type: "passive_notice",
        text: "[compaction]\n\nCompacted from 255,166 tokens (ctrl+o to expand)",
        level: "info",
        deferDuringTurn: false,
        noticeKind: "compaction_end",
      },
    ],
  );
});

test("frontend backend event translator does not expose compact summary when token count is unavailable", () => {
  const translator = sdk.createRinFrontendBackendEventTranslator();

  assert.deepEqual(
    translator.translate({
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      result: { summary: "Summary of conversation must not reach chat" },
    }),
    [],
  );
});

test("frontend backend event translator emits only completed assistant summaries", () => {
  const translator = sdk.createRinFrontendBackendEventTranslator();
  const partial = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Designing casual greeting response" },
      { type: "text", text: "Assistant content stays separate" },
    ],
  };

  assert.deepEqual(
    translator.translate({
      type: "message_update",
      message: partial,
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: " response",
        partial,
      },
    }),
    [{ type: "assistant_stream", text: "Assistant content stays separate" }],
  );
  assert.deepEqual(
    translator.translate({
      type: "message_update",
      message: partial,
      assistantMessageEvent: {
        type: "thinking_end",
        contentIndex: 0,
        content: "Designing casual greeting response",
        partial,
      },
    }),
    [
      {
        type: "assistant_summary",
        text: "Designing casual greeting response",
      },
      { type: "assistant_stream", text: "Assistant content stays separate" },
    ],
  );
  assert.deepEqual(
    translator.translate({
      type: "message_update",
      message: partial,
      assistantMessageEvent: {
        type: "thinking_end",
        contentIndex: 0,
        content: "Designing casual greeting response",
        partial,
      },
    }),
    [{ type: "assistant_stream", text: "Assistant content stays separate" }],
  );

  for (const text of [
    "Checking the rendered result",
    "Designing casual greeting response",
  ]) {
    assert.deepEqual(
      translator.translate({
        type: "message_update",
        message: partial,
        assistantMessageEvent: {
          type: "thinking_end",
          contentIndex: 0,
          content: text,
          partial,
        },
      }),
      [
        { type: "assistant_summary", text },
        { type: "assistant_stream", text: "Assistant content stays separate" },
      ],
    );
  }
});

test("frontend backend event translator classifies assistant tool preface as interim", () => {
  const translator = sdk.createRinFrontendBackendEventTranslator();

  assert.deepEqual(
    translator.translate({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "I will check" },
          { type: "toolCall", name: "read", id: "call-1" },
          { type: "text", text: "hidden from interim" },
        ],
      },
    }),
    [{ type: "assistant_interim", text: "I will check" }],
  );

  assert.deepEqual(
    translator.translate({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "I will check" },
          { type: "toolCall", name: "read", id: "call-1" },
        ],
      },
    }),
    [],
  );
});

test("frontend backend event translator does not complete turns from interim text before compaction", () => {
  const translator = sdk.createRinFrontendBackendEventTranslator();

  assert.deepEqual(translator.translate({ type: "agent_start" }), [
    { type: "turn_accepted" },
  ]);
  assert.deepEqual(
    translator.translate({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "interim before compaction" },
          { type: "toolCall", name: "todo", id: "call-1" },
        ],
      },
    }),
    [{ type: "assistant_interim", text: "interim before compaction" }],
  );
  assert.deepEqual(translator.translate({ type: "agent_end" }), []);
  assert.deepEqual(translator.translate({ type: "compaction_start" }), [
    { type: "compaction_start_notice", text: "Compacting..." },
  ]);
  assert.deepEqual(translator.translate({ type: "compaction_end" }), []);
  assert.deepEqual(translator.translate({ type: "agent_start" }), [
    { type: "turn_accepted" },
  ]);
  assert.deepEqual(
    translator.translate({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "real final after compaction" }],
      },
    }),
    [{ type: "assistant_final", text: "real final after compaction" }],
  );
  assert.deepEqual(translator.translate({ type: "agent_end" }), []);
});

test("frontend backend event translator emits todo notice for single todo execution", () => {
  const translator = sdk.createRinFrontendBackendEventTranslator();

  assert.deepEqual(
    translator.translate({
      type: "tool_execution_end",
      toolCallId: "todo-1",
      toolName: "todo",
      result: {
        content: [{ type: "text", text: "legacy text is ignored" }],
        details: {
          action: "write",
          todos: [
            { id: 1, text: "Keep working", done: false },
            { id: 2, text: "Ship renderer", done: true },
          ],
          nextId: 3,
        },
      },
      isError: false,
    }),
    [
      { type: "turn_accepted" },
      {
        type: "passive_notice",
        text: "[ ] Keep working\n[x] Ship renderer",
        level: "info",
        deferDuringTurn: false,
        noticeKind: "todo",
        todoItems: [
          { id: 1, text: "Keep working", done: false },
          { id: 2, text: "Ship renderer", done: true },
        ],
        sourceEventId: "todo-1",
      },
    ],
  );
});

test("frontend backend event translator displays todo reads", () => {
  const translator = sdk.createRinFrontendBackendEventTranslator();

  assert.deepEqual(
    translator.translate({
      type: "tool_execution_end",
      toolCallId: "todo-read",
      toolName: "todo",
      result: {
        details: {
          action: "list",
          todos: [{ id: 1, text: "Keep working", done: false }],
          nextId: 2,
        },
      },
      isError: false,
    }),
    [
      { type: "turn_accepted" },
      {
        type: "passive_notice",
        text: "[ ] Keep working",
        level: "info",
        deferDuringTurn: false,
        noticeKind: "todo",
        todoItems: [{ id: 1, text: "Keep working", done: false }],
        sourceEventId: "todo-read",
      },
    ],
  );
});

test("frontend backend event translator emits empty todo notices as clears", () => {
  const translator = sdk.createRinFrontendBackendEventTranslator();

  assert.deepEqual(
    translator.translate({
      type: "tool_execution_end",
      toolCallId: "todo-1",
      toolName: "todo",
      result: {
        content: [{ type: "text", text: "No todos" }],
        details: {
          action: "clear",
          todos: [],
          nextId: 1,
        },
      },
      isError: false,
    }),
    [
      { type: "turn_accepted" },
      {
        type: "passive_notice",
        text: "",
        level: "info",
        deferDuringTurn: false,
        noticeKind: "todo",
        todoItems: [],
        sourceEventId: "todo-1",
      },
    ],
  );
  assert.deepEqual(
    translator.translate({
      type: "tool_execution_end",
      toolCallId: "todo-2",
      toolName: "todo",
      result: {
        details: {
          action: "write",
          todos: [],
          nextId: 1,
          error: "invalid todo list",
        },
      },
      isError: true,
    }),
    [
      { type: "turn_accepted" },
      {
        type: "passive_notice",
        text: "Error: invalid todo list",
        level: "info",
        deferDuringTurn: false,
        noticeKind: "todo",
        todoItems: [],
        todoError: "invalid todo list",
        sourceEventId: "todo-2",
      },
    ],
  );
});

test("frontend backend event translator waits for the active tool batch before todo notice", () => {
  const translator = sdk.createRinFrontendBackendEventTranslator();

  assert.deepEqual(
    translator.translate({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "todo-1", name: "todo" },
          { type: "toolCall", id: "read-1", name: "read" },
        ],
      },
    }),
    [],
  );
  assert.deepEqual(
    translator.translate({
      type: "tool_execution_end",
      toolCallId: "todo-1",
      toolName: "todo",
      result: {
        details: {
          action: "write",
          todos: [
            { id: 1, text: "Keep working", done: false },
            { id: 2, text: "Ship renderer", done: true },
          ],
          nextId: 3,
        },
      },
    }),
    [{ type: "turn_accepted" }],
  );
  assert.deepEqual(
    translator.translate({
      type: "tool_execution_end",
      toolCallId: "read-1",
      toolName: "read",
      result: { content: [{ type: "text", text: "done" }] },
    }),
    [
      { type: "turn_accepted" },
      {
        type: "passive_notice",
        text: "[ ] Keep working\n[x] Ship renderer",
        level: "info",
        deferDuringTurn: false,
        noticeKind: "todo",
        todoItems: [
          { id: 1, text: "Keep working", done: false },
          { id: 2, text: "Ship renderer", done: true },
        ],
        sourceEventId: "todo-1",
      },
    ],
  );
});

test("frontend backend event translator emits nested multi-tool todo notice when wrapper ends", () => {
  const translator = sdk.createRinFrontendBackendEventTranslator();

  assert.deepEqual(
    translator.translate({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "multi-1",
            name: "multi_tool_use.parallel",
            arguments: {
              tool_uses: [
                { recipient_name: "functions.todo", parameters: {} },
                { recipient_name: "functions.read", parameters: {} },
              ],
            },
          },
        ],
      },
    }),
    [],
  );
  assert.deepEqual(
    translator.translate({
      type: "tool_execution_end",
      toolCallId: "multi-1",
      toolName: "multi_tool_use.parallel",
      result: {
        results: [
          {
            recipient_name: "functions.read",
            result: { content: [{ type: "text", text: "done" }] },
          },
          {
            recipient_name: "functions.todo",
            result: {
              details: {
                action: "write",
                todos: [
                  { id: 1, text: "Keep working", done: false },
                  { id: 2, text: "Ship renderer", done: true },
                ],
                nextId: 3,
              },
            },
          },
        ],
      },
    }),
    [
      { type: "turn_accepted" },
      {
        type: "passive_notice",
        text: "[ ] Keep working\n[x] Ship renderer",
        level: "info",
        deferDuringTurn: false,
        noticeKind: "todo",
        todoItems: [
          { id: 1, text: "Keep working", done: false },
          { id: 2, text: "Ship renderer", done: true },
        ],
        sourceEventId: "multi-1",
      },
    ],
  );
});

test("frontend backend event translator treats overflow compaction as ordinary backend progress", () => {
  const translator = sdk.createRinFrontendBackendEventTranslator();

  assert.deepEqual(
    translator.translate({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "context_length_exceeded",
        },
      ],
    }),
    [],
  );
  assert.deepEqual(
    translator.translate({
      type: "compaction_end",
      reason: "overflow",
      willRetry: true,
      aborted: false,
    }),
    [],
  );
  assert.deepEqual(
    translator.translate({
      type: "agent_start",
    }),
    [{ type: "turn_accepted" }],
  );
  assert.deepEqual(
    translator.translate({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "continued" }],
        stopReason: "stop",
      },
    }),
    [{ type: "assistant_final", text: "continued" }],
  );
  assert.deepEqual(
    translator.translate({
      type: "rpc_turn_event",
      event: "complete",
      finalText: "continued",
    }),
    [
      {
        type: "assistant_final",
        text: "continued",
        result: undefined,
        sessionId: undefined,
        sessionFile: undefined,
        requestTag: undefined,
      },
      {
        type: "turn_complete",
        finalText: "continued",
        result: undefined,
        sessionId: undefined,
        sessionFile: undefined,
        requestTag: undefined,
      },
    ],
  );
});

test("frontend backend event translator preserves producer request tags on progress", () => {
  const translator = sdk.createRinFrontendBackendEventTranslator();

  assert.deepEqual(
    translator.translate({
      type: "message_start",
      requestTag: "producer-tag",
      message: {
        role: "user",
        content: [{ type: "text", text: "continue" }],
      },
    }),
    [
      {
        type: "user_message_start",
        text: "continue",
        requestTag: "producer-tag",
      },
    ],
  );
  assert.deepEqual(
    translator.translate({
      type: "message_update",
      requestTag: "producer-tag",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "thinking_end",
        content: "Checking ownership",
      },
    }),
    [
      {
        type: "assistant_summary",
        text: "Checking ownership",
        requestTag: "producer-tag",
      },
    ],
  );
  assert.deepEqual(
    translator.translate({
      type: "message_end",
      requestTag: "producer-tag",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "I will inspect this" },
          { type: "toolCall", id: "call-1", name: "read" },
        ],
      },
    }),
    [
      {
        type: "assistant_interim",
        text: "I will inspect this",
        requestTag: "producer-tag",
      },
    ],
  );
});

test("frontend backend event translator keeps retry schedules silent without terminalizing the turn", () => {
  const translator = sdk.createRinFrontendBackendEventTranslator();

  assert.deepEqual(
    translator.translate({
      type: "auto_retry_start",
      attempt: 2,
      maxAttempts: 3,
      delayMs: 1000,
      errorMessage: "Provider unavailable",
      requestTag: "retry-turn",
    }),
    [],
  );
  assert.deepEqual(
    translator.translate({
      type: "summarization_retry_scheduled",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2000,
      errorMessage: "Compaction failed: overloaded",
      requestTag: "retry-turn",
    }),
    [],
  );
  assert.deepEqual(
    translator.translate({
      type: "rpc_turn_event",
      event: "error",
      error: "Provider unavailable",
      retryFailure: {
        attempt: 3,
        finalError: "Provider unavailable",
      },
      requestTag: "retry-turn",
    }),
    [
      {
        type: "turn_error",
        error: "Retry failed after 3 attempts: Provider unavailable",
        retryFailure: {
          attempt: 3,
          finalError: "Provider unavailable",
        },
        sessionId: undefined,
        sessionFile: undefined,
        requestTag: "retry-turn",
      },
    ],
  );
  assert.deepEqual(
    translator.translate({
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      willRetry: false,
      errorMessage: "Compaction failed after retries",
      requestTag: "retry-turn",
    }),
    [
      {
        type: "passive_notice",
        text: "Compaction failed after retries",
        level: "error",
        deferDuringTurn: false,
        noticeKind: "lifecycle_error",
        requestTag: "retry-turn",
      },
    ],
  );
});

test("frontend backend event translator covers wrapper, optional-status, and untagged branches", () => {
  const translator = sdk.createRinFrontendBackendEventTranslator();

  assert.deepEqual(
    translator.translate({
      type: "ui",
      payload: {
        type: "rpc_frontend_status",
        phase: "unknown",
        label: " ",
        connected: "yes",
        turnActive: null,
        isStreaming: 1,
      },
    }),
    [
      {
        type: "status",
        phase: "idle",
        label: undefined,
        connected: undefined,
        turnActive: undefined,
        isStreaming: undefined,
      },
    ],
  );
  for (const phase of ["compacting", "idle"]) {
    const [event] = translator.translate({
      type: "rpc_frontend_status",
      phase,
    });
    assert.equal(event?.type, "status");
    if (event?.type === "status") assert.equal(event.phase, phase);
  }
  assert.deepEqual(translator.translate({ type: "extension_ui_request" }), []);
  assert.deepEqual(
    translator.translate({
      type: "extension_ui_request",
      payload: {
        type: "rpc_frontend_status",
        phase: "working",
        label: "Working",
        connected: false,
        turnActive: true,
        isStreaming: false,
      },
    }),
    [
      {
        type: "status",
        phase: "working",
        label: "Working",
        connected: false,
        turnActive: true,
        isStreaming: false,
      },
    ],
  );
  assert.deepEqual(
    translator.translate({ type: "rpc_turn_event", event: "start" }),
    [{ type: "turn_accepted", requestTag: undefined }],
  );
  assert.equal(
    translator
      .translate({ type: "rpc_turn_event", event: "complete" })
      .some((event) => event.type === "turn_complete"),
    true,
  );
  assert.deepEqual(
    translator.translate({
      type: "message_start",
      message: { role: "assistant", content: [] },
    }),
    [],
  );
  assert.deepEqual(
    translator.translate({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "other", content: "ignored" },
    }),
    [],
  );
  assert.deepEqual(
    translator.translate({
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    }),
    [{ type: "user_message_start", text: "hello" }],
  );
  assert.deepEqual(translator.translate({ type: "agent_start" }), [
    { type: "turn_accepted" },
  ]);
  assert.deepEqual(translator.translate({ type: "tool_execution_start" }), [
    { type: "turn_accepted" },
  ]);
  assert.deepEqual(
    translator.translate({
      type: "tool_execution_end",
      toolName: "functions.todo",
      toolCallId: "todo-untagged",
      result: {
        details: {
          todos: [],
          error: "owner error",
        },
      },
    }),
    [
      { type: "turn_accepted" },
      {
        type: "passive_notice",
        text: "Error: owner error",
        level: "info",
        deferDuringTurn: false,
        noticeKind: "todo",
        todoItems: [],
        todoError: "owner error",
        sourceEventId: "todo-untagged",
      },
    ],
  );
  translator.resetAssistantSegments();
  assert.deepEqual(translator.translate(null), []);
});

test("frontend backend event translator leaves terminal commit dedupe to the driver", () => {
  const translator = sdk.createRinFrontendBackendEventTranslator();

  assert.deepEqual(
    translator.translate({
      type: "rpc_turn_event",
      event: "complete",
      requestTag: "tag-1",
      finalText: "done",
      result: { ok: true },
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
    }),
    [
      {
        type: "assistant_final",
        text: "done",
        result: { ok: true },
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
        requestTag: "tag-1",
      },
      {
        type: "turn_complete",
        finalText: "done",
        result: { ok: true },
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
        requestTag: "tag-1",
      },
    ],
  );
  assert.deepEqual(
    translator.translate({
      type: "rpc_turn_event",
      event: "error",
      requestTag: "tag-1",
      error: "late duplicate terminal",
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
    }),
    [
      {
        type: "turn_error",
        error: "late duplicate terminal",
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
        requestTag: "tag-1",
      },
    ],
  );
});
