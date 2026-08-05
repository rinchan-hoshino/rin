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
const adapters = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat-runtime", "adapters.js"),
  ).href
);
const inbox = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "inbox.js")).href
);
const messageStore = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js"))
    .href
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
  const files = inbox.listPendingChatInboxItems(agentDir);
  const stored = files[0];

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

  const files = inbox.listPendingChatInboxItems(agentDir);
  const stored = files[0];

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
      reference: { messageId: "discord-parent" },
      content: "hello",
    });

    const files = inbox.listPendingChatInboxItems(agentDir);
    const stored = files[0];

    assert.equal(files.length, 1);
    assert.equal(stored?.chatKey, "discord/bot-discord:thread-1");
    assert.equal(
      stored?.routing?.chatName,
      "Rin Dev / Projects / features / metadata-paths",
    );
    assert.equal(stored?.routing?.replyToMessageId, "discord-parent");
    assert.equal(stored?.elements?.[0]?.type, "quote");
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
  const files = inbox.listPendingChatInboxItems(agentDir);
  const stored = files[0];

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
  const files = inbox.listPendingChatInboxItems(agentDir);
  const stored = files[0];
  assert.equal(stored.routing?.nickname, "AccountNick");
  assert.equal(stored.session?.author?.nickname, "AccountNick");
  assert.equal(stored.session?.author?.groupNickname, "GroupCard");
  assert.equal(stored.session?.author?.accountNickname, undefined);
});

