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
const runtime = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js"))
    .href
);
const inbox = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "inbox.js")).href
);

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
