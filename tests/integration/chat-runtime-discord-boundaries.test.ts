import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  app,
  logger,
  owner,
  resetOwner,
  withTempDir,
} from "../support/chat-runtime-adapters-owner-harness.ts";

const adapters = await import(
  pathToFileURL(path.resolve("dist/core/chat/platform/discord.js")).href
);

test("Discord private helpers preserve defensive collection and media boundaries", () => {
  const seam = adapters as any;
  assert.equal(seam.__rinOwnerCompareDiscordMessageIds("2", "10"), -1);
  assert.equal(seam.__rinOwnerCompareDiscordMessageIds("10", "2"), 1);
  assert.equal(seam.__rinOwnerCompareDiscordMessageIds("2", "2"), 0);
  assert.equal(
    seam.__rinOwnerCompareDiscordMessageIds(undefined, undefined),
    0,
  );
  assert.equal(
    seam.__rinOwnerCompareDiscordMessageIds("beta", "alpha") > 0,
    true,
  );
  assert.equal(seam.__rinOwnerIsOutboundMediaNodeType("image"), true);
  assert.equal(seam.__rinOwnerIsOutboundMediaNodeType("text"), false);

  const array = [1, 2];
  assert.deepEqual(seam.__rinOwnerCollectionValues(null), []);
  assert.equal(seam.__rinOwnerCollectionValues(array), array);
  assert.deepEqual(seam.__rinOwnerCollectionValues(new Map([["a", 1]])), [1]);
  assert.deepEqual(seam.__rinOwnerCollectionValues({ cache: [3] }), [3]);
  assert.deepEqual(
    seam.__rinOwnerCollectionValues({ values: () => [4][Symbol.iterator]() }),
    [4],
  );
  assert.deepEqual(
    seam.__rinOwnerCollectionValues({
      values() {
        throw new Error("owner");
      },
    }),
    [],
  );
  assert.equal(
    seam.__rinOwnerPermissionSetHasFlag(null, "ViewChannel", 1n),
    false,
  );
  assert.equal(
    seam.__rinOwnerPermissionSetHasFlag({ has: () => true }, "ViewChannel", 1n),
    true,
  );
  assert.equal(
    seam.__rinOwnerPermissionSetHasFlag({ bitfield: 1n }, "ViewChannel", 1n),
    true,
  );
  assert.equal(
    seam.__rinOwnerPermissionSetHasFlag(
      { has: (value: unknown) => value === 1n },
      "ViewChannel",
      1n,
    ),
    true,
  );
  assert.equal(
    seam.__rinOwnerPermissionSetHasFlag(
      {
        has() {
          throw new Error("owner");
        },
        bitfield: "invalid",
      },
      "ViewChannel",
      1n,
    ),
    false,
  );
  assert.equal(
    seam.__rinOwnerDiscordChannelDisplayName({ name: "general" }),
    "general",
  );
  assert.equal(
    seam.__rinOwnerDiscordChannelDisplayName({ rawName: "raw" }),
    "raw",
  );
  assert.equal(seam.__rinOwnerDiscordChannelDisplayName(null), "");
  assert.equal(seam.__rinOwnerFindDiscordChannelById(null, "room"), null);
  assert.deepEqual(
    seam.__rinOwnerFindDiscordChannelById(
      { get: () => ({ id: "room" }) },
      "room",
    ),
    { id: "room" },
  );
  assert.deepEqual(
    seam.__rinOwnerFindDiscordChannelById(
      { get: () => null, values: () => [{ id: "room" }][Symbol.iterator]() },
      "room",
    ),
    { id: "room" },
  );
  assert.equal(
    seam.__rinOwnerFindDiscordChannelById(
      {
        get() {
          throw new Error("owner");
        },
        values: () => [][Symbol.iterator](),
      },
      "missing",
    ),
    null,
  );
  assert.equal(seam.__rinOwnerResolveDiscordParentChannel(null), null);
  assert.equal(seam.__rinOwnerResolveDiscordParentChannel({}), null);
});

