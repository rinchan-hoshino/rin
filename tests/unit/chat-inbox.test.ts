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
    db.prepare("SELECT COUNT(*) AS value FROM turns").get().value,
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
    BEFORE INSERT ON turns
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
    db.prepare("SELECT COUNT(*) AS value FROM turns").get().value,
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

test("chat inbox claim is unique and fenced through retry ownership", async () => {
  const agentDir = await tempDir();
  const { item } = inbox.enqueueChatInboxItem(agentDir, input());
  const first = inbox.claimChatInboxItem(agentDir, item.itemId, {
    leaseMs: 10,
    nowMs: 1000,
  });
  assert.ok(first);
  assert.equal(inbox.claimChatInboxItem(agentDir, item.itemId), null);

  const restored = inbox.restoreProcessingChatInboxItems(agentDir, {
    nowMs: 1011,
  });
  assert.equal(restored.length, 1);
  const second = inbox.claimChatInboxItem(agentDir, item.itemId, {
    nowMs: 1012,
  });
  assert.ok(second);
  assert.notEqual(second.ownerEpoch, first.ownerEpoch);
  assert.equal(
    inbox.completeClaimedChatInboxItem(agentDir, first, {
      disposition: "actionable",
    }),
    false,
  );
  assert.equal(
    inbox.completeClaimedChatInboxItem(agentDir, second, {
      disposition: "actionable",
    }),
    true,
  );
  assert.equal(inbox.getChatInboxItem(agentDir, item.itemId).state, "terminal");
});

