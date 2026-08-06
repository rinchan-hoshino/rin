import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const migration = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat", "chat-key-migration.js"),
  ).href
);
const recordResolution = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat", "chat-key-record-resolution.js"),
  ).href
);
const installMigration = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat", "install-migration.js"),
  ).href
);
const database = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "database.js")).href
);
const messageStore = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js"))
    .href
);

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeRecord(
  agentDir: string,
  input: {
    chatKey: string;
    messageId: string;
    platform: string;
    chatId: string;
    botId?: string;
    role?: "user" | "assistant";
    replyToMessageId?: string;
    sessionFile?: string;
    receivedAt: string;
  },
) {
  const recordKey = createHash("sha1")
    .update(`${input.chatKey}\n${input.messageId}`)
    .digest("hex");
  const filePath = path.join(
    agentDir,
    "data",
    "chat",
    "message-store",
    "records",
    recordKey.slice(0, 2),
    `${recordKey}.json`,
  );
  await writeJson(filePath, { version: 1, recordKey, ...input });
  return { filePath, recordKey };
}

async function readStoredRecords(agentDir: string) {
  const root = path.join(agentDir, "data", "chat", "message-store", "records");
  const files: string[] = [];
  const visit = async (dir: string) => {
    let entries: Awaited<ReturnType<typeof fs.readdir>> = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(filePath);
      else if (entry.isFile() && entry.name.endsWith(".json")) {
        files.push(filePath);
      }
    }
  };
  await visit(root);
  return await Promise.all(
    files.map(async (filePath) =>
      JSON.parse(await fs.readFile(filePath, "utf8")),
    ),
  );
}

test("historical evidence resolver covers the production-sized recovery distribution", () => {
  const records: any[] = [
    {
      version: 1,
      recordKey: "reply-anchor",
      chatKey: "telegram/100:reply-room",
      messageId: "reply-owner",
      platform: "telegram",
      botId: "100",
      chatId: "reply-room",
      role: "user",
      receivedAt: "2026-07-01T00:00:00.000Z",
    },
    {
      version: 1,
      recordKey: "session-anchor",
      chatKey: "discord/200:session-room",
      messageId: "session-owner",
      platform: "discord",
      botId: "200",
      chatId: "session-room",
      role: "user",
      sessionFile: "sessions/shared.jsonl",
      receivedAt: "2026-07-01T01:00:00.000Z",
    },
    {
      version: 1,
      recordKey: "neighbor-before",
      chatKey: "slack/U300:neighbor-room",
      messageId: "neighbor-before",
      platform: "slack",
      botId: "U300",
      chatId: "neighbor-room",
      role: "user",
      receivedAt: "2026-07-01T02:00:00.000Z",
    },
    {
      version: 1,
      recordKey: "neighbor-after",
      chatKey: "slack/U300:neighbor-room",
      messageId: "neighbor-after",
      platform: "slack",
      botId: "U300",
      chatId: "neighbor-room",
      role: "user",
      receivedAt: "2026-07-01T04:00:00.000Z",
    },
  ];
  for (let index = 0; index < 12_382; index += 1) {
    records.push({
      version: 1,
      recordKey: `reply-${index}`,
      chatKey: "telegram:reply-room",
      messageId: `reply-${index}`,
      platform: "telegram",
      chatId: "reply-room",
      role: "assistant",
      replyToMessageId: "reply-owner",
      receivedAt: `2026-07-01T00:${String(index % 60).padStart(2, "0")}:01.000Z`,
    });
  }
  for (let index = 0; index < 653; index += 1) {
    records.push({
      version: 1,
      recordKey: `session-${index}`,
      chatKey: "discord:session-room",
      messageId: `session-${index}`,
      platform: "discord",
      chatId: "session-room",
      role: "assistant",
      sessionFile: "sessions/shared.jsonl",
      receivedAt: `2026-07-01T01:${String(index % 60).padStart(2, "0")}:01.000Z`,
    });
  }
  for (let index = 0; index < 470; index += 1) {
    records.push({
      version: 1,
      recordKey: `neighbor-${index}`,
      chatKey: "slack:neighbor-room",
      messageId: `neighbor-${index}`,
      platform: "slack",
      chatId: "neighbor-room",
      role: "assistant",
      receivedAt: `2026-07-01T03:${String(index % 60).padStart(2, "0")}:01.000Z`,
    });
  }

  const resolutions =
    recordResolution.resolveLegacyChatKeyRecordBotIds(records);
  const sources = resolutions.reduce(
    (counts: Record<string, number>, resolution: any) => {
      if (resolution.source && resolution.source !== "persisted") {
        counts[resolution.source] = (counts[resolution.source] || 0) + 1;
      }
      return counts;
    },
    {},
  );
  assert.deepEqual(sources, { reply: 12_382, session: 653, neighbor: 470 });
  assert.equal(
    resolutions.filter((resolution: any) => resolution.reason).length,
    0,
  );
});

