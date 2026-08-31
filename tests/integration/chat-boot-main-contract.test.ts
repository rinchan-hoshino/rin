import "../support/require-test-sandbox.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const boot = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "boot.js")).href
);
const outbox = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "outbox.js")).href
);
const database = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "database.js")).href
);
const messageStore = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js"))
    .href
);

test("chat boot projects chat-enabled commands from the runtime catalog", () => {
  const rows = boot.getChatCommandRows([
    {
      name: "hello",
      description: "Say hello",
      source: "extension",
      chat: true,
      chatConcurrent: true,
    },
    {
      name: "terminal-only",
      description: "TUI only",
      source: "extension",
      chat: false,
    },
    {
      name: "usage",
      description: "Show Codex quota status",
      source: "builtin",
      chat: true,
    },
  ]);
  assert.deepEqual(rows, [
    {
      name: "hello",
      description: "Say hello",
      chatConcurrent: true,
    },
    { name: "usage", description: "Show Codex quota status" },
  ]);
  assert.equal(boot.isChatCommandConcurrent(rows, "hello"), true);
  assert.equal(boot.isChatCommandConcurrent(rows, "usage"), false);
});

test("chat boot refreshes a live command projection after reload", async () => {
  const current = [{ name: "old", description: "Old" }];
  await boot.refreshChatCommandRows(current, {
    async connect() {},
    async getCommands() {
      return [
        { id: "new", name: "new", description: "New", chat: true },
        { id: "hidden", name: "hidden", description: "Hidden", chat: false },
      ];
    },
    async disconnect() {},
  });
  assert.deepEqual(current, [{ name: "new", description: "New" }]);
});

test("chat boot loads its command projection from the daemon catalog", async () => {
  const calls: string[] = [];
  const rows = await boot.loadChatCommandRows({
    async connect() {
      calls.push("connect");
    },
    async getCommands() {
      calls.push("getCommands");
      return [
        { id: "visible", name: "visible", description: "Visible", chat: true },
        { id: "hidden", name: "hidden", description: "Hidden", chat: false },
      ];
    },
    async disconnect() {
      calls.push("disconnect");
    },
  });
  assert.deepEqual(rows, [{ name: "visible", description: "Visible" }]);
  assert.deepEqual(calls, ["connect", "getCommands", "disconnect"]);
});

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-boot-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function waitFor(assertion, timeoutMs = 1000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      return assertion();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (lastError) throw lastError;
}

const chatBuiltinCatalog = [
  { name: "help", chat: true },
  { name: "abort", chat: true },
  { name: "new", chat: true },
  { name: "compact", chat: true },
  { name: "reload", chat: true },
  { name: "usage", description: "Show Codex quota status", chat: true },
  { name: "status", chat: true },
];

test("chat boot falls back to English descriptions for catalog rows", () => {
  const rows = boot.getChatCommandRows(chatBuiltinCatalog);
  assert.deepEqual(
    rows.map((row) => row.description),
    [
      "Show available commands",
      "Abort current operation",
      "Start a new session",
      "Compact the current session",
      "Reload extensions, prompts, skills, and themes",
      "Show Codex quota status",
      "Show this chat session status",
    ],
  );
});