test("chat inbox admission is write-once across retry ownership", async () => {
  const agentDir = await tempDir();
  const { item } = inbox.enqueueChatInboxItem(agentDir, input());
  const claim = inbox.claimChatInboxItem(agentDir, item.itemId);
  assert.throws(
    () =>
      inbox.commitClaimedChatInboxAdmission(agentDir, claim, {
        state: "actionable",
        decision: {
          version: 1,
          kind: "message",
          decision: { allow: true },
        },
        submission: {
          version: 1,
          chatKey: "telegram/other:chat",
          incomingMessageId: claim.messageId,
          text: "wrong chat",
          attachments: [],
          promptMeta: { chatKey: "telegram/other:chat", sentAt: 1234 },
        },
      }),
    /chat_inbox_admission_identity_mismatch/,
  );
  const actionable = inbox.commitClaimedChatInboxAdmission(agentDir, claim, {
    state: "actionable",
    decision: {
      version: 1,
      kind: "message",
      decision: {
        allow: true,
        chatKey: claim.chatKey,
        chatType: "private",
      },
    },
    submission: {
      version: 1,
      chatKey: claim.chatKey,
      incomingMessageId: claim.messageId,
      text: "frozen prompt",
      attachments: [],
      promptMeta: { chatKey: claim.chatKey, sentAt: 1234 },
    },
  });
  assert.equal(actionable?.state, "actionable");
  assert.equal(actionable?.submission?.text, "frozen prompt");

  const db = database.openChatDatabase(agentDir);
  assert.equal(
    db.prepare("SELECT disposition FROM messages WHERE message_id = 'm1'").get()
      .disposition,
    "actionable",
  );
  const hashes = db
    .prepare(
      "SELECT admission_json, admission_hash, submission_json, submission_hash " +
        "FROM turns WHERE turn_id = ?",
    )
    .get(item.itemId);
  assert.deepEqual(
    {
      decision: inbox.getChatInboxItem(agentDir, item.itemId).admission
        .decisionIntegrity,
      submission: inbox.getChatInboxItem(agentDir, item.itemId).admission
        .submissionIntegrity,
    },
    { decision: "valid", submission: "valid" },
  );
  for (const invalidHash of [null, "mismatch"]) {
    db.prepare("UPDATE turns SET submission_hash = ? WHERE turn_id = ?").run(
      invalidHash,
      item.itemId,
    );
    assert.equal(
      inbox.getChatInboxItem(agentDir, item.itemId).admission
        .submissionIntegrity,
      "invalid",
    );
  }
  db.prepare("UPDATE turns SET submission_hash = ? WHERE turn_id = ?").run(
    hashes.submission_hash,
    item.itemId,
  );
  for (const invalidHash of [null, "mismatch"]) {
    db.prepare("UPDATE turns SET admission_hash = ? WHERE turn_id = ?").run(
      invalidHash,
      item.itemId,
    );
    assert.equal(
      inbox.getChatInboxItem(agentDir, item.itemId).admission.decisionIntegrity,
      "invalid",
    );
  }
  db.prepare("UPDATE turns SET admission_hash = ? WHERE turn_id = ?").run(
    hashes.admission_hash,
    item.itemId,
  );
  for (const column of ["admission_json", "submission_json"]) {
    db.prepare(
      `UPDATE turns SET ${column} = ' ' || ${column} WHERE turn_id = ?`,
    ).run(item.itemId);
    const integrity = inbox.getChatInboxItem(agentDir, item.itemId).admission;
    assert.equal(
      column === "admission_json"
        ? integrity.decisionIntegrity
        : integrity.submissionIntegrity,
      "invalid",
    );
    db.prepare(`UPDATE turns SET ${column} = ? WHERE turn_id = ?`).run(
      column === "admission_json"
        ? hashes.admission_json
        : hashes.submission_json,
      item.itemId,
    );
  }
  inbox.requeueClaimedChatInboxItem(agentDir, claim, { delayMs: 0 });
  inbox.enqueueChatInboxItem(agentDir, {
    ...input(),
    session: { ...input().session, content: "changed duplicate" },
  });
  const next = inbox.claimChatInboxItem(agentDir, item.itemId);
  assert.equal(next.session.content, "content m1");
  assert.equal(
    inbox.commitClaimedChatInboxAdmission(agentDir, claim, {
      state: "record_only",
      decision: {
        version: 1,
        kind: "policy_rejected",
        decision: { allow: false },
      },
    }),
    null,
  );
  const preserved = inbox.commitClaimedChatInboxAdmission(agentDir, next, {
    state: "record_only",
    decision: {
      version: 1,
      kind: "policy_rejected",
      decision: { allow: false },
    },
  });
  assert.equal(preserved?.state, "actionable");
  assert.equal(preserved?.submission?.text, "frozen prompt");
  assert.equal(
    inbox.getChatInboxItem(agentDir, item.itemId).admission.state,
    "actionable",
  );
});

test("chat inbox retry state and attempts are transactional", async () => {
  const agentDir = await tempDir();
  const { item } = inbox.enqueueChatInboxItem(agentDir, input());
  const first = inbox.claimChatInboxItem(agentDir, item.itemId);
  const pending = inbox.requeueClaimedChatInboxItem(agentDir, first, {
    delayMs: 0,
    error: "temporary",
  });
  assert.equal(pending.state, "pending");
  assert.equal(pending.lastError, "temporary");
  const second = inbox.claimChatInboxItem(agentDir, item.itemId);
  assert.equal(second.attemptCount, 2);
  const failed = inbox.failClaimedChatInboxItem(agentDir, second, "fatal");
  assert.equal(failed.state, "failed");
  assert.equal(failed.lastError, "fatal");
});

