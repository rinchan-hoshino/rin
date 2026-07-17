import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const inbox = await importBuiltModule<
  typeof import("../../src/core/chat/inbox.js")
>("dist/core/chat/inbox.js");
const drainModule = await importBuiltModule<
  typeof import("../../src/core/chat/inbox-drain.js")
>("dist/core/chat/inbox-drain.js");

async function withTempDir(run: (agentDir: string) => Promise<void>) {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-inbox-drain-owner-"),
  );
  try {
    await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

function enqueue(agentDir: string, messageId: string) {
  return inbox.enqueueChatInboxItem(agentDir, {
    chatKey: "onebot/bot:private:owner",
    messageId,
    session: {
      platform: "onebot",
      selfId: "bot",
      channelId: "private:owner",
      userId: "owner",
      messageId,
      content: messageId,
      stripped: { content: messageId },
    },
    elements: [{ type: "text", attrs: { content: messageId } }],
  });
}

function claim(agentDir: string, messageId: string) {
  const queued = enqueue(agentDir, messageId);
  const claimedPath = inbox.claimChatInboxFile(agentDir, queued.filePath);
  const envelope = inbox.readChatInboxItem(claimedPath);
  assert.ok(envelope);
  return { claimedPath, envelope };
}

async function waitUntil(run: () => boolean) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (run()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for inbox drain");
}

test("claimed inbox jobs complete, retry, and fail at the attempt limit", async () => {
  assert.equal(drainModule.computeChatInboxRetryDelay(-1), 2000);
  assert.equal(drainModule.computeChatInboxRetryDelay(Number.NaN), 2000);
  assert.equal(drainModule.computeChatInboxRetryDelay(2), 8000);
  assert.equal(drainModule.computeChatInboxRetryDelay(99), 60_000);

  await withTempDir(async (agentDir) => {
    const completed = claim(agentDir, "complete");
    drainModule.completeClaimedChatInboxJob(completed);
    assert.equal(inbox.listProcessingChatInboxFiles(agentDir).length, 0);

    const retried = claim(agentDir, "retry");
    drainModule.requeueClaimedChatInboxJob(
      agentDir,
      retried,
      new Error("busy"),
    );
    const [retriedPath] = inbox.listPendingChatInboxFiles(agentDir);
    const retriedItem = inbox.readChatInboxItem(retriedPath);
    assert.equal(retriedItem?.attemptCount, 1);
    assert.equal(retriedItem?.lastError, "Error: busy");
    assert.ok(Date.parse(retriedItem?.nextAttemptAt || "") > Date.now());

    const defaultRetry = claim(agentDir, "default-retry");
    drainModule.finalizeClaimedChatInboxJob(agentDir, defaultRetry, {
      retry: true,
    });
    const defaultRetryItem = inbox
      .listPendingChatInboxFiles(agentDir)
      .map((file) => inbox.readChatInboxItem(file))
      .find((item) => item?.messageId === "default-retry");
    assert.equal(defaultRetryItem?.lastError, "chat_inbound_retry_needed");

    const finalized = claim(agentDir, "finalized");
    drainModule.finalizeClaimedChatInboxJob(agentDir, finalized, undefined);
    assert.equal(
      inbox
        .listProcessingChatInboxFiles(agentDir)
        .some((file) => file === finalized.claimedPath),
      false,
    );

    const failed = claim(agentDir, "failed");
    failed.envelope.attemptCount = 4;
    drainModule.requeueClaimedChatInboxJob(agentDir, failed, "permanent");
    const failedPath = path.join(
      agentDir,
      "data",
      "chat",
      "inbox",
      "failed",
      `${failed.envelope.itemId}.json`,
    );
    assert.equal((await fs.stat(failedPath)).isFile(), true);
    assert.equal(inbox.readChatInboxItem(failedPath)?.lastError, "permanent");
  });
});

test("inbox retries default errors and consumes unreadable pending files", async () => {
  await withTempDir(async (agentDir) => {
    const fallback = claim(agentDir, "fallback-error");
    drainModule.requeueClaimedChatInboxJob(agentDir, fallback);
    const [fallbackPath] = inbox.listPendingChatInboxFiles(agentDir);
    assert.equal(
      inbox.readChatInboxItem(fallbackPath)?.lastError,
      "chat_inbound_retry_needed",
    );
    inbox.completeChatInboxFile(fallbackPath);

    const pendingDir = path.join(agentDir, "data", "chat", "inbox", "pending");
    await fs.writeFile(path.join(pendingDir, "unreadable.json"), "not-json");
    await fs.writeFile(
      path.join(pendingDir, "missing-key.json"),
      JSON.stringify({
        version: 1,
        itemId: "missing-key",
        messageId: "missing-key",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        attemptCount: 0,
        session: {},
        elements: [],
      }),
    );

    const drain = drainModule.createChatInboxDrain({
      agentDir,
      getController() {
        assert.fail("invalid pending files must not reach a controller");
      },
      isInboundMessageProcessed() {
        return false;
      },
      enqueueClaimedInboxItem() {
        assert.fail("invalid pending files must not be claimed");
      },
    });
    await drain.drainChatInboxOnce();
    assert.equal(
      inbox
        .listPendingChatInboxFiles(agentDir)
        .some((file) => file.endsWith("unreadable.json")),
      false,
    );
    assert.equal(
      inbox
        .listPendingChatInboxFiles(agentDir)
        .some((file) => file.endsWith("missing-key.json")),
      false,
    );
  });
});

test("requested inbox drains serialize work and report controller failures", async () => {
  await withTempDir(async (agentDir) => {
    enqueue(agentDir, "controller-failure");
    const warnings: string[] = [];
    const drain = drainModule.createChatInboxDrain({
      agentDir,
      getController() {
        throw new Error("controller unavailable");
      },
      isInboundMessageProcessed() {
        return false;
      },
      enqueueClaimedInboxItem() {
        assert.fail("failed controller item must not be claimed");
      },
      logger: { warn: (message: string) => warnings.push(message) },
    });

    drain.requestDrainChatInbox();
    drain.requestDrainChatInbox();
    await waitUntil(() => warnings.length >= 1);
    assert.match(warnings[0], /controller unavailable/);
    assert.equal(inbox.listPendingChatInboxFiles(agentDir).length, 1);
  });
});