test("chat boot builds and syncs Discord application commands", async () => {
  const calls = [];
  const bot = {
    platform: "discord",
    selfId: "bot-1",
    internal: {
      async setApplicationCommands(payload) {
        calls.push(payload);
      },
    },
  };
  const rows = boot.getChatCommandRows(chatBuiltinCatalog);
  const expectedPayload = [
    {
      name: "help",
      description: "Show available commands",
      type: 1,
      options: [
        { name: "input", description: "Arguments", type: 3, required: false },
      ],
    },
    {
      name: "abort",
      description: "Abort current operation",
      type: 1,
      options: [
        { name: "input", description: "Arguments", type: 3, required: false },
      ],
    },
    {
      name: "new",
      description: "Start a new session",
      type: 1,
      options: [
        { name: "input", description: "Arguments", type: 3, required: false },
      ],
    },
    {
      name: "compact",
      description: "Compact the current session",
      type: 1,
      options: [
        { name: "input", description: "Arguments", type: 3, required: false },
      ],
    },
    {
      name: "reload",
      description: "Reload extensions, prompts, skills, and themes",
      type: 1,
      options: [
        { name: "input", description: "Arguments", type: 3, required: false },
      ],
    },
    {
      name: "usage",
      description: "Show Codex quota status",
      type: 1,
      options: [
        { name: "input", description: "Arguments", type: 3, required: false },
      ],
    },
    {
      name: "status",
      description: "Show this chat session status",
      type: 1,
      options: [
        { name: "input", description: "Arguments", type: 3, required: false },
      ],
    },
  ];

  assert.deepEqual(boot.buildDiscordCommandPayload(rows), expectedPayload);
  assert.deepEqual(
    boot.buildDiscordCommandPayload([
      { name: "HELP", description: "override" },
      { name: "help", description: "ignored duplicate" },
      { name: "bad name" },
      { name: "usage" },
    ]),
    [
      {
        name: "help",
        description: "override",
        type: 1,
        options: [
          { name: "input", description: "Arguments", type: 3, required: false },
        ],
      },
      {
        name: "usage",
        description: "usage",
        type: 1,
        options: [
          { name: "input", description: "Arguments", type: 3, required: false },
        ],
      },
    ],
  );

  await boot.syncDiscordCommands(
    { bots: [bot, { platform: "telegram", internal: {} }] },
    { warn() {} },
    rows,
  );

  assert.deepEqual(calls, [{ commands: expectedPayload }]);
});

test("chat boot clears common telegram scopes before syncing default commands", async () => {
  const deletes = [];
  const sets = [];
  const bot = {
    platform: "telegram",
    selfId: "bot-1",
    internal: {
      async deleteMyCommands(payload) {
        deletes.push(payload);
      },
      async setMyCommands(payload) {
        sets.push(payload);
      },
    },
  };

  const rows = boot.getChatCommandRows(chatBuiltinCatalog);
  const expectedPayload = [
    { command: "help", description: "Show available commands" },
    { command: "abort", description: "Abort current operation" },
    { command: "new", description: "Start a new session" },
    { command: "compact", description: "Compact the current session" },
    {
      command: "reload",
      description: "Reload extensions, prompts, skills, and themes",
    },
    { command: "usage", description: "Show Codex quota status" },
    { command: "status", description: "Show this chat session status" },
  ];

  assert.deepEqual(boot.buildTelegramCommandPayload(rows), expectedPayload);
  assert.deepEqual(
    boot.buildTelegramCommandPayload([
      { name: "HELP", description: "override" },
      { name: "help", description: "ignored duplicate" },
      { name: "bad name" },
      { name: "usage" },
    ]),
    [
      { command: "help", description: "override" },
      { command: "usage", description: "usage" },
    ],
  );
  assert.deepEqual(boot.buildTelegramCommandClearScopes(), [
    { type: "all_private_chats" },
    { type: "all_group_chats" },
    { type: "all_chat_administrators" },
  ]);

  await boot.syncTelegramCommands(
    { bots: [bot], $commander: { updateCommands() {} } },
    { warn() {} },
    rows,
  );

  assert.deepEqual(deletes, [
    { scope: { type: "all_private_chats" } },
    { scope: { type: "all_group_chats" } },
    { scope: { type: "all_chat_administrators" } },
  ]);
  assert.deepEqual(sets, [
    {
      commands: expectedPayload,
    },
  ]);
});

test("chat boot claims outbox files before sending so concurrent drains do not duplicate delivery", async () => {
  await withTempDir(async (agentDir) => {
    outbox.enqueueChatOutboxPayload(agentDir, {
      createdAt: new Date().toISOString(),
      chatKey: "telegram/1:2",
      parts: [{ type: "text", text: "hello" }],
    });

    const sends = [];
    const app = {
      bots: [
        {
          platform: "telegram",
          selfId: "1",
          async sendMessage(chatId, content) {
            sends.push({ chatId, content });
            await new Promise((resolve) => setTimeout(resolve, 50));
            return ["m1"];
          },
        },
      ],
    };
    const h = {
      text(content) {
        return { type: "text", attrs: { content } };
      },
      quote(id) {
        return { type: "quote", attrs: { id } };
      },
    };

    await Promise.all([
      boot.drainChatOutbox(app, agentDir, h, { warn() {} }),
      boot.drainChatOutbox(app, agentDir, h, { warn() {} }),
    ]);

    assert.equal(sends.length, 1);
  });
});

