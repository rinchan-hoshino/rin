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
          terminalId: "terminal-a",
          chatDeliveryContext: { chatKey: "discord/1:2" },
        },
        {
          terminalId: "terminal-b",
          chatDeliveryContext: { chatKey: "discord/1:2" },
        },
        { terminalId: "not-chat-owned" },
      ],
    }),
    disconnect: async () => {
      connected = false;
    },
  };
  const handled = [];
  let controllerConnectCalls = 0;
  const terminals =
    await reconciler.listUnacknowledgedChatTerminalEvents(client);
  const chatKeys = await reconciler.reconcileChatTerminalEvents(
    terminals,
    (chatKey) => ({
      connect: async () => {
        controllerConnectCalls += 1;
      },
      driver: {
        handleClientEvent: async (event) => {
          handled.push([chatKey, event.payload.terminalId]);
        },
      },
    }),
  );

  assert.equal(connectCalls, 1);
  assert.equal(controllerConnectCalls, 1);
  assert.deepEqual(chatKeys, ["discord/1:2"]);
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
