import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
const installerPersist = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-install", "persist.js"))
    .href
);
const installMigration = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat", "install-migration.js"),
  ).href
);
const inbox = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "inbox.js")).href
);
const messageStore = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js"))
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

function seedLegacyAcceptedTurn(
  agentDir: string,
  options: { state?: "pending" | "running"; leaseUntil?: string } = {},
) {
  const item = inbox.enqueueChatInboxItem(agentDir, {
    chatKey: "legacy/1:2",
    messageId: `legacy-${options.state || "pending"}`,
    session: {
      platform: "legacy",
      selfId: "1",
      channelId: "2",
      userId: "owner",
      messageId: `legacy-${options.state || "pending"}`,
      timestamp: Date.now(),
      isDirect: true,
      content: "legacy accepted input",
      stripped: { content: "legacy accepted input" },
    },
    elements: [{ type: "text", attrs: { content: "legacy accepted input" } }],
  }).item;
  const decisionJson = JSON.stringify({
    version: 1,
    kind: "legacy_message_projection",
  });
  const db = database.openChatDatabase(agentDir);
  db.prepare(
    `UPDATE turns
        SET state = ?, owner_epoch = ?, attempt = ?, lease_until = ?,
            admission_state = 'actionable', admission_json = ?, admission_hash = ?,
            execution_session_file = 'legacy-session.jsonl'
      WHERE turn_id = ?`,
  ).run(
    options.state || "pending",
    options.state === "running" ? "legacy-owner" : null,
    options.state === "running" ? 1 : 0,
    options.leaseUntil || null,
    decisionJson,
    createHash("sha256").update(decisionJson).digest("hex"),
    item.itemId,
  );
  db.prepare(
    `UPDATE messages
        SET accepted_at = ?, disposition = 'actionable',
            session_file = 'legacy-session.jsonl'
      WHERE id = ?`,
  ).run(new Date().toISOString(), item.itemId);
  return item;
}

test("installer preflight refuses activation while an old accepted turn still has a live owner", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-live-legacy-turn-"),
  );
  try {
    seedLegacyAcceptedTurn(installDir, {
      state: "running",
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    database.closeChatDatabase(installDir);

    assert.throws(
      () => installMigration.preflightChatInstallMigrations(installDir),
      /chat_install_migration_active_legacy_turn/,
    );
    assert.throws(
      () => database.migrateChatDatabaseForInstall(installDir),
      /chat_install_migration_active_legacy_turn/,
    );
    assert.equal(
      database
        .openChatDatabase(installDir)
        .prepare(
          `SELECT value FROM schema_meta
            WHERE key = 'admission_model_version'`,
        )
        .get().value,
      "1",
    );
  } finally {
    database.closeChatDatabase(installDir);
    await fs.rm(installDir, { recursive: true, force: true });
  }
});

test("installer preflight does not block current durable active turns", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-current-active-turn-"),
  );
  try {
    const item = seedLegacyAcceptedTurn(installDir, {
      state: "running",
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    const decisionJson = JSON.stringify({
      version: 1,
      kind: "message",
      decision: { allow: true },
    });
    const submissionJson = JSON.stringify({
      version: 1,
      chatKey: item.chatKey,
      incomingMessageId: item.messageId,
      text: "current frozen input",
      attachments: [],
      promptMeta: { chatKey: item.chatKey },
    });
    database
      .openChatDatabase(installDir)
      .prepare(
        `UPDATE turns
            SET admission_json = ?, admission_hash = ?,
                submission_json = ?, submission_hash = ?
          WHERE turn_id = ?`,
      )
      .run(
        decisionJson,
        createHash("sha256").update(decisionJson).digest("hex"),
        submissionJson,
        createHash("sha256").update(submissionJson).digest("hex"),
        item.itemId,
      );
    database.closeChatDatabase(installDir);

    assert.doesNotThrow(() =>
      installMigration.preflightChatInstallMigrations(installDir),
    );
    assert.doesNotThrow(() =>
      database.migrateChatDatabaseForInstall(installDir),
    );
    assert.equal(
      database
        .openChatDatabase(installDir)
        .prepare(`SELECT state FROM turns WHERE turn_id = ?`)
        .get(item.itemId).state,
      "running",
    );
  } finally {
    database.closeChatDatabase(installDir);
    await fs.rm(installDir, { recursive: true, force: true });
  }
});