test("onebot v11 runtime releases buffered live messages without history extensions", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-onebot-recovery-"),
  );
  try {
    const app = runtime.createChatRuntimeApp(agentDir);
    runtime.instantiateBuiltInChatRuntimeAdapters(app, {
      dataDir: path.join(agentDir, "data"),
      settings: {},
      adapterEntries: [
        {
          key: "onebot",
          name: "OneBot",
          config: { endpoint: "ws://127.0.0.1:3001", selfId: "bot-1" },
        },
      ],
    });
    const adapter = [...app.adapters][0];
    const seen: string[] = [];
    app.on("message", (session) => seen.push(session.messageId));
    messageStore.saveChatMessage(agentDir, {
      role: "user",
      platform: "onebot",
      botId: "bot-1",
      chatId: "123",
      chatKey: "onebot/bot-1:123",
      messageId: "id-100",
      receivedAt: "2026-07-13T00:00:00.000Z",
      platformTimestamp: 1000,
      providerCursor: "100",
    });
    const payload = (
      messageId: string,
      messageSeq: string,
      time: number,
      text: string,
    ) => ({
      post_type: "message",
      message_type: "group",
      self_id: "bot-1",
      group_id: "123",
      user_id: "owner-1",
      message_id: messageId,
      message_seq: messageSeq,
      time,
      sender: { nickname: "Owner" },
      raw_message: text,
      message: [{ type: "text", data: { text } }],
    });
    const duplicateLive = payload("id-300", "300", 3, "live copy");
    const newestLive = payload("id-400", "400", 3, "newest");
    adapter.callAction = async (action: string) => {
      assert.fail(
        `OneBot v11 recovery must not call extension action ${action}`,
      );
    };
    adapter.inboundGate.begin();
    adapter.inboundGate.buffer("123", duplicateLive);
    adapter.inboundGate.buffer("123", newestLive);

    await adapter.recoverOneBotMessages();

    assert.deepEqual(seen, ["id-300", "id-400"]);
    assert.deepEqual(adapter.bot.inboundRecovery, {
      status: "ready",
      mode: "live-only",
    });
    assert.equal(adapter.inboundGate.isBuffering(), false);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("onebot v11 runtime releases all buffered chats without history waiting", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-onebot-isolated-recovery-"),
  );
  try {
    const app = runtime.createChatRuntimeApp(agentDir);
    runtime.instantiateBuiltInChatRuntimeAdapters(app, {
      dataDir: path.join(agentDir, "data"),
      settings: {},
      adapterEntries: [
        {
          key: "onebot",
          name: "OneBot",
          config: { endpoint: "ws://127.0.0.1:3001", selfId: "bot-1" },
        },
      ],
    });
    const adapter = [...app.adapters][0];
    const seen = [];
    app.on("message", (session) => seen.push(session.messageId));
    messageStore.saveChatMessage(agentDir, {
      role: "user",
      platform: "onebot",
      botId: "bot-1",
      chatId: "123",
      chatKey: "onebot/bot-1:123",
      messageId: "id-100",
      receivedAt: "2026-07-13T00:00:00.000Z",
      platformTimestamp: 1000,
      providerCursor: "100",
    });
    const payload = (messageId, messageSeq, groupId, time) => ({
      post_type: "message",
      message_type: "group",
      self_id: "bot-1",
      group_id: groupId,
      user_id: "owner-1",
      message_id: messageId,
      message_seq: messageSeq,
      time,
      sender: { nickname: "Owner" },
      raw_message: messageId,
      message: [{ type: "text", data: { text: messageId } }],
    });
    const slowLive = payload("id-300", "300", "123", 3);
    const fastLive = payload("id-400", "400", "999", 4);
    const fastFollowUp = payload("id-500", "500", "999", 5);
    adapter.callAction = async (action) => {
      assert.fail(
        `OneBot v11 recovery must not call extension action ${action}`,
      );
    };
    let releaseHandoff = () => {};
    let handoffStarted = () => {};
    const handoffPending = new Promise((resolve) => {
      releaseHandoff = resolve;
    });
    const handoffObserved = new Promise((resolve) => {
      handoffStarted = resolve;
    });
    const originalBuildSession = adapter.buildSession.bind(adapter);
    adapter.buildSession = async (payload) => {
      if (payload?.message_id === "id-400") {
        handoffStarted();
        await handoffPending;
      }
      return await originalBuildSession(payload);
    };
    adapter.inboundGate.begin();
    adapter.inboundGate.buffer("123", slowLive);
    adapter.inboundGate.buffer("999", fastLive);

    let configured = false;
    const recovering = adapter.recoverOneBotMessages(() => {
      configured = true;
    });
    await handoffObserved;
    assert.equal(adapter.inboundGate.buffer("999", fastFollowUp), true);
    releaseHandoff();
    const deadline = Date.now() + 1000;
    while ((!seen.includes("id-500") || !configured) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(configured, true);
    assert.deepEqual(adapter.bot.inboundRecovery, {
      status: "ready",
      mode: "live-only",
    });
    assert.deepEqual(seen, ["id-300", "id-400", "id-500"]);
    assert.equal(app.isInboundRecoveryChat("onebot/bot-1:123"), false);
    assert.equal(app.isInboundRecoveryChat("onebot/bot-1:999"), false);

    await recovering;
    assert.deepEqual(seen, ["id-300", "id-400", "id-500"]);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("onebot runtime requeues buffered ingress when durable emit fails", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-onebot-requeue-"),
  );
  try {
    const app = runtime.createChatRuntimeApp(agentDir);
    runtime.instantiateBuiltInChatRuntimeAdapters(app, {
      dataDir: path.join(agentDir, "data"),
      settings: {},
      adapterEntries: [
        {
          key: "onebot",
          name: "OneBot",
          config: { endpoint: "ws://127.0.0.1:3001", selfId: "bot-1" },
        },
      ],
    });
    const adapter = [...app.adapters][0];
    const first = { message_id: "buffered-1" };
    const second = { message_id: "buffered-2" };
    adapter.inboundGate.begin();
    adapter.inboundGate.configure(["123"]);
    adapter.inboundGate.buffer("123", first);
    adapter.inboundGate.buffer("123", second);
    adapter.buildSession = async (payload) => ({
      platform: "onebot",
      selfId: "bot-1",
      channelId: "123",
      messageId: payload.message_id,
      timestamp: payload === first ? 1000 : 2000,
    });
    const seen = [];
    let failSecond = true;
    app.emit = (_event, session) => {
      if (session.messageId === "buffered-2" && failSecond) {
        throw new Error("durable inbox write failed");
      }
      seen.push(session.messageId);
      return true;
    };

    await assert.rejects(
      adapter.finishOneBotRecovery("123", []),
      /durable inbox write failed/,
    );

    assert.deepEqual(seen, ["buffered-1"]);
    assert.equal(adapter.inboundGate.hasPending("123"), true);
    failSecond = false;
    await adapter.finishOneBotRecovery("123", []);
    assert.deepEqual(seen, ["buffered-1", "buffered-2"]);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("telegram runtime reports ready only after native cursor catch-up", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-telegram-recovery-"),
  );
  try {
    const app = runtime.createChatRuntimeApp(agentDir);
    runtime.instantiateBuiltInChatRuntimeAdapters(app, {
      dataDir: path.join(agentDir, "data"),
      settings: {},
      adapterEntries: [
        { key: "telegram", name: "Telegram", config: { token: "123:abc" } },
      ],
    });
    const adapter = [...app.adapters][0];
    let releaseCatchUp: () => void = () => {};
    const catchUp = new Promise<void>((resolve) => {
      releaseCatchUp = resolve;
    });
    adapter.bootstrap = async () => {};
    adapter.catchUpTelegramUpdates = async () => await catchUp;
    adapter.pollLoop = async () => {};

    const starting = adapter.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(adapter.bot.status, 0);
    assert.equal(adapter.bot.inboundRecovery, undefined);

    releaseCatchUp();
    await starting;
    assert.equal(adapter.bot.status, 1);
    assert.deepEqual(adapter.bot.inboundRecovery, {
      status: "ready",
      mode: "native-cursor",
    });
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("telegram and onebot adapters emit replies as canonical quote nodes", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-runtime-quote-"),
  );
  try {
    const app = runtime.createChatRuntimeApp(agentDir);
    runtime.instantiateBuiltInChatRuntimeAdapters(app, {
      dataDir: path.join(agentDir, "data"),
      settings: {},
      adapterEntries: [
        { key: "telegram", name: "Telegram", config: { token: "123:abc" } },
        {
          key: "onebot",
          name: "OneBot",
          config: { endpoint: "ws://127.0.0.1:3001", selfId: "bot-1" },
        },
      ],
    });
    const telegram = [...app.adapters].find(
      (adapter) => adapter.bot.platform === "telegram",
    );
    const onebot = [...app.adapters].find(
      (adapter) => adapter.bot.platform === "onebot",
    );

    const telegramSession = await telegram.buildSession(
      {},
      {
        message_id: 10,
        date: 1713436800,
        chat: { id: 20, type: "private" },
        from: { id: 30, username: "owner" },
        text: "continue",
        reply_to_message: {
          message_id: 9,
          from: { id: 30, username: "owner" },
          text: "previous",
        },
      },
    );
    const onebotSession = await onebot.buildSession({
      post_type: "message",
      message_type: "private",
      self_id: "bot-1",
      user_id: "owner-1",
      message_id: "78",
      time: 1713436800,
      message: [
        { type: "reply", data: { id: "77" } },
        { type: "text", data: { text: "continue" } },
      ],
    });

    assert.equal(telegramSession.quote, undefined);
    assert.deepEqual(telegramSession.elements[0], {
      type: "quote",
      attrs: { id: "9" },
      children: [],
    });
    assert.equal(onebotSession.quote, undefined);
    assert.deepEqual(onebotSession.elements[0], {
      type: "quote",
      attrs: { id: "77" },
      children: [],
    });
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
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
      order.push(`ack:${inbox.listPendingChatInboxItems(agentDir).length}`);
    },
    body: {
      event: {
        type: "message",
        user: "U1",
        channel: "D1",
        text: "hello",
        ts: "123.456",
        thread_ts: "123.000",
      },
    },
  };

  await adapter.handleSlackEvent(envelope);

  assert.deepEqual(order, ["emit", "ack:1"]);
  const stored = inbox.listPendingChatInboxItems(agentDir)[0];
  assert.equal(stored.routing?.replyToMessageId, "123.000");
  assert.equal(stored.elements?.[0]?.type, "quote");
});

test("lark runtime paginates native history before releasing buffered events", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-lark-recovery-"),
  );
  try {
    const seen: string[] = [];
    let bot: any = null;
    const adapter = new adapters.LarkAdapter(
      {
        agentDir,
        register(_adapter: unknown, registeredBot: any) {
          bot = registeredBot;
        },
        emit(event: string, session: any) {
          if (event === "message") seen.push(session.messageId);
          return true;
        },
      },
      agentDir,
      {},
      { warn() {}, info() {}, error() {}, debug() {} },
    );
    bot.selfId = "app-1";
    messageStore.saveChatMessage(agentDir, {
      role: "user",
      platform: "lark",
      botId: "app-1",
      chatId: "chat-1",
      chatKey: "lark/app-1:chat-1",
      messageId: "m100",
      receivedAt: "2026-07-13T00:00:00.000Z",
      platformTimestamp: 1000,
    });
    const historyItem = (
      messageId: string,
      createTime: string,
      text: string,
      senderType = "user",
    ) => ({
      message_id: messageId,
      create_time: createTime,
      chat_id: "chat-1",
      chat_type: "group",
      msg_type: "text",
      body: { content: JSON.stringify({ text }) },
      sender: {
        id: senderType === "app" ? "app-open-id" : "owner-1",
        id_type: "open_id",
        sender_type: senderType,
      },
    });
    const eventData = (
      messageId: string,
      createTime: string,
      text: string,
    ) => ({
      message: {
        message_id: messageId,
        create_time: createTime,
        chat_id: "chat-1",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text }),
      },
      sender: {
        sender_type: "user",
        sender_id: { open_id: "owner-1" },
      },
    });
    const listCalls: any[] = [];
    (adapter as any).client = {
      im: {
        message: {
          async list(options: any) {
            listCalls.push(options);
            if (!options.params.page_token) {
              return {
                code: 0,
                data: {
                  items: [
                    historyItem("m100", "1000", "head"),
                    historyItem("m150", "1500", "bot output", "app"),
                    historyItem("m200", "2000", "missed"),
                  ],
                  has_more: true,
                  page_token: "next-page",
                },
              };
            }
            return {
              code: 0,
              data: {
                items: [historyItem("m300", "3000", "history copy")],
                has_more: false,
              },
            };
          },
        },
      },
    };
    let resolved = 0;
    (adapter as any).inboundGate.begin();
    (adapter as any).inboundGate.buffer("chat-1", {
      data: eventData("m300", "3000", "live copy"),
      resolve: () => {
        resolved += 1;
      },
      reject: assert.fail,
    });
    (adapter as any).inboundGate.buffer("chat-1", {
      data: eventData("m400", "3000", "newest"),
      resolve: () => {
        resolved += 1;
      },
      reject: assert.fail,
    });

    await (adapter as any).recoverLarkMessages();

    assert.equal(listCalls.length, 2);
    assert.equal(listCalls[1].params.page_token, "next-page");
    assert.deepEqual(seen, ["m200", "m300", "m400"]);
    assert.equal(resolved, 2);
    assert.deepEqual(bot.inboundRecovery, { status: "ready" });
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("lark runtime releases unrelated chats while one history fetch is still pending", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-lark-isolated-recovery-"),
  );
  try {
    const seen = [];
    let bot = null;
    const adapter = new adapters.LarkAdapter(
      {
        agentDir,
        register(_adapter, registeredBot) {
          bot = registeredBot;
        },
        emit(event, session) {
          if (event === "message") seen.push(session.messageId);
          return true;
        },
      },
      agentDir,
      {},
      { warn() {}, info() {}, error() {}, debug() {} },
    );
    bot.selfId = "app-1";
    messageStore.saveChatMessage(agentDir, {
      role: "user",
      platform: "lark",
      botId: "app-1",
      chatId: "slow",
      chatKey: "lark/app-1:slow",
      messageId: "m100",
      receivedAt: "2026-07-13T00:00:00.000Z",
      platformTimestamp: 1000,
    });
    const eventData = (messageId, createTime, chatId) => ({
      message: {
        message_id: messageId,
        create_time: createTime,
        chat_id: chatId,
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: messageId }),
      },
      sender: {
        sender_type: "user",
        sender_id: { open_id: "owner-1" },
      },
    });
    const historyItem = (messageId, createTime) => ({
      message_id: messageId,
      create_time: createTime,
      chat_id: "slow",
      chat_type: "group",
      msg_type: "text",
      body: { content: JSON.stringify({ text: messageId }) },
      sender: { id: "owner-1", id_type: "open_id", sender_type: "user" },
    });
    let releaseHistory = () => {};
    const historyPending = new Promise((resolve) => {
      releaseHistory = resolve;
    });
    adapter.client = {
      im: {
        message: {
          async list() {
            await historyPending;
            return {
              code: 0,
              data: {
                items: [
                  historyItem("m100", "1000"),
                  historyItem("m200", "2000"),
                ],
                has_more: false,
              },
            };
          },
        },
      },
    };
    let releaseHandoff = () => {};
    let handoffStarted = () => {};
    const handoffPending = new Promise((resolve) => {
      releaseHandoff = resolve;
    });
    const handoffObserved = new Promise((resolve) => {
      handoffStarted = resolve;
    });
    const originalHandleMessage = adapter.handleMessage.bind(adapter);
    adapter.handleMessage = async (data) => {
      if (data?.message?.message_id === "m400") {
        handoffStarted();
        await handoffPending;
      }
      await originalHandleMessage(data);
    };
    adapter.inboundGate.begin();
    adapter.inboundGate.buffer("slow", {
      data: eventData("m300", "3000", "slow"),
      resolve() {},
      reject: assert.fail,
    });
    adapter.inboundGate.buffer("fast", {
      data: eventData("m400", "4000", "fast"),
      resolve() {},
      reject: assert.fail,
    });

    let configured = false;
    const recovering = adapter.recoverLarkMessages(() => {
      configured = true;
    });
    await handoffObserved;
    assert.equal(
      adapter.inboundGate.buffer("fast", {
        data: eventData("m500", "5000", "fast"),
        resolve() {},
        reject: assert.fail,
      }),
      true,
    );
    releaseHandoff();
    const deadline = Date.now() + 1000;
    while ((!seen.includes("m500") || !configured) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(configured, true);
    assert.deepEqual(bot.inboundRecovery, {
      status: "recovering",
      pending: ["lark/app-1:slow"],
    });
    assert.deepEqual(seen, ["m400", "m500"]);

    releaseHistory();
    await recovering;
    assert.deepEqual(seen, ["m400", "m500", "m200", "m300"]);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("lark recovery requeues only the unhandled buffered suffix", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-lark-requeue-"),
  );
  try {
    const adapter = new adapters.LarkAdapter(
      { register() {} },
      agentDir,
      {},
      { warn() {}, info() {}, error() {}, debug() {} },
    );
    const entry = (messageId, createTime) => ({
      data: {
        message: { message_id: messageId, create_time: createTime },
      },
      resolve() {},
      reject() {},
    });
    const first = entry("m100", "1000");
    const second = entry("m200", "2000");
    const seen = [];
    let failSecond = true;
    adapter.handleMessage = async (data) => {
      const messageId = data.message.message_id;
      if (messageId === "m200" && failSecond) {
        throw new Error("durable inbox write failed");
      }
      seen.push(messageId);
    };
    adapter.inboundGate.begin();
    adapter.inboundGate.configure(["chat-1"]);
    adapter.inboundGate.buffer("chat-1", first);
    adapter.inboundGate.buffer("chat-1", second);

    await assert.rejects(
      adapter.finishLarkRecovery("chat-1", []),
      /durable inbox write failed/,
    );
    assert.deepEqual(seen, ["m100"]);
    assert.equal(adapter.inboundGate.hasPending("chat-1"), true);

    failSecond = false;
    await adapter.finishLarkRecovery("chat-1", []);
    assert.deepEqual(seen, ["m100", "m200"]);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("lark startup retries local recovery handling without closing transport", async () => {
  const Lark = nodeRequire("@larksuiteoapi/node-sdk");
  const originalClient = Lark.Client;
  const originalWSClient = Lark.WSClient;
  let closed = false;

  class FakeWSClient {
    start() {}
    close() {
      closed = true;
    }
  }

  Lark.Client = class FakeClient {
    async request() {
      return { code: 0, bot: { open_id: "ou_bot", app_name: "Rin" } };
    }
  };
  Lark.WSClient = FakeWSClient;
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-lark-recovery-retry-"),
  );
  try {
    let bot = null;
    const adapter = new adapters.LarkAdapter(
      {
        agentDir,
        register(_adapter, registeredBot) {
          bot = registeredBot;
        },
        emit() {
          return true;
        },
      },
      agentDir,
      { appId: "cli_test", appSecret: "secret" },
      { warn() {}, info() {}, error() {}, debug() {} },
    );
    let attempts = 0;
    adapter.recoverLarkMessages = async (onConfigured) => {
      attempts += 1;
      onConfigured?.();
      if (attempts === 1) throw new Error("durable inbox write failed");
      bot.inboundRecovery = { status: "ready" };
    };

    await adapter.start();

    assert.equal(attempts, 2);
    assert.equal(closed, false);
    assert.equal(bot.status, 1);
    assert.deepEqual(bot.inboundRecovery, { status: "ready" });
  } finally {
    Lark.Client = originalClient;
    Lark.WSClient = originalWSClient;
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("lark startup resolves the bot open id without changing the stable app identity", async () => {
  const Lark = nodeRequire("@larksuiteoapi/node-sdk");
  const originalClient = Lark.Client;
  const originalWSClient = Lark.WSClient;
  const identityCalls: any[] = [];

  class FakeWSClient {
    start() {}
    close() {}
  }

  Lark.Client = class FakeClient {
    async request(options: any) {
      identityCalls.push(options);
      return {
        code: 0,
        bot: { open_id: "ou_bot", app_name: "Rin" },
      };
    }
  };
  Lark.WSClient = FakeWSClient;

  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-lark-identity-"),
  );
  try {
    let bot: any = null;
    const adapter = new adapters.LarkAdapter(
      {
        agentDir,
        register(_adapter: unknown, registeredBot: any) {
          bot = registeredBot;
        },
        emit() {
          return true;
        },
      },
      agentDir,
      { appId: "cli_test", appSecret: "secret" },
      { warn() {}, info() {}, error() {}, debug() {} },
    );

    await adapter.start();

    assert.deepEqual(identityCalls, [
      { url: "/open-apis/bot/v3/info", method: "GET" },
    ]);
    assert.equal(bot.selfId, "cli_test");
    assert.deepEqual(bot.user, {
      name: "Rin",
      username: "Rin",
      nick: "Rin",
    });
    await adapter.stop();
  } finally {
    Lark.Client = originalClient;
    Lark.WSClient = originalWSClient;
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("lark startup rejects an unresolved bot identity instead of silently disabling mentions", async () => {
  const Lark = nodeRequire("@larksuiteoapi/node-sdk");
  const originalClient = Lark.Client;
  const originalWSClient = Lark.WSClient;
  let websocketStarts = 0;

  Lark.Client = class FakeClient {
    async request() {
      return { code: 0, bot: {} };
    }
  };
  Lark.WSClient = class FakeWSClient {
    start() {
      websocketStarts += 1;
    }
    close() {}
  };

  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-lark-missing-identity-"),
  );
  try {
    const adapter = new adapters.LarkAdapter(
      { agentDir, register() {}, emit() {} },
      agentDir,
      { appId: "cli_test", appSecret: "secret" },
      { warn() {}, info() {}, error() {}, debug() {} },
    );

    await assert.rejects(
      adapter.start(),
      /Lark bot identity response is missing open_id/,
    );
    assert.equal(websocketStarts, 0);
  } finally {
    Lark.Client = originalClient;
    Lark.WSClient = originalWSClient;
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("lark runtime recognizes only the exact bot open id in native mentions", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-lark-mention-"),
  );
  try {
    const app = runtime.createChatRuntimeApp(agentDir);
    runtime.instantiateBuiltInChatRuntimeAdapters(app, {
      dataDir: path.join(agentDir, "data"),
      settings: {},
      adapterEntries: [
        {
          key: "lark",
          name: "Feishu",
          config: { appId: "cli_test", appSecret: "secret" },
        },
      ],
    });
    const adapter = [...app.adapters][0];
    adapter.bot.selfId = "cli_test";
    adapter.bot.user = { openId: "ou_not_the_bot_identity" };
    adapter.botOpenId = "ou_bot";
    const seen: any[] = [];
    app.on("message", (session: any) => seen.push(session));
    const event = (messageId: string, openId: string) => ({
      sender: { sender_type: "user", sender_id: { open_id: "ou_sender" } },
      message: {
        message_id: messageId,
        message_type: "text",
        chat_id: "oc_chat",
        chat_type: "group",
        create_time: "1713436800000",
        content: JSON.stringify({ text: "@_user_1 ping" }),
        mentions: [
          {
            key: "@_user_1",
            id: { open_id: openId },
            mentioned_type: "bot",
            name: "Rin",
          },
        ],
      },
    });

    await adapter.handleMessage(event("om-self-mention", "ou_bot"));
    await adapter.handleMessage(event("om-self-mention", "ou_bot"));
    await adapter.handleMessage(event("om-other-bot", "ou_other_bot"));

    assert.equal(seen.length, 3);
    assert.equal(seen[0].stripped.appel, true);
    assert.equal(seen[0].elements[0].type, "at");
    assert.equal(seen[0].elements[0].attrs.id, "ou_bot");
    assert.equal(seen[1].stripped.appel, true);
    assert.equal(seen[2].stripped.appel, false);
    assert.equal(seen[2].elements[0].attrs.id, "ou_other_bot");

    const pending = inbox.listPendingChatInboxItems(agentDir);
    assert.equal(pending.length, 2);
    assert.equal(
      messageStore.getChatMessage(
        agentDir,
        "lark/cli_test:oc_chat",
        "om-self-mention",
      )?.duplicateCount,
      1,
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("lark websocket events settle only after durable message handling", async () => {
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

  Lark.Client = class FakeClient {
    async request() {
      return { code: 0, bot: { open_id: "ou_bot", app_name: "Rin" } };
    }
  };
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

    assert.equal(handlingStarted, true);
    assert.equal(state, "pending");

    resolveHandling();
    await handled;
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

  const files = inbox.listPendingChatInboxItems(agentDir);
  const stored = files[0];
  assert.match(stored.routing?.text, /Alice: hello/);
  assert.doesNotMatch(stored.routing?.text, /Merged and Forwarded Message/);
});

test("lark runtime maps reply parent ids to canonical quote rich text", async () => {
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
  const emittedByAdapter = [];
  const emit = app.emit.bind(app);
  app.emit = (event, session) => {
    if (event === "message") {
      emittedByAdapter.push({
        quote: session.quote,
        stripped: session.stripped,
        elements: JSON.parse(JSON.stringify(session.elements)),
      });
    }
    return emit(event, session);
  };
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
  assert.equal(emittedByAdapter[0].quote, undefined);
  assert.deepEqual(emittedByAdapter[0].stripped, {
    appel: false,
    content: "continue",
  });
  assert.deepEqual(emittedByAdapter[0].elements[0], {
    type: "quote",
    attrs: { id: "om-parent" },
    children: [],
  });
  const files = inbox.listPendingChatInboxItems(agentDir);
  const stored = files[0];
  assert.equal(stored.routing?.replyToMessageId, "om-parent");
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

  const files = inbox.listPendingChatInboxItems(agentDir);
  const stored = files[0];
  assert.match(stored.elements[0].attrs.src, /^file:\/\//);
  assert.equal(stored.elements[0].attrs.mimeType, "image/png");
});

test("lark runtime preserves official audio, video, sticker, and post media nodes", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-lark-media-"),
  );
  try {
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
    const resourceCalls: any[] = [];
    adapter.client = {
      im: {
        messageResource: {
          get: async (options: any) => {
            resourceCalls.push(options);
            return {
              headers: { "content-type": "application/octet-stream" },
              writeFile: async (filePath: string) => {
                await fs.writeFile(filePath, Buffer.from("media"));
                return filePath;
              },
            };
          },
        },
      },
    };
    const seen: any[] = [];
    app.on("message", (session: any) => seen.push(session));
    const event = (messageId: string, messageType: string, content: any) => ({
      sender: { sender_type: "user", sender_id: { open_id: "ou_sender" } },
      message: {
        message_id: messageId,
        message_type: messageType,
        chat_id: "oc_chat",
        chat_type: "group",
        create_time: "1713436800000",
        content: JSON.stringify(content),
      },
    });

    await adapter.handleMessage(
      event("om-audio", "audio", { file_key: "audio-key", duration: 1500 }),
    );
    await adapter.handleMessage(
      event("om-video", "media", {
        file_key: "video-key",
        file_name: "clip.mp4",
        image_key: "cover-key",
        duration: 30000,
      }),
    );
    await adapter.handleMessage(
      event("om-sticker", "sticker", { file_key: "sticker-key" }),
    );
    await adapter.handleMessage(
      event("om-post-media", "post", {
        zh_cn: {
          content: [
            [
              {
                tag: "media",
                file_key: "post-video-key",
                image_key: "post-cover-key",
              },
            ],
          ],
        },
      }),
    );

    assert.deepEqual(
      seen.map((session) => session.elements[0].type),
      ["audio", "video", "sticker", "video"],
    );
    assert.match(seen[0].elements[0].attrs.src, /^file:\/\//);
    assert.equal(seen[0].elements[0].attrs.duration, 1500);
    assert.match(seen[1].elements[0].attrs.src, /^file:\/\//);
    assert.equal(seen[1].elements[0].attrs.name, "clip.mp4");
    assert.equal(seen[1].elements[0].attrs.cover, "cover-key");
    assert.equal(seen[2].elements[0].attrs.src, "sticker-key");
    assert.match(seen[3].elements[0].attrs.src, /^file:\/\//);
    assert.deepEqual(
      resourceCalls.map((call) => call.params.type),
      ["file", "file", "file"],
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
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

  const files = inbox.listPendingChatInboxItems(agentDir);
  const stored = files[0];
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
