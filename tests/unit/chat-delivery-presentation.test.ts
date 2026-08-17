import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const presentation = await importBuiltModule<
  typeof import("../../src/core/chat/delivery-presentation.js")
>("dist/core/chat/delivery-presentation.js");

test("chat delivery presenter owns quote insertion without duplicating existing quotes", () => {
  assert.deepEqual(presentation.withChatQuotePart(undefined, "quoted"), [
    { type: "quote", id: "quoted" },
  ]);
  const textPart = { type: "text" as const, text: "answer" };
  assert.deepEqual(presentation.withChatQuotePart([textPart], " "), [textPart]);
  assert.deepEqual(
    presentation.withChatQuotePart(
      [{ type: "quote", id: "existing" }, textPart],
      "owner-message",
    ),
    [{ type: "quote", id: "existing" }, textPart],
  );
  assert.deepEqual(
    presentation.withChatQuotePart([textPart], " owner-message "),
    [{ type: "quote", id: "owner-message" }, textPart],
  );
});

test("chat delivery presenter projects optional conversation session metadata", () => {
  assert.deepEqual(
    presentation.conversationSessionPayload(false, "live.jsonl"),
    {},
  );
  assert.deepEqual(
    presentation.conversationSessionPayload(true, undefined),
    {},
  );
  assert.deepEqual(
    presentation.conversationSessionPayload(true, "live.jsonl"),
    { sessionFile: "live.jsonl", sessionBinding: "conversation" },
  );
});

test("chat delivery presenter builds final payloads from explicit values", () => {
  assert.deepEqual(
    presentation.buildChatAssistantDelivery(
      {
        agentDir: "/tmp/rin-agent",
        chatKey: "telegram/bot:chat",
        currentSessionFile: "/tmp/rin-agent/sessions/current.jsonl",
      },
      { text: " final answer ", replyToMessageId: " owner-message " },
    ),
    {
      chatKey: "telegram/bot:chat",
      deliveryKind: "final",
      parts: [
        { type: "quote", id: "owner-message" },
        { type: "text", text: "final answer" },
      ],
      sessionFile: "current.jsonl",
      sessionBinding: "conversation",
    },
  );

  assert.deepEqual(
    presentation.buildChatAssistantDelivery(
      { agentDir: "/tmp/rin-agent", chatKey: "discord/bot:chat" },
      {
        parts: [{ type: "markdown", text: "failure" }],
        sessionFile: "/tmp/rin-agent/sessions/error.jsonl",
        bindSession: false,
        deliveryKind: "error",
      },
    ),
    {
      chatKey: "discord/bot:chat",
      deliveryKind: "error",
      parts: [{ type: "markdown", text: "failure" }],
    },
  );
});
