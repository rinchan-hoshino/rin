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
const { saveChatMessage } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js"))
    .href
);

test("chat inbox enqueues a durable inbound envelope keyed by chat and message id", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-inbox-"));
  const session = {
    platform: "onebot",
    selfId: "1",
    channelId: "private:2",
    userId: "2",
    messageId: "m1",
    timestamp: Date.now(),
    content: "hello",
    stripped: { content: "hello" },
    author: { name: "tester" },
  };
  const elements = [{ type: "text", attrs: { content: "hello" } }];

  const { item } = inbox.enqueueChatInboxItem(agentDir, {
    chatKey: "onebot/1:private:2",
    messageId: "m1",
    session,
    elements,
  });
  const files = inbox.listPendingChatInboxFiles(agentDir);

  assert.equal(files.length, 1);
  const loaded = inbox.readChatInboxItem(files[0]);
  assert.equal(loaded.itemId, item.itemId);
  assert.equal(loaded.chatKey, "onebot/1:private:2");
  assert.equal(loaded.messageId, "m1");
  assert.deepEqual(loaded.elements, elements);
});

test("chat inbox preserves normalized mention routing hints needed for queued group turns", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-inbox-"));
  const session = {
    platform: "telegram",
    selfId: "1",
    guildId: "g1",
    channelId: "-100123",
    userId: "owner-1",
    messageId: "m-mention",
    timestamp: Date.now(),
    content: "@rin hello",
    stripped: { content: "hello", appel: true },
  };
  const elements = [{ type: "text", attrs: { content: "hello" } }];

  inbox.enqueueChatInboxItem(agentDir, {
    chatKey: "telegram/1:-100123",
    messageId: "m-mention",
    session,
    elements,
  });
  const [filePath] = inbox.listPendingChatInboxFiles(agentDir);
  const loaded = inbox.readChatInboxItem(filePath);
  const restored = inbox.restoreChatInboxSession({
    ...loaded,
    session: {
      ...loaded.session,
      stripped: { content: loaded.session?.stripped?.content },
    },
  });

  assert.equal(loaded.routing?.mentionLike, true);
  assert.equal(loaded.routing?.chatType, "group");
  assert.equal(loaded.session?.stripped?.content, "hello");
  assert.equal(loaded.session?.stripped?.appel, undefined);
  assert.equal(restored.stripped?.appel, true);
});

test("chat inbox restore backfills routing hints without clobbering existing session metadata", () => {
  const bot = { id: "bot-demo" };
  const restored = inbox.restoreChatInboxSession(
    {
      version: 1,
      itemId: "item-1",
      chatKey: "telegram/1:-100123",
      messageId: "m-route",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attemptCount: 0,
      routing: {
        chatType: "group",
        isDirect: false,
        mentionLike: true,
        text: "routing text",
        userId: "routing-user",
        nickname: "Routing Nick",
        chatName: "Routing Chat",
        replyToMessageId: "routing-reply",
      },
      session: {
        userId: "session-user",
        stripped: { content: "session text", extra: true },
        quote: { messageId: "session-reply", keep: "yes" },
        author: { name: "Session Nick", role: "member" },
        channelName: "Session Chat",
      },
      elements: [],
    },
    bot,
  );

  assert.equal(restored.bot, bot);
  assert.equal(restored.isDirect, false);
  assert.equal(restored.userId, "session-user");
  assert.deepEqual(restored.stripped, {
    content: "session text",
    extra: true,
    appel: true,
  });
  assert.deepEqual(restored.quote, {
    messageId: "session-reply",
    keep: "yes",
  });
  assert.deepEqual(restored.author, {
    name: "Session Nick",
    role: "member",
  });
  assert.equal(restored.channelName, "Session Chat");
});

