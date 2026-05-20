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

const NOTICE_NO_CHANGE =
  "\u{1f4a1} \u81ea\u6211\u6574\u7406\uff1a\u65e0\u53d8\u66f4";
const COMPACTION_NOTICE = "Summary of conversation...";

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
});

test("frontend backend event translator exposes compaction review as external working", () => {
  const translator = sdk.createRinFrontendBackendEventTranslator();

  assert.deepEqual(translator.translate({ type: "rin_working_start" }), [
    { type: "external_working_start" },
  ]);
  assert.deepEqual(translator.translate({ type: "rin_working_end" }), [
    { type: "external_working_end" },
  ]);
  assert.deepEqual(translator.translate({ type: "compaction_start" }), [
    { type: "external_working_start" },
  ]);
  assert.deepEqual(translator.translate({ type: "compaction_end" }), [
    { type: "external_working_end" },
  ]);
});

test("frontend backend event translator exposes notify requests as passive notices", () => {
  const translator = sdk.createRinFrontendBackendEventTranslator();

  assert.deepEqual(
    translator.translate({
      type: "extension_ui_request",
      payload: {
        type: "extension_ui_request",
        method: "notify",
        message: NOTICE_NO_CHANGE,
        notifyType: "info",
      },
    }),
    [
      {
        type: "passive_notice",
        text: NOTICE_NO_CHANGE,
        level: "info",
      },
    ],
  );
  assert.deepEqual(
    translator.translate({
      type: "extension_ui_request",
      payload: {
        type: "extension_ui_request",
        method: "notify",
        message: "ordinary extension notice",
        notifyType: "info",
      },
    }),
    [],
  );
});

test("frontend backend event translator exposes compaction summaries as passive notices", () => {
  const translator = sdk.createRinFrontendBackendEventTranslator();

  assert.deepEqual(
    translator.translate({
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      result: { summary: "Summary of conversation..." },
    }),
    [
      { type: "external_working_end" },
      {
        type: "passive_notice",
        text: COMPACTION_NOTICE,
        level: "info",
      },
    ],
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
  assert.deepEqual(translator.translate({ type: "agent_end" }), [
    { type: "turn_complete", finalText: "real final after compaction" },
  ]);
});

test("frontend backend event translator ignores overflow continuation markers", () => {
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
      type: "rpc_turn_event",
      event: "error",
      error: "context_length_exceeded",
    }),
    [
      {
        type: "turn_error",
        error: "context_length_exceeded",
        sessionId: undefined,
        sessionFile: undefined,
        requestTag: undefined,
      },
    ],
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
  assert.deepEqual(translator.translate({ type: "agent_end" }), [
    { type: "turn_complete", finalText: "continued" },
  ]);
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
