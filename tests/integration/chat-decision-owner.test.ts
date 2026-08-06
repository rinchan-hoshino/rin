import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const decision = await importBuiltModule<
  typeof import("../../src/core/chat/decision.js")
>("dist/core/chat/decision.js");
await import("./chat-decision.test.js");

const identity = {
  aliases: [
    { platform: "telegram", userId: "owner", personId: "owner-person" },
    { platform: "telegram", userId: "trusted", personId: "trusted-person" },
    { platform: "onebot", userId: "owner-onebot", personId: "owner-person" },
    { platform: "lark", userId: "owner-lark", personId: "owner-person" },
    { platform: "discord", userId: "owner-discord", personId: "owner-person" },
  ],
  persons: {
    "owner-person": { trust: "OWNER" },
    "trusted-person": { trust: "TRUSTED" },
  },
};

const text = [{ type: "text", attrs: { content: " hello " } }];

function groupSession(overrides: Record<string, any> = {}) {
  return {
    platform: "telegram",
    guildId: "guild",
    channelId: "-1001",
    selfId: "bot",
    userId: "owner",
    bot: { selfId: "bot", username: "rin_bot" },
    elements: text,
    ...overrides,
  };
}

test("chat decision enforces direct, mention, media, and owner-presence boundaries", async () => {
  const empty = await decision.shouldProcessText({}, [], identity);
  assert.deepEqual(empty, {
    allow: false,
    text: "",
    chatKey: "",
    chatType: "group",
    trust: "OTHER",
    requiresMentionToStartTurn: false,
  });

  const direct = await decision.shouldProcessText(
    { platform: "telegram", selfId: "bot", userId: "trusted", isDirect: true },
    text,
    identity,
  );
  assert.equal(direct.allow, true);
  assert.equal(direct.trust, "TRUSTED");
  assert.equal(direct.chatType, "private");

  const image = await decision.shouldProcessText(
    { platform: "telegram", selfId: "bot", userId: "owner", isDirect: true },
    [
      {
        type: "image",
        attrs: { src: "https://example.invalid/image.png", name: "image.png" },
      },
    ],
    identity,
  );
  assert.equal(image.allow, true);
  assert.match(image.text, /image\.png/);

  const replyOnly = await decision.shouldProcessText(
    {
      platform: "telegram",
      selfId: "bot",
      userId: "owner",
      isDirect: true,
      quote: { messageId: "prior" },
    },
    [{ type: "quote", attrs: { id: "prior" } }],
    identity,
    { chatKey: "telegram/bot:override" },
  );
  assert.equal(replyOnly.allow, true);
  assert.equal(replyOnly.chatKey, "telegram/bot:override");

  const stranger = await decision.shouldProcessText(
    groupSession({ userId: "stranger" }),
    [{ type: "at", attrs: { id: "bot" } }, ...text],
    identity,
  );
  assert.equal(stranger.allow, false);
  assert.equal(stranger.trust, "OTHER");
  assert.equal(stranger.requiresMentionToStartTurn, true);

  const unmentionedOwner = await decision.shouldProcessText(
    groupSession(),
    text,
    identity,
  );
  assert.equal(unmentionedOwner.allow, false);
  assert.equal(unmentionedOwner.requiresMentionToStartTurn, true);

  const ownerMention = [{ type: "at", attrs: { name: "rin_bot" } }, ...text];
  const mentionedOwner = await decision.shouldProcessText(
    groupSession({ elements: ownerMention }),
    ownerMention,
    identity,
  );
  assert.equal(mentionedOwner.allow, true);

  const ownerQueries: string[] = [];
  const trustedPresent = await decision.shouldProcessText(
    groupSession({
      userId: "trusted",
      elements: [{ type: "at", attrs: { id: "bot" } }, ...text],
      bot: {
        selfId: "bot",
        username: "rin_bot",
        internal: {
          async getChatMember({ user_id }: any) {
            ownerQueries.push(user_id);
            return { status: "administrator" };
          },
        },
      },
    }),
    [{ type: "at", attrs: { id: "bot" } }, ...text],
    identity,
  );
  assert.equal(trustedPresent.allow, true);
  assert.deepEqual(ownerQueries, ["owner"]);

  for (const member of [
    { status: "left" },
    { status: "restricted", is_member: false },
    {},
  ]) {
    const result = await decision.shouldProcessText(
      groupSession({
        userId: "trusted",
        elements: [{ type: "at", attrs: { id: "bot" } }, ...text],
        bot: {
          selfId: "bot",
          username: "rin_bot",
          internal: {
            async getChatMember() {
              return member;
            },
          },
        },
      }),
      [{ type: "at", attrs: { id: "bot" } }, ...text],
      identity,
    );
    assert.equal(result.allow, false);
  }
});