test("historical evidence resolver covers every bot-qualified platform", () => {
  const platforms = [
    "telegram",
    "onebot",
    "discord",
    "lark",
    "slack",
    "minecraft",
  ];
  const records = platforms.flatMap((platform, index) => {
    const botId = `bot-${index}`;
    const chatId = `chat-${index}`;
    return [
      {
        version: 1,
        recordKey: `${platform}-owner`,
        chatKey: `${platform}/${botId}:${chatId}`,
        messageId: `${platform}-owner`,
        platform,
        botId,
        chatId,
        role: "user",
        receivedAt: "2026-07-01T00:00:00.000Z",
      },
      {
        version: 1,
        recordKey: `${platform}-assistant`,
        chatKey: `${platform}:${chatId}`,
        messageId: `${platform}-assistant`,
        platform,
        chatId,
        role: "assistant",
        replyToMessageId: `${platform}-owner`,
        receivedAt: "2026-07-01T00:00:01.000Z",
      },
    ];
  });
  const resolutions =
    recordResolution.resolveLegacyChatKeyRecordBotIds(records);
  platforms.forEach((platform, index) => {
    assert.deepEqual(resolutions[index * 2 + 1], {
      botId: `bot-${index}`,
      source: "reply",
    });
  });
});

test("stronger evidence and invalid temporal evidence never guess ownership", () => {
  const records: any[] = [
    {
      version: 1,
      recordKey: "owner-a",
      chatKey: "discord/A:room",
      messageId: "shared-owner",
      platform: "discord",
      botId: "A",
      chatId: "room",
      receivedAt: "2026-07-01T00:00:00.000Z",
    },
    {
      version: 1,
      recordKey: "owner-b",
      chatKey: "discord/B:room",
      messageId: "shared-owner",
      platform: "discord",
      botId: "B",
      chatId: "room",
      receivedAt: "2026-07-01T00:00:00.000Z",
    },
    {
      version: 1,
      recordKey: "reply-conflict",
      chatKey: "discord:room",
      messageId: "reply-conflict",
      platform: "discord",
      chatId: "room",
      replyToMessageId: "shared-owner",
      receivedAt: "2026-07-01T00:00:01.000Z",
    },
    {
      version: 1,
      recordKey: "session-a",
      chatKey: "onebot/A:group",
      messageId: "session-a",
      platform: "onebot",
      botId: "A",
      chatId: "group",
      sessionFile: "shared.jsonl",
      receivedAt: "2026-07-01T01:00:00.000Z",
    },
    {
      version: 1,
      recordKey: "session-b",
      chatKey: "onebot/B:group",
      messageId: "session-b",
      platform: "onebot",
      botId: "B",
      chatId: "group",
      sessionFile: "shared.jsonl",
      receivedAt: "2026-07-01T01:00:01.000Z",
    },
    {
      version: 1,
      recordKey: "session-conflict",
      chatKey: "onebot:group",
      messageId: "session-conflict",
      platform: "onebot",
      chatId: "group",
      sessionFile: "shared.jsonl",
      receivedAt: "2026-07-01T01:00:02.000Z",
    },
    {
      version: 1,
      recordKey: "persisted",
      chatKey: "telegram:room",
      messageId: "persisted",
      platform: "telegram",
      botId: "persisted-bot",
      chatId: "room",
      replyToMessageId: "other-bot-owner",
      receivedAt: "invalid",
    },
    {
      version: 1,
      recordKey: "other-bot-owner",
      chatKey: "telegram/other-bot:room",
      messageId: "other-bot-owner",
      platform: "telegram",
      botId: "other-bot",
      chatId: "room",
      receivedAt: "2026-07-01T02:00:00.000Z",
    },
    {
      version: 1,
      recordKey: "same-time",
      chatKey: "telegram:room",
      messageId: "same-time",
      platform: "telegram",
      chatId: "room",
      receivedAt: "2026-07-01T02:00:00.000Z",
    },
    {
      version: 1,
      recordKey: "missing-time",
      chatKey: "telegram:room",
      messageId: "missing-time",
      platform: "telegram",
      chatId: "room",
      receivedAt: "invalid",
    },
    {
      version: 1,
      recordKey: "priority-anchor-a",
      chatKey: "lark/A:priority-room",
      messageId: "priority-anchor-a",
      platform: "lark",
      botId: "A",
      chatId: "priority-room",
      sessionFile: "priority-a.jsonl",
      receivedAt: "2026-07-01T03:00:00.000Z",
    },
    {
      version: 1,
      recordKey: "priority-anchor-b",
      chatKey: "lark/B:priority-room",
      messageId: "priority-anchor-b",
      platform: "lark",
      botId: "B",
      chatId: "priority-room",
      sessionFile: "priority-b.jsonl",
      receivedAt: "2026-07-01T03:00:00.000Z",
    },
    {
      version: 1,
      recordKey: "priority-target",
      chatKey: "lark:priority-room",
      messageId: "priority-target",
      platform: "lark",
      chatId: "priority-room",
      sessionFile: "priority-b.jsonl",
      receivedAt: "2026-07-01T03:00:01.000Z",
    },
    {
      version: 1,
      recordKey: "priority-reply",
      chatKey: "lark:priority-room",
      messageId: "priority-reply",
      platform: "lark",
      chatId: "priority-room",
      sessionFile: "priority-a.jsonl",
      replyToMessageId: "priority-target",
      receivedAt: "2026-07-01T03:00:02.000Z",
    },
  ];
  const resolutions =
    recordResolution.resolveLegacyChatKeyRecordBotIds(records);
  assert.equal(resolutions[2].reason, "reply_conflict");
  assert.equal(resolutions[5].reason, "session_conflict");
  assert.deepEqual(resolutions[6], {
    botId: "persisted-bot",
    source: "persisted",
  });
  assert.equal(resolutions[8].reason, "unresolved");
  assert.equal(resolutions[9].reason, "unresolved");
  assert.deepEqual(resolutions[12], { botId: "B", source: "session" });
  assert.deepEqual(resolutions[13], { botId: "B", source: "reply" });
});

