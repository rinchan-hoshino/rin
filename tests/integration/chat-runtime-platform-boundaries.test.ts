import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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

const adapters = Object.assign(
  {},
  await import(
    pathToFileURL(path.resolve("dist/core/chat-runtime/discord.js")).href
  ),
  await import(
    pathToFileURL(path.resolve("dist/core/chat-runtime/slack.js")).href
  ),
  await import(
    pathToFileURL(path.resolve("dist/core/chat-runtime/lark.js")).href
  ),
);

test("adapter private normalizers preserve defensive collection and media boundaries", () => {
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

  for (const [name, mime, expected] of [
    ["a.opus", "", "opus"],
    ["a", "audio/opus", "opus"],
    ["a.mp4", "", "mp4"],
    ["a.pdf", "", "pdf"],
    ["a.docx", "", "doc"],
    ["a.xlsx", "", "xls"],
    ["a.pptx", "", "ppt"],
    ["a.bin", "", "stream"],
  ])
    assert.equal(seam.__rinOwnerLarkFileType(name, mime), expected);
  assert.equal(seam.__rinOwnerTruncateSlackPlainText(" short ", 10), "short");
  assert.equal(seam.__rinOwnerTruncateSlackPlainText("owner text", 5), "owne…");

  assert.deepEqual(seam.__rinOwnerTodoNodeItems(null), []);
  assert.deepEqual(
    seam.__rinOwnerTodoNodeItems({
      attrs: { todos: [null, {}, { text: " owner ", done: 1 }] },
    }),
    [{ text: "owner", done: true }],
  );
  assert.equal(seam.__rinOwnerTodoNodeTitle(null), "Todo");
  assert.equal(
    seam.__rinOwnerTodoNodeTitle({ attrs: { title: " Owner " } }),
    "Owner",
  );

  const array = [1, 2];
  assert.equal(seam.__rinOwnerCollectionValues(null).length, 0);
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
        has: () => {
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
        get: () => {
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

test("discord and slack preserve fallback, authorization, and delivery error branches", async () => {
  resetOwner();
  await withTempDir(async (directory) => {
    const discordLog = logger();
    const discordApp = app();
    const discord = new adapters.DiscordAdapter(
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

    const slackLog = logger();
    const slackApp = app();
    const slack = new adapters.SlackAdapter(
      slackApp,
      directory,
      { token: "xapp", botToken: "xoxb" },
      slackLog,
    ) as any;
    const slackCalls: any[] = [];
    slack.web = {
      chat: {
        postMessage: async (payload: any) => {
          slackCalls.push(["post", payload]);
          return {
            ts: payload.text === "no-id" ? "" : `s${slackCalls.length}`,
          };
        },
        update: async () => ({}),
        delete: async () => true,
      },
      reactions: { add: async () => true, remove: async () => true },
      files: { uploadV2: async () => ({ file: { id: "file-one" } }) },
      users: {
        info: async () => {
          throw new Error("user unavailable");
        },
      },
    };
    slack.bot.selfId = "B1";
    await assert.rejects(
      slack.deleteReaction("C", "1", "::"),
      /emoji_required/,
    );
    assert.deepEqual(await slack.postText("C", "no-id"), []);
    assert.equal(slack.buildTodoBlocks({ attrs: {} }), null);
    const longItems = Array.from({ length: 11 }, (_, index) => ({
      text: index === 0 ? "x".repeat(100) : `task ${index}`,
      done: index % 2 === 0,
    }));
    const blocks = slack.buildTodoBlocks({
      attrs: { todos: [null, { text: "" }, ...longItems] },
    });
    assert.equal(blocks.blocks.length, 3);
    assert.equal(
      blocks.blocks[1].elements[0].options[0].text.text.length <= 75,
      true,
    );
    assert.deepEqual(
      await slack.sendMedia("C", { type: "file", attrs: {} }),
      [],
    );
    assert.deepEqual(
      await slack.sendMedia(
        "C",
        { type: "file", attrs: { src: "https://owner/file" } },
        "thread",
      ),
      ["s2"],
    );
    assert.deepEqual(
      await slack.sendMedia("C", {
        type: "file",
        attrs: { data: Buffer.from("x"), name: "x.txt" },
      }),
      ["file-one"],
    );

    for (const envelope of [
      {
        type: "events_api",
        body: { event: { type: "message", subtype: "edited", user: "U" } },
      },
      { type: "events_api", body: { event: { type: "message", user: "B1" } } },
      { type: "events_api", body: { event: { type: "message" } } },
    ]) {
      await slack.handleSlackEvent(envelope);
    }
    const eventFetch = slack.httpTransport.fetch;
    try {
      slack.httpTransport.fetch = async () =>
        new Response(Buffer.from("image"));
      await slack.handleSlackEvent({
        type: "events_api",
        body: {
          authorizations: [{ team_id: "T2" }],
          event: {
            type: "message",
            subtype: "file_share",
            user: "U2",
            channel: "D1",
            ts: "bad",
            text: "",
            thread_ts: "thread",
            files: [{ url_private: "https://owner/image", name: "image.png" }],
          },
        },
      });
    } finally {
      slack.httpTransport.fetch = eventFetch;
    }
    assert.equal(slackApp.records.at(-1)[1].isDirect, true);
    assert.deepEqual(slackApp.records.at(-1)[1].elements[0], {
      type: "quote",
      attrs: { id: "thread" },
      children: [],
    });

    slack.web.chat.postMessage = async () => {
      throw new Error("post failed");
    };
    await assert.rejects(
      slack.bot.sendMessage("C", [
        { type: "text", attrs: { content: "owner" }, children: [] },
      ]),
      /post failed/,
    );
    assert.equal(
      slackLog.records.some((entry: any[]) =>
        /rich message segment failed/.test(entry.join(" ")),
      ),
      true,
    );
  });
});

test("adapter platform permutations keep lifecycle, identity, and ingress fallbacks observable", async () => {
  resetOwner();
  await withTempDir(async (directory) => {
    const discordLog = logger();
    const discordApp = app(directory);
    const discord = new adapters.DiscordAdapter(
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

    const slackApp = app();
    const slackLog = logger();
    const slack = new adapters.SlackAdapter(
      slackApp,
      directory,
      { token: "xapp", botToken: "xoxb" },
      slackLog,
    ) as any;
    const socket = new EventEmitter() as any;
    socket.start = async () => {};
    socket.disconnect = async () => {
      throw new Error("disconnect failed");
    };
    owner.slackSocket = socket;
    owner.slackWeb = {
      auth: { test: async () => ({}) },
      chat: {
        postMessage: async () => ({ ts: "posted" }),
        update: async () => ({}),
        delete: async () => true,
      },
      reactions: { add: async () => true, remove: async () => true },
      files: { uploadV2: async () => ({}) },
      users: {
        info: async () => ({ user: { profile: { display_name: "Display" } } }),
      },
    };
    await slack.start();
    assert.equal(slack.bot.selfId, "");
    assert.equal(slack.bot.user.name, undefined);
    socket.emit("connected");
    socket.emit("disconnected");
    socket.emit("error", "socket scalar");
    socket.emit("slack_event", {
      type: "events_api",
      body: { event: { type: "message", user: "U", channel: "C" } },
    });
    await new Promise((resolve) => setImmediate(resolve));
    await slack.stop();

    slack.web = owner.slackWeb;
    assert.equal(await slack.bot.internal.apiCall("method"), undefined);
    assert.deepEqual(
      slack.buildTodoBlocks({
        attrs: { title: "", items: [{ text: "one", done: false }] },
      }).text,
      "Todo\n⬜ one",
    );
    assert.deepEqual(await slack.postTodo("C", { attrs: { items: [] } }), []);
    slack.web.chat.postMessage = async () => ({});
    assert.deepEqual(
      await slack.postTodo("C", { attrs: { items: [{ text: "one" }] } }),
      [],
    );
    assert.equal(
      await slack.uploadFile("C", { data: Buffer.from("x"), name: "x" }),
      "",
    );

    const larkLog = logger();
    const larkApp = app();
    const lark = new adapters.LarkAdapter(
      larkApp,
      directory,
      { appId: "app", appSecret: "secret" },
      larkLog,
    ) as any;
    lark.bot.selfId = "app";
    lark.client = {
      im: {
        message: {
          get: async () => ({ data: { items: [] } }),
          create: async () => ({ code: 0 }),
          reply: async () => ({ code: 0 }),
        },
        messageResource: { get: async () => null },
        chat: { get: async () => null },
        messageReaction: {
          create: async () => true,
          list: async () => ({}),
          delete: async () => true,
        },
        image: { create: async () => ({ image_key: "key" }) },
      },
    };

    assert.deepEqual(
      lark.parseMessageContent('{"mentions":[{"key":"x"}]}').mentions,
      [{ key: "x" }],
    );
    assert.equal(lark.parseMessageContent("{}").text, "{}");
    assert.deepEqual(lark.parsePostContentNodes(null), []);
    assert.equal(
      lark.parseLarkMessageContentNodes("image", '{"key":"k"}')[0].attrs.src,
      "k",
    );
    assert.equal(
      lark.parseLarkMessageContentNodes("image", "raw")[0].attrs.src,
      "raw",
    );
    assert.equal(
      lark.parseLarkMessageContentNodes("file", '{"key":"k","name":"n"}')[0]
        .attrs.name,
      "n",
    );
    assert.equal(
      lark.parseLarkMessageContentNodes("text", "@_owner", [
        { key: "@_owner", open_id: "open" },
      ])[0].attrs.id,
      "open",
    );
    assert.deepEqual(lark.pickLarkMessageItems({ items: [2] }), [2]);
    assert.equal(lark.larkForwardSenderName({ message_id: "m" }), "m");
    assert.equal(lark.larkForwardSenderName({}), "unknown");
    assert.equal(await lark.cacheLarkMessageResource("m", "k", "file"), null);
    assert.deepEqual(
      await lark.resolveLarkMessageResources("m", [
        { type: "image", attrs: null },
      ]),
      [{ type: "image", attrs: null }],
    );
    assert.equal(await lark.bot.deleteReaction("chat", "m", "custom"), false);
    assert.equal(
      lark.renderOutboundText([
        { type: "at", attrs: { id: "", name: "Owner" }, children: [] },
      ]),
      "Owner",
    );
    assert.deepEqual(await lark.sendData("chat", { msg_type: "text" }), []);

    const postCases = [
      "",
      "[bad]()",
      "<span>bad</span>",
      '<at user_id="owner"></at>',
      '<at user_id="owner">Owner</at>',
      "```\ncode\n```",
      "---",
      "a\n\n\nb",
      "- one\n\nplain",
    ];
    for (const value of postCases) lark.buildPostData(value);

    for (const data of [
      {},
      { sender: { sender_type: "app" } },
      { sender: { sender_type: "bot" } },
      { sender: { sender_type: "user" } },
      {
        sender: { sender_id: { user_id: "user" } },
        message: {
          msg_type: "text",
          chat_id: "group",
          create_time: "bad",
          content: '{"text":"hello"}',
          mentions: [],
        },
      },
      {
        sender: { id: "id" },
        message: {
          message_type: "merge_forward",
          message_id: "forward",
          chat_id: "group",
          parent_id: "parent",
        },
      },
      {
        sender: { sender_id: "string-user" },
        message: {
          message_type: "text",
          chat_type: "p2p",
          content: '{"text":""}',
        },
      },
    ]) {
      await lark.handleMessage(data);
    }
    assert.equal(larkApp.records.length, 3);

    lark.client.im.message.create = async () => {
      throw new Error("text failed");
    };
    await assert.rejects(
      lark.bot.sendMessage("chat", [
        { type: "text", attrs: { content: "owner" }, children: [] },
      ]),
      /text failed/,
    );
    lark.client.im.message.create = async () => ({
      code: 0,
      data: { message_id: "placeholder" },
    });
    assert.deepEqual(
      await lark.bot.sendMessage("chat", [
        { type: "image", attrs: {}, children: [] },
        { type: "text", attrs: { content: "after" }, children: [] },
      ]),
      ["placeholder", "placeholder"],
    );
  });
});
