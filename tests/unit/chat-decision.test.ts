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
    { platform: "lark", userId: "ou_owner", personId: "owner" },
    { platform: "onebot", userId: "10001", personId: "owner" },
    { platform: "onebot", userId: "10003", personId: "owner" },
    { platform: "slack", userId: "U_OWNER", personId: "owner" },
    { platform: "discord", userId: "owner-discord", personId: "owner" },
  ],
  persons: {
    owner: { trust: "OWNER" },
    trusted: { trust: "TRUSTED" },
  },
};

function makeTelegramGroupSession({
  chatId,
  memberCounts = [2],
  ownerStatus = "member",
  botStatus = "member",
  ownerIsMember = undefined,
  botIsMember = undefined,
  failMemberLookup = false,
}) {
  const botId = "8623230033";
  const calls = { count: 0, members: [] as any[] };
  return {
    calls,
    session: {
      platform: "telegram",
      guildId: chatId,
      channelId: chatId,
      selfId: botId,
      userId: "owner-1",
      bot: {
        selfId: botId,
        internal: {
          async getChatMemberCount(payload) {
            assert.deepEqual(payload, { chat_id: chatId });
            const index = Math.min(calls.count, memberCounts.length - 1);
            calls.count += 1;
            return memberCounts[index];
          },
          async getChatMember(payload) {
            calls.members.push(payload);
            if (failMemberLookup) throw new Error("lookup_failed");
            const userId = String(payload.user_id);
            const isAgent = userId === botId;
            return {
              status: isAgent ? botStatus : ownerStatus,
              ...(isAgent
                ? botIsMember === undefined
                  ? {}
                  : { is_member: botIsMember }
                : ownerIsMember === undefined
                  ? {}
                  : { is_member: ownerIsMember }),
              user: { id: Number(userId) || userId },
            };
          },
        },
      },
      stripped: { content: "private note" },
      elements: [{ type: "text", attrs: { content: "private note" } }],
    },
  };
}

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

test("chat decision fails closed when Telegram membership APIs are unavailable", async () => {
  const result = await decision.shouldProcessText(
    {
      platform: "telegram",
      guildId: "group-1",
      channelId: "-1001447529496",
      selfId: "8623230033",
      userId: "owner-1",
      bot: { selfId: "8623230033" },
      stripped: { content: "group note" },
      elements: [{ type: "text", attrs: { content: "group note" } }],
    },
    [{ type: "text", attrs: { content: "group note" } }],
    identity,
  );

  assert.equal(result.allow, false);
  assert.equal(result.chatKey, "telegram/8623230033:-1001447529496");
  assert.equal(result.chatType, "group");
  assert.equal(result.trust, "OWNER");
  assert.equal(result.requiresMentionToStartTurn, true);
});

test("chat decision lets Telegram owner-and-agent groups skip mention", async () => {
  const { session, calls } = makeTelegramGroupSession({
    chatId: "-1001447529497",
  });
  const result = await decision.shouldProcessText(
    session,
    session.elements,
    identity,
  );

  assert.equal(result.allow, true);
  assert.equal(result.chatType, "group");
  assert.equal(result.requiresMentionToStartTurn, false);
  assert.deepEqual(calls.members, [
    { chat_id: "-1001447529497", user_id: "owner-1" },
    { chat_id: "-1001447529497", user_id: "8623230033" },
  ]);
});

test("chat decision caches Telegram groups with a third member", async () => {
  const { session, calls } = makeTelegramGroupSession({
    chatId: "-1001447529498",
    memberCounts: [3, 2],
  });

  const first = await decision.shouldProcessText(
    session,
    session.elements,
    identity,
  );
  const second = await decision.shouldProcessText(
    session,
    session.elements,
    identity,
  );

  assert.equal(first.allow, false);
  assert.equal(second.allow, false);
  assert.equal(calls.count, 1);
  assert.deepEqual(calls.members, []);
});

test("chat decision rejects Telegram groups when owner or agent is no longer a member", async () => {
  for (const [suffix, ownerStatus, botStatus] of [
    ["owner-left", "left", "member"],
    ["bot-left", "member", "kicked"],
  ]) {
    const { session, calls } = makeTelegramGroupSession({
      chatId: `-100-${suffix}`,
      ownerStatus,
      botStatus,
    });
    const result = await decision.shouldProcessText(
      session,
      session.elements,
      identity,
    );
    assert.equal(result.allow, false, suffix);
    assert.equal(result.requiresMentionToStartTurn, true, suffix);
    assert.equal(calls.count, 1, suffix);
    assert.equal(calls.members.length, 2, suffix);
  }
});

