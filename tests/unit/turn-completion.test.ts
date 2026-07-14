import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const {
  resolveRinTurnCompletionFromAssistantMessage,
  resolveRinTurnCompletionFromMessages,
  resolveRinTurnCompletionFromTurnResult,
  resolveRinTurnFailureMessage,
} = await import(
  pathToFileURL(
    path.join(
      rootDir,
      "dist",
      "core",
      "rin-frontend-sdk",
      "turn-completion.js",
    ),
  ).href
);

test("Rin turn completion resolves explicit TurnResult payloads", () => {
  const { completion } = resolveRinTurnCompletionFromTurnResult({
    messages: [{ type: "text", text: "explicit final" }],
  });

  assert.equal(completion.finalText, "explicit final");
});

test("Rin turn completion resolves the current assistant message_end", () => {
  const resolution = resolveRinTurnCompletionFromAssistantMessage({
    role: "assistant",
    content: [{ type: "text", text: "message_end final" }],
  });

  assert.equal(resolution?.completion.finalText, "message_end final");
});

test("Rin turn completion does not treat assistant tool-call prefaces as finals", () => {
  const resolution = resolveRinTurnCompletionFromAssistantMessage({
    role: "assistant",
    content: [
      { type: "text", text: "not final" },
      { type: "toolCall", name: "read", id: "call-1" },
    ],
  });

  assert.equal(resolution?.completion.finalText, "");
  assert.equal(
    resolveRinTurnCompletionFromAssistantMessage({
      role: "user",
      content: [{ type: "text", text: "not an assistant" }],
    }),
    null,
  );
});

test("Rin turn completion preserves the supplied message list", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "question" }] },
    { role: "assistant", content: [{ type: "text", text: "answer" }] },
  ];

  const resolution = resolveRinTurnCompletionFromMessages(messages);

  assert.equal(resolution.messages, messages);
  assert.equal(resolution.completion.finalText, "answer");
});

test("Rin turn failure messages follow explicit, state, and assistant error priority", () => {
  const messages = [
    { role: "assistant", errorMessage: "older failure" },
    { role: "user", errorMessage: "ignored user failure" },
    { role: "assistant", errorMessage: "latest failure" },
  ];

  assert.equal(
    resolveRinTurnFailureMessage({}, messages, {
      retryFailureMessage: " retry failed ",
    }),
    "retry failed",
  );
  assert.equal(
    resolveRinTurnFailureMessage(
      { agent: { state: { errorMessage: " state failed " } } },
      messages,
    ),
    "state failed",
  );
  assert.equal(resolveRinTurnFailureMessage({}, messages), "latest failure");
  assert.equal(
    resolveRinTurnFailureMessage({}, [
      { role: "user", errorMessage: "ignored" },
      { role: "assistant", errorMessage: "  " },
    ]),
    "",
  );
});
