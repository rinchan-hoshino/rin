import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

await import("../support/register-chat-runtime-adapters-owner-fixture.ts");
const adapters = await import(
  pathToFileURL(path.resolve("dist/core/chat-runtime/adapters.js")).href
);
// Reuse the current integration contracts; immutable characterization evidence
// remains outside strict owner coverage.
await import("./chat-runtime-discord.test.ts");
await import("./chat-runtime-send.test.ts");

const owner = (globalThis as any).__chatRuntimeAdaptersOwner as Record<
  string,
  any
>;

function logger() {
  const records: any[] = [];
  return {
    records,
    warn: (...args: any[]) => records.push(["warn", ...args]),
    info: (...args: any[]) => records.push(["info", ...args]),
    error: (...args: any[]) => records.push(["error", ...args]),
    debug: (...args: any[]) => records.push(["debug", ...args]),
  };
}

function app(agentDir?: string) {
  const records: any[] = [];
  const registered: any[] = [];
  return {
    agentDir,
    records,
    registered,
    register(adapter: any, bot: any) {
      registered.push({ adapter, bot });
    },
    emit(name: string, payload: any) {
      records.push([name, payload]);
      return true;
    },
  };
}

function resetOwner() {
  owner.events = [];
  owner.discordClients = [];
  owner.discordUser = {
    id: "discord-bot",
    username: "rin-bot",
    globalName: "Rin Bot",
  };
  owner.discordChannels = {
    fetch: async (id: string) => owner.discordChannelById?.[id],
  };
  owner.discordGuilds = {
    fetch: async (id: string) => owner.discordGuildById?.[id],
  };
  owner.discordApplication = {
    id: "discord-app",
    commands: { set: async () => true },
  };
  owner.discordRest = { put: async () => true };
  owner.discordChannelById = {};
  owner.discordGuildById = {};
  owner.discordLoginError = undefined;
  owner.discordDestroyError = undefined;
  owner.slackWeb = undefined;
  owner.slackSocket = undefined;
  owner.larkClient = undefined;
  owner.larkWs = undefined;
  owner.larkDispatcher = undefined;
  owner.webSockets = [];
  owner.wsOpenError = undefined;
  owner.wsSendError = undefined;
  owner.wsAutoReply = true;
  owner.wsReply = undefined;
}

async function withTempDir(run: (directory: string) => Promise<void>) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-adapters-owner-"),
  );
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

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
});

