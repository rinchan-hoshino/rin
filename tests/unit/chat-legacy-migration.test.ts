import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const database = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "database.js")).href
);
const legacyMigration = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat", "legacy-migration.js"),
  ).href
);
const inbox = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "inbox.js")).href
);
const outbox = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "chat-outbox.js"))
    .href
);
const messageStore = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js"))
    .href
);

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-migration-"));
}

function legacyMessage(messageId = "legacy-message") {
  return {
    version: 1,
    recordKey: `record-${messageId}`,
    chatKey: "telegram/1:2",
    messageId,
    role: "user",
    platform: "telegram",
    botId: "1",
    chatId: "2",
    receivedAt: "2026-07-14T01:00:00.000Z",
    acceptedAt: "2026-07-14T01:00:01.000Z",
    text: `text ${messageId}`,
  };
}

function legacyInbox(messageId = "legacy-inbox") {
  return {
    version: 1,
    itemId: `turn-${messageId}`,
    chatKey: "telegram/1:2",
    messageId,
    createdAt: "2026-07-14T01:00:00.000Z",
    updatedAt: "2026-07-14T01:00:01.000Z",
    attemptCount: 2,
    routing: {
      chatType: "private",
      isDirect: true,
      mentionLike: false,
      text: "queued",
    },
    session: {
      platform: "telegram",
      selfId: "1",
      channelId: "2",
      userId: "owner",
      messageId,
      content: "queued",
      stripped: { content: "queued" },
    },
    elements: [{ type: "text", attrs: { content: "queued" } }],
  };
}

function legacyOutbox(id = "legacy-outbox") {
  return {
    id,
    status: "queued",
    createdAt: "2026-07-14T01:00:02.000Z",
    updatedAt: "2026-07-14T01:00:02.000Z",
    sequence: 10,
    deliveryKind: "final",
    attempts: 1,
    payload: {
      createdAt: "2026-07-14T01:00:02.000Z",
      chatKey: "telegram/1:2",
      parts: [{ type: "text", text: "answer" }],
    },
  };
}

test("legacy message, inbox, and outbox authority migrates once into chat.sqlite", async () => {
  const agentDir = await tempDir();
  const chatRoot = path.join(agentDir, "data", "chat");
  await writeJson(
    path.join(chatRoot, "message-store", "records", "aa", "message.json"),
    legacyMessage(),
  );
  await writeJson(
    path.join(
      agentDir,
      "data",
      "koishi-message-store",
      "records",
      "bb",
      "fallback.json",
    ),
    legacyMessage("legacy-fallback-message"),
  );
  await writeJson(
    path.join(chatRoot, "inbox", "processing", "turn.json"),
    legacyInbox(),
  );
  await writeJson(
    path.join(chatRoot, "outbox", "items", "outbox.json"),
    legacyOutbox(),
  );
  await writeJson(path.join(chatRoot, "outbox", "items", "sending.json"), {
    ...legacyOutbox("legacy-sending-outbox"),
    status: "sending",
    deliveryResult: [],
  });

  const db = database.migrateChatDatabaseForInstall(agentDir);
  assert.equal(
    messageStore.getChatMessage(agentDir, "telegram/1:2", "legacy-message")
      ?.text,
    "text legacy-message",
  );
  assert.equal(
    messageStore.getChatMessage(
      agentDir,
      "telegram/1:2",
      "legacy-fallback-message",
    )?.text,
    "text legacy-fallback-message",
  );
  assert.equal(
    inbox.getChatInboxItem(agentDir, "turn-legacy-inbox")?.state,
    "pending",
  );
  assert.equal(
    outbox.readChatOutboxItemById(agentDir, "legacy-outbox")?.item.status,
    "queued",
  );
  const ambiguousLegacySend = outbox.readChatOutboxItemById(
    agentDir,
    "legacy-sending-outbox",
  )?.item;
  assert.equal(ambiguousLegacySend.status, "delivered");
  assert.equal(ambiguousLegacySend.deliveryUnconfirmed, true);
  assert.equal(
    db
      .prepare(
        "SELECT value FROM schema_meta WHERE key = 'legacy_control_migration'",
      )
      .get().value,
    "complete_v1",
  );
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  assert.ok(
    await fs.stat(path.join(chatRoot, "legacy-migrated-v1", "message-records")),
  );
  assert.ok(
    await fs.stat(
      path.join(chatRoot, "legacy-migrated-v1", "message-records-1"),
    ),
  );
  assert.ok(await fs.stat(path.join(chatRoot, "legacy-migrated-v1", "inbox")));
  assert.ok(await fs.stat(path.join(chatRoot, "legacy-migrated-v1", "outbox")));
  await assert.rejects(fs.stat(path.join(chatRoot, "inbox")));
  await assert.rejects(fs.stat(path.join(chatRoot, "outbox")));

  database.closeChatDatabase(agentDir);
  const reopened = database.migrateChatDatabaseForInstall(agentDir);
  assert.equal(
    reopened.prepare("SELECT COUNT(*) AS value FROM messages").get().value,
    3,
  );
  assert.equal(
    reopened.prepare("SELECT COUNT(*) AS value FROM turns").get().value,
    1,
  );
  assert.equal(
    reopened.prepare("SELECT COUNT(*) AS value FROM outbox").get().value,
    2,
  );
});

