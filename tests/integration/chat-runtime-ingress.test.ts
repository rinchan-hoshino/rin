import "../support/require-test-sandbox.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const runtime = Object.assign(
  {},
  await import(
    pathToFileURL(path.join(rootDir, "dist", "core", "chat", "chat.js")).href
  ),
  await import(
    pathToFileURL(path.join(rootDir, "dist", "core", "chat", "chat.js")).href
  ),
);
const inbox = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "inbox.js")).href
);
const messageStore = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js"))
    .href
);

test("chat runtime persists inbound sessions before emitting message events", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-runtime-"),
  );
  const app = runtime.createChat(agentDir);
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
  const app = runtime.createChat(agentDir);
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
    const app = runtime.createChat(agentDir);
    runtime.addBuiltInPlatforms(app, {
      dataDir: path.join(agentDir, "data"),
      settings: {},
      entries: [
        {
          platform: "discord",
          name: "Discord",
          config: { token: "abc" },
        },
      ],
    });
    const adapter = [...app.platforms][0];
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
  const app = runtime.createChat(agentDir);
  runtime.addBuiltInPlatforms(app, {
    dataDir: path.join(agentDir, "data"),
    settings: {},
    entries: [
      {
        platform: "discord",
        name: "Discord",
        config: { token: "abc" },
      },
    ],
  });
  app.setWorkingText("Localized acknowledgement");
  const adapter = [...app.platforms][0];
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
    reply: async (payload: { content: string }) => {
      assert.equal(payload.content, "Localized acknowledgement");
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
  const app = runtime.createChat(agentDir);

  const session = {
    platform: "example",
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
  assert.equal(stored.chatKey, "example/1:42");
  assert.equal(stored.messageId, "m2");
  assert.equal(stored.routing?.chatType, "private");
  assert.equal(stored.routing?.userId, "42");
});

test("telegram runtime reports ready only after native cursor catch-up", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-telegram-recovery-"),
  );
  try {
    const app = runtime.createChat(agentDir);
    runtime.addBuiltInPlatforms(app, {
      dataDir: path.join(agentDir, "data"),
      settings: {},
      entries: [
        {
          platform: "telegram",
          name: "Telegram",
          config: { token: "123:abc" },
        },
      ],
    });
    const adapter = [...app.platforms][0];
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

test("telegram runtime advances the poll cursor only after the update is handled", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-runtime-"),
  );
  const app = runtime.createChat(agentDir);
  runtime.addBuiltInPlatforms(app, {
    dataDir: path.join(agentDir, "data"),
    settings: {},
    entries: [
      { platform: "telegram", name: "Telegram", config: { token: "123:abc" } },
    ],
  });
  const adapter = [...app.platforms][0];
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
  const app = runtime.createChat(agentDir);
  runtime.addBuiltInPlatforms(app, {
    dataDir: path.join(agentDir, "data"),
    settings: {},
    entries: [
      { platform: "telegram", name: "Telegram", config: { token: "123:abc" } },
    ],
  });
  const adapter = [...app.platforms][0];
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
