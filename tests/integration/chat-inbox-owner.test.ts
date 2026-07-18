import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const inbox = await importBuiltModule<
  typeof import("../../src/core/chat/inbox.js")
>("dist/core/chat/inbox.js");
const database = await importBuiltModule<
  typeof import("../../src/core/chat/database.js")
>("dist/core/chat/database.js");

async function withAgentDir(run: (agentDir: string) => Promise<void>) {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-inbox-owner-"));
  try {
    await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

function input(messageId = "message-1") {
  return {
    chatKey: "discord/bot:room",
    messageId,
    session: {
      platform: "discord",
      selfId: "bot",
      channelId: "room",
      userId: "owner",
      messageId,
      timestamp: 1_700_000_000_000,
      content: "owner text",
      stripped: { content: "owner text", appel: true },
      quote: { messageId: "quoted" },
      author: { name: "Owner" },
      channelName: "Room",
    },
    elements: [{ type: "text", attrs: { content: "owner text" } }],
  };
}

function staleClaim<T extends { ownerEpoch?: string }>(item: T): T {
  return { ...item, ownerEpoch: "stale-owner" };
}

test("chat inbox owns validation, claim fencing, and terminal transitions", async () => {
  await withAgentDir(async (agentDir) => {
    assert.throws(
      () => inbox.buildChatInboxItem({ ...input(), chatKey: "" }),
      /chatKey_required/,
    );
    assert.throws(
      () => inbox.buildChatInboxItem({ ...input(), chatKey: "legacy:room" }),
      /invalid_chatKey/,
    );
    assert.throws(
      () => inbox.buildChatInboxItem({ ...input(), messageId: "" }),
      /messageId_required/,
    );
    assert.deepEqual(
      inbox.listChatInboxItems(agentDir, ["unknown" as any]),
      [],
    );
    assert.equal(inbox.getChatInboxItem(agentDir, "missing"), null);
    assert.equal(inbox.isChatInboxItemAccepted(agentDir, "missing"), false);

    const first = inbox.enqueueChatInboxItem(agentDir, input("first")).item;
    const duplicate = inbox.enqueueChatInboxItem(agentDir, {
      ...input("first"),
      elements: [{ type: "text", attrs: { content: "updated" } }],
    }).item as any;
    assert.equal(duplicate.itemId, first.itemId);
    assert.equal(duplicate.duplicateCount, 1);
    assert.equal(duplicate.elements[0].attrs.content, "updated");

    const firstClaim = inbox.claimChatInboxItem(agentDir, first.itemId, {
      nowMs: 100,
      leaseMs: 0,
    })!;
    assert.equal(firstClaim.attemptCount, 1);
    assert.equal(inbox.claimChatInboxItem(agentDir, first.itemId), null);
    assert.equal(
      inbox.classifyClaimedChatInboxItem(agentDir, firstClaim, "actionable"),
      true,
    );
    assert.equal(
      inbox.classifyClaimedChatInboxItem(
        agentDir,
        staleClaim(firstClaim),
        "superseded",
      ),
      false,
    );
    assert.equal(
      inbox.touchClaimedChatInboxItem(agentDir, firstClaim, {
        nowMs: 200,
        leaseMs: 0,
      }),
      true,
    );
    assert.equal(
      inbox.touchClaimedChatInboxItem(agentDir, staleClaim(firstClaim)),
      false,
    );
    assert.equal(
      inbox.completeClaimedChatInboxItem(agentDir, firstClaim),
      true,
    );
    assert.equal(
      inbox.completeClaimedChatInboxItem(agentDir, firstClaim),
      true,
    );

    for (const operation of [
      () =>
        inbox.classifyClaimedChatInboxItem(agentDir, {} as any, "actionable"),
      () => inbox.touchClaimedChatInboxItem(agentDir, {} as any),
      () => inbox.completeClaimedChatInboxItem(agentDir, {} as any),
      () =>
        inbox.requeueClaimedChatInboxItem(agentDir, {} as any, { delayMs: 0 }),
      () => inbox.failClaimedChatInboxItem(agentDir, {} as any),
    ]) {
      assert.throws(operation, /claim_required/);
    }

    const retry = inbox.enqueueChatInboxItem(agentDir, input("retry")).item;
    const retryClaim = inbox.claimChatInboxItem(agentDir, retry.itemId)!;
    const requeued = inbox.requeueClaimedChatInboxItem(agentDir, retryClaim, {
      delayMs: Number.NaN,
      error: "",
    })!;
    assert.equal(requeued.state, "pending");
    assert.equal(
      inbox.requeueClaimedChatInboxItem(agentDir, staleClaim(retryClaim), {
        delayMs: 0,
      }),
      null,
    );
    const releasedClaim = inbox.claimChatInboxItem(agentDir, retry.itemId, {
      nowMs: Date.now() + 1_000,
    })!;
    assert.ok(inbox.releaseClaimedChatInboxItem(agentDir, releasedClaim));

    const failed = inbox.enqueueChatInboxItem(agentDir, input("failed")).item;
    const failedClaim = inbox.claimChatInboxItem(agentDir, failed.itemId)!;
    assert.equal(
      inbox.failClaimedChatInboxItem(
        agentDir,
        staleClaim(failedClaim),
        "stale",
      ),
      null,
    );
    assert.equal(
      inbox.failClaimedChatInboxItem(agentDir, failedClaim)?.state,
      "failed",
    );
    assert.equal(inbox.listRunningChatInboxItems(agentDir).length, 0);
  });
});

test("chat inbox tolerates sparse row metadata and restores routing fallbacks", async () => {
  await withAgentDir(async (agentDir) => {
    assert.throws(
      () =>
        inbox.enqueueChatInboxItem(agentDir, {
          chatKey: "discord/bot:room",
          messageId: "missing-identity",
          session: {},
          elements: [],
        }),
      /message_identity_required/,
    );
    const item = inbox.enqueueChatInboxItem(agentDir, input("sparse")).item;
    database
      .openChatDatabase(agentDir)
      .prepare(
        `UPDATE turns
         SET routing_json = 'invalid', session_json = '[]', elements_json = '{}',
             next_attempt_at = '', last_error = '', owner_epoch = '', lease_until = ''
         WHERE turn_id = ?`,
      )
      .run(item.itemId);
    const sparse = inbox.getChatInboxItem(agentDir, item.itemId)!;
    assert.deepEqual(sparse.routing, {});
    assert.deepEqual(sparse.session, {});
    assert.deepEqual(sparse.elements, []);
    assert.equal(sparse.nextAttemptAt, undefined);
    assert.equal(sparse.ownerEpoch, undefined);

    database
      .openChatDatabase(agentDir)
      .prepare("UPDATE turns SET elements_json = 'invalid' WHERE turn_id = ?")
      .run(item.itemId);
    assert.deepEqual(
      inbox.getChatInboxItem(agentDir, item.itemId)?.elements,
      [],
    );
    database
      .openChatDatabase(agentDir)
      .prepare(
        `UPDATE messages SET message_id = ''
         WHERE id = (SELECT inbound_message_id FROM turns WHERE turn_id = ?)`,
      )
      .run(item.itemId);
    assert.equal(inbox.getChatInboxItem(agentDir, item.itemId), null);

    const bot = { selfId: "bot" };
    assert.deepEqual(
      inbox.restoreChatInboxSession(
        { session: null, routing: null } as any,
        bot,
      ),
      { bot },
    );
    const restored = inbox.restoreChatInboxSession({
      session: {
        userId: "",
        stripped: "invalid",
        quote: null,
        author: [],
        channelName: "",
      },
      routing: {
        isDirect: true,
        userId: "routed-user",
        text: "routed text",
        mentionLike: true,
        replyToMessageId: "routed-quote",
        nickname: "Routed Owner",
        chatName: "Routed Room",
      },
    } as any);
    assert.equal(restored.userId, "routed-user");
    assert.deepEqual(restored.stripped, {
      content: "routed text",
      appel: true,
    });
    assert.deepEqual(restored.quote, { messageId: "routed-quote" });
    assert.deepEqual(restored.author, { name: "Routed Owner" });
    assert.equal(restored.channelName, "Routed Room");

    const untouched = inbox.restoreChatInboxSession({
      session: { stripped: { content: "existing" } },
      routing: { isDirect: false },
    } as any);
    assert.deepEqual(untouched, {
      isDirect: false,
      stripped: { content: "existing" },
      userId: undefined,
    });
  });
});