test("equal-time anchors block temporal inference even when surrounding anchors agree", () => {
  const records: any[] = [
    {
      version: 1,
      recordKey: "before",
      chatKey: "slack/A:room",
      messageId: "before",
      platform: "slack",
      botId: "A",
      chatId: "room",
      receivedAt: "2026-07-01T00:00:00.000Z",
    },
    {
      version: 1,
      recordKey: "equal",
      chatKey: "slack/B:room",
      messageId: "equal",
      platform: "slack",
      botId: "B",
      chatId: "room",
      receivedAt: "2026-07-01T00:00:01.000Z",
    },
    {
      version: 1,
      recordKey: "target",
      chatKey: "slack:room",
      messageId: "target",
      platform: "slack",
      chatId: "room",
      receivedAt: "2026-07-01T00:00:01.000Z",
    },
    {
      version: 1,
      recordKey: "after",
      chatKey: "slack/A:room",
      messageId: "after",
      platform: "slack",
      botId: "A",
      chatId: "room",
      receivedAt: "2026-07-01T00:00:02.000Z",
    },
  ];
  const resolutions =
    recordResolution.resolveLegacyChatKeyRecordBotIds(records);
  assert.equal(resolutions[2].reason, "unresolved");
});

test("reply evidence does not propagate transitively or depend on record order", () => {
  const anchor: any = {
    version: 1,
    recordKey: "anchor",
    chatKey: "telegram/bot:room",
    messageId: "anchor",
    platform: "telegram",
    botId: "bot",
    chatId: "room",
    receivedAt: "2026-07-01T00:00:00.000Z",
  };
  const middle: any = {
    version: 1,
    recordKey: "middle",
    chatKey: "telegram:room",
    messageId: "middle",
    platform: "telegram",
    chatId: "room",
    replyToMessageId: "anchor",
    receivedAt: "invalid",
  };
  const tail: any = {
    version: 1,
    recordKey: "tail",
    chatKey: "telegram:room",
    messageId: "tail",
    platform: "telegram",
    chatId: "room",
    replyToMessageId: "middle",
    receivedAt: "invalid",
  };
  for (const records of [
    [anchor, middle, tail],
    [anchor, tail, middle],
  ]) {
    const resolutions =
      recordResolution.resolveLegacyChatKeyRecordBotIds(records);
    const byMessageId = new Map(
      records.map((record, index) => [record.messageId, resolutions[index]]),
    );
    assert.deepEqual(byMessageId.get("middle"), {
      botId: "bot",
      source: "reply",
    });
    assert.equal(byMessageId.get("tail")?.reason, "unresolved");
  }
});