test("chat decision fails closed when Telegram member lookup fails", async () => {
  const { session, calls } = makeTelegramGroupSession({
    chatId: "-1001447529499",
    failMemberLookup: true,
  });
  const result = await decision.shouldProcessText(
    session,
    session.elements,
    identity,
  );

  assert.equal(result.allow, false);
  assert.equal(result.requiresMentionToStartTurn, true);
  assert.equal(calls.count, 1);
  assert.equal(calls.members.length, 2);
});

test("chat decision rejects malformed Telegram member statuses", async () => {
  for (const [suffix, options] of [
    ["missing-status", { ownerStatus: null }],
    [
      "string-restricted-membership",
      { ownerStatus: "restricted", ownerIsMember: "false" },
    ],
  ]) {
    const { session } = makeTelegramGroupSession({
      chatId: `-100-${suffix}`,
      ...options,
    });
    const result = await decision.shouldProcessText(
      session,
      session.elements,
      identity,
    );

    assert.equal(result.allow, false, suffix);
    assert.equal(result.requiresMentionToStartTurn, true, suffix);
  }
});

test("chat decision rejects noncanonical platform member-id fields", async () => {
  const telegram = await decision.shouldProcessText(
    {
      platform: "telegram",
      guildId: "-100-noncanonical",
      channelId: "-100-noncanonical",
      selfId: "8623230033",
      userId: "owner-1",
      bot: {
        selfId: "8623230033",
        internal: {
          async getChatMemberCount() {
            return 2;
          },
          async getChatMember({ user_id }) {
            return { status: "member", userId: user_id };
          },
        },
      },
      stripped: { content: "private note" },
      elements: [{ type: "text", attrs: { content: "private note" } }],
    },
    [{ type: "text", attrs: { content: "private note" } }],
    identity,
  );
  const lark = await decision.shouldProcessText(
    {
      platform: "lark",
      guildId: "oc_noncanonical",
      channelId: "oc_noncanonical",
      selfId: "cli_bot_noncanonical",
      userId: "ou_owner",
      bot: {
        selfId: "cli_bot_noncanonical",
        internal: {
          async listChatMembers() {
            return {
              code: 0,
              data: {
                items: [{ memberId: "ou_owner" }],
                has_more: false,
                member_total: 1,
              },
            };
          },
          async getChat() {
            return { code: 0, data: { user_count: "1", bot_count: "1" } };
          },
        },
      },
      stripped: { content: "private note" },
      elements: [{ type: "text", attrs: { content: "private note" } }],
    },
    [{ type: "text", attrs: { content: "private note" } }],
    identity,
  );
  const onebot = await decision.shouldProcessText(
    {
      platform: "onebot",
      guildId: "20007",
      channelId: "20007",
      selfId: "90001",
      userId: "10001",
      bot: {
        selfId: "90001",
        internal: {
          async getGroupMemberList() {
            return [{ userId: "10001" }, { userId: "90001" }];
          },
        },
      },
      stripped: { content: "private note" },
      elements: [{ type: "text", attrs: { content: "private note" } }],
    },
    [{ type: "text", attrs: { content: "private note" } }],
    identity,
  );

  for (const result of [telegram, lark, onebot]) {
    assert.equal(result.allow, false);
    assert.equal(result.requiresMentionToStartTurn, true);
  }
});

test("chat decision rechecks Telegram owner-only proofs for newly joined members", async () => {
  const { session, calls } = makeTelegramGroupSession({
    chatId: "-1001447529500",
    memberCounts: [2, 3],
  });

  const beforeJoin = await decision.shouldProcessText(
    session,
    session.elements,
    identity,
  );
  const afterJoin = await decision.shouldProcessText(
    session,
    session.elements,
    identity,
  );

  assert.equal(beforeJoin.allow, true);
  assert.equal(afterJoin.allow, false);
  assert.equal(calls.count, 2);
});

test("chat decision keeps Feishu chats on normal group mention policy", async () => {
  const result = await decision.shouldProcessText(
    {
      platform: "lark",
      guildId: "oc_group",
      channelId: "oc_group",
      selfId: "ou_bot",
      userId: "ou_owner",
      bot: { selfId: "ou_bot" },
      stripped: { content: "group note" },
      elements: [{ type: "text", attrs: { content: "group note" } }],
    },
    [{ type: "text", attrs: { content: "group note" } }],
    identity,
  );

  assert.equal(result.allow, false);
  assert.equal(result.chatKey, "lark/ou_bot:oc_group");
  assert.equal(result.chatType, "group");
  assert.equal(result.trust, "OWNER");
  assert.equal(result.requiresMentionToStartTurn, true);
});

