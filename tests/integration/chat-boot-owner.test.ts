import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import BetterSqlite3 from "better-sqlite3";

import { importBuiltModule } from "../support/import-built-module.js";

await import("../support/register-chat-boot-owner-fixture.ts");
const boot = await importBuiltModule<
  typeof import("../../src/core/chat/boot.js")
>("dist/core/chat/boot.js");
const outbox = await importBuiltModule<
  typeof import("../../src/core/chat/outbox.js")
>("dist/core/chat/outbox.js");
const messageStore = await importBuiltModule<
  typeof import("../../src/core/chat/message-store.js")
>("dist/core/chat/message-store.js");

async function withTempDir(run: (directory: string) => Promise<void>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rin-boot-owner-"));
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("chat boot private delivery state builders preserve edge contracts", async () => {
  const seam = boot as any;
  assert.equal(seam.__rinOwnerNormalizePositiveMilliseconds("2.9", 9), 2);
  assert.equal(seam.__rinOwnerNormalizePositiveMilliseconds("bad", 9), 9);
  assert.equal(seam.__rinOwnerNormalizePositiveMilliseconds(0, 9), 9);

  const base: any = {
    id: "owner-item",
    status: "sending",
    attempts: 1,
    ownerEpoch: "epoch",
    createdAt: "not-a-date",
    updatedAt: new Date().toISOString(),
    payload: {
      chatKey: "telegram/bot:owner",
      parts: [{ type: "text", text: "owner" }],
    },
  };
  assert.equal(seam.__rinOwnerIsRetryDue(base), true);
  assert.equal(
    seam.__rinOwnerIsOutboxItemExpired(base, { maxAgeMs: 1 }),
    false,
  );
  assert.equal(
    seam.__rinOwnerIsOutboxItemDrainable({ ...base, status: "delivered" }),
    false,
  );
  assert.equal(seam.__rinOwnerIsSameSendingAttempt({ ...base }, base), true);
  assert.equal(seam.__rinOwnerIsSameSendingAttempt(null, base), false);

  assert.equal(
    await seam.__rinOwnerWithChatOutboxSendTimeout(Promise.resolve("ok"), 10),
    "ok",
  );
  await assert.rejects(
    seam.__rinOwnerWithChatOutboxSendTimeout(new Promise(() => {}), 1),
    /chat_outbox_delivery_timeout:1/,
  );
  assert.equal(
    seam.__rinOwnerDeliveredChatOutboxItem(base, ["message"]).status,
    "delivered",
  );
  assert.deepEqual(
    seam.__rinOwnerDeliveredUnconfirmedChatOutboxItem(base, {
      message: "partial",
      deliveredMessageIds: ["fragment"],
    }).deliveryResult,
    ["fragment"],
  );
  assert.deepEqual(
    seam.__rinOwnerDeliveredUnconfirmedChatOutboxItem(
      { ...base, deliveryResult: ["old"] },
      new Error("owner"),
    ).deliveryResult,
    ["old"],
  );
  assert.equal(
    seam.__rinOwnerFailedChatOutboxItem(base, new Error("retry")),
    null,
  );
  assert.equal(
    seam.__rinOwnerFailedChatOutboxItem(
      { ...base, attempts: 99 },
      new Error("exhausted"),
    ).failureKind,
    "attempts_exhausted",
  );
  assert.equal(
    seam.__rinOwnerFailedChatOutboxItem(
      base,
      Object.assign(new Error("partial"), {
        partialDelivery: true,
        deliveredMessageIds: ["fragment"],
      }),
    ).failureKind,
    "partial",
  );
  assert.equal(
    seam.__rinOwnerQueuedChatOutboxItem(base, new Error("retry"), {
      keepSending: true,
      retryAfterMs: 0,
    }).status,
    "sending",
  );
  assert.equal(
    seam.__rinOwnerQueuedChatOutboxItem(base, new Error("retry")).status,
    "queued",
  );
  await withTempDir(async (agentDir) => {
    const result = seam.__rinOwnerSettleChatOutboxFailure(
      agentDir,
      { warn() {} },
      base,
      Object.assign(new Error("partial"), {
        partialDelivery: true,
        deliveredMessageIds: ["fragment"],
      }),
    );
    assert.deepEqual(result, {
      status: "superseded",
      error: "chat_outbox_attempt_superseded",
    });
  });
});

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

test("chat boot normalizes timeout configuration and platform media bounds", () => {
  const item = {
    payload: {
      createdAt: new Date().toISOString(),
      chatKey: "example/bot:chat",
      parts: [{ type: "IMAGE" as const, path: "/tmp/image.png" }],
    },
  };
  assert.equal(
    boot.getChatOutboxSendTimeoutMs(
      item as any,
      {},
      {
        bots: [
          {
            platform: "example",
            selfId: "bot",
            outboxMediaSendTimeoutMs: 600_000,
          },
        ],
      },
    ),
    600_000,
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

test("chat boot permanently rejects media removed before dispatch", async () => {
  await withTempDir(async (agentDir) => {
    const mediaPath = path.join(agentDir, "removed.png");
    await fs.writeFile(mediaPath, "image");
    outbox.enqueueChatOutboxPayload(agentDir, {
      createdAt: new Date().toISOString(),
      chatKey: "telegram/bot:media",
      parts: [{ type: "image", path: mediaPath }],
    });
    await fs.rm(mediaPath);
    const result = await boot.drainChatOutbox(
      {
        bots: [{ platform: "telegram", selfId: "bot", sendMessage() {} }],
      },
      agentDir,
      {
        ...h,
        image(src: string) {
          return { type: "image", attrs: { src } };
        },
      },
      { warn() {} },
      { chatKey: "telegram/bot:media" },
    );
    assert.equal(result[0].status, "queued");
    assert.match(result[0].error || "", /file_missing|media_missing/);
  });
});

test("chat boot keeps queued delivery untouched while transport is unavailable", async () => {
  await withTempDir(async (agentDir) => {
    const id = outbox.enqueueChatOutboxPayload(agentDir, {
      createdAt: new Date().toISOString(),
      chatKey: "telegram/bot:unavailable",
      parts: [{ type: "text", text: "wait for transport" }],
    });
    const result = await boot.drainChatOutbox(
      { bots: [] },
      agentDir,
      h,
      { warn() {} },
      { chatKey: "telegram/bot:unavailable" },
    );
    assert.deepEqual(result, []);
    assert.equal(
      outbox.readChatOutboxItemById(agentDir, id)!.item.status,
      "queued",
    );
  });
});

test("chat boot expires stale uncommitted delivery without dispatch", async () => {
  await withTempDir(async (agentDir) => {
    const id = outbox.enqueueChatOutboxPayload(agentDir, {
      createdAt: "2020-01-01T00:00:00.000Z",
      chatKey: "telegram/bot:expired",
      parts: [{ type: "text", text: "expired" }],
    });
    const warnings: string[] = [];
    const result = await boot.drainChatOutbox(
      {
        bots: [{ platform: "telegram", selfId: "bot", sendMessage() {} }],
      },
      agentDir,
      h,
      {
        warn(message: string) {
          warnings.push(message);
        },
      },
      { chatKey: "telegram/bot:expired", maxAgeMs: 1 },
    );
    assert.equal(result[0].id, id);
    assert.equal(result[0].status, "failed");
    assert.equal(result[0].error, "chat_outbox_expired");
    assert.equal(
      outbox.readChatOutboxItemById(agentDir, id)!.item.failureKind,
      "expired",
    );
    assert.match(warnings[0], /chat_outbox_expired/);
  });
});

test("chat boot permanently rejects corrupt persisted payloads", async () => {
  await withTempDir(async (agentDir) => {
    outbox.enqueueChatOutboxPayload(agentDir, {
      createdAt: new Date().toISOString(),
      chatKey: "telegram/bot:corrupt",
      parts: [{ type: "text", text: "valid before corruption" }],
    });
    const entry = outbox.listChatOutboxItems(agentDir)[0];
    const db = new BetterSqlite3(
      path.join(agentDir, "data", "chat", "chat.sqlite"),
    );
    db.prepare("UPDATE outbox SET payload_json = ? WHERE outbox_id = ?").run(
      JSON.stringify({
        ...entry.item.payload,
        parts: [{ type: "unsupported" }],
      }),
      entry.item.id,
    );
    db.close();

    const result = await boot.drainChatOutbox(
      {
        bots: [{ platform: "telegram", selfId: "bot", sendMessage() {} }],
      },
      agentDir,
      h,
      { warn() {} },
      { chatKey: "telegram/bot:corrupt" },
    );
    assert.equal(result[0].status, "failed");
    assert.match(
      result[0].error || "",
      /unsupported_chat_part|chat_outbox_invalid_part/,
    );
  });
});

test("chat boot settles late dispatched success and failure", async () => {
  await withTempDir(async (agentDir) => {
    for (const outcome of ["success", "failure", "partial"] as const) {
      const chatKey = `telegram/bot:late-${outcome}`;
      outbox.enqueueChatOutboxPayload(agentDir, {
        createdAt: new Date().toISOString(),
        chatKey,
        parts: [{ type: "text", text: outcome }],
      });
      const entry = outbox
        .listChatOutboxItems(agentDir)
        .find(({ item }) => item.payload.chatKey === chatKey)!;
      let resolveDelivery!: (value: string[]) => void;
      let rejectDelivery!: (error: Error) => void;
      const result = await boot.drainChatOutbox(
        {
          bots: [
            {
              platform: "telegram",
              selfId: "bot",
              outboxUsesDispatchSignal: true,
              sendMessage() {
                const delivery: any = new Promise<string[]>(
                  (resolve, reject) => {
                    resolveDelivery = resolve;
                    rejectDelivery = reject;
                  },
                );
                delivery.dispatched = Promise.resolve();
                return delivery;
              },
            },
          ],
        },
        agentDir,
        h,
        { warn() {} },
        { chatKey },
      );
      assert.equal(result[0].status, "dispatched");
      if (outcome === "success") resolveDelivery(["late-message"]);
      else if (outcome === "partial")
        rejectDelivery(
          Object.assign(new Error("chat_delivery_partial:owner"), {
            deliveredMessageIds: ["partial-message"],
            partialDelivery: true,
          }),
        );
      else rejectDelivery(new Error("late failure"));
      await waitFor(() => {
        const stored = outbox.readChatOutboxItemById(
          agentDir,
          entry.item.id,
        )!.item;
        assert.equal(
          stored.status,
          outcome === "partial" ? "failed" : "delivered",
        );
        if (outcome === "failure")
          assert.equal(stored.deliveryUnconfirmed, true);
        if (outcome === "partial")
          assert.deepEqual(stored.deliveryResult, ["partial-message"]);
      });
    }
  });
});

test("chat boot handles direct-dispatch success, timeout, and ambiguous failure", async () => {
  await withTempDir(async (agentDir) => {
    for (const outcome of ["success", "timeout", "failure"] as const) {
      const chatKey = `custom/bot:direct-${outcome}`;
      outbox.enqueueChatOutboxPayload(agentDir, {
        createdAt: new Date().toISOString(),
        chatKey,
        parts: [{ type: "text", text: outcome }],
      });
      const entry = outbox
        .listChatOutboxItems(agentDir)
        .find(({ item }) => item.payload.chatKey === chatKey)!;
      let resolveDelivery!: (value: string[]) => void;
      const result = await boot.drainChatOutbox(
        {
          bots: [
            {
              platform: "custom",
              selfId: "bot",
              outboxUsesDispatchSignal: false,
              sendMessage() {
                if (outcome === "success") return ["direct-message"];
                if (outcome === "failure") {
                  return Promise.reject(new Error("direct ambiguous failure"));
                }
                return new Promise<string[]>((resolve) => {
                  resolveDelivery = resolve;
                });
              },
            },
          ],
        },
        agentDir,
        h,
        { warn() {} },
        { chatKey, sendTimeoutMs: 5, retryLeaseMs: 20 },
      );
      if (outcome === "success") {
        assert.equal(result[0].status, "delivered");
      } else if (outcome === "failure") {
        assert.equal(result[0].status, "delivered");
        assert.equal(result[0].deliveryUnconfirmed, true);
      } else {
        assert.equal(result[0].status, "queued");
        resolveDelivery(["late-direct-message"]);
        await waitFor(() => {
          const stored = outbox.readChatOutboxItemById(
            agentDir,
            entry.item.id,
          )!.item;
          assert.equal(stored.status, "delivered");
          assert.deepEqual(stored.deliveryResult, ["late-direct-message"]);
        });
      }
    }
  });
});

test("chat boot reports superseded success and failure attempts", async () => {
  await withTempDir(async (agentDir) => {
    for (const outcome of ["success", "failure"] as const) {
      const chatKey = `telegram/bot:superseded-${outcome}`;
      outbox.enqueueChatOutboxPayload(agentDir, {
        createdAt: new Date().toISOString(),
        chatKey,
        parts: [{ type: "text", text: outcome }],
      });
      const entry = outbox
        .listChatOutboxItems(agentDir)
        .find(({ item }) => item.payload.chatKey === chatKey)!;
      const result = await boot.drainChatOutbox(
        {
          bots: [
            {
              platform: "telegram",
              selfId: "bot",
              sendMessage() {
                const sending = outbox.readChatOutboxItemById(
                  agentDir,
                  entry.item.id,
                )!.item;
                outbox.writeChatOutboxItem(agentDir, {
                  ...sending,
                  status: "delivered",
                  deliveredAt: new Date().toISOString(),
                });
                if (outcome === "failure")
                  throw new Error("superseded failure");
                return ["message-1"];
              },
            },
          ],
        },
        agentDir,
        h,
        { warn() {} },
        { chatKey },
      );
      assert.equal(result[0].status, "superseded");
    }
  });
});

test("chat boot returns targeted terminal items and recovers ambiguous sends", async () => {
  await withTempDir(async (agentDir) => {
    for (const status of ["delivered", "failed"] as const) {
      outbox.enqueueChatOutboxPayload(agentDir, {
        createdAt: new Date().toISOString(),
        chatKey: `telegram/bot:${status}`,
        parts: [{ type: "text", text: status }],
      });
      const entry = outbox
        .listChatOutboxItems(agentDir)
        .find(({ item }) => item.payload.chatKey === `telegram/bot:${status}`)!;
      outbox.writeChatOutboxItem(agentDir, {
        ...entry.item,
        status,
        deliveryResult: status === "delivered" ? ["message-1"] : undefined,
        lastError: status === "failed" ? "permanent" : undefined,
      });
      const result = await boot.drainChatOutbox(
        { bots: [] },
        agentDir,
        h,
        { warn() {} },
        { chatKey: entry.item.payload.chatKey, itemId: entry.item.id },
      );
      assert.equal(result[0].status, status);
    }

    outbox.enqueueChatOutboxPayload(agentDir, {
      createdAt: new Date().toISOString(),
      chatKey: "telegram/bot:ambiguous",
      parts: [{ type: "text", text: "ambiguous" }],
    });
    const ambiguous = outbox
      .listChatOutboxItems(agentDir)
      .find(({ item }) => item.payload.chatKey === "telegram/bot:ambiguous")!;
    outbox.writeChatOutboxItem(agentDir, {
      ...ambiguous.item,
      status: "sending",
      attempts: 1,
      leaseUntil: "2020-01-01T00:00:00.000Z",
      nextAttemptAt: "2020-01-01T00:00:00.000Z",
      dispatchStartedAt: "2020-01-01T00:00:00.000Z",
    });
    const recovered = await boot.drainChatOutbox(
      {
        bots: [{ platform: "telegram", selfId: "bot", sendMessage() {} }],
      },
      agentDir,
      h,
      { warn() {} },
      { chatKey: "telegram/bot:ambiguous", itemId: ambiguous.item.id },
    );
    assert.equal(recovered[0].status, "delivered");
    assert.equal(recovered[0].deliveryUnconfirmed, true);
  });
});

test("chat boot reconciles only committed final and error post-delivery records", async () => {
  await withTempDir(async (agentDir) => {
    messageStore.saveChatMessage(agentDir, {
      chatKey: "telegram/bot:processed",
      platform: "telegram",
      botId: "bot",
      chatId: "processed",
      messageId: "inbound-processed",
      role: "user",
      receivedAt: new Date().toISOString(),
      text: "question",
    });
    const committedId = outbox.enqueueChatOutboxPayload(
      agentDir,
      {
        createdAt: new Date().toISOString(),
        chatKey: "telegram/bot:processed",
        sessionFile: "sessions/processed.jsonl",
        parts: [{ type: "text", text: "answer" }],
      },
      {
        deliveryKind: "final",
        postDelivery: {
          markProcessed: {
            chatKey: "telegram/bot:processed",
            messageId: "inbound-processed",
            bindSession: false,
          },
        },
      },
    );
    const committed = outbox.readChatOutboxItemById(
      agentDir,
      committedId,
    )!.item;
    outbox.writeChatOutboxItem(agentDir, {
      ...committed,
      status: "delivered",
      deliveredAt: new Date().toISOString(),
    });
    assert.equal(boot.reconcileCommittedChatOutboxProcessing(agentDir), 1);
    assert.ok(
      messageStore.getChatMessage(
        agentDir,
        "telegram/bot:processed",
        "inbound-processed",
      )?.processedAt,
    );

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
