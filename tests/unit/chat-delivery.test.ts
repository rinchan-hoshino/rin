import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const delivery = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "delivery.js")).href
);

test("chat delivery builder keeps quote, parts, and stored session binding", () => {
  assert.deepEqual(
    delivery.buildChatAssistantDelivery(
      {
        agentDir: "/home/demo/.rin",
        chatKey: "discord/bot:channel",
        currentSessionFile: "/home/demo/.rin/sessions/chat/session.jsonl",
      },
      { text: "hello", replyToMessageId: "m1" },
    ),
    {
      chatKey: "discord/bot:channel",
      deliveryKind: "final",
      replyToMessageId: "m1",
      parts: [
        { type: "quote", id: "m1" },
        { type: "text", text: "hello" },
      ],
      sessionFile: "chat/session.jsonl",
      sessionBinding: "conversation",
    },
  );
});

test("chat delivery transaction suppresses non-final quiet output before enqueue", async () => {
  let enqueued = false;
  const result = await delivery.enqueueAndDrainChatDelivery(
    {
      agentDir: "/tmp/rin",
      app: {},
      h: {},
      logger: {},
      quietModeEnabled: true,
      enqueue() {
        enqueued = true;
      },
      async drain() {
        return [];
      },
      read() {
        return undefined;
      },
    },
    { chatKey: "discord/bot:channel", parts: [{ type: "text", text: "x" }] },
    { deliveryKind: "interim" },
  );
  assert.equal(enqueued, false);
  assert.deepEqual(result, { messageIds: [], accepted: false, settled: true });
});
