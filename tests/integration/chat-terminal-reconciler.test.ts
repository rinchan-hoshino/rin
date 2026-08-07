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

test("terminal reconciliation acknowledges only after the durable projection succeeds", async () => {
  let connected = false;
  let connectCalls = 0;
  const requests = [];
  const client = {
    isConnected: () => connected,
    connect: async () => {
      connectCalls += 1;
      connected = true;
    },
    request: async (command) => {
      requests.push(command);
      return {};
    },
    disconnect: async () => {
      connected = false;
    },
  };
  const terminal = {
    requestTag: "chat-inbox-recovered",
    terminalRecord: { terminalId: "terminal-recovered" },
  };
  const order = [];

  await reconciler.projectAndAcknowledgeChatTerminalEvent(
    client,
    terminal,
    async () => {
      order.push("projected");
    },
  );
  order.push("acknowledged");

  assert.deepEqual(order, ["projected", "acknowledged"]);
  assert.equal(connectCalls, 1);
  assert.deepEqual(requests, [
    {
      type: "ack_turn_terminal",
      requestTag: "chat-inbox-recovered",
      terminalId: "terminal-recovered",
    },
  ]);

  await assert.rejects(
    reconciler.projectAndAcknowledgeChatTerminalEvent(
      client,
      terminal,
      async () => {
        throw new Error("projection_failed");
      },
    ),
    /projection_failed/,
  );
  assert.equal(requests.length, 1);

  await assert.rejects(
    reconciler.projectAndAcknowledgeChatTerminalEvent(
      client,
      { requestTag: "chat-inbox-missing-terminal" },
      async () => {},
    ),
    /chat_terminal_record_missing/,
  );
  await assert.rejects(
    reconciler.projectAndAcknowledgeChatTerminalEvent(
      client,
      { terminalRecord: { terminalId: "terminal-missing-request" } },
      async () => {},
    ),
    /chat_terminal_record_missing/,
  );

  let disconnectCalls = 0;
  const failingClient = {
    isConnected: () => true,
    connect: async () => {},
    request: async () => {
      throw new Error("ack_failed");
    },
    disconnect: async () => {
      disconnectCalls += 1;
    },
  };
  await assert.rejects(
    reconciler.projectAndAcknowledgeChatTerminalEvent(
      failingClient,
      terminal,
      async () => {},
    ),
    /ack_failed/,
  );
  assert.equal(disconnectCalls, 1);
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
