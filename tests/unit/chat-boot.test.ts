import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const boot = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "boot.js")).href
);
const outbox = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "chat-outbox.js"))
    .href
);

test("chat boot exposes the dedicated chat command registry", () => {
  const rows = boot.getChatCommandRows();
  assert.equal(rows[0].name, "help");
  assert.deepEqual(
    rows.map((row) => row.name),
    ["help", "abort", "new", "compact", "reload", "status", "session", "model"],
  );
  assert.ok(!rows.some((row) => row.name === "init"));
});

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-boot-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("chat boot localizes command descriptions for Chinese runtimes", () => {
  const rows = boot.getChatCommandRows("zh_CN");
  assert.deepEqual(
    rows.map((row) => row.description),
    [
      "\u663e\u793a\u53ef\u7528\u547d\u4ee4",
      "\u4e2d\u6b62\u5f53\u524d\u64cd\u4f5c",
      "\u5f00\u59cb\u65b0\u4f1a\u8bdd",
      "\u538b\u7f29\u5f53\u524d\u4f1a\u8bdd",
      "\u91cd\u65b0\u52a0\u8f7d\u6269\u5c55\u3001\u63d0\u793a\u8bcd\u3001\u6280\u80fd\u548c\u4e3b\u9898",
      "\u663e\u793a\u5f53\u524d\u804a\u5929\u5904\u7406\u72b6\u6001",
      "\u663e\u793a\u5f53\u524d\u4f1a\u8bdd\u72b6\u6001",
      "\u663e\u793a\u6216\u5207\u6362\u5f53\u524d\u6a21\u578b",
    ],
  );
  assert.deepEqual(boot.buildTelegramCommandPayload(rows), [
    { command: "help", description: "\u663e\u793a\u53ef\u7528\u547d\u4ee4" },
    { command: "abort", description: "\u4e2d\u6b62\u5f53\u524d\u64cd\u4f5c" },
    { command: "new", description: "\u5f00\u59cb\u65b0\u4f1a\u8bdd" },
    { command: "compact", description: "\u538b\u7f29\u5f53\u524d\u4f1a\u8bdd" },
    {
      command: "reload",
      description:
        "\u91cd\u65b0\u52a0\u8f7d\u6269\u5c55\u3001\u63d0\u793a\u8bcd\u3001\u6280\u80fd\u548c\u4e3b\u9898",
    },
    {
      command: "status",
      description:
        "\u663e\u793a\u5f53\u524d\u804a\u5929\u5904\u7406\u72b6\u6001",
    },
    {
      command: "session",
      description: "\u663e\u793a\u5f53\u524d\u4f1a\u8bdd\u72b6\u6001",
    },
    {
      command: "model",
      description: "\u663e\u793a\u6216\u5207\u6362\u5f53\u524d\u6a21\u578b",
    },
  ]);
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

  const rows = boot.getChatCommandRows();
  const expectedPayload = [
    { command: "help", description: "Show available commands" },
    { command: "abort", description: "Abort current operation" },
    { command: "new", description: "Start a new session" },
    { command: "compact", description: "Compact the current session" },
    {
      command: "reload",
      description: "Reload extensions, prompts, skills, and themes",
    },
    { command: "status", description: "Show current chat processing status" },
    { command: "session", description: "Show current session status" },
    { command: "model", description: "Show or change the current model" },
  ];

  assert.deepEqual(boot.buildTelegramCommandPayload(rows), expectedPayload);
  assert.deepEqual(
    boot.buildTelegramCommandPayload([
      { name: "HELP", description: "override" },
      { name: "help", description: "ignored duplicate" },
      { name: "bad name" },
      { name: "status" },
    ]),
    [
      { command: "help", description: "override" },
      { command: "status", description: "status" },
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
      type: "text_delivery",
      createdAt: new Date().toISOString(),
      chatKey: "telegram/1:2",
      text: "hello",
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

test("chat boot drains a target chat without waiting for a slow different chat", async () => {
  await withTempDir(async (agentDir) => {
    outbox.enqueueChatOutboxPayload(agentDir, {
      type: "text_delivery",
      createdAt: new Date().toISOString(),
      chatKey: "telegram/1:slow",
      text: "slow image batch",
    });
    outbox.enqueueChatOutboxPayload(agentDir, {
      type: "text_delivery",
      createdAt: new Date().toISOString(),
      chatKey: "telegram/1:fast",
      text: "fast reply",
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
    assert.ok(
      outbox.readChatOutboxItem(
        agentDir,
        outbox.chatOutboxHistoryItemPath(agentDir, fastId, "delivered"),
      ),
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
      type: "text_delivery",
      createdAt: new Date().toISOString(),
      chatKey: "telegram/1:2",
      text: "stuck send",
    });
    const itemId = outbox.listChatOutboxItems(agentDir)[0].item.id;
    let sends = 0;
    const app = {
      bots: [
        {
          platform: "telegram",
          selfId: "1",
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

    assert.equal(results[0].status, "queued");
    const stored = outbox.listChatOutboxItems(agentDir)[0].item;
    assert.equal(stored.status, "sending");
    assert.equal(stored.failureKind, "retryable");
    assert.match(stored.lastError, /chat_outbox_delivery_timeout/);
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
      type: "text_delivery",
      createdAt: new Date().toISOString(),
      chatKey: "telegram/1:2",
      text: "hello",
    });

    const warnings = [];
    const app = {
      bots: [
        {
          platform: "telegram",
          selfId: "1",
          async sendMessage() {
            throw new Error("boom");
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
