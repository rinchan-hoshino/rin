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
const database = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "database.js")).href
);
const inbox = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "inbox.js")).href
);
const recovery = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat-runtime", "inbound-recovery.js"),
  ).href
);
const outbox = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "chat-outbox.js"))
    .href
);
const boot = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "boot.js")).href
);

function planText(rows) {
  return rows.map((row) => String(row.detail || "")).join("\n");
}

test("180k archived messages do not enter inbox or recovery control paths", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-control-180k-"),
  );
  try {
    const db = database.openChatDatabase(agentDir);
    db.exec(`
      BEGIN IMMEDIATE;
      WITH RECURSIVE numbers(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1 FROM numbers WHERE value < 180000
      )
      INSERT INTO messages (
        id, record_key, chat_key, message_id, platform, bot_id, chat_id,
        role, received_at, sequence, generation, disposition, record_json,
        accepted_at, processed_at, text
      )
      SELECT
        printf('history-%06d', value),
        printf('history-%06d', value),
        'onebot/1:private:history',
        printf('%d', value),
        'onebot',
        '1',
        'private:history',
        CASE WHEN value % 2 = 0 THEN 'user' ELSE 'assistant' END,
        strftime('%Y-%m-%dT%H:%M:%fZ', 1700000000 + value, 'unixepoch'),
        value,
        0,
        CASE WHEN value % 2 = 0 THEN 'actionable' ELSE 'record_only' END,
        json_object(
          'version', 1,
          'recordKey', printf('history-%06d', value),
          'chatKey', 'onebot/1:private:history',
          'messageId', printf('%d', value),
          'platform', 'onebot',
          'botId', '1',
          'chatId', 'private:history',
          'receivedAt', strftime('%Y-%m-%dT%H:%M:%fZ', 1700000000 + value, 'unixepoch')
        ),
        CASE WHEN value % 2 = 0 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 1700000000 + value, 'unixepoch') ELSE NULL END,
        CASE WHEN value % 2 = 0 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 1700000001 + value, 'unixepoch') ELSE NULL END,
        printf('historical message %d', value)
      FROM numbers;

      INSERT INTO chat_state (chat_key, current_generation, next_sequence, updated_at)
      VALUES ('onebot/1:private:history', 0, 180001, '2026-07-14T00:00:00.000Z');

      INSERT INTO inbound_heads (
        platform, bot_id, chat_key, chat_id, message_id, platform_timestamp,
        received_at, provider_cursor, sequence, updated_at
      ) VALUES (
        'onebot', '1', 'onebot/1:private:history', 'private:history',
        '180000', 1700180000000, '2023-11-16T00:00:00.000Z',
        'cursor-180000', 180000, '2026-07-14T00:00:00.000Z'
      );

      WITH RECURSIVE numbers(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1 FROM numbers WHERE value < 180000
      )
      INSERT INTO outbox (
        outbox_id, chat_key, delivery_kind, state, payload_json,
        adapter_id, adapter_version, plan_state, sequence, attempts,
        delivery_unconfirmed, created_at, updated_at, delivered_at
      )
      SELECT
        printf('delivered-%06d', value),
        'onebot/1:private:history',
        'generic',
        'delivered',
        '{"createdAt":"2026-07-14T00:00:00.000Z","chatKey":"onebot/1:private:history","parts":[{"type":"text","text":"archived"}]}',
        'onebot',
        '1',
        'planned',
        value,
        1,
        0,
        '2026-07-14T00:00:00.000Z',
        '2026-07-14T00:00:00.000Z',
        '2026-07-14T00:00:00.000Z'
      FROM numbers;
      COMMIT;
    `);

    const enqueued = inbox.enqueueChatInboxItem(agentDir, {
      chatKey: "onebot/1:private:history",
      messageId: "180001",
      session: {
        platform: "onebot",
        selfId: "1",
        channelId: "private:history",
        userId: "owner",
        messageId: "180001",
        timestamp: 1700180001000,
        content: "new pending control item",
        stripped: { content: "new pending control item" },
      },
      elements: [
        { type: "text", attrs: { content: "new pending control item" } },
      ],
    }).item;

    const started = performance.now();
    const pending = inbox.listPendingChatInboxItems(agentDir);
    const claim = inbox.claimChatInboxItem(agentDir, enqueued.itemId);
    const heads = recovery.listInboundRecoveryHeads(agentDir, "onebot", "1");
    const newOutboxId = outbox.enqueueChatOutboxPayload(agentDir, {
      chatKey: "onebot/1:private:history",
      parts: [{ type: "text", text: "new outbound control item" }],
    });
    const activeOutbox = outbox.listChatOutboxItems(agentDir);
    const postDelivery = boot.reconcileCommittedChatOutboxProcessing(agentDir);
    const elapsedMs = performance.now() - started;

    assert.equal(pending.length, 1);
    assert.equal(claim.messageId, "180001");
    assert.equal(heads.length, 1);
    assert.equal(heads[0].messageId, "180001");
    assert.equal(activeOutbox.length, 1);
    assert.equal(activeOutbox[0].item.id, newOutboxId);
    assert.equal(activeOutbox[0].item.sequence, 180001);
    assert.equal(postDelivery, 0);
    assert.ok(elapsedMs < 1000, `control path took ${elapsedMs.toFixed(1)}ms`);

    const pendingPlan = planText(
      db
        .prepare(
          `EXPLAIN QUERY PLAN
         SELECT turns.* FROM turns
         WHERE turns.state = 'pending'
         ORDER BY turns.chat_key, turns.sequence`,
        )
        .all(),
    );
    const headPlan = planText(
      db
        .prepare(
          `EXPLAIN QUERY PLAN
         SELECT * FROM inbound_heads
         WHERE platform = 'onebot' AND bot_id = '1'`,
        )
        .all(),
    );
    const outboxSequencePlan = planText(
      db.prepare(`EXPLAIN QUERY PLAN SELECT MAX(sequence) FROM outbox`).all(),
    );
    const deliveredCleanupPlan = planText(
      db
        .prepare(
          `EXPLAIN QUERY PLAN DELETE FROM outbox
           INDEXED BY outbox_delivered_cleanup_idx
           WHERE state = 'delivered' AND delivered_at <= ?`,
        )
        .all("2026-07-01T00:00:00.000Z"),
    );
    const failedCleanupPlan = planText(
      db
        .prepare(
          `EXPLAIN QUERY PLAN DELETE FROM outbox
           INDEXED BY outbox_failed_cleanup_idx
           WHERE state = 'failed' AND failed_at <= ?`,
        )
        .all("2026-07-01T00:00:00.000Z"),
    );
    const postDeliveryPlan = planText(
      db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT * FROM outbox
           WHERE post_delivery_json IS NOT NULL
             AND post_delivery_applied_at IS NULL
             AND state IN ('queued', 'sending', 'delivered')
           ORDER BY sequence, outbox_id`,
        )
        .all(),
    );
    assert.doesNotMatch(pendingPlan, /SCAN messages/i);
    assert.doesNotMatch(headPlan, /SCAN messages/i);
    assert.match(headPlan, /inbound_heads/i);
    assert.match(outboxSequencePlan, /outbox_sequence_idx/i);
    assert.match(deliveredCleanupPlan, /outbox_delivered_cleanup_idx/i);
    assert.match(failedCleanupPlan, /outbox_failed_cleanup_idx/i);
    assert.match(postDeliveryPlan, /outbox_post_delivery_pending_idx/i);
  } finally {
    database.closeChatDatabase(agentDir);
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});