test("chat boot does not apply post-delivery after losing the outbox attempt fence", async () => {
  await withTempDir(async (agentDir) => {
    messageStore.saveChatMessage(agentDir, {
      chatKey: "telegram/1:2",
      platform: "telegram",
      botId: "1",
      chatId: "2",
      messageId: "inbound-raced-delivery",
      role: "user",
      receivedAt: new Date().toISOString(),
      text: "question",
    });
    const itemId = outbox.enqueueChatOutboxPayload(
      agentDir,
      {
        createdAt: new Date().toISOString(),
        chatKey: "telegram/1:2",
        parts: [{ type: "text", text: "answer" }],
      },
      {
        postDelivery: {
          markProcessed: {
            chatKey: "telegram/1:2",
            messageId: "inbound-raced-delivery",
          },
        },
      },
    );
    let replacement;
    const app = {
      bots: [
        {
          platform: "telegram",
          selfId: "1",
          async sendMessage() {
            database
              .openChatDatabase(agentDir)
              .prepare(`UPDATE outbox SET lease_until = ? WHERE outbox_id = ?`)
              .run(new Date(0).toISOString(), itemId);
            replacement = outbox.claimChatOutboxItem(agentDir, itemId, {
              leaseUntil: new Date(Date.now() + 60_000).toISOString(),
            });
            return ["stale-provider-result"];
          },
        },
      ],
    };

    await boot.drainChatOutbox(
      app,
      agentDir,
      {
        text(content) {
          return { type: "text", attrs: { content } };
        },
      },
      { warn() {} },
      { itemId },
    );

    assert.ok(replacement?.ownerEpoch);
    assert.equal(
      messageStore
        .listChatMessages(agentDir)
        .find((message) => message.messageId === "inbound-raced-delivery")
        ?.processedAt,
      undefined,
    );
    assert.equal(
      outbox.readChatOutboxItemById(agentDir, itemId)?.item.ownerEpoch,
      replacement.ownerEpoch,
    );
  });
});

test("chat boot drains a target chat without waiting for a slow different chat", async () => {
  await withTempDir(async (agentDir) => {
    outbox.enqueueChatOutboxPayload(agentDir, {
      createdAt: new Date().toISOString(),
      chatKey: "telegram/1:slow",
      parts: [{ type: "text", text: "slow image batch" }],
    });
    outbox.enqueueChatOutboxPayload(agentDir, {
      createdAt: new Date().toISOString(),
      chatKey: "telegram/1:fast",
      parts: [{ type: "text", text: "fast reply" }],
    });
    const fastId = outbox
      .listChatOutboxItems(agentDir)
      .find(({ item }) => item.payload.chatKey === "telegram/1:fast")?.item.id;
    assert.ok(fastId);

    const sends = [];
    const app = {
      bots: [
        {
          platform: "telegram",
          selfId: "1",
          async sendMessage(chatId, content) {
            sends.push({ chatId, content });
            if (chatId === "slow") {
              await new Promise(() => {});
            }
            return [`m-${chatId}`];
          },
        },
      ],
    };
    const h = {
      text(content) {
        return { type: "text", attrs: { content } };
      },
      quote(id) {
        return { type: "quote", attrs: { id } };
      },
    };

    const result = await Promise.race([
      boot.drainChatOutbox(
        app,
        agentDir,
        h,
        { warn() {} },
        {
          chatKey: "telegram/1:fast",
          itemId: fastId,
        },
      ),
      new Promise((resolve) => setTimeout(() => resolve("timed-out"), 100)),
    ]);

    assert.notEqual(result, "timed-out");
    assert.equal(
      outbox.readChatOutboxItemById(agentDir, fastId)?.item.status,
      "delivered",
    );
    assert.deepEqual(
      sends.map((send) => send.chatId),
      ["fast"],
    );
  });
});

