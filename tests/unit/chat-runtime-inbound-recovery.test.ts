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
