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
const chatLog = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "chat-log.js")).href
);
const messageStore = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js"))
    .href
);
const messageQuery = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-query.js"))
    .href
);

async function withTempRoot(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-chat-log-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("chat chat log appends into unified message store and reads one day chat history", async () => {
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
      text: "Good morning",
      rawContent: "Good morning",
      strippedContent: "Good morning",
    });
    const appended = chatLog.appendChatLog(root, {
      timestamp: "2026-04-04T12:00:00.000Z",
      chatKey: "telegram/123:456",
      role: "user",
      text: "Good morning",
      messageId: "m1",
      nickname: "Alice",
    });
    messageStore.saveChatMessage(root, {
      messageId: "m2",
      role: "assistant",
      replyToMessageId: "m1",
      chatKey: "telegram/123:456",
      platform: "telegram",
      botId: "123",
      chatId: "456",
      chatType: "private",
      receivedAt: "2026-04-04T12:00:05.000Z",
      text: "Good morning!",
      rawContent: "Good morning!",
      strippedContent: "Good morning!",
    });

    assert.equal(
      appended?.filePath,
      messageStore.chatMessageLogPath(
        root,
        "telegram/123:456",
        "2026-04-04T12:00:00.000Z",
      ),
    );

    const stored = messageStore.getChatMessage(root, "telegram/123:456", "m1");
    assert.equal(stored?.role, "user");
    assert.equal(stored?.nickname, "Alice");
    assert.equal(stored?.trust, "OWNER");
    assert.equal(stored?.chatName, "Demo Chat");

    const { filePath, entries } = chatLog.readChatLog(
      root,
      "telegram/123:456",
      "2026-04-04",
    );
    assert.match(filePath, /chat[\\/]message-store[\\/]chat-log-view[\\/]/);
    assert.equal(entries.length, 2);
    assert.match(chatLog.formatChatLog(entries), /assistant: Good morning!/);
  });
});

test("chat message query returns canonical ID-only quote rich text", async () => {
  await withTempRoot(async (root) => {
    const chatKey = "telegram/123:456";
    messageStore.saveChatMessage(root, {
      messageId: "m2",
      role: "user",
      replyToMessageId: "m1",
      chatKey,
      platform: "telegram",
      botId: "123",
      chatId: "456",
      chatType: "private",
      receivedAt: "2026-04-04T12:00:02.000Z",
      text: "continue",
      elements: [{ type: "text", attrs: { content: "continue" } }],
      quote: {
        messageId: "m1",
        userId: "owner-1",
        nickname: "Owner",
        content: "must not expand",
      },
    });

    const message = messageQuery.getChatMessageRead(root, chatKey, "m2");
    assert.equal(Object.hasOwn(message, "quote"), false);
    assert.equal(Object.hasOwn(message, "replyToMessageId"), false);
    assert.deepEqual(message.elements, [
      { type: "quote", attrs: { id: "m1" }, children: [] },
      { type: "br", attrs: {}, children: [] },
      { type: "text", attrs: { content: "continue" } },
    ]);
  });
});

test("chat message store lists a bounded chat window by message-id cursors", async () => {
  await withTempRoot(async (root) => {
    const chatKey = "telegram/123:456";
    for (const [index, messageId] of ["m1", "m2", "m3", "m4"].entries()) {
      messageStore.saveChatMessage(root, {
        messageId,
        role: index % 2 === 0 ? "user" : "assistant",
        chatKey,
        platform: "telegram",
        botId: "123",
        chatId: "456",
        chatType: "private",
        receivedAt: `2026-04-04T12:00:0${index}.000Z`,
        text: messageId,
        elements: [{ type: "text", attrs: { content: messageId } }],
      });
    }

    const ids = (records) => records.map((record) => record.messageId);
    assert.deepEqual(
      ids(
        messageStore.listChatMessagesByChatWindow(root, {
          chatKey,
          limit: 2,
        }),
      ),
      ["m3", "m4"],
    );
    assert.deepEqual(
      ids(
        messageStore.listChatMessagesByChatWindow(root, {
          chatKey,
          before: "m4",
          limit: 2,
        }),
      ),
      ["m2", "m3"],
    );
    assert.deepEqual(
      ids(
        messageStore.listChatMessagesByChatWindow(root, {
          chatKey,
          after: "m1",
          limit: 2,
        }),
      ),
      ["m2", "m3"],
    );
    assert.deepEqual(
      ids(
        messageStore.listChatMessagesByChatWindow(root, {
          chatKey,
          after: "m1",
          before: "m4",
          limit: 5,
        }),
      ),
      ["m2", "m3"],
    );
  });
});

test("chat chat log preserves first-seen inbound timing after duplicate delivery", async () => {
  await withTempRoot(async (root) => {
    const chatKey = "lark/cli_bot:oc_chat";
    const messageId = "om_duplicate";
    messageStore.saveInboundChatMessage(root, {
      messageId,
      role: "user",
      chatKey,
      platform: "lark",
      botId: "cli_bot",
      chatId: "oc_chat",
      chatType: "group",
      receivedAt: "2026-07-10T03:14:50.500Z",
      acceptedAt: "2026-07-10T03:14:50.544Z",
      processedAt: "2026-07-10T03:14:50.544Z",
      text: "/usage",
    });
    messageStore.saveInboundChatMessage(root, {
      messageId,
      role: "user",
      chatKey,
      platform: "lark",
      botId: "cli_bot",
      chatId: "oc_chat",
      chatType: "group",
      receivedAt: "2026-07-10T03:15:00.581Z",
      text: "/usage",
    });

    chatLog.appendChatLog(root, {
      timestamp: "2026-07-10T03:15:00.581Z",
      chatKey,
      role: "user",
      text: "/usage",
      messageId,
    });

    const stored = messageStore.getChatMessage(root, chatKey, messageId);
    assert.equal(stored?.receivedAt, "2026-07-10T03:14:50.500Z");
    assert.equal(stored?.lastReceivedAt, "2026-07-10T03:15:00.581Z");
    assert.equal(stored?.duplicateCount, 1);
    assert.equal(stored?.acceptedAt, "2026-07-10T03:14:50.544Z");
    assert.equal(stored?.processedAt, "2026-07-10T03:14:50.544Z");
  });
});

test("chat chat log reuses message-store projection for fallback text and timestamp fields", async () => {
  await withTempRoot(async (root) => {
    messageStore.saveChatMessage(root, {
      messageId: "m-fallback",
      role: "assistant",
      chatKey: "telegram/123:456",
      platform: "telegram",
      botId: "123",
      chatId: "456",
      chatType: "private",
      receivedAt: "",
      processedAt: "2026-04-04T12:00:05.000Z",
      sessionFile: " /tmp/demo-session.jsonl ",
      text: "",
      rawContent: "  from raw content  ",
      strippedContent: "",
    });

    const { entries } = chatLog.readChatLog(
      root,
      "telegram/123:456",
      "2026-04-04",
    );
    assert.deepEqual(entries, [
      {
        version: 1,
        timestamp: "2026-04-04T12:00:05.000Z",
        chatKey: "telegram/123:456",
        role: "assistant",
        text: "from raw content",
        messageId: "m-fallback",
        replyToMessageId: undefined,
        sessionFile: "/tmp/demo-session.jsonl",
        userId: undefined,
        nickname: undefined,
      },
    ]);
  });
});