test("chat inbox restores stranded processing envelopes back to pending on startup", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-inbox-"));
  const session = {
    platform: "telegram",
    selfId: "1",
    channelId: "2",
    userId: "3",
    messageId: "m-processing",
    timestamp: Date.now(),
    content: "hello again",
    stripped: { content: "hello again" },
  };
  const elements = [{ type: "text", attrs: { content: "hello again" } }];

  inbox.enqueueChatInboxItem(agentDir, {
    chatKey: "telegram/1:2",
    messageId: "m-processing",
    session,
    elements,
  });
  const [pendingPath] = inbox.listPendingChatInboxFiles(agentDir);
  const claimedPath = inbox.claimChatInboxFile(agentDir, pendingPath);
  assert.equal(inbox.listPendingChatInboxFiles(agentDir).length, 0);
  assert.equal(inbox.listProcessingChatInboxFiles(agentDir).length, 1);

  const restored = inbox.restoreProcessingChatInboxFiles(agentDir);
  assert.equal(restored.length, 1);
  assert.equal(inbox.listProcessingChatInboxFiles(agentDir).length, 0);
  const [restoredPath] = inbox.listPendingChatInboxFiles(agentDir);
  const restoredItem = inbox.readChatInboxItem(restoredPath);
  assert.equal(restoredItem.messageId, "m-processing");
  assert.ok(restoredPath.endsWith(`${restoredItem.itemId}.json`));
  assert.ok(claimedPath.endsWith(`${restoredItem.itemId}.json`));
});

test("chat inbox keeps fresh processing envelopes until they become stale", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-inbox-"));
  const session = {
    platform: "telegram",
    selfId: "1",
    channelId: "2",
    userId: "3",
    messageId: "m-fresh-processing",
    timestamp: Date.now(),
    content: "still running",
    stripped: { content: "still running" },
  };
  const elements = [{ type: "text", attrs: { content: "still running" } }];

  inbox.enqueueChatInboxItem(agentDir, {
    chatKey: "telegram/1:2",
    messageId: "m-fresh-processing",
    session,
    elements,
  });
  const [pendingPath] = inbox.listPendingChatInboxFiles(agentDir);
  const claimedPath = inbox.claimChatInboxFile(agentDir, pendingPath);
  const claimed = inbox.readChatInboxItem(claimedPath);

  const fresh = inbox.restoreProcessingChatInboxFiles(agentDir, {
    staleMs: 60_000,
    nowMs: Date.parse(claimed.updatedAt) + 30_000,
  });
  assert.equal(fresh.length, 0);
  assert.equal(inbox.listProcessingChatInboxFiles(agentDir).length, 1);

  const stale = inbox.restoreProcessingChatInboxFiles(agentDir, {
    staleMs: 60_000,
    nowMs: Date.parse(claimed.updatedAt) + 61_000,
  });
  assert.equal(stale.length, 1);
  assert.equal(inbox.listProcessingChatInboxFiles(agentDir).length, 0);
  assert.equal(inbox.listPendingChatInboxFiles(agentDir).length, 1);
});

test("chat inbox restores processing envelopes without inspecting delivered replies", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-inbox-"));
  const chatKey = "telegram/1:2";
  const sessionFile = path.join(agentDir, "sessions", "chat.jsonl");
  const session = {
    platform: "telegram",
    selfId: "1",
    channelId: "2",
    userId: "3",
    messageId: "m-delivered",
    timestamp: Date.now(),
    content: "hello again",
    stripped: { content: "hello again" },
  };
  const elements = [{ type: "text", attrs: { content: "hello again" } }];

  inbox.enqueueChatInboxItem(agentDir, {
    chatKey,
    messageId: "m-delivered",
    session,
    elements,
  });
  saveChatMessage(agentDir, {
    chatKey,
    platform: "telegram",
    botId: "1",
    chatId: "2",
    chatType: "private",
    messageId: "m-delivered",
    role: "user",
    receivedAt: new Date().toISOString(),
    text: "hello again",
    acceptedAt: new Date().toISOString(),
    sessionFile,
  });
  saveChatMessage(agentDir, {
    chatKey,
    platform: "telegram",
    botId: "1",
    chatId: "2",
    chatType: "private",
    messageId: "assistant-visible",
    role: "assistant",
    replyToMessageId: "m-delivered",
    receivedAt: new Date().toISOString(),
    processedAt: new Date().toISOString(),
    text: "visible reply",
    sessionFile,
  });
  const [pendingPath] = inbox.listPendingChatInboxFiles(agentDir);
  inbox.claimChatInboxFile(agentDir, pendingPath);

  const restored = inbox.restoreProcessingChatInboxFiles(agentDir);

  assert.equal(restored.length, 1);
  assert.equal(inbox.listProcessingChatInboxFiles(agentDir).length, 0);
  assert.equal(inbox.listPendingChatInboxFiles(agentDir).length, 1);
});

