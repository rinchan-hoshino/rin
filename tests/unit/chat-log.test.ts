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
const chatLog = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "chat-log.js")).href
);
const messageStore = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js"))
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
