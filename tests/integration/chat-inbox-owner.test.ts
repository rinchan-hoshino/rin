import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const inbox = await importBuiltModule<
  typeof import("../../src/core/chat/inbox.js")
>("dist/core/chat/inbox.js");
const store = await importBuiltModule<
  typeof import("../../src/core/chat/message-store.js")
>("dist/core/chat/message-store.js");

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
      content: "owner text",
      stripped: { content: "owner text", appel: true },
      quote: { messageId: "quoted" },
      author: { name: "Owner" },
      channelName: "Room",
    },
    elements: [{ type: "text", attrs: { content: "owner text" } }],
  };
}

test("chat inbox validates, deduplicates, claims, requeues, fails, and completes items", async () => {
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

    const first = inbox.enqueueChatInboxItem(agentDir, input());
    assert.equal(inbox.listPendingChatInboxFiles(agentDir).length, 1);
    const duplicate = inbox.enqueueChatInboxItem(agentDir, {
      ...input(),
      elements: [{ type: "text", attrs: { content: "new" } }],
    });
    assert.equal(duplicate.filePath, first.filePath);
    assert.equal(duplicate.item.duplicateCount, 1);
    assert.equal(duplicate.item.elements[0].attrs.content, "new");

    const claimed = inbox.claimChatInboxFile(agentDir, first.filePath);
    assert.ok(claimed);
    const processingDuplicate = inbox.enqueueChatInboxItem(agentDir, input());
    assert.equal(processingDuplicate.filePath, claimed);
    assert.equal(inbox.listProcessingChatInboxFiles(agentDir).length, 1);

    const loaded = inbox.readChatInboxItem(claimed!);
    const restored = inbox.restoreChatInboxFile(agentDir, claimed!, loaded!);
    const requeued = inbox.requeueChatInboxFile(
      agentDir,
      restored.filePath,
      restored.item,
      {
        delayMs: 500,
        error: " temporary ",
      },
    );
    assert.equal(requeued.item.attemptCount, 1);
    assert.equal(requeued.item.lastError, "temporary");
    assert.ok(requeued.item.nextAttemptAt);

    const failed = inbox.failChatInboxFile(
      agentDir,
      requeued.filePath,
      requeued.item,
      "",
    );
    assert.equal(failed.item.attemptCount, 2);
    assert.equal(failed.item.lastError, undefined);
    assert.equal(failed.item.nextAttemptAt, undefined);
    inbox.completeChatInboxFile(failed.filePath);
    assert.equal(inbox.readChatInboxItem(failed.filePath), null);
    assert.equal(
      Boolean(
        inbox.claimChatInboxFile(agentDir, path.join(agentDir, "missing.json")),
      ),
      false,
    );
  });
});

test("chat inbox session restoration backfills routing without clobbering stored metadata", () => {
  const item = inbox.buildChatInboxItem(input());
  const bot = { id: "bot" };
  const restored = inbox.restoreChatInboxSession(
    {
      ...item,
      session: {
        userId: "kept-user",
        stripped: { content: "kept", extra: true },
        quote: { messageId: "kept-quote", extra: true },
        author: { name: "Kept", role: "owner" },
        channelName: "Kept room",
      },
    },
    bot,
  );
  assert.equal(restored.bot, bot);
  assert.equal(restored.userId, "kept-user");
  assert.deepEqual(restored.stripped, {
    content: "kept",
    extra: true,
    appel: true,
  });
  assert.deepEqual(restored.quote, { messageId: "kept-quote", extra: true });
  assert.deepEqual(restored.author, { name: "Kept", role: "owner" });
  assert.equal(restored.channelName, "Kept room");
  const withoutRouting = inbox.restoreChatInboxSession({
    ...item,
    routing: null as any,
  });
  assert.equal(withoutRouting.platform, item.session.platform);
  assert.equal(withoutRouting.messageId, item.session.messageId);

  const noHints = inbox.restoreChatInboxSession({
    ...item,
    session: {},
    routing: {
      chatType: "group",
      isDirect: false,
      mentionLike: false,
    },
  });
  assert.equal(noHints.userId, undefined);
  assert.equal(noHints.stripped, undefined);

  const mentionOnly = inbox.restoreChatInboxSession({
    ...item,
    session: {},
    routing: {
      chatType: "group",
      isDirect: false,
      mentionLike: true,
    },
  });
  assert.deepEqual(mentionOnly.stripped, { appel: true });

  const textOnly = inbox.restoreChatInboxSession({
    ...item,
    session: {},
    routing: {
      chatType: "group",
      isDirect: false,
      mentionLike: false,
      text: "text only",
    },
  });
  assert.deepEqual(textOnly.stripped, { content: "text only" });
});