test("durably admitted inbox work remains pending after retry limit", async () => {
  const agentDir = await tempDir();
  const { item } = inbox.enqueueChatInboxItem(
    agentDir,
    input("accepted-retry-limit"),
  );
  const claim = inbox.claimChatInboxItem(agentDir, item.itemId);
  inbox.commitClaimedChatInboxAdmission(agentDir, claim, {
    state: "actionable",
    decision: {
      version: 1,
      kind: "message",
      decision: { allow: true },
    },
    submission: {
      version: 1,
      chatKey: claim.chatKey,
      incomingMessageId: claim.messageId,
      text: "recover me",
      attachments: [],
      promptMeta: { chatKey: claim.chatKey, sentAt: 1234 },
    },
  });
  const db = database.openChatDatabase(agentDir);
  db.prepare(`UPDATE turns SET attempt = 5 WHERE turn_id = ?`).run(
    claim.itemId,
  );

  const pending = inboxDrain.requeueClaimedChatInboxJob(
    agentDir,
    { envelope: { ...claim, attemptCount: 5 } },
    "still recovering",
  );
  assert.equal(pending.state, "pending");
  assert.equal(pending.lastError, "still recovering");
  assert.equal(inbox.getChatInboxItem(agentDir, item.itemId).state, "pending");
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
    inbox.restoreProcessingChatInboxItems(agentDir, { nowMs: 1101 }).length,
    0,
  );
  assert.equal(
    inbox.restoreProcessingChatInboxItems(agentDir, { nowMs: 1151 }).length,
    1,
  );
});

test("chat generation supersedes old pending and running turns while preserving /new", async () => {
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
    "superseded",
  );
  assert.equal(
    inbox.getChatInboxItem(agentDir, oldRunningItem.itemId).state,
    "superseded",
  );
  assert.equal(inbox.getChatInboxItem(agentDir, reset.itemId).state, "running");
  assert.equal(
    inbox.getChatInboxItem(agentDir, arrivedDuringReset.itemId).state,
    "pending",
  );
  assert.equal(
    database
      .openChatDatabase(agentDir)
      .prepare("SELECT generation FROM turns WHERE turn_id = ?")
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
      .prepare("SELECT generation FROM turns WHERE turn_id = ?")
      .get(next.itemId).generation,
    1,
  );
});

test("chat inbox runtime recovery never synthesizes turns for pre-atomic accepted messages", async () => {
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
    inbox.restoreProcessingChatInboxItems(agentDir, {
      nowMs: Date.parse("2026-07-14T01:01:00.000Z"),
    }),
    [],
  );
  assert.deepEqual(inbox.listPendingChatInboxItems(agentDir), []);
  assert.equal(
    database
      .openChatDatabase(agentDir)
      .prepare("SELECT COUNT(*) AS count FROM turns")
      .get().count,
    0,
  );
});

test("chat inbox drain requeues a reclaimed lease while the old controller still owns it", async () => {
  const agentDir = await tempDir();
  const item = inbox.enqueueChatInboxItem(agentDir, input("reclaimed")).item;
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
  const current = inbox.getChatInboxItem(agentDir, item.itemId);
  assert.equal(current.state, "pending");
  assert.match(current.lastError, /chat_inbound_still_owned/);
  assert.ok(Date.parse(current.nextAttemptAt) > Date.now());
});

test("chat inbox drain does not claim a turn whose durable session conflicts with the active session", async () => {
  const agentDir = await tempDir();
  const item = inbox.enqueueChatInboxItem(
    agentDir,
    input("session-conflict"),
  ).item;
  database
    .openChatDatabase(agentDir)
    .prepare("UPDATE turns SET execution_session_file = ? WHERE turn_id = ?")
    .run("managed/chat/owned-session.jsonl", item.itemId);
  const jobs = [];
  const drain = inboxDrain.createChatInboxDrain({
    agentDir,
    getController: () => ({
      conflictsWithActiveSession: () => true,
      ownsInboundMessage: () => false,
    }),
    isInboundMessageProcessed: () => false,
    enqueueClaimedInboxItem: (job) => jobs.push(job),
    hasActiveChatKeyWorker: () => false,
  });

  await drain.drainChatInboxOnce();

  assert.deepEqual(jobs, []);
  const current = database
    .openChatDatabase(agentDir)
    .prepare("SELECT state, attempt FROM turns WHERE turn_id = ?")
    .get(item.itemId);
  assert.deepEqual(current, { state: "pending", attempt: 0 });
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
  assert.match(source, /FROM turns/);
});
