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
const outbox = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "chat-outbox.js"))
    .href
);
const boot = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "boot.js")).href
);
const transport = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "transport.js")).href
);
const messageStore = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js"))
    .href
);
const database = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "database.js")).href
);
const inbox = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "inbox.js")).href
);

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-outbox-sqlite-"));
  try {
    await fn(dir);
  } finally {
    database.closeChatDatabase(dir);
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function waitFor(assertion, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return assertion();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

function rejectedDeliveryBeforeDispatch(message) {
  const error = new Error(message);
  const delivery = Promise.reject(error);
  delivery.dispatched = Promise.reject(error);
  return delivery;
}

function payload(text = "hello") {
  return {
    createdAt: new Date().toISOString(),
    chatKey: "telegram/777:1",
    parts: [{ type: "text", text }],
  };
}

function h() {
  return {
    text(content) {
      return { type: "text", attrs: { content } };
    },
  };
}

test("chat outbox persists only in chat.sqlite and requires structured parts", async () => {
  await withTempDir(async (dir) => {
    assert.throws(
      () =>
        outbox.enqueueChatOutboxPayload(dir, {
          chatKey: "telegram/777:1",
          text: "plain",
        }),
      /chat_outbox_invalid_payload/,
    );
    assert.throws(
      () =>
        outbox.enqueueChatOutboxPayload(dir, {
          ...payload("bad"),
          parts: [
            { type: "quote", id: "quoted-message" },
            { type: "text", text: "   " },
          ],
        }),
      /chat_outbox_empty_message/,
    );
    assert.throws(
      () =>
        outbox.enqueueChatOutboxPayload(dir, {
          ...payload("bad"),
          parts: [{ type: "image", path: "/missing/direct-image.png" }],
        }),
      /chat_outbox_media_missing:image/,
    );
    const id = outbox.enqueueChatOutboxPayload(dir, payload());
    assert.equal(outbox.readChatOutboxItemById(dir, id).item.status, "queued");
    assert.equal(outbox.listChatOutboxItems(dir).length, 1);
    await assert.rejects(fs.stat(path.join(dir, "data", "chat", "outbox")));
  });
});

test("chat outbox idempotency commits one logical message", async () => {
  await withTempDir(async (dir) => {
    const options = {
      idempotencyKey: "same logical final",
      deliveryKind: "final",
    };
    const first = outbox.enqueueChatOutboxPayload(
      dir,
      payload("same"),
      options,
    );
    const second = outbox.enqueueChatOutboxPayload(
      dir,
      payload("same"),
      options,
    );
    assert.equal(first, second);
    assert.equal(outbox.listChatOutboxItems(dir).length, 1);
  });
});

test("chat outbox claim is atomic and rejects stale settlement after lease recovery", async () => {
  await withTempDir(async (dir) => {
    const id = outbox.enqueueChatOutboxPayload(dir, payload());
    const first = outbox.claimChatOutboxItem(dir, id, {
      leaseUntil: new Date(1010).toISOString(),
      nowMs: 1000,
    });
    assert.ok(first.ownerEpoch);
    assert.equal(first.claimedFromStatus, "queued");
    assert.equal(
      outbox.claimChatOutboxItem(dir, id, {
        leaseUntil: new Date(1020).toISOString(),
        nowMs: 1001,
      }),
      null,
    );
    const second = outbox.claimChatOutboxItem(dir, id, {
      leaseUntil: new Date(1030).toISOString(),
      nowMs: 1011,
    });
    assert.ok(second);
    assert.equal(second.claimedFromStatus, "sending");
    assert.notEqual(first.ownerEpoch, second.ownerEpoch);
    assert.equal(
      outbox.writeChatOutboxItem(dir, {
        ...first,
        status: "delivered",
        deliveredAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deliveryResult: ["stale"],
      }),
      false,
    );
    assert.equal(
      outbox.writeChatOutboxItem(dir, {
        ...second,
        status: "delivered",
        deliveredAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deliveryResult: ["winner"],
      }),
      true,
    );
    assert.deepEqual(
      outbox.readChatOutboxItemById(dir, id).item.deliveryResult,
      ["winner"],
    );
  });
});

test("terminal outbox transaction rolls back logical ownership when delivery planning crashes", async () => {
  await withTempDir(async (dir) => {
    const inbound = inbox.enqueueChatInboxItem(dir, {
      chatKey: "telegram/777:1",
      messageId: "crash-before-plan",
      session: {
        platform: "telegram",
        selfId: "777",
        channelId: "1",
        userId: "owner",
        messageId: "crash-before-plan",
        timestamp: Date.now(),
        content: "question",
        stripped: { content: "question" },
      },
      elements: [{ type: "text", attrs: { content: "question" } }],
    }).item;
    const claim = inbox.claimChatInboxItem(dir, inbound.itemId);
    const db = database.openChatDatabase(dir);
    db.exec(`
      CREATE TRIGGER crash_delivery_plan
      BEFORE INSERT ON outbox_deliveries
      BEGIN
        SELECT RAISE(ABORT, 'injected_delivery_crash');
      END;
    `);
    assert.throws(
      () =>
        outbox.enqueueChatOutboxPayload(dir, payload("answer"), {
          deliveryKind: "final",
          turnFence: {
            agentDir: dir,
            turnId: claim.itemId,
            chatKey: claim.chatKey,
            messageId: claim.messageId,
            ownerEpoch: claim.ownerEpoch,
            attempt: claim.attemptCount,
          },
          postDelivery: {
            markProcessed: {
              chatKey: "telegram/777:1",
              messageId: "crash-before-plan",
            },
          },
        }),
      /injected_delivery_crash/,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS value FROM outbox").get().value,
      0,
    );
    assert.equal(inbox.getChatInboxItem(dir, inbound.itemId).state, "running");
  });
});

test("stale-owner outbox failure reports superseded without durable settlement", async () => {
  await withTempDir(async (dir) => {
    const id = outbox.enqueueChatOutboxPayload(dir, payload("stale failure"));
    const results = await boot.drainChatOutbox(
      {
        bots: [
          {
            platform: "telegram",
            selfId: "777",
            sendMessage() {
              database
                .openChatDatabase(dir)
                .prepare(
                  `UPDATE outbox
                   SET owner_epoch = 'replacement-owner'
                   WHERE outbox_id = ?`,
                )
                .run(id);
              return rejectedDeliveryBeforeDispatch("stale failure");
            },
          },
        ],
      },
      dir,
      h(),
      { warn() {} },
      { itemId: id },
    );

    assert.equal(results[0].status, "superseded");
    const current = outbox.readChatOutboxItemById(dir, id).item;
    assert.equal(current.status, "sending");
    assert.equal(current.ownerEpoch, "replacement-owner");
    assert.equal(current.deliveryUnconfirmed, undefined);
  });
});

test("chat outbox successful delivery records ordered provider fragments", async () => {
  await withTempDir(async (dir) => {
    const id = outbox.enqueueChatOutboxPayload(dir, payload("split me"));
    const app = {
      bots: [
        {
          platform: "telegram",
          selfId: "777",
          async sendMessage() {
            return ["fragment-1", "fragment-2", "fragment-3"];
          },
        },
      ],
    };
    const results = await boot.drainChatOutbox(app, dir, h(), { warn() {} });
    assert.equal(results[0].status, "dispatched");
    await waitFor(() => {
      assert.equal(
        outbox.readChatOutboxItemById(dir, id).item.status,
        "delivered",
      );
    });
    assert.deepEqual(
      outbox
        .listChatOutboxDeliveries(dir, id)
        .map((item) => [
          item.fragmentIndex,
          item.state,
          item.providerMessageId,
        ]),
      [
        [0, "delivered", "fragment-1"],
        [1, "delivered", "fragment-2"],
        [2, "delivered", "fragment-3"],
      ],
    );
  });
});

test("chat outbox partial delivery is terminal and preserves delivered fragments", async () => {
  await withTempDir(async (dir) => {
    const id = outbox.enqueueChatOutboxPayload(dir, payload("partial"));
    const app = {
      bots: [
        {
          platform: "telegram",
          selfId: "777",
          async sendMessage() {
            throw Object.assign(new Error("chat_delivery_partial:network"), {
              deliveredMessageIds: ["fragment-1"],
              partialDelivery: true,
            });
          },
        },
      ],
    };
    await boot.drainChatOutbox(app, dir, h(), { warn() {} });
    await waitFor(() => {
      assert.equal(
        outbox.readChatOutboxItemById(dir, id).item.status,
        "delivered",
      );
    });
    const item = outbox.readChatOutboxItemById(dir, id).item;
    assert.equal(item.deliveryUnconfirmed, true);
    assert.deepEqual(item.deliveryResult, ["fragment-1"]);
    assert.deepEqual(
      outbox
        .listChatOutboxDeliveries(dir, id)
        .map((delivery) => delivery.state),
      ["delivered", "unconfirmed"],
    );
  });
});

test("chat outbox retries a synchronous pre-dispatch adapter throw", async () => {
  await withTempDir(async (dir) => {
    const id = outbox.enqueueChatOutboxPayload(dir, payload("sync throw"));
    const results = await boot.drainChatOutbox(
      {
        bots: [
          {
            platform: "telegram",
            selfId: "777",
            sendMessage() {
              throw new Error("synchronous pre-io failure");
            },
          },
        ],
      },
      dir,
      h(),
      { warn() {} },
      { itemId: id },
    );
    assert.equal(results[0].status, "queued");
    const queued = outbox.readChatOutboxItemById(dir, id).item;
    assert.equal(queued.status, "queued");
    assert.equal(queued.dispatchStartedAt, undefined);
    assert.equal(queued.deliveryUnconfirmed, undefined);
  });
});

test("chat outbox retries a rejected provider pre-dispatch signal", async () => {
  await withTempDir(async (dir) => {
    const id = outbox.enqueueChatOutboxPayload(dir, payload("dispatch reject"));
    const results = await boot.drainChatOutbox(
      {
        bots: [
          {
            platform: "telegram",
            selfId: "777",
            sendMessage() {
              const delivery = new Promise(() => {});
              delivery.dispatched = Promise.reject(
                new Error("provider rejected before handoff"),
              );
              return delivery;
            },
          },
        ],
      },
      dir,
      h(),
      { warn() {} },
      { itemId: id },
    );
    assert.equal(results[0].status, "queued");
    const queued = outbox.readChatOutboxItemById(dir, id).item;
    assert.equal(queued.status, "queued");
    assert.equal(queued.dispatchStartedAt, undefined);
    assert.equal(queued.deliveryUnconfirmed, undefined);
  });
});

test("chat outbox does not retry rejection without dispatch evidence", async () => {
  await withTempDir(async (dir) => {
    const id = outbox.enqueueChatOutboxPayload(
      dir,
      payload("ambiguous reject"),
    );
    let providerAttempts = 0;
    const app = {
      bots: [
        {
          platform: "telegram",
          selfId: "777",
          async sendMessage() {
            providerAttempts += 1;
            throw new Error("response lost after provider accepted request");
          },
        },
      ],
    };

    await boot.drainChatOutbox(app, dir, h(), { warn() {} }, { itemId: id });
    await boot.drainChatOutbox(app, dir, h(), { warn() {} }, { itemId: id });
    const delivered = outbox.readChatOutboxItemById(dir, id).item;
    assert.equal(providerAttempts, 1);
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.deliveryUnconfirmed, true);
  });
});

test("chat outbox retries confirmed pre-dispatch transient failures", async () => {
  await withTempDir(async (dir) => {
    const firstId = outbox.enqueueChatOutboxPayload(dir, payload("first"));
    const secondId = outbox.enqueueChatOutboxPayload(dir, payload("second"));
    const sends = [];
    const app = {
      bots: [
        {
          platform: "telegram",
          selfId: "777",
          sendMessage(_chatId, content) {
            const text = content[0].attrs.content;
            sends.push(text);
            if (
              text === "first" &&
              sends.filter((item) => item === "first").length === 1
            ) {
              return rejectedDeliveryBeforeDispatch("network down");
            }
            return Promise.resolve([`sent-${text}`]);
          },
        },
      ],
    };
    await boot.drainChatOutbox(app, dir, h(), { warn() {} });
    await waitFor(() => {
      assert.equal(
        outbox.readChatOutboxItemById(dir, firstId).item.status,
        "queued",
      );
      assert.equal(
        outbox.readChatOutboxItemById(dir, secondId).item.status,
        "delivered",
      );
    });
    const first = outbox.readChatOutboxItemById(dir, firstId).item;
    outbox.writeChatOutboxItem(dir, {
      ...first,
      nextAttemptAt: new Date(Date.now() - 1).toISOString(),
    });
    await boot.drainChatOutbox(app, dir, h(), { warn() {} });
    await waitFor(() => {
      assert.equal(
        outbox.readChatOutboxItemById(dir, firstId).item.status,
        "delivered",
      );
    });
    assert.deepEqual(sends, ["first", "second", "first"]);
  });
});

test("terminal outbox commit owns the inbound turn before external delivery", async () => {
  await withTempDir(async (dir) => {
    const inbound = inbox.enqueueChatInboxItem(dir, {
      chatKey: "telegram/777:1",
      messageId: "inbound-final",
      session: {
        platform: "telegram",
        selfId: "777",
        channelId: "1",
        userId: "owner",
        messageId: "inbound-final",
        timestamp: Date.now(),
        content: "question",
        stripped: { content: "question" },
      },
      elements: [{ type: "text", attrs: { content: "question" } }],
    }).item;
    const claim = inbox.claimChatInboxItem(dir, inbound.itemId);
    const id = outbox.enqueueChatOutboxPayload(dir, payload("answer"), {
      deliveryKind: "final",
      turnFence: {
        agentDir: dir,
        turnId: claim.itemId,
        chatKey: claim.chatKey,
        messageId: claim.messageId,
        ownerEpoch: claim.ownerEpoch,
        attempt: claim.attemptCount,
      },
      postDelivery: {
        markProcessed: {
          chatKey: "telegram/777:1",
          messageId: "inbound-final",
        },
      },
    });
    assert.equal(inbox.getChatInboxItem(dir, inbound.itemId).state, "terminal");
    assert.equal(
      outbox.readChatOutboxItemById(dir, id).item.turnId,
      inbound.itemId,
    );
    assert.equal(
      inbox.completeClaimedChatInboxItem(dir, claim, {
        disposition: "actionable",
      }),
      true,
    );
    const db = database.openChatDatabase(dir);
    assert.equal(
      db
        .prepare("SELECT disposition FROM messages WHERE message_id = ?")
        .get("inbound-final").disposition,
      "actionable",
    );
  });
});

test("terminal outbox atomically supersedes every coalesced steer turn", async () => {
  await withTempDir(async (dir) => {
    const claims = ["steer-a", "steer-b", "steer-c"].map((messageId) => {
      const item = inbox.enqueueChatInboxItem(dir, {
        chatKey: "telegram/777:1",
        messageId,
        session: {
          platform: "telegram",
          selfId: "777",
          channelId: "1",
          messageId,
          timestamp: Date.now(),
          content: messageId,
          stripped: { content: messageId },
        },
        elements: [{ type: "text", attrs: { content: messageId } }],
      }).item;
      return inbox.claimChatInboxItem(dir, item.itemId);
    });
    const fences = claims.map((claim) => ({
      agentDir: dir,
      turnId: claim.itemId,
      chatKey: claim.chatKey,
      messageId: claim.messageId,
      ownerEpoch: claim.ownerEpoch,
      attempt: claim.attemptCount,
    }));

    outbox.enqueueChatOutboxPayload(dir, payload("answer for latest steer"), {
      deliveryKind: "final",
      turnFence: fences[2],
      supersedeTurnFences: [fences[0], fences[1]],
      postDelivery: {
        markProcessed: {
          chatKey: claims[2].chatKey,
          messageId: claims[2].messageId,
        },
      },
    });

    assert.deepEqual(
      database
        .openChatDatabase(dir)
        .prepare(
          `SELECT messages.message_id, turns.state, messages.disposition
           FROM turns JOIN messages ON messages.id = turns.inbound_message_id
           ORDER BY messages.sequence`,
        )
        .all(),
      [
        {
          message_id: "steer-a",
          state: "superseded",
          disposition: "superseded",
        },
        {
          message_id: "steer-b",
          state: "superseded",
          disposition: "superseded",
        },
        {
          message_id: "steer-c",
          state: "terminal",
          disposition: "actionable",
        },
      ],
    );
  });
});

test("fenced terminal enqueue adopts an existing unlinked retryable final", async () => {
  await withTempDir(async (dir) => {
    const inbound = inbox.enqueueChatInboxItem(dir, {
      chatKey: "telegram/777:1",
      messageId: "adopt-existing-final",
      session: {
        platform: "telegram",
        selfId: "777",
        channelId: "1",
        messageId: "adopt-existing-final",
        timestamp: Date.now(),
        content: "question",
        stripped: { content: "question" },
      },
      elements: [{ type: "text", attrs: { content: "question" } }],
    }).item;
    const claim = inbox.claimChatInboxItem(dir, inbound.itemId);
    const id = "adopt-existing-final";
    const requestedId = "requested-adopted-final";
    const idempotencyKey = "shared-adopted-final-key";
    outbox.enqueueChatOutboxPayload(dir, payload("adopted answer"), {
      id,
      idempotencyKey,
      deliveryKind: "final",
    });
    assert.throws(
      () =>
        outbox.enqueueChatOutboxPayload(dir, payload("different answer"), {
          id: requestedId,
          idempotencyKey,
          deliveryKind: "final",
        }),
      /chat_outbox_idempotency_collision/,
    );
    database
      .openChatDatabase(dir)
      .prepare(
        `UPDATE outbox
         SET state = 'failed', failure_kind = 'attempts_exhausted',
             failed_at = ?, last_error = 'temporary failure'
         WHERE outbox_id = ?`,
      )
      .run(new Date().toISOString(), id);
    database
      .openChatDatabase(dir)
      .prepare(
        `UPDATE outbox_deliveries
         SET state = 'failed', failed_at = ?, last_error = 'temporary failure'
         WHERE outbox_id = ?`,
      )
      .run(new Date().toISOString(), id);

    assert.equal(
      outbox.enqueueChatOutboxPayload(dir, payload("adopted answer"), {
        id: requestedId,
        idempotencyKey,
        deliveryKind: "final",
        turnFence: {
          agentDir: dir,
          turnId: claim.itemId,
          chatKey: claim.chatKey,
          messageId: claim.messageId,
          ownerEpoch: claim.ownerEpoch,
          attempt: claim.attemptCount,
        },
        postDelivery: {
          markProcessed: {
            chatKey: claim.chatKey,
            messageId: claim.messageId,
          },
        },
      }),
      id,
    );

    const adopted = outbox.readChatOutboxItemById(dir, id).item;
    assert.equal(adopted.turnId, claim.itemId);
    assert.equal(adopted.status, "queued");
    assert.equal(adopted.failureKind, "");
    assert.deepEqual(
      outbox.listChatOutboxDeliveries(dir, id).map((item) => item.state),
      ["queued"],
    );
    assert.equal(
      database
        .openChatDatabase(dir)
        .prepare(`SELECT state FROM turns WHERE turn_id = ?`)
        .get(claim.itemId).state,
      "terminal",
    );
  });
});

test("delivered same-key adoption applies newly attached post-delivery", async () => {
  await withTempDir(async (dir) => {
    inbox.enqueueChatInboxItem(dir, {
      chatKey: "telegram/777:1",
      messageId: "delivered-adoption-inbound",
      session: {
        platform: "telegram",
        selfId: "777",
        channelId: "1",
        messageId: "delivered-adoption-inbound",
        timestamp: Date.now(),
        content: "question",
        stripped: { content: "question" },
      },
      elements: [{ type: "text", attrs: { content: "question" } }],
    });
    const id = outbox.enqueueChatOutboxPayload(
      dir,
      payload("already delivered"),
      {
        id: "already-delivered-row",
        idempotencyKey: "already-delivered-key",
        deliveryKind: "final",
      },
    );
    const timestamp = new Date().toISOString();
    database
      .openChatDatabase(dir)
      .prepare(
        `UPDATE outbox
         SET state = 'delivered', delivered_at = ?,
             delivery_result_json = '["provider-existing"]'
         WHERE outbox_id = ?`,
      )
      .run(timestamp, id);
    database
      .openChatDatabase(dir)
      .prepare(
        `UPDATE outbox_deliveries
         SET state = 'delivered', delivered_at = ?,
             provider_message_id = 'provider-existing'
         WHERE outbox_id = ?`,
      )
      .run(timestamp, id);

    const adoptedId = outbox.enqueueChatOutboxPayload(
      dir,
      payload("already delivered"),
      {
        id: "different-requested-id",
        idempotencyKey: "already-delivered-key",
        deliveryKind: "final",
        postDelivery: {
          markProcessed: {
            chatKey: "telegram/777:1",
            messageId: "delivered-adoption-inbound",
          },
        },
      },
    );
    assert.equal(adoptedId, id);

    const results = await boot.drainChatOutbox(
      { bots: [] },
      dir,
      h(),
      { warn() {} },
      { chatKey: "telegram/777:1", itemId: adoptedId },
    );
    assert.deepEqual(results, [
      {
        id,
        status: "delivered",
        deliveryResult: ["provider-existing"],
      },
    ]);
    assert.ok(
      messageStore.getChatMessage(
        dir,
        "telegram/777:1",
        "delivered-adoption-inbound",
      ).processedAt,
    );
  });
});

test("expired sending terminal outbox recovers as ambiguous without duplicate dispatch", async () => {
  await withTempDir(async (dir) => {
    const inbound = inbox.enqueueChatInboxItem(dir, {
      chatKey: "telegram/777:1",
      messageId: "ambiguous-crash-terminal",
      session: {
        platform: "telegram",
        selfId: "777",
        channelId: "1",
        messageId: "ambiguous-crash-terminal",
        timestamp: Date.now(),
        content: "question",
        stripped: { content: "question" },
      },
      elements: [{ type: "text", attrs: { content: "question" } }],
    }).item;
    const claim = inbox.claimChatInboxItem(dir, inbound.itemId);
    const finalId = outbox.enqueueChatOutboxPayload(
      dir,
      payload("possibly delivered answer"),
      {
        deliveryKind: "final",
        turnFence: {
          agentDir: dir,
          turnId: claim.itemId,
          chatKey: claim.chatKey,
          messageId: claim.messageId,
          ownerEpoch: claim.ownerEpoch,
          attempt: claim.attemptCount,
        },
        postDelivery: {
          markProcessed: {
            chatKey: claim.chatKey,
            messageId: claim.messageId,
          },
        },
      },
    );
    const dispatchedClaim = outbox.claimChatOutboxItem(dir, finalId, {
      leaseUntil: new Date(0).toISOString(),
    });
    assert.ok(dispatchedClaim);
    assert.ok(outbox.markChatOutboxDispatchStarted(dir, dispatchedClaim));
    let sends = 0;
    const results = await boot.drainChatOutbox(
      {
        bots: [
          {
            platform: "telegram",
            selfId: "777",
            async sendMessage() {
              sends += 1;
              return ["duplicate-provider-id"];
            },
          },
        ],
      },
      dir,
      h(),
      { warn() {} },
      { itemId: finalId },
    );

    assert.equal(sends, 0);
    assert.equal(results[0].deliveryUnconfirmed, true);
    const recovered = outbox.readChatOutboxItemById(dir, finalId).item;
    assert.equal(recovered.status, "delivered");
    assert.equal(recovered.deliveryUnconfirmed, true);
    assert.equal(
      messageStore.getChatMessage(dir, claim.chatKey, claim.messageId)
        ?.processedAt !== undefined,
      true,
    );
  });
});

test("expired pre-dispatch outbox work is retried instead of falsely delivered", async () => {
  await withTempDir(async (dir) => {
    const id = outbox.enqueueChatOutboxPayload(
      dir,
      payload("not yet dispatched"),
      { deliveryKind: "generic" },
    );
    const claim = outbox.claimChatOutboxItem(dir, id, {
      leaseUntil: new Date(0).toISOString(),
    });
    assert.ok(claim);
    assert.equal(claim.dispatchStartedAt, undefined);
    let sends = 0;

    const results = await boot.drainChatOutbox(
      {
        bots: [
          {
            platform: "telegram",
            selfId: "777",
            async sendMessage() {
              assert.ok(
                outbox.readChatOutboxItemById(dir, id).item.dispatchStartedAt,
              );
              sends += 1;
              return ["provider-retried-once"];
            },
          },
        ],
      },
      dir,
      h(),
      { warn() {} },
      { itemId: id },
    );

    assert.equal(sends, 1);
    assert.ok(["delivered", "dispatched"].includes(results[0].status));
    assert.equal(results[0].deliveryUnconfirmed, undefined);
    await waitFor(() => {
      assert.equal(
        outbox.readChatOutboxItemById(dir, id).item.status,
        "delivered",
      );
    });
  });
});

test("committed terminal outbox survives expiry and retry exhaustion while its adapter is unavailable", async () => {
  await withTempDir(async (dir) => {
    const inbound = inbox.enqueueChatInboxItem(dir, {
      chatKey: "telegram/777:1",
      messageId: "durable-terminal-retry",
      session: {
        platform: "telegram",
        selfId: "777",
        channelId: "1",
        messageId: "durable-terminal-retry",
        timestamp: Date.now(),
        content: "question",
        stripped: { content: "question" },
      },
      elements: [{ type: "text", attrs: { content: "question" } }],
    }).item;
    const claim = inbox.claimChatInboxItem(dir, inbound.itemId);
    const finalId = outbox.enqueueChatOutboxPayload(
      dir,
      {
        ...payload("durable answer"),
        createdAt: new Date(0).toISOString(),
      },
      {
        deliveryKind: "final",
        turnFence: {
          agentDir: dir,
          turnId: claim.itemId,
          chatKey: claim.chatKey,
          messageId: claim.messageId,
          ownerEpoch: claim.ownerEpoch,
          attempt: claim.attemptCount,
        },
        postDelivery: {
          markProcessed: {
            chatKey: claim.chatKey,
            messageId: claim.messageId,
          },
        },
      },
    );
    const unlinkedFinalId = outbox.enqueueChatOutboxPayload(
      dir,
      {
        ...payload("legacy unlinked durable answer"),
        createdAt: new Date(0).toISOString(),
      },
      { deliveryKind: "final" },
    );

    for (const durableId of [finalId, unlinkedFinalId]) {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        database
          .openChatDatabase(dir)
          .prepare(`UPDATE outbox SET next_attempt_at = ? WHERE outbox_id = ?`)
          .run(new Date(0).toISOString(), durableId);
        await boot.drainChatOutbox(
          { bots: [] },
          dir,
          h(),
          { warn() {} },
          { itemId: durableId, maxAgeMs: 1 },
        );
      }

      const durable = outbox.readChatOutboxItemById(dir, durableId).item;
      assert.equal(durable.status, "queued");
      assert.equal(durable.failureKind, "retryable");
      assert.ok(durable.attempts >= 6);
      assert.match(durable.lastError, /no_bot_for_platform/);
    }
  });
});

