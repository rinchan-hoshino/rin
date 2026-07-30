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
const inbox = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "inbox.js")).href
);
const inboxDrain = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "inbox-drain.js"))
    .href
);
const database = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "database.js")).href
);
const messageStore = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js"))
    .href
);

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-inbox-sqlite-"));
}

function input(messageId = "m1", chatKey = "telegram/1:2") {
  const chatId = chatKey.slice(chatKey.indexOf(":") + 1);
  return {
    chatKey,
    messageId,
    session: {
      platform: chatKey.slice(0, chatKey.indexOf("/")),
      selfId: "1",
      channelId: chatId,
      userId: "owner",
      messageId,
      timestamp: Date.now(),
      content: `content ${messageId}`,
      stripped: { content: `content ${messageId}` },
      author: { name: "Owner" },
    },
    elements: [{ type: "text", attrs: { content: `content ${messageId}` } }],
  };
}

test("chat inbox atomically commits the inbound message and one durable turn", async () => {
  const agentDir = await tempDir();
  const first = inbox.enqueueChatInboxItem(agentDir, input());
  const second = inbox.enqueueChatInboxItem(agentDir, input());

  assert.equal(first.item.itemId, second.item.itemId);
  assert.equal(inbox.listPendingChatInboxItems(agentDir).length, 1);
  assert.equal(
    messageStore.getChatMessage(agentDir, "telegram/1:2", "m1")?.duplicateCount,
    1,
  );
  const db = database.openChatDatabase(agentDir);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS value FROM inbox_jobs").get().value,
    1,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS value FROM messages").get().value,
    1,
  );
});

test("chat inbox transaction rolls back the message when turn commit crashes", async () => {
  const agentDir = await tempDir();
  const db = database.openChatDatabase(agentDir);
  db.exec(`
    CREATE TRIGGER crash_turn_insert
    BEFORE INSERT ON inbox_jobs
    BEGIN
      SELECT RAISE(ABORT, 'injected_turn_crash');
    END;
  `);
  assert.throws(
    () => inbox.enqueueChatInboxItem(agentDir, input()),
    /injected_turn_crash/,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS value FROM messages").get().value,
    0,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS value FROM inbox_jobs").get().value,
    0,
  );
});

test("chat inbox duplicate delivery cannot replace an active owner", async () => {
  const agentDir = await tempDir();
  const { item } = inbox.enqueueChatInboxItem(agentDir, input());
  const claim = inbox.claimChatInboxItem(agentDir, item.itemId);
  assert.ok(claim?.ownerEpoch);

  inbox.enqueueChatInboxItem(agentDir, {
    ...input(),
    session: { ...input().session, content: "richer duplicate" },
  });
  const current = inbox.getChatInboxItem(agentDir, item.itemId);
  assert.equal(current.state, "running");
  assert.equal(current.ownerEpoch, claim.ownerEpoch);
  assert.equal(current.attemptCount, 1);
});

test("chat inbox duplicate delivery cannot revive a terminal turn", async () => {
  const agentDir = await tempDir();
  const { item } = inbox.enqueueChatInboxItem(agentDir, input());
  const claim = inbox.claimChatInboxItem(agentDir, item.itemId);
  assert.ok(claim);
  assert.equal(
    inbox.completeClaimedChatInboxItem(agentDir, claim, {
      terminalKind: "completed",
      disposition: "actionable",
    }),
    true,
  );

  const duplicate = inbox.enqueueChatInboxItem(agentDir, input());

  assert.equal(duplicate.item.itemId, item.itemId);
  assert.equal(duplicate.item.state, "terminal");
  assert.equal(inbox.listPendingChatInboxItems(agentDir).length, 0);
  assert.equal(
    messageStore.getChatMessage(agentDir, "telegram/1:2", "m1")?.duplicateCount,
    1,
  );
});

test("chat inbox heartbeat extends only the current claim", async () => {
  const agentDir = await tempDir();
  const { item } = inbox.enqueueChatInboxItem(agentDir, input());
  const claim = inbox.claimChatInboxItem(agentDir, item.itemId, {
    nowMs: 1000,
    leaseMs: 100,
  });
  assert.equal(
    inbox.touchClaimedChatInboxItem(agentDir, claim, {
      nowMs: 1050,
      leaseMs: 100,
    }),
    true,
  );
  assert.equal(
    inbox.interruptProcessingChatInboxItems(agentDir, { nowMs: 1101 }).length,
    0,
  );
  assert.equal(
    inbox.interruptProcessingChatInboxItems(agentDir, { nowMs: 1151 }).length,
    1,
  );
  assert.equal(inbox.getChatInboxItem(agentDir, item.itemId).state, "failed");
});