test("chat inbox restores processing envelopes without inspecting interim replies", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-inbox-"));
  const chatKey = "telegram/1:2";
  const sessionFile = path.join(agentDir, "sessions", "chat.jsonl");
  const session = {
    platform: "telegram",
    selfId: "1",
    channelId: "2",
    userId: "3",
    messageId: "m-interim",
    timestamp: Date.now(),
    content: "hello again",
    stripped: { content: "hello again" },
  };
  const elements = [{ type: "text", attrs: { content: "hello again" } }];

  inbox.enqueueChatInboxItem(agentDir, {
    chatKey,
    messageId: "m-interim",
    session,
    elements,
  });
  saveChatMessage(agentDir, {
    chatKey,
    platform: "telegram",
    botId: "1",
    chatId: "2",
    chatType: "private",
    messageId: "m-interim",
    role: "user",
    receivedAt: new Date().toISOString(),
    text: "hello again",
    acceptedAt: new Date().toISOString(),
    sessionFile,
  });
  saveChatMessage(agentDir, {
    chatKey,
    platform: "telegram",
    botId: "1",
    chatId: "2",
    chatType: "private",
    messageId: "assistant-interim",
    role: "assistant",
    replyToMessageId: "m-interim",
    receivedAt: new Date().toISOString(),
    processedAt: new Date().toISOString(),
    text: "··· visible interim",
    sessionFile,
  });
  const [pendingPath] = inbox.listPendingChatInboxFiles(agentDir);
  inbox.claimChatInboxFile(agentDir, pendingPath);

  const restored = inbox.restoreProcessingChatInboxFiles(agentDir);

  assert.equal(restored.length, 1);
  assert.equal(inbox.listProcessingChatInboxFiles(agentDir).length, 0);
  assert.equal(inbox.listPendingChatInboxFiles(agentDir).length, 1);
});

test("chat inbox restores processing envelopes without inspecting later /new boundaries", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-inbox-"));
  const chatKey = "onebot/1:private:2";
  const session = {
    platform: "onebot",
    selfId: "1",
    channelId: "private:2",
    userId: "2",
    messageId: "m-partial-command",
    timestamp: Date.parse("2026-05-09T03:22:19.000Z"),
    content: "/ne",
    stripped: { content: "/ne" },
  };
  const elements = [{ type: "text", attrs: { content: "/ne" } }];

  inbox.enqueueChatInboxItem(agentDir, {
    chatKey,
    messageId: "m-partial-command",
    session,
    elements,
  });
  saveChatMessage(agentDir, {
    chatKey,
    platform: "onebot",
    botId: "1",
    chatId: "private:2",
    chatType: "private",
    messageId: "m-partial-command",
    role: "user",
    receivedAt: "2026-05-09T03:22:19.000Z",
    text: "/ne",
  });
  saveChatMessage(agentDir, {
    chatKey,
    platform: "onebot",
    botId: "1",
    chatId: "private:2",
    chatType: "private",
    messageId: "m-new",
    role: "user",
    receivedAt: "2026-05-09T03:22:20.000Z",
    acceptedAt: "2026-05-09T03:22:21.000Z",
    processedAt: "2026-05-09T03:22:21.000Z",
    text: "/new",
  });
  const [pendingPath] = inbox.listPendingChatInboxFiles(agentDir);
  inbox.claimChatInboxFile(agentDir, pendingPath);

  const restored = inbox.restoreProcessingChatInboxFiles(agentDir);

  assert.equal(restored.length, 1);
  assert.equal(inbox.listProcessingChatInboxFiles(agentDir).length, 0);
  assert.equal(inbox.listPendingChatInboxFiles(agentDir).length, 1);
});

