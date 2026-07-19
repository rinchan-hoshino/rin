import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const {
  resolveRinTurnCompletionFromAssistantMessage,
  resolveRinTurnCompletionFromTurnResult,
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

  assert.equal(resolution, null);
});
