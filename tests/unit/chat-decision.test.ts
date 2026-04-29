import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const decision = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "decision.js")).href
);

const identity = {
  aliases: [
    { platform: "telegram", userId: "owner-1", personId: "owner" },
    { platform: "telegram", userId: "trusted-1", personId: "trusted" },
  ],
  persons: {
    owner: { trust: "OWNER" },
    trusted: { trust: "TRUSTED" },
  },
};

test("chat decision keeps slash-containing owner text routable", async () => {
  const result = await decision.shouldProcessText(
    {
      platform: "telegram",
      userId: "owner-1",
      content: "How should /tmp/demo.txt be handled?",
      stripped: { content: "How should /tmp/demo.txt be handled?" },
      isDirect: true,
    },
    [
      {
        type: "text",
        attrs: { content: "How should /tmp/demo.txt be handled?" },
      },
    ],
    identity,
  );

  assert.equal(result.allow, true);
  assert.equal(result.text, "How should /tmp/demo.txt be handled?");
});

test("chat decision only enforces access policy, not custom slash-command guessing", async () => {
  const result = await decision.shouldProcessText(
    {
      platform: "telegram",
      userId: "owner-1",
      content: "/new hello",
      stripped: { content: "/new hello" },
      isDirect: true,
    },
    [{ type: "text", attrs: { content: "/new hello" } }],
    identity,
  );

  assert.equal(result.allow, true);
  assert.equal(result.text, "/new hello");
});

test("chat decision allows trusted private messages", async () => {
  const result = await decision.shouldProcessText(
    {
      platform: "telegram",
      userId: "trusted-1",
      content: "hello from trusted",
      stripped: { content: "hello from trusted" },
      isDirect: true,
    },
    [{ type: "text", attrs: { content: "hello from trusted" } }],
    identity,
  );

  assert.equal(result.allow, true);
  assert.equal(result.text, "hello from trusted");
  assert.equal(result.trust, "TRUSTED");
});

test("chat decision treats two-member owner groups as private-like", async () => {
  const result = await decision.shouldProcessText(
    {
      platform: "telegram",
      guildId: "group-1",
      channelId: "-1001447529496",
      selfId: "8623230033",
      userId: "owner-1",
      bot: {
        selfId: "8623230033",
        internal: {
          async getChatMemberCount({ chat_id }) {
            assert.equal(chat_id, "-1001447529496");
            return 2;
          },
        },
      },
      stripped: { content: "private note" },
      elements: [{ type: "text", attrs: { content: "private note" } }],
    },
    [{ type: "text", attrs: { content: "private note" } }],
    identity,
  );

  assert.equal(result.allow, true);
  assert.equal(result.chatKey, "telegram/8623230033:-1001447529496");
  assert.equal(result.trust, "OWNER");
});

test("chat decision keeps image-only owner messages routable", async () => {
  const result = await decision.shouldProcessText(
    {
      platform: "telegram",
      userId: "owner-1",
      content: '<img src="https://example.com/demo.png" file="demo.png"/>',
      stripped: { content: "" },
      isDirect: true,
    },
    [
      {
        type: "img",
        attrs: { src: "https://example.com/demo.png", file: "demo.png" },
      },
    ],
    identity,
  );

  assert.equal(result.allow, true);
  assert.equal(result.text, "![demo.png](https://example.com/demo.png)");
});

test("chat decision allows owner group messages that explicitly at the bot even when stripped.appel is missing", async () => {
  const result = await decision.shouldProcessText(
    {
      platform: "telegram",
      guildId: "group-1",
      channelId: "-1001447529496",
      selfId: "8623230033",
      userId: "owner-1",
      bot: {
        selfId: "8623230033",
        username: "THE_cattail_rin_chan_bot",
      },
      stripped: { content: "ping" },
      elements: [
        { type: "at", attrs: { name: "THE_cattail_rin_chan_bot" } },
        { type: "text", attrs: { content: " ping" } },
      ],
    },
    [
      { type: "at", attrs: { name: "THE_cattail_rin_chan_bot" } },
      { type: "text", attrs: { content: " ping" } },
    ],
    identity,
  );

  assert.equal(result.allow, true);
  assert.equal(result.chatKey, "telegram/8623230033:-1001447529496");
  assert.equal(result.text, "ping");
});

test("chat decision ignores owner group messages that only at other users", async () => {
  const result = await decision.shouldProcessText(
    {
      platform: "telegram",
      guildId: "group-1",
      channelId: "-1001447529496",
      selfId: "8623230033",
      userId: "owner-1",
      bot: {
        selfId: "8623230033",
        username: "THE_cattail_rin_chan_bot",
      },
      stripped: { content: "see this" },
      elements: [
        { type: "at", attrs: { name: "some_other_user" } },
        { type: "text", attrs: { content: " see this" } },
      ],
    },
    [
      { type: "at", attrs: { name: "some_other_user" } },
      { type: "text", attrs: { content: " see this" } },
    ],
    identity,
  );

  assert.equal(result.allow, false);
  assert.equal(result.chatKey, "telegram/8623230033:-1001447529496");
  assert.equal(result.text, "see this");
});
