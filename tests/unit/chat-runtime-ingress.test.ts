import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const runtime = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js"))
    .href
);
const inbox = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "inbox.js")).href
);
const nodeRequire = createRequire(import.meta.url);

test("chat runtime persists inbound sessions before emitting message events", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-runtime-"),
  );
  const app = runtime.createChatRuntimeApp(agentDir);
  const seen = [];
  app.on("message", (session) => {
    seen.push(session.messageId);
  });

  const session = {
    platform: "telegram",
    selfId: "1",
    channelId: "2",
    messageId: "m1",
    userId: "u1",
    content: "hello",
    stripped: { content: "hello" },
    elements: [{ type: "text", attrs: { content: "hello" } }],
  };

  const delivered = app.emit("message", session);
  const files = inbox.listPendingChatInboxFiles(agentDir);
  const stored = inbox.readChatInboxItem(files[0]);

  assert.equal(delivered, true);
  assert.deepEqual(seen, ["m1"]);
  assert.equal(files.length, 1);
  assert.equal(stored.chatKey, "telegram/1:2");
  assert.equal(stored.messageId, "m1");
  assert.equal(stored.routing?.text, "hello");
  assert.equal(stored.routing?.isDirect, true);
});

test("chat runtime qualifies second bot keys for the same platform", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-runtime-"),
  );
  const app = runtime.createChatRuntimeApp(agentDir);
  app.bots.push({ platform: "discord", selfId: "bot-1" });
  app.bots.push({ platform: "discord", selfId: "bot-2" });

  app.emit("message", {
    platform: "discord",
    selfId: "bot-2",
    channelId: "channel-1",
    messageId: "m-discord-2",
    userId: "u1",
    content: "hello",
    stripped: { content: "hello" },
    elements: [{ type: "text", attrs: { content: "hello" } }],
  });

  const files = inbox.listPendingChatInboxFiles(agentDir);
  const stored = inbox.readChatInboxItem(files[0]);

  assert.equal(files.length, 1);
  assert.equal(stored.chatKey, "discord/bot-2:channel-1");
  assert.equal(stored.messageId, "m-discord-2");
});