test("chat inbox restores stranded items after only a working notice", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-inbox-"));
  const chatKey = "onebot/1:private:2";
  const session = {
    platform: "onebot",
    selfId: "1",
    channelId: "private:2",
    userId: "2",
    messageId: "m-working",
    timestamp: Date.now(),
    content: "hello again",
    stripped: { content: "hello again" },
  };
  const elements = [{ type: "text", attrs: { content: "hello again" } }];

  inbox.enqueueChatInboxItem(agentDir, {
    chatKey,
    messageId: "m-working",
    session,
    elements,
  });
  saveChatMessage(agentDir, {
    chatKey,
    platform: "onebot",
    botId: "1",
    chatId: "private:2",
    chatType: "private",
    messageId: "assistant-working",
    role: "assistant",
    replyToMessageId: "m-working",
    receivedAt: new Date().toISOString(),
    processedAt: new Date().toISOString(),
    text: "Working...",
  });
  const [pendingPath] = inbox.listPendingChatInboxFiles(agentDir);
  inbox.claimChatInboxFile(agentDir, pendingPath);

  const restored = inbox.restoreProcessingChatInboxFiles(agentDir);

  assert.equal(restored.length, 1);
  assert.equal(inbox.listProcessingChatInboxFiles(agentDir).length, 0);
  assert.equal(inbox.listPendingChatInboxFiles(agentDir).length, 1);
});

test("chat inbox restores processing envelopes without inspecting previous working notices", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-inbox-"));
  const chatKey = "onebot/1:private:2";
  const session = {
    platform: "onebot",
    selfId: "1",
    channelId: "private:2",
    userId: "2",
    messageId: "m-previous-working",
    timestamp: Date.now(),
    content: "hello again",
    stripped: { content: "hello again" },
  };
  const elements = [{ type: "text", attrs: { content: "hello again" } }];

  inbox.enqueueChatInboxItem(agentDir, {
    chatKey,
    messageId: "m-previous-working",
    session,
    elements,
  });
  saveChatMessage(agentDir, {
    chatKey,
    platform: "onebot",
    botId: "1",
    chatId: "private:2",
    chatType: "private",
    messageId: "assistant-previous-working",
    role: "assistant",
    replyToMessageId: "m-previous-working",
    receivedAt: new Date().toISOString(),
    processedAt: new Date().toISOString(),
    text: "Working……",
  });
  const [pendingPath] = inbox.listPendingChatInboxFiles(agentDir);
  inbox.claimChatInboxFile(agentDir, pendingPath);

  const restored = inbox.restoreProcessingChatInboxFiles(agentDir);

  assert.equal(restored.length, 1);
  assert.equal(inbox.listProcessingChatInboxFiles(agentDir).length, 0);
  assert.equal(inbox.listPendingChatInboxFiles(agentDir).length, 1);
});

test("chat inbox can claim, restore, and reschedule a queued envelope", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-inbox-"));
  const session = {
    platform: "telegram",
    selfId: "1",
    channelId: "2",
    userId: "3",
    messageId: "m2",
    timestamp: Date.now(),
    content: "hello again",
    stripped: { content: "hello again" },
  };
  const elements = [{ type: "text", attrs: { content: "hello again" } }];

  const { item } = inbox.enqueueChatInboxItem(agentDir, {
    chatKey: "telegram/1:2",
    messageId: "m2",
    session,
    elements,
  });
  const [filePath] = inbox.listPendingChatInboxFiles(agentDir);
  const claimedPath = inbox.claimChatInboxFile(agentDir, filePath);
  const claimed = inbox.readChatInboxItem(claimedPath);
  assert.equal(claimed.itemId, item.itemId);

  inbox.restoreChatInboxFile(agentDir, claimedPath, claimed);
  const [restoredPath] = inbox.listPendingChatInboxFiles(agentDir);
  const restored = inbox.readChatInboxItem(restoredPath);
  assert.equal(restored.itemId, item.itemId);

  const reClaimedPath = inbox.claimChatInboxFile(agentDir, restoredPath);
  const reClaimed = inbox.readChatInboxItem(reClaimedPath);
  const next = inbox.requeueChatInboxFile(agentDir, reClaimedPath, reClaimed, {
    delayMs: 4000,
    error: "temporary_failure",
  });
  const [rescheduledPath] = inbox.listPendingChatInboxFiles(agentDir);
  const rescheduled = inbox.readChatInboxItem(rescheduledPath);
  assert.equal(rescheduled.attemptCount, 1);
  assert.equal(rescheduled.lastError, "temporary_failure");
  assert.equal(rescheduled.itemId, next.item.itemId);
  assert.ok(Date.parse(rescheduled.nextAttemptAt) > Date.now());

  const rescheduledClaimPath = inbox.claimChatInboxFile(
    agentDir,
    rescheduledPath,
  );
  const rescheduledClaim = inbox.readChatInboxItem(rescheduledClaimPath);
  const retried = inbox.requeueChatInboxFile(
    agentDir,
    rescheduledClaimPath,
    rescheduledClaim,
    {
      delayMs: 0,
    },
  );
  const retriedItem = inbox.readChatInboxItem(retried.filePath);
  assert.equal(retriedItem.attemptCount, 2);
  assert.equal(retriedItem.lastError, undefined);
  assert.ok(Date.parse(retriedItem.nextAttemptAt) <= Date.now() + 1000);
});

