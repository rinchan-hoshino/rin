import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const normalization = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat", "inbound-normalization.js"),
  ).href
);
const helpers = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "chat-helpers.js"))
    .href
);
const messageStore = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js"))
    .href
);

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-normalize-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("chat inbound normalization keeps inbox, log, and store metadata aligned", () => {
  const session = {
    platform: "telegram",
    selfId: "8623230033",
    guildId: "g1",
    channelId: "-100123",
    userId: "owner-1",
    messageId: "m-aligned",
    timestamp: 1713436800000,
    content: "@rin   hello\n\nworld",
    stripped: { content: "hello\n\nworld", appel: true },
    author: { name: "Alice" },
    channel: { name: "Demo Group" },
    quote: { messageId: "old-1", content: "older context" },
  };
  const elements = [
    { type: "at", attrs: { id: "8623230033" } },
    { type: "text", attrs: { content: " hello" } },
    { type: "br" },
    { type: "text", attrs: { content: "world" } },
  ];
  const timestamp = "2026-04-18T12:34:56.000Z";

  const stored = normalization.buildInboundStoredChatMessageInput(
    session,
    elements,
    { receivedAt: timestamp, trust: "TRUSTED" },
  );
  const logEntry = normalization.buildInboundChatLogInput(session, elements, {
    timestamp,
  });
  const routing = normalization.buildChatInboxRouting(session, elements);
  const snapshot = normalization.serializeChatInboxSession(session);

  assert.equal(stored?.chatKey, "telegram/8623230033:-100123");
  assert.equal(stored?.messageId, "m-aligned");
  assert.equal(stored?.text, "hello\nworld");
  assert.equal(stored?.nickname, "Alice");
  assert.equal(stored?.chatName, "Demo Group");
  assert.equal(stored?.replyToMessageId, "old-1");
  assert.equal(stored?.trust, "TRUSTED");
  assert.equal(logEntry?.chatKey, stored?.chatKey);
  assert.equal(logEntry?.messageId, stored?.messageId);
  assert.equal(logEntry?.text, stored?.text);
  assert.equal(logEntry?.replyToMessageId, stored?.replyToMessageId);
  assert.equal(logEntry?.nickname, stored?.nickname);
  assert.equal(routing.chatType, "group");
  assert.equal(routing.isDirect, false);
  assert.equal(routing.mentionLike, true);
  assert.equal(routing.text, stored?.text);
  assert.equal(routing.userId, stored?.userId);
  assert.equal(routing.nickname, stored?.nickname);
  assert.equal(routing.chatName, stored?.chatName);
  assert.equal(snapshot.userId, stored?.userId);
  assert.equal(snapshot.messageId, stored?.messageId);
  assert.deepEqual(snapshot.stripped, { content: "hello\n\nworld" });
  assert.equal(snapshot.quote?.messageId, "old-1");
});

test("chat inbound normalization renders received rich objects as chat markdown syntax", () => {
  const session = {
    platform: "telegram",
    selfId: "bot-1",
    guildId: "g1",
    channelId: "-100123",
    userId: "owner-1",
    messageId: "m-rich",
    stripped: { content: "hello", appel: false },
  };
  const elements = [
    { type: "text", attrs: { content: "hello " } },
    { type: "at", attrs: { id: "user-2", name: "Alice" } },
    { type: "quote", attrs: { id: "old-2" } },
    {
      type: "file",
      attrs: { src: "https://example.com/spec.pdf", name: "spec.pdf" },
    },
    {
      type: "sticker",
      attrs: { src: "https://example.com/yay.webp", name: "yay" },
    },
  ];

  const stored = normalization.buildInboundStoredChatMessageInput(
    session,
    elements,
  );

  assert.equal(
    stored?.text,
    "hello [@Alice](at:user-2)[quote:old-2]\n[file: spec.pdf](https://example.com/spec.pdf)\n\n[sticker: yay](https://example.com/yay.webp)",
  );
});

test("chat helpers persist inbound messages with the shared normalized store shape", async () => {
  await withTempDir(async (agentDir) => {
    const session = {
      platform: "onebot",
      selfId: "2301401877",
      channelId: "private:114514",
      userId: "114514",
      messageId: "msg-1",
      timestamp: 1713436800000,
      content: "hello there",
      stripped: { content: "hello there" },
      author: { name: "Tester" },
    };
    const elements = [{ type: "text", attrs: { content: "hello there" } }];
    const expected = normalization.buildInboundStoredChatMessageInput(
      session,
      elements,
      { trust: "TRUSTED" },
    );

    const persisted = helpers.persistInboundMessage(
      agentDir,
      session,
      elements,
      { demo: true },
      () => "TRUSTED",
    );
    const stored = messageStore.getChatMessage(
      agentDir,
      expected.chatKey,
      expected.messageId,
    );

    assert.equal(persisted?.record.chatKey, expected.chatKey);
    assert.equal(persisted?.record.messageId, expected.messageId);
    assert.equal(stored?.chatKey, expected.chatKey);
    assert.equal(stored?.messageId, expected.messageId);
    assert.equal(stored?.role, expected.role);
    assert.equal(stored?.replyToMessageId, expected.replyToMessageId);
    assert.equal(stored?.chatType, expected.chatType);
    assert.equal(stored?.userId, expected.userId);
    assert.equal(stored?.nickname, expected.nickname);
    assert.equal(stored?.trust, expected.trust);
    assert.equal(stored?.text, expected.text);
    assert.equal(stored?.rawContent, expected.rawContent);
    assert.equal(stored?.strippedContent, expected.strippedContent);
    assert.deepEqual(stored?.elements, expected.elements);
  });
});

test("chat inbound log input reuses stored text fallback order", () => {
  const logEntry = normalization.buildInboundChatLogInput(
    {
      platform: "telegram",
      selfId: "8623230033",
      channelId: "-100123",
      userId: "owner-1",
      messageId: "m-fallback",
      content: "  raw fallback  ",
      stripped: { content: "  stripped fallback  " },
    },
    [],
    { timestamp: "2026-04-18T13:00:00.000Z" },
  );

  assert.equal(logEntry?.chatKey, "telegram/8623230033:-100123");
  assert.equal(logEntry?.text, "stripped fallback");
  assert.equal(logEntry?.timestamp, "2026-04-18T13:00:00.000Z");
});