test("discord runtime persists guild channel paths as chat names", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-runtime-"),
  );
  try {
    const app = runtime.createChatRuntimeApp(agentDir);
    runtime.instantiateBuiltInChatRuntimeAdapters(app, {
      dataDir: path.join(agentDir, "data"),
      settings: {},
      adapterEntries: [
        {
          key: "discord",
          name: "Discord",
          config: { token: "abc" },
        },
      ],
    });
    const adapter = [...app.adapters][0];
    (adapter as any).bot.selfId = "bot-discord";

    const guild: any = {
      id: "guild-1",
      name: "Rin Dev",
      channels: { cache: new Map<string, any>() },
    };
    const category = { id: "category-1", name: "Projects", guild };
    const parentChannel = {
      id: "parent-1",
      name: "features",
      guild,
      parent: category,
    };
    const threadChannel = {
      id: "thread-1",
      name: "metadata-paths",
      guild,
      parent: parentChannel,
    };
    guild.channels.cache.set(category.id, category);
    guild.channels.cache.set(parentChannel.id, parentChannel);
    guild.channels.cache.set(threadChannel.id, threadChannel);

    await (adapter as any).handleMessage({
      id: "message-1",
      createdTimestamp: 1710000000000,
      guildId: "guild-1",
      guild,
      channelId: "thread-1",
      channel: threadChannel,
      author: {
        id: "owner-discord",
        bot: false,
        globalName: "Owner",
        username: "owner",
      },
      member: { displayName: "Owner Nick" },
      mentions: { users: { has: () => false } },
      attachments: new Map(),
      content: "hello",
    });

    const files = inbox.listPendingChatInboxFiles(agentDir);
    const stored = inbox.readChatInboxItem(files[0]);

    assert.equal(files.length, 1);
    assert.equal(stored?.chatKey, "discord/bot-discord:thread-1");
    assert.equal(
      stored?.routing?.chatName,
      "Rin Dev / Projects / features / metadata-paths",
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("discord slash interactions emit after acknowledgement", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-runtime-"),
  );
  const app = runtime.createChatRuntimeApp(agentDir);
  runtime.instantiateBuiltInChatRuntimeAdapters(app, {
    dataDir: path.join(agentDir, "data"),
    settings: {},
    adapterEntries: [
      {
        key: "discord",
        name: "Discord",
        config: { token: "abc" },
      },
    ],
  });
  const adapter = [...app.adapters][0];
  const seen = [];
  app.on("message", (session) => seen.push(session));

  let replyStarted = false;
  let resolveReply: () => void = () => {};
  const replyGate = new Promise<void>((resolve) => {
    resolveReply = resolve;
  });

  const handled = (adapter as any).handleInteraction({
    id: "interaction-1",
    commandName: "new",
    createdTimestamp: 123,
    channelId: "channel-1",
    guildId: "guild-1",
    user: { id: "owner-1", username: "owner" },
    member: { displayName: "Owner" },
    isChatInputCommand: () => true,
    options: { getString: () => "" },
    reply: async () => {
      replyStarted = true;
      await replyGate;
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replyStarted, true);
  assert.equal(seen.length, 0);

  resolveReply();
  await handled;
  assert.equal(seen.length, 1);
  assert.equal(seen[0].messageId, "interaction-1");
  assert.equal(seen[0].content, "/new");
});

test("chat runtime derives the durable chat key from normalized chat identity", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-runtime-"),
  );
  const app = runtime.createChatRuntimeApp(agentDir);

  const session = {
    platform: "onebot",
    selfId: "1",
    userId: "42",
    messageId: "m2",
    isDirect: true,
    content: "hello",
    stripped: { content: "hello" },
    elements: [{ type: "text", attrs: { content: "hello" } }],
  };

  app.emit("message", session);
  const files = inbox.listPendingChatInboxFiles(agentDir);
  const stored = inbox.readChatInboxItem(files[0]);

  assert.equal(files.length, 1);
  assert.equal(stored.chatKey, "onebot/1:private:42");
  assert.equal(stored.messageId, "m2");
  assert.equal(stored.routing?.chatType, "private");
  assert.equal(stored.routing?.userId, "42");
});

test("onebot group sessions preserve both group card and account nickname", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-runtime-"),
  );
  const app = runtime.createChatRuntimeApp(agentDir);
  runtime.instantiateBuiltInChatRuntimeAdapters(app, {
    dataDir: path.join(agentDir, "data"),
    settings: {},
    adapterEntries: [
      {
        key: "onebot",
        name: "OneBot",
        config: { endpoint: "ws://127.0.0.1:1", selfId: "1" },
      },
    ],
  });
  const adapter = [...app.adapters][0];
  const seen = [];
  app.on("message", (session) => seen.push(session));

  await adapter.handleSocketMessage(
    JSON.stringify({
      post_type: "message",
      message_type: "group",
      self_id: 1,
      user_id: 42,
      group_id: 100,
      message_id: 200,
      raw_message: "hello",
      sender: { card: "GroupCard", nickname: "AccountNick" },
    }),
  );

  assert.equal(seen.length, 1);
  assert.equal(seen[0].author.name, "GroupCard");
  assert.equal(seen[0].author.nickname, "AccountNick");
  assert.equal(seen[0].author.groupNickname, "GroupCard");
  assert.equal(seen[0].author.accountNickname, undefined);
  const files = inbox.listPendingChatInboxFiles(agentDir);
  const stored = inbox.readChatInboxItem(files[0]);
  assert.equal(stored.routing?.nickname, "AccountNick");
  assert.equal(stored.session?.author?.nickname, "AccountNick");
  assert.equal(stored.session?.author?.groupNickname, "GroupCard");
  assert.equal(stored.session?.author?.accountNickname, undefined);
});