test("chat decision lets owner-only Lark chats with API string counts skip mention", async () => {
  const calls: any[] = [];
  const result = await decision.shouldProcessText(
    {
      platform: "lark",
      guildId: "oc_owner_only",
      channelId: "oc_owner_only",
      selfId: "cli_bot",
      userId: "ou_owner",
      bot: {
        selfId: "cli_bot",
        internal: {
          async listChatMembers(options) {
            calls.push(options);
            return {
              code: 0,
              data: {
                items: [{ member_id: "ou_owner" }],
                has_more: false,
                member_total: 1,
              },
            };
          },
          async getChat(options) {
            assert.deepEqual(options, { path: { chat_id: "oc_owner_only" } });
            return {
              code: 0,
              data: { user_count: "1", bot_count: "1" },
            };
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
  assert.equal(result.chatType, "group");
  assert.equal(result.requiresMentionToStartTurn, false);
  assert.deepEqual(calls, [
    {
      path: { chat_id: "oc_owner_only" },
      params: {
        member_id_type: "open_id",
        page_size: 100,
      },
    },
  ]);
});

test("chat decision fails closed when Lark chat counts are numeric", async () => {
  const result = await decision.shouldProcessText(
    {
      platform: "lark",
      guildId: "oc_numeric_counts",
      channelId: "oc_numeric_counts",
      selfId: "cli_bot_numeric_counts",
      userId: "ou_owner",
      bot: {
        selfId: "cli_bot_numeric_counts",
        internal: {
          async listChatMembers() {
            return {
              code: 0,
              data: {
                items: [{ member_id: "ou_owner" }],
                has_more: false,
                member_total: 1,
              },
            };
          },
          async getChat() {
            return { code: 0, data: { user_count: 1, bot_count: 1 } };
          },
        },
      },
      stripped: { content: "private note" },
      elements: [{ type: "text", attrs: { content: "private note" } }],
    },
    [{ type: "text", attrs: { content: "private note" } }],
    identity,
  );

  assert.equal(result.allow, false);
  assert.equal(result.requiresMentionToStartTurn, true);
});

test("chat decision rejects Lark chats containing a third bot", async () => {
  const result = await decision.shouldProcessText(
    {
      platform: "lark",
      guildId: "oc_third_bot",
      channelId: "oc_third_bot",
      selfId: "cli_bot_third_bot",
      userId: "ou_owner",
      bot: {
        selfId: "cli_bot_third_bot",
        internal: {
          async listChatMembers() {
            return {
              code: 0,
              data: {
                items: [{ member_id: "ou_owner" }],
                has_more: false,
                member_total: 1,
              },
            };
          },
          async getChat() {
            return { code: 0, data: { user_count: "1", bot_count: "2" } };
          },
        },
      },
      stripped: { content: "private note" },
      elements: [{ type: "text", attrs: { content: "private note" } }],
    },
    [{ type: "text", attrs: { content: "private note" } }],
    identity,
  );

  assert.equal(result.allow, false);
  assert.equal(result.requiresMentionToStartTurn, true);
});

test("chat decision rechecks owner-only lists so a newly joined member revokes bypass", async () => {
  let calls = 0;
  const session = {
    platform: "lark",
    guildId: "oc_owner_changes",
    channelId: "oc_owner_changes",
    selfId: "cli_bot_changes",
    userId: "ou_owner",
    bot: {
      selfId: "cli_bot_changes",
      internal: {
        async listChatMembers() {
          calls += 1;
          return {
            code: 0,
            data: {
              items:
                calls === 1
                  ? [{ member_id: "ou_owner" }]
                  : [{ member_id: "ou_owner" }, { member_id: "ou_other" }],
              has_more: false,
              member_total: calls === 1 ? 1 : 2,
            },
          };
        },
        async getChat() {
          return {
            code: 0,
            data: { user_count: calls === 1 ? "1" : "2", bot_count: "1" },
          };
        },
      },
    },
    stripped: { content: "private note" },
    elements: [{ type: "text", attrs: { content: "private note" } }],
  };
  const elements = [{ type: "text", attrs: { content: "private note" } }];

  const beforeJoin = await decision.shouldProcessText(
    session,
    elements,
    identity,
  );
  const afterJoin = await decision.shouldProcessText(
    session,
    elements,
    identity,
  );

  assert.equal(beforeJoin.allow, true);
  assert.equal(afterJoin.allow, false);
  assert.equal(calls, 2);
});

test("chat decision caches complete lists that already contain another user", async () => {
  let calls = 0;
  const session = {
    platform: "onebot",
    guildId: "20002",
    channelId: "20002",
    selfId: "90001",
    userId: "10001",
    bot: {
      selfId: "90001",
      internal: {
        async getGroupMemberList(groupId) {
          calls += 1;
          assert.equal(groupId, "20002");
          return [
            { user_id: "10001" },
            { user_id: "10002" },
            { user_id: "90001" },
          ];
        },
      },
    },
    stripped: { content: "shared note" },
    elements: [{ type: "text", attrs: { content: "shared note" } }],
  };
  const elements = [{ type: "text", attrs: { content: "shared note" } }];

  const first = await decision.shouldProcessText(session, elements, identity);
  const second = await decision.shouldProcessText(session, elements, identity);

  assert.equal(first.allow, false);
  assert.equal(second.allow, false);
  assert.equal(calls, 1);
});

test("chat decision isolates member-list caches by platform bot and chat", async () => {
  let calls = 0;
  const makeSession = (botId, chatId, shared) => ({
    platform: "onebot",
    guildId: chatId,
    channelId: chatId,
    selfId: botId,
    userId: "10001",
    bot: {
      selfId: botId,
      internal: {
        async getGroupMemberList() {
          calls += 1;
          return [
            { user_id: "10001" },
            ...(shared ? [{ user_id: "10002" }] : []),
            { user_id: botId },
          ];
        },
      },
    },
    stripped: { content: "group note" },
    elements: [{ type: "text", attrs: { content: "group note" } }],
  });
  const elements = [{ type: "text", attrs: { content: "group note" } }];

  const shared = await decision.shouldProcessText(
    makeSession("90001", "20004", true),
    elements,
    identity,
  );
  const ownerOnly = await decision.shouldProcessText(
    makeSession("90002", "20004", false),
    elements,
    identity,
  );

  assert.equal(shared.allow, false);
  assert.equal(ownerOnly.allow, true);
  assert.equal(calls, 2);
});

test("chat decision lets complete OneBot member lists containing only owner and agent skip mention", async () => {
  const result = await decision.shouldProcessText(
    {
      platform: "onebot",
      guildId: "20003",
      channelId: "20003",
      selfId: "90001",
      userId: "10001",
      bot: {
        selfId: "90001",
        internal: {
          async getGroupMemberList() {
            return [{ user_id: "10001" }, { user_id: "90001" }];
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
  assert.equal(result.requiresMentionToStartTurn, false);
});

test("chat decision rejects a third member even when that identity also maps to OWNER", async () => {
  const result = await decision.shouldProcessText(
    {
      platform: "onebot",
      guildId: "20006",
      channelId: "20006",
      selfId: "90001",
      userId: "10001",
      bot: {
        selfId: "90001",
        internal: {
          async getGroupMemberList() {
            return [
              { user_id: "10001" },
              { user_id: "10003" },
              { user_id: "90001" },
            ];
          },
        },
      },
      stripped: { content: "private note" },
      elements: [{ type: "text", attrs: { content: "private note" } }],
    },
    [{ type: "text", attrs: { content: "private note" } }],
    identity,
  );

  assert.equal(result.allow, false);
  assert.equal(result.requiresMentionToStartTurn, true);
});

test("chat decision rejects OneBot lists that do not prove the current agent is present", async () => {
  const result = await decision.shouldProcessText(
    {
      platform: "onebot",
      guildId: "20005",
      channelId: "20005",
      selfId: "90001",
      userId: "10001",
      bot: {
        selfId: "90001",
        internal: {
          async getGroupMemberList() {
            return [{ user_id: "10001" }];
          },
        },
      },
      stripped: { content: "private note" },
      elements: [{ type: "text", attrs: { content: "private note" } }],
    },
    [{ type: "text", attrs: { content: "private note" } }],
    identity,
  );

  assert.equal(result.allow, false);
  assert.equal(result.requiresMentionToStartTurn, true);
});

test("chat decision follows complete Slack member-list pagination", async () => {
  const cursors: string[] = [];
  const result = await decision.shouldProcessText(
    {
      platform: "slack",
      guildId: "T_TEAM",
      channelId: "C_OWNER_ONLY",
      selfId: "U_BOT",
      userId: "U_OWNER",
      bot: {
        selfId: "U_BOT",
        internal: {
          async conversationsMembers(options) {
            cursors.push(options.cursor || "");
            return options.cursor
              ? {
                  ok: true,
                  members: ["U_BOT"],
                  response_metadata: { next_cursor: "" },
                }
              : {
                  ok: true,
                  members: ["U_OWNER"],
                  response_metadata: { next_cursor: "next" },
                };
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
  assert.equal(result.requiresMentionToStartTurn, false);
  assert.deepEqual(cursors, ["", "next"]);
});

test("chat decision fails closed when member-list pagination is incomplete", async () => {
  const result = await decision.shouldProcessText(
    {
      platform: "lark",
      guildId: "oc_incomplete",
      channelId: "oc_incomplete",
      selfId: "cli_bot_incomplete",
      userId: "ou_owner",
      bot: {
        selfId: "cli_bot_incomplete",
        internal: {
          async listChatMembers() {
            return {
              code: 0,
              data: {
                items: [{ member_id: "ou_owner" }],
                has_more: true,
                page_token: "",
                member_total: 2,
              },
            };
          },
          async getChat() {
            return { code: 0, data: { user_count: "1", bot_count: "1" } };
          },
        },
      },
      stripped: { content: "private note" },
      elements: [{ type: "text", attrs: { content: "private note" } }],
    },
    [{ type: "text", attrs: { content: "private note" } }],
    identity,
  );

  assert.equal(result.allow, false);
  assert.equal(result.requiresMentionToStartTurn, true);
});

test("chat decision fails closed when Lark member_total contradicts the complete list", async () => {
  const result = await decision.shouldProcessText(
    {
      platform: "lark",
      guildId: "oc_total_mismatch",
      channelId: "oc_total_mismatch",
      selfId: "cli_bot_total_mismatch",
      userId: "ou_owner",
      bot: {
        selfId: "cli_bot_total_mismatch",
        internal: {
          async listChatMembers() {
            return {
              code: 0,
              data: {
                items: [{ member_id: "ou_owner" }],
                has_more: false,
                member_total: 2,
              },
            };
          },
          async getChat() {
            return { code: 0, data: { user_count: "1", bot_count: "1" } };
          },
        },
      },
      stripped: { content: "private note" },
      elements: [{ type: "text", attrs: { content: "private note" } }],
    },
    [{ type: "text", attrs: { content: "private note" } }],
    identity,
  );

  assert.equal(result.allow, false);
  assert.equal(result.requiresMentionToStartTurn, true);
});

test("chat decision fails closed when Lark omits success or total proof", async () => {
  for (const [suffix, response] of [
    [
      "missing-code",
      {
        data: {
          items: [{ member_id: "ou_owner" }],
          has_more: false,
          member_total: 1,
        },
      },
    ],
    [
      "missing-total",
      {
        code: 0,
        data: {
          items: [{ member_id: "ou_owner" }],
          has_more: false,
        },
      },
    ],
  ]) {
    const result = await decision.shouldProcessText(
      {
        platform: "lark",
        guildId: `oc_${suffix}`,
        channelId: `oc_${suffix}`,
        selfId: `cli_bot_${suffix}`,
        userId: "ou_owner",
        bot: {
          selfId: `cli_bot_${suffix}`,
          internal: {
            async listChatMembers() {
              return response;
            },
            async getChat() {
              return { code: 0, data: { user_count: "1", bot_count: "1" } };
            },
          },
        },
        stripped: { content: "private note" },
        elements: [{ type: "text", attrs: { content: "private note" } }],
      },
      [{ type: "text", attrs: { content: "private note" } }],
      identity,
    );

    assert.equal(result.allow, false, suffix);
    assert.equal(result.requiresMentionToStartTurn, true, suffix);
  }
});

test("chat decision fails closed when Lark omits pagination completeness", async () => {
  const result = await decision.shouldProcessText(
    {
      platform: "lark",
      guildId: "oc_missing_has_more",
      channelId: "oc_missing_has_more",
      selfId: "cli_bot_missing_has_more",
      userId: "ou_owner",
      bot: {
        selfId: "cli_bot_missing_has_more",
        internal: {
          async listChatMembers() {
            return {
              code: 0,
              data: {
                items: [{ member_id: "ou_owner" }],
                member_total: 1,
              },
            };
          },
          async getChat() {
            return { code: 0, data: { user_count: "1", bot_count: "1" } };
          },
        },
      },
      stripped: { content: "private note" },
      elements: [{ type: "text", attrs: { content: "private note" } }],
    },
    [{ type: "text", attrs: { content: "private note" } }],
    identity,
  );

  assert.equal(result.allow, false);
  assert.equal(result.requiresMentionToStartTurn, true);
});

test("chat decision fails closed when Slack omits pagination metadata", async () => {
  const result = await decision.shouldProcessText(
    {
      platform: "slack",
      guildId: "T_TEAM",
      channelId: "C_MISSING_METADATA",
      selfId: "U_BOT",
      userId: "U_OWNER",
      bot: {
        selfId: "U_BOT",
        internal: {
          async conversationsMembers() {
            return { ok: true, members: ["U_OWNER", "U_BOT"] };
          },
        },
      },
      stripped: { content: "private note" },
      elements: [{ type: "text", attrs: { content: "private note" } }],
    },
    [{ type: "text", attrs: { content: "private note" } }],
    identity,
  );

  assert.equal(result.allow, false);
  assert.equal(result.requiresMentionToStartTurn, true);
});

test("chat decision keeps Discord channels on normal group mention policy", async () => {
  const result = await decision.shouldProcessText(
    {
      platform: "discord",
      guildId: "guild-1",
      channelId: "channel-1",
      selfId: "bot-discord",
      userId: "owner-discord",
      bot: { selfId: "bot-discord" },
      stripped: { content: "group note" },
      elements: [{ type: "text", attrs: { content: "group note" } }],
    },
    [{ type: "text", attrs: { content: "group note" } }],
    identity,
  );

  assert.equal(result.allow, false);
  assert.equal(result.chatKey, "discord/bot-discord:channel-1");
  assert.equal(result.chatType, "group");
  assert.equal(result.trust, "OWNER");
  assert.equal(result.requiresMentionToStartTurn, true);
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
  assert.equal(result.text, "[image: demo.png](https://example.com/demo.png)");
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

test("chat decision rejects other group mentions before owner membership lookup", async () => {
  const queried: Array<{ chatId: string; userId: string }> = [];
  const result = await decision.shouldProcessText(
    {
      platform: "telegram",
      guildId: "group-1",
      channelId: "-1001447529496",
      selfId: "8623230033",
      userId: "stranger-1",
      bot: {
        selfId: "8623230033",
        username: "THE_cattail_rin_chan_bot",
        internal: {
          async getChatMember({ chat_id, user_id }) {
            queried.push({ chatId: chat_id, userId: user_id });
            return { status: "administrator" };
          },
        },
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

  assert.equal(result.allow, false);
  assert.equal(result.trust, "OTHER");
  assert.equal(result.requiresMentionToStartTurn, true);
  assert.deepEqual(queried, []);
});

test("chat decision requires owner presence before trusted group mentions can trigger", async () => {
  const queried: Array<{ chatId: string; userId: string }> = [];
  const result = await decision.shouldProcessText(
    {
      platform: "telegram",
      guildId: "group-1",
      channelId: "-1001447529496",
      selfId: "8623230033",
      userId: "trusted-1",
      bot: {
        selfId: "8623230033",
        username: "THE_cattail_rin_chan_bot",
        internal: {
          async getChatMember({ chat_id, user_id }) {
            queried.push({ chatId: chat_id, userId: user_id });
            return { status: "left" };
          },
        },
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

  assert.equal(result.allow, false);
  assert.deepEqual(queried, [{ chatId: "-1001447529496", userId: "owner-1" }]);
});

test("chat decision rejects trusted group mentions when owner membership is unverifiable", async () => {
  const result = await decision.shouldProcessText(
    {
      platform: "telegram",
      guildId: "group-1",
      channelId: "-1001447529496",
      selfId: "8623230033",
      userId: "trusted-1",
      bot: {
        selfId: "8623230033",
        username: "THE_cattail_rin_chan_bot",
        internal: {
          async getChatMember() {
            return {};
          },
        },
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

  assert.equal(result.allow, false);
});

test("chat decision allows trusted group mentions when an owner is present", async () => {
  const result = await decision.shouldProcessText(
    {
      platform: "telegram",
      guildId: "group-1",
      channelId: "-1001447529496",
      selfId: "8623230033",
      userId: "trusted-1",
      bot: {
        selfId: "8623230033",
        username: "THE_cattail_rin_chan_bot",
        internal: {
          async getChatMember({ chat_id, user_id }) {
            assert.equal(chat_id, "-1001447529496");
            assert.equal(user_id, "owner-1");
            return { status: "administrator" };
          },
        },
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
