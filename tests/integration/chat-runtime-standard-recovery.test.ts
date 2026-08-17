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
const adapters = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat", "platform", "discord.js"),
  ).href
);
const messageStore = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js"))
    .href
);
const inboundRecovery = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat", "inbound-recovery.js"),
  ).href
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

test("discord channel deletion immediately removes its inbound recovery head", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-discord-channel-delete-"),
  );
  try {
    let bot: any;
    const adapter = new adapters.DiscordPlatform(
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
    bot = adapter.bot;
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
    const adapter = new adapters.DiscordPlatform(
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
    bot = adapter.bot;
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
    adapter.handleChannelDelete = () => {
      assert.fail("Unknown Channel must not synthesize ChannelDelete");
    };

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
    const adapter = new adapters.DiscordPlatform(
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
    bot = adapter.bot;
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
