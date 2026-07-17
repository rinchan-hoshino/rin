import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const submittedTurn = await importBuiltModule<
  typeof import("../../src/core/rin-frontend-sdk/submitted-turn.js")
>("dist/core/rin-frontend-sdk/submitted-turn.js");

const sentAt = Date.parse("2026-07-16T10:00:00.000Z");

test("submitted turn validation requires a matching post-send user prompt", () => {
  assert.equal(
    submittedTurn.resolveSubmittedTurnFromMessages([], {
      text: "prompt",
      sentAt: 0,
    }),
    null,
  );
  assert.equal(
    submittedTurn.resolveSubmittedTurnFromMessages([], {
      text: "prompt",
      sentAt: Number.NaN,
    }),
    null,
  );
  assert.equal(
    submittedTurn.resolveSubmittedTurnFromMessages([], {
      text: "  ",
      sentAt,
    }),
    null,
  );
  assert.equal(
    submittedTurn.resolveSubmittedTurnFromMessages(
      [
        { role: "assistant", timestamp: sentAt + 1, content: "not a user" },
        { role: "user", timestamp: sentAt - 1, content: "prompt" },
        { role: "user", timestamp: sentAt + 1, content: "other" },
        { role: "user", timestamp: "not a date", content: "prompt" },
      ],
      { text: "prompt", sentAt },
    ),
    null,
  );
});

test("submitted turn matching normalizes persisted wrappers, timestamps, and content forms", () => {
  const variants = [
    { role: "user", timestamp: sentAt, content: " prompt " },
    {
      timestamp: sentAt,
      message: {
        role: "user",
        content: [
          "pro",
          { text: "m" },
          { content: "p" },
          { attrs: { content: "t" } },
        ],
      },
    },
    {
      message: {
        role: "user",
        timestamp: "2026-07-16T10:00:00.000Z",
        text: "prompt",
      },
    },
  ];

  for (const message of variants) {
    assert.deepEqual(
      submittedTurn.resolveSubmittedTurnFromMessages([message], {
        text: "prompt",
        sentAt,
      }),
      { submitted: true },
    );
  }
});

test("later user input supersedes the matched turn before completion", () => {
  assert.deepEqual(
    submittedTurn.resolveSubmittedTurnFromMessages(
      [
        { role: "user", timestamp: sentAt, content: "prompt" },
        { role: "assistant", content: [{ type: "toolCall", name: "read" }] },
        { role: "user", timestamp: sentAt + 1, content: "steered" },
        { role: "assistant", content: "final after steering" },
      ],
      { text: "prompt", sentAt },
    ),
    { superseded: true },
  );
});

test("the first deliverable assistant completion resolves the submitted turn", () => {
  assert.deepEqual(
    submittedTurn.resolveSubmittedTurnFromMessages(
      [
        { role: "user", timestamp: sentAt, content: "prompt" },
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "work" }],
        },
        { role: "assistant", content: "  completed answer  " },
        { role: "assistant", content: "later answer" },
      ],
      { text: "prompt", sentAt },
    ),
    {
      finalText: "completed answer",
      result: { messages: [{ type: "text", text: "completed answer" }] },
    },
  );
});

test("provider failures are surfaced only after the turn is no longer active", () => {
  const messages = [
    { role: "user", timestamp: sentAt, content: "prompt" },
    {
      role: "assistant",
      stopReason: "error",
      errorMessage: " provider failed ",
      content: [{ type: "thinking", thinking: "work" }],
    },
  ];
  assert.deepEqual(
    submittedTurn.resolveSubmittedTurnFromMessages(
      messages,
      { text: "prompt", sentAt },
      { turnActive: true },
    ),
    { submitted: true },
  );
  assert.deepEqual(
    submittedTurn.resolveSubmittedTurnFromMessages(messages, {
      text: "prompt",
      sentAt,
    }),
    { error: "provider failed" },
  );

  assert.deepEqual(
    submittedTurn.resolveSubmittedTurnFromMessages(
      [
        { role: "user", timestamp: sentAt, content: "prompt" },
        {
          message: {
            role: "assistant",
            stopReason: "aborted",
            error: "aborted detail",
          },
        },
        { role: "assistant", stopReason: "error", errorMessage: "" },
      ],
      { text: "prompt", sentAt },
    ),
    { error: "aborted detail" },
  );

  assert.deepEqual(
    submittedTurn.resolveSubmittedTurnFromMessages(
      [
        { role: "user", timestamp: sentAt, content: "prompt" },
        { role: "toolResult", content: "no final" },
      ],
      { text: "prompt", sentAt },
    ),
    { submitted: true },
  );
});