test("installer consumes ambiguous old admissions before the new runtime starts", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-consume-legacy-turn-"),
  );
  try {
    const item = seedLegacyAcceptedTurn(installDir);
    database.closeChatDatabase(installDir);

    const first = installMigration.runChatInstallMigrations(installDir);
    const second = installMigration.runChatInstallMigrations(installDir);
    assert.deepEqual(first.database.oldAdmissions, {
      turns: 1,
      orphanedMessages: 0,
      interruptedUnknown: 1,
      historyResolved: 0,
      legacyNotices: 0,
    });
    assert.deepEqual(
      second.database.oldAdmissions,
      first.database.oldAdmissions,
    );
    const db = database.openChatDatabase(installDir);
    const turn = db
      .prepare(
        `SELECT state, terminal_kind, admission_json, admission_hash
           FROM turns WHERE turn_id = ?`,
      )
      .get(item.itemId) as any;
    assert.deepEqual(turn, {
      state: "terminal",
      terminal_kind: "interrupted_unknown",
      admission_json: null,
      admission_hash: null,
    });
    assert.equal(
      db
        .prepare(`SELECT COUNT(*) AS count FROM outbox WHERE turn_id = ?`)
        .get(item.itemId).count,
      0,
    );
    assert.equal(
      db
        .prepare(
          `SELECT value FROM schema_meta
            WHERE key = 'admission_model_version'`,
        )
        .get().value,
      "1",
    );
  } finally {
    database.closeChatDatabase(installDir);
    await fs.rm(installDir, { recursive: true, force: true });
  }
});