test("Discord preserves fallback, authorization, and delivery error branches", async () => {
  resetOwner();
  await withTempDir(async (directory) => {
    const discordLog = logger();
    const discordApp = app();
    const discord = new adapters.DiscordPlatform(
      discordApp,
      directory,
      { token: "token with spaces", applicationCommandGuildIds: " g1, ,g2 " },
      discordLog,
    ) as any;
    const discordBot = discord.bot;
    discordBot.selfId = "bot";

    const roles = new Map<string, any>([
      ["everyone", { id: "everyone", permissions: { bitfield: 0n } }],
      [
        "managed",
        {
          id: "managed",
          managed: true,
          tags: { bot_id: "bot" },
          permissions: { bitfield: 8n },
        },
      ],
    ]);
    const overwrites = new Map<string, any>([
      ["everyone", { id: "everyone", deny: { bitfield: 1024n } }],
      ["bot", { id: "bot", allow: { bitfield: 1024n } }],
      ["owner", { id: "owner", allow: { bitfield: 1024n } }],
      ["managed", { id: "managed", allow: { bitfield: 1024n } }],
    ]);
    const parent = { id: "parent", name: "Parent" };
    const channel: any = {
      id: "child",
      rawName: "Child",
      parentId: "parent",
      guild: {
        id: "everyone",
        name: "Guild",
        ownerID: "owner",
        channels: { cache: new Map([["parent", parent]]) },
        roles: { everyone: { id: "everyone" }, cache: roles },
        members: {
          cache: new Map(),
          fetch: async (id: string) =>
            id === "managed"
              ? { id, user: { id, bot: true } }
              : { id, user: { id, bot: false } },
        },
      },
      permissionOverwrites: { cache: overwrites },
      messages: {
        fetch: async () => undefined,
        delete: async () => false,
      },
      send: async (payload: any) => ({
        id: payload?.content ? "text" : "media",
      }),
    };
    discord.client = {
      channels: {
        fetch: async (id: string) => (id === "child" ? channel : null),
      },
      application: { id: "application", commands: {} },
      rest: {
        put: async (route: string, payload: any) => {
          owner.events.push(["discord-put", route, payload]);
        },
      },
    };
    discordBot.internal.rest = discord.client.rest;

    assert.equal(
      await discordBot.getGuildMember("missing", "owner"),
      undefined,
    );
    assert.equal(
      (await discordBot.getGuildMember("child", "owner")).id,
      "owner",
    );
    channel.permissionsFor = () => ({ has: () => false });
    assert.equal(await discordBot.getGuildMember("child", "owner"), null);
    channel.permissionsFor = undefined;

    assert.equal(
      await discordBot.internal.setApplicationCommands({ commands: null }),
      true,
    );
    assert.deepEqual(
      owner.events
        .filter(([name]: any[]) => name === "discord-put")
        .map((entry: any[]) => entry[1]),
      [
        "/applications/bot/guilds/g1/commands",
        "/applications/bot/guilds/g2/commands",
      ],
    );
    discord.client.rest = null;
    discordBot.internal.rest = null;
    assert.equal(await discordBot.internal.setApplicationCommands({}), false);

    assert.equal(
      await discordBot.internal.createReaction("child", "missing", "🔥"),
      undefined,
    );
    assert.equal(
      await discordBot.internal.deleteOwnReaction("child", "missing", "🔥"),
      undefined,
    );
    assert.equal(
      await discordBot.internal.editMessage("child", "missing", {}),
      undefined,
    );
    assert.equal(
      await discordBot.internal.deleteMessage("child", "missing"),
      false,
    );
    assert.deepEqual(
      await discordBot.sendMessage("child", [
        { type: "at", attrs: { id: "owner", name: "Owner" }, children: [] },
        { type: "file", attrs: {}, children: [] },
      ]),
      ["text"],
    );
    await assert.rejects(
      discordBot.sendMessage("missing", [
        { type: "text", attrs: { content: "x" } },
      ]),
      /channel_not_sendable/,
    );

    const originalRestRequest = discord.restRequest;
    const replies: any[] = [];
    try {
      discord.restRequest = {
        makeRequest: async () => ({
          ok: false,
          status: 401,
          text: async () => "denied",
        }),
      };
      await discord.acknowledgeInteraction({ id: "i", token: "t" });
      discord.restRequest = {
        makeRequest: async () => {
          throw new Error("callback offline");
        },
      };
      await discord.acknowledgeInteraction({
        id: "i",
        token: "t",
        reply: async (payload: any) => replies.push(payload),
      });
      await discord.acknowledgeInteraction({
        replied: true,
        reply: async () => {},
      });
      await discord.acknowledgeInteraction({
        reply: async () => {
          throw new Error("reply failed");
        },
      });
      await discord.acknowledgeInteraction({});
    } finally {
      discord.restRequest = originalRestRequest;
    }
    assert.equal(replies.length, 1);
    assert.equal(
      discordLog.records.some((entry: any[]) => /401/.test(entry.join(" "))),
      true,
    );
    assert.equal(
      discordLog.records.some((entry: any[]) =>
        /callback offline/.test(entry.join(" ")),
      ),
      true,
    );

    assert.equal(discord.discordInteractionCommandLine({}), "");
    assert.equal(
      discord.discordInteractionCommandLine({
        commandName: "MODEL",
        options: {
          getString: () => {
            throw new Error("bad option");
          },
        },
      }),
      "/model",
    );
    for (const message of [
      null,
      { author: { id: "bot" } },
      { author: { id: "other", bot: true } },
      { author: {} },
    ]) {
      await discord.handleMessage(message);
    }
    await discord.handleMessage({
      id: "direct",
      channelId: "child",
      channel: {
        id: "cycle",
        name: "same",
        parent: { id: "cycle", name: "same" },
      },
      author: { id: "owner", globalName: "Owner" },
      mentions: { users: { has: () => false } },
      attachments: new Map([["empty", {}]]),
      content: "plain",
      reference: { messageId: "quoted" },
    });
  });
});

