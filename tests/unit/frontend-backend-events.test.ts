import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const sdk = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-frontend-sdk", "index.js"),
  ).href
);
const NOTICE_CHANGED = "💡 Self-improve review updated demo.";

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
});

test("frontend backend event translator exposes Pi working and compaction events", () => {
  const translator = sdk.createRinFrontendBackendEventTranslator();

  assert.deepEqual(
    translator.translate({
      type: "extension_ui_request",
      method: "setWorkingVisible",
      visible: true,
    }),
    [{ type: "working_visible", visible: true }],
  );
  assert.deepEqual(
    translator.translate({
      type: "extension_ui_request",
      method: "setWorkingVisible",
      visible: false,
    }),
    [{ type: "working_visible", visible: false }],
  );
  assert.deepEqual(translator.translate({ type: "rin_working_start" }), []);
  assert.deepEqual(translator.translate({ type: "rin_working_end" }), []);
  assert.deepEqual(translator.translate({ type: "compaction_start" }), [
    { type: "compaction_start_notice", text: "Compacting..." },
    { type: "external_working_start" },
  ]);
  assert.deepEqual(translator.translate({ type: "compaction_end" }), [
    { type: "external_working_end" },
  ]);
});

test("frontend backend event translator exposes compact collapsed notice without summary text", () => {
  const translator = sdk.createRinFrontendBackendEventTranslator();

  assert.deepEqual(
    translator.translate({
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      tokensBefore: 108642,
      result: { summary: "Summary of conversation must not reach chat" },
    }),
    [
      {
        type: "passive_notice",
        text: "[compaction]\n\nCompacted from 108,642 tokens",
        level: "info",
        deferDuringTurn: false,
        noticeKind: "compaction_end",
      },
      { type: "external_working_end" },
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
      tokensBefore: 255166,
      result: { summary: "Summary of conversation must not reach chat" },
    }),
    [
      {
        type: "passive_notice",
        text: "[compaction]\n\nCompacted from 255,166 tokens (ctrl+o to expand)",
        level: "info",
        deferDuringTurn: false,
        noticeKind: "compaction_end",
      },
      { type: "external_working_end" },
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
    [{ type: "external_working_end" }],
  );
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
    { type: "external_working_start" },
  ]);
  assert.deepEqual(translator.translate({ type: "compaction_end" }), [
    { type: "external_working_end" },
  ]);
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
    [{ type: "external_working_end" }],
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

test("frontend backend event translator returns final typed turn events after completion", () => {
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
});