test("retired adapter archives with unqualified keys migrate from persisted identity", async () => {
  const agentDir = await tempDir();
  const chatRoot = path.join(agentDir, "data", "chat");
  const matrixChatKey = "matrix:!room:matrix.example";
  await writeJson(
    path.join(chatRoot, "message-store", "records", "aa", "matrix.json"),
    {
      ...legacyMessage("archived-matrix"),
      chatKey: matrixChatKey,
      platform: "matrix",
      botId: "",
      chatId: "!room:matrix.example",
    },
  );
  const githubChatKey = "github:private:owner/repo#issue/1";
  await writeJson(path.join(chatRoot, "inbox", "failed", "github.json"), {
    ...legacyInbox("archived-github"),
    chatKey: githubChatKey,
    session: {
      ...legacyInbox("archived-github").session,
      platform: "github",
      selfId: "",
      channelId: "private:owner/repo#issue/1",
    },
  });

  const db = database.migrateChatDatabaseForInstall(agentDir);
  assert.equal(
    messageStore.getChatMessage(agentDir, matrixChatKey, "archived-matrix")
      ?.text,
    "text archived-matrix",
  );
  assert.equal(
    messageStore.getChatMessage(agentDir, githubChatKey, "archived-github")
      ?.text,
    "queued",
  );
  for (const messageId of ["archived-matrix", "archived-github"]) {
    assert.equal(
      db
        .prepare("SELECT bot_id FROM messages WHERE message_id = ?")
        .get(messageId).bot_id,
      null,
    );
  }
  assert.equal(
    inbox.getChatInboxItem(agentDir, "turn-archived-github")?.state,
    "failed",
  );
  assert.equal(
    db
      .prepare(
        "SELECT value FROM schema_meta WHERE key = 'legacy_control_migration'",
      )
      .get().value,
    "complete_v1",
  );
});

