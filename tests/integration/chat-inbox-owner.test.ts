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
const inbox = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "inbox.js")).href
);
const { openChatDatabase } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "database.js")).href
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

test("prepared incoming is committed as one actionable durable inbox item", async () => {
  const agentDir = await tempDir();
  const prepared = inbox.enqueueChatInboxItem(agentDir, {
    ...input("prepared-incoming"),
    preparedAdmission: {
      decision: { allow: true, reason: "prepared_incoming_message" },
      submission: {
        version: 1,
        chatKey: "telegram/1:2",
        text: "scheduled text",
        attachments: [],
        promptMeta: {},
        incomingMessageId: "prepared-incoming",
        replyToMessageId: "prepared-incoming",
        receivedAt: new Date().toISOString(),
      },
    },
  });
  assert.equal(prepared.item.admission.state, "actionable");
  assert.equal(
    prepared.item.admission.submission.incomingMessageId,
    "prepared-incoming",
  );
  const claim = inbox.claimChatInboxItem(agentDir, prepared.item.itemId);
  assert.ok(claim);
  assert.equal(claim.admission.state, "actionable");
  await fs.rm(agentDir, { recursive: true, force: true });
});

test("chat inbox drain completion helpers own success and failure finalization", async () => {
  const agentDir = await tempDir();
  inbox.enqueueChatInboxItem(agentDir, input("helper-success"));
  const successItem = inbox.listPendingChatInboxItems(agentDir)[0];
  const successClaim = inbox.claimChatInboxItem(agentDir, successItem.itemId);
  assert.ok(successClaim);
  assert.equal(
    inboxDrain.finalizeClaimedChatInboxJob(
      agentDir,
      { envelope: successClaim },
      { terminalKind: "complete", disposition: "actionable" },
    ),
    true,
  );

  inbox.enqueueChatInboxItem(agentDir, input("helper-error"));
  const errorItem = inbox
    .listPendingChatInboxItems(agentDir)
    .find((item) => item.messageId === "helper-error");
  assert.ok(errorItem);
  const errorClaim = inbox.claimChatInboxItem(agentDir, errorItem.itemId);
  assert.ok(errorClaim);
  assert.throws(
    () =>
      inboxDrain.finalizeClaimedChatInboxJob(
        agentDir,
        { envelope: errorClaim },
        { errorMessage: " owner failure " },
      ),
    /owner failure/,
  );

  for (const [messageId, finalize] of [
    ["helper-default-complete", false],
    ["helper-default-finalize", true],
  ]) {
    inbox.enqueueChatInboxItem(agentDir, input(messageId));
    const item = inbox
      .listPendingChatInboxItems(agentDir)
      .find((candidate) => candidate.messageId === messageId);
    assert.ok(item);
    const claim = inbox.claimChatInboxItem(agentDir, item.itemId);
    assert.ok(claim);
    assert.equal(
      finalize
        ? inboxDrain.finalizeClaimedChatInboxJob(
            agentDir,
            { envelope: claim },
            undefined,
          )
        : inboxDrain.completeClaimedChatInboxJob(agentDir, {
            envelope: claim,
          }),
      true,
    );
  }
});

test("chat inbox drain handles processed, inactive, and denied pending work", async () => {
  for (const mode of ["processed", "inactive", "denied"]) {
    const agentDir = await tempDir();
    inbox.enqueueChatInboxItem(agentDir, input(`drain-${mode}`));
    const queued = [];
    const drain = inboxDrain.createChatInboxDrain({
      agentDir,
      getController: () => ({
        ownsInboundMessage: () => false,
        hasActiveTurn: () => mode !== "inactive",
      }),
      isInboundMessageProcessed: () => mode === "processed",
      enqueueClaimedInboxItem: (job) => queued.push(job),
      hasActiveChatKeyWorker: () => mode !== "processed",
      canClaimDuringActiveChatKeyWorker: () => mode !== "denied",
    });
    await drain.drainChatInboxOnce();
    assert.equal(queued.length, 0);
  }
});

