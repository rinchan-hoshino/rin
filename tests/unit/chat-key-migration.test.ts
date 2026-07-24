import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const migration = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat", "chat-key-migration.js"),
  ).href
);
const messageStore = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js"))
    .href
);
const database = {
  ...(await import(
    pathToFileURL(path.join(rootDir, "dist", "core", "chat", "database.js"))
      .href
  )),
  ...(await import(
    pathToFileURL(
      path.join(
        rootDir,
        "dist",
        "core",
        "chat",
        "database-install-migration.js",
      ),
    ).href
  )),
};

test("chat key migration infers configured bot ids without adapter-specific key shapes", () => {
  const botIds = migration.inferChatBotIdsFromSettings({
    chat: {
      telegram: { token: "8623230033:secret" },
      onebot: { selfId: "2301401877" },
      discord: { rin: { token: "MTUxOTkwODk1NjIxMjgyMjExNw.secret" } },
      minecraft: { selfId: "minecraft" },
    },
  });

  assert.deepEqual(botIds, {
    discord: "1519908956212822117",
    minecraft: "minecraft",
    onebot: "2301401877",
    telegram: "8623230033",
  });
});

test("chat key migration preserves historical first-bot ownership for unqualified keys", () => {
  const settings = {
    chat: {
      lark: [
        { appId: "cli_first", appSecret: "first-secret" },
        { appId: "cli_second", appSecret: "second-secret" },
      ],
      byChatKey: {
        "lark:oc_legacy": { turnPolicy: "record_only" },
        "lark/cli_second:oc_current": { quietMode: true },
      },
    },
  };

  const result = migration.rewriteSettingsChatKeys(settings);

  assert.deepEqual(Object.keys(result.settings.chat.byChatKey).sort(), [
    "lark/cli_first:oc_legacy",
    "lark/cli_second:oc_current",
  ]);
});

test("chat key migration canonicalizes legacy unqualified keys through a single bot-qualified shape", () => {
  const botIds = {
    discord: "1519908956212822117",
    onebot: "2301401877",
    telegram: "8623230033",
  };

  assert.equal(
    migration.canonicalizeStoredChatKey("discord:1519918607071576239", botIds),
    "discord/1519908956212822117:1519918607071576239",
  );
  assert.equal(
    migration.canonicalizeStoredChatKey("onebot:private:519418441", botIds),
    "onebot/2301401877:private:519418441",
  );
  assert.equal(
    migration.canonicalizeStoredChatKey(
      "telegram/8623230033:-1001447529496",
      botIds,
    ),
    "telegram/8623230033:-1001447529496",
  );
  assert.equal(
    migration.canonicalizeStoredChatKey("slack:C0123456789", botIds),
    "",
  );
});

test("chat key migration rewrites byChatKey entries without losing settings", () => {
  const settings = {
    chat: {
      byChatKey: {
        "discord:1519918607071576239": { turnPolicy: "record_only" },
        "onebot/2301401877:1067390680": { quietMode: true },
      },
    },
  };

  const result = migration.rewriteSettingsChatKeys(settings, {
    discord: "1519908956212822117",
    onebot: "2301401877",
  });

  assert.deepEqual(result.rewritten, {
    "discord:1519918607071576239":
      "discord/1519908956212822117:1519918607071576239",
  });
  assert.deepEqual(Object.keys(result.settings.chat.byChatKey).sort(), [
    "discord/1519908956212822117:1519918607071576239",
    "onebot/2301401877:1067390680",
  ]);
  assert.deepEqual(
    result.settings.chat.byChatKey[
      "discord/1519908956212822117:1519918607071576239"
    ],
    { turnPolicy: "record_only" },
  );
});