test("chat boot releases a timed out outbox send without retrying before its lease", async () => {
  await withTempDir(async (agentDir) => {
    outbox.enqueueChatOutboxPayload(agentDir, {
      createdAt: new Date().toISOString(),
      chatKey: "telegram/1:2",
      parts: [{ type: "text", text: "stuck send" }],
    });
    const itemId = outbox.listChatOutboxItems(agentDir)[0].item.id;
    let sends = 0;
    const app = {
      bots: [
        {
          platform: "telegram",
          selfId: "1",
          outboxUsesDispatchSignal: true,
          async sendMessage() {
            sends += 1;
            await new Promise(() => {});
          },
        },
      ],
    };
    const h = {
      text(content) {
        return { type: "text", attrs: { content } };
      },
    };

    const results = await boot.drainChatOutbox(
      app,
      agentDir,
      h,
      { warn() {} },
      {
        chatKey: "telegram/1:2",
        itemId,
        sendTimeoutMs: 20,
        retryLeaseMs: 5000,
      },
    );

    assert.equal(results[0].status, "dispatched");
    const stored = outbox.listChatOutboxItems(agentDir)[0].item;
    assert.equal(stored.status, "sending");
    assert.equal(stored.failureKind, "retryable");
    assert.match(stored.lastError, /chat_outbox_delivery_pending/);
    assert.ok(stored.nextAttemptAt);

    const second = await boot.drainChatOutbox(
      app,
      agentDir,
      h,
      { warn() {} },
      {
        chatKey: "telegram/1:2",
        itemId,
        sendTimeoutMs: 20,
      },
    );
    assert.deepEqual(second, []);
    assert.equal(sends, 1);
  });
});

test("chat boot keeps retryable outbox delivery failures queued", async () => {
  await withTempDir(async (agentDir) => {
    outbox.enqueueChatOutboxPayload(agentDir, {
      createdAt: new Date().toISOString(),
      chatKey: "telegram/1:2",
      parts: [{ type: "text", text: "hello" }],
    });

    const warnings = [];
    const app = {
      bots: [
        {
          platform: "telegram",
          selfId: "1",
          outboxUsesDispatchSignal: true,
          sendMessage() {
            const error = new Error("boom");
            const delivery = Promise.reject(error);
            delivery.dispatched = Promise.reject(error);
            return delivery;
          },
        },
      ],
    };
    const h = {
      text(content) {
        return { type: "text", attrs: { content } };
      },
      quote(id) {
        return { type: "quote", attrs: { id } };
      },
    };

    await boot.drainChatOutbox(app, agentDir, h, {
      warn(message) {
        warnings.push(String(message));
      },
    });

    const item = outbox.listChatOutboxItems(agentDir)[0].item;
    assert.equal(item.status, "queued");
    assert.equal(item.failureKind, "retryable");
    assert.ok(item.nextAttemptAt);
    assert.ok(
      warnings.some((message) => message.includes("chat outbox queued")),
    );
  });
});

test("chat boot gets media send bounds from the owning platform", () => {
  const app = {
    bots: [
      {
        platform: "example",
        selfId: "1",
        outboxMediaSendTimeoutMs: 600_000,
      },
    ],
  };
  const mediaItem = {
    payload: {
      createdAt: new Date().toISOString(),
      chatKey: "example/1:2",
      parts: [{ type: "file", path: "/tmp/pack.mrpack" }],
    },
  };
  assert.equal(boot.getChatOutboxSendTimeoutMs(mediaItem, {}, app), 600_000);
  assert.equal(
    boot.getChatOutboxSendTimeoutMs(
      {
        ...mediaItem,
        payload: {
          ...mediaItem.payload,
          parts: [{ type: "text", text: "plain" }],
        },
      },
      {},
      app,
    ),
    boot.DEFAULT_CHAT_OUTBOX_SEND_TIMEOUT_MS,
  );
  assert.equal(
    boot.getChatOutboxSendTimeoutMs(mediaItem, { sendTimeoutMs: 42 }, app),
    42,
  );
});

