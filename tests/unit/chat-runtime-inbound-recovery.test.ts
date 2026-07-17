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
const recovery = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat-runtime", "inbound-recovery.js"),
  ).href
);
const messageStore = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js"))
    .href
);
const inboundNormalization = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat", "inbound-normalization.js"),
  ).href
);

test("inbound normalization preserves a provider-native recovery cursor", () => {
  const stored = inboundNormalization.buildInboundStoredChatMessageInput(
    {
      platform: "onebot",
      selfId: "bot-1",
      channelId: "chat-1",
      messageId: "opaque-message-id",
      providerCursor: "12345",
      timestamp: 1000,
      userId: "owner-1",
      content: "hello",
    },
    [],
  );

  assert.equal(stored?.providerCursor, "12345");
});

test("inbound recovery heads use the latest durable user message per bot chat", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-recovery-heads-"),
  );
  try {
    const save = (input: Record<string, any>) =>
      messageStore.saveChatMessage(agentDir, {
        role: "user",
        platform: "discord",
        botId: "bot-1",
        chatId: "channel-1",
        chatKey: "discord/bot-1:channel-1",
        receivedAt: "2026-07-13T00:00:00.000Z",
        ...input,
      });
    save({ messageId: "100", platformTimestamp: 1000 });
    save({ messageId: "200", platformTimestamp: 2000 });
    save({ messageId: "9", platformTimestamp: 5000 });
    save({ messageId: "10", platformTimestamp: 5000 });
    save({
      messageId: "assistant-300",
      role: "assistant",
      platformTimestamp: 3000,
    });
    save({
      messageId: "other-bot",
      botId: "bot-2",
      chatKey: "discord/bot-2:channel-1",
      platformTimestamp: 4000,
    });
    const legacyRecordsDir = path.join(
      agentDir,
      "data",
      "chat",
      "message-store",
      "records",
      "legacy",
    );
    await fs.mkdir(legacyRecordsDir, { recursive: true });
    await fs.writeFile(
      path.join(legacyRecordsDir, "legacy-record.json"),
      JSON.stringify({
        version: 1,
        recordKey: "legacy-record",
        role: "user",
        platform: "discord",
        botId: "bot-1",
        chatId: "channel-1",
        chatKey: "discord:channel-1",
        messageId: "legacy-message",
        receivedAt: "2026-06-28T00:00:00.000Z",
        platformTimestamp: 6000,
      }),
    );

    assert.deepEqual(
      recovery.listInboundRecoveryHeads(agentDir, "discord", "bot-1"),
      [
        {
          chatKey: "discord/bot-1:channel-1",
          chatId: "channel-1",
          messageId: "10",
          platformTimestamp: 5000,
        },
      ],
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

async function createRecoveryLeaseFixture() {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-recovery-lease-"),
  );
  const save = (chatId: string, messageId: string, timestamp: number) =>
    messageStore.saveChatMessage(agentDir, {
      role: "user",
      platform: "discord",
      botId: "bot-1",
      chatId,
      chatKey: `discord/bot-1:${chatId}`,
      messageId,
      receivedAt: new Date(timestamp).toISOString(),
      platformTimestamp: timestamp,
    });
  save("healthy", "healthy-1", 1000);
  save("stale", "stale-1", 1000);
  return { agentDir, save };
}

const recoveryLeasePolicy = {
  minFailures: 3,
  minFailureAgeMs: 24 * 60 * 60 * 1000,
  retryBaseMs: 60 * 60 * 1000,
  retryMaxMs: 8 * 60 * 60 * 1000,
  maxRetirements: 100,
};

test("inbound recovery retires a repeatedly failing checkpoint through a shared lease", async () => {
  const { agentDir } = await createRecoveryLeaseFixture();
  try {
    const attempts: string[] = [];
    const runAt = async (nowMs: number) =>
      await recovery.recoverInboundHeads(
        agentDir,
        "discord",
        "bot-1",
        async (head: any) => {
          attempts.push(head.chatId);
          if (head.chatId === "stale") throw new Error("history unavailable");
          return [];
        },
        { nowMs, policy: recoveryLeasePolicy },
      );

    const first = await runAt(0);
    assert.deepEqual(first.failures, [
      "discord/bot-1:stale:history unavailable",
    ]);
    assert.deepEqual(first.retired, []);

    attempts.length = 0;
    const deferred = await runAt(30 * 60 * 1000);
    assert.deepEqual(attempts, ["healthy"]);
    assert.deepEqual(deferred.deferred, ["discord/bot-1:stale"]);

    await runAt(60 * 60 * 1000);
    await runAt(3 * 60 * 60 * 1000);
    const retired = await runAt(24 * 60 * 60 * 1000);
    assert.deepEqual(retired.retired, ["discord/bot-1:stale"]);
    assert.deepEqual(
      recovery
        .listInboundRecoveryHeads(agentDir, "discord", "bot-1")
        .map((head: any) => head.chatId),
      ["healthy"],
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("inbound recovery backs off without aging checkpoints when the whole scope fails", async () => {
  const { agentDir } = await createRecoveryLeaseFixture();
  try {
    let attempts = 0;
    const run = async (nowMs: number) =>
      await recovery.recoverInboundHeads(
        agentDir,
        "discord",
        "bot-1",
        async () => {
          attempts += 1;
          throw new Error("adapter history unavailable");
        },
        { nowMs, policy: recoveryLeasePolicy },
      );
    const failed = await run(0);
    assert.equal(failed.scopeHealthy, false);
    assert.deepEqual(failed.retired, []);
    assert.equal(attempts, 2);

    const deferred = await run(30 * 60 * 1000);
    assert.equal(attempts, 2);
    assert.deepEqual(deferred.deferred, [
      "discord/bot-1:healthy",
      "discord/bot-1:stale",
    ]);

    await run(25 * 60 * 60 * 1000);
    const heads = recovery.listInboundRecoveryHeads(
      agentDir,
      "discord",
      "bot-1",
      { includeLeaseState: true },
    );
    assert.equal(heads.length, 2);
    assert.ok(heads.every((head: any) => head.failureCount === 0));
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("a lone due failure is local when another checkpoint is deferred", async () => {
  const { agentDir } = await createRecoveryLeaseFixture();
  try {
    await recovery.recoverInboundHeads(
      agentDir,
      "discord",
      "bot-1",
      async (head: any) => {
        if (head.chatId === "stale") throw new Error("stale failed");
        return [];
      },
      { nowMs: 0, policy: recoveryLeasePolicy },
    );
    const result = await recovery.recoverInboundHeads(
      agentDir,
      "discord",
      "bot-1",
      async () => {
        throw new Error("only due head failed");
      },
      { nowMs: 30 * 60 * 1000, policy: recoveryLeasePolicy },
    );
    assert.equal(result.scopeHealthy, true);
    const heads = recovery.listInboundRecoveryHeads(
      agentDir,
      "discord",
      "bot-1",
      { includeLeaseState: true },
    );
    assert.equal(
      heads.find((head: any) => head.chatId === "healthy")?.failureCount,
      1,
    );
    assert.equal(
      heads.find((head: any) => head.chatId === "stale")?.failureCount,
      1,
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("inbound recovery excludes a global outage from an existing lease age", async () => {
  const { agentDir } = await createRecoveryLeaseFixture();
  try {
    const run = async (
      nowMs: number,
      behavior: "local_failure" | "global_failure",
    ) =>
      await recovery.recoverInboundHeads(
        agentDir,
        "discord",
        "bot-1",
        async (head: any) => {
          if (behavior === "global_failure" || head.chatId === "stale") {
            throw new Error("history unavailable");
          }
          return [];
        },
        { nowMs, policy: recoveryLeasePolicy },
      );

    await run(0, "local_failure");
    await run(60 * 60 * 1000, "local_failure");
    const global = await run(3 * 60 * 60 * 1000, "global_failure");
    assert.equal(global.scopeHealthy, false);
    const resumed = await run(27 * 60 * 60 * 1000, "local_failure");
    assert.deepEqual(resumed.retired, []);
    const stale = recovery
      .listInboundRecoveryHeads(agentDir, "discord", "bot-1", {
        includeLeaseState: true,
      })
      .find((head: any) => head.chatId === "stale");
    assert.equal(stale?.failureCount, 3);
    assert.equal(stale?.firstFailedAt, "1970-01-02T00:00:00.000Z");
    assert.equal(stale?.pausedAt, undefined);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("inbound recovery CAS preserves a cursor advanced during a failed attempt", async () => {
  const { agentDir, save } = await createRecoveryLeaseFixture();
  try {
    await recovery.recoverInboundHeads(
      agentDir,
      "discord",
      "bot-1",
      async (head: any) => {
        if (head.chatId === "stale") {
          save("stale", "stale-2", 2000);
          throw new Error("old cursor failed");
        }
        return [];
      },
      { nowMs: 0, policy: recoveryLeasePolicy },
    );
    const stale = recovery
      .listInboundRecoveryHeads(agentDir, "discord", "bot-1", {
        includeLeaseState: true,
      })
      .find((head: any) => head.chatId === "stale");
    assert.equal(stale?.messageId, "stale-2");
    assert.equal(stale?.failureCount, 0);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("inbound recovery success clears an existing failure lease", async () => {
  const { agentDir } = await createRecoveryLeaseFixture();
  try {
    const run = async (nowMs: number, staleFails: boolean) =>
      await recovery.recoverInboundHeads(
        agentDir,
        "discord",
        "bot-1",
        async (head: any) => {
          if (staleFails && head.chatId === "stale") {
            throw new Error("history unavailable");
          }
          return [];
        },
        { nowMs, policy: recoveryLeasePolicy },
      );
    await run(0, true);
    await run(60 * 60 * 1000, false);
    const result = await run(26 * 60 * 60 * 1000, true);
    assert.deepEqual(result.retired, []);
    const stale = recovery
      .listInboundRecoveryHeads(agentDir, "discord", "bot-1", {
        includeLeaseState: true,
      })
      .find((head: any) => head.chatId === "stale");
    assert.equal(stale?.failureCount, 1);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("inbound recovery success wins a concurrent retirement failure", async () => {
  const { agentDir } = await createRecoveryLeaseFixture();
  try {
    const failStale = async (head: any) => {
      if (head.chatId === "stale") throw new Error("history unavailable");
      return [];
    };
    await recovery.recoverInboundHeads(
      agentDir,
      "discord",
      "bot-1",
      failStale,
      { nowMs: 0, policy: recoveryLeasePolicy },
    );
    await recovery.recoverInboundHeads(
      agentDir,
      "discord",
      "bot-1",
      failStale,
      { nowMs: 60 * 60 * 1000, policy: recoveryLeasePolicy },
    );

    let releaseSuccess: () => void = () => {};
    const waitForFailure = new Promise<void>((resolve) => {
      releaseSuccess = resolve;
    });
    const successRun = recovery.recoverInboundHeads(
      agentDir,
      "discord",
      "bot-1",
      async (head: any) => {
        if (head.chatId === "stale") await waitForFailure;
        return [];
      },
      { nowMs: 25 * 60 * 60 * 1000, policy: recoveryLeasePolicy },
    );
    await new Promise((resolve) => setImmediate(resolve));
    const failedRetirement = await recovery.recoverInboundHeads(
      agentDir,
      "discord",
      "bot-1",
      async (head: any) => {
        if (head.chatId === "stale") throw new Error("history unavailable");
        return [];
      },
      { nowMs: 25 * 60 * 60 * 1000, policy: recoveryLeasePolicy },
    );
    assert.deepEqual(failedRetirement.retired, []);
    releaseSuccess();
    await successRun;

    const stale = recovery
      .listInboundRecoveryHeads(agentDir, "discord", "bot-1", {
        includeLeaseState: true,
      })
      .find((head: any) => head.chatId === "stale");
    assert.equal(stale?.failureCount, 0);
    assert.equal(stale?.nextAttemptAt, undefined);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("inbound recovery status remains degraded while a lease is deferred", () => {
  const bot: any = {};
  const warnings: string[] = [];
  recovery.applyInboundRecoveryResult(
    bot,
    { warn: (message: string) => warnings.push(message) },
    {
      failures: [],
      deferred: ["discord/bot-1:stale"],
      retired: [],
    },
  );
  assert.deepEqual(bot.inboundRecovery, {
    status: "degraded",
    failures: ["discord/bot-1:stale:recovery_deferred"],
  });
  assert.deepEqual(warnings, []);

  recovery.applyInboundRecoveryResult(
    bot,
    {},
    {
      failures: [],
      deferred: [],
      retired: [],
    },
  );
  assert.deepEqual(bot.inboundRecovery, { status: "ready" });
});

test("inbound recovery gate buffers startup ingress until explicitly opened", () => {
  const gate = new recovery.InboundRecoveryGate();
  assert.equal(gate.buffer("before"), false);

  gate.begin();
  assert.equal(gate.buffer("recovered-window"), true);
  assert.deepEqual(gate.drain(), ["recovered-window"]);
  assert.equal(gate.hasPending(), false);

  assert.equal(gate.buffer("during-drain"), true);
  assert.equal(gate.hasPending(), true);
  assert.throws(() => gate.open(), /still has buffered messages/);
  assert.deepEqual(gate.drain(), ["during-drain"]);
  gate.open();
  assert.equal(gate.isBuffering(), false);
  assert.equal(gate.buffer("after"), false);
});

test("inbound recovery merges provider-ordered history before buffered live duplicates", () => {
  const session = (messageId: string, timestamp: number) => ({
    platform: "onebot",
    selfId: "bot-1",
    channelId: "chat-1",
    messageId,
    timestamp,
  });
  const recovered = [session("old", 1000), session("same", 2000)];
  const bufferedLive = [session("same", 2000), session("new", 2000)];

  assert.deepEqual(
    recovery
      .mergeInboundRecoverySessions(recovered, bufferedLive)
      .map((item: any) => item.messageId),
    ["old", "same", "new"],
  );
});