test("chat key migration leaves retired platform archives untouched", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-key-archive-migration-"),
  );
  try {
    const settingsPath = path.join(agentDir, "settings.json");
    const settings = {
      chat: {
        byChatKey: {
          "matrix:archived-room": { quietMode: true },
        },
      },
    };
    await fs.writeFile(settingsPath, JSON.stringify(settings));
    const chatKey = "github:archived-thread";
    const messageId = "archived-assistant";
    const recordKey = createHash("sha1")
      .update(`${chatKey}\n${messageId}`)
      .digest("hex");
    const recordPath = path.join(
      agentDir,
      "data",
      "chat",
      "message-store",
      "records",
      recordKey.slice(0, 2),
      `${recordKey}.json`,
    );
    await fs.mkdir(path.dirname(recordPath), { recursive: true });
    await fs.writeFile(
      recordPath,
      JSON.stringify({
        version: 1,
        recordKey,
        messageId,
        role: "assistant",
        chatKey,
        platform: "github",
        botId: "github-app",
        chatId: "archived-thread",
        receivedAt: "2026-05-01T00:00:00.000Z",
      }),
    );

    const result = migration.migrateLegacyChatKeys(
      agentDir,
      settingsPath,
      settings,
    );

    assert.equal(result.migratedRecords, 0);
    assert.deepEqual(result.settings, settings);
    assert.equal(
      JSON.parse(await fs.readFile(recordPath, "utf8")).chatKey,
      chatKey,
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat key migration treats legacy markers without complete as successful", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-key-legacy-marker-"),
  );
  try {
    const markerPath = path.join(
      agentDir,
      "data",
      "migrations",
      "chat-key-v1.json",
    );
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(
      markerPath,
      JSON.stringify({ id: "chat-key-v1", appliedAt: "2026-07-01T00:00:00Z" }),
    );
    const preflight = migration.preflightLegacyChatKeys(agentDir, {
      chat: { byChatKey: { "telegram:room": { quietMode: true } } },
    });
    assert.equal(preflight.alreadyApplied, true);
    assert.equal(preflight.complete, true);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat key migration rejects malformed or unowned marker files", async () => {
  for (const [name, content, expected] of [
    ["malformed", "{bad json", /chat_key_migration_invalid_marker/],
    ["unowned", "{}", /chat_key_migration_marker_id_mismatch/],
  ] as const) {
    const agentDir = await fs.mkdtemp(
      path.join(os.tmpdir(), `rin-chat-key-${name}-marker-`),
    );
    try {
      const markerPath = path.join(
        agentDir,
        "data",
        "migrations",
        "chat-key-v1.json",
      );
      await fs.mkdir(path.dirname(markerPath), { recursive: true });
      await fs.writeFile(markerPath, content);
      assert.throws(
        () => migration.preflightLegacyChatKeys(agentDir, {}),
        expected,
      );
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  }
});