test("chat inbox moves failed envelopes into failed storage with updated metadata", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-inbox-"));
  const session = {
    platform: "telegram",
    selfId: "1",
    channelId: "2",
    userId: "3",
    messageId: "m-fail",
    timestamp: Date.now(),
    content: "hello failure",
    stripped: { content: "hello failure" },
  };
  const elements = [{ type: "text", attrs: { content: "hello failure" } }];

  const { item } = inbox.enqueueChatInboxItem(agentDir, {
    chatKey: "telegram/1:2",
    messageId: "m-fail",
    session,
    elements,
  });
  const [filePath] = inbox.listPendingChatInboxFiles(agentDir);
  const claimedPath = inbox.claimChatInboxFile(agentDir, filePath);
  const claimed = inbox.readChatInboxItem(claimedPath);
  const delayed = inbox.requeueChatInboxFile(agentDir, claimedPath, claimed, {
    delayMs: 5000,
    error: "temporary_failure",
  });
  const delayedClaimPath = inbox.claimChatInboxFile(agentDir, delayed.filePath);
  const delayedClaim = inbox.readChatInboxItem(delayedClaimPath);
  const failed = inbox.failChatInboxFile(
    agentDir,
    delayedClaimPath,
    delayedClaim,
    "fatal_failure",
  );

  assert.equal(inbox.listPendingChatInboxFiles(agentDir).length, 0);
  assert.equal(inbox.listProcessingChatInboxFiles(agentDir).length, 0);
  assert.equal(failed.item.itemId, item.itemId);
  assert.equal(failed.item.attemptCount, 2);
  assert.equal(failed.item.lastError, "fatal_failure");
  assert.equal(failed.item.nextAttemptAt, undefined);
  assert.ok(failed.filePath.endsWith(`${item.itemId}.json`));

  const loaded = inbox.readChatInboxItem(failed.filePath);
  assert.equal(loaded.itemId, item.itemId);
  assert.equal(loaded.attemptCount, 2);
  assert.equal(loaded.lastError, "fatal_failure");
  assert.equal(loaded.nextAttemptAt, undefined);
});

test("chat inbox processing restore honors a per-drain limit", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-inbox-"));
  for (let index = 0; index < 3; index += 1) {
    inbox.enqueueChatInboxItem(agentDir, {
      chatKey: `telegram/1:${index}`,
      messageId: `restore-limit-${index}`,
      session: {
        platform: "telegram",
        selfId: "1",
        channelId: String(index),
        userId: "3",
        messageId: `restore-limit-${index}`,
        timestamp: Date.now(),
        content: "hello",
        stripped: { content: "hello" },
      },
      elements: [{ type: "text", attrs: { content: "hello" } }],
    });
  }

  for (const filePath of inbox.listPendingChatInboxFiles(agentDir)) {
    inbox.claimChatInboxFile(agentDir, filePath);
  }

  const restored = inbox.restoreProcessingChatInboxFiles(agentDir, {
    limit: 2,
  });

  assert.equal(restored.length, 2);
  assert.equal(inbox.listPendingChatInboxFiles(agentDir).length, 2);
  assert.equal(inbox.listProcessingChatInboxFiles(agentDir).length, 1);
});

