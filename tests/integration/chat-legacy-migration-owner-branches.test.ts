import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const database = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "database.js")).href
);

const validMessage = {
  version: 1,
  recordKey: "record-1",
  chatKey: "telegram/1:2",
  messageId: "message-1",
  role: "user",
  platform: "telegram",
  botId: "1",
  chatId: "2",
  receivedAt: "2026-07-14T01:00:00.000Z",
};
const validInbox = {
  itemId: "turn-1",
  chatKey: "telegram/1:2",
  messageId: "message-1",
  createdAt: "2026-07-14T01:00:00.000Z",
  session: { platform: "telegram", selfId: "1", channelId: "2" },
};
const validOutbox = {
  id: "outbox-1",
  status: "queued",
  createdAt: "2026-07-14T01:00:00.000Z",
  payload: {
    chatKey: "telegram/1:2",
    parts: [{ type: "text", text: "answer" }],
  },
};

async function expectRejectedLegacy(
  relativePath: string,
  value: unknown,
  pattern: RegExp,
) {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-legacy-invalid-"),
  );
  const filePath = path.join(agentDir, "data", "chat", relativePath);
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(value)}\n`);
    assert.throws(
      () => database.migrateChatDatabaseForInstall(agentDir),
      pattern,
    );
  } finally {
    database.closeChatDatabase(agentDir);
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

test("legacy migration rejects malformed message and inbox boundary fields", async () => {
  await expectRejectedLegacy(
    "message-store/records/aa/missing-id.json",
    { ...validMessage, messageId: "" },
    /invalid_message_identity/,
  );
  await expectRejectedLegacy(
    "message-store/records/aa/received.json",
    { ...validMessage, receivedAt: "not-a-date" },
    /invalid_message_timestamp/,
  );
  await expectRejectedLegacy(
    "message-store/records/aa/accepted.json",
    { ...validMessage, acceptedAt: "not-a-date" },
    /invalid_timestamp:acceptedAt/,
  );
  await expectRejectedLegacy(
    "inbox/pending/missing-id.json",
    { ...validInbox, messageId: "" },
    /invalid_inbox:|invalid_message_identity/,
  );
  await expectRejectedLegacy(
    "inbox/pending/accepted.json",
    { ...validInbox, acceptedAt: "not-a-date" },
    /invalid_timestamp:inbox.acceptedAt/,
  );
  await expectRejectedLegacy(
    "inbox/pending/created.json",
    { ...validInbox, createdAt: "not-a-date" },
    /invalid_timestamp:inbox.createdAt|invalid_message_timestamp/,
  );
});

test("legacy migration normalizes optional message and terminal outbox variants", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-legacy-variants-"),
  );
  const chatRoot = path.join(agentDir, "data", "chat");
  try {
    const write = async (relativePath: string, value: unknown) => {
      const filePath = path.join(chatRoot, relativePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, `${JSON.stringify(value)}\n`);
    };
    await write("message-store/records/aa/assistant.json", {
      ...validMessage,
      recordKey: "",
      messageId: "assistant",
      role: "assistant",
      acceptedAt: "",
      processedAt: "2026-07-14T01:00:01.000Z",
      lastReceivedAt: "2026-07-14T01:00:02.000Z",
      updatedAt: "2026-07-14T01:00:03.000Z",
      platformTimestamp: "42",
      elements: [{ type: "text", attrs: { content: "answer" } }],
      quote: { id: "quoted" },
      chatType: "group",
      duplicateCount: -2,
    });
    await write("message-store/records/aa/tie-a.json", {
      ...validMessage,
      recordKey: "tie-a",
      messageId: "tie-a",
      platformTimestamp: "not-a-number",
    });
    await write("message-store/records/zz/tie-b.json", {
      ...validMessage,
      recordKey: "tie-b",
      messageId: "tie-b",
    });
    await write("../koishi-message-store/records/aa/duplicate.json", {
      ...validMessage,
      recordKey: "duplicate-copy",
      messageId: "tie-a",
    });
    await write("outbox/items/failed.json", {
      ...validOutbox,
      id: "failed-outbox",
      status: "failed",
      sequence: "not-a-number",
      attempts: -2,
      updatedAt: "2026-07-14T01:00:01.000Z",
      nextAttemptAt: "2026-07-14T01:00:02.000Z",
      failedAt: "2026-07-14T01:00:03.000Z",
      lastError: "permanent",
      failureKind: "permanent",
      deliveryResult: ["", " provider-1 "],
      postDelivery: { type: "remember" },
    });
    await write("outbox/items/queued.json", {
      ...validOutbox,
      id: "queued-outbox",
      status: "unexpected",
      sequence: undefined,
      deliveryUnconfirmed: true,
    });

    const db = database.migrateChatDatabaseForInstall(agentDir);
    assert.equal(
      db
        .prepare("SELECT role FROM messages WHERE message_id = 'assistant'")
        .get().role,
      "assistant",
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT state, provider_message_id FROM outbox_deliveries ORDER BY outbox_id",
        )
        .all(),
      [
        { state: "failed", provider_message_id: "provider-1" },
        { state: "queued", provider_message_id: null },
      ],
    );
  } finally {
    database.closeChatDatabase(agentDir);
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("legacy migration rejects unsupported keys, unreadable roots, and archive collisions", async () => {
  await expectRejectedLegacy(
    "message-store/records/aa/unsupported.json",
    { ...validMessage, chatKey: "custom:2", platform: "custom", botId: "" },
    /invalid_message_identity/,
  );

  const unreadable = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-legacy-unreadable-"),
  );
  try {
    const inboxPath = path.join(unreadable, "data", "chat", "inbox");
    await fs.mkdir(path.dirname(inboxPath), { recursive: true });
    await fs.writeFile(inboxPath, "not a directory");
    assert.throws(
      () => database.migrateChatDatabaseForInstall(unreadable),
      /ENOTDIR/,
    );
  } finally {
    database.closeChatDatabase(unreadable);
    await fs.rm(unreadable, { recursive: true, force: true });
  }

  const collision = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-legacy-collision-"),
  );
  try {
    const chatRoot = path.join(collision, "data", "chat");
    await fs.mkdir(path.join(chatRoot, "inbox"), { recursive: true });
    await fs.mkdir(path.join(chatRoot, "legacy-migrated-v1", "inbox"), {
      recursive: true,
    });
    assert.throws(
      () => database.migrateChatDatabaseForInstall(collision),
      /chat_legacy_migration_archive_collision/,
    );
  } finally {
    database.closeChatDatabase(collision);
    await fs.rm(collision, { recursive: true, force: true });
  }
});

test("legacy migration rejects malformed outbox timing and payload fields", async () => {
  await expectRejectedLegacy(
    "outbox/items/missing-parts.json",
    { ...validOutbox, payload: { chatKey: "telegram/1:2", parts: [] } },
    /invalid_outbox:/,
  );
  for (const [field, value] of [
    ["createdAt", "not-a-date"],
    ["updatedAt", "not-a-date"],
    ["nextAttemptAt", "not-a-date"],
    ["failedAt", "not-a-date"],
  ]) {
    await expectRejectedLegacy(
      `outbox/items/${field}.json`,
      { ...validOutbox, [field]: value },
      new RegExp(`invalid_timestamp:outbox(?:\\.delivery)?\\.${field}`),
    );
  }
});