test("chat key migration reports unresolved settings without blocking migration", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-key-active-unresolved-"),
  );
  try {
    const settingsPath = path.join(agentDir, "settings.json");
    const settings = {
      chat: {
        telegram: { token: "" },
        byChatKey: {
          "telegram:123": { quietMode: true },
        },
      },
    };
    await fs.writeFile(settingsPath, JSON.stringify(settings));

    const result = migration.migrateLegacyChatKeys(
      agentDir,
      settingsPath,
      settings,
    );
    assert.equal(result.complete, false);
    assert.equal(result.unresolvedSettings, 1);
    assert.deepEqual(result.settings, settings);
    assert.equal(
      JSON.parse(
        await fs.readFile(
          path.join(agentDir, "data", "migrations", "chat-key-v1.json"),
          "utf8",
        ),
      ).complete,
      false,
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat key migration preserves unresolved records without blocking migration", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-key-active-record-unresolved-"),
  );
  try {
    const settingsPath = path.join(agentDir, "settings.json");
    const settings = { chat: { telegram: { token: "12345:test" } } };
    await fs.writeFile(settingsPath, JSON.stringify(settings));

    const chatKey = "telegram:123";
    const messageId = "legacy-active-assistant";
    const recordKey = createHash("sha1")
      .update(`${chatKey}\n${messageId}`)
      .digest("hex");
    const recordPath = path.join(
      agentDir,
      "data",
      "chat",
      "message-store",
      "records",
      recordKey.slice(0, 2),
      `${recordKey}.json`,
    );
    await fs.mkdir(path.dirname(recordPath), { recursive: true });
    await fs.writeFile(
      recordPath,
      JSON.stringify({
        version: 1,
        recordKey,
        messageId,
        role: "assistant",
        chatKey,
        platform: "telegram",
        chatId: "123",
        receivedAt: "2026-05-01T00:00:00.000Z",
      }),
    );

    const preflight = migration.preflightLegacyChatKeys(agentDir, settings);
    assert.equal(preflight.unresolvedRecords, 1);
    assert.equal(preflight.complete, false);
    assert.deepEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf8")),
      settings,
    );
    const result = migration.migrateLegacyChatKeys(
      agentDir,
      settingsPath,
      settings,
    );
    assert.equal(result.unresolvedRecords, 1);
    assert.equal(result.complete, false);
    assert.equal(
      JSON.parse(await fs.readFile(recordPath, "utf8")).chatKey,
      chatKey,
    );
    assert.equal(
      JSON.parse(
        await fs.readFile(
          path.join(agentDir, "data", "migrations", "chat-key-v1.json"),
          "utf8",
        ),
      ).complete,
      false,
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat key migration rewrites legacy settings and message records before recovery", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-key-migration-"),
  );
  try {
    const settingsPath = path.join(agentDir, "settings.json");
    const settings = {
      chat: {
        lark: { appId: "cli_bot", appSecret: "secret" },
        byChatKey: {
          "lark:oc_same": {
            turnPolicy: "record_only",
            quietMode: false,
          },
          "lark/cli_bot:oc_same": {
            quietMode: true,
          },
        },
      },
    };
    await fs.writeFile(settingsPath, JSON.stringify(settings));

    const recordsDir = path.join(
      agentDir,
      "data",
      "chat",
      "message-store",
      "records",
    );
    const canonicalRecordKey = createHash("sha1")
      .update("lark/cli_bot:oc_same\nduplicate-message")
      .digest("hex");
    const canonicalSaved = {
      filePath: path.join(
        recordsDir,
        canonicalRecordKey.slice(0, 2),
        `${canonicalRecordKey}.json`,
      ),
    };
    await fs.mkdir(path.dirname(canonicalSaved.filePath), { recursive: true });
    await fs.writeFile(
      canonicalSaved.filePath,
      JSON.stringify({
        version: 1,
        recordKey: canonicalRecordKey,
        messageId: "duplicate-message",
        role: "user",
        chatKey: "lark/cli_bot:oc_same",
        platform: "lark",
        botId: "cli_bot",
        chatId: "oc_same",
        receivedAt: "2026-07-01T00:00:00.000Z",
        platformTimestamp: 2000,
        text: "current canonical message",
        processedAt: "2026-07-01T00:01:00.000Z",
      }),
    );
    const writeLegacyRecord = async (messageId: string, input = {}) => {
      const chatKey = "lark:oc_same";
      const recordKey = createHash("sha1")
        .update(`${chatKey}\n${messageId}`)
        .digest("hex");
      const filePath = path.join(
        recordsDir,
        recordKey.slice(0, 2),
        `${recordKey}.json`,
      );
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(
        filePath,
        JSON.stringify({
          version: 1,
          recordKey,
          messageId,
          role: "user",
          chatKey,
          platform: "lark",
          botId: "cli_bot",
          chatId: "oc_same",
          receivedAt: "2026-06-01T00:00:00.000Z",
          platformTimestamp: 1000,
          ...input,
        }),
      );
      return { filePath, recordKey };
    };
    const duplicateLegacy = await writeLegacyRecord("duplicate-message", {
      rawContent: "legacy raw content retained during merge",
      duplicateCount: 2,
    });
    const uniqueLegacy = await writeLegacyRecord("legacy-only-message");
    const storeDir = path.dirname(recordsDir);
    const indexesDir = path.join(storeDir, "indexes");
    const refsPath = (messageId: string) => {
      const key = createHash("sha1").update(messageId).digest("hex");
      return path.join(
        indexesDir,
        "by-message-id",
        key.slice(0, 2),
        `${key}.json`,
      );
    };
    const canonicalRecordPath = (messageId: string) => {
      const recordKey = createHash("sha1")
        .update(`lark/cli_bot:oc_same\n${messageId}`)
        .digest("hex");
      return path.join(recordsDir, recordKey.slice(0, 2), `${recordKey}.json`);
    };
    const writeRefs = async (messageId: string, refs: string[]) => {
      const filePath = refsPath(messageId);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(refs));
    };
    await writeRefs("duplicate-message", [
      path.relative(storeDir, duplicateLegacy.filePath),
      path.relative(storeDir, canonicalSaved.filePath),
    ]);
    await writeRefs("legacy-only-message", [
      path.relative(storeDir, uniqueLegacy.filePath),
    ]);
    const legacyDateIndexPath = path.join(
      indexesDir,
      "by-chat-date",
      "lark",
      "oc_same",
      "2026-06-01.json",
    );
    await fs.mkdir(path.dirname(legacyDateIndexPath), { recursive: true });
    await fs.writeFile(
      legacyDateIndexPath,
      JSON.stringify({
        version: 1,
        recordKeys: [duplicateLegacy.recordKey, uniqueLegacy.recordKey],
      }),
    );
    const legacyLogPath = path.join(
      storeDir,
      "chat-log-view",
      "lark",
      "oc_same",
      "2026-06-01.txt",
    );
    await fs.mkdir(path.dirname(legacyLogPath), { recursive: true });
    await fs.writeFile(legacyLogPath, "legacy derived view");
    assert.equal(
      (await fs.readdir(recordsDir, { recursive: true })).filter((name) =>
        String(name).endsWith(".json"),
      ).length,
      3,
    );

    const result = migration.migrateLegacyChatKeys(
      agentDir,
      settingsPath,
      settings,
    );

    assert.equal(result.alreadyApplied, false);
    assert.equal(result.migratedRecords, 2);
    assert.equal(result.mergedRecords, 1);
    assert.deepEqual(result.settings.chat.byChatKey, {
      "lark/cli_bot:oc_same": {
        turnPolicy: "record_only",
        quietMode: true,
      },
    });
    assert.deepEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf8")).chat.byChatKey,
      result.settings.chat.byChatKey,
    );
    await assert.rejects(fs.access(duplicateLegacy.filePath));
    await assert.rejects(fs.access(uniqueLegacy.filePath));
    await assert.rejects(fs.access(legacyDateIndexPath));
    await assert.rejects(fs.access(legacyLogPath));
    assert.deepEqual(
      JSON.parse(await fs.readFile(refsPath("legacy-only-message"), "utf8")),
      [path.relative(storeDir, canonicalRecordPath("legacy-only-message"))],
    );

    database.migrateChatDatabaseForInstall(agentDir);
    migration.finalizeLegacyChatKeyMigration(agentDir, {
      unresolvedSettings: 0,
      unresolvedRecords: 0,
    });
    const duplicate = messageStore.getChatMessage(
      agentDir,
      "lark/cli_bot:oc_same",
      "duplicate-message",
    );
    assert.equal(duplicate?.text, "current canonical message");
    assert.equal(
      duplicate?.rawContent,
      "legacy raw content retained during merge",
    );
    assert.equal(duplicate?.duplicateCount, 2);
    assert.equal(
      messageStore.getChatMessage(
        agentDir,
        "lark/cli_bot:oc_same",
        "legacy-only-message",
      )?.chatKey,
      "lark/cli_bot:oc_same",
    );
    assert.equal(
      messageStore.getChatMessagesByMessageId(agentDir, "legacy-only-message")
        .length,
      1,
    );
    assert.equal(
      messageStore.listChatMessagesByChatAndDate(
        agentDir,
        "lark/cli_bot:oc_same",
        "2026-06-01",
      ).length,
      1,
    );

    const repeated = migration.migrateLegacyChatKeys(
      agentDir,
      settingsPath,
      result.settings,
    );
    assert.equal(repeated.alreadyApplied, true);
    assert.equal(repeated.migratedRecords, 0);
  } finally {
    database.closeChatDatabase(agentDir);
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});
