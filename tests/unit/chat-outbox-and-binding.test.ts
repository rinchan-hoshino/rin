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

test("chat outbox accepts SDK-style text and parts payloads", async () => {
  await withTempDir(async (dir) => {
    outbox.enqueueChatOutboxPayload(dir, {
      chatKey: "telegram/777:1",
      text: "plain sdk text",
    });
    outbox.enqueueChatOutboxPayload(dir, {
      chatKey: "telegram/777:1",
      parts: [
        { type: "text", text: "sdk parts text" },
        { type: "image", path: "/tmp/example.png", mimeType: "image/png" },
      ],
    });

    const queued = outbox.listChatOutboxItems(dir).map(({ item }) => item);
    assert.equal(queued[0].payload.type, "text_delivery");
    assert.equal(queued[0].payload.text, "plain sdk text");
    assert.equal(queued[1].payload.type, "parts_delivery");
    assert.equal(queued[1].payload.parts.length, 2);

    const sent = [];
    function h(type, attrs) {
      return { type, attrs };
    }
    h.text = (content) => ({ type: "text", attrs: { content } });
    h.markdown = (content) => ({ type: "markdown", attrs: { content } });
    h.quote = (id) => ({ type: "quote", attrs: { id } });
    h.file = (src, mimeType, attrs) => ({
      type: "file",
      attrs: { src, mimeType, ...attrs },
    });
    const app = {
      bots: [
        {
          platform: "telegram",
          selfId: "777",
          async sendMessage(chatId, content) {
            sent.push({ chatId, content });
            return [`m-${sent.length}`];
          },
        },
      ],
    };

    const results = await boot.drainChatOutbox(app, dir, h, { warn() {} });
    assert.deepEqual(
      results.map((result) => result.status),
      ["delivered", "delivered"],
    );
    assert.equal(sent.length, 2);
    assert.equal(sent[0].content[0].attrs.content, "plain sdk text");
    assert.equal(sent[1].content[0].attrs.content, "sdk parts text");
    assert.equal(sent[1].content[1].type, "image");
  });
});

test("chat outbox rejects SDK-style empty payloads before enqueue", async () => {
  await withTempDir(async (dir) => {
    assert.throws(
      () => outbox.enqueueChatOutboxPayload(dir, { chatKey: "telegram/777:1" }),
      /chat_outbox_invalid_payload/,
    );
    assert.deepEqual(outbox.listChatOutboxItems(dir), []);
  });
});

test("chat outbox archives legacy completed items out of the active queue", async () => {
  await withTempDir(async (dir) => {
    outbox.enqueueChatOutboxPayload(dir, {
      type: "text_delivery",
      createdAt: new Date().toISOString(),
      chatKey: "telegram/777:1",
      text: "already sent",
    });
    const queued = outbox.listChatOutboxItems(dir)[0].item;
    await fs.writeFile(
      outbox.chatOutboxItemPath(dir, queued.id),
      `${JSON.stringify({
        ...queued,
        status: "delivered",
        deliveredAt: new Date().toISOString(),
      })}\n`,
    );

    assert.deepEqual(outbox.listChatOutboxItems(dir), []);
    await assert.rejects(fs.stat(outbox.chatOutboxItemPath(dir, queued.id)));
    assert.equal(
      outbox.readChatOutboxItem(
        dir,
        outbox.chatOutboxHistoryItemPath(dir, queued.id, "delivered"),
      ).status,
      "delivered",
    );
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
    assert.deepEqual(outbox.listChatOutboxItems(dir), []);
    assert.ok(
      await fs.stat(
        outbox.chatOutboxHistoryItemPath(dir, stored.id, "delivered"),
      ),
    );
  });
});