test("non-authoritative manual and invalid outbox archives do not re-enter delivery", async () => {
  const agentDir = await tempDir();
  const chatRoot = path.join(agentDir, "data", "chat");
  await writeJson(
    path.join(chatRoot, "outbox", "items", "active.json"),
    legacyOutbox("active-outbox"),
  );
  for (const directory of ["archived-manual", "invalid"]) {
    await writeJson(
      path.join(chatRoot, "outbox", directory, `${directory}.json`),
      {
        id: `${directory}-outbox`,
        status: "queued",
        createdAt: "2026-07-14T02:00:00.000Z",
        payload: { chatKey: "telegram/1:2" },
      },
    );
  }

  const db = database.migrateChatDatabaseForInstall(agentDir);
  assert.equal(
    outbox.readChatOutboxItemById(agentDir, "active-outbox")?.item.status,
    "queued",
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS value FROM outbox").get().value,
    1,
  );
  assert.ok(
    await fs.stat(
      path.join(
        chatRoot,
        "legacy-migrated-v1",
        "outbox",
        "archived-manual",
        "archived-manual.json",
      ),
    ),
  );
  assert.ok(
    await fs.stat(
      path.join(
        chatRoot,
        "legacy-migrated-v1",
        "outbox",
        "invalid",
        "invalid.json",
      ),
    ),
  );
});

test("mismatched archived identity blocks authority cutover", async () => {
  const agentDir = await tempDir();
  await writeJson(
    path.join(
      agentDir,
      "data",
      "chat",
      "message-store",
      "records",
      "aa",
      "mismatch.json",
    ),
    {
      ...legacyMessage("mismatched-archive"),
      chatKey: "matrix:!expected:matrix.example",
      platform: "matrix",
      botId: "",
      chatId: "!different:matrix.example",
    },
  );

  assert.throws(
    () => database.migrateChatDatabaseForInstall(agentDir),
    /chat_legacy_migration_invalid_message_identity/,
  );
  const inspect = new (await import("better-sqlite3")).default(
    database.chatDatabasePath(agentDir),
  );
  assert.equal(
    inspect.prepare("SELECT COUNT(*) AS value FROM messages").get().value,
    0,
  );
  inspect.close();
});

test("archived keys with slash and later colon cannot bypass identity validation", async () => {
  const agentDir = await tempDir();
  await writeJson(
    path.join(
      agentDir,
      "data",
      "chat",
      "message-store",
      "records",
      "aa",
      "github-mismatch.json",
    ),
    {
      ...legacyMessage("mismatched-github-archive"),
      chatKey: "github:private:owner/repo#issue/1:thread",
      platform: "github",
      botId: "",
      chatId: "private:owner/repo#issue/2:thread",
    },
  );

  assert.throws(
    () => database.migrateChatDatabaseForInstall(agentDir),
    /chat_legacy_migration_invalid_message_identity/,
  );
});

test("active unqualified records defer without blocking SQLite cutover", async () => {
  const agentDir = await tempDir();
  await writeJson(
    path.join(
      agentDir,
      "data",
      "chat",
      "message-store",
      "records",
      "aa",
      "active.json",
    ),
    {
      ...legacyMessage("unmigrated-active"),
      chatKey: "telegram:2",
      platform: "telegram",
      botId: "1",
      chatId: "2",
    },
  );

  const db = database.migrateChatDatabaseForInstall(agentDir);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS value FROM messages").get().value,
    0,
  );
  const retry = legacyMigration.retryUnresolvedLegacyChatKeyMessages(
    agentDir,
    db,
  );
  assert.equal(retry.resolvedRecords, 1);
  assert.equal(retry.unresolvedRecords, 0);
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS value FROM messages WHERE chat_key = 'telegram/1:2'",
      )
      .get().value,
    1,
  );
});

test("malformed legacy JSON blocks authority cutover without partial rows", async () => {
  const agentDir = await tempDir();
  const badPath = path.join(
    agentDir,
    "data",
    "chat",
    "inbox",
    "pending",
    "bad.json",
  );
  await fs.mkdir(path.dirname(badPath), { recursive: true });
  await fs.writeFile(badPath, "{bad json\n");

  assert.throws(
    () => database.migrateChatDatabaseForInstall(agentDir),
    /chat_legacy_migration_invalid_json/,
  );
  database.closeChatDatabase(agentDir);
  await writeJson(badPath, legacyInbox("repaired"));
  const db = database.migrateChatDatabaseForInstall(agentDir);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS value FROM turns").get().value,
    1,
  );
  assert.equal(
    db
      .prepare(
        "SELECT value FROM schema_meta WHERE key = 'legacy_control_migration'",
      )
      .get().value,
    "complete_v1",
  );
});