test("installer preserves prior migration notice counts as historical audit only", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-preserve-old-migration-summary-"),
  );
  try {
    const item = seedLegacyAcceptedTurn(installDir);
    database
      .openChatDatabase(installDir)
      .prepare(
        `INSERT INTO schema_meta (key, value)
         VALUES ('admission_model_migration_summary', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(JSON.stringify({ turns: 7, orphanedMessages: 2, notices: 5 }));
    database.closeChatDatabase(installDir);

    const result = installMigration.runChatInstallMigrations(installDir);
    assert.deepEqual(result.database.oldAdmissions, {
      turns: 8,
      orphanedMessages: 2,
      interruptedUnknown: 1,
      historyResolved: 0,
      legacyNotices: 5,
    });
    assert.equal(
      database
        .openChatDatabase(installDir)
        .prepare(`SELECT COUNT(*) AS count FROM outbox WHERE turn_id = ?`)
        .get(item.itemId).count,
      0,
    );
  } finally {
    database.closeChatDatabase(installDir);
    await fs.rm(installDir, { recursive: true, force: true });
  }
});

test("installer silently supersedes an old turn after later handled chat activity", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-supersede-old-turn-"),
  );
  try {
    const item = seedLegacyAcceptedTurn(installDir);
    messageStore.saveChatMessage(installDir, {
      chatKey: item.chatKey,
      platform: "legacy",
      botId: "1",
      chatId: "2",
      chatType: "private",
      messageId: "later-handled-message",
      role: "user",
      receivedAt: new Date(Date.now() + 1_000).toISOString(),
      acceptedAt: new Date(Date.now() + 2_000).toISOString(),
      processedAt: new Date(Date.now() + 3_000).toISOString(),
      text: "the conversation already continued",
    });
    database.closeChatDatabase(installDir);

    const result = installMigration.runChatInstallMigrations(installDir);
    assert.deepEqual(result.database.oldAdmissions, {
      turns: 1,
      orphanedMessages: 0,
      interruptedUnknown: 0,
      historyResolved: 1,
      legacyNotices: 0,
    });
    const migrated = database.openChatDatabase(installDir);
    assert.deepEqual(
      migrated
        .prepare(`SELECT state, terminal_kind FROM turns WHERE turn_id = ?`)
        .get(item.itemId),
      {
        state: "superseded",
        terminal_kind: "legacy_history_superseded",
      },
    );
    assert.equal(
      migrated
        .prepare(`SELECT COUNT(*) AS count FROM outbox WHERE turn_id = ?`)
        .get(item.itemId).count,
      0,
    );
  } finally {
    database.closeChatDatabase(installDir);
    await fs.rm(installDir, { recursive: true, force: true });
  }
});

test("installer adopts an existing assistant reply without a migration error", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-adopt-old-reply-"),
  );
  try {
    const item = seedLegacyAcceptedTurn(installDir);
    messageStore.saveChatMessage(installDir, {
      chatKey: item.chatKey,
      platform: "legacy",
      botId: "1",
      chatId: "2",
      chatType: "private",
      messageId: "existing-assistant-reply",
      role: "assistant",
      replyToMessageId: item.messageId,
      receivedAt: new Date(Date.now() + 1_000).toISOString(),
      processedAt: new Date(Date.now() + 1_000).toISOString(),
      deliveryKind: "final",
      text: "already answered",
    });
    database.closeChatDatabase(installDir);

    const result = installMigration.runChatInstallMigrations(installDir);
    assert.deepEqual(result.database.oldAdmissions, {
      turns: 1,
      orphanedMessages: 0,
      interruptedUnknown: 0,
      historyResolved: 1,
      legacyNotices: 0,
    });
    const migrated = database.openChatDatabase(installDir);
    assert.deepEqual(
      migrated
        .prepare(`SELECT state, terminal_kind FROM turns WHERE turn_id = ?`)
        .get(item.itemId),
      {
        state: "terminal",
        terminal_kind: "legacy_reply_observed",
      },
    );
    assert.equal(
      migrated
        .prepare(`SELECT COUNT(*) AS count FROM outbox WHERE turn_id = ?`)
        .get(item.itemId).count,
      0,
    );
  } finally {
    database.closeChatDatabase(installDir);
    await fs.rm(installDir, { recursive: true, force: true });
  }
});

test("installer terminalizes old turns with noncanonical chat identity without chat delivery", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-consume-unresolved-legacy-turn-"),
  );
  try {
    const item = seedLegacyAcceptedTurn(installDir);
    const db = database.openChatDatabase(installDir);
    const unresolvedChatKey = "matrix:!room:matrix.example";
    db.prepare(
      `INSERT INTO chat_state (
         chat_key, current_generation, next_sequence, updated_at
       ) VALUES (?, 0, 2, ?)`,
    ).run(unresolvedChatKey, new Date().toISOString());
    db.prepare(`UPDATE messages SET chat_key = ? WHERE id = ?`).run(
      unresolvedChatKey,
      item.itemId,
    );
    db.prepare(`UPDATE turns SET chat_key = ? WHERE turn_id = ?`).run(
      unresolvedChatKey,
      item.itemId,
    );
    database.closeChatDatabase(installDir);

    const result = installMigration.runChatInstallMigrations(installDir);
    assert.deepEqual(result.database.oldAdmissions, {
      turns: 1,
      orphanedMessages: 0,
      interruptedUnknown: 1,
      historyResolved: 0,
      legacyNotices: 0,
    });
    const migrated = database.openChatDatabase(installDir);
    assert.equal(
      migrated
        .prepare(`SELECT terminal_kind FROM turns WHERE turn_id = ?`)
        .get(item.itemId).terminal_kind,
      "interrupted_unknown",
    );
    assert.equal(
      migrated
        .prepare(`SELECT COUNT(*) AS count FROM outbox WHERE turn_id = ?`)
        .get(item.itemId).count,
      0,
    );
  } finally {
    database.closeChatDatabase(installDir);
    await fs.rm(installDir, { recursive: true, force: true });
  }
});

test("installer consumes accepted messages that predate atomic inbox turns", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-consume-accepted-orphan-"),
  );
  try {
    messageStore.saveChatMessage(installDir, {
      chatKey: "discord/1:room",
      platform: "discord",
      botId: "1",
      chatId: "room",
      chatType: "group",
      messageId: "accepted-before-atomic-turns",
      role: "user",
      receivedAt: "2026-07-14T01:00:00.000Z",
      acceptedAt: "2026-07-14T01:00:01.000Z",
      sessionFile: "accepted-orphan.jsonl",
      text: "recover me during update",
      elements: [
        { type: "text", attrs: { content: "recover me during update" } },
      ],
    });
    database.closeChatDatabase(installDir);

    installMigration.runChatInstallMigrations(installDir);
    const db = database.openChatDatabase(installDir);
    const row = db
      .prepare(
        `SELECT turns.state, turns.terminal_kind, turns.admission_json,
                messages.processed_at
           FROM turns
           JOIN messages ON messages.id = turns.inbound_message_id
          WHERE messages.message_id = 'accepted-before-atomic-turns'`,
      )
      .get() as any;
    assert.equal(row.state, "terminal");
    assert.equal(row.terminal_kind, "interrupted_unknown");
    assert.equal(row.admission_json, null);
    assert.ok(row.processed_at);
    assert.equal(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM outbox
            WHERE turn_id = (
              SELECT id FROM messages
               WHERE message_id = 'accepted-before-atomic-turns'
            )`,
        )
        .get().count,
      0,
    );
  } finally {
    database.closeChatDatabase(installDir);
    await fs.rm(installDir, { recursive: true, force: true });
  }
});

