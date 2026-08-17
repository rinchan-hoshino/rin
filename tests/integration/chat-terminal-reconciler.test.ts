import "../support/require-test-sandbox.ts";
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

test("terminal reconciliation loop deduplicates active and detached projections", async () => {
  const requests: any[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const disposed: string[] = [];
  const terminals = ["active", "detached", "failed"].map((kind) => ({
    requestTag: `chat-inbox-${kind}`,
    chatDeliveryContext: { chatKey: `discord/1:${kind}` },
    terminalRecord: { terminalId: `terminal-${kind}` },
  }));
  const client = {
    isConnected: () => true,
    connect: async () => {},
    async request(command: any) {
      requests.push(command);
      return command.type === "list_unacknowledged_chat_terminals"
        ? { terminals }
        : {};
    },
    disconnect: async () => {},
  };
  const controllers = new Map([
    [
      "discord/1:active",
      {
        ownsAuthoritativeTerminalProjection: () => true,
        driver: { projectAuthoritativeTerminal: async () => {} },
      },
    ],
  ]);
  const detachedControllers = new Map<string, any>();
  const detachedControllerSignatures = new Map<string, string>();
  const loop = reconciler.createChatTerminalReconciliationLoop({
    client,
    isStopping: () => false,
    controllers,
    detachedControllers,
    detachedControllerSignatures,
    getDetachedController(controllerKey: string) {
      const failed = controllerKey.endsWith("failed");
      const controller = {
        async connect() {},
        driver: {
          async projectAuthoritativeTerminal() {
            if (failed) throw new Error("owner projection failed");
          },
        },
        dispose() {
          disposed.push(controllerKey);
        },
      };
      detachedControllers.set(controllerKey, controller);
      detachedControllerSignatures.set(controllerKey, controllerKey);
      return controller;
    },
    logger: {
      info(message: string) {
        infos.push(message);
      },
      warn(message: string) {
        warnings.push(message);
      },
    },
  });

  await loop.request();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    requests.filter((row) => row.type === "ack_turn_terminal").length,
    2,
  );
  assert.equal(disposed.length, 2);
  assert.equal(detachedControllers.size, 0);
  assert.equal(detachedControllerSignatures.size, 0);
  assert.equal(
    infos.some((message) => message.includes("projections=3")),
    true,
  );
  assert.equal(
    warnings.some((message) => message.includes("owner projection failed")),
    true,
  );

  const stopped = reconciler.createChatTerminalReconciliationLoop({
    client,
    isStopping: () => true,
    controllers: new Map(),
    detachedControllers: new Map(),
    detachedControllerSignatures: new Map(),
    getDetachedController() {
      throw new Error("unexpected detached controller");
    },
    logger: { info() {}, warn() {} },
  });
  assert.equal(stopped.request(), null);

  const listingWarnings: string[] = [];
  const failing = reconciler.createChatTerminalReconciliationLoop({
    client: {
      ...client,
      async request() {
        throw new Error("owner listing failed");
      },
    },
    isStopping: () => false,
    controllers: new Map(),
    detachedControllers: new Map(),
    detachedControllerSignatures: new Map(),
    getDetachedController() {
      throw new Error("unexpected detached controller");
    },
    logger: {
      info() {},
      warn(message: string) {
        listingWarnings.push(message);
      },
    },
  });
  await failing.request();
  assert.equal(
    listingWarnings.some((message) => message.includes("owner listing failed")),
    true,
  );
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