test("discord adapter owns SDK lifecycle, native wrappers, indicators, and ingress", async () => {
  resetOwner();
  await withTempDir(async (directory) => {
    const log = logger();
    const targetApp = app();
    const missing = new adapters.DiscordAdapter(targetApp, directory, {}, log);
    await assert.rejects(missing.start(), /discord_token_required/);
    assert.deepEqual(
      (missing as any)
        .mergeDiscordRecoveryMessages(
          [{ id: "beta" }, { id: "10" }, { id: "" }],
          [{ id: "alpha" }, { id: "2" }, { id: "10", newest: true }],
        )
        .map((message: any) => message.id),
      ["2", "10", "alpha", "beta"],
    );

    const messages = new Map<string, any>();
    const channel = {
      id: "channel-1",
      name: "owner-chat",
      guild: {
        id: "guild-1",
        name: "Owner Guild",
        members: {
          fetch: async (id: string) => ({ id, user: { id, bot: false } }),
        },
      },
      sendTyping: async () => "typed",
      permissionsFor: () => ({ has: () => false }),
      send: async (payload: any) => {
        const message = {
          id: `sent-${messages.size + 1}`,
          payload,
          edit: async (next: any) => ({ id: "edited", ...next }),
          react: async (emoji: string) => `reacted:${emoji}`,
          reactions: {
            cache: {
              find: () => ({ users: { remove: async (id: string) => id } }),
            },
          },
        };
        messages.set(message.id, message);
        return message;
      },
      messages: {
        fetch: async (id: string) => messages.get(id),
        delete: async (id: string) => messages.delete(id),
      },
    };
    owner.discordChannelById["channel-1"] = channel;
    owner.discordGuildById["guild-1"] = channel.guild;

    const adapter = new adapters.DiscordAdapter(
      targetApp,
      directory,
      { token: "discord-token" },
      log,
    );
    await adapter.start();
    const bot = adapter.bot;
    assert.equal(bot.status, 1);
    assert.equal(bot.selfId, "discord-bot");
    assert.equal(bot.user.name, "Rin Bot");
    assert.deepEqual(owner.discordClients[0].options.intents, [1, 2, 4, 8]);
    assert.deepEqual(owner.discordClients[0].options.partials, ["channel"]);
    assert.equal(owner.discordClients[0].options.rest.timeout, 60_000);
    assert.equal(owner.discordClients[0].options.rest.retries, 1);
    assert.equal(
      typeof owner.discordClients[0].options.rest.makeRequest,
      "function",
    );
    assert.equal(await bot.internal.fetchChannel("channel-1"), channel);
    assert.equal(await bot.internal.fetchGuild("guild-1"), channel.guild);
    assert.equal(
      (await bot.internal.fetchGuildMember("guild-1", "owner")).id,
      "owner",
    );
    assert.equal(await bot.internal.sendTyping("channel-1"), "typed");
    assert.equal(await bot.getGuildMember("channel-1", "owner"), null);
    channel.permissionsFor = () => ({ has: (flag: any) => flag === 1024n });
    assert.equal((await bot.getGuildMember("channel-1", "owner")).id, "owner");

    const typing = bot.workingIndicators.find(
      (item: any) => item.presentation === "typing",
    );
    const reaction = bot.workingIndicators.find(
      (item: any) => item.presentation === "reaction",
    );
    assert.equal(await typing.tick({}), false);
    assert.equal(await typing.tick({ chatId: "channel-1" }), true);
    const source = await channel.send({ content: "source" });
    assert.equal(
      await reaction.tick({
        chatId: "channel-1",
        messageId: source.id,
        reactionTick: 0,
      }),
      true,
    );
    assert.equal(
      await reaction.tick({
        chatId: "channel-1",
        messageId: source.id,
        reactionTick: 1,
      }),
      false,
    );
    assert.equal(await reaction.end({ chatId: "channel-1" }), true);
    assert.equal(await reaction.end({}), false);

    owner.discordClients[0].emit("message", {
      id: "incoming-1",
      createdTimestamp: 123,
      channelId: "channel-1",
      guildId: "guild-1",
      channel,
      guild: channel.guild,
      author: { id: "owner", username: "owner", bot: false },
      member: { displayName: "Owner" },
      mentions: { users: { has: () => true } },
      attachments: new Map([
        ["image", { url: "https://owner/image.png", name: "image.png" }],
        [
          "file",
          {
            proxyURL: "https://owner/file.txt",
            name: "file.txt",
            contentType: "text/plain",
          },
        ],
      ]),
      content: "<@discord-bot>, hello",
    });
    await new Promise((resolve) => setImmediate(resolve));
    const inbound = targetApp.records.find(([name]) => name === "message")?.[1];
    assert.equal(inbound.stripped.content, "hello");
    assert.deepEqual(
      inbound.elements.map((node: any) => node.type),
      ["text", "image", "file"],
    );

    for (const interaction of [
      null,
      { isChatInputCommand: () => false },
      {
        isChatInputCommand: () => true,
        user: { id: "discord-bot" },
      },
      { isChatInputCommand: () => true, user: { id: "bot", bot: true } },
    ]) {
      await (adapter as any).handleInteraction(interaction);
    }

    await adapter.stop();
    assert.equal(bot.status, 0);
    owner.discordDestroyError = new Error("destroy owner");
    await adapter.stop();
  });
});

test("discord adapter reports failed catch-up without hiding client cleanup", async () => {
  resetOwner();
  await withTempDir(async (directory) => {
    const targetApp = app();
    const adapter = new adapters.DiscordAdapter(
      targetApp,
      directory,
      { token: "discord-token" },
      logger(),
    );
    (adapter as any).recoverDiscordMessages = async () => {
      throw new Error("owner catch-up failed");
    };
    owner.discordDestroyError = new Error("destroy also failed");
    await assert.rejects(adapter.start(), /owner catch-up failed/);
    assert.deepEqual(adapter.bot.inboundRecovery, {
      status: "degraded",
      failures: ["owner catch-up failed"],
    });
  });
});