test("chat decision uses controlled adapter evidence for private-like groups", async () => {
  const discordCalls: any[] = [];
  const discord = groupSession({
    platform: "discord",
    channelId: "channel",
    userId: "owner-discord",
    bot: {
      selfId: "bot",
      async hasOnlyOwnerUsers(
        chatId: string,
        ownerIds: string[],
        context: any,
      ) {
        discordCalls.push({ chatId, ownerIds, platform: context.platform });
        return true;
      },
    },
  });
  assert.equal(
    await decision.isPrivateLikeGroupSession(discord, identity),
    false,
  );
  assert.equal(
    await decision.isEffectivePrivateChatSession(discord, identity),
    false,
  );
  assert.deepEqual(discordCalls, []);

  const telegram = groupSession({
    channelId: "-cache-owner-test",
    bot: {
      selfId: "bot",
      internal: {
        async getChatMemberCount() {
          return 2;
        },
        async getChatMember({ user_id }: any) {
          return { status: "member", user: { id: String(user_id) } };
        },
      },
    },
  });
  assert.equal(
    await decision.isPrivateLikeGroupSession(telegram, identity),
    true,
  );
  assert.equal(
    await decision.isPrivateLikeGroupSession(telegram, identity),
    true,
  );

  const onebot = groupSession({
    platform: "onebot",
    channelId: "group-7",
    userId: "owner-onebot",
    bot: {
      selfId: "onebot",
      internal: {
        async getGroupInfo() {
          return { member_count: 3 };
        },
      },
    },
  });
  assert.equal(
    await decision.isPrivateLikeGroupSession(onebot, identity),
    false,
  );

  const lark = groupSession({
    platform: "lark",
    channelId: "chat-lark-owner",
    userId: "owner-lark",
    bot: {
      selfId: "lark-bot",
      internal: {
        async listChatMembers() {
          return {
            code: 0,
            data: {
              member_total: 1,
              items: [{ member_id: "owner-lark" }],
              has_more: false,
            },
          };
        },
        async getChat() {
          return { code: 0, data: { user_count: "1", bot_count: "1" } };
        },
      },
    },
  });
  assert.equal(await decision.isPrivateLikeGroupSession(lark, identity), true);

  const failures = [
    groupSession({ guildId: "" }),
    groupSession({ userId: "trusted" }),
    groupSession({ platform: "unknown", channelId: "unknown" }),
    groupSession({
      channelId: "throws",
      bot: {
        selfId: "bot",
        async getGuildMemberCount() {
          throw new Error("nope");
        },
      },
    }),
  ];
  for (const session of failures) {
    assert.equal(
      await decision.isPrivateLikeGroupSession(session, identity),
      false,
    );
  }
  assert.equal(
    await decision.isEffectivePrivateChatSession({ isDirect: true }, identity),
    true,
  );
});

test("chat decision rejects incomplete adapter fallbacks and malformed membership evidence", async () => {
  const throwingChecker = groupSession({
    platform: "discord",
    channelId: "throwing-checker",
    userId: "owner-discord",
    selfId: undefined,
    bot: {
      selfId: "bot-fallback",
      async hasOnlyOwnerUsers() {
        throw new Error("unavailable");
      },
      async getGuildMemberCount() {
        return 2;
      },
    },
  });
  assert.equal(
    await decision.isPrivateLikeGroupSession(throwingChecker, identity),
    false,
  );

  const onebotCamel = groupSession({
    platform: "onebot",
    channelId: "camel-count",
    userId: "owner-onebot",
    bot: {
      selfId: "onebot",
      internal: {
        async getGroupInfo() {
          return { memberCount: 2 };
        },
      },
    },
  });
  assert.equal(
    await decision.isPrivateLikeGroupSession(onebotCamel, identity),
    false,
  );

  const larkDirect = groupSession({
    platform: "lark",
    channelId: "direct-response",
    userId: "owner-lark",
    bot: {
      selfId: "lark",
      internal: {
        async getChat() {
          return { userCount: 1, botCount: "bad" };
        },
      },
    },
  });
  assert.equal(
    await decision.isPrivateLikeGroupSession(larkDirect, identity),
    false,
  );
  assert.equal(
    await decision.isPrivateLikeGroupSession(
      groupSession({ platform: "", channelId: "", userId: "owner" }),
      identity,
    ),
    false,
  );
  assert.equal(
    await decision.isOwnerPresentForGroup(groupSession({ userId: "trusted" }), {
      aliases: null,
      persons: {},
    }),
    false,
  );

  for (const [member, expected] of [
    [{ status: "restricted", is_member: true }, true],
    [{ status: "creator" }, true],
    [{ status: "unknown" }, false],
    [{ nickname: "Owner" }, true],
    [null, false],
  ] as const) {
    const present = await decision.isOwnerPresentForGroup(
      groupSession({
        platform: "discord",
        channelId: `member-${String(expected)}-${JSON.stringify(member)}`,
        userId: "other",
        bot: {
          async getGuildMember() {
            return member;
          },
        },
      }),
      identity,
    );
    assert.equal(present, expected);
  }
});

test("chat decision checks owner membership through Telegram, OneBot, and generic adapters", async () => {
  assert.equal(
    await decision.isOwnerPresentForGroup(groupSession(), identity),
    true,
  );
  assert.equal(
    await decision.isOwnerPresentForGroup(
      groupSession({
        userId: "trusted",
        bot: {
          internal: {
            async getChatMember() {
              throw new Error("offline");
            },
          },
        },
      }),
      identity,
    ),
    false,
  );
  assert.equal(
    await decision.isOwnerPresentForGroup(
      groupSession({
        platform: "onebot",
        channelId: "group",
        userId: "other",
        bot: {
          internal: {
            async getGroupMemberInfo() {
              return { role: "member", user_id: "owner-onebot" };
            },
          },
        },
      }),
      identity,
    ),
    true,
  );
  assert.equal(
    await decision.isOwnerPresentForGroup(
      groupSession({
        platform: "discord",
        channelId: "channel",
        userId: "other",
        bot: {
          async getGuildMember() {
            return { user: { id: "owner-discord" } };
          },
        },
      }),
      identity,
    ),
    true,
  );
});
