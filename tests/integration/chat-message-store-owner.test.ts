import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const messageStore = await importBuiltModule<
  typeof import("../../src/core/chat/message-store.js")
>("dist/core/chat/message-store.js");

async function withStore(run: (agentDir: string) => Promise<void>) {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-message-owner-"),
  );
  try {
    await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

function input(overrides: Record<string, any> = {}) {
  return {
    messageId: "message-1",
    role: "user",
    chatKey: "telegram/1:2",
    platform: "telegram",
    botId: "1",
    chatId: "2",
    chatType: "private",
    receivedAt: "2026-07-17T08:00:00.000Z",
    userId: "owner",
    nickname: "Owner",
    text: "hello",
    ...overrides,
  } as any;
}

test("message-store paths and record identities are stable and chat-scoped", async () => {
  await withStore(async (agentDir) => {
    assert.equal(
      messageStore.chatMessageStoreDir(agentDir),
      path.join(agentDir, "data", "chat", "message-store"),
    );
    assert.equal(
      messageStore.chatMessageLogDir(agentDir),
      path.join(agentDir, "data", "chat", "message-store", "chat-log-view"),
    );
    const logPath = messageStore.chatMessageLogPath(
      agentDir,
      "telegram/1:2",
      "2026-07-17",
    );
    assert.ok(logPath.startsWith(messageStore.chatMessageLogDir(agentDir)));
    assert.ok(logPath.endsWith(`${path.sep}2026-07-17.txt`));
    assert.equal(
      messageStore.buildChatMessageRecordKey("telegram/1:2", "message-1"),
      messageStore.buildChatMessageRecordKey("telegram/1:2", "message-1"),
    );
    assert.notEqual(
      messageStore.buildChatMessageRecordKey("telegram/1:2", "message-1"),
      messageStore.buildChatMessageRecordKey("telegram/1:3", "message-1"),
    );
  });
});

test("stored message construction validates identity and normalizes role", () => {
  assert.throws(
    () => messageStore.buildStoredChatMessage(input({ chatKey: " " })),
    /chat_message_store_chatKey_required/,
  );
  assert.throws(
    () => messageStore.buildStoredChatMessage(input({ messageId: " " })),
    /chat_message_store_messageId_required/,
  );

  const record = messageStore.buildStoredChatMessage(
    input({ chatKey: " telegram/1:2 ", messageId: " message-1 ", role: "bot" }),
  );
  assert.equal(record.version, 1);
  assert.equal(record.chatKey, "telegram/1:2");
  assert.equal(record.messageId, "message-1");
  assert.equal(record.role, undefined);
  assert.equal(record.recordKey.length, 40);
  assert.equal(messageStore.normalizeStoredChatMessageRole(" user "), "user");
  assert.equal(
    messageStore.normalizeStoredChatMessageRole("assistant"),
    "assistant",
  );
  assert.equal(messageStore.normalizeStoredChatMessageRole(null), undefined);
});

test("stored message projections use receiver-visible text and session references", () => {
  assert.equal(messageStore.storedChatMessageTimestamp(undefined), "");
  assert.equal(
    messageStore.storedChatMessageTimestamp({
      receivedAt: "",
      processedAt: "2026-07-17T08:00:00.000Z",
    }),
    "2026-07-17T08:00:00.000Z",
  );
  assert.equal(messageStore.normalizeStoredChatMessageText(null), "");
  assert.equal(
    messageStore.normalizeStoredChatMessageText({
      text: undefined,
      strippedContent: " stripped ",
      rawContent: "raw",
    }),
    "stripped",
  );
  assert.equal(
    messageStore.normalizeStoredChatMessageText({ rawContent: " raw " }),
    "raw",
  );

  const projected = messageStore.projectStoredChatMessageToChatLog(
    messageStore.buildStoredChatMessage(
      input({
        replyToMessageId: " reply-1 ",
        sessionFile: "sessions/managed/chat/owner.jsonl",
      }),
    ),
  );
  assert.deepEqual(projected, {
    timestamp: "2026-07-17T08:00:00.000Z",
    role: "user",
    text: "hello",
    messageId: "message-1",
    replyToMessageId: "reply-1",
    sessionFile: "sessions/managed/chat/owner.jsonl",
    userId: "owner",
    nickname: "Owner",
  });
  assert.deepEqual(
    messageStore.projectStoredChatMessageToChatLog({
      role: "assistant",
      text: "minimal",
      receivedAt: "2026-07-17T08:00:00.000Z",
      messageId: "",
      replyToMessageId: "",
      userId: "",
      nickname: "",
    } as any),
    {
      timestamp: "2026-07-17T08:00:00.000Z",
      role: "assistant",
      text: "minimal",
      messageId: undefined,
      replyToMessageId: undefined,
      sessionFile: undefined,
      userId: undefined,
      nickname: undefined,
    },
  );
  assert.equal(
    messageStore.projectStoredChatMessageToChatLog(
      messageStore.buildStoredChatMessage(input({ role: undefined })),
    ),
    null,
  );
  assert.equal(
    messageStore.projectStoredChatMessageToChatLog(
      messageStore.buildStoredChatMessage(input({ text: " " })),
    ),
    null,
  );
});

test("message records persist, update, query, and normalize session ownership", async () => {
  await withStore(async (agentDir) => {
    const externalSession = path.join(
      agentDir,
      "sessions",
      "managed",
      "chat",
      "owner.jsonl",
    );
    const saved = messageStore.saveChatMessage(
      agentDir,
      input({ sessionId: "legacy-session", sessionFile: externalSession }),
    );
    assert.equal(saved.record.sessionId, undefined);
    assert.equal(saved.record.sessionFile, "managed/chat/owner.jsonl");

    const loaded = messageStore.getChatMessage(
      agentDir,
      "telegram/1:2",
      "message-1",
    );
    assert.equal(loaded?.recordKey, saved.record.recordKey);
    assert.equal(loaded?.text, "hello");
    assert.equal(
      messageStore.findChatMessageByChatAndId(
        agentDir,
        "telegram/1:2",
        "message-1",
      )?.recordKey,
      saved.record.recordKey,
    );
    assert.equal(
      messageStore.findChatMessageByChatAndId(
        agentDir,
        "telegram/9:9",
        "message-1",
      ),
      null,
    );
    assert.equal(
      messageStore.updateChatMessage(agentDir, "telegram/9:9", "missing", {
        text: "no",
      }),
      null,
    );

    const updated = messageStore.updateChatMessage(
      agentDir,
      "telegram/1:2",
      "message-1",
      {
        role: "assistant",
        platform: "discord",
        chatId: "changed",
        text: "updated",
        sessionId: "discarded",
        sessionFile: externalSession,
      },
    );
    assert.equal(updated?.role, "assistant");
    assert.equal(updated?.platform, "telegram");
    assert.equal(updated?.chatId, "2");
    assert.equal(updated?.text, "updated");
    assert.equal(updated?.sessionId, undefined);
    assert.equal(updated?.sessionFile, "managed/chat/owner.jsonl");

    assert.deepEqual(messageStore.getChatMessagesByMessageId(agentDir, ""), []);
    assert.deepEqual(
      messageStore
        .getChatMessagesByMessageId(agentDir, "message-1")
        .map((item) => item.recordKey),
      [saved.record.recordKey],
    );
    assert.equal(messageStore.listChatMessages(agentDir).length, 1);
  });
});

test("same provider message ids remain independently addressable by chat", async () => {
  await withStore(async (agentDir) => {
    const first = messageStore.saveChatMessage(agentDir, input());
    const second = messageStore.saveChatMessage(
      agentDir,
      input({ chatKey: "telegram/1:3", chatId: "3", text: "other chat" }),
    );
    assert.notEqual(first.record.recordKey, second.record.recordKey);
    assert.deepEqual(
      messageStore
        .getChatMessagesByMessageId(agentDir, "message-1")
        .map((item) => item.chatKey)
        .sort(),
      ["telegram/1:2", "telegram/1:3"],
    );
    assert.deepEqual(
      messageStore
        .normalizeChatMessageLookup(agentDir, "message-1")
        .map((item) => [item.chatKey, item.parsedChatKey.chatId])
        .sort(),
      [
        ["telegram/1:2", "2"],
        ["telegram/1:3", "3"],
      ],
    );
    assert.deepEqual(
      messageStore.normalizeChatMessageLookup(
        agentDir,
        "message-1",
        "telegram/1:3",
      )[0].parsedChatKey,
      {
        platform: "telegram",
        botId: "1",
        chatId: "3",
      },
    );
    assert.deepEqual(
      messageStore.normalizeChatMessageLookup(
        agentDir,
        "missing",
        "telegram/1:3",
      ),
      [],
    );
  });
});

test("inbound duplicate merging keeps richer owner evidence and monotonic timestamps", async () => {
  await withStore(async (agentDir) => {
    messageStore.saveInboundChatMessage(
      agentDir,
      input({
        text: "short",
        rawContent: "raw",
        strippedContent: "",
        elements: [{ type: "text" }],
        quote: { messageId: "quoted" },
        receivedAt: "not-a-date",
        duplicateCount: -3,
      }),
    );
    const merged = messageStore.saveInboundChatMessage(
      agentDir,
      input({
        role: "assistant",
        platform: "discord",
        chatId: "changed",
        text: "a much richer owner message",
        rawContent: "",
        strippedContent: "normalized content",
        elements: [{ type: "text" }, { type: "image" }],
        quote: { messageId: "incoming-quote" },
        receivedAt: "2026-07-17T09:00:00.000Z",
        acceptedAt: "2026-07-17T09:00:01.000Z",
        processedAt: "2026-07-17T09:00:02.000Z",
        sessionFile: "/outside/owner.jsonl",
      }),
    ).record;

    assert.equal(merged.role, "user");
    assert.equal(merged.platform, "telegram");
    assert.equal(merged.chatId, "2");
    assert.equal(merged.text, "a much richer owner message");
    assert.equal(merged.rawContent, "raw");
    assert.equal(merged.strippedContent, "normalized content");
    assert.equal(merged.elements?.length, 2);
    assert.deepEqual(merged.quote, { messageId: "quoted" });
    assert.equal(merged.duplicateCount, 1);
    assert.equal(merged.lastReceivedAt, "2026-07-17T09:00:00.000Z");
    assert.match(merged.updatedAt || "", /^\d{4}-/);
    assert.equal(merged.acceptedAt, "2026-07-17T09:00:01.000Z");
    assert.equal(merged.processedAt, "2026-07-17T09:00:02.000Z");

    const older = messageStore.saveInboundChatMessage(
      agentDir,
      input({
        text: "tiny",
        receivedAt: "2026-07-17T07:00:00.000Z",
        elements: [],
      }),
    ).record;
    assert.equal(older.text, "a much richer owner message");
    assert.equal(older.lastReceivedAt, "2026-07-17T09:00:00.000Z");
    assert.equal(older.duplicateCount, 2);
  });
});

test("upsert creates and updates while preserving record identity", async () => {
  await withStore(async (agentDir) => {
    const created = messageStore.upsertChatMessage(
      agentDir,
      input({ messageId: "upsert-1", text: "created" }),
    );
    const updated = messageStore.upsertChatMessage(
      agentDir,
      input({
        messageId: "upsert-1",
        role: "assistant",
        platform: "discord",
        chatId: "changed",
        text: "updated",
        processedAt: "2026-07-17T08:01:00.000Z",
      }),
    );
    assert.equal(updated.recordKey, created.recordKey);
    assert.equal(updated.role, "assistant");
    assert.equal(updated.text, "updated");
    assert.equal(updated.platform, "telegram");
    assert.equal(updated.chatId, "2");
    assert.equal(updated.processedAt, "2026-07-17T08:01:00.000Z");
    messageStore.saveChatMessage(
      agentDir,
      input({ messageId: "timestamp-empty", platformTimestamp: "" }),
    );
    messageStore.saveChatMessage(
      agentDir,
      input({ messageId: "timestamp-invalid", platformTimestamp: "invalid" }),
    );
    messageStore.saveChatMessage(
      agentDir,
      input({ messageId: "timestamp-valid", platformTimestamp: 42 }),
    );
  });
});

test("chat-date indexes sort records and follow date-changing updates", async () => {
  await withStore(async (agentDir) => {
    const late = messageStore.saveChatMessage(
      agentDir,
      input({ messageId: "late", receivedAt: "2026-07-17T10:00:00.000Z" }),
    ).record;
    const early = messageStore.saveChatMessage(
      agentDir,
      input({ messageId: "early", receivedAt: "2026-07-17T07:00:00.000Z" }),
    ).record;
    messageStore.saveChatMessage(
      agentDir,
      input({
        messageId: "other-chat",
        chatKey: "telegram/1:3",
        chatId: "3",
        receivedAt: "2026-07-17T06:00:00.000Z",
      }),
    );

    assert.deepEqual(
      messageStore
        .listChatMessagesByChatAndDate(agentDir, "telegram/1:2", "2026-07-17")
        .map((item) => item.messageId),
      ["early", "late"],
    );
    assert.deepEqual(
      messageStore.listChatMessagesByChatAndDate(agentDir, "", "2026-07-17"),
      [],
    );
    assert.deepEqual(
      messageStore.listChatMessagesByChatAndDate(
        agentDir,
        "telegram/1:2",
        "not-a-date",
      ),
      [],
    );

    await fs.rm(
      path.join(messageStore.chatMessageStoreDir(agentDir), "indexes"),
      { recursive: true, force: true },
    );
    messageStore.updateChatMessage(agentDir, "telegram/1:2", "early", {
      receivedAt: "2026-07-18T07:00:00.000Z",
    });
    assert.deepEqual(
      messageStore
        .listChatMessagesByChatAndDate(agentDir, "telegram/1:2", "2026-07-17")
        .map((item) => item.recordKey),
      [late.recordKey],
    );
    assert.deepEqual(
      messageStore
        .listChatMessagesByChatAndDate(agentDir, "telegram/1:2", "2026-07-18")
        .map((item) => item.recordKey),
      [early.recordKey],
    );

    const tied = ["tie-a", "tie-b"].map(
      (messageId) =>
        messageStore.saveChatMessage(
          agentDir,
          input({ messageId, receivedAt: "2026-07-19T08:00:00.000Z" }),
        ).record,
    );
    assert.deepEqual(
      messageStore
        .listChatMessagesByChatAndDate(agentDir, "telegram/1:2", "2026-07-19")
        .map((item) => item.recordKey),
      tied.map((item) => item.recordKey).sort(),
    );
  });
});

test("reply lookup filters exact chat and provider reply identity", async () => {
  await withStore(async (agentDir) => {
    messageStore.saveChatMessage(
      agentDir,
      input({ messageId: "reply-a", replyToMessageId: "root" }),
    );
    messageStore.saveChatMessage(
      agentDir,
      input({
        messageId: "reply-b",
        replyToMessageId: "root",
        chatKey: "telegram/1:3",
        chatId: "3",
      }),
    );
    messageStore.saveChatMessage(
      agentDir,
      input({ messageId: "reply-c", replyToMessageId: "other" }),
    );

    assert.deepEqual(
      messageStore
        .listChatMessagesByReplyTo(agentDir, "telegram/1:2", "root")
        .map((item) => item.messageId),
      ["reply-a"],
    );
    assert.deepEqual(
      messageStore.listChatMessagesByReplyTo(agentDir, "", "root"),
      [],
    );
    assert.deepEqual(
      messageStore.listChatMessagesByReplyTo(agentDir, "telegram/1:2", ""),
      [],
    );
  });
});

test("record descriptions and element summaries expose only meaningful fields", () => {
  const record = messageStore.buildStoredChatMessage(
    input({
      role: "assistant",
      replyToMessageId: "reply-1",
      sessionFile: "sessions/owner.jsonl",
      chatName: "Owner chat",
      trust: "trusted",
    }),
  );
  const detail = messageStore.describeChatMessageRecord(record);
  assert.match(detail, /messageId=message-1/);
  assert.match(detail, /chatKey=telegram\/1:2/);
  assert.match(detail, /role=assistant/);
  assert.match(detail, /replyToMessageId=reply-1/);
  assert.match(detail, /sessionFile=sessions\/owner.jsonl/);
  assert.match(detail, /userId=owner/);
  assert.match(detail, /nickname=Owner/);
  assert.match(detail, /chatName=Owner chat/);
  assert.match(detail, /trust=trusted/);
  assert.match(detail, /receivedAt=2026-07-17/);
  assert.match(detail, /text=hello/);

  const summary = messageStore.summarizeChatMessageRecord(record);
  assert.match(summary, /- message id: message-1/);
  assert.match(summary, /- sender nickname: Owner/);
  assert.equal(
    messageStore
      .summarizeChatMessageRecord(
        messageStore.buildStoredChatMessage(
          input({
            role: undefined,
            replyToMessageId: undefined,
            sessionFile: undefined,
            userId: undefined,
            nickname: undefined,
            chatName: undefined,
            trust: undefined,
            text: undefined,
          }),
        ),
      )
      .split("\n").length,
    3,
  );

  assert.deepEqual(messageStore.normalizeElementSummary(null), []);
  assert.deepEqual(
    messageStore.normalizeElementSummary([
      { type: " IMAGE ", attrs: { src: "owner.png", empty: "", count: 0 } },
      { type: "", attrs: "bad" },
      null,
    ]),
    [
      { type: "image", attrs: { src: "owner.png", count: "0" } },
      { type: "unknown" },
      { type: "unknown" },
    ],
  );
});
