import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const normalization = await importBuiltModule<
  typeof import("../../src/core/chat/inbound-normalization.js")
>("dist/core/chat/inbound-normalization.js");

const groupSession = {
  platform: "telegram",
  selfId: "bot-1",
  guildId: "group-1",
  channelId: "-1001",
  userId: "owner-1",
  messageId: "message-1",
  timestamp: 1_713_436_800_000,
  content: "@rin hello",
  stripped: { content: "hello", appel: true },
  username: "fallback-user",
  author: { groupNickname: "Group Name", nickname: "Owner" },
  channel: { name: "Example Group" },
  quote: {
    messageId: "prior-1",
    user: { id: "u2", name: "Quoted" },
    content: "Earlier",
  },
  bot: { selfId: "bot-1", username: "rin_bot", user: { nick: "Rin" } },
};

const groupElements = [
  { type: "at", attrs: { id: "bot-1", name: "rin_bot" } },
  { type: "text", attrs: { content: " hello " } },
  { type: "at", attrs: { id: "u2", name: "Friend" } },
  {
    type: "file",
    attrs: { src: "https://example.invalid/a.pdf", name: "a.pdf" },
  },
];

test("inbound normalization derives aligned routing, session, store, and log records", () => {
  assert.equal(normalization.pickUserId(groupSession), "owner-1");
  assert.equal(
    normalization.pickUserId({ author: { userId: "author" } }),
    "author",
  );
  assert.equal(
    normalization.directLike({ isDirect: true, guildId: "g" }),
    true,
  );
  assert.equal(
    normalization.directLike({ guildId: "", channelId: "channel" }),
    true,
  );
  assert.equal(
    normalization.directLike({ guildId: "g", channelId: "private:7" }),
    true,
  );
  assert.equal(normalization.directLike(groupSession), false);
  assert.deepEqual(
    normalization.ensureSessionElements({ elements: groupElements }),
    groupElements,
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
  assert.equal(normalization.mentionLike(groupSession), true);
  assert.equal(
    normalization.mentionLike({
      elements: [{ type: "at", attrs: { name: "RIN" } }],
      bot: { name: "rin" },
    }),
    true,
  );
  assert.equal(
    normalization.mentionLike({
      elements: [{ type: "at", attrs: { id: "other" } }],
    }),
    false,
  );
  assert.equal(
    normalization.mentionLike({
      elements: [{ type: "text", attrs: { content: "hi" } }],
    }),
    false,
  );
  assert.equal(
    normalization.elementsToText([
      { type: "text", attrs: { content: " one  two " } },
    ]),
    "one two",
  );
  assert.equal(
    normalization.pickSenderGroupNickname(groupSession),
    "Group Name",
  );
  assert.equal(
    normalization.pickSenderGroupNickname({ user: { card: " Card " } }),
    "Card",
  );
  assert.equal(normalization.pickSenderNickname(groupSession), "Owner");
  assert.equal(
    normalization.pickSenderNickname({ user: { name: " Last " } }),
    "Last",
  );
  assert.equal(normalization.pickChatName(groupSession), "Example Group");
  assert.equal(normalization.pickChatName({ guildName: " Guild " }), "Guild");
  assert.equal(normalization.pickMessageId(groupSession), "message-1");
  assert.equal(normalization.pickReplyToMessageId(groupSession), "prior-1");
  assert.deepEqual(normalization.summarizeQuote(groupSession), {
    messageId: "prior-1",
    userId: "u2",
    nickname: "Quoted",
    content: "Earlier",
  });
  assert.equal(normalization.summarizeQuote({ quote: "bad" }), undefined);
  assert.equal(normalization.summarizeQuote({ quote: {} }), undefined);
  assert.equal(normalization.getChatId(groupSession), "-1001");
  assert.equal(
    normalization.getChatId({ platform: "onebot", userId: "7" }),
    "private:7",
  );
  assert.equal(
    normalization.getChatId({ platform: "telegram", userId: "7" }),
    "7",
  );
  assert.equal(normalization.getChatId({ platform: "telegram" }), "");
  assert.equal(normalization.getChatType(groupSession), "group");

  const routing = normalization.buildChatInboxRouting(
    groupSession,
    groupElements,
  );
  assert.deepEqual(routing, {
    chatType: "group",
    isDirect: false,
    mentionLike: true,
    text: "hello [@Friend](at:u2)\n[file: a.pdf](https://example.invalid/a.pdf)",
    userId: "owner-1",
    nickname: "Owner",
    chatName: "Example Group",
    messageThreadId: undefined,
    replyToMessageId: "prior-1",
  });

  const snapshot = normalization.serializeChatInboxSession({
    ...groupSession,
    messageThreadId: "thread-1",
    isTopicMessage: false,
    providerCursor: "ignored",
  });
  assert.equal(snapshot.selfId, "bot-1");
  assert.equal(snapshot.messageThreadId, "thread-1");
  assert.equal(snapshot.chatThreadId, "thread-1");
  assert.equal(snapshot.isTopicMessage, false);
  assert.notEqual(snapshot.author, groupSession.author);

  const stored = normalization.buildInboundStoredChatMessageInput(
    groupSession,
    groupElements,
    {
      receivedAt: "2026-04-18T12:34:56.000Z",
      trust: " OWNER ",
    },
  );
  assert.equal(stored?.chatKey, "telegram/bot-1:-1001");
  assert.equal(stored?.receivedAt, "2026-04-18T12:34:56.000Z");
  assert.equal(stored?.platformTimestamp, 1_713_436_800_000);
  assert.equal(stored?.trust, "OWNER");
  assert.equal(stored?.text, routing.text);
  assert.deepEqual(stored?.quote, normalization.summarizeQuote(groupSession));

  const log = normalization.buildInboundChatLogInput(
    groupSession,
    groupElements,
    {
      timestamp: "2026-04-18T12:34:56.000Z",
    },
  );
  assert.equal(log?.chatKey, stored?.chatKey);
  assert.equal(log?.text, stored?.text);
  assert.equal(log?.replyToMessageId, "prior-1");
});

test("inbound normalization rejects incomplete records and preserves fallbacks", () => {
  assert.equal(
    normalization.buildInboundStoredChatMessageInput(
      { platform: "telegram", selfId: "bot", channelId: "chat" },
      [],
    ),
    null,
  );
  assert.equal(
    normalization.buildInboundStoredChatMessageInput(
      { platform: "telegram", messageId: "m" },
      [],
    ),
    null,
  );
  const explicit = normalization.buildInboundStoredChatMessageInput(
    {
      platform: "",
      messageId: "m",
      timestamp: "not-a-number",
      providerCursor: " cursor ",
      content: " raw ",
      stripped: { content: " stripped " },
      quote: {
        id: "q",
        author: { id: "a", nick: "Nick" },
        message: { content: "quote" },
      },
    },
    [],
    { chatKey: "custom/bot:chat", receivedAt: "2026-01-01T00:00:00.000Z" },
  );
  assert.equal(explicit?.chatKey, "custom/bot:chat");
  assert.equal(explicit?.platformTimestamp, undefined);
  assert.equal(explicit?.providerCursor, "cursor");
  assert.equal(explicit?.text, "stripped");
  assert.deepEqual(explicit?.quote, {
    messageId: "q",
    userId: "a",
    nickname: "Nick",
    content: "quote",
  });
  assert.equal(
    normalization.buildInboundChatLogInput(
      {
        platform: "telegram",
        selfId: "bot",
        channelId: "chat",
        messageId: "m",
      },
      [],
      { timestamp: "2026-01-01T00:00:00.000Z" },
    ),
    null,
  );
  assert.deepEqual(normalization.serializeChatInboxSession(null), {
    platform: undefined,
    selfId: undefined,
    channelId: undefined,
    guildId: undefined,
    messageThreadId: undefined,
    chatThreadId: undefined,
    isTopicMessage: undefined,
    userId: undefined,
    messageId: undefined,
    timestamp: undefined,
    content: undefined,
    stripped: undefined,
    username: undefined,
    author: undefined,
    user: undefined,
    channel: undefined,
    guild: undefined,
    quote: undefined,
  });
});
