import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const messageStore = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js"))
    .href
);

async function withTempRoot(fn) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-message-store-"),
  );
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function chatDateIndexPath(root, date) {
  return path.join(
    root,
    "data",
    "chat",
    "message-store",
    "indexes",
    "by-chat-date",
    "telegram",
    "123",
    "456",
    `${date}.json`,
  );
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

test("message store eagerly maintains chat-date indexes while preserving chat-day reads", async () => {
  await withTempRoot(async (root) => {
    messageStore.saveChatMessage(root, {
      messageId: "m1",
      role: "user",
      chatKey: "telegram/123:456",
      platform: "telegram",
      botId: "123",
      chatId: "456",
      chatType: "private",
      receivedAt: "2026-04-04T12:00:00.000Z",
      text: "first",
      rawContent: "first",
      strippedContent: "first",
    });
    messageStore.saveChatMessage(root, {
      messageId: "m2",
      role: "assistant",
      chatKey: "telegram/123:456",
      platform: "telegram",
      botId: "123",
      chatId: "456",
      chatType: "private",
      receivedAt: "2026-04-04T12:00:05.000Z",
      text: "second",
      rawContent: "second",
      strippedContent: "second",
    });
    messageStore.saveChatMessage(root, {
      messageId: "other",
      role: "user",
      chatKey: "telegram/123:789",
      platform: "telegram",
      botId: "123",
      chatId: "789",
      chatType: "private",
      receivedAt: "2026-04-04T08:00:00.000Z",
      text: "noise",
      rawContent: "noise",
      strippedContent: "noise",
    });

    const indexPath = chatDateIndexPath(root, "2026-04-04");
    assert.deepEqual(await readJson(indexPath), {
      version: 1,
      recordKeys: [
        messageStore.buildChatMessageRecordKey("telegram/123:456", "m1"),
        messageStore.buildChatMessageRecordKey("telegram/123:456", "m2"),
      ],
    });

    messageStore.saveChatMessage(root, {
      messageId: "m3",
      role: "user",
      chatKey: "telegram/123:456",
      platform: "telegram",
      botId: "123",
      chatId: "456",
      chatType: "private",
      receivedAt: "2026-04-04T12:00:10.000Z",
      text: "third",
      rawContent: "third",
      strippedContent: "third",
    });

    assert.deepEqual(await readJson(indexPath), {
      version: 1,
      recordKeys: [
        messageStore.buildChatMessageRecordKey("telegram/123:456", "m1"),
        messageStore.buildChatMessageRecordKey("telegram/123:456", "m2"),
        messageStore.buildChatMessageRecordKey("telegram/123:456", "m3"),
      ],
    });
    assert.deepEqual(
      messageStore
        .listChatMessagesByChatAndDate(root, "telegram/123:456", "2026-04-04")
        .map((item) => item.messageId),
      ["m1", "m2", "m3"],
    );
  });
});

test("message store backfills a missing chat-date index from existing records", async () => {
  await withTempRoot(async (root) => {
    messageStore.saveChatMessage(root, {
      messageId: "m1",
      role: "user",
      chatKey: "telegram/123:456",
      platform: "telegram",
      botId: "123",
      chatId: "456",
      chatType: "private",
      receivedAt: "2026-04-04T12:00:00.000Z",
      text: "first",
      rawContent: "first",
      strippedContent: "first",
    });
    messageStore.saveChatMessage(root, {
      messageId: "m2",
      role: "assistant",
      chatKey: "telegram/123:456",
      platform: "telegram",
      botId: "123",
      chatId: "456",
      chatType: "private",
      receivedAt: "2026-04-04T12:00:05.000Z",
      text: "second",
      rawContent: "second",
      strippedContent: "second",
    });

    const indexPath = chatDateIndexPath(root, "2026-04-04");
    await fs.rm(indexPath, { force: true });
    await assert.rejects(fs.access(indexPath));

    const rebuilt = messageStore.listChatMessagesByChatAndDate(
      root,
      "telegram/123:456",
      "2026-04-04",
    );
    assert.deepEqual(
      rebuilt.map((item) => item.messageId),
      ["m1", "m2"],
    );
    assert.deepEqual(await readJson(indexPath), {
      version: 1,
      recordKeys: [
        messageStore.buildChatMessageRecordKey("telegram/123:456", "m1"),
        messageStore.buildChatMessageRecordKey("telegram/123:456", "m2"),
      ],
    });
  });
});

test("message store removes stale chat-date index entries when indexed records move to another day", async () => {
  await withTempRoot(async (root) => {
    messageStore.saveChatMessage(root, {
      messageId: "m1",
      role: "user",
      chatKey: "telegram/123:456",
      platform: "telegram",
      botId: "123",
      chatId: "456",
      chatType: "private",
      receivedAt: "2026-04-04T12:00:00.000Z",
      text: "first",
      rawContent: "first",
      strippedContent: "first",
    });

    assert.equal(
      messageStore.listChatMessagesByChatAndDate(
        root,
        "telegram/123:456",
        "2026-04-04",
      ).length,
      1,
    );

    messageStore.updateChatMessage(root, "telegram/123:456", "m1", {
      receivedAt: "2026-04-05T09:30:00.000Z",
    });

    const dayOneIndex = await readJson(chatDateIndexPath(root, "2026-04-04"));
    assert.deepEqual(dayOneIndex, { version: 1, recordKeys: [] });
    assert.equal(
      messageStore.listChatMessagesByChatAndDate(
        root,
        "telegram/123:456",
        "2026-04-04",
      ).length,
      0,
    );

    const nextDay = messageStore.listChatMessagesByChatAndDate(
      root,
      "telegram/123:456",
      "2026-04-05",
    );
    assert.deepEqual(
      nextDay.map((item) => item.messageId),
      ["m1"],
    );
    assert.deepEqual(await readJson(chatDateIndexPath(root, "2026-04-05")), {
      version: 1,
      recordKeys: [
        messageStore.buildChatMessageRecordKey("telegram/123:456", "m1"),
      ],
    });
  });
});

test("message store upsert keeps existing metadata while moving a record to a new day", async () => {
  await withTempRoot(async (root) => {
    messageStore.saveChatMessage(root, {
      messageId: "m1",
      role: "user",
      chatKey: "telegram/123:456",
      platform: "telegram",
      botId: "123",
      chatId: "456",
      chatType: "private",
      receivedAt: "2026-04-04T12:00:00.000Z",
      nickname: "Alice",
      trust: "OWNER",
      chatName: "Demo Chat",
      text: "first",
      rawContent: "first",
      strippedContent: "first",
    });

    const updated = messageStore.upsertChatMessage(root, {
      messageId: "m1",
      role: "user",
      chatKey: "telegram/123:456",
      platform: "telegram",
      botId: "123",
      chatId: "456",
      chatType: "private",
      receivedAt: "2026-04-05T09:30:00.000Z",
      text: "updated",
      rawContent: "updated",
      strippedContent: "updated",
    });

    assert.equal(updated.receivedAt, "2026-04-05T09:30:00.000Z");
    assert.equal(updated.nickname, "Alice");
    assert.equal(updated.trust, "OWNER");
    assert.equal(updated.chatName, "Demo Chat");
    assert.equal(
      messageStore.listChatMessagesByChatAndDate(
        root,
        "telegram/123:456",
        "2026-04-04",
      ).length,
      0,
    );
    assert.deepEqual(
      messageStore
        .listChatMessagesByChatAndDate(root, "telegram/123:456", "2026-04-05")
        .map((item) => item.messageId),
      ["m1"],
    );
    assert.deepEqual(await readJson(chatDateIndexPath(root, "2026-04-04")), {
      version: 1,
      recordKeys: [],
    });
    assert.deepEqual(await readJson(chatDateIndexPath(root, "2026-04-05")), {
      version: 1,
      recordKeys: [
        messageStore.buildChatMessageRecordKey("telegram/123:456", "m1"),
      ],
    });
  });
});

test("message store inbound duplicate keeps the existing first-seen timestamp even if incoming is earlier", async () => {
  await withTempRoot(async (root) => {
    const chatKey = "lark/bot-1:oc-demo";
    const base = {
      messageId: "m1",
      role: "user",
      chatKey,
      platform: "lark",
      botId: "bot-1",
      chatId: "oc-demo",
      chatType: "group",
      text: "first",
      rawContent: "first",
      strippedContent: "first",
    };
    messageStore.saveChatMessage(root, {
      ...base,
      receivedAt: "2026-07-02T11:23:00.000Z",
      processedAt: "2026-07-02T11:23:02.000Z",
    });

    const updated = messageStore.saveInboundChatMessage(root, {
      ...base,
      receivedAt: "2026-07-02T11:22:00.000Z",
      text: "first duplicate",
      rawContent: "first duplicate",
      strippedContent: "first duplicate",
    }).record;

    assert.equal(updated.receivedAt, "2026-07-02T11:23:00.000Z");
    assert.equal(updated.processedAt, "2026-07-02T11:23:02.000Z");
    assert.equal(updated.duplicateCount, 1);
    assert.deepEqual(
      messageStore
        .listChatMessagesByChatAndDate(root, chatKey, "2026-07-02")
        .map((item) => item.messageId),
      ["m1"],
    );
  });
});

test("message store always uses the preferred root even if a previous root still exists", async () => {
  await withTempRoot(async (root) => {
    await fs.mkdir(path.join(root, "data", "koishi-message-store"), {
      recursive: true,
    });

    assert.equal(
      messageStore.chatMessageStoreDir(root),
      path.join(root, "data", "chat", "message-store"),
    );
    assert.equal(
      messageStore.chatMessageLogPath(
        root,
        "telegram/123:456",
        "2026-04-04T12:00:00.000Z",
      ),
      path.join(
        root,
        "data",
        "chat",
        "message-store",
        "chat-log-view",
        "telegram",
        "123",
        "456",
        "2026-04-04.txt",
      ),
    );
  });
});

test("message store record formatters stay aligned across detail and summary output", () => {
  const record = {
    messageId: "m1",
    chatKey: "telegram/123:456",
    role: "assistant",
    replyToMessageId: "m0",
    sessionFile: "/tmp/session.jsonl",
    userId: "user-1",
    nickname: "Rin",
    chatName: "demo room",
    trust: "TRUSTED",
    receivedAt: "2026-04-05T09:30:00.000Z",
    text: "hello world",
  };

  assert.equal(
    messageStore.describeChatMessageRecord(record),
    [
      "messageId=m1",
      "chatKey=telegram/123:456",
      "role=assistant",
      "replyToMessageId=m0",
      "sessionFile=/tmp/session.jsonl",
      "userId=user-1",
      "nickname=Rin",
      "chatName=demo room",
      "trust=TRUSTED",
      "receivedAt=2026-04-05T09:30:00.000Z",
      "text=hello world",
    ].join("\n"),
  );
  assert.equal(
    messageStore.summarizeChatMessageRecord(record),
    [
      "- message id: m1",
      "- chatKey: telegram/123:456",
      "- role: assistant",
      "- reply to: m0",
      "- session file: /tmp/session.jsonl",
      "- sender user id: user-1",
      "- sender nickname: Rin",
      "- chat name: demo room",
      "- sender trust: TRUSTED",
      "- received at: 2026-04-05T09:30:00.000Z",
      "- text: hello world",
    ].join("\n"),
  );
  assert.equal(
    messageStore.summarizeChatMessageRecord({
      messageId: "m1",
      chatKey: "telegram/123:456",
    }),
    ["- message id: m1", "- chatKey: telegram/123:456"].join("\n"),
  );
});