test("chat outbox fails partial delivery errors without retrying", async () => {
  await withTempDir(async (dir) => {
    outbox.enqueueChatOutboxPayload(dir, {
      type: "text_delivery",
      createdAt: new Date().toISOString(),
      chatKey: "telegram/777:1",
      text: "partial send",
    });
    const app = {
      bots: [
        {
          platform: "telegram",
          selfId: "777",
          async sendMessage() {
            throw Object.assign(
              new Error("chat_delivery_partial:network down"),
              {
                deliveredMessageIds: ["m-before-failure"],
                partialDelivery: true,
              },
            );
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
    assert.deepEqual(outbox.listChatOutboxItems(dir), []);
    const failed = outbox.readChatOutboxItem(
      dir,
      outbox.chatOutboxHistoryItemPath(dir, results[0].id, "failed"),
    );
    assert.equal(failed.status, "failed");
    assert.equal(failed.failureKind, "permanent");
    assert.equal(failed.nextAttemptAt, undefined);
    assert.deepEqual(failed.deliveryResult, ["m-before-failure"]);
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
    assert.deepEqual(outbox.listChatOutboxItems(dir), []);
    const failed = outbox.readChatOutboxItem(
      dir,
      outbox.chatOutboxHistoryItemPath(dir, results[0].id, "failed"),
    );
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
    assert.deepEqual(outbox.listChatOutboxItems(dir), []);
    const stored = outbox.readChatOutboxItem(
      dir,
      outbox.chatOutboxHistoryItemPath(dir, results[0].id, "failed"),
    );
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
    assert.deepEqual(outbox.listChatOutboxItems(dir), []);
    const stored = outbox.readChatOutboxItem(
      dir,
      outbox.chatOutboxHistoryItemPath(dir, results[0].id, "failed"),
    );
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

test("chat outbox history cleanup applies 7 day delivered and 14 day failed retention", async () => {
  await withTempDir(async (dir) => {
    const nowMs = Date.parse("2026-06-17T00:00:00.000Z");
    const daysAgo = (days) =>
      new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString();
    const makePayload = (text) => ({
      type: "text_delivery",
      createdAt: daysAgo(20),
      chatKey: "telegram/777:1",
      text,
    });
    const baseItem = (id, status, updatedAt) => ({
      id,
      status,
      createdAt: updatedAt,
      updatedAt,
      sequence: Date.parse(updatedAt),
      deliveryKind: "generic",
      payload: makePayload(id),
      attempts: 1,
    });

    outbox.writeChatOutboxItem(dir, {
      ...baseItem("old-delivered", "delivered", daysAgo(8)),
      deliveredAt: daysAgo(8),
      deliveryResult: ["m-old-delivered"],
    });
    outbox.writeChatOutboxItem(dir, {
      ...baseItem("fresh-delivered", "delivered", daysAgo(6)),
      deliveredAt: daysAgo(6),
      deliveryResult: ["m-fresh-delivered"],
    });
    outbox.writeChatOutboxItem(dir, {
      ...baseItem("old-failed", "failed", daysAgo(15)),
      failedAt: daysAgo(15),
      failureKind: "permanent",
      lastError: "old failure",
    });
    outbox.writeChatOutboxItem(dir, {
      ...baseItem("fresh-failed", "failed", daysAgo(13)),
      failedAt: daysAgo(13),
      failureKind: "permanent",
      lastError: "fresh failure",
    });
    outbox.writeChatOutboxItem(dir, {
      ...baseItem("active-queued", "queued", daysAgo(20)),
      attempts: 0,
    });

    const result = outbox.cleanupChatOutboxHistory(dir, { nowMs });

    assert.deepEqual(result, { delivered: 1, failed: 1 });
    await assert.rejects(
      fs.stat(
        outbox.chatOutboxHistoryItemPath(dir, "old-delivered", "delivered"),
      ),
    );
    await assert.rejects(
      fs.stat(outbox.chatOutboxHistoryItemPath(dir, "old-failed", "failed")),
    );
    assert.equal(
      outbox.readChatOutboxItem(
        dir,
        outbox.chatOutboxHistoryItemPath(dir, "fresh-delivered", "delivered"),
      ).status,
      "delivered",
    );
    assert.equal(
      outbox.readChatOutboxItem(
        dir,
        outbox.chatOutboxHistoryItemPath(dir, "fresh-failed", "failed"),
      ).status,
      "failed",
    );
    assert.deepEqual(
      outbox.listChatOutboxItems(dir).map(({ item }) => item.id),
      ["active-queued"],
    );
  });
});
