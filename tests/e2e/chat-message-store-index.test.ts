import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const messageStore = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js"))
    .href
);
const chatDatabase = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "database.js")).href
);
const chatHelpers = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "chat-helpers.js"))
    .href
);

async function withTempRoot(fn) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-message-store-"),
  );
  try {
    await fn(root);
  } finally {
    chatDatabase.closeChatDatabase(root);
    await fs.rm(root, { recursive: true, force: true });
  }
}

function runNodeProcess(code, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`child_exit_${code}:${stderr}`));
    });
  });
}

function messageInput(overrides = {}) {
  return {
    messageId: "message-1",
    role: "user",
    chatKey: "telegram/123:456",
    platform: "telegram",
    botId: "123",
    chatId: "456",
    receivedAt: "2026-04-04T12:00:00.000Z",
    text: "hello",
    ...overrides,
  };
}

test("SQLite message store preserves chat-local day reads without filesystem indexes", async () => {
  await withTempRoot(async (root) => {
    const saved = messageStore.saveChatMessage(
      root,
      messageInput({ platformTimestamp: null }),
    );
    assert.equal(Object.hasOwn(saved, "filePath"), false);
    assert.equal(
      chatDatabase
        .openChatDatabase(root)
        .prepare(`SELECT platform_timestamp FROM messages WHERE id = ?`)
        .get(saved.record.recordKey).platform_timestamp,
      null,
    );
    messageStore.saveChatMessage(
      root,
      messageInput({
        messageId: "message-2",
        receivedAt: "2026-04-05T12:00:00.000Z",
        text: "tomorrow",
      }),
    );

    assert.deepEqual(
      messageStore
        .listChatMessagesByChatAndDate(root, "telegram/123:456", "2026-04-04")
        .map((item) => item.messageId),
      ["message-1"],
    );
    assert.deepEqual(
      messageStore
        .listChatMessagesByChatAndDate(root, "telegram/123:456", "2026-04-05")
        .map((item) => item.messageId),
      ["message-2"],
    );

    const datePlan = chatDatabase
      .openChatDatabase(root)
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT record_json FROM messages
         WHERE chat_key = ? AND received_at >= ? AND received_at < ?
         ORDER BY received_at, record_key`,
      )
      .all("telegram/123:456", "2026-04-04", "2026-04-05")
      .map((row) => String(row.detail || ""))
      .join("\n");
    assert.match(datePlan, /messages_chat_date_idx/);
    const fallbackDatePlan = chatDatabase
      .openChatDatabase(root)
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT record_json FROM messages
         WHERE chat_key = ? AND received_at = ''
           AND processed_at >= ? AND processed_at < ?
         ORDER BY processed_at, record_key`,
      )
      .all("telegram/123:456", "2026-04-04", "2026-04-05")
      .map((row) => String(row.detail || ""))
      .join("\n");
    assert.match(fallbackDatePlan, /messages_chat_processed_date_idx/);

    await assert.rejects(
      fs.stat(path.join(root, "data", "chat", "message-store", "records")),
    );
    assert.ok((await fs.stat(chatDatabase.chatDatabasePath(root))).isFile());
  });
});

test("SQLite message store updates day projections without stale index entries", async () => {
  await withTempRoot(async (root) => {
    messageStore.saveChatMessage(root, messageInput());
    messageStore.updateChatMessage(root, "telegram/123:456", "message-1", {
      receivedAt: "2026-04-05T09:00:00.000Z",
      text: "moved",
    });

    assert.deepEqual(
      messageStore.listChatMessagesByChatAndDate(
        root,
        "telegram/123:456",
        "2026-04-04",
      ),
      [],
    );
    assert.equal(
      messageStore.listChatMessagesByChatAndDate(
        root,
        "telegram/123:456",
        "2026-04-05",
      )[0].text,
      "moved",
    );
  });
});

test("SQLite message store upsert preserves existing metadata while updating content", async () => {
  await withTempRoot(async (root) => {
    messageStore.saveChatMessage(
      root,
      messageInput({
        acceptedAt: "2026-04-04T12:00:01.000Z",
        sessionFile: "/tmp/original.jsonl",
      }),
    );
    messageStore.upsertChatMessage(
      root,
      messageInput({
        receivedAt: "2026-04-05T10:00:00.000Z",
        text: "updated",
      }),
    );

    const stored = messageStore.getChatMessage(
      root,
      "telegram/123:456",
      "message-1",
    );
    assert.equal(stored.text, "updated");
    assert.equal(stored.acceptedAt, "2026-04-04T12:00:01.000Z");
    assert.equal(stored.sessionFile, "/tmp/original.jsonl");
    assert.equal(
      messageStore.listChatMessagesByChatAndDate(
        root,
        "telegram/123:456",
        "2026-04-05",
      ).length,
      1,
    );
  });
});

