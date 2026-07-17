import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const boot = await importBuiltModule<
  typeof import("../../src/core/chat/boot.js")
>("dist/core/chat/boot.js");
const outbox = await importBuiltModule<
  typeof import("../../src/core/rin-lib/chat-outbox.js")
>("dist/core/rin-lib/chat-outbox.js");

async function withTempDir(run: (directory: string) => Promise<void>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rin-boot-owner-"));
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const h = {
  text(content: string) {
    return { type: "text", attrs: { content } };
  },
  quote(id: string) {
    return { type: "quote", attrs: { id } };
  },
};

async function waitFor(check: () => void, timeoutMs = 1_000) {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      check();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

test("chat boot validates command payload boundaries and adapter sync failures", async () => {
  const long = "x".repeat(120);
  assert.deepEqual(
    boot.buildTelegramCommandPayload([
      { name: "A-B", description: "" },
      { name: "a_b", description: "duplicate" },
      { name: "x".repeat(33), description: "too long" },
      undefined as any,
    ]),
    [{ command: "a_b", description: "A-B" }],
  );
  const discord = boot.buildDiscordCommandPayload([
    { name: "VALID", description: long },
    { name: "valid", description: "duplicate" },
    { name: "bad name", description: "bad" },
    undefined as any,
  ]);
  assert.equal(discord.length, 1);
  assert.equal(discord[0].name, "valid");
  assert.equal(discord[0].description.length, 100);

  const telegramWarnings: string[] = [];
  const commanderCalls: any[] = [];
  await boot.syncTelegramCommands(
    {
      bots: [
        { platform: "discord" },
        {
          platform: "telegram",
          selfId: "fallback",
          updateCommands() {},
        },
        {
          platform: "telegram",
          selfId: "broken",
          internal: {
            async setMyCommands() {
              throw "sync failed";
            },
          },
        },
      ],
      $commander: {
        async updateCommands(bot: any) {
          commanderCalls.push(bot.selfId);
        },
      },
    },
    { warn: (message: string) => telegramWarnings.push(message) },
    [{ name: "help", description: "Help" }],
  );
  assert.deepEqual(commanderCalls, ["fallback"]);
  assert.match(
    telegramWarnings[0],
    /platform=telegram selfId=broken err=sync failed/,
  );

  const discordWarnings: string[] = [];
  await boot.syncDiscordCommands(
    {
      bots: [
        { platform: "telegram" },
        { platform: "discord", internal: {} },
        {
          platform: "discord",
          selfId: "broken",
          internal: {
            async setApplicationCommands() {
              throw new Error("discord failed");
            },
          },
        },
      ],
    },
    { warn: (message: string) => discordWarnings.push(message) },
    [{ name: "help" }],
  );
  assert.match(discordWarnings[0], /discord failed/);
  await boot.syncTelegramCommands({ bots: null }, { warn() {} });
  await boot.syncDiscordCommands({ bots: null }, { warn() {} });
});

test("chat boot normalizes timeout configuration for text and OneBot media", () => {
  const item = {
    payload: {
      createdAt: new Date().toISOString(),
      chatKey: "onebot/bot:chat",
      parts: [{ type: "IMAGE" as const, path: "/tmp/image.png" }],
    },
  };
  assert.equal(
    boot.getChatOutboxSendTimeoutMs(item as any),
    boot.DEFAULT_ONEBOT_MEDIA_CHAT_OUTBOX_SEND_TIMEOUT_MS,
  );
  assert.equal(
    boot.getChatOutboxSendTimeoutMs(undefined, { sendTimeoutMs: 1.9 }),
    1,
  );
  assert.equal(
    boot.getChatOutboxSendTimeoutMs(undefined, { sendTimeoutMs: 0 }),
    boot.DEFAULT_CHAT_OUTBOX_SEND_TIMEOUT_MS,
  );
  const previous = process.env.RIN_CHAT_OUTBOX_SEND_TIMEOUT_MS;
  try {
    process.env.RIN_CHAT_OUTBOX_SEND_TIMEOUT_MS = "25";
    assert.equal(boot.getChatOutboxSendTimeoutMs(), 25);
    process.env.RIN_CHAT_OUTBOX_SEND_TIMEOUT_MS = "bad";
    assert.equal(
      boot.getChatOutboxSendTimeoutMs(),
      boot.DEFAULT_CHAT_OUTBOX_SEND_TIMEOUT_MS,
    );
  } finally {
    if (previous === undefined)
      delete process.env.RIN_CHAT_OUTBOX_SEND_TIMEOUT_MS;
    else process.env.RIN_CHAT_OUTBOX_SEND_TIMEOUT_MS = previous;
  }
});

test("chat boot permanently fails expired, invalid, partial, and exhausted outbox work", async () => {
  await withTempDir(async (agentDir) => {
    outbox.enqueueChatOutboxPayload(agentDir, {
      createdAt: "2020-01-01T00:00:00.000Z",
      chatKey: "telegram/bot:expired",
      parts: [{ type: "text", text: "old" }],
    });
    const warnings: string[] = [];
    const expired = await boot.drainChatOutbox(
      { bots: [] },
      agentDir,
      h,
      { warn: (message: string) => warnings.push(message) },
      { maxAgeMs: 1 },
    );
    assert.equal(expired[0].status, "failed");
    assert.equal(expired[0].error, "chat_outbox_expired");

    outbox.enqueueChatOutboxPayload(agentDir, {
      createdAt: new Date().toISOString(),
      chatKey: "telegram/missing:no-bot",
      parts: [{ type: "text", text: "no bot" }],
    });
    const permanent = await boot.drainChatOutbox({ bots: [] }, agentDir, h, {
      warn: (message: string) => warnings.push(message),
    });
    assert.equal(permanent[0].status, "failed");
    assert.match(permanent[0].error, /no_bot_for_platform/);

    outbox.enqueueChatOutboxPayload(agentDir, {
      createdAt: new Date().toISOString(),
      chatKey: "telegram/bot:partial",
      parts: [{ type: "text", text: "partial" }],
    });
    const partialId = outbox
      .listChatOutboxItems(agentDir)
      .find(({ item }) => item.payload.chatKey === "telegram/bot:partial")!.item
      .id;
    const partialError: any = new Error("partial transport");
    partialError.partialDelivery = true;
    partialError.deliveredMessageIds = [" one ", "", 2];
    const partial = await boot.drainChatOutbox(
      {
        bots: [
          {
            platform: "telegram",
            selfId: "bot",
            async sendMessage() {
              throw partialError;
            },
          },
        ],
      },
      agentDir,
      h,
      { warn: (message: string) => warnings.push(message) },
      { chatKey: "telegram/bot:partial" },
    );
    assert.equal(partial[0].status, "dispatched");
    await waitFor(() => {
      const stored = outbox.readChatOutboxItemById(agentDir, partialId)?.item;
      assert.equal(stored?.status, "failed");
      assert.deepEqual(stored?.deliveryResult, ["one", "2"]);
    });

    outbox.enqueueChatOutboxPayload(agentDir, {
      createdAt: new Date().toISOString(),
      chatKey: "telegram/bot:exhausted",
      parts: [{ type: "text", text: "retry" }],
    });
    const exhaustedEntry = outbox
      .listChatOutboxItems(agentDir)
      .find(({ item }) => item.payload.chatKey === "telegram/bot:exhausted")!;
    outbox.writeChatOutboxItem(agentDir, {
      ...exhaustedEntry.item,
      attempts: 3,
      status: "queued",
    });
    const exhausted = await boot.drainChatOutbox(
      {
        bots: [
          {
            platform: "telegram",
            selfId: "bot",
            async sendMessage() {
              throw new Error("temporary");
            },
          },
        ],
      },
      agentDir,
      h,
      { warn: (message: string) => warnings.push(message) },
      { chatKey: "telegram/bot:exhausted" },
    );
    assert.equal(exhausted[0].status, "dispatched");
    await waitFor(() => {
      assert.equal(
        outbox.readChatOutboxItemById(agentDir, exhaustedEntry.item.id)?.item
          .status,
        "failed",
      );
    });
    assert.ok(
      warnings.some((message) => message.includes("chat outbox failed")),
    );
  });
});

test("chat boot reconciles only committed final and error post-delivery records", async () => {
  await withTempDir(async (agentDir) => {
    for (const deliveryKind of ["working", "final", "error"] as const) {
      outbox.enqueueChatOutboxPayload(
        agentDir,
        {
          createdAt: new Date().toISOString(),
          chatKey: `telegram/bot:${deliveryKind}`,
          parts: [{ type: "text", text: deliveryKind }],
        },
        {
          deliveryKind,
        },
      );
    }
    assert.equal(boot.reconcileCommittedChatOutboxProcessing(agentDir), 0);
    assert.equal(
      boot.reconcileCommittedChatOutboxProcessing(
        path.join(agentDir, "missing"),
      ),
      0,
    );
  });
});
