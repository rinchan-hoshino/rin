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