test("chat inbox duplicate and sparse restoration paths preserve defensive fallbacks", async () => {
  await withAgentDir(async (agentDir) => {
    const first = inbox.enqueueChatInboxItem(agentDir, {
      ...input("sparse"),
      elements: [],
    });
    const current = {
      ...first.item,
      duplicateCount: 3,
      routing: null as any,
      session: null as any,
      elements: [{ type: "text", attrs: { content: "kept" } }],
    };
    await fs.writeFile(first.filePath, JSON.stringify(current));
    const duplicate = inbox.enqueueChatInboxItem(agentDir, {
      ...input("sparse"),
      session: null,
      elements: [],
    });
    assert.equal(duplicate.item.duplicateCount, 4);
    assert.equal(duplicate.item.elements[0].attrs.content, "kept");

    const sparse = inbox.restoreChatInboxSession({
      ...duplicate.item,
      session: null as any,
      routing: {
        chatType: "group",
        isDirect: false,
        mentionLike: true,
        text: "routing text",
        userId: "routing-user",
        nickname: "Routing owner",
        chatName: "Routing room",
        replyToMessageId: "routing-reply",
      },
    });
    assert.equal(sparse.userId, "routing-user");
    assert.deepEqual(sparse.stripped, { content: "routing text", appel: true });
    assert.deepEqual(sparse.quote, { messageId: "routing-reply" });
    assert.deepEqual(sparse.author, { name: "Routing owner" });
    assert.equal(sparse.channelName, "Routing room");

    const requeued = inbox.requeueChatInboxFile(
      agentDir,
      duplicate.filePath,
      duplicate.item,
      {} as any,
    );
    assert.ok(requeued.item.nextAttemptAt);
    assert.equal(requeued.item.lastError, undefined);
  });
});

test("processing recovery respects invalid files, freshness, limits, and stale restoration", async () => {
  await withAgentDir(async (agentDir) => {
    const pending = inbox.enqueueChatInboxItem(agentDir, input("stale"));
    const claimed = inbox.claimChatInboxFile(agentDir, pending.filePath)!;
    const item = inbox.readChatInboxItem(claimed)!;
    await fs.writeFile(
      claimed,
      JSON.stringify({ ...item, updatedAt: "2026-07-15T00:00:00.000Z" }),
    );
    const second = inbox.enqueueChatInboxItem(agentDir, input("second-stale"));
    const secondClaimed = inbox.claimChatInboxFile(agentDir, second.filePath)!;
    await fs.writeFile(
      secondClaimed,
      JSON.stringify({
        ...inbox.readChatInboxItem(secondClaimed),
        updatedAt: "2026-07-15T00:00:00.000Z",
      }),
    );
    const invalidPath = path.join(path.dirname(claimed), "invalid.json");
    await fs.writeFile(invalidPath, "not-json");

    assert.deepEqual(
      inbox.restoreProcessingChatInboxFiles(agentDir, {
        staleMs: 10_000,
        nowMs: Date.parse("2026-07-15T00:00:05.000Z"),
      }),
      [],
    );
    assert.ok(await fs.stat(claimed));
    const restored = inbox.restoreProcessingChatInboxFiles(agentDir, {
      staleMs: 1_000,
      nowMs: Date.parse("2026-07-15T00:00:05.000Z"),
      limit: 1,
    });
    assert.equal(restored.length, 1);
    assert.equal(inbox.listProcessingChatInboxFiles(agentDir).length, 1);
    assert.equal(inbox.restoreProcessingChatInboxFiles(agentDir).length, 1);
    assert.equal(inbox.listProcessingChatInboxFiles(agentDir).length, 0);
  });
});

function saveUser(agentDir: string, patch: Record<string, unknown>) {
  store.saveChatMessage(agentDir, {
    chatKey: "discord/bot:room",
    platform: "discord",
    botId: "bot",
    chatId: "room",
    chatType: "group",
    messageId: "owner-message",
    role: "user",
    receivedAt: "2026-07-15T00:00:00.000Z",
    userId: "owner",
    text: "recover owner",
    rawContent: "raw owner",
    strippedContent: "recover owner",
    acceptedAt: "2026-07-15T00:00:10.000Z",
    ...patch,
  } as any);
}

