import "../support/require-test-sandbox.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import BetterSqlite3 from "better-sqlite3";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
await import("../support/register-chat-database-owner-fixture.ts");
const database = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "database.js")).href
);
const databaseMigration = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat", "database-migration.js"),
  ).href
);

async function tempAgent(prefix: string) {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function createDatabase(agentDir: string) {
  const dbPath = database.chatDatabasePath(agentDir);
  return fs
    .mkdir(path.dirname(dbPath), { recursive: true })
    .then(() => new BetterSqlite3(dbPath));
}

test("chat database upgrade rejects a recorded future schema", () => {
  assert.throws(
    () =>
      (databaseMigration as any).__rinOwnerUpgradeRecordedChatDatabase({
        pragma: () => 11,
      }),
    /chat_database_future_schema:11/,
  );
});

test("chat database migration retires a legacy terminal WAL only when present", async () => {
  const agentDir = await tempAgent("rin-chat-terminal-wal-");
  try {
    const terminalWal = path.join(agentDir, "data", "chat", "terminal-wal");
    (databaseMigration as any).__rinOwnerRetireLegacyTerminalWal(agentDir);
    await fs.mkdir(terminalWal, { recursive: true });
    (databaseMigration as any).__rinOwnerRetireLegacyTerminalWal(agentDir);
    const names = await fs.readdir(path.dirname(terminalWal));
    assert.equal(
      names.some((name) => name.startsWith("terminal-wal-retired-")),
      true,
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat database private normalizers preserve required text, WAL retry, and state floors", () => {
  const seam = database as any;
  assert.equal(seam.__rinOwnerRequiredText(" owner ", "missing"), "owner");
  assert.throws(() => seam.__rinOwnerRequiredText(" ", "missing"), /missing/);
  assert.deepEqual(seam.__rinOwnerNormalizeChatState(null, "chat"), {
    chatKey: "chat",
    currentGeneration: 0,
    nextSequence: 1,
  });
  assert.deepEqual(
    seam.__rinOwnerNormalizeChatState(
      { current_generation: -2, next_sequence: 0 },
      "chat",
    ),
    { chatKey: "chat", currentGeneration: 0, nextSequence: 1 },
  );
  assert.deepEqual(
    seam.__rinOwnerNormalizeChatState(
      { current_generation: 3, next_sequence: 4 },
      "chat",
    ),
    { chatKey: "chat", currentGeneration: 3, nextSequence: 4 },
  );

  const pragmas: string[] = [];
  seam.__rinOwnerSetWalJournalMode({
    pragma(value: string) {
      pragmas.push(value);
    },
  });
  assert.deepEqual(pragmas, ["journal_mode = WAL"]);
  let attempts = 0;
  seam.__rinOwnerSetWalJournalMode({
    pragma() {
      attempts += 1;
      if (attempts === 1)
        throw Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
    },
  });
  assert.equal(attempts, 2);
  assert.throws(
    () =>
      seam.__rinOwnerSetWalJournalMode({
        pragma() {
          throw new Error("owner");
        },
      }),
    /owner/,
  );
  const admissionDb = (value: unknown) => ({
    prepare() {
      return { get: () => ({ value }) };
    },
  });
  assert.doesNotThrow(() =>
    seam.__rinOwnerValidateCurrentChatAdmissionModel(admissionDb("1")),
  );
  assert.throws(
    () => seam.__rinOwnerValidateCurrentChatAdmissionModel(admissionDb("0")),
    /chat_database_admission_model_incomplete/,
  );
  assert.throws(
    () =>
      seam.__rinOwnerValidateCurrentChatAdmissionModel({
        prepare() {
          return { get: () => undefined };
        },
      }),
    /chat_database_admission_model_incomplete/,
  );
  const schemaTables = [
    "chat_state",
    "inbound_heads",
    "messages",
    "outbox",
    "outbox_deliveries",
    "schema_meta",
    "turns",
  ].map((name) => ({ name }));
  const schemaDb = {
    prepare(sql: string) {
      if (sql.includes("WHERE type = 'table'"))
        return { all: () => schemaTables };
      if (sql.includes("schema_version"))
        return { get: () => ({ value: "6" }) };
      if (sql.includes("schema_fingerprint"))
        return { get: () => ({ value: "wrong" }) };
      if (sql.includes("sqlite_master")) return { all: () => [] };
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
  assert.throws(
    () => database.validateRecordedChatDatabaseSchema(schemaDb as any, 6),
    /chat_database_schema_fingerprint_mismatch/,
  );
  const missingVersionDb = {
    prepare(sql: string) {
      if (sql.includes("WHERE type = 'table'"))
        return { all: () => schemaTables };
      if (sql.includes("schema_version")) return { get: () => undefined };
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
  assert.throws(
    () =>
      database.validateRecordedChatDatabaseSchema(missingVersionDb as any, 6),
    /chat_database_schema_version_mismatch/,
  );
});

test("chat database migration private probes classify schema and history terminals", () => {
  const seam = databaseMigration as any;
  assert.equal(
    seam.__rinOwnerTableHasColumn(
      { pragma: () => [{ name: "owner" }] },
      "turns",
      "owner",
    ),
    true,
  );
  assert.equal(
    seam.__rinOwnerTableHasColumn(
      { pragma: () => [{ name: "other" }] },
      "turns",
      "owner",
    ),
    false,
  );
  const dbWith = (row: any) => ({
    prepare() {
      return { get: (..._args: any[]) => row };
    },
  });
  assert.equal(
    seam.__rinOwnerTerminalOutboxKindForMigration(
      dbWith({ delivery_kind: "final" }),
      "turn",
    ),
    "outbox_final",
  );
  assert.equal(
    seam.__rinOwnerTerminalOutboxKindForMigration(
      dbWith({ delivery_kind: "error" }),
      "turn",
    ),
    "outbox_error",
  );
  assert.equal(
    seam.__rinOwnerTerminalOutboxKindForMigration(
      dbWith({ delivery_kind: "command_ack" }),
      "turn",
    ),
    "command_ack",
  );
  assert.equal(
    seam.__rinOwnerTerminalOutboxKindForMigration(
      dbWith({ delivery_kind: "working" }),
      "turn",
    ),
    "outbox_terminal",
  );
  assert.equal(
    seam.__rinOwnerTerminalOutboxKindForMigration(dbWith(undefined), "turn"),
    "",
  );
  assert.equal(
    seam.__rinOwnerHasAssistantReplyForMigration(
      dbWith({ one: 1 }),
      "chat",
      "message",
    ),
    true,
  );
  assert.equal(
    seam.__rinOwnerHasAssistantReplyForMigration(
      dbWith(undefined),
      "chat",
      "message",
    ),
    false,
  );
  assert.equal(
    seam.__rinOwnerHasLaterHandledUserMessageForMigration(
      dbWith({ one: 1 }),
      "chat",
      1,
    ),
    true,
  );
  assert.equal(
    seam.__rinOwnerHasLaterHandledUserMessageForMigration(
      dbWith(undefined),
      "chat",
      1,
    ),
    false,
  );
  let rebuildSql = "";
  seam.__rinOwnerRebuildChatDeliveryTablesV9({
    exec(sql: string) {
      rebuildSql = sql;
    },
  });
  assert.match(rebuildSql, /CREATE TABLE inbox_jobs/);
  assert.match(rebuildSql, /CREATE TABLE outbox_deliveries/);
  assert.match(rebuildSql, /DROP TABLE cutover_messages_v9/);

  const guardDb = (
    columns: string[],
    options: { tables?: string[]; active?: boolean; count?: number } = {},
  ) => ({
    pragma() {
      return columns.map((name) => ({ name }));
    },
    prepare(sql: string) {
      if (sql.includes("WHERE type = 'table'")) {
        return {
          all: () => (options.tables || ["turns"]).map((name) => ({ name })),
        };
      }
      if (sql.includes("COUNT(*) AS count")) {
        return { get: () => ({ count: options.count || 0 }) };
      }
      return {
        get: () => (options.active ? { turn_id: "active" } : undefined),
      };
    },
  });
  assert.doesNotThrow(() =>
    seam.__rinOwnerAssertNoActiveOldAdmissionOwner(guardDb([]), 0),
  );
  assert.doesNotThrow(() =>
    seam.__rinOwnerAssertNoActiveOldAdmissionOwner(guardDb(["other"]), 5),
  );
  assert.doesNotThrow(() =>
    seam.__rinOwnerAssertNoActiveOldAdmissionOwner(
      guardDb(["lease_until", "admission_json", "run_id"]),
      6,
    ),
  );
  assert.throws(
    () =>
      seam.__rinOwnerAssertNoActiveOldAdmissionOwner(
        guardDb(["lease_until"], { active: true }),
        5,
      ),
    /chat_database_migration_active_legacy_turn/,
  );
  assert.throws(
    () =>
      seam.__rinOwnerAssertNoActiveOldAdmissionOwner(
        guardDb(["lease_until", "admission_json"], { active: true }),
        6,
      ),
    /chat_database_migration_active_legacy_turn/,
  );
  assert.doesNotThrow(() =>
    seam.__rinOwnerAssertNoActiveOldAdmissionOwner(
      guardDb(["lease_until", "run_id"]),
      6,
    ),
  );

  assert.doesNotThrow(() =>
    seam.__rinOwnerAssertNoUnfencedRunningTurns(guardDb([]), 0),
  );
  assert.doesNotThrow(() =>
    seam.__rinOwnerAssertNoUnfencedRunningTurns(guardDb([], { tables: [] }), 5),
  );
  assert.doesNotThrow(() =>
    seam.__rinOwnerAssertNoUnfencedRunningTurns(guardDb([], { count: 0 }), 5),
  );
  assert.throws(
    () =>
      seam.__rinOwnerAssertNoUnfencedRunningTurns(
        guardDb(["run_id"], { count: 2 }),
        6,
      ),
    /chat_database_canonical_run_drain_required:2/,
  );
  assert.doesNotThrow(() =>
    seam.__rinOwnerAssertNoUnfencedRunningTurns(
      guardDb(["run_id"], { count: 0 }),
      8,
    ),
  );
  assert.throws(
    () =>
      seam.__rinOwnerAssertNoUnfencedRunningTurns(guardDb([], { count: 1 }), 6),
    /chat_database_canonical_run_drain_required:1/,
  );

  const summaryDb = (value?: string) => ({
    prepare() {
      return { get: () => (value === undefined ? undefined : { value }) };
    },
  });
  assert.deepEqual(
    databaseMigration.readAdmissionModelSchemaMigrationSummary(
      summaryDb() as any,
    ),
    {
      turns: 0,
      orphanedMessages: 0,
      interruptedUnknown: 0,
      historyResolved: 0,
      legacyNotices: 0,
      releasedCurrentClaims: 0,
    },
  );
  assert.deepEqual(
    databaseMigration.readAdmissionModelSchemaMigrationSummary(
      summaryDb("{}") as any,
    ),
    {
      turns: 0,
      orphanedMessages: 0,
      interruptedUnknown: 0,
      historyResolved: 0,
      legacyNotices: 0,
      releasedCurrentClaims: 0,
    },
  );
  assert.deepEqual(
    databaseMigration.readAdmissionModelSchemaMigrationSummary(
      summaryDb(
        JSON.stringify({
          turns: -1,
          orphanedMessages: 2,
          interruptedUnknown: null,
          historyResolved: 3,
          notices: 4,
          releasedCurrentClaims: -2,
        }),
      ) as any,
    ),
    {
      turns: 0,
      orphanedMessages: 2,
      interruptedUnknown: 0,
      historyResolved: 3,
      legacyNotices: 4,
      releasedCurrentClaims: 0,
    },
  );
  assert.equal(
    databaseMigration.readAdmissionModelSchemaMigrationSummary(
      summaryDb(JSON.stringify({ legacyNotices: 5, notices: 4 })) as any,
    ).legacyNotices,
    5,
  );
});

test("chat database install preflight distinguishes absent, empty, partial, and future schemas", async () => {
  const absent = await tempAgent("rin-chat-db-absent-");
  const empty = await tempAgent("rin-chat-db-empty-");
  const partial = await tempAgent("rin-chat-db-partial-");
  const future = await tempAgent("rin-chat-db-future-");
  const current = await tempAgent("rin-chat-db-current-");
  try {
    assert.equal(
      databaseMigration.preflightChatDatabaseMigration(absent).fromVersion,
      0,
    );

    (await createDatabase(empty)).close();
    assert.equal(
      databaseMigration.preflightChatDatabaseMigration(empty).fromVersion,
      0,
    );

    const partialDb = await createDatabase(partial);
    partialDb.exec("CREATE TABLE stray (id TEXT)");
    partialDb.close();
    assert.throws(
      () => databaseMigration.preflightChatDatabaseMigration(partial),
      /chat_database_partial_schema/,
    );

    const futureDb = await createDatabase(future);
    futureDb.pragma("user_version = 999");
    futureDb.close();
    assert.throws(
      () => databaseMigration.preflightChatDatabaseMigration(future),
      /chat_database_future_schema:999/,
    );

    database.openChatDatabase(current);
    database.closeChatDatabase(current);
    assert.equal(
      databaseMigration.preflightChatDatabaseMigration(current).fromVersion > 0,
      true,
    );
  } finally {
    for (const agentDir of [absent, empty, partial, future, current]) {
      database.closeChatDatabase(agentDir);
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  }
});

test("chat database session state APIs preserve cache and conditional writes", async () => {
  const agentDir = await tempAgent("rin-chat-db-state-");
  try {
    const first = database.openChatDatabase(agentDir);
    assert.equal(database.openChatDatabase(agentDir), first);
    const migrated = databaseMigration.migrateChatDatabase(agentDir);
    assert.notEqual(migrated, first);
    assert.equal(first.open, false);
    assert.equal(database.openChatDatabase(agentDir), migrated);

    assert.equal(
      database.importLegacyChatSessionBinding(
        agentDir,
        "telegram/1:2",
        "legacy.jsonl",
      ),
      true,
    );
    assert.equal(
      database.importLegacyChatSessionBinding(
        agentDir,
        "telegram/1:2",
        "ignored.jsonl",
      ),
      false,
    );
    assert.equal(
      database.importLegacyChatSessionBinding(agentDir, "telegram/1:3", " "),
      true,
    );
    assert.equal(database.readChatSessionBinding(agentDir, "telegram/1:3"), "");
    assert.equal(
      database.readChatSessionBinding(agentDir, "telegram/1:2"),
      "legacy.jsonl",
    );
    assert.equal(
      database.writeChatSessionBinding(
        agentDir,
        "telegram/1:2",
        "conditional.jsonl",
        { onlyIfEmpty: true },
      ),
      false,
    );
    assert.equal(
      database.writeChatSessionBinding(
        agentDir,
        "telegram/1:2",
        "replacement.jsonl",
      ),
      true,
    );
    assert.equal(
      database.readChatSessionBinding(agentDir, "telegram/1:2"),
      "replacement.jsonl",
    );
    assert.equal(
      database.writeChatSessionBinding(agentDir, "telegram/1:3", " "),
      true,
    );
    assert.equal(
      database.writeChatSessionBindingWithFence(
        agentDir,
        {
          turnId: "missing-turn",
          chatKey: "telegram/1:3",
          messageId: "missing-message",
          ownerEpoch: "owner",
          attempt: 0,
        },
        " ",
      ),
      false,
    );

    assert.deepEqual(database.readChatState(agentDir, "telegram/1:2"), {
      chatKey: "telegram/1:2",
      currentGeneration: 0,
      nextSequence: 1,
    });
    assert.deepEqual(
      database.allocateChatSequenceInDatabase(migrated, "telegram/1:2"),
      { sequence: 1, generation: 0 },
    );
    assert.deepEqual(database.allocateChatSequence(agentDir, "telegram/1:2"), {
      sequence: 2,
      generation: 0,
    });
    assert.equal(
      database.advanceChatGeneration(agentDir, "telegram/1:2", {
        sessionFile: "",
      }).currentGeneration,
      1,
    );
    assert.equal(
      database.advanceChatGeneration(agentDir, "telegram/1:2")
        .currentGeneration,
      2,
    );
    assert.equal(
      database.advanceChatGeneration(agentDir, "telegram/1:2", {
        resolveNonterminalSends: true,
      }).currentGeneration,
      3,
    );
    database.closeChatDatabase(agentDir);
    database.closeChatDatabase(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat database rejects blank required identities across public state APIs", async () => {
  const agentDir = await tempAgent("rin-chat-db-required-");
  try {
    for (const operation of [
      () => database.readChatSessionBinding(agentDir, " "),
      () => database.writeChatSessionBinding(agentDir, "", "session.jsonl"),
      () => database.readChatState(agentDir, ""),
      () => database.allocateChatSequence(agentDir, ""),
      () => database.advanceChatGeneration(agentDir, ""),
    ]) {
      assert.throws(operation, /required/);
    }
    database.closeChatDatabase(agentDir);
    database.closeChatDatabase(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat install reconciliation state validates and completes durably", async () => {
  const agentDir = await tempAgent("rin-chat-reconciliation-");
  try {
    const db = database.openChatDatabase(agentDir);
    const key = "canonical_run_reconciliation_v8";
    const writeState = (value: unknown) =>
      db
        .prepare(
          `INSERT INTO schema_meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(key, JSON.stringify(value));

    assert.equal(
      databaseMigration.readCanonicalReconciliationMigrationState(db),
      null,
    );
    assert.equal(
      databaseMigration.completeCanonicalReconciliationMigrationState(db),
      null,
    );
    const pending = {
      version: 1,
      state: "pending_session_retirement",
      chatKeys: [" owner/chat ", ""],
      interruptedTurnIds: [" owner-turn ", ""],
      retiredRunIds: [" owner-run ", ""],
      createdAt: "created",
      completedAt: "",
    };
    writeState(pending);
    assert.deepEqual(
      databaseMigration.readCanonicalReconciliationMigrationState(db),
      {
        version: 1,
        state: "pending_session_retirement",
        chatKeys: ["owner/chat"],
        interruptedTurnIds: ["owner-turn"],
        retiredRunIds: ["owner-run"],
        createdAt: "created",
        completedAt: null,
      },
    );
    const completed =
      databaseMigration.completeCanonicalReconciliationMigrationState(db);
    assert.equal(completed.state, "complete");
    assert.match(completed.completedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(
      databaseMigration.completeCanonicalReconciliationMigrationState(db),
      completed,
    );

    for (const invalid of [
      { ...pending, version: 0 },
      { ...pending, state: "invalid" },
      { ...pending, chatKeys: null },
      { ...pending, interruptedTurnIds: null },
      { ...pending, retiredRunIds: null },
    ]) {
      writeState(invalid);
      assert.throws(
        () => databaseMigration.readCanonicalReconciliationMigrationState(db),
        /chat_database_invalid_canonical_reconciliation_state/,
      );
    }
    database.closeChatDatabase(agentDir);
  } finally {
    database.closeChatDatabase(agentDir);
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat database settles joined presentations and empty completions transactionally", async () => {
  const agentDir = await tempAgent("rin-chat-db-joined-");
  const chatKey = "telegram/owner:joined";
  try {
    const db = database.openChatDatabase(agentDir);
    database.ensureChatState(db, chatKey);
    const timestamp = "2026-08-06T00:00:00.000Z";
    const insertMessage = db.prepare(`INSERT INTO messages (
      id, record_key, chat_key, message_id, platform, chat_id, role,
      accepted_at, received_at, sequence, generation, disposition, record_json
    ) VALUES (?, ?, ?, ?, 'telegram', 'joined', 'user', ?, ?, ?, 0, 'actionable', '{}')`);
    insertMessage.run(
      "owner-message",
      "owner-record",
      chatKey,
      "owner-provider",
      timestamp,
      timestamp,
      1,
    );
    insertMessage.run(
      "joined-message",
      "joined-record",
      chatKey,
      "joined-provider",
      timestamp,
      timestamp,
      2,
    );
    insertMessage.run(
      "empty-message",
      "empty-record",
      chatKey,
      "empty-provider",
      null,
      timestamp,
      3,
    );
    const insertTurn = db.prepare(`INSERT INTO inbox_jobs (
      turn_id, inbound_message_id, chat_key, generation, sequence, state,
      terminal_kind, owner_epoch, attempt, admission_json, created_at, updated_at
    ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insertTurn.run(
      "owner-turn",
      "owner-message",
      chatKey,
      1,
      "terminal",
      "outbox_final",
      null,
      1,
      null,
      timestamp,
      timestamp,
    );
    insertTurn.run(
      "joined-turn",
      "joined-message",
      chatKey,
      2,
      "running",
      null,
      "joined-owner",
      1,
      JSON.stringify({ joinedTurnId: "owner-turn" }),
      timestamp,
      timestamp,
    );
    insertTurn.run(
      "empty-turn",
      "empty-message",
      chatKey,
      3,
      "running",
      null,
      "empty-owner",
      2,
      null,
      timestamp,
      timestamp,
    );
    db.prepare(
      `INSERT INTO outbox (
      outbox_id, turn_id, chat_key, delivery_kind, state, payload_json,
      post_delivery_json, sequence, attempts, created_at, updated_at, delivered_at
    ) VALUES (?, ?, ?, 'final', 'delivered', '{}', ?, 1, 1, ?, ?, ?)`,
    ).run(
      "chat-terminal-owner",
      "owner-turn",
      chatKey,
      JSON.stringify({
        markJoinedProcessed: {
          ownerTurnId: "owner-turn",
          deliveryKind: "outbox_final",
        },
      }),
      timestamp,
      timestamp,
      timestamp,
    );

    assert.deepEqual(
      database.readLatestJoinedChatPresentation(agentDir, "owner-turn"),
      {
        turnId: "joined-turn",
        chatKey,
        messageId: "joined-provider",
      },
    );
    assert.equal(
      database.readLatestJoinedChatPresentation(agentDir, "missing-turn"),
      null,
    );
    assert.deepEqual(
      database.markTerminalOwnerAndJoinedChatMessagesProcessed(
        agentDir,
        "owner-turn",
        {
          deliveryKind: "outbox_final",
          outboxId: "chat-terminal-owner",
          deferProcessedMessage: { chatKey, messageId: "" },
        },
      ),
      { matched: false, processedMessages: 0 },
    );
    assert.deepEqual(
      database.markTerminalOwnerAndJoinedChatMessagesProcessed(
        agentDir,
        "owner-turn",
        {
          deliveryKind: "outbox_final",
          outboxId: "chat-terminal-owner",
          deferProcessedMessage: {
            chatKey,
            messageId: "missing-provider",
          },
        },
      ),
      { matched: false, processedMessages: 0 },
    );
    assert.deepEqual(
      database.markTerminalOwnerAndJoinedChatMessagesProcessed(
        agentDir,
        "owner-turn",
        {
          processedAt: timestamp,
          deliveryKind: "outbox_final",
          outboxId: "chat-terminal-owner",
        },
      ),
      { matched: true, processedMessages: 2 },
    );
    assert.equal(
      db
        .prepare(
          `SELECT json_extract(admission_json, '$.settledOutboxId') AS value
             FROM inbox_jobs WHERE turn_id = 'joined-turn'`,
        )
        .get().value,
      "chat-terminal-owner",
    );

    const emptyFence = {
      turnId: "empty-turn",
      chatKey,
      messageId: "empty-provider",
      ownerEpoch: "empty-owner",
      attempt: 2,
    };
    assert.deepEqual(
      db
        .prepare(
          `SELECT inbox_jobs.state, inbox_jobs.owner_epoch,
                  inbox_jobs.attempt, inbox_jobs.generation,
                  chat_state.current_generation, messages.message_id
             FROM inbox_jobs
             JOIN messages ON messages.id = inbox_jobs.inbound_message_id
             JOIN chat_state ON chat_state.chat_key = inbox_jobs.chat_key
            WHERE inbox_jobs.turn_id = 'empty-turn'`,
        )
        .get(),
      {
        state: "running",
        owner_epoch: "empty-owner",
        attempt: 2,
        generation: 0,
        current_generation: 0,
        message_id: "empty-provider",
      },
    );
    assert.equal(
      database.completeChatTurnWithoutDelivery(agentDir, emptyFence, {
        sessionFile: "managed/chat/empty.jsonl",
      }),
      true,
    );
    assert.equal(
      database.completeChatTurnWithoutDelivery(agentDir, emptyFence),
      false,
    );
    const emptyCompletion = db
      .prepare(
        `SELECT inbox_jobs.state, inbox_jobs.terminal_kind,
                messages.disposition, messages.processed_at
           FROM inbox_jobs
           JOIN messages ON messages.id = inbox_jobs.inbound_message_id
          WHERE inbox_jobs.turn_id = 'empty-turn'`,
      )
      .get();
    assert.equal(emptyCompletion.state, "terminal");
    assert.equal(emptyCompletion.terminal_kind, "empty_completion");
    assert.equal(emptyCompletion.disposition, "actionable");
    assert.match(emptyCompletion.processed_at, /^\d{4}-\d{2}-\d{2}T/);
    database.closeChatDatabase(agentDir);
  } finally {
    database.closeChatDatabase(agentDir);
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});
