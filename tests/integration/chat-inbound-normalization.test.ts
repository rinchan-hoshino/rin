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

test("chat inbound normalization covers sparse session and legacy quote fallbacks", () => {
  assert.equal(
    normalization.pickUserId({ author: { userId: " author " } }),
    "author",
  );
  assert.equal(normalization.pickUserId({}), "");
  assert.equal(
    normalization.directLike({ isDirect: true, guildId: "guild" }),
    true,
  );
  assert.equal(normalization.directLike({ guildId: "" }), true);
  assert.equal(
    normalization.directLike({ guildId: "guild", channelId: "private:user" }),
    true,
  );
  assert.equal(
    normalization.directLike({ guildId: "guild", channelId: "group" }),
    false,
  );

  assert.deepEqual(
    normalization.ensureSessionElements({ elements: [null, { type: "text" }] }),
    [{ type: "text" }],
  );
  assert.deepEqual(
    normalization.ensureSessionElements({
      stripped: { content: " stripped " },
    }),
    [{ type: "text", attrs: { content: "stripped" } }],
  );
  assert.deepEqual(normalization.ensureSessionElements({ content: " raw " }), [
    { type: "text", attrs: { content: "raw" } },
  ]);
  assert.deepEqual(normalization.ensureSessionElements({}), []);

  assert.equal(normalization.mentionLike({ stripped: { appel: true } }), true);
  assert.equal(normalization.mentionLike({ elements: [] }), false);
  assert.equal(
    normalization.mentionLike({
      selfId: "bot",
      elements: [{ type: "at", attrs: { id: "@BOT" } }],
    }),
    true,
  );
  assert.equal(
    normalization.mentionLike({
      bot: { username: "rin" },
      elements: [{ type: "at", attrs: { name: "@Rin" } }],
    }),
    true,
  );
  assert.equal(
    normalization.mentionLike({
      selfId: "bot",
      elements: [{ type: "at", attrs: { id: "other" } }],
    }),
    false,
  );

  assert.equal(
    normalization.pickSenderGroupNickname({ author: { card: " Owner card " } }),
    "Owner card",
  );
  assert.equal(
    normalization.pickSenderGroupNickname({
      user: { groupNickname: " Group " },
    }),
    "Group",
  );
  assert.equal(normalization.pickSenderGroupNickname({}), "");
  assert.equal(
    normalization.pickSenderNickname({ user: { name: " User name " } }),
    "User name",
  );
  assert.equal(
    normalization.pickChatName({ guildName: " Guild fallback " }),
    "Guild fallback",
  );
  assert.equal(normalization.pickChatName({}), "");

  const existingQuote = [{ type: "quote", attrs: { id: "existing" } }];
  assert.deepEqual(
    normalization.migrateLegacyQuoteToElements({ id: "legacy" }, existingQuote),
    existingQuote,
  );
  assert.deepEqual(
    normalization.migrateLegacyQuoteToElements(null, [null]),
    [],
  );
  assert.deepEqual(
    normalization.migrateLegacyQuoteToElements({ messageId: " legacy " }, [
      { type: "text", attrs: { content: "body" } },
    ]),
    [
      { type: "quote", attrs: { id: "legacy" }, children: [] },
      { type: "br", attrs: {}, children: [] },
      { type: "text", attrs: { content: "body" } },
    ],
  );
  assert.deepEqual(
    normalization.migrateLegacyQuoteToElements({ id: "q" }, []),
    [{ type: "quote", attrs: { id: "q" }, children: [] }],
  );

  assert.equal(normalization.getChatId({ channelId: " channel " }), "channel");
  assert.equal(normalization.getChatId({}), "");
  assert.equal(
    normalization.getChatId({ platform: "onebot", userId: "owner" }),
    "private:owner",
  );
  assert.equal(
    normalization.getChatId({ platform: "telegram", userId: "owner" }),
    "owner",
  );
});

test("chat inbound normalization serializes rich fallbacks and rejects incomplete records", () => {
  assert.equal(
    normalization.renderInboundMessageText(
      { selfId: "bot", stripped: { content: "fallback" } },
      [
        { type: "at", attrs: { id: "bot" } },
        { type: "at", attrs: { id: "other", name: "Other" } },
        { type: "at", attrs: { name: "Name only" } },
        { type: "at", attrs: {} },
        { type: "image", attrs: { src: "https://example.invalid/a.png" } },
      ],
    ),
    "[@Other](at:other)@Name only\n[image: https://example.invalid/a.png](https://example.invalid/a.png)",
  );
  assert.equal(
    normalization.renderInboundMessageText(
      { stripped: { content: "fallback only" } },
      [],
    ),
    "fallback only",
  );

  const snapshot = normalization.serializeChatInboxSession({
    platform: " telegram ",
    bot: { selfId: "bot", username: "rin" },
    chatThreadId: "thread",
    isTopicMessage: true,
    author: { userId: "owner" },
    timestamp: "invalid",
    stripped: "invalid",
  });
  assert.equal(snapshot.selfId, "bot");
  assert.equal(snapshot.messageThreadId, "thread");
  assert.equal(snapshot.chatThreadId, "thread");
  assert.equal(snapshot.isTopicMessage, true);
  assert.equal(snapshot.timestamp, undefined);
  assert.equal(snapshot.stripped, undefined);

  assert.equal(normalization.buildInboundStoredChatMessageInput({}, []), null);
  assert.equal(
    normalization.buildInboundStoredChatMessageInput(
      { messageId: "message", content: "body" },
      [],
      { chatKey: "custom/key" },
    )?.chatKey,
    "custom/key",
  );
  assert.equal(normalization.buildInboundChatLogInput({}, []), null);
  assert.equal(
    normalization.buildInboundChatLogInput({ messageId: "message" }, [], {
      chatKey: "custom/key",
    }),
    null,
  );
});

test("chat inbound normalization makes rich text the quote semantic source", () => {
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
  };
  const elements = [
    {
      type: "quote",
      attrs: { id: "old-1" },
    },
    { type: "br" },
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
  assert.equal(stored?.text, "[quote:old-1]\nhello\nworld");
  assert.equal(stored?.nickname, "Alice");
  assert.equal(stored?.chatName, "Demo Group");
  assert.equal(stored?.replyToMessageId, "old-1");
  assert.equal(stored?.quote, undefined);
  assert.deepEqual(stored?.elements?.[0], {
    type: "quote",
    attrs: { id: "old-1" },
  });
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
  assert.equal(snapshot.quote, undefined);
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