test("qq group sessions preserve both group nickname and account nickname", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-runtime-"),
  );
  const app = runtime.createChatRuntimeApp(agentDir);
  runtime.instantiateBuiltInChatRuntimeAdapters(app, {
    dataDir: path.join(agentDir, "data"),
    settings: {},
    adapterEntries: [
      {
        key: "qq",
        name: "QQ",
        config: {},
      },
    ],
  });
  const adapter = [...app.adapters][0];
  adapter.bot.selfId = "bot-1";
  const seen = [];
  app.on("message", (session) => seen.push(session));

  await adapter.handleIncomingEvent({
    eventType: "GROUP_AT_MESSAGE_CREATE",
    msg: {
      id: "qq-msg-1",
      group_openid: "group-1",
      group_name: "Demo QQ Group",
      content: "<@!bot-1> hello",
      author: { member_openid: "user-1", username: "AccountNick" },
      member: { nick: "GroupNick" },
    },
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].author.name, "GroupNick");
  assert.equal(seen[0].author.nickname, "AccountNick");
  assert.equal(seen[0].author.groupNickname, "GroupNick");
  assert.equal(seen[0].author.accountNickname, undefined);
  const files = inbox.listPendingChatInboxFiles(agentDir);
  const stored = inbox.readChatInboxItem(files[0]);
  assert.equal(stored.routing?.nickname, "AccountNick");
  assert.equal(stored.session?.author?.nickname, "AccountNick");
  assert.equal(stored.session?.author?.groupNickname, "GroupNick");
  assert.equal(stored.session?.author?.accountNickname, undefined);
});

test("telegram runtime advances the poll cursor only after the update is handled", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-runtime-"),
  );
  const app = runtime.createChatRuntimeApp(agentDir);
  runtime.instantiateBuiltInChatRuntimeAdapters(app, {
    dataDir: path.join(agentDir, "data"),
    settings: {},
    adapterEntries: [
      { key: "telegram", name: "Telegram", config: { token: "123:abc" } },
    ],
  });
  const adapter = [...app.adapters][0];
  const calls = [];
  let saveCalls = 0;
  adapter.running = true;
  adapter.nextOffset = 100;
  adapter.callApi = async () => [{ update_id: 101 }];
  adapter.handleUpdate = async (update) => {
    calls.push(`handle:${update.update_id}`);
    adapter.running = false;
  };
  adapter.saveCursor = () => {
    saveCalls += 1;
    calls.push(`save:${adapter.nextOffset}`);
  };

  await adapter.pollLoop();

  assert.deepEqual(calls, ["handle:101", "save:102"]);
  assert.equal(adapter.nextOffset, 102);
  assert.equal(saveCalls, 1);
});

test("telegram runtime does not advance the poll cursor when update handling fails", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-runtime-"),
  );
  const app = runtime.createChatRuntimeApp(agentDir);
  runtime.instantiateBuiltInChatRuntimeAdapters(app, {
    dataDir: path.join(agentDir, "data"),
    settings: {},
    adapterEntries: [
      { key: "telegram", name: "Telegram", config: { token: "123:abc" } },
    ],
  });
  const adapter = [...app.adapters][0];
  let saveCalls = 0;
  adapter.running = true;
  adapter.nextOffset = 200;
  adapter.callApi = async () => [{ update_id: 201 }];
  adapter.handleUpdate = async () => {
    adapter.running = false;
    throw new Error("boom");
  };
  adapter.saveCursor = () => {
    saveCalls += 1;
  };

  await adapter.pollLoop();

  assert.equal(adapter.nextOffset, 200);
  assert.equal(saveCalls, 0);
});

test("slack runtime acks only after the inbound event is emitted", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-runtime-"),
  );
  const app = runtime.createChatRuntimeApp(agentDir);
  runtime.instantiateBuiltInChatRuntimeAdapters(app, {
    dataDir: path.join(agentDir, "data"),
    settings: {},
    adapterEntries: [
      {
        key: "slack",
        name: "Slack",
        config: { token: "xapp-test", botToken: "xoxb-test" },
      },
    ],
  });
  const adapter = [...app.adapters][0];
  adapter.bot.selfId = "B1";
  adapter.web = {
    users: {
      info: async () => ({ user: { name: "tester" } }),
    },
  };
  const order = [];
  app.on("message", () => {
    order.push("emit");
  });
  const envelope = {
    type: "events_api",
    ack: async () => {
      order.push(`ack:${inbox.listPendingChatInboxFiles(agentDir).length}`);
    },
    body: {
      event: {
        type: "message",
        user: "U1",
        channel: "D1",
        text: "hello",
        ts: "123.456",
      },
    },
  };

  await adapter.handleSlackEvent(envelope);

  assert.deepEqual(order, ["emit", "ack:1"]);
});

