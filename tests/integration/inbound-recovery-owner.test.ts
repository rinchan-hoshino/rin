import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const recovery = await importBuiltModule<
  typeof import("../../src/core/chat-runtime/inbound-recovery.js")
>("dist/core/chat-runtime/inbound-recovery.js");
const messageStore = await importBuiltModule<
  typeof import("../../src/core/chat/message-store.js")
>("dist/core/chat/message-store.js");

async function withAgentDir(run: (agentDir: string) => Promise<void>) {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-inbound-recovery-owner-"),
  );
  try {
    await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

test("inbound recovery gate preserves buffered ordering", () => {
  const gate = new recovery.InboundRecoveryGate<string>();
  assert.equal(gate.isBuffering(), false);
  assert.equal(gate.buffer("closed"), false);
  gate.begin();
  assert.equal(gate.buffer("live"), true);
  gate.prepend([]);
  gate.prepend(["older-1", "older-2"]);
  assert.equal(gate.hasPending(), true);
  assert.deepEqual(gate.drain(), ["older-1", "older-2", "live"]);
  assert.equal(gate.hasPending(), false);
  gate.open();
  assert.equal(gate.isBuffering(), false);

  gate.begin();
  gate.buffer("pending");
  assert.throws(() => gate.open(), /still has buffered messages/);
});

test("inbound recovery heads choose the newest durable user message", async () => {
  await withAgentDir(async (agentDir) => {
    const save = (input: Record<string, unknown>) =>
      messageStore.saveChatMessage(agentDir, {
        role: "user",
        platform: "discord",
        botId: "bot-1",
        chatId: "channel-b",
        chatKey: "discord/bot-1:channel-b",
        messageId: "1",
        receivedAt: "2026-07-16T00:00:00.000Z",
        ...input,
      } as any);

    save({ messageId: "9", platformTimestamp: 5000 });
    save({
      messageId: "10",
      platformTimestamp: 5000,
      providerCursor: " cursor-10 ",
    });
    save({
      chatId: "channel-a",
      chatKey: "discord/bot-1:channel-a",
      messageId: "opaque-z",
      platformTimestamp: 0,
      receivedAt: "2026-07-16T01:00:00.000Z",
    });
    save({
      chatId: "channel-a",
      chatKey: "discord/bot-1:channel-a",
      messageId: "opaque-a",
      platformTimestamp: 0,
      receivedAt: "2026-07-16T01:00:00.000Z",
    });
    save({
      role: "assistant",
      messageId: "assistant",
      platformTimestamp: 9000,
    });
    save({
      platform: "telegram",
      messageId: "other-platform",
      platformTimestamp: 9000,
    });
    save({ botId: "bot-2", messageId: "other-bot", platformTimestamp: 9000 });

    assert.deepEqual(
      recovery.listInboundRecoveryHeads(agentDir, "", "bot-1"),
      [],
    );
    assert.deepEqual(
      recovery.listInboundRecoveryHeads(agentDir, "discord", ""),
      [],
    );
    assert.deepEqual(
      recovery.listInboundRecoveryHeads(agentDir, " discord ", " bot-1 "),
      [
        {
          chatKey: "discord/bot-1:channel-a",
          chatId: "channel-a",
          messageId: "opaque-a",
          platformTimestamp: Date.parse("2026-07-16T01:00:00.000Z"),
        },
        {
          chatKey: "discord/bot-1:channel-b",
          chatId: "channel-b",
          messageId: "10",
          platformTimestamp: 5000,
          providerCursor: "cursor-10",
        },
      ],
    );
  });
});

test("inbound recovery settles successful, failed, deferred, and retired checkpoints", async () => {
  await withAgentDir(async (agentDir) => {
    const saveHead = (chatId: string, messageId: string) =>
      messageStore.saveChatMessage(agentDir, {
        role: "user",
        platform: "discord",
        botId: "bot-1",
        chatId,
        chatKey: `discord/bot-1:${chatId}`,
        messageId,
        receivedAt: "2026-07-16T00:00:00.000Z",
        platformTimestamp: 5_000,
      } as any);
    saveHead("success", "success-message");
    saveHead("retire", "retire-message");

    const nowMs = Date.parse("2026-07-17T00:00:00.000Z");
    const succeeded = await recovery.recoverInboundHeads(
      agentDir,
      " discord ",
      " bot-1 ",
      async (head) => [head.messageId],
      { nowMs, policy: { retryBaseMs: 0, retryMaxMs: 0 } },
    );
    assert.deepEqual(succeeded.recovered.sort(), [
      "retire-message",
      "success-message",
    ]);
    assert.deepEqual(succeeded.failures, []);
    assert.equal(succeeded.scopeHealthy, true);

    const mixed = await recovery.recoverInboundHeads(
      agentDir,
      "discord",
      "bot-1",
      async (head) => {
        if (head.chatId === "retire") throw new Error("history unavailable");
        return [head.chatId];
      },
      {
        nowMs: nowMs + 1,
        policy: {
          minFailures: 1,
          minFailureAgeMs: 0,
          retryBaseMs: 0,
          retryMaxMs: 0,
          maxRetirements: 1,
        },
      },
    );
    assert.deepEqual(mixed.recovered, ["success"]);
    assert.deepEqual(mixed.retired, ["discord/bot-1:retire"]);
    assert.deepEqual(mixed.failures, []);

    const logs: string[] = [];
    const bot: any = {};
    recovery.applyInboundRecoveryResult(
      bot,
      {
        info: (message: string) => logs.push(message),
        warn: (message: string) => logs.push(message),
      },
      {
        failures: ["discord/bot-1:failed:history"],
        deferred: ["discord/bot-1:deferred"],
        retired: mixed.retired,
      },
    );
    assert.equal(bot.inboundRecovery.status, "degraded");
    assert.equal(bot.inboundRecovery.failures.length, 2);
    assert.ok(logs.some((message) => message.includes("retired checkpoints")));
    assert.ok(logs.some((message) => message.includes("degraded failures")));
    recovery.applyInboundRecoveryResult(
      bot,
      {},
      { failures: [], deferred: [], retired: [] },
    );
    assert.deepEqual(bot.inboundRecovery, { status: "ready" });
  });

  await withAgentDir(async (agentDir) => {
    messageStore.saveChatMessage(agentDir, {
      role: "user",
      platform: "discord",
      botId: "bot-1",
      chatId: "outage",
      chatKey: "discord/bot-1:outage",
      messageId: "outage-message",
      receivedAt: "2026-07-16T00:00:00.000Z",
    } as any);
    const nowMs = Date.parse("2026-07-17T00:00:00.000Z");
    const unhealthy = await recovery.recoverInboundHeads(
      agentDir,
      "discord",
      "bot-1",
      async () => {
        throw "provider outage";
      },
      {
        nowMs,
        policy: { retryBaseMs: 1_000, retryMaxMs: 1_000 },
      },
    );
    assert.equal(unhealthy.scopeHealthy, false);
    assert.deepEqual(unhealthy.failures, [
      "discord/bot-1:outage:provider outage",
    ]);
    const [leased] = recovery.listInboundRecoveryHeads(
      agentDir,
      "discord",
      "bot-1",
      { includeLeaseState: true },
    );
    assert.equal(leased.failureCount, 0);
    assert.ok(leased.nextAttemptAt);

    const deferred = await recovery.recoverInboundHeads(
      agentDir,
      "discord",
      "bot-1",
      async () => assert.fail("deferred checkpoint should not run"),
      { nowMs: nowMs + 500 },
    );
    assert.equal(deferred.scopeHealthy, true);
    assert.deepEqual(deferred.deferred, ["discord/bot-1:outage"]);
  });
});

test("inbound recovery merge prefers live duplicates and stable source ordering", () => {
  const recoveredDuplicate = {
    platform: "onebot",
    selfId: "bot-1",
    channelId: "chat-1",
    messageId: "same",
    timestamp: 20,
    source: "recovered",
  };
  const liveDuplicate = { ...recoveredDuplicate, source: "live" };
  const merged = recovery.mergeInboundRecoverySessions(
    [
      { ...recoveredDuplicate, messageId: "early", timestamp: 10 },
      recoveredDuplicate,
      { anonymous: "recovered", timestamp: 20 },
    ],
    [
      liveDuplicate,
      { ...recoveredDuplicate, messageId: "late", timestamp: 30 },
      { anonymous: "live", timestamp: "invalid" },
    ],
  );

  assert.deepEqual(
    merged.map((item: any) => item.messageId || item.anonymous),
    ["live", "early", "same", "recovered", "late"],
  );
  assert.equal(
    merged.find((item: any) => item.messageId === "same")?.source,
    "live",
  );
  assert.deepEqual(
    recovery.mergeInboundRecoverySessions(null as any, null as any),
    [],
  );
});