test("SQLite message store inbound duplicate keeps first-seen state and richer content", async () => {
  await withTempRoot(async (root) => {
    messageStore.saveInboundChatMessage(
      root,
      messageInput({
        text: "hi",
        processedAt: "2026-04-04T12:00:02.000Z",
      }),
    );
    messageStore.saveInboundChatMessage(
      root,
      messageInput({
        receivedAt: "2026-04-04T11:59:00.000Z",
        text: "hello with richer content",
      }),
    );

    const stored = messageStore.getChatMessage(
      root,
      "telegram/123:456",
      "message-1",
    );
    assert.equal(stored.receivedAt, "2026-04-04T12:00:00.000Z");
    assert.equal(stored.text, "hello with richer content");
    assert.equal(stored.processedAt, "2026-04-04T12:00:02.000Z");
    assert.equal(stored.duplicateCount, 1);
    assert.equal(stored.lastReceivedAt, "2026-04-04T12:00:00.000Z");
  });
});

test("SQLite inbound duplicate merge is serialized across process connections", async () => {
  await withTempRoot(async (root) => {
    messageStore.saveInboundChatMessage(
      root,
      messageInput({
        text: "initial",
        processedAt: "2026-04-04T12:00:02.000Z",
      }),
    );
    chatDatabase.closeChatDatabase(root);

    const moduleUrl = pathToFileURL(
      path.join(rootDir, "dist", "core", "chat", "message-store.js"),
    ).href;
    const childCode = `
      const store = await import(process.env.MESSAGE_STORE_URL);
      store.saveInboundChatMessage(process.env.AGENT_DIR, {
        messageId: 'message-1', role: 'user', chatKey: 'telegram/123:456',
        platform: 'telegram', botId: '123', chatId: '456',
        receivedAt: '2026-04-04T12:00:00.000Z', text: process.env.MESSAGE_TEXT
      });
    `;
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        runNodeProcess(childCode, {
          MESSAGE_STORE_URL: moduleUrl,
          AGENT_DIR: root,
          MESSAGE_TEXT: `duplicate-${index}-${"x".repeat(index)}`,
        }),
      ),
    );

    const stored = messageStore.getChatMessage(
      root,
      "telegram/123:456",
      "message-1",
    );
    assert.equal(stored.duplicateCount, 8);
    assert.equal(stored.processedAt, "2026-04-04T12:00:02.000Z");
    assert.equal(stored.text, `duplicate-7-${"x".repeat(7)}`);
  });
});

test("message-id lookup is deterministic across chats with equal local sequence", async () => {
  await withTempRoot(async (root) => {
    messageStore.saveChatMessage(
      root,
      messageInput({
        chatKey: "telegram/123:later",
        chatId: "later",
        receivedAt: "2026-04-04T12:10:00.000Z",
      }),
    );
    messageStore.saveChatMessage(
      root,
      messageInput({
        chatKey: "telegram/123:earlier",
        chatId: "earlier",
        receivedAt: "2026-04-04T12:00:00.000Z",
      }),
    );

    assert.deepEqual(
      messageStore
        .getChatMessagesByMessageId(root, "message-1")
        .map((item) => item.chatKey),
      ["telegram/123:earlier", "telegram/123:later"],
    );
  });
});

test("SQLite message store uses direct reply indexes instead of list-all history", async () => {
  await withTempRoot(async (root) => {
    messageStore.saveChatMessage(root, messageInput());
    messageStore.saveChatMessage(
      root,
      messageInput({
        messageId: "assistant-1",
        role: "assistant",
        replyToMessageId: "message-1",
        processedAt: "2026-04-04T12:00:02.000Z",
        deliveryKind: "final",
        text: "reply",
      }),
    );

    assert.deepEqual(
      messageStore
        .listChatMessagesByReplyTo(root, "telegram/123:456", "message-1")
        .map((item) => item.messageId),
      ["assistant-1"],
    );

    const plan = chatDatabase
      .openChatDatabase(root)
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT record_json FROM messages
         WHERE chat_key = ? AND reply_to_message_id = ?`,
      )
      .all("telegram/123:456", "message-1")
      .map((row) => String(row.detail || ""))
      .join("\n");
    assert.match(plan, /messages_reply_idx/);
  });
});

test("/new replay boundaries follow durable sequence instead of timestamp ties or skew", async () => {
  await withTempRoot(async (root) => {
    messageStore.saveChatMessage(
      root,
      messageInput({
        messageId: "new-first-insert",
        receivedAt: "2026-04-04T12:10:00.000Z",
        processedAt: "2026-04-04T12:10:01.000Z",
        text: "/new",
      }),
    );
    messageStore.saveChatMessage(
      root,
      messageInput({
        messageId: "original-late-insert",
        receivedAt: "2026-04-04T12:00:00.000Z",
        text: "old request",
      }),
    );

    assert.equal(
      chatHelpers.hasLaterNewSessionBoundary(
        root,
        "telegram/123:456",
        "original-late-insert",
      ),
      false,
    );

    messageStore.saveChatMessage(
      root,
      messageInput({
        messageId: "new-later-sequence",
        receivedAt: "2026-04-04T11:00:00.000Z",
        processedAt: "2026-04-04T12:20:01.000Z",
        text: "/new",
      }),
    );
    assert.equal(
      chatHelpers.hasLaterNewSessionBoundary(
        root,
        "telegram/123:456",
        "original-late-insert",
      ),
      true,
    );
  });
});

test("message store keeps the established chat-log projection path", async () => {
  await withTempRoot(async (root) => {
    assert.equal(
      messageStore.chatMessageLogPath(root, "telegram/123:456", "2026-04-04"),
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