test("Discord lifecycle, identity, and ingress fallbacks remain observable", async () => {
  resetOwner();
  await withTempDir(async (directory) => {
    const discordLog = logger();
    const discordApp = app(directory);
    const discord = new adapters.DiscordPlatform(
      discordApp,
      directory,
      { token: "discord" },
      discordLog,
    ) as any;
    discord.bot.selfId = "bot";
    assert.deepEqual(
      discord
        .mergeDiscordRecoveryMessages(
          [{ id: "10" }, { id: "2" }, { id: "same", value: 1 }],
          [{ id: "2" }, { id: "same", value: 2 }, { id: "alpha" }, {}],
        )
        .map((entry: any) => entry.id),
      ["2", "10", "alpha", "same"],
    );
    assert.deepEqual(
      discord
        .mergeDiscordRecoveryMessages([{ id: "1" }, { id: "1" }], [])
        .map((entry: any) => entry.id),
      ["1"],
    );

    const pageCalls: any[] = [];
    const pages = [
      new Map([
        ["equal", { id: "100" }],
        ["later", { id: "101" }],
      ]),
      new Map([["same", { id: "101" }]]),
    ];
    assert.deepEqual(
      await discord.fetchDiscordMessagesAfter(
        {
          messages: {
            fetch: async (payload: any) => (
              pageCalls.push(payload),
              pages.shift()
            ),
          },
        },
        "100",
      ),
      [{ id: "101" }],
    );
    assert.deepEqual(pageCalls, [
      { after: "100", limit: 100 },
      { after: "101", limit: 100 },
    ]);

    discord.client = {
      channels: { fetch: async () => ({}) },
      application: { commands: {} },
      user: { id: "client-user" },
      rest: { put: async () => true },
    };
    discord.bot.selfId = "";
    assert.equal(discord.discordApplicationId(), "client-user");
    discord.client.user.id = "";
    assert.equal(discord.discordApplicationCommandsRoute(), "");
    discord.client.application.id = "application id";
    assert.equal(
      discord.discordApplicationCommandsRoute(),
      "/applications/application%20id/commands",
    );
    assert.deepEqual(discord.discordCommandGuildIds([" one ", "", null]), [
      "one",
    ]);
    assert.deepEqual(discord.discordCommandGuildIds(undefined), []);
    assert.equal(
      await discord.bot.internal.setApplicationCommands({ guildIds: [] }),
      true,
    );

    const typing = discord.bot.workingIndicators.find(
      (item: any) => item.presentation === "typing",
    );
    discord.bot.internal.sendChatAction = async () => false;
    assert.equal(await typing.tick({ chatId: "chat" }), false);
    delete discord.bot.internal.sendChatAction;
    discord.bot.internal.sendTyping = async () => false;
    assert.equal(await typing.tick({ chatId: "chat" }), false);
    delete discord.bot.internal.sendTyping;
    assert.equal(await typing.tick({ chatId: "chat" }), false);

    const reaction = discord.bot.workingIndicators.find(
      (item: any) => item.presentation === "reaction",
    );
    discord.bot.createReaction = undefined;
    discord.bot.deleteReaction = undefined;
    discord.bot.internal.createReaction = async (...args: any[]) =>
      owner.events.push(["internal-create", ...args]);
    discord.bot.internal.deleteOwnReaction = undefined;
    discord.bot.internal.deleteReaction = async (...args: any[]) =>
      owner.events.push(["internal-delete", ...args]);
    discord.bot.selfId = "";
    assert.equal(
      await reaction.tick({ chatId: "chat", messageId: "message", tick: 0 }),
      true,
    );
    assert.equal(
      await reaction.tick({ chatId: "chat", messageId: "message", tick: 0 }),
      false,
    );
    assert.equal(
      await reaction.tick({
        chatId: "chat",
        messageId: "message",
        reactionDue: false,
      }),
      false,
    );
    assert.equal(
      await reaction.end({ chatId: "chat", messageId: "unknown" }),
      false,
    );
    assert.equal(
      await reaction.end({ chatId: "chat", messageId: "message" }),
      true,
    );
    discord.bot.internal.deleteReaction = undefined;
    assert.equal(await reaction.end({ chatId: "chat" }), false);

    const permissions = {
      has(value: unknown) {
        if (typeof value === "string") throw new Error("named unsupported");
        return value === 1024n;
      },
    };
    const channel: any = {
      guild: { members: { fetch: async () => ({ id: "owner" }) } },
      permissionsFor: () => permissions,
    };
    discord.client.channels.fetch = async () => channel;
    assert.equal(
      (await discord.bot.getGuildMember("chat", "owner")).id,
      "owner",
    );
    channel.permissionsFor = () => ({
      has() {
        throw new Error("unsupported");
      },
      bitfield: "1024",
    });
    assert.equal(
      (await discord.bot.getGuildMember("chat", "owner")).id,
      "owner",
    );
    channel.permissionsFor = undefined;
    assert.equal(
      (await discord.bot.getGuildMember("chat", "owner")).id,
      "owner",
    );

    const noValues = {
      values() {
        throw new Error("values failed");
      },
    };
    channel.guild = {
      id: "everyone",
      ownerId: "owner",
      roles: { everyone: { id: "everyone" }, cache: noValues },
      members: {
        cache: noValues,
        fetch: async () => {
          throw new Error("missing member");
        },
      },
    };
    channel.permissionOverwrites = { cache: noValues };
    await assert.rejects(
      discord.bot.getGuildMember("chat", "owner"),
      /missing member/,
    );

    discord.handleMessage = async () => {
      throw new Error("message failed");
    };
    discord.inboundGate.open();
    const client = owner.discordClients[0];
    if (client) {
      client.emit("message", { id: "bad" });
      client.emit("interaction", {});
      client.emit("disconnect");
      client.emit("error", "scalar error");
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
});