test("install migration never emits owner-visible chat errors", async () => {
  const source = await fs.readFile(
    path.join(rootDir, "src/core/chat/database-install-migration.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /INSERT INTO outbox|enqueueInterruptedUnknown/);
});

test("ordinary chat execution source contains no old-admission compatibility", async () => {
  for (const relativePath of [
    "src/core/chat/database.ts",
    "src/core/chat/durable-admission.ts",
    "src/core/chat/inbox.ts",
    "src/core/chat/main.ts",
    "src/core/chat/controller.ts",
    "src/core/rin-frontend-sdk/turn-driver.ts",
  ]) {
    const source = await fs.readFile(path.join(rootDir, relativePath), "utf8");
    assert.doesNotMatch(
      source,
      /legacy_message_projection|legacy_accepted_orphan|rejoin-only|rejoin_turn/,
      relativePath,
    );
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

test("installer migration preflight is read-only", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-installer-preflight-"),
  );
  const settingsPath = path.join(installDir, "settings.json");
  const settings = {
    chat: {
      lark: { appId: "cli_bot", appSecret: "secret" },
      byChatKey: { "lark:oc_same": { quietMode: true } },
    },
  };
  await writeJson(settingsPath, settings);
  try {
    const preflight = installerPersist.preflightInstallUpgradeMigrations(
      {
        targetUser: "test-user",
        installDir,
        migrationRuntimeRoot: rootDir,
      },
      { runPrivileged() {} },
    );
    assert.ok(
      preflight.some(
        (migration) =>
          migration.id === "chat-authority-install-migration-v1-preflight",
      ),
    );
    assert.ok(
      preflight.some(
        (migration) => migration.id === "transcript-search-schema-v5-preflight",
      ),
    );
    assert.deepEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf8")),
      settings,
    );
    await assert.rejects(
      fs.access(
        path.join(installDir, "data", "migrations", "chat-key-v1.json"),
      ),
    );
    await assert.rejects(
      fs.access(path.join(installDir, "data", "chat", "chat.sqlite")),
    );
  } finally {
    await fs.rm(installDir, { recursive: true, force: true });
  }
});

test("installer fails closed when transcript migration needs a staged runtime", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-memory-installer-runtime-required-"),
  );
  await fs.mkdir(path.join(installDir, "memory"), { recursive: true });
  await fs.writeFile(path.join(installDir, "memory", "search.db"), "legacy");
  try {
    assert.throws(
      () =>
        installerPersist.preflightInstallUpgradeMigrations(
          { targetUser: "test-user", installDir },
          { runPrivileged() {} },
        ),
      /memory_install_migration_runtime_required/,
    );
  } finally {
    await fs.rm(installDir, { recursive: true, force: true });
  }
});

test("malformed per-chat session state is reported without blocking install migration", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-session-state-preserved-"),
  );
  const stateRoot = path.join(
    installDir,
    "data",
    "chat",
    "session-state",
    "telegram",
    "bot",
  );
  const invalidStatePath = path.join(stateRoot, "invalid", "state.json");
  await fs.mkdir(path.dirname(invalidStatePath), { recursive: true });
  await fs.writeFile(invalidStatePath, "{bad json\n");
  await writeJson(path.join(stateRoot, "invalid-session", "state.json"), {
    chatKey: "telegram/bot:invalid-session",
    sessionFile: 42,
  });
  await writeJson(path.join(stateRoot, "without-binding", "state.json"), {
    chatKey: "telegram/bot:without-binding",
  });
  await writeJson(path.join(stateRoot, "valid", "state.json"), {
    chatKey: "telegram/bot:valid",
    sessionFile: "managed/chat/valid.jsonl",
  });

  try {
    const preflight =
      installMigration.preflightChatInstallMigrations(installDir);
    assert.deepEqual(preflight.sessionBindings, {
      scanned: 4,
      preserved: 2,
      preservedReasons: { invalid_json: 1, invalid_session_file: 1 },
      withoutBinding: 1,
    });

    const result = installMigration.runChatInstallMigrations(installDir);
    assert.deepEqual(result.sessionBindings, {
      scanned: 4,
      imported: 1,
      preserved: 2,
      preservedReasons: { invalid_json: 1, invalid_session_file: 1 },
      withoutBinding: 1,
    });
    assert.equal(await fs.readFile(invalidStatePath, "utf8"), "{bad json\n");
  } finally {
    database.closeChatDatabase(installDir);
    await fs.rm(installDir, { recursive: true, force: true });
  }
});