test("legacy outbox missing media blocks authority cutover", async () => {
  const agentDir = await tempDir();
  const legacy = legacyOutbox("missing-media");
  legacy.payload.parts = [
    { type: "image", path: "/definitely/missing/legacy-image.png" },
  ];
  await writeJson(
    path.join(agentDir, "data", "chat", "outbox", "items", "missing.json"),
    legacy,
  );

  assert.throws(
    () => database.migrateChatDatabaseForInstall(agentDir),
    /chat_outbox_media_missing:image/,
  );
  const inspect = new (await import("better-sqlite3")).default(
    database.chatDatabasePath(agentDir),
  );
  assert.equal(
    inspect.prepare("SELECT COUNT(*) AS value FROM outbox").get().value,
    0,
  );
  inspect.close();
});

test("terminal legacy outbox history tolerates cleaned local media", async () => {
  const agentDir = await tempDir();
  const legacy = legacyOutbox("delivered-missing-media");
  legacy.status = "delivered";
  legacy.deliveredAt = "2026-07-14T02:00:00.000Z";
  legacy.payload.parts = [
    { type: "image", path: "/already/cleaned/legacy-image.png" },
  ];
  await writeJson(
    path.join(agentDir, "data", "chat", "outbox", "items", "history.json"),
    legacy,
  );

  database.migrateChatDatabaseForInstall(agentDir);
  assert.equal(
    outbox.readChatOutboxItemById(agentDir, "delivered-missing-media").item
      .status,
    "delivered",
  );
});

test("concurrent cold opens serialize one legacy import and archive", async () => {
  const agentDir = await tempDir();
  const chatRoot = path.join(agentDir, "data", "chat");
  for (let index = 0; index < 20; index += 1) {
    await writeJson(
      path.join(
        chatRoot,
        "message-store",
        "records",
        String(index).padStart(2, "0"),
        `${index}.json`,
      ),
      legacyMessage(`concurrent-${index}`),
    );
  }
  const moduleUrl = pathToFileURL(
    path.join(rootDir, "dist", "core", "chat", "database.js"),
  ).href;
  const code = `
    const database = await import(process.env.CHAT_DATABASE_URL);
    database.migrateChatDatabaseForInstall(process.env.AGENT_DIR);
    database.closeChatDatabase(process.env.AGENT_DIR);
  `;
  await Promise.all(
    Array.from({ length: 8 }, () =>
      execFileAsync(process.execPath, ["--input-type=module", "-e", code], {
        env: {
          ...process.env,
          AGENT_DIR: agentDir,
          CHAT_DATABASE_URL: moduleUrl,
        },
        timeout: 30_000,
      }),
    ),
  );
  const db = database.migrateChatDatabaseForInstall(agentDir);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS value FROM messages").get().value,
    20,
  );
  assert.equal(
    db
      .prepare(
        "SELECT value FROM schema_meta WHERE key = 'legacy_control_migration'",
      )
      .get().value,
    "complete_v1",
  );
  assert.ok(
    await fs.stat(path.join(chatRoot, "legacy-migrated-v1", "message-records")),
  );
});