test("lark websocket events return before slow message handling settles", async () => {
  const Lark = nodeRequire("@larksuiteoapi/node-sdk");
  const originalClient = Lark.Client;
  const originalWSClient = Lark.WSClient;
  let capturedDispatcher: any;

  class FakeWSClient {
    start(params: any) {
      capturedDispatcher = params.eventDispatcher;
    }

    close() {}
  }

  Lark.Client = class FakeClient {};
  Lark.WSClient = FakeWSClient;

  try {
    const agentDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "rin-chat-runtime-"),
    );
    const app = runtime.createChatRuntimeApp(agentDir);
    runtime.instantiateBuiltInChatRuntimeAdapters(app, {
      dataDir: path.join(agentDir, "data"),
      settings: {},
      adapterEntries: [
        {
          key: "lark",
          name: "Lark",
          config: { appId: "cli_1234567890abcdef", appSecret: "secret" },
        },
      ],
    });
    const adapter = [...app.adapters][0];
    let resolveHandling: () => void = () => {};
    let handlingStarted = false;
    const handlingGate = new Promise<void>((resolve) => {
      resolveHandling = resolve;
    });
    (adapter as any).handleMessage = async () => {
      handlingStarted = true;
      await handlingGate;
    };

    await adapter.start();
    const handler = capturedDispatcher?.handles?.get("im.message.receive_v1");
    assert.equal(typeof handler, "function");

    const handled = Promise.resolve(
      handler({ message: { message_id: "om_1" } }),
    );
    const firstTick = new Promise((resolve) => setImmediate(resolve));
    const state = await Promise.race([
      handled.then(() => "settled"),
      firstTick.then(() => "pending"),
    ]);

    let assertionError: unknown;
    try {
      assert.equal(handlingStarted, true);
      assert.equal(state, "settled");
    } catch (error) {
      assertionError = error;
    }

    resolveHandling();
    await handled;
    if (assertionError) throw assertionError;
  } finally {
    Lark.Client = originalClient;
    Lark.WSClient = originalWSClient;
  }
});

test("lark runtime reads merged forward messages into inbound text", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-runtime-"),
  );
  const app = runtime.createChatRuntimeApp(agentDir);
  runtime.instantiateBuiltInChatRuntimeAdapters(app, {
    dataDir: path.join(agentDir, "data"),
    settings: {},
    adapterEntries: [
      {
        key: "lark",
        name: "Lark",
        config: { appId: "cli-test", appSecret: "secret" },
      },
    ],
  });
  const adapter = [...app.adapters][0];
  adapter.bot.selfId = "cli-test";
  const calls = [];
  adapter.client = {
    im: {
      message: {
        get: async (options) => {
          calls.push(options);
          return {
            data: {
              items: [
                {
                  message_id: "om-forward",
                  msg_type: "merge_forward",
                  body: { content: "Merged and Forwarded Message" },
                },
                {
                  message_id: "om-child-1",
                  msg_type: "text",
                  sender: { id: "Alice" },
                  body: { content: JSON.stringify({ text: "hello" }) },
                },
                {
                  message_id: "om-child-2",
                  msg_type: "image",
                  sender: { id: "Bob" },
                  body: { content: JSON.stringify({ image_key: "img-key" }) },
                },
              ],
            },
          };
        },
      },
    },
  };
  const seen = [];
  app.on("message", (session) => seen.push(session));

  await adapter.handleMessage({
    sender: { sender_type: "user", sender_id: { open_id: "ou_sender" } },
    message: {
      message_id: "om-forward",
      message_type: "merge_forward",
      chat_id: "oc_chat",
      chat_type: "group",
      create_time: "1713436800000",
      content: "Merged and Forwarded Message",
    },
  });

  assert.deepEqual(calls, [
    { path: { message_id: "om-forward" }, params: { user_id_type: "open_id" } },
  ]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].elements[0].type, "forward");
  assert.match(seen[0].content, /\[forward: merged forward: om-forward\]/);
  assert.match(seen[0].content, /Alice: hello/);
  assert.match(seen[0].content, /Bob: image: img-key/);
  assert.doesNotMatch(seen[0].content, /Merged and Forwarded Message/);

  const files = inbox.listPendingChatInboxFiles(agentDir);
  const stored = inbox.readChatInboxItem(files[0]);
  assert.match(stored.routing?.text, /Alice: hello/);
  assert.doesNotMatch(stored.routing?.text, /Merged and Forwarded Message/);
});

