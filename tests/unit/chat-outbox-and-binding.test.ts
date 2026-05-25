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
const outbox = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "chat-outbox.js"))
    .href
);
const boot = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "boot.js")).href
);
const support = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href
);
const transport = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "transport.js")).href
);
const messageStore = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js"))
    .href
);

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-outbox-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("chat outbox enqueues payload on disk", async () => {
  await withTempDir(async (dir) => {
    const filePath = outbox.enqueueChatOutboxPayload(dir, {
      type: "text_delivery",
      createdAt: new Date().toISOString(),
      chatKey: "telegram/777:1",
      text: "hello",
    });
    const stat = await fs.stat(filePath);
    assert.ok(stat.isFile());
  });
});

test("chat outbox retries queued payloads after send failure", async () => {
  await withTempDir(async (dir) => {
    outbox.enqueueChatOutboxPayload(dir, {
      type: "text_delivery",
      createdAt: new Date().toISOString(),
      chatKey: "telegram/777:1",
      text: "retry me",
    });
    const deliveries = [];
    const app = {
      bots: [
        {
          platform: "telegram",
          selfId: "777",
          async sendMessage(_chatId, content) {
            deliveries.push(content?.[0]?.attrs?.content);
            if (deliveries.length === 1) throw new Error("network down");
            return ["m-retry"];
          },
        },
      ],
    };
    const h = {
      text(content) {
        return { type: "text", attrs: { content } };
      },
    };
    const logger = { warn() {} };

    let results = await boot.drainChatOutbox(app, dir, h, logger);
    assert.equal(results[0].status, "queued");
    const stored = outbox.listChatOutboxItems(dir)[0].item;
    assert.equal(stored.status, "queued");
    assert.equal(stored.failureKind, "retryable");
    assert.ok(stored.nextAttemptAt);
    assert.ok(Date.parse(stored.nextAttemptAt) - Date.now() <= 1500);

    results = await boot.drainChatOutbox(app, dir, h, logger);
    assert.deepEqual(results, []);

    outbox.writeChatOutboxItem(dir, {
      ...stored,
      nextAttemptAt: new Date(Date.now() - 1000).toISOString(),
    });
    results = await boot.drainChatOutbox(app, dir, h, logger);
    assert.equal(results[0].status, "delivered");
    assert.deepEqual(deliveries, ["retry me", "retry me"]);
    assert.equal(outbox.listChatOutboxItems(dir)[0].item.status, "delivered");
  });
});

test("chat outbox stops retrying after repeated transient failures", async () => {
  await withTempDir(async (dir) => {
    outbox.enqueueChatOutboxPayload(dir, {
      type: "text_delivery",
      createdAt: new Date().toISOString(),
      chatKey: "telegram/777:1",
      text: "stop retrying",
    });
    const stored = outbox.listChatOutboxItems(dir)[0].item;
    outbox.writeChatOutboxItem(dir, { ...stored, attempts: 3 });
    const app = {
      bots: [
        {
          platform: "telegram",
          selfId: "777",
          async sendMessage() {
            throw new Error("network still down");
          },
        },
      ],
    };
    const h = {
      text(content) {
        return { type: "text", attrs: { content } };
      },
    };
    const logger = { warn() {} };

    const results = await boot.drainChatOutbox(app, dir, h, logger);
    assert.equal(results[0].status, "failed");
    const failed = outbox.listChatOutboxItems(dir)[0].item;
    assert.equal(failed.status, "failed");
    assert.equal(failed.failureKind, "attempts_exhausted");
  });
});

test("chat outbox fails permanent delivery errors without retrying", async () => {
  await withTempDir(async (dir) => {
    outbox.enqueueChatOutboxPayload(dir, {
      type: "text_delivery",
      createdAt: new Date().toISOString(),
      chatKey: "telegram/777:1",
      text: "no bot",
    });
    const h = {
      text(content) {
        return { type: "text", attrs: { content } };
      },
    };
    const logger = { warn() {} };

    const results = await boot.drainChatOutbox({ bots: [] }, dir, h, logger);
    assert.equal(results[0].status, "failed");
    const stored = outbox.listChatOutboxItems(dir)[0].item;
    assert.equal(stored.status, "failed");
    assert.equal(stored.failureKind, "permanent");
    assert.equal(stored.nextAttemptAt, undefined);
  });
});

test("chat outbox treats platform permission errors as permanent", async () => {
  await withTempDir(async (dir) => {
    outbox.enqueueChatOutboxPayload(dir, {
      type: "text_delivery",
      createdAt: new Date().toISOString(),
      chatKey: "telegram/777:1",
      text: "blocked",
    });
    const app = {
      bots: [
        {
          platform: "telegram",
          selfId: "777",
          async sendMessage() {
            throw new Error("Forbidden: bot was blocked by the user");
          },
        },
      ],
    };
    const h = {
      text(content) {
        return { type: "text", attrs: { content } };
      },
    };
    const logger = { warn() {} };

    const results = await boot.drainChatOutbox(app, dir, h, logger);
    assert.equal(results[0].status, "failed");
    const stored = outbox.listChatOutboxItems(dir)[0].item;
    assert.equal(stored.status, "failed");
    assert.equal(stored.failureKind, "permanent");
  });
});

test("chat assistant delivery stores session only for conversation binding", async () => {
  await withTempDir(async (dir) => {
    transport.recordDeliveredAssistantMessages(dir, {
      chatKey: "telegram/777:1",
      deliveryResult: ["m1"],
      text: "tool send",
      sessionFile: "/tmp/ignored.jsonl",
    });
    transport.recordDeliveredAssistantMessages(dir, {
      chatKey: "telegram/777:1",
      deliveryResult: ["m2"],
      text: "normal reply",
      sessionFile: "/tmp/kept.jsonl",
      sessionBinding: "conversation",
    });

    assert.equal(
      messageStore.getChatMessage(dir, "telegram/777:1", "m1")?.sessionFile,
      undefined,
    );
    assert.equal(
      messageStore.getChatMessage(dir, "telegram/777:1", "m2")?.sessionFile,
      "/tmp/kept.jsonl",
    );
  });
});

test("chat state paths stay stable", () => {
  const statePath = support.chatStatePath("/tmp/rin-data", "telegram/777:1");
  assert.ok(
    statePath.endsWith(
      path.join("chat", "session-state", "telegram", "777", "1", "state.json"),
    ),
  );
});

test("chat state rejects legacy telegram chat keys without bot id", () => {
  assert.throws(
    () => support.chatStatePath("/tmp/rin-data", "telegram:1"),
    /invalid_chatKey:telegram:1/,
  );
});

test("chat state discovery ignores legacy telegram state dirs", async () => {
  await withTempDir(async (dir) => {
    const chatsRoot = path.join(dir, "chats");
    await fs.mkdir(path.join(chatsRoot, "telegram", "legacy-chat"), {
      recursive: true,
    });
    await fs.mkdir(path.join(chatsRoot, "telegram", "777", "scoped-chat"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(chatsRoot, "telegram", "legacy-chat", "state.json"),
      "{}\n",
    );
    await fs.writeFile(
      path.join(chatsRoot, "telegram", "777", "scoped-chat", "state.json"),
      "{}\n",
    );

    assert.deepEqual(support.listChatStateFiles(chatsRoot), [
      {
        chatKey: "telegram/777:scoped-chat",
        statePath: path.join(
          chatsRoot,
          "telegram",
          "777",
          "scoped-chat",
          "state.json",
        ),
      },
    ]);
  });
});
