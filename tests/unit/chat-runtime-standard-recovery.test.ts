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
const adapters = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat-runtime", "adapters.js"),
  ).href
);
const messageStore = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js"))
    .href
);
const inboundRecovery = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat-runtime", "inbound-recovery.js"),
  ).href
);
const database = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "database.js")).href
);

function logger(warnings: string[] = []) {
  return {
    warn(message: unknown) {
      warnings.push(String(message));
    },
    info() {},
    error() {},
    debug() {},
  };
}

function saveInboundHead(
  agentDir: string,
  input: { platform: string; botId: string; chatId: string; messageId: string },
) {
  messageStore.saveChatMessage(agentDir, {
    role: "user",
    platform: input.platform,
    botId: input.botId,
    chatId: input.chatId,
    chatKey: `${input.platform}/${input.botId}:${input.chatId}`,
    messageId: input.messageId,
    receivedAt: "2026-08-05T00:00:00.000Z",
    platformTimestamp: 1,
    providerCursor: "1",
  });
}

function insertLegacyOneBotHead(
  agentDir: string,
  botId = "bot-1",
  chatId = "123",
) {
  const db = database.openChatDatabase(agentDir);
  db.prepare(
    `INSERT INTO inbound_heads (
       platform, bot_id, chat_key, chat_id, message_id,
       platform_timestamp, received_at, provider_cursor,
       sequence, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "onebot",
    botId,
    `onebot/${botId}:${chatId}`,
    chatId,
    "id-old",
    1,
    "2026-08-05T00:00:00.000Z",
    "1",
    1,
    "2026-08-05T00:00:00.000Z",
  );
}

test("onebot v11 live messages do not create non-standard history checkpoints", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-onebot-standard-head-"),
  );
  try {
    saveInboundHead(agentDir, {
      platform: "onebot",
      botId: "bot-1",
      chatId: "123",
      messageId: "id-live",
    });

    assert.deepEqual(
      inboundRecovery.listInboundRecoveryHeads(agentDir, "onebot", "bot-1"),
      [],
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("onebot v11 startup discards legacy recovery heads without calling history extensions", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-onebot-standard-startup-"),
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
    const adapter = [...app.adapters][0] as any;
    const seen: string[] = [];
    app.on("message", (session: any) => seen.push(session.messageId));
    insertLegacyOneBotHead(agentDir);
    insertLegacyOneBotHead(agentDir, "bot-2", "456");
    adapter.callAction = async (action: string) => {
      assert.fail(
        `OneBot v11 recovery must not call extension action ${action}`,
      );
    };
    const live = {
      post_type: "message",
      message_type: "group",
      self_id: "bot-1",
      group_id: "123",
      user_id: "owner-1",
      message_id: "id-live",
      message_seq: "2",
      time: 2,
      sender: { nickname: "Owner" },
      raw_message: "live",
      message: [{ type: "text", data: { text: "live" } }],
    };
    adapter.inboundGate.begin();
    adapter.inboundGate.buffer("123", live);

    await adapter.recoverOneBotMessages();

    assert.deepEqual(seen, ["id-live"]);
    assert.deepEqual(adapter.bot.inboundRecovery, {
      status: "ready",
      mode: "live-only",
    });
    assert.deepEqual(
      inboundRecovery.listInboundRecoveryHeads(agentDir, "onebot", "bot-1"),
      [],
    );
    assert.deepEqual(
      inboundRecovery
        .listInboundRecoveryHeads(agentDir, "onebot", "bot-2")
        .map((head: any) => head.chatKey),
      ["onebot/bot-2:456"],
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("discord channel deletion immediately removes its inbound recovery head", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-discord-channel-delete-"),
  );
  try {
    let bot: any;
    const adapter = new adapters.DiscordAdapter(
      {
        agentDir,
        register(_adapter: unknown, registeredBot: any) {
          bot = registeredBot;
        },
      },
      agentDir,
      {},
      logger(),
    ) as any;
    bot.selfId = "bot-discord";
    saveInboundHead(agentDir, {
      platform: "discord",
      botId: "bot-discord",
      chatId: "channel-1",
      messageId: "100",
    });
    saveInboundHead(agentDir, {
      platform: "discord",
      botId: "bot-discord",
      chatId: "channel-2",
      messageId: "200",
    });

    await adapter.handleChannelDelete({ id: "channel-1" });

    assert.deepEqual(
      inboundRecovery
        .listInboundRecoveryHeads(agentDir, "discord", "bot-discord")
        .map((head: any) => head.chatKey),
      ["discord/bot-discord:channel-2"],
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("discord startup treats API code 10003 as a terminal deleted channel", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-discord-unknown-channel-"),
  );
  try {
    const warnings: string[] = [];
    let bot: any;
    const adapter = new adapters.DiscordAdapter(
      {
        agentDir,
        register(_adapter: unknown, registeredBot: any) {
          bot = registeredBot;
        },
      },
      agentDir,
      {},
      logger(warnings),
    ) as any;
    bot.selfId = "bot-discord";
    saveInboundHead(agentDir, {
      platform: "discord",
      botId: "bot-discord",
      chatId: "channel-1",
      messageId: "100",
    });
    adapter.client = {
      channels: {
        async fetch() {
          throw Object.assign(new Error("Unknown Channel"), { code: 10003 });
        },
      },
    };
    adapter.inboundGate.begin();

    await adapter.recoverDiscordMessages();

    assert.deepEqual(bot.inboundRecovery, { status: "ready" });
    assert.deepEqual(warnings, []);
    assert.deepEqual(
      inboundRecovery.listInboundRecoveryHeads(
        agentDir,
        "discord",
        "bot-discord",
      ),
      [],
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("discord channel tombstone wins over in-flight recovery", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-discord-delete-recovery-race-"),
  );
  try {
    let bot: any;
    const adapter = new adapters.DiscordAdapter(
      {
        agentDir,
        register(_adapter: unknown, registeredBot: any) {
          bot = registeredBot;
        },
      },
      agentDir,
      {},
      logger(),
    ) as any;
    bot.selfId = "bot-discord";
    for (const [chatId, messageId] of [
      ["channel-1", "100"],
      ["channel-2", "200"],
    ]) {
      saveInboundHead(agentDir, {
        platform: "discord",
        botId: "bot-discord",
        chatId,
        messageId,
      });
    }

    let markFetchStarted = () => {};
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    let releaseFetch = () => {};
    const fetchBlocked = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const recovered = { id: "101", channelId: "channel-1" };
    let channelOneFetches = 0;
    adapter.client = {
      channels: {
        async fetch(channelId: string) {
          return {
            messages: {
              async fetch() {
                if (channelId !== "channel-1") return new Map();
                channelOneFetches += 1;
                if (channelOneFetches > 1) return new Map();
                markFetchStarted();
                await fetchBlocked;
                return new Map([[recovered.id, recovered]]);
              },
            },
          };
        },
      },
    };
    const handled: string[] = [];
    adapter.handleMessage = async (message: any) => {
      handled.push(message.id);
      saveInboundHead(agentDir, {
        platform: "discord",
        botId: "bot-discord",
        chatId: message.channelId,
        messageId: message.id,
      });
    };
    adapter.inboundGate.begin();

    const recovery = adapter.recoverDiscordMessages();
    await fetchStarted;
    adapter.handleChannelDelete({ id: "channel-1" });
    releaseFetch();
    await recovery;

    assert.deepEqual(handled, []);
    assert.deepEqual(
      inboundRecovery
        .listInboundRecoveryHeads(agentDir, "discord", "bot-discord")
        .map((head: any) => head.chatKey),
      ["discord/bot-discord:channel-2"],
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});