test("chat generation supersedes queued nonterminal outbox work without suppressing committed finals", async () => {
  await withTempDir(async (dir) => {
    const firstInbound = inbox.enqueueChatInboxItem(dir, {
      chatKey: "telegram/777:1",
      messageId: "generation-interim",
      session: {
        platform: "telegram",
        selfId: "777",
        channelId: "1",
        messageId: "generation-interim",
        timestamp: Date.now(),
        content: "question",
        stripped: { content: "question" },
      },
      elements: [{ type: "text", attrs: { content: "question" } }],
    }).item;
    const firstClaim = inbox.claimChatInboxItem(dir, firstInbound.itemId);
    const firstFence = {
      agentDir: dir,
      turnId: firstClaim.itemId,
      chatKey: firstClaim.chatKey,
      messageId: firstClaim.messageId,
      ownerEpoch: firstClaim.ownerEpoch,
      attempt: firstClaim.attemptCount,
    };
    const interimId = outbox.enqueueChatOutboxPayload(
      dir,
      payload("stale progress"),
      { deliveryKind: "interim", turnFence: firstFence },
    );
    assert.equal(
      outbox.readChatOutboxItemById(dir, interimId).item.turnId,
      firstClaim.itemId,
    );
    const sendingInterimId = outbox.enqueueChatOutboxPayload(
      dir,
      payload("in-flight stale progress"),
      { deliveryKind: "interim", turnFence: firstFence },
    );
    const sendingInterim = outbox.claimChatOutboxItem(dir, sendingInterimId, {
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.equal(sendingInterim.status, "sending");
    database
      .openChatDatabase(dir)
      .prepare(
        `UPDATE outbox_deliveries
         SET state = 'sending', owner_epoch = ?, attempt = 1
         WHERE outbox_id = ?`,
      )
      .run(sendingInterim.ownerEpoch, sendingInterimId);
    assert.ok(outbox.markChatOutboxDispatchStarted(dir, sendingInterim));

    assert.throws(
      () => database.advanceChatGeneration(dir, firstClaim.chatKey),
      /chat_generation_nonterminal_send_in_flight/,
    );
    database
      .openChatDatabase(dir)
      .prepare(
        `UPDATE outbox
         SET lease_until = ?, next_attempt_at = ?
         WHERE outbox_id = ?`,
      )
      .run(
        new Date(0).toISOString(),
        new Date(0).toISOString(),
        sendingInterimId,
      );
    let duplicateSends = 0;
    await boot.drainChatOutbox(
      {
        bots: [
          {
            platform: "telegram",
            selfId: "777",
            async sendMessage() {
              duplicateSends += 1;
              return ["duplicate-interim"];
            },
          },
        ],
      },
      dir,
      h(),
      { warn() {} },
      { itemId: sendingInterimId },
    );
    assert.equal(duplicateSends, 0);

    database.advanceChatGeneration(dir, firstClaim.chatKey);

    const staleInterim = outbox.readChatOutboxItemById(dir, interimId).item;
    assert.equal(staleInterim.status, "failed");
    assert.equal(staleInterim.failureKind, "permanent");
    assert.equal(staleInterim.lastError, "chat_outbox_turn_superseded");
    const staleSendingInterim = outbox.readChatOutboxItemById(
      dir,
      sendingInterimId,
    ).item;
    assert.equal(staleSendingInterim.status, "delivered");
    assert.equal(staleSendingInterim.failureKind, "");
    assert.equal(staleSendingInterim.deliveryUnconfirmed, true);
    assert.equal(staleSendingInterim.ownerEpoch, undefined);
    assert.deepEqual(
      outbox
        .listChatOutboxDeliveries(dir, sendingInterimId)
        .map((delivery) => [delivery.state, delivery.ownerEpoch]),
      [["unconfirmed", undefined]],
    );
    assert.deepEqual(outbox.listChatOutboxItems(dir), []);

    const secondInbound = inbox.enqueueChatInboxItem(dir, {
      chatKey: "telegram/777:1",
      messageId: "generation-final",
      session: {
        platform: "telegram",
        selfId: "777",
        channelId: "1",
        messageId: "generation-final",
        timestamp: Date.now(),
        content: "next question",
        stripped: { content: "next question" },
      },
      elements: [{ type: "text", attrs: { content: "next question" } }],
    }).item;
    const secondClaim = inbox.claimChatInboxItem(dir, secondInbound.itemId);
    const finalId = outbox.enqueueChatOutboxPayload(
      dir,
      payload("committed final"),
      {
        deliveryKind: "final",
        turnFence: {
          agentDir: dir,
          turnId: secondClaim.itemId,
          chatKey: secondClaim.chatKey,
          messageId: secondClaim.messageId,
          ownerEpoch: secondClaim.ownerEpoch,
          attempt: secondClaim.attemptCount,
        },
        postDelivery: {
          markProcessed: {
            chatKey: secondClaim.chatKey,
            messageId: secondClaim.messageId,
          },
        },
      },
    );

    database.advanceChatGeneration(dir, secondClaim.chatKey);

    assert.equal(
      outbox.readChatOutboxItemById(dir, finalId).item.status,
      "queued",
    );
  });
});

test("superseded inbox ownership cannot commit a stale terminal outbox", async () => {
  await withTempDir(async (dir) => {
    const inbound = inbox.enqueueChatInboxItem(dir, {
      chatKey: "telegram/777:1",
      messageId: "stale-final",
      session: {
        platform: "telegram",
        selfId: "777",
        channelId: "1",
        messageId: "stale-final",
        timestamp: Date.now(),
        content: "old question",
        stripped: { content: "old question" },
      },
      elements: [{ type: "text", attrs: { content: "old question" } }],
    }).item;
    const claim = inbox.claimChatInboxItem(dir, inbound.itemId);
    database.advanceChatGeneration(dir, claim.chatKey);
    {
      assert.throws(
        () =>
          outbox.runWithChatOutboxTurnFence(
            {
              agentDir: dir,
              turnId: claim.itemId,
              chatKey: claim.chatKey,
              messageId: claim.messageId,
              ownerEpoch: claim.ownerEpoch,
              attempt: claim.attemptCount,
            },
            () =>
              outbox.enqueueChatOutboxPayload(dir, payload("stale answer"), {
                deliveryKind: "final",
                postDelivery: {
                  markProcessed: {
                    chatKey: claim.chatKey,
                    messageId: claim.messageId,
                  },
                },
              }),
          ),
        /chat_turn_fence_lost/,
      );
      assert.throws(
        () =>
          outbox.runWithChatOutboxTurnFence(
            {
              agentDir: dir,
              turnId: claim.itemId,
              chatKey: claim.chatKey,
              messageId: claim.messageId,
              ownerEpoch: claim.ownerEpoch,
              attempt: claim.attemptCount,
            },
            () =>
              outbox.enqueueChatOutboxPayload(dir, payload("stale interim"), {
                deliveryKind: "interim",
              }),
          ),
        /chat_turn_fence_lost/,
      );
    }
    assert.equal(
      database
        .openChatDatabase(dir)
        .prepare("SELECT COUNT(*) AS value FROM outbox")
        .get().value,
      0,
    );
  });
});

test("an expired attempt cannot borrow a replacement owner's turn fence", async () => {
  await withTempDir(async (dir) => {
    const inbound = inbox.enqueueChatInboxItem(dir, {
      chatKey: "telegram/777:1",
      messageId: "retried-final",
      session: {
        platform: "telegram",
        selfId: "777",
        channelId: "1",
        messageId: "retried-final",
        timestamp: Date.now(),
        content: "retry me",
        stripped: { content: "retry me" },
      },
      elements: [{ type: "text", attrs: { content: "retry me" } }],
    }).item;
    const first = inbox.claimChatInboxItem(dir, inbound.itemId);
    const firstFence = {
      agentDir: dir,
      turnId: first.itemId,
      chatKey: first.chatKey,
      messageId: first.messageId,
      ownerEpoch: first.ownerEpoch,
      attempt: first.attemptCount,
    };
    assert.ok(
      inbox.requeueClaimedChatInboxItem(dir, first, {
        delayMs: 0,
        error: "retry",
      }),
    );
    const second = inbox.claimChatInboxItem(dir, inbound.itemId, {
      nowMs: Date.now() + 10,
    });
    assert.throws(
      () =>
        outbox.enqueueChatOutboxPayload(dir, payload("late first"), {
          deliveryKind: "final",
          turnFence: firstFence,
          postDelivery: {
            markProcessed: {
              chatKey: first.chatKey,
              messageId: first.messageId,
            },
          },
        }),
      /chat_turn_fence_lost/,
    );
    assert.equal(inbox.getChatInboxItem(dir, second.itemId).state, "running");
  });
});

test("a valid turn fence cannot commit another inbound message", async () => {
  await withTempDir(async (dir) => {
    const first = inbox.enqueueChatInboxItem(dir, {
      chatKey: "telegram/777:1",
      messageId: "fence-a",
      session: {
        platform: "telegram",
        selfId: "777",
        channelId: "1",
        messageId: "fence-a",
        timestamp: Date.now(),
        content: "first",
        stripped: { content: "first" },
      },
      elements: [{ type: "text", attrs: { content: "first" } }],
    }).item;
    const second = inbox.enqueueChatInboxItem(dir, {
      chatKey: "telegram/777:1",
      messageId: "fence-b",
      session: {
        platform: "telegram",
        selfId: "777",
        channelId: "1",
        messageId: "fence-b",
        timestamp: Date.now(),
        content: "second",
        stripped: { content: "second" },
      },
      elements: [{ type: "text", attrs: { content: "second" } }],
    }).item;
    const claim = inbox.claimChatInboxItem(dir, first.itemId);
    assert.ok(inbox.claimChatInboxItem(dir, second.itemId));
    assert.throws(
      () =>
        outbox.enqueueChatOutboxPayload(dir, payload("wrong target"), {
          deliveryKind: "final",
          turnFence: {
            agentDir: dir,
            turnId: claim.itemId,
            chatKey: claim.chatKey,
            messageId: claim.messageId,
            ownerEpoch: claim.ownerEpoch,
            attempt: claim.attemptCount,
          },
          postDelivery: {
            markProcessed: {
              chatKey: claim.chatKey,
              messageId: "fence-b",
            },
          },
        }),
      /chat_turn_fence_lost/,
    );
    assert.equal(inbox.getChatInboxItem(dir, first.itemId).state, "running");
    assert.equal(inbox.getChatInboxItem(dir, second.itemId).state, "running");
  });
});

test("chat outbox cleanup uses SQL terminal timestamps", async () => {
  await withTempDir(async (dir) => {
    const nowMs = Date.parse("2026-07-14T00:00:00.000Z");
    const oldId = outbox.enqueueChatOutboxPayload(dir, {
      ...payload("old"),
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    const claimed = outbox.claimChatOutboxItem(dir, oldId, {
      leaseUntil: "2026-07-01T00:01:00.000Z",
      nowMs: Date.parse("2026-07-01T00:00:00.000Z"),
    });
    outbox.writeChatOutboxItem(dir, {
      ...claimed,
      status: "delivered",
      deliveredAt: "2026-07-01T00:00:10.000Z",
      updatedAt: "2026-07-01T00:00:10.000Z",
      deliveryResult: ["old-message"],
    });
    assert.deepEqual(outbox.cleanupChatOutboxHistory(dir, { nowMs }), {
      delivered: 1,
      failed: 0,
    });
    assert.equal(outbox.readChatOutboxItemById(dir, oldId), null);
  });
});

test("chat assistant delivery stores session only for conversation binding", async () => {
  await withTempDir(async (dir) => {
    transport.recordDeliveredAssistantMessages(dir, {
      chatKey: "telegram/777:1",
      deliveryResult: ["m1"],
      text: "tool send",
      sessionFile: "/tmp/ignored.jsonl",
    });
    transport.recordDeliveredAssistantMessages(dir, {
      chatKey: "telegram/777:1",
      deliveryResult: ["m2"],
      text: "normal reply",
      sessionFile: "/tmp/kept.jsonl",
      sessionBinding: "conversation",
    });
    assert.equal(
      messageStore.getChatMessage(dir, "telegram/777:1", "m1")?.sessionFile,
      undefined,
    );
    assert.equal(
      messageStore.getChatMessage(dir, "telegram/777:1", "m2")?.sessionFile,
      "/tmp/kept.jsonl",
    );
  });
});

test("outbox implementation has no JSON file authority", async () => {
  const source = await fs.readFile(
    path.join(rootDir, "src", "core", "rin-lib", "chat-outbox.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /writeJsonAtomic|readJsonFile|readdirSync/);
  assert.match(source, /FROM outbox/);
  assert.match(source, /outbox_deliveries/);
});
