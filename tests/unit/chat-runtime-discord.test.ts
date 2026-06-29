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
const extraAdapters = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat-runtime", "extra-adapters.js"),
  ).href
);

function namedPermission(value: boolean, name: string, bit: bigint) {
  return {
    has(flag: unknown) {
      return value && (flag === name || flag === bit);
    },
  };
}

function viewPermission(value: boolean) {
  return namedPermission(value, "ViewChannel", 1024n);
}

function adminPermission(value: boolean) {
  return namedPermission(value, "Administrator", 8n);
}

test("discord adapter syncs application commands through the Discord client", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-discord-"),
  );
  try {
    let bot: any = null;
    const adapter = new extraAdapters.DiscordAdapter(
      {
        register(_adapter: unknown, registeredBot: any) {
          bot = registeredBot;
        },
      },
      agentDir,
      { commandGuildIds: ["guild-1", " guild-2 "] },
      { warn() {}, info() {}, error() {}, debug() {} },
    );
    assert.ok(bot);
    const calls: any[] = [];
    (adapter as any).client = {
      application: {
        commands: {
          async set(commands: any[], guildId?: string) {
            calls.push({ commands, guildId });
          },
        },
      },
    };

    await bot.internal.setApplicationCommands({
      commands: [{ name: "status", description: "Show status", type: 1 }],
    });

    assert.deepEqual(calls, [
      {
        commands: [{ name: "status", description: "Show status", type: 1 }],
        guildId: "guild-1",
      },
      {
        commands: [{ name: "status", description: "Show status", type: 1 }],
        guildId: "guild-2",
      },
    ]);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("discord adapter falls back to Discord REST for command sync", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-discord-"),
  );
  try {
    let bot: any = null;
    const adapter = new extraAdapters.DiscordAdapter(
      {
        register(_adapter: unknown, registeredBot: any) {
          bot = registeredBot;
        },
      },
      agentDir,
      {},
      { warn() {}, info() {}, error() {}, debug() {} },
    );
    assert.ok(bot);
    bot.selfId = "bot-discord";
    const calls: any[] = [];
    (adapter as any).client = {
      rest: {
        async put(route: string, payload: any) {
          calls.push({ route, payload });
        },
      },
    };

    await bot.internal.setApplicationCommands({
      commands: [{ name: "status", description: "Show status", type: 1 }],
      guildIds: ["guild-1"],
    });

    assert.deepEqual(calls, [
      {
        route: "/applications/bot-discord/guilds/guild-1/commands",
        payload: {
          body: [{ name: "status", description: "Show status", type: 1 }],
        },
      },
    ]);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("discord adapter treats command sync before ready as a no-op", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-discord-"),
  );
  try {
    let bot: any = null;
    new extraAdapters.DiscordAdapter(
      {
        register(_adapter: unknown, registeredBot: any) {
          bot = registeredBot;
        },
      },
      agentDir,
      {},
      { warn() {}, info() {}, error() {}, debug() {} },
    );
    assert.ok(bot);

    assert.equal(
      await bot.internal.setApplicationCommands({
        commands: [{ name: "status", description: "Show status", type: 1 }],
      }),
      false,
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("discord adapter maps chat input interactions to Rin slash messages", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-discord-"),
  );
  try {
    const emitted: any[] = [];
    const adapter = new extraAdapters.DiscordAdapter(
      {
        register() {},
        emit(eventName: string, payload: any) {
          emitted.push({ eventName, payload });
        },
      },
      agentDir,
      {},
      { warn() {}, info() {}, error() {}, debug() {} },
    );
    (adapter as any).bot.selfId = "bot-discord";
    const replies: any[] = [];

    await (adapter as any).handleInteraction({
      id: "interaction-1",
      commandName: "model",
      channelId: "channel-1",
      channel: { name: "rin-dev" },
      guildId: "guild-1",
      guild: { name: "Rin Dev" },
      createdTimestamp: 1710000000000,
      user: {
        id: "owner-discord",
        bot: false,
        globalName: "Owner",
        username: "owner",
      },
      member: { displayName: "Owner Nick" },
      options: {
        getString(name: string) {
          assert.equal(name, "input");
          return "google/gemini-test";
        },
      },
      isChatInputCommand() {
        return true;
      },
      async reply(payload: any) {
        replies.push(payload);
      },
    });

    assert.deepEqual(replies, [{ content: "Working...", ephemeral: true }]);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].eventName, "message");
    assert.equal(emitted[0].payload.platform, "discord");
    assert.equal(emitted[0].payload.messageId, "interaction-1");
    assert.equal(emitted[0].payload.channelId, "channel-1");
    assert.equal(emitted[0].payload.guildId, "guild-1");
    assert.equal(emitted[0].payload.userId, "owner-discord");
    assert.equal(emitted[0].payload.content, "/model google/gemini-test");
    assert.deepEqual(emitted[0].payload.stripped, {
      appel: true,
      content: "/model google/gemini-test",
    });
    assert.deepEqual(emitted[0].payload.elements, [
      {
        type: "text",
        attrs: { content: "/model google/gemini-test" },
        children: [],
      },
    ]);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("discord adapter treats guilds with only owner and bots as owner-only", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-discord-"),
  );
  try {
    let bot: any = null;
    const adapter = new extraAdapters.DiscordAdapter(
      {
        register(_adapter: unknown, registeredBot: any) {
          bot = registeredBot;
        },
      },
      agentDir,
      {},
      { warn() {}, info() {}, error() {}, debug() {} },
    );
    assert.ok(bot);
    bot.selfId = "bot-discord";

    const members = new Map<string, any>([
      ["owner-discord", { id: "owner-discord", user: { bot: false } }],
      ["bot-discord", { id: "bot-discord", user: { bot: true } }],
      ["other-bot", { id: "other-bot", user: { bot: true } }],
    ]);
    let unboundedGuildFetchCalled = false;
    (adapter as any).client = {
      channels: {
        async fetch(channelId: string) {
          assert.equal(channelId, "channel-owner-only");
          return {
            members: { cache: members },
            guild: {
              id: "guild-1",
              ownerId: "owner-discord",
              roles: { everyone: { id: "guild-1" }, cache: new Map() },
              members: {
                async fetch(userId?: string) {
                  if (userId) return members.get(userId);
                  unboundedGuildFetchCalled = true;
                  throw new Error("guild member gateway fetch unavailable");
                },
              },
            },
            permissionOverwrites: { cache: new Map() },
          };
        },
      },
    };

    assert.equal(
      await bot.hasOnlyOwnerUsers("channel-owner-only", ["owner-discord"]),
      true,
    );
    assert.equal(unboundedGuildFetchCalled, false);

    members.set("other-human", {
      id: "other-human",
      user: { bot: false },
    });
    assert.equal(
      await bot.hasOnlyOwnerUsers("channel-owner-only", ["owner-discord"]),
      false,
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("discord adapter proves owner-only channels from private permission overwrites", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-discord-"),
  );
  try {
    let bot: any = null;
    const adapter = new extraAdapters.DiscordAdapter(
      {
        register(_adapter: unknown, registeredBot: any) {
          bot = registeredBot;
        },
      },
      agentDir,
      {},
      { warn() {}, info() {}, error() {}, debug() {} },
    );
    assert.ok(bot);
    bot.selfId = "bot-discord";

    let guildOwnerId = "owner-discord";
    const roles = new Map<string, any>([
      ["guild-1", { id: "guild-1", permissions: adminPermission(false) }],
    ]);
    const overwrites = new Map<string, any>([
      [
        "guild-1",
        {
          id: "guild-1",
          type: 0,
          allow: viewPermission(false),
          deny: viewPermission(true),
        },
      ],
      [
        "owner-discord",
        {
          id: "owner-discord",
          type: 1,
          allow: viewPermission(true),
          deny: viewPermission(false),
        },
      ],
      [
        "bot-discord",
        {
          id: "bot-discord",
          type: 1,
          allow: viewPermission(true),
          deny: viewPermission(false),
        },
      ],
    ]);
    (adapter as any).client = {
      channels: {
        async fetch(channelId: string) {
          assert.equal(channelId, "channel-owner-only");
          return {
            guild: {
              id: "guild-1",
              ownerId: guildOwnerId,
              roles: { everyone: { id: "guild-1" }, cache: roles },
              members: {
                async fetch(userId?: string) {
                  assert.ok(
                    userId,
                    "owner-only check must not fetch all guild members",
                  );
                  return {
                    id: userId,
                    user: {
                      bot: userId === "bot-discord" || userId === "other-bot",
                    },
                  };
                },
              },
            },
            permissionOverwrites: { cache: overwrites },
          };
        },
      },
    };

    assert.equal(
      await bot.hasOnlyOwnerUsers("channel-owner-only", ["owner-discord"]),
      true,
    );

    overwrites.set("other-user", {
      id: "other-user",
      type: 1,
      allow: viewPermission(true),
      deny: viewPermission(false),
    });
    assert.equal(
      await bot.hasOnlyOwnerUsers("channel-owner-only", ["owner-discord"]),
      false,
    );

    overwrites.delete("other-user");
    overwrites.set("other-bot", {
      id: "other-bot",
      type: 1,
      allow: viewPermission(true),
      deny: viewPermission(false),
    });
    assert.equal(
      await bot.hasOnlyOwnerUsers("channel-owner-only", ["owner-discord"]),
      true,
    );

    overwrites.delete("other-bot");
    guildOwnerId = "server-owner";
    assert.equal(
      await bot.hasOnlyOwnerUsers("channel-owner-only", ["owner-discord"]),
      false,
    );

    guildOwnerId = "owner-discord";
    roles.set("admin-role", {
      id: "admin-role",
      managed: false,
      permissions: adminPermission(true),
    });
    assert.equal(
      await bot.hasOnlyOwnerUsers("channel-owner-only", ["owner-discord"]),
      false,
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});