test("chat key migration recovers bot ownership from platform-neutral historical evidence", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-key-evidence-recovery-"),
  );
  const settingsPath = path.join(agentDir, "settings.json");
  const settings = { chat: {} };
  await writeJson(settingsPath, settings);

  try {
    await writeRecord(agentDir, {
      chatKey: "telegram/100:room",
      messageId: "telegram-owner",
      platform: "telegram",
      botId: "100",
      chatId: "room",
      role: "user",
      receivedAt: "2026-07-01T00:00:00.000Z",
    });
    await writeRecord(agentDir, {
      chatKey: "telegram:room",
      messageId: "telegram-assistant",
      platform: "telegram",
      chatId: "room",
      role: "assistant",
      replyToMessageId: "telegram-owner",
      receivedAt: "2026-07-01T00:00:01.000Z",
    });

    await writeRecord(agentDir, {
      chatKey: "discord/200:room",
      messageId: "discord-owner",
      platform: "discord",
      botId: "200",
      chatId: "room",
      role: "user",
      sessionFile: "sessions/shared-discord.jsonl",
      receivedAt: "2026-07-01T01:00:00.000Z",
    });
    await writeRecord(agentDir, {
      chatKey: "discord:room",
      messageId: "discord-assistant",
      platform: "discord",
      chatId: "room",
      role: "assistant",
      sessionFile: "sessions/shared-discord.jsonl",
      receivedAt: "2026-07-01T01:00:01.000Z",
    });

    await writeRecord(agentDir, {
      chatKey: "slack/U300:room",
      messageId: "slack-before",
      platform: "slack",
      botId: "U300",
      chatId: "room",
      role: "user",
      receivedAt: "2026-07-01T02:00:00.000Z",
    });
    await writeRecord(agentDir, {
      chatKey: "slack:room",
      messageId: "slack-assistant",
      platform: "slack",
      chatId: "room",
      role: "assistant",
      receivedAt: "2026-07-01T02:00:01.000Z",
    });
    await writeRecord(agentDir, {
      chatKey: "slack/U300:room",
      messageId: "slack-after",
      platform: "slack",
      botId: "U300",
      chatId: "room",
      role: "user",
      receivedAt: "2026-07-01T02:00:02.000Z",
    });

    const preflight = migration.preflightLegacyChatKeys(agentDir, settings);
    assert.equal(preflight.migratedRecords, 3);
    assert.equal(preflight.unresolvedRecords, 0);
    assert.deepEqual(preflight.resolvedRecords, {
      persisted: 0,
      reply: 1,
      session: 1,
      neighbor: 1,
    });

    const result = migration.migrateLegacyChatKeys(
      agentDir,
      settingsPath,
      settings,
    );
    assert.equal(result.unresolvedRecords, 0);
    assert.deepEqual(result.resolvedRecords, preflight.resolvedRecords);
    const records = await readStoredRecords(agentDir);
    assert.ok(
      records.some(
        (record) =>
          record.messageId === "telegram-assistant" &&
          record.chatKey === "telegram/100:room" &&
          record.botId === "100",
      ),
    );
    assert.ok(
      records.some(
        (record) =>
          record.messageId === "discord-assistant" &&
          record.chatKey === "discord/200:room" &&
          record.botId === "200",
      ),
    );
    assert.ok(
      records.some(
        (record) =>
          record.messageId === "slack-assistant" &&
          record.chatKey === "slack/U300:room" &&
          record.botId === "U300",
      ),
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("conflicting historical evidence remains unresolved instead of guessing", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-key-evidence-conflict-"),
  );
  const settingsPath = path.join(agentDir, "settings.json");
  const settings = { chat: {} };
  await writeJson(settingsPath, settings);
  try {
    await writeRecord(agentDir, {
      chatKey: "onebot/100:group",
      messageId: "before",
      platform: "onebot",
      botId: "100",
      chatId: "group",
      role: "user",
      receivedAt: "2026-07-01T00:00:00.000Z",
    });
    const unresolved = await writeRecord(agentDir, {
      chatKey: "onebot:group",
      messageId: "between",
      platform: "onebot",
      chatId: "group",
      role: "assistant",
      receivedAt: "2026-07-01T00:00:01.000Z",
    });
    await writeRecord(agentDir, {
      chatKey: "onebot/200:group",
      messageId: "after",
      platform: "onebot",
      botId: "200",
      chatId: "group",
      role: "user",
      receivedAt: "2026-07-01T00:00:02.000Z",
    });

    const result = migration.migrateLegacyChatKeys(
      agentDir,
      settingsPath,
      settings,
    );
    assert.equal(result.complete, false);
    assert.equal(result.unresolvedRecords, 1);
    assert.deepEqual(result.unresolvedRecordDetails, [
      { filePath: unresolved.filePath, reason: "neighbor_conflict" },
    ]);
    assert.equal(
      JSON.parse(await fs.readFile(unresolved.filePath, "utf8")).chatKey,
      "onebot:group",
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("pending marker resumes the first archive scan after a pre-cutover crash", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-key-pending-finalize-"),
  );
  const settingsPath = path.join(agentDir, "settings.json");
  const settings = { chat: {} };
  await writeJson(settingsPath, settings);
  await writeJson(
    path.join(
      agentDir,
      "data",
      "chat",
      "legacy-migrated-v1",
      "message-records",
      "aa",
      "archived.json",
    ),
    {
      version: 1,
      recordKey: "legacy-archived",
      chatKey: "telegram:room",
      messageId: "archived",
      platform: "telegram",
      botId: "bot",
      chatId: "room",
      role: "assistant",
      receivedAt: "2026-07-01T00:00:00.000Z",
    },
  );
  try {
    const interrupted = migration.migrateLegacyChatKeys(
      agentDir,
      settingsPath,
      settings,
    );
    assert.equal(interrupted.complete, false);
    assert.equal(
      JSON.parse(
        await fs.readFile(
          path.join(agentDir, "data", "migrations", "chat-key-v1.json"),
          "utf8",
        ),
      ).pendingAuthorityFinalize,
      true,
    );

    const resumed = installMigration.runChatInstallMigrations(
      agentDir,
      settingsPath,
    );
    assert.equal(resumed.keyMigration.complete, true);
    assert.equal(resumed.keyMigration.deferredResolvedRecords, 1);
    const db = database.openChatDatabase(agentDir);
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM messages WHERE chat_key = 'telegram/bot:room'",
        )
        .get().count,
      1,
    );
  } finally {
    database.closeChatDatabase(agentDir);
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("deferred records without message identity remain unresolved without blocking install", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-key-invalid-deferred-"),
  );
  const settingsPath = path.join(agentDir, "settings.json");
  await writeJson(settingsPath, { chat: {} });
  await writeJson(
    path.join(
      agentDir,
      "data",
      "chat",
      "legacy-migrated-v1",
      "message-records",
      "aa",
      "invalid.json",
    ),
    {
      version: 1,
      recordKey: "invalid-deferred",
      chatKey: "telegram:room",
      messageId: "",
      platform: "telegram",
      botId: "bot",
      chatId: "room",
      role: "assistant",
      receivedAt: "2026-07-01T00:00:00.000Z",
    },
  );
  try {
    const result = installMigration.runChatInstallMigrations(
      agentDir,
      settingsPath,
    );
    assert.equal(result.keyMigration.complete, false);
    assert.equal(result.keyMigration.unresolvedRecords, 1);
    assert.deepEqual(result.keyMigration.unresolvedRecordReasons, {
      invalid_message_identity: 1,
    });
    await assert.rejects(
      fs.access(
        path.join(
          agentDir,
          "data",
          "migrations",
          "chat-key-v1-resolved-records.json",
        ),
      ),
    );
  } finally {
    database.closeChatDatabase(agentDir);
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("deferred bot-qualified identity mismatch never writes a resolved ledger entry", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-key-mismatched-deferred-"),
  );
  const settingsPath = path.join(agentDir, "settings.json");
  await writeJson(settingsPath, { chat: {} });
  await writeJson(
    path.join(
      agentDir,
      "data",
      "chat",
      "legacy-migrated-v1",
      "message-records",
      "aa",
      "mismatch.json",
    ),
    {
      version: 1,
      recordKey: "mismatched-deferred",
      chatKey: "telegram:expected-room",
      messageId: "mismatched-deferred",
      platform: "telegram",
      botId: "bot",
      chatId: "different-room",
      role: "assistant",
      receivedAt: "2026-07-01T00:00:00.000Z",
    },
  );
  try {
    const result = installMigration.runChatInstallMigrations(
      agentDir,
      settingsPath,
    );
    assert.equal(result.keyMigration.complete, false);
    assert.equal(result.keyMigration.unresolvedRecords, 1);
    assert.deepEqual(result.keyMigration.unresolvedRecordReasons, {
      invalid_identity: 1,
    });
    await assert.rejects(
      fs.access(
        path.join(
          agentDir,
          "data",
          "migrations",
          "chat-key-v1-resolved-records.json",
        ),
      ),
    );
  } finally {
    database.closeChatDatabase(agentDir);
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("unresolved settings and records together do not block SQLite cutover", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-key-combined-unresolved-"),
  );
  const settingsPath = path.join(agentDir, "settings.json");
  await writeJson(settingsPath, {
    chat: {
      telegram: { token: "" },
      byChatKey: { "telegram:room": { quietMode: true } },
    },
  });
  await writeRecord(agentDir, {
    chatKey: "telegram:room",
    messageId: "unresolved-assistant",
    platform: "telegram",
    chatId: "room",
    role: "assistant",
    receivedAt: "invalid",
  });
  try {
    const result = installMigration.runChatInstallMigrations(
      agentDir,
      settingsPath,
    );
    assert.equal(result.keyMigration.complete, false);
    assert.equal(result.keyMigration.unresolvedSettings, 1);
    assert.equal(result.keyMigration.unresolvedRecords, 1);
    const db = database.openChatDatabase(agentDir);
    assert.equal(Number(db.pragma("user_version", { simple: true })), 10);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM messages").get().count,
      0,
    );
  } finally {
    database.closeChatDatabase(agentDir);
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("unresolved historical ownership stays retryable without blocking install migration", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-key-deferred-recovery-"),
  );
  const settingsPath = path.join(agentDir, "settings.json");
  await writeJson(settingsPath, { chat: {} });
  await writeRecord(agentDir, {
    chatKey: "discord:room",
    messageId: "deferred-assistant",
    platform: "discord",
    chatId: "room",
    role: "assistant",
    replyToMessageId: "future-owner",
    sessionFile: "sessions/deferred.jsonl",
    receivedAt: "2026-07-01T03:00:01.000Z",
  });

  try {
    const first = installMigration.runChatInstallMigrations(
      agentDir,
      settingsPath,
    );
    assert.equal(first.keyMigration.unresolvedRecords, 1);
    assert.equal(first.keyMigration.complete, false);
    let db = database.openChatDatabase(agentDir);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM messages").get().count,
      0,
    );
    database.closeChatDatabase(agentDir);

    messageStore.saveChatMessage(agentDir, {
      chatKey: "discord/200:room",
      messageId: "later-owner",
      platform: "discord",
      botId: "200",
      chatId: "room",
      role: "user",
      sessionFile: "sessions/deferred.jsonl",
      receivedAt: "2026-07-02T00:00:00.000Z",
    });
    database.closeChatDatabase(agentDir);

    const second = installMigration.runChatInstallMigrations(
      agentDir,
      settingsPath,
    );
    assert.equal(second.keyMigration.unresolvedRecords, 0);
    assert.equal(second.keyMigration.complete, true);
    db = database.openChatDatabase(agentDir);
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM messages WHERE chat_key = 'discord/200:room'",
        )
        .get().count,
      2,
    );
    const recovered = JSON.parse(
      db
        .prepare(
          "SELECT record_json FROM messages WHERE message_id = 'deferred-assistant'",
        )
        .get().record_json,
    );
    assert.equal(recovered.botId, "200");
    assert.equal(
      recovered.recordKey,
      messageStore.buildChatMessageRecordKey(
        "discord/200:room",
        "deferred-assistant",
      ),
    );
    database.closeChatDatabase(agentDir);
    const resolvedLedgerPath = path.join(
      agentDir,
      "data",
      "migrations",
      "chat-key-v1-resolved-records.json",
    );
    const resolvedLedger = await fs.readFile(resolvedLedgerPath, "utf8");
    for (const invalidLedger of [
      "{invalid ledger",
      JSON.stringify({ version: 1, records: { bad: null } }),
    ]) {
      await fs.writeFile(resolvedLedgerPath, invalidLedger);
      assert.throws(
        () => installMigration.runChatInstallMigrations(agentDir, settingsPath),
        /chat_key_migration_invalid_resolved_ledger/,
      );
    }
    await fs.writeFile(resolvedLedgerPath, resolvedLedger);
    const repeated = installMigration.runChatInstallMigrations(
      agentDir,
      settingsPath,
    );
    assert.equal(repeated.keyMigration.unresolvedRecords, 0);
    db = database.openChatDatabase(agentDir);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM messages").get().count,
      2,
    );
    messageStore.saveChatMessage(agentDir, {
      chatKey: "discord/300:room",
      messageId: "future-owner",
      platform: "discord",
      botId: "300",
      chatId: "room",
      role: "user",
      receivedAt: "2026-07-03T00:00:00.000Z",
    });
    database.closeChatDatabase(agentDir);
    const changedEvidence = installMigration.runChatInstallMigrations(
      agentDir,
      settingsPath,
    );
    assert.equal(changedEvidence.keyMigration.unresolvedRecords, 0);
    db = database.openChatDatabase(agentDir);
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM messages WHERE message_id = 'deferred-assistant'",
        )
        .get().count,
      1,
    );
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM messages WHERE chat_key = 'discord/300:room' AND message_id = 'deferred-assistant'",
        )
        .get().count,
      0,
    );
    const marker = JSON.parse(
      await fs.readFile(
        path.join(agentDir, "data", "migrations", "chat-key-v1.json"),
        "utf8",
      ),
    );
    assert.equal(marker.complete, true);
  } finally {
    database.closeChatDatabase(agentDir);
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});