test("chat inbox drain caps claimed work while backlog remains pending", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-inbox-"));
  for (let index = 0; index < 5; index += 1) {
    inbox.enqueueChatInboxItem(agentDir, {
      chatKey: `telegram/1:${index}`,
      messageId: `claim-limit-${index}`,
      session: {
        platform: "telegram",
        selfId: "1",
        channelId: String(index),
        userId: "3",
        messageId: `claim-limit-${index}`,
        timestamp: Date.now(),
        content: "hello",
        stripped: { content: "hello" },
      },
      elements: [{ type: "text", attrs: { content: "hello" } }],
    });
  }

  const claimedJobs = [];
  const drain = inboxDrain.createChatInboxDrain({
    agentDir,
    getController: () => ({ claimsInboundMessage: () => false }),
    isInboundMessageProcessed: () => false,
    enqueueClaimedInboxItem: (job) => claimedJobs.push(job),
    maxClaimsPerDrain: 10,
    maxActiveChatKeyWorkers: 2,
    activeChatKeyWorkerCount: () => claimedJobs.length,
  });

  await drain.drainChatInboxOnce();

  assert.equal(claimedJobs.length, 2);
  assert.equal(inbox.listPendingChatInboxFiles(agentDir).length, 3);
  assert.equal(inbox.listProcessingChatInboxFiles(agentDir).length, 2);
});

test("chat inbox retry helper isolates envelopes after repeated failures", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-inbox-"));
  const { item } = inbox.enqueueChatInboxItem(agentDir, {
    chatKey: "telegram/1:retry",
    messageId: "retry-limit",
    session: {
      platform: "telegram",
      selfId: "1",
      channelId: "retry",
      userId: "3",
      messageId: "retry-limit",
      timestamp: Date.now(),
      content: "hello",
      stripped: { content: "hello" },
    },
    elements: [{ type: "text", attrs: { content: "hello" } }],
  });
  const [filePath] = inbox.listPendingChatInboxFiles(agentDir);
  const claimedPath = inbox.claimChatInboxFile(agentDir, filePath);
  const envelope = {
    ...inbox.readChatInboxItem(claimedPath),
    attemptCount: 4,
  };

  inboxDrain.requeueClaimedChatInboxJob(
    agentDir,
    { claimedPath, envelope },
    "still failing",
  );

  const failedPath = path.join(
    agentDir,
    "data",
    "chat",
    "inbox",
    "failed",
    `${item.itemId}.json`,
  );
  const failed = inbox.readChatInboxItem(failedPath);

  assert.equal(inbox.listPendingChatInboxFiles(agentDir).length, 0);
  assert.equal(inbox.listProcessingChatInboxFiles(agentDir).length, 0);
  assert.equal(failed.itemId, item.itemId);
  assert.equal(failed.attemptCount, 5);
  assert.equal(failed.lastError, "still failing");
});

test("chat inbox claim refreshes old envelopes before stale recovery checks", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-inbox-"));
  inbox.enqueueChatInboxItem(agentDir, {
    chatKey: "telegram/1:claim-refresh",
    messageId: "claim-refresh",
    session: {
      platform: "telegram",
      selfId: "1",
      channelId: "claim-refresh",
      userId: "3",
      messageId: "claim-refresh",
      timestamp: Date.now(),
      content: "hello",
      stripped: { content: "hello" },
    },
    elements: [{ type: "text", attrs: { content: "hello" } }],
  });
  const [pendingPath] = inbox.listPendingChatInboxFiles(agentDir);
  const oldItem = {
    ...inbox.readChatInboxItem(pendingPath),
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
  await fs.writeFile(pendingPath, `${JSON.stringify(oldItem)}\n`);

  const claimedPath = inbox.claimChatInboxFile(agentDir, pendingPath);
  const claimed = inbox.readChatInboxItem(claimedPath);
  const restored = inbox.restoreProcessingChatInboxFiles(agentDir, {
    staleMs: 10 * 60 * 1000,
    nowMs: Date.now(),
  });

  assert.notEqual(claimed.updatedAt, oldItem.updatedAt);
  assert.equal(restored.length, 0);
  assert.equal(inbox.listProcessingChatInboxFiles(agentDir).length, 1);
});