test("chat generation interrupts old pending and running inbox_jobs while preserving /new", async () => {
  const agentDir = await tempDir();
  const oldPending = inbox.enqueueChatInboxItem(
    agentDir,
    input("old-pending"),
  ).item;
  const oldRunningItem = inbox.enqueueChatInboxItem(
    agentDir,
    input("old-running"),
  ).item;
  inbox.claimChatInboxItem(agentDir, oldRunningItem.itemId);
  const reset = inbox.enqueueChatInboxItem(
    agentDir,
    input("reset-command"),
  ).item;
  const resetClaim = inbox.claimChatInboxItem(agentDir, reset.itemId);
  const arrivedDuringReset = inbox.enqueueChatInboxItem(
    agentDir,
    input("arrived-during-reset"),
  ).item;

  const generation = database.advanceChatGeneration(agentDir, "telegram/1:2", {
    preserveInboundMessageId: "reset-command",
  });

  assert.equal(generation.currentGeneration, 1);
  assert.equal(
    inbox.getChatInboxItem(agentDir, oldPending.itemId).state,
    "failed",
  );
  assert.equal(
    inbox.getChatInboxItem(agentDir, oldRunningItem.itemId).state,
    "failed",
  );
  assert.equal(inbox.getChatInboxItem(agentDir, reset.itemId).state, "running");
  assert.equal(
    inbox.getChatInboxItem(agentDir, arrivedDuringReset.itemId).state,
    "pending",
  );
  assert.equal(
    database
      .openChatDatabase(agentDir)
      .prepare("SELECT generation FROM inbox_jobs WHERE turn_id = ?")
      .get(arrivedDuringReset.itemId).generation,
    1,
  );
  assert.equal(
    inbox.completeClaimedChatInboxItem(agentDir, resetClaim, {
      disposition: "actionable",
    }),
    true,
  );
  const next = inbox.enqueueChatInboxItem(agentDir, input("after-reset")).item;
  const db = database.openChatDatabase(agentDir);
  assert.equal(
    db
      .prepare("SELECT generation FROM inbox_jobs WHERE turn_id = ?")
      .get(next.itemId).generation,
    1,
  );
});

test("chat inbox runtime recovery never synthesizes inbox_jobs for pre-atomic accepted messages", async () => {
  const agentDir = await tempDir();
  messageStore.saveChatMessage(agentDir, {
    chatKey: "discord/1:room",
    platform: "discord",
    botId: "1",
    chatId: "room",
    chatType: "group",
    messageId: "accepted-orphan",
    role: "user",
    receivedAt: "2026-07-14T01:00:00.000Z",
    acceptedAt: "2026-07-14T01:00:01.000Z",
    text: "update-owned migration only",
  });

  assert.deepEqual(
    inbox.interruptProcessingChatInboxItems(agentDir, {
      nowMs: Date.parse("2026-07-14T01:01:00.000Z"),
    }),
    [],
  );
  assert.deepEqual(inbox.listPendingChatInboxItems(agentDir), []);
  assert.equal(
    database
      .openChatDatabase(agentDir)
      .prepare("SELECT COUNT(*) AS count FROM inbox_jobs")
      .get().count,
    0,
  );
});

test("chat inbox drain skips rejected active-turn chatter and claims a later command", async () => {
  const agentDir = await tempDir();
  const chatter = inbox.enqueueChatInboxItem(
    agentDir,
    input("chatter", "telegram/1:active"),
  ).item;
  const abort = inbox.enqueueChatInboxItem(
    agentDir,
    input("abort", "telegram/1:active"),
  ).item;
  const jobs = [];
  const drain = inboxDrain.createChatInboxDrain({
    agentDir,
    getController: () => ({
      hasActiveTurn: () => true,
      ownsInboundMessage: () => false,
    }),
    isInboundMessageProcessed: () => false,
    enqueueClaimedInboxItem: (job) => jobs.push(job),
    hasActiveChatKeyWorker: () => true,
    canClaimDuringActiveChatKeyWorker: async (item) =>
      item.messageId === abort.messageId,
  });

  await drain.drainChatInboxOnce();
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && jobs.length < 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.deepEqual(
    jobs.map((job) => job.envelope.messageId),
    ["abort"],
  );
  assert.equal(
    inbox.getChatInboxItem(agentDir, chatter.itemId).state,
    "pending",
  );
  assert.equal(inbox.getChatInboxItem(agentDir, abort.itemId).state, "running");
});

