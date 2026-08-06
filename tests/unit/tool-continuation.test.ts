import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const continuation = await importBuiltModule<
  typeof import("../../src/core/pi/tool-continuation.js")
>("dist/core/pi/tool-continuation.js");

const firstCall = {
  type: "toolCall",
  id: " call-1 ",
  name: "read",
  arguments: { path: "/tmp/demo" },
};
const blankIdCall = {
  type: "toolCall",
  id: " ",
  name: "bash",
  arguments: { command: "true" },
};

test("tool continuation plans expose only complete assistant messages", () => {
  const plan = continuation.buildPiToolContinuationPlan([
    { role: "user", content: [firstCall] },
    { role: " assistant ", content: [firstCall] },
    { role: "assistant", stopReason: "error", content: [firstCall] },
    { role: "assistant", stopReason: "aborted", content: [firstCall] },
    {
      role: "assistant",
      stopReason: "stop",
      content: [firstCall, blankIdCall],
    },
    { role: "assistant", content: "plain text" },
  ]);

  assert.deepEqual([...plan.visibleMessageIndexes], [1, 4, 5]);
  assert.deepEqual(plan.visibleToolCallPartsByMessageIndex.get(1), [firstCall]);
  assert.deepEqual(plan.visibleToolCallPartsByMessageIndex.get(4), [
    firstCall,
    blankIdCall,
  ]);
  assert.deepEqual(plan.visibleToolCallPartsByMessageIndex.get(5), []);
  assert.deepEqual(continuation.buildPiToolContinuationPlan(null as any), {
    visibleMessageIndexes: new Set(),
    visibleToolCallPartsByMessageIndex: new Map(),
  });
});

test("assistant tool call extraction accepts assistant messages regardless of completion", () => {
  const assistant = {
    role: "assistant",
    stopReason: "error",
    content: [firstCall, { type: "text", text: "ignored" }, blankIdCall],
  };

  assert.deepEqual(continuation.extractAssistantToolCallParts(assistant), [
    firstCall,
    blankIdCall,
  ]);
  assert.deepEqual(continuation.extractAssistantToolCallIds(assistant), [
    "call-1",
  ]);
  assert.deepEqual(
    continuation.extractAssistantToolCallParts({
      role: "user",
      content: [firstCall],
    }),
    [],
  );
});

test("continuable tool calls reject Pi error and aborted assistant turns", () => {
  for (const stopReason of ["error", "aborted"]) {
    const message = { role: "assistant", stopReason, content: [firstCall] };
    assert.deepEqual(
      continuation.extractPiContinuableToolCallParts(message),
      [],
    );
    assert.deepEqual(continuation.extractPiContinuableToolCallIds(message), []);
  }

  const complete = {
    role: "assistant",
    stopReason: "stop",
    content: [firstCall, blankIdCall],
  };
  assert.deepEqual(continuation.extractPiContinuableToolCallParts(complete), [
    firstCall,
    blankIdCall,
  ]);
  assert.deepEqual(continuation.extractPiContinuableToolCallIds(complete), [
    "call-1",
  ]);
  assert.deepEqual(
    continuation.extractPiContinuableToolCallIds({
      role: "user",
      content: [firstCall],
    }),
    [],
  );
});