test("chat boot dispatches media outbox items asynchronously after starting delivery", async () => {
  await withTempDir(async (agentDir) => {
    const filePath = path.join(agentDir, "pack.mrpack");
    await fs.writeFile(filePath, Buffer.from("pack"));
    outbox.enqueueChatOutboxPayload(agentDir, {
      createdAt: new Date().toISOString(),
      chatKey: "telegram/1:2",
      parts: [
        {
          type: "file",
          path: filePath,
          name: "pack.mrpack",
          mimeType: "application/octet-stream",
        },
      ],
    });
    const itemId = outbox.listChatOutboxItems(agentDir)[0].item.id;
    let resolveDelivery;
    const app = {
      bots: [
        {
          platform: "telegram",
          selfId: "1",
          outboxUsesDispatchSignal: true,
          sendMessage() {
            return new Promise((resolve) => {
              resolveDelivery = resolve;
            });
          },
        },
      ],
    };
    const h = {
      text(content) {
        return { type: "text", attrs: { content } };
      },
      file(src, mimeType, attrs) {
        return { type: "file", attrs: { src, mimeType, ...attrs } };
      },
    };

    const results = await boot.drainChatOutbox(app, agentDir, h, { warn() {} });

    assert.equal(results[0].status, "dispatched");
    let stored = outbox.readChatOutboxItemById(agentDir, itemId).item;
    assert.equal(stored.status, "sending");
    assert.equal(stored.failureKind, "retryable");
    assert.equal(stored.attempts, 1);
    assert.match(stored.lastError, /chat_outbox_delivery_pending/);

    resolveDelivery(["m1"]);
    await waitFor(() => {
      stored = outbox.readChatOutboxItemById(agentDir, itemId).item;
      assert.equal(stored.status, "delivered");
      assert.deepEqual(stored.deliveryResult, ["m1"]);
    });
  });
});

test("chat boot dispatches non-media outbox items asynchronously when the platform advertises dispatch", async () => {
  await withTempDir(async (agentDir) => {
    outbox.enqueueChatOutboxPayload(agentDir, {
      createdAt: new Date().toISOString(),
      chatKey: "onebot/1:2",
      parts: [{ type: "text", text: "plain text" }],
    });
    const itemId = outbox.listChatOutboxItems(agentDir)[0].item.id;
    let resolveDelivery;
    const app = {
      bots: [
        {
          platform: "onebot",
          selfId: "1",
          outboxUsesDispatchSignal: true,
          sendMessage() {
            const delivery = new Promise((resolve) => {
              resolveDelivery = resolve;
            });
            delivery.dispatched = Promise.resolve();
            return delivery;
          },
        },
      ],
    };
    const h = {
      text(content) {
        return { type: "text", attrs: { content } };
      },
    };

    const results = await boot.drainChatOutbox(
      app,
      agentDir,
      h,
      { warn() {} },
      { sendTimeoutMs: 20, retryLeaseMs: 100 },
    );

    assert.equal(results[0].status, "dispatched");
    let stored = outbox.readChatOutboxItemById(agentDir, itemId).item;
    assert.equal(stored.status, "sending");
    assert.equal(stored.failureKind, "retryable");
    resolveDelivery(["m1"]);
    await waitFor(() => {
      stored = outbox.readChatOutboxItemById(agentDir, itemId).item;
      assert.equal(stored.status, "delivered");
      assert.deepEqual(stored.deliveryResult, ["m1"]);
    });
  });
});

test("chat boot does not retry ambiguous timeout after dispatch", async () => {
  await withTempDir(async (agentDir) => {
    outbox.enqueueChatOutboxPayload(agentDir, {
      createdAt: new Date().toISOString(),
      chatKey: "onebot/1:2",
      parts: [{ type: "text", text: "plain text" }],
    });
    const itemId = outbox.listChatOutboxItems(agentDir)[0].item.id;
    const app = {
      bots: [
        {
          platform: "onebot",
          selfId: "1",
          outboxUsesDispatchSignal: true,
          sendMessage() {
            const delivery = Promise.reject(
              new Error("onebot_action_timeout:send_group_msg"),
            );
            delivery.dispatched = Promise.resolve();
            return delivery;
          },
        },
      ],
    };
    const h = {
      text(content) {
        return { type: "text", attrs: { content } };
      },
      quote(id) {
        return { type: "quote", attrs: { id } };
      },
    };

    const results = await boot.drainChatOutbox(app, agentDir, h, { warn() {} });

    assert.equal(results[0].status, "dispatched");
    await waitFor(() => {
      const stored = outbox.readChatOutboxItemById(agentDir, itemId).item;
      assert.equal(stored.status, "delivered");
      assert.equal(stored.deliveryUnconfirmed, true);
      assert.equal(stored.attempts, 1);
      assert.match(stored.lastError, /onebot_action_timeout:send_group_msg/);
    });
    assert.deepEqual(outbox.listChatOutboxItems(agentDir), []);
  });
});