test("elevated installer preflight runs the staged migration as target user", async () => {
  const calls: any[] = [];
  installerPersist.preflightInstallUpgradeMigrations(
    {
      targetUser: "service-user",
      installDir: "/srv/rin",
      elevated: true,
      migrationRuntimeRoot: "/srv/rin/app/releases/staged",
      targetNodePath: "/srv/rin/runtime/node/current/bin/node",
    },
    {
      runPrivileged() {},
      runCommandAsUser(targetUser, command, args) {
        calls.push({ targetUser, command, args });
      },
    },
  );
  assert.deepEqual(calls, [
    {
      targetUser: "service-user",
      command: "/srv/rin/runtime/node/current/bin/node",
      args: [
        "/srv/rin/app/releases/staged/dist/app/rin-install/memory-migrations.js",
        "--preflight",
        "/srv/rin",
      ],
    },
    {
      targetUser: "service-user",
      command: "/srv/rin/runtime/node/current/bin/node",
      args: [
        "/srv/rin/app/releases/staged/dist/app/rin-install/chat-migrations.js",
        "--preflight",
        "/srv/rin",
      ],
    },
  ]);
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
    assert.ok(
      migrations.some(
        (migration) => migration.id === "transcript-search-schema-v5",
      ),
    );
    assert.deepEqual(
      JSON.parse(await fs.readFile(settingsPath, "utf8")).chat.byChatKey,
      { "lark/cli_bot:oc_same": { quietMode: true } },
    );
    const db = database.openChatDatabase(installDir);
    assert.equal(Number(db.pragma("user_version", { simple: true })), 6);
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

test("installer preflight still blocks corrupted migration control metadata", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-invalid-preserved-summary-"),
  );
  try {
    const db = database.migrateChatDatabaseForInstall(installDir);
    db.prepare(
      `UPDATE schema_meta SET value = ?
       WHERE key = 'legacy_control_migration_preserved'`,
    ).run('{"version":1,"total":2,"reasons":{"invalid":1}}');
    database.closeChatDatabase(installDir);

    assert.throws(
      () => installMigration.preflightChatInstallMigrations(installDir),
      /chat_legacy_migration_invalid_preserved_summary/,
    );
  } finally {
    database.closeChatDatabase(installDir);
    await fs.rm(installDir, { recursive: true, force: true });
  }
});

test("install-only database creation stays unrunnable until admission migration commits", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-install-incomplete-admission-model-"),
  );
  try {
    const installDb = database.openChatDatabaseForInstall(agentDir);
    assert.equal(
      installDb
        .prepare(
          `SELECT value FROM schema_meta
            WHERE key = 'admission_model_version'`,
        )
        .get(),
      undefined,
    );
    database.closeChatDatabase(agentDir);
    assert.throws(
      () => database.openChatDatabase(agentDir),
      /chat_database_admission_model_incomplete/,
    );
    database.closeChatDatabase(agentDir);

    database.migrateChatDatabaseForInstall(agentDir);
    database.closeChatDatabase(agentDir);
    assert.doesNotThrow(() => database.openChatDatabase(agentDir));
  } finally {
    database.closeChatDatabase(agentDir);
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("runtime database open rejects a current schema whose update migration did not finish", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-runtime-incomplete-admission-model-"),
  );
  try {
    const db = database.openChatDatabase(agentDir);
    db.prepare(
      `DELETE FROM schema_meta WHERE key = 'admission_model_version'`,
    ).run();
    database.closeChatDatabase(agentDir);

    assert.throws(
      () => database.openChatDatabase(agentDir),
      /chat_database_admission_model_incomplete/,
    );
  } finally {
    database.closeChatDatabase(agentDir);
    await fs.rm(agentDir, { recursive: true, force: true });
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
      /chat_database_schema_upgrade_required:3:6/,
    );
  } finally {
    database.closeChatDatabase(agentDir);
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});