test("legacy archive resumes after a process dies between path renames", async () => {
  const agentDir = await tempDir();
  const chatRoot = path.join(agentDir, "data", "chat");
  await writeJson(
    path.join(chatRoot, "inbox", "pending", "resumed.json"),
    legacyInbox("archive-resume"),
  );
  const db = database.migrateChatDatabaseForInstall(agentDir);
  database.closeChatDatabase(agentDir);
  await fs.rename(
    path.join(chatRoot, "legacy-migrated-v1", "inbox"),
    path.join(chatRoot, "inbox"),
  );
  const raw = new (await import("better-sqlite3")).default(
    database.chatDatabasePath(agentDir),
  );
  raw.exec(
    `DELETE FROM schema_meta
     WHERE key IN ('legacy_control_migration',
                   'legacy_control_migration_source_fingerprint')`,
  );
  raw.close();

  const reopened = database.migrateChatDatabaseForInstall(agentDir);
  assert.equal(
    reopened
      .prepare(
        `SELECT value FROM schema_meta
         WHERE key = 'legacy_control_migration'`,
      )
      .get().value,
    "complete_v1",
  );
  assert.equal(
    inbox.getChatInboxItem(agentDir, "turn-archive-resume")?.state,
    "pending",
  );
  assert.ok(await fs.stat(path.join(chatRoot, "legacy-migrated-v1", "inbox")));
  await assert.rejects(fs.stat(path.join(chatRoot, "inbox")));
});

test("legacy authority recreated after completed cutover blocks startup", async () => {
  const agentDir = await tempDir();
  database.migrateChatDatabaseForInstall(agentDir);
  database.closeChatDatabase(agentDir);
  await writeJson(
    path.join(agentDir, "data", "chat", "outbox", "items", "late.json"),
    legacyOutbox("late-legacy-write"),
  );

  assert.throws(
    () => database.migrateChatDatabaseForInstall(agentDir),
    /chat_legacy_migration_source_recreated/,
  );
});

test("legacy timeline sequence prevents replaying older pending work after newer handled history", async () => {
  const agentDir = await tempDir();
  const chatRoot = path.join(agentDir, "data", "chat");
  const newer = {
    ...legacyMessage("newer-handled"),
    receivedAt: "2026-07-14T02:00:00.000Z",
    processedAt: "2026-07-14T02:00:01.000Z",
  };
  const older = {
    ...legacyInbox("older-pending"),
    createdAt: "2026-07-14T09:00:00.000+08:00",
  };
  await writeJson(
    path.join(chatRoot, "message-store", "records", "00", "a.json"),
    newer,
  );
  await writeJson(path.join(chatRoot, "inbox", "pending", "z.json"), older);

  const db = database.migrateChatDatabaseForInstall(agentDir);
  const rows = db
    .prepare("SELECT message_id, sequence FROM messages ORDER BY sequence")
    .all();
  assert.deepEqual(
    rows.map((row) => row.message_id),
    ["older-pending", "newer-handled"],
  );
  assert.equal(db.prepare("SELECT state FROM turns").get().state, "superseded");
  assert.deepEqual(inbox.listPendingChatInboxItems(agentDir), []);
});

test("atomic cutover retry imports legacy writes after marker rollback", async () => {
  const agentDir = await tempDir();
  const db = database.migrateChatDatabaseForInstall(agentDir);
  database.closeChatDatabase(agentDir);
  const source = path.join(agentDir, "data", "chat", "inbox");
  await writeJson(
    path.join(source, "pending", "already-imported.json"),
    legacyInbox("must-not-reimport"),
  );

  const raw = new (await import("better-sqlite3")).default(
    database.chatDatabasePath(agentDir),
  );
  raw.exec(
    `DELETE FROM schema_meta
     WHERE key IN ('legacy_control_migration',
                   'legacy_control_migration_source_fingerprint')`,
  );
  raw.close();

  const reopened = database.migrateChatDatabaseForInstall(agentDir);
  assert.equal(
    reopened.prepare("SELECT COUNT(*) AS value FROM turns").get().value,
    1,
  );
  assert.equal(
    reopened.prepare("SELECT message_id FROM messages").get().message_id,
    "must-not-reimport",
  );
  assert.equal(
    reopened
      .prepare(
        "SELECT value FROM schema_meta WHERE key = 'legacy_control_migration'",
      )
      .get().value,
    "complete_v1",
  );
  await assert.rejects(fs.stat(source));
});