test("chat inbox durable admission validates ownership and corrupted projections", async () => {
  const agentDir = await tempDir();
  assert.throws(
    () => inbox.buildChatInboxItem({ ...input("invalid-chat"), chatKey: "" }),
    /chat_inbox_chatKey_required/,
  );
  assert.throws(
    () =>
      inbox.buildChatInboxItem({
        ...input("invalid-chat"),
        chatKey: "invalid",
      }),
    /invalid_chatKey/,
  );
  assert.throws(
    () => inbox.buildChatInboxItem({ ...input("missing-id"), messageId: "" }),
    /chat_inbox_messageId_required/,
  );
  assert.deepEqual(
    inbox.buildChatInboxItem({ ...input("no-elements"), elements: null })
      .elements,
    [],
  );
  const explicitItem = inbox.buildChatInboxItem({
    ...input("explicit-fields"),
    routing: { trust: "owner" },
    session: { platform: "telegram" },
    elements: [{ type: "text", attrs: { content: "explicit" } }],
    receivedAt: "2026-08-03T00:00:00.000Z",
    priority: Number.NaN,
    attemptCount: 2,
    attemptDelayMs: Number.NaN,
    createdAt: "2026-08-03T00:00:01.000Z",
    updatedAt: "2026-08-03T00:00:02.000Z",
    revision: 3,
    state: "running",
    nextAttemptAt: "2026-08-03T00:00:03.000Z",
    startedAt: "2026-08-03T00:00:04.000Z",
    lastError: "owner error",
    ownerEpoch: "epoch-explicit",
  });
  assert.equal(
    inbox.restoreChatInboxSession(explicitItem, null).platform,
    "telegram",
  );
  assert.deepEqual(
    inbox.restoreChatInboxSession({ session: null }, { id: 1 }),
    {
      bot: { id: 1 },
    },
  );
  assert.deepEqual(
    inbox.restoreChatInboxElements(explicitItem),
    explicitItem.elements,
  );
  const enrichedSession = inbox.restoreChatInboxSession(
    {
      session: {},
      routing: {
        text: "owner text",
        chatName: "owner channel",
        nickname: "owner name",
        mentionLike: true,
      },
    },
    null,
  );
  assert.equal(enrichedSession.channelName, "owner channel");
  assert.equal(enrichedSession.author.name, "owner name");
  assert.equal(enrichedSession.stripped.content, "owner text");
  assert.equal(enrichedSession.stripped.appel, true);

  inbox.enqueueChatInboxItem(agentDir, input("admission-owner"));
  const pending = inbox.listPendingChatInboxItems(agentDir)[0];
  const claim = inbox.claimChatInboxItem(agentDir, pending.itemId);
  assert.ok(claim);
  const decision = {
    version: 1,
    kind: "unmatched_command",
    chatKey: claim.chatKey,
    messageId: claim.messageId,
    name: "unknown",
    trust: "owner",
    respond: true,
  };
  assert.throws(
    () =>
      inbox.commitClaimedChatInboxAdmission(
        agentDir,
        {},
        {
          state: "actionable",
          decision,
        },
      ),
    /chat_inbox_claim_required/,
  );
  assert.throws(
    () =>
      inbox.commitClaimedChatInboxAdmission(agentDir, claim, {
        state: "actionable",
        decision: { ...decision, messageId: "mismatch" },
      }),
    /chat_inbox_admission_identity_mismatch/,
  );
  const admission = inbox.commitClaimedChatInboxAdmission(agentDir, claim, {
    state: "actionable",
    decision,
    submission: {
      version: 1,
      chatKey: claim.chatKey,
      text: "frozen prompt",
      attachments: [],
      promptMeta: {},
      incomingMessageId: claim.messageId,
    },
  });
  assert.equal(admission.decisionIntegrity, "valid");
  assert.equal(admission.submissionIntegrity, "valid");
  assert.equal(
    inbox.commitClaimedChatInboxAdmission(agentDir, claim, {
      state: "actionable",
      decision,
    }).state,
    "actionable",
  );
  assert.equal(
    inbox.commitClaimedChatInboxAdmission(
      agentDir,
      { ...claim, ownerEpoch: "stale" },
      { state: "actionable", decision },
    ),
    null,
  );
  assert.equal(
    inbox.isChatInboxItemDurablyActionable(agentDir, claim.itemId),
    true,
  );

  openChatDatabase(agentDir)
    .prepare(
      `UPDATE inbox_jobs
       SET admission_state = 'actionable', admission_json = '{', admission_hash = 'x',
           submission_json = '[]', submission_hash = 'x',
           routing_json = '{', session_json = '[]', elements_json = '{'
       WHERE turn_id = ?`,
    )
    .run(claim.itemId);
  const corrupted = inbox.getChatInboxItem(agentDir, claim.itemId);
  assert.ok(corrupted);
  assert.equal(corrupted.admission.stateIntegrity, "valid");
  assert.equal(corrupted.admission.decisionIntegrity, "invalid");
  assert.equal(corrupted.admission.submissionIntegrity, "invalid");
  assert.deepEqual(corrupted.routing, {});
  assert.deepEqual(corrupted.session, {});
  assert.deepEqual(corrupted.elements, []);

  assert.deepEqual(inbox.restoreChatInboxSession({ session: null }, null), {});
  assert.deepEqual(inbox.restoreChatInboxElements({ elements: null }), []);
});

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