test("lark runtime maps reply parent ids to canonical quote metadata", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-runtime-"),
  );
  const app = runtime.createChatRuntimeApp(agentDir);
  runtime.instantiateBuiltInChatRuntimeAdapters(app, {
    dataDir: path.join(agentDir, "data"),
    settings: {},
    adapterEntries: [
      {
        key: "lark",
        name: "Feishu",
        config: { appId: "cli-test", appSecret: "secret" },
      },
    ],
  });
  const adapter = [...app.adapters][0];
  adapter.bot.selfId = "cli-test";
  const seen = [];
  app.on("message", (session) => seen.push(session));

  await adapter.handleMessage({
    sender: { sender_type: "user", sender_id: { open_id: "ou_sender" } },
    message: {
      message_id: "om-followup",
      parent_id: "om-parent",
      root_id: "om-parent",
      message_type: "text",
      chat_id: "oc_chat",
      chat_type: "group",
      create_time: "1713436800000",
      content: JSON.stringify({ text: "continue" }),
    },
  });

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].quote, { messageId: "om-parent" });
  const files = inbox.listPendingChatInboxFiles(agentDir);
  const stored = inbox.readChatInboxItem(files[0]);
  assert.equal(stored.routing?.replyToMessageId, "om-parent");
});

test("lark adapter reports Feishu group member count including the bot", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-runtime-"),
  );
  const app = runtime.createChatRuntimeApp(agentDir);
  runtime.instantiateBuiltInChatRuntimeAdapters(app, {
    dataDir: path.join(agentDir, "data"),
    settings: {},
    adapterEntries: [
      {
        key: "lark",
        name: "Feishu",
        config: { appId: "cli-test", appSecret: "secret" },
      },
    ],
  });
  const adapter = [...app.adapters][0];
  const calls = [];
  adapter.client = {
    im: {
      chat: {
        get: async (options) => {
          calls.push(options);
          return { data: { user_count: "1", bot_count: "1" } };
        },
      },
    },
  };

  const count = await adapter.bot.getGuildMemberCount("oc_owner_only");

  assert.deepEqual(calls, [
    {
      path: { chat_id: "oc_owner_only" },
      params: { user_id_type: "open_id" },
    },
  ]);
  assert.equal(count, 2);
});

test("lark runtime downloads image message resources before inbox persistence", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-runtime-"),
  );
  const dataDir = path.join(agentDir, "data");
  const app = runtime.createChatRuntimeApp(agentDir);
  runtime.instantiateBuiltInChatRuntimeAdapters(app, {
    dataDir,
    settings: {},
    adapterEntries: [
      {
        key: "lark",
        name: "Feishu",
        config: { appId: "cli-test", appSecret: "secret" },
      },
    ],
  });
  const adapter = [...app.adapters][0];
  adapter.bot.selfId = "cli-test";
  const calls = [];
  adapter.client = {
    im: {
      messageResource: {
        get: async (options) => {
          calls.push(options);
          return {
            headers: { "content-type": "image/png" },
            writeFile: async (filePath) => {
              await fs.writeFile(filePath, Buffer.from("demo-image"));
              return filePath;
            },
          };
        },
      },
    },
  };
  const seen = [];
  app.on("message", (session) => seen.push(session));

  await adapter.handleMessage({
    sender: { sender_type: "user", sender_id: { open_id: "ou_sender" } },
    message: {
      message_id: "om-image",
      message_type: "image",
      chat_id: "oc_chat",
      chat_type: "group",
      create_time: "1713436800000",
      content: JSON.stringify({ image_key: "img_v2_demo" }),
    },
  });

  assert.deepEqual(calls, [
    {
      path: { message_id: "om-image", file_key: "img_v2_demo" },
      params: { type: "image" },
    },
  ]);
  assert.equal(seen.length, 1);
  assert.match(seen[0].elements[0].attrs.src, /^file:\/\//);
  assert.equal(seen[0].elements[0].attrs.mimeType, "image/png");

  const files = inbox.listPendingChatInboxFiles(agentDir);
  const stored = inbox.readChatInboxItem(files[0]);
  assert.match(stored.elements[0].attrs.src, /^file:\/\//);
  assert.equal(stored.elements[0].attrs.mimeType, "image/png");
});

