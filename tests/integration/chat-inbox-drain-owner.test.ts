import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const drainModule = await importBuiltModule<
  typeof import("../../src/core/chat/inbox-drain.js")
>("dist/core/chat/inbox-drain.js");
const inbox = await importBuiltModule<
  typeof import("../../src/core/chat/inbox.js")
>("dist/core/chat/inbox.js");

async function withAgentDir(run: (agentDir: string) => Promise<void>) {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-drain-owner-"));
  try {
    await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

function input(chatKey: string, messageId: string) {
  const [, target = "bot:room"] = chatKey.split("/");
  const [selfId = "bot", channelId = "room"] = target.split(":");
  return {
    chatKey,
    messageId,
    session: {
      platform: chatKey.split("/")[0],
      selfId,
      channelId,
      userId: "owner",
      messageId,
      content: messageId,
      stripped: { content: messageId },
    },
    elements: [{ type: "text", attrs: { content: messageId } }],
  };
}

async function waitFor(check: () => void) {
  let error: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      check();
      return;
    } catch (next) {
      error = next;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw error;
}

test("inbox drain job helpers complete, retry, and exhaust fenced claims", async () => {
  await withAgentDir(async (agentDir) => {
    assert.equal(drainModule.computeChatInboxRetryDelay(0), 2_000);
    assert.equal(drainModule.computeChatInboxRetryDelay(-1), 2_000);
    assert.equal(drainModule.computeChatInboxRetryDelay(99), 60_000);

    const complete = inbox.enqueueChatInboxItem(
      agentDir,
      input("discord/bot:complete", "complete"),
    ).item;
    const completeClaim = inbox.claimChatInboxItem(agentDir, complete.itemId)!;
    assert.equal(
      drainModule.finalizeClaimedChatInboxJob(
        agentDir,
        { envelope: completeClaim },
        undefined,
      ),
      true,
    );

    const retry = inbox.enqueueChatInboxItem(
      agentDir,
      input("discord/bot:retry", "retry"),
    ).item;
    const retryClaim = inbox.claimChatInboxItem(agentDir, retry.itemId)!;
    assert.equal(
      drainModule.finalizeClaimedChatInboxJob(
        agentDir,
        { envelope: retryClaim },
        { retry: true },
      )?.state,
      "pending",
    );

    const exhausted = inbox.enqueueChatInboxItem(
      agentDir,
      input("discord/bot:exhausted", "exhausted"),
    ).item;
    let claimed;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      claimed = inbox.claimChatInboxItem(agentDir, exhausted.itemId, {
        nowMs: Date.now() + attempt * 100_000,
      })!;
      if (attempt < 5) {
        assert.equal(
          drainModule.requeueClaimedChatInboxJob(
            agentDir,
            { envelope: claimed },
            new Error("retry"),
          )?.state,
          "pending",
        );
      }
    }
    assert.equal(
      drainModule.requeueClaimedChatInboxJob(
        agentDir,
        { envelope: claimed! },
        "exhausted",
      )?.state,
      "failed",
    );
  });
});

test("inbox drain consumes processed work, defers owned work, and enqueues available work", async () => {
  await withAgentDir(async (agentDir) => {
    const owned = inbox.enqueueChatInboxItem(
      agentDir,
      input("discord/bot:owned", "owned"),
    ).item;
    const processed = inbox.enqueueChatInboxItem(
      agentDir,
      input("discord/bot:processed", "processed"),
    ).item;
    const available = inbox.enqueueChatInboxItem(
      agentDir,
      input("discord/bot:available", "available"),
    ).item;
    const jobs: any[] = [];
    const controller = (chatKey: string) => ({
      ownsInboundMessage(messageId: string) {
        return chatKey === owned.chatKey && messageId === owned.messageId;
      },
      hasActiveTurn() {
        return false;
      },
    });
    const drain = drainModule.createChatInboxDrain({
      agentDir,
      getController: controller as any,
      isInboundMessageProcessed(chatKey, messageId) {
        return (
          chatKey === processed.chatKey && messageId === processed.messageId
        );
      },
      enqueueClaimedInboxItem(job) {
        jobs.push(job);
      },
    });

    await drain.drainChatInboxOnce();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].envelope.itemId, available.itemId);
    assert.equal(
      inbox.getChatInboxItem(agentDir, processed.itemId)?.state,
      "terminal",
    );
    assert.equal(
      inbox.getChatInboxItem(agentDir, owned.itemId)?.state,
      "pending",
    );
  });
});

test("inbox drain isolates rejected asynchronous active admission", async () => {
  await withAgentDir(async (agentDir) => {
    inbox.enqueueChatInboxItem(agentDir, input("discord/bot:busy", "busy"));
    const warnings: string[] = [];
    const drain = drainModule.createChatInboxDrain({
      agentDir,
      getController: () => ({ hasActiveTurn: () => true }) as any,
      isInboundMessageProcessed: () => false,
      enqueueClaimedInboxItem() {},
      hasActiveChatKeyWorker: () => true,
      canClaimDuringActiveChatKeyWorker: async () => {
        throw new Error("admission failed");
      },
      logger: { warn: (message: string) => warnings.push(message) },
    });
    drain.requestDrainChatInbox();
    drain.requestDrainChatInbox();
    await waitFor(() => {
      assert.ok(
        warnings.some((message) => message.includes("admission failed")),
      );
    });
    assert.equal(inbox.listPendingChatInboxItems(agentDir).length, 1);
  });
});