test("orphan recovery reconstructs rich and sparse stored message shapes", async () => {
  await withAgentDir(async (agentDir) => {
    saveUser(agentDir, {
      chatKey: "discord/bot:rich-room",
      messageId: "rich",
      receivedAt: "",
      platformTimestamp: Date.parse("2026-07-15T00:00:05.000Z"),
      strippedContent: "",
      text: "text fallback",
      rawContent: "raw fallback",
      nickname: "Owner name",
      chatName: "Owner room",
      quote: { messageId: "quoted", empty: "" },
      elements: [{ type: "image", attrs: { src: "owner.png" } }],
    });
    saveUser(agentDir, {
      chatKey: "discord/bot:raw-room",
      messageId: "raw",
      receivedAt: "",
      platformTimestamp: Number.NaN,
      strippedContent: "",
      text: "",
      rawContent: "raw only",
      elements: [],
    });
    saveUser(agentDir, {
      chatKey: "discord/bot:empty-room",
      messageId: "empty",
      receivedAt: "",
      platformTimestamp: Number.NaN,
      strippedContent: "",
      text: "",
      rawContent: "",
      elements: [],
    });

    const restored = inbox.restoreOrphanedAcceptedChatInboxItems(agentDir, {
      nowMs: Date.parse("2026-07-15T00:01:00.000Z"),
      maxAgeMs: 0,
    });
    assert.equal(restored.length, 3);
    const items = inbox
      .listPendingChatInboxFiles(agentDir)
      .map((filePath) => inbox.readChatInboxItem(filePath)!);
    const rich = items.find((entry) => entry.messageId === "rich")!;
    assert.equal(rich.session.author.name, "Owner name");
    assert.deepEqual(rich.session.quote, { messageId: "quoted" });
    assert.equal(rich.elements[0].type, "image");
    assert.equal(
      items.find((entry) => entry.messageId === "raw")!.session.stripped
        .content,
      "raw only",
    );
    assert.deepEqual(
      items.find((entry) => entry.messageId === "empty")!.elements,
      [],
    );
  });
});

test("orphan recovery restores eligible messages and reports each skip reason", async () => {
  await withAgentDir(async (agentDir) => {
    saveUser(agentDir, {
      chatKey: "discord/bot:restore-room",
      messageId: "restore",
      elements: [],
    });
    saveUser(agentDir, {
      chatKey: "discord/bot:not-accepted-room",
      messageId: "not-accepted",
      acceptedAt: "",
    });
    saveUser(agentDir, {
      chatKey: "discord/bot:stale-room",
      messageId: "stale",
      acceptedAt: "2026-07-14T00:00:00.000Z",
    });
    saveUser(agentDir, {
      chatKey: "discord/bot:processed-room",
      messageId: "processed",
      processedAt: "2026-07-15T00:00:20.000Z",
    });
    saveUser(agentDir, { messageId: "existing" });
    inbox.enqueueChatInboxItem(agentDir, input("existing"));

    store.saveChatMessage(agentDir, {
      chatKey: "discord/bot:reply-room",
      platform: "discord",
      botId: "bot",
      chatId: "room",
      chatType: "group",
      messageId: "assistant-reply",
      role: "assistant",
      replyToMessageId: "reply-boundary",
      receivedAt: "2026-07-15T00:00:30.000Z",
      processedAt: "2026-07-15T00:00:30.000Z",
      deliveryKind: "final",
      text: "final response",
    } as any);
    saveUser(agentDir, {
      chatKey: "discord/bot:reply-room",
      messageId: "reply-boundary",
    });

    saveUser(agentDir, {
      chatKey: "discord/bot:superseded-room",
      messageId: "superseded",
      receivedAt: "2026-07-15T00:00:01.000Z",
    });
    saveUser(agentDir, {
      chatKey: "discord/bot:superseded-room",
      messageId: "later",
      receivedAt: "2026-07-15T00:00:40.000Z",
      processedAt: "2026-07-15T00:00:50.000Z",
    });

    const report = inbox.reconcileChatInboxRecovery(agentDir, {
      nowMs: Date.parse("2026-07-15T00:01:00.000Z"),
      orphans: { maxAgeMs: 60_000, limit: 20 },
    });
    assert.ok(
      report.restoredOrphans.some((entry) => entry.messageId === "restore"),
    );
    assert.ok(report.skippedOrphans.notAccepted >= 1);
    assert.ok(report.skippedOrphans.stale >= 1);
    assert.ok(report.skippedOrphans.processed >= 1);
    assert.ok(report.skippedOrphans.replyBoundary >= 1);
    assert.ok(report.skippedOrphans.superseded >= 1);
    assert.ok(report.skippedOrphans.existingInbox >= 1);

    const restored = inbox.restoreOrphanedAcceptedChatInboxItems(agentDir, {
      nowMs: Date.parse("2026-07-15T00:01:00.000Z"),
      maxAgeMs: 0,
      limit: 1,
    });
    assert.ok(restored.length <= 1);

    const defaults = inbox.reconcileChatInboxRecovery(agentDir);
    assert.ok(Array.isArray(defaults.restoredProcessing));
    assert.equal(typeof defaults.skippedOrphans.invalid, "number");
  });
});