test("chat inbox drain prioritizes reset commands over earlier admissible follow-ups", async () => {
  const agentDir = await tempDir();
  const followUp = inbox.enqueueChatInboxItem(
    agentDir,
    input("follow-up", "telegram/1:active"),
  ).item;
  const abort = inbox.enqueueChatInboxItem(
    agentDir,
    input("abort-priority", "telegram/1:active"),
  ).item;
  const jobs = [];
  const drain = inboxDrain.createChatInboxDrain({
    agentDir,
    getController: () => ({
      hasActiveTurn: () => true,
      ownsInboundMessage: () => false,
    }),
    isInboundMessageProcessed: () => false,
    enqueueClaimedInboxItem: (job) => jobs.push(job),
    hasActiveChatKeyWorker: () => true,
    isPriorityDuringActiveChatKeyWorker: (item) =>
      item.messageId === abort.messageId,
    canClaimDuringActiveChatKeyWorker: async () => true,
  });

  await drain.drainChatInboxOnce();
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && jobs.length < 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.deepEqual(
    jobs.map((job) => job.envelope.messageId),
    ["abort-priority"],
  );
  assert.equal(
    inbox.getChatInboxItem(agentDir, followUp.itemId).state,
    "pending",
  );
  assert.equal(inbox.getChatInboxItem(agentDir, abort.itemId).state, "running");
});

test("chat inbox drain leaves a recovering chat pending while unrelated chats run", async () => {
  const agentDir = await tempDir();
  inbox.enqueueChatInboxItem(agentDir, input("recovering", "discord/1:a"));
  inbox.enqueueChatInboxItem(agentDir, input("ready", "discord/1:b"));
  const jobs = [];
  const drain = inboxDrain.createChatInboxDrain({
    agentDir,
    getController: () => ({ ownsInboundMessage: () => false }),
    isInboundMessageProcessed: () => false,
    enqueueClaimedInboxItem: (job) => jobs.push(job),
    isChatKeyBlocked: (chatKey) => chatKey === "discord/1:a",
    hasActiveChatKeyWorker: () => false,
  });

  await drain.drainChatInboxOnce();

  assert.deepEqual(
    jobs.map((job) => job.envelope.messageId),
    ["ready"],
  );
  assert.deepEqual(
    inbox.listPendingChatInboxItems(agentDir).map((item) => item.messageId),
    ["recovering"],
  );
});

test("chat inbox drain claims unrelated chats concurrently and serializes each chat", async () => {
  const agentDir = await tempDir();
  inbox.enqueueChatInboxItem(agentDir, input("a1", "telegram/1:a"));
  inbox.enqueueChatInboxItem(agentDir, input("a2", "telegram/1:a"));
  inbox.enqueueChatInboxItem(agentDir, input("b1", "telegram/1:b"));
  const jobs = [];
  const drain = inboxDrain.createChatInboxDrain({
    agentDir,
    getController: () => ({ ownsInboundMessage: () => false }),
    isInboundMessageProcessed: () => false,
    enqueueClaimedInboxItem: (job) => jobs.push(job),
    hasActiveChatKeyWorker: (chatKey) =>
      jobs.some((job) => job.envelope.chatKey === chatKey),
  });
  await drain.drainChatInboxOnce();
  assert.deepEqual(jobs.map((job) => job.envelope.messageId).sort(), [
    "a1",
    "b1",
  ]);
  assert.equal(inbox.listPendingChatInboxItems(agentDir).length, 1);
  assert.equal(inbox.listRunningChatInboxItems(agentDir).length, 2);
});

test("chat inbox restore migrates legacy quote metadata into rich text", () => {
  const item = inbox.buildChatInboxItem(input("route"));
  item.routing.mentionLike = true;
  item.routing.replyToMessageId = "routing-reply";
  item.session = {
    ...item.session,
    stripped: { content: "session text", extra: true },
    quote: {
      messageId: "session-reply",
      content: "legacy body must stay lazy",
      keep: true,
    },
  };
  const elements = inbox.restoreChatInboxElements(item);
  const restored = inbox.restoreChatInboxSession(item, { selfId: "1" });
  assert.deepEqual(restored.stripped, {
    content: "session text",
    extra: true,
    appel: true,
  });
  assert.equal(restored.quote, undefined);
  assert.deepEqual(elements[0], {
    type: "quote",
    attrs: { id: "session-reply" },
    children: [],
  });
  assert.deepEqual(elements[0].attrs, { id: "session-reply" });

  delete item.session.quote;
  assert.deepEqual(inbox.restoreChatInboxElements(item)[0], {
    type: "quote",
    attrs: { id: "routing-reply" },
    children: [],
  });
});

test("inbox implementation has no file queue or list-all-message recovery dependency", async () => {
  const source = await fs.readFile(
    path.join(rootDir, "src", "core", "chat", "inbox.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /listChatMessages\s*\(/);
  assert.doesNotMatch(source, /listJsonFiles|writeJsonAtomic|claimFileToDir/);
  assert.match(source, /FROM messages/);
  assert.match(source, /FROM inbox_jobs/);
});
