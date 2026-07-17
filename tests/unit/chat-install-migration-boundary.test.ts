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
const installerPersist = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-install", "persist.js"))
    .href
);

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("runtime database open never imports legacy control-plane data", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-runtime-open-"),
  );
  const legacyPath = path.join(
    agentDir,
    "data",
    "chat",
    "message-store",
    "records",
    "aa",
    "legacy.json",
  );
  await writeJson(legacyPath, {
    version: 1,
    recordKey: "record-legacy",
    chatKey: "telegram/1:2",
    messageId: "legacy-message",
    role: "user",
    platform: "telegram",
    botId: "1",
    chatId: "2",
    receivedAt: "2026-07-14T01:00:00.000Z",
    text: "legacy text",
  });

  try {
    const runtimeDb = database.openChatDatabase(agentDir);
    assert.equal(
      runtimeDb.prepare("SELECT COUNT(*) AS count FROM messages").get().count,
      0,
    );
    assert.equal(
      runtimeDb
        .prepare(
          "SELECT value FROM schema_meta WHERE key = 'legacy_control_migration'",
        )
        .get(),
      undefined,
    );

    database.closeChatDatabase(agentDir);
    const migratedDb = database.migrateChatDatabaseForInstall(agentDir);
    assert.equal(
      migratedDb.prepare("SELECT COUNT(*) AS count FROM messages").get().count,
      1,
    );
  } finally {
    database.closeChatDatabase(agentDir);
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat bridge startup never runs legacy key migration", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-runtime-key-boundary-"),
  );
  const settingsPath = path.join(agentDir, "settings.json");
  const settings = {
    chat: {
      telegram: { token: "" },
      byChatKey: { "telegram:123": { quietMode: true } },
    },
  };
  await writeJson(settingsPath, settings);
  database.migrateChatDatabaseForInstall(agentDir);
  database.closeChatDatabase(agentDir);

  try {
    const mainUrl = pathToFileURL(
      path.join(rootDir, "dist", "core", "chat", "main.js"),
    ).href;
    await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { startChatBridge } = await import(${JSON.stringify(mainUrl)}); const bridge = await startChatBridge({ hosted: true, settingsPath: process.env.SETTINGS_PATH }); await bridge.stop();`,
      ],
      {
        cwd: rootDir,
        env: { ...process.env, RIN_DIR: agentDir, SETTINGS_PATH: settingsPath },
        timeout: 30_000,
      },
    );

    assert.deepEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf8")),
      settings,
    );
    await assert.rejects(
      fs.access(path.join(agentDir, "data", "migrations", "chat-key-v1.json")),
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("installer upgrade migrations own chat key and SQLite authority migration", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-installer-migration-"),
  );
  const settingsPath = path.join(installDir, "settings.json");
  await writeJson(settingsPath, {
    chat: {
      lark: { appId: "cli_bot", appSecret: "secret" },
      byChatKey: { "lark:oc_same": { quietMode: true } },
    },
  });
  await writeJson(
    path.join(
      installDir,
      "data",
      "chat",
      "session-state",
      "lark",
      "cli_bot",
      "oc_same",
      "state.json",
    ),
    {
      chatKey: "lark/cli_bot:oc_same",
      sessionFile: "managed/chat/session.jsonl",
    },
  );

  try {
    const migrations = installerPersist.applyInstallUpgradeMigrations(
      {
        targetUser: "test-user",
        installDir,
        migrationRuntimeRoot: rootDir,
      },
      { runPrivileged() {} },
    );

    assert.ok(
      migrations.some(
        (migration) => migration.id === "chat-authority-install-migration-v1",
      ),
    );
    assert.deepEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf8")).chat.byChatKey,
      { "lark/cli_bot:oc_same": { quietMode: true } },
    );
    const db = database.openChatDatabase(installDir);
    assert.equal(Number(db.pragma("user_version", { simple: true })), 4);
    assert.equal(
      db
        .prepare(
          "SELECT value FROM schema_meta WHERE key = 'legacy_control_migration'",
        )
        .get().value,
      "complete_v1",
    );
    assert.equal(
      db
        .prepare(
          "SELECT session_file FROM chat_state WHERE chat_key = 'lark/cli_bot:oc_same'",
        )
        .get().session_file,
      "managed/chat/session.jsonl",
    );
  } finally {
    database.closeChatDatabase(installDir);
    await fs.rm(installDir, { recursive: true, force: true });
  }
});

test("runtime database open rejects an old schema instead of upgrading it", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-runtime-schema-"),
  );
  try {
    const db = database.migrateChatDatabaseForInstall(agentDir);
    db.pragma("user_version = 3");
    database.closeChatDatabase(agentDir);

    assert.throws(
      () => database.openChatDatabase(agentDir),
      /chat_database_schema_upgrade_required:3:4/,
    );
  } finally {
    database.closeChatDatabase(agentDir);
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});