test("chat inbox reconciliation atomically fences the previous executor", async () => {
  const agentDir = await tempDir();
  const { item } = inbox.enqueueChatInboxItem(agentDir, input("m-reclaim"));
  const nowMs = Date.now();
  const first = inbox.claimChatInboxItem(agentDir, item.itemId, {
    nowMs,
    leaseMs: 100,
  });
  const reclaimed = inbox.reclaimRunningChatInboxItem(agentDir, first, {
    nowMs: nowMs + 10,
    force: true,
  });
  assert.equal(reclaimed.itemId, item.itemId);
  assert.notEqual(reclaimed.ownerEpoch, first.ownerEpoch);
  assert.equal(reclaimed.attemptCount, first.attemptCount + 1);
  assert.equal(
    inbox.touchClaimedChatInboxItem(agentDir, first, { nowMs: nowMs + 20 }),
    false,
  );
  assert.equal(
    inbox.completeClaimedChatInboxItem(agentDir, first, {
      terminalKind: "complete",
    }),
    false,
  );
  assert.equal(
    inbox.touchClaimedChatInboxItem(agentDir, reclaimed, {
      nowMs: nowMs + 20,
    }),
    true,
  );
});

test("chat inbox lease expiry never creates a business terminal", async () => {
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
  const current = inbox.getChatInboxItem(agentDir, item.itemId);
  assert.equal(current.state, "running");
  assert.equal(current.lastError, undefined);
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

  assert.deepEqual(inbox.listRunningChatInboxItems(agentDir), []);
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

test("chat inbox drain leaves an inbound already owned by its controller pending", async () => {
  const agentDir = await tempDir();
  const owned = inbox.enqueueChatInboxItem(
    agentDir,
    input("already-owned", "discord/1:owned"),
  ).item;
  const jobs = [];
  const drain = inboxDrain.createChatInboxDrain({
    agentDir,
    getController: () => ({ ownsInboundMessage: () => true }),
    isInboundMessageProcessed: () => false,
    enqueueClaimedInboxItem: (job) => jobs.push(job),
    hasActiveChatKeyWorker: () => false,
  });

  await drain.drainChatInboxOnce();

  assert.deepEqual(jobs, []);
  assert.equal(inbox.getChatInboxItem(agentDir, owned.itemId).state, "pending");
});

test("chat inbox drain lets a reset command interrupt an active recovering chat", async () => {
  const agentDir = await tempDir();
  const abort = inbox.enqueueChatInboxItem(
    agentDir,
    input("abort-recovery", "discord/1:recovering"),
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
    isChatKeyBlocked: () => true,
    hasActiveChatKeyWorker: () => true,
    isPriorityDuringActiveChatKeyWorker: () => true,
    canClaimDuringActiveChatKeyWorker: () => true,
  });

  await drain.drainChatInboxOnce();

  assert.deepEqual(
    jobs.map((job) => job.envelope.messageId),
    ["abort-recovery"],
  );
  assert.equal(inbox.getChatInboxItem(agentDir, abort.itemId).state, "running");
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
