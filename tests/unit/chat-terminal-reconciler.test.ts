import assert from "node:assert/strict";
import test from "node:test";

const reconciler = await import("../../dist/core/chat/terminal-reconciler.js");

test("terminal reconciler routes durable backlog without waiting for ingress", async () => {
  let connected = false;
  let connectCalls = 0;
  const client = {
    isConnected: () => connected,
    connect: async () => {
      connectCalls += 1;
      connected = true;
    },
    request: async () => ({
      terminals: [
        {
          chatTerminalRecordId: "terminal-a",
          requestTag: "chat-inbox-a",
          chatDeliveryContext: { chatKey: "discord/1:2" },
        },
        {
          chatTerminalRecordId: "terminal-b",
          requestTag: "chat-inbox-b",
          chatDeliveryContext: { chatKey: "discord/1:2" },
        },
        {
          chatTerminalRecordId: "scheduled-chat-delivery",
          requestTag: "scheduled:cron:1",
          chatDeliveryContext: { chatKey: "discord/1:2" },
        },
      ],
    }),
    disconnect: async () => {
      connected = false;
    },
  };
  const handled = [];
  const terminals =
    await reconciler.listUnacknowledgedChatTerminalEvents(client);
  const handledCount = await reconciler.reconcileChatTerminalEvents(
    terminals,
    async (chatKey, terminal) => {
      handled.push([chatKey, terminal.chatTerminalRecordId]);
    },
  );

  assert.equal(connectCalls, 1);
  assert.equal(handledCount, 2);
  assert.deepEqual(handled, [
    ["discord/1:2", "terminal-a"],
    ["discord/1:2", "terminal-b"],
  ]);
});

test("terminal reconciler disconnects a failed global ledger client", async () => {
  let disconnectCalls = 0;
  const client = {
    isConnected: () => true,
    connect: async () => {},
    request: async () => {
      throw new Error("rin_disconnected");
    },
    disconnect: async () => {
      disconnectCalls += 1;
    },
  };

  await assert.rejects(
    reconciler.listUnacknowledgedChatTerminalEvents(client),
    /rin_disconnected/,
  );
  assert.equal(disconnectCalls, 1);
});