test("onebot runtime reads merged forward messages into inbound text", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-runtime-"),
  );
  const app = runtime.createChatRuntimeApp(agentDir);
  runtime.instantiateBuiltInChatRuntimeAdapters(app, {
    dataDir: path.join(agentDir, "data"),
    settings: {},
    adapterEntries: [
      {
        key: "onebot",
        name: "OneBot",
        config: { endpoint: "ws://127.0.0.1:1", selfId: "1" },
      },
    ],
  });
  const adapter = [...app.adapters][0];
  const calls = [];
  adapter.callAction = async (action, params) => {
    calls.push({ action, params });
    assert.equal(action, "get_forward_msg");
    assert.deepEqual(params, { id: "forward-1" });
    return {
      messages: [
        {
          sender: { nickname: "Alice" },
          content: [{ type: "text", data: { text: "hello" } }],
        },
        {
          sender: { nickname: "Bob" },
          content: [
            { type: "text", data: { text: "look" } },
            {
              type: "image",
              data: { url: "https://example.test/a.png", file: "a.png" },
            },
          ],
        },
      ],
    };
  };
  const seen = [];
  app.on("message", (session) => seen.push(session));

  await adapter.handleSocketMessage(
    JSON.stringify({
      post_type: "message",
      message_type: "group",
      self_id: 1,
      user_id: 42,
      group_id: 100,
      message_id: 201,
      message: [{ type: "forward", data: { id: "forward-1" } }],
      raw_message: "[CQ:forward,id=forward-1]",
      sender: { nickname: "Tester" },
    }),
  );

  assert.equal(calls.length, 1);
  assert.equal(seen.length, 1);
  assert.match(seen[0].content, /\[forward: forward-1\]/);
  assert.match(seen[0].content, /Alice: hello/);
  assert.match(seen[0].content, /Bob: look/);
  assert.match(seen[0].content, /image: a\.png/);
  assert.doesNotMatch(seen[0].content, /\[CQ:forward/);
  assert.equal(seen[0].elements[0].type, "forward");

  const files = inbox.listPendingChatInboxFiles(agentDir);
  const stored = inbox.readChatInboxItem(files[0]);
  assert.match(stored.routing?.text, /Alice: hello/);
  assert.doesNotMatch(stored.routing?.text, /\[CQ:forward/);
});

test("onebot runtime maps the working thinking reaction to a QQ desktop-visible face", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-runtime-"),
  );
  const app = runtime.createChatRuntimeApp(agentDir);
  runtime.instantiateBuiltInChatRuntimeAdapters(app, {
    dataDir: path.join(agentDir, "data"),
    settings: {},
    adapterEntries: [
      {
        key: "onebot",
        name: "OneBot",
        config: { endpoint: "ws://127.0.0.1:1" },
      },
    ],
  });
  const adapter = [...app.adapters][0];
  const calls = [];
  adapter.callAction = async (action, params) => {
    calls.push({ action, params });
    return {};
  };

  await adapter.createReaction("1067390680", "52", "🤔");
  await adapter.deleteReaction("1067390680", "52", "🤔");

  assert.deepEqual(calls, [
    {
      action: "set_msg_emoji_like",
      params: { message_id: 52, emoji_id: "212", set: true },
    },
    {
      action: "set_msg_emoji_like",
      params: { message_id: 52, emoji_id: "212", set: false },
    },
  ]);
});