test("slack adapter owns socket lifecycle, SDK wrappers, file ingress, and rich delivery", async () => {
  resetOwner();
  await withTempDir(async (directory) => {
    const socket = new EventEmitter() as any;
    socket.start = async () => {
      socket.emit("connected");
    };
    socket.disconnect = async () => socket.emit("disconnected");
    const calls: any[] = [];
    const web = {
      auth: { test: async () => ({ user_id: "B1", user: "rin" }) },
      apiCall: async (...args: any[]) => (calls.push(["api", ...args]), "api"),
      chat: {
        postMessage: async (payload: any) => {
          calls.push(["post", payload]);
          return { ts: `ts-${calls.length}` };
        },
        update: async (payload: any) => (
          calls.push(["update", payload]),
          { ts: payload.ts }
        ),
        delete: async (payload: any) => (calls.push(["delete", payload]), true),
      },
      conversations: {
        info: async (payload: any) => (calls.push(["info", payload]), payload),
        members: async (payload: any) => (
          calls.push(["members", payload]),
          payload
        ),
      },
      reactions: {
        add: async (payload: any) => (
          calls.push(["reaction-add", payload]),
          true
        ),
        remove: async (payload: any) => (
          calls.push(["reaction-remove", payload]),
          true
        ),
      },
      files: {
        uploadV2: async (payload: any) => (
          calls.push(["upload", payload]),
          { files: [{ id: "F1" }] }
        ),
      },
      users: {
        info: async () => ({
          user: {
            real_name: "Owner Real",
            name: "owner",
            profile: { display_name: "Owner Display" },
          },
        }),
      },
    };
    owner.slackWeb = web;
    owner.slackSocket = socket;
    const targetApp = app();
    const log = logger();
    const noBot = new adapters.SlackAdapter(targetApp, directory, {}, log);
    await assert.rejects(noBot.start(), /slack_bot_token_required/);
    const noApp = new adapters.SlackAdapter(
      targetApp,
      directory,
      { botToken: "xoxb" },
      log,
    );
    await assert.rejects(noApp.start(), /slack_app_token_required/);

    const adapter = new adapters.SlackAdapter(
      targetApp,
      directory,
      { token: "xapp", botToken: "xoxb" },
      log,
    );
    await adapter.start();
    const bot = adapter.bot;
    assert.equal(bot.selfId, "B1");
    assert.equal(bot.status, 1);
    assert.equal(
      await bot.internal.apiCall("owner.method", { ok: true }),
      "api",
    );
    await bot.internal.postMessage({ text: "owner" });
    await bot.internal.updateMessage({ ts: "1" });
    await bot.internal.deleteMessage({ ts: "1" });
    await bot.internal.conversationsInfo({ channel: "C1" });
    await bot.internal.conversationsMembers({ channel: "C1" });
    await bot.internal.reactionsAdd({ name: "fire" });
    await bot.internal.reactionsRemove({ name: "fire" });
    await bot.internal.filesUploadV2({ file: Buffer.from("owner") });
    await bot.createReaction("C1", "1", "🔥");
    await bot.deleteReaction("C1", "1", ":custom:");
    await assert.rejects(bot.createReaction("C1", "1", ""), /emoji_required/);

    const originalTransportFetch = (adapter as any).httpTransport.fetch;
    (adapter as any).httpTransport.fetch = async () =>
      new Response(Buffer.from("owner-file"), {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    try {
      await (adapter as any).handleSlackEvent({ type: "ignored" });
      await (adapter as any).handleSlackEvent({
        type: "events_api",
        body: { event: { type: "reaction_added" } },
      });
      await (adapter as any).handleSlackEvent({
        type: "events_api",
        body: {
          team_id: "T1",
          event: {
            type: "message",
            user: "U1",
            channel: "C1",
            ts: "123.5",
            text: "<@B1> hello",
            files: [
              {
                id: "F1",
                name: "owner.txt",
                mimetype: "text/plain",
                url_private_download: "https://owner/file",
              },
              {},
            ],
          },
        },
        ack: async () => calls.push(["ack"]),
      });
    } finally {
      (adapter as any).httpTransport.fetch = originalTransportFetch;
    }
    const inbound = targetApp.records.find(([name]) => name === "message")?.[1];
    assert.equal(inbound.stripped.content, "hello");
    assert.equal(inbound.elements[1].type, "file");
    assert.equal(inbound.guildId, "T1");

    const h = (type: string, attrs: any = {}) => ({
      type,
      attrs,
      children: [],
    });
    const todo = {
      type: "todo",
      attrs: {
        title: "Owner tasks",
        items: [
          { text: "done", done: true },
          { text: "next", done: false },
        ],
      },
      children: [],
    };
    const result = await bot.sendMessage("C1", [
      h("quote", { id: "thread" }),
      h("text", { content: "hello" }),
      todo,
      h("file", { data: Buffer.from("file"), name: "owner.txt" }),
    ]);
    assert.equal(result.length, 3);
    assert.equal(
      calls.some(([name]) => name === "upload"),
      true,
    );

    socket.emit("error", new Error("socket owner"));
    socket.emit("slack_event", { type: "events_api", body: { event: {} } });
    await new Promise((resolve) => setImmediate(resolve));
    await adapter.stop();
    assert.equal(bot.status, 0);
  });
});

test("lark adapter owns SDK startup, event settlement, native APIs, and parsing fallbacks", async () => {
  resetOwner();
  await withTempDir(async (directory) => {
    const calls: any[] = [];
    const client = {
      request: async (payload: any) => (
        calls.push(["request", payload]),
        { code: 0, bot: { open_id: "bot-open-id", app_name: "Rin Bot" } }
      ),
      im: {
        message: {
          create: async (payload: any) => (
            calls.push(["create", payload]),
            { code: 0, data: { message_id: `m${calls.length}` } }
          ),
          reply: async (payload: any) => (
            calls.push(["reply", payload]),
            { code: 0, data: { message_id: `m${calls.length}` } }
          ),
          get: async (payload: any) => (calls.push(["get", payload]), {}),
          list: async () => ({ code: 0, data: { items: [], has_more: false } }),
        },
        chat: {
          get: async (payload: any) => (
            calls.push(["chat", payload]),
            { data: { user_count: "2", bot_count: "1" } }
          ),
        },
        chatMembers: {
          get: async (payload: any) => (calls.push(["members", payload]), {}),
        },
        messageReaction: {
          create: async (payload: any) => (
            calls.push(["reaction-create", payload]),
            {}
          ),
          list: async (payload: any) => (
            calls.push(["reaction-list", payload]),
            {
              data: {
                items: [
                  {
                    reaction_id: "r1",
                    reaction_type: { emoji_type: "Fire" },
                    operator: { operator_type: "app" },
                  },
                ],
              },
            }
          ),
          delete: async (payload: any) => (
            calls.push(["reaction-delete", payload]),
            {}
          ),
        },
        messageResource: {
          get: async (payload: any) => (calls.push(["resource", payload]), {}),
        },
        image: {
          create: async (payload: any) => (
            calls.push(["image", payload]),
            { data: { image_key: "image-key" } }
          ),
        },
      },
      contact: {
        user: {
          get: async (payload: any) => (calls.push(["user", payload]), {}),
        },
      },
    };
    const ws = {
      async start(options: any) {
        calls.push(["ws-start", options]);
      },
      close(options: any) {
        calls.push(["ws-close", options]);
      },
    };
    owner.larkClient = client;
    owner.larkWs = ws;
    const targetApp = app();
    const log = logger();
    await assert.rejects(
      new adapters.LarkAdapter(targetApp, directory, {}, log).start(),
      /lark_app_id_required/,
    );
    await assert.rejects(
      new adapters.LarkAdapter(
        targetApp,
        directory,
        { appId: "app" },
        log,
      ).start(),
      /lark_app_secret_required/,
    );

    const adapter = new adapters.LarkAdapter(
      targetApp,
      directory,
      { appId: "app", appSecret: "secret", platform: "lark" },
      log,
    );
    await adapter.start();
    const bot = adapter.bot;
    assert.equal(bot.status, 1);
    assert.equal(bot.selfId, "app");
    assert.equal(bot.user.name, "Rin Bot");
    assert.equal(owner.larkDispatcher.handles.size, 1);
    await owner.larkDispatcher.handles.get("im.message.receive_v1")({
      sender: {
        sender_type: "user",
        sender_id: { open_id: "owner" },
      },
      message: {
        message_id: "incoming",
        message_type: "text",
        chat_id: "chat",
        chat_type: "p2p",
        create_time: "123",
        content: JSON.stringify({ text: "hello" }),
      },
    });
    assert.equal(
      targetApp.records.find(([name]) => name === "message")?.[1].content,
      "hello",
    );

    await bot.internal.createMessage({ data: {} });
    await bot.internal.getMessage({ path: {} });
    await bot.internal.getChat({ path: {} });
    await bot.internal.createReaction({ data: {} });
    await bot.internal.deleteReaction({ path: {} });
    await bot.internal.listReactions({ path: {} });
    await bot.internal.listChatMembers({ path: {} });
    await bot.internal.getMessageResource({ path: {} });
    await bot.internal.getUser({ path: {} });
    await bot.createReaction("chat", "m1", "🔥");
    assert.equal(await bot.deleteReaction("chat", "m1", "🔥"), true);
    client.im.messageReaction.list = async () => ({ data: { items: [] } });
    assert.equal(await bot.deleteReaction("chat", "m1", "custom"), false);
    await assert.rejects(
      bot.createReaction("chat", "m1", ""),
      /emoji_required/,
    );

    assert.deepEqual((adapter as any).parseMessageContent(""), {
      text: "",
      mentions: [],
    });
    assert.deepEqual((adapter as any).parseMessageContent('"owner"'), {
      text: "owner",
      mentions: [],
    });
    assert.equal(
      (adapter as any).parseMessageContent("not-json").text,
      "not-json",
    );
    for (const [type, raw] of [
      [
        "post",
        JSON.stringify({
          zh_cn: { content: [[{ tag: "text", text: "post" }]] },
        }),
      ],
      ["image", JSON.stringify({ image_key: "image" })],
      ["file", JSON.stringify({ file_key: "file", file_name: "owner" })],
      ["text", JSON.stringify({ text: "hello @_owner" })],
    ] as const) {
      assert.equal(
        (adapter as any).parseLarkMessageContentNodes(type, raw, [
          { key: "@_owner", id: "owner", name: "Owner" },
        ]).length > 0,
        true,
      );
    }

    const delivered = await bot.sendMessage("chat", [
      { type: "quote", attrs: { id: "parent" }, children: [] },
      { type: "markdown", attrs: { content: "**owner**" }, children: [] },
      {
        type: "image",
        attrs: { data: Buffer.from("image"), name: "owner.png" },
        children: [],
      },
    ]);
    assert.equal(delivered.length, 2);
    assert.equal(
      calls.some(([name]) => name === "image"),
      true,
    );
    await assert.rejects(
      bot.sendMessage("chat", []),
      /lark_send_message_empty/,
    );

    await adapter.stop();
    assert.equal(bot.status, 0);
  });
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

test("lark adapter preserves recovery, forward, resource, and image failure branches", async () => {
  resetOwner();
  await withTempDir(async (directory) => {
    const calls: any[] = [];
    const pages = [
      {
        code: 0,
        data: {
          items: [
            {
              message_id: "cursor",
              msg_type: "text",
              content: '{"text":"cursor"}',
              sender: { id: "u0", id_type: "open_id" },
            },
            {
              message_id: "next",
              msg_type: "text",
              body: { content: '{"text":"next"}' },
              sender: { id: "u1", id_type: "user_id" },
            },
          ],
          has_more: true,
          page_token: "page-2",
        },
      },
      {
        code: 0,
        items: [
          {
            message_id: "last",
            message_type: "text",
            content: '{"content":"last"}',
            sender: { id: "u2", id_type: "union_id" },
          },
        ],
        has_more: true,
        page_token: "page-2",
      },
    ];
    const client: any = {
      im: {
        message: {
          list: async (payload: any) => (
            calls.push(["list", payload]),
            pages.shift()
          ),
          get: async () => ({
            items: [
              { message_id: "forward" },
              {
                message_id: "a",
                msg_type: "text",
                content: '{"text":"hello"}',
                sender: { id: "sender" },
              },
              {
                message_id: "b",
                msg_type: "text",
                content: "",
                sender: { sender_id: { open_id: "open" } },
              },
              {
                message_id: "c",
                msg_type: "text",
                content: "",
                sender: { sender_id: { user_id: "user" } },
              },
              { message_id: "d", msg_type: "text", content: "" },
              { msg_type: "text", content: "" },
            ],
          }),
          create: async (payload: any) => ({
            code: 0,
            message_id: payload.data.receive_id ? "created" : "",
          }),
          reply: async () => ({ code: 0, data: { message_id: "reply" } }),
        },
        messageResource: {
          get: async ({ path: resourcePath }: any) => {
            if (resourcePath.file_key === "missing") return {};
            if (resourcePath.file_key === "boom")
              throw new Error("resource failed");
            return {
              headers: { "Content-Type": "image/png; charset=binary" },
              async writeFile(filePath: string) {
                calls.push(["write", filePath]);
                await fs.writeFile(filePath, "resource");
              },
            };
          },
        },
        chat: { get: async () => ({ userCount: 2, botCount: "bad" }) },
        messageReaction: {
          create: async () => true,
          list: async () => ({
            data: { items: [{ reaction_id: "fallback" }] },
          }),
          delete: async () => true,
        },
        image: { create: async () => ({}) },
      },
    };
    const log = logger();
    const targetApp = app(directory);
    const lark = new adapters.LarkAdapter(
      targetApp,
      directory,
      { appId: "app", appSecret: "secret" },
      log,
    ) as any;
    lark.client = client;
    lark.bot.selfId = "app";

    const recovered = await lark.fetchLarkMessagesAfter({
      chatKey: "lark/app:chat",
      chatId: "chat",
      messageId: "cursor",
      platformTimestamp: 500,
    });
    assert.deepEqual(
      recovered.map((entry: any) => entry.message.message_id),
      ["next", "last"],
    );
    assert.equal(recovered[0].sender.sender_id.user_id, "u1");
    assert.equal(recovered[1].sender.sender_id.union_id, "u2");
    client.im.message.list = async () => ({ code: 0, data: { items: [] } });
    await assert.rejects(
      lark.fetchLarkMessagesAfter({
        chatKey: "k",
        chatId: "c",
        messageId: "absent",
        platformTimestamp: 0,
      }),
      /did not return recovery cursor/,
    );
    client.im.message.list = async () => ({ code: 7, msg: "denied" });
    await assert.rejects(
      lark.fetchLarkMessagesAfter({
        chatKey: "k",
        chatId: "c",
        messageId: "absent",
        platformTimestamp: 0,
      }),
      /lark_api_error:7:denied/,
    );

    assert.equal(await lark.recoverLarkMessages(), undefined);
    const merged = lark.mergeLarkRecoveryMessages(
      [
        { message: { message_id: "same", create_time: 2 } },
        { message: { message_id: "older", create_time: 1 } },
        { message: {} },
      ],
      [
        {
          data: { message: { message_id: "same", create_time: 3 } },
          resolve() {},
          reject() {},
        },
        { data: { message: { create_time: 3 } }, resolve() {}, reject() {} },
      ],
    );
    assert.deepEqual(
      merged.map((entry: any) => entry.data.message.message_id || "buffered"),
      ["older", "same", "buffered"],
    );

    const forward = await lark.buildLarkForwardNode({ message_id: "forward" });
    assert.equal(forward.children.length, 5);
    assert.match(forward.children[0].attrs.content, /sender: hello/);
    assert.match(
      forward.children.at(-1).attrs.content,
      /unknown: \[unsupported message\]/,
    );
    client.im.message.get = async () => {
      throw new Error("forward failed");
    };
    assert.equal(
      (await lark.buildLarkForwardNode({ message_id: "failed" })).children
        .length,
      0,
    );
    assert.equal((await lark.buildLarkForwardNode({})).children.length, 0);

    assert.deepEqual(lark.pickLarkMessageItems({ data: { items: [1] } }), [1]);
    assert.deepEqual(lark.pickLarkMessageItems({}), []);
    assert.equal(await lark.cacheLarkMessageResource("", "key", "image"), null);
    assert.equal(
      await lark.cacheLarkMessageResource("m", "missing", "image"),
      null,
    );
    const cached = await lark.cacheLarkMessageResource("m", "key", "image");
    assert.equal(cached.name.endsWith(".png"), true);
    assert.equal(await fs.readFile(cached.path, "utf8"), "resource");

    const resolved = await lark.resolveLarkMessageResources("m", [
      { type: "text", attrs: { content: "plain" } },
      { type: "image", attrs: { src: "https://owner/image" } },
      { type: "image", attrs: { src: "key", name: "owner" } },
      { type: "file", attrs: { src: "missing" } },
      { type: "file", attrs: { src: "boom" } },
      { type: "file", attrs: {} },
    ]);
    assert.equal(resolved[2].attrs.src.startsWith("file:"), true);
    assert.equal(resolved[3].attrs.src, undefined);
    assert.equal(resolved[4].attrs.src, undefined);
    assert.equal(await lark.bot.deleteReaction("chat", "m", "custom"), true);
    await assert.rejects(
      lark.bot.deleteReaction("chat", "m", ""),
      /emoji_required/,
    );

    assert.deepEqual(
      lark
        .parsePostContentNodes({
          en_us: {
            content: [
              [
                { tag: "at", id: "owner", name: "Owner" },
                { tag: "img", src: "image", alt: "alt" },
                { tag: "md", text: "**bold**" },
                { tag: "a", href: "https://owner" },
              ],
              "invalid",
            ],
          },
        })
        .map((node: any) => node.type),
      ["at", "image", "markdown", "text"],
    );
    assert.deepEqual(
      lark.parseLarkMessageContentNodes("text", "@_missing tail", []),
      [
        { type: "text", attrs: { content: "@_missing" }, children: [] },
        { type: "text", attrs: { content: " tail" }, children: [] },
      ],
    );
    assert.deepEqual(lark.parseLarkMessageContentNodes("text", "", []), []);

    const postData = lark.buildPostData(
      '# Heading\n\n**bold** *italic* ~~strike~~ [link](https://owner)  \nnext\n\n```ts\nconst x = 1;\n```\n\n---\n\n<at user_id="u&amp;&quot;">Owner</at>\n\n- one\ncontinuation',
    );
    assert.equal(postData.msg_type, "post");
    assert.equal(JSON.parse(postData.content).zh_cn.content.length > 5, true);
    assert.deepEqual(
      await lark.sendData("chat", { msg_type: "text" }, "parent"),
      ["reply"],
    );
    client.im.message.create = async () => ({
      code: 9,
      message: "create failed",
    });
    await assert.rejects(
      lark.sendData("chat", { msg_type: "text" }),
      /lark_api_error:9:create failed/,
    );
    await assert.rejects(lark.sendPostText("chat", ""), /send_message_empty/);

    assert.throws(
      () => lark.assertLarkImageSize(Buffer.alloc(0)),
      /content is empty/,
    );
    assert.throws(
      () => lark.assertLarkImageSize(Buffer.alloc(10 * 1024 * 1024 + 1)),
      /10 MB/,
    );
    const originalTransportFetch = lark.httpTransport.fetch;
    try {
      lark.httpTransport.fetch = async () =>
        new Response("no", { status: 404 });
      await assert.rejects(
        lark.downloadLarkImage("https://owner/404"),
        /HTTP 404/,
      );
      lark.httpTransport.fetch = async () =>
        new Response("x", {
          headers: { "content-length": String(11 * 1024 * 1024) },
        });
      await assert.rejects(
        lark.downloadLarkImage("https://owner/large"),
        /10 MB/,
      );
      lark.httpTransport.fetch = async () => {
        throw new Error("network down");
      };
      await assert.rejects(
        lark.downloadLarkImage("https://owner/down"),
        /network down/,
      );
      lark.httpTransport.fetch = async () => new Response(Buffer.from("image"));
      client.im.message.create = async () => ({
        code: 0,
        data: { message_id: "image-message" },
      });
      await assert.rejects(
        lark.sendImage("chat", {
          type: "image",
          attrs: { src: "https://owner/image" },
        }),
        /no image key/,
      );
    } finally {
      lark.httpTransport.fetch = originalTransportFetch;
    }

    const local = path.join(directory, "local.png");
    await fs.writeFile(local, "image");
    await lark.assertLarkLocalImageSourceSize({ attrs: { src: local } });
    await lark.assertLarkLocalImageSourceSize({
      attrs: { src: path.join(directory, "missing.png") },
    });
    assert.equal(
      log.records.some((entry: any[]) =>
        /forward failed/.test(entry.join(" ")),
      ),
      true,
    );
    assert.equal(
      log.records.some((entry: any[]) =>
        /resource failed/.test(entry.join(" ")),
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
