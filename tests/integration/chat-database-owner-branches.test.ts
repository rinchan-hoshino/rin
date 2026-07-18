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
const database = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "database.js")).href
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

test("chat database install preflight distinguishes absent, empty, partial, and future schemas", async () => {
  const absent = await tempAgent("rin-chat-db-absent-");
  const empty = await tempAgent("rin-chat-db-empty-");
  const partial = await tempAgent("rin-chat-db-partial-");
  const future = await tempAgent("rin-chat-db-future-");
  const current = await tempAgent("rin-chat-db-current-");
  try {
    assert.equal(
      database.preflightChatDatabaseMigrationForInstall(absent).fromVersion,
      0,
    );

    (await createDatabase(empty)).close();
    assert.equal(
      database.preflightChatDatabaseMigrationForInstall(empty).fromVersion,
      0,
    );

    const partialDb = await createDatabase(partial);
    partialDb.exec("CREATE TABLE stray (id TEXT)");
    partialDb.close();
    assert.throws(
      () => database.preflightChatDatabaseMigrationForInstall(partial),
      /chat_database_partial_schema/,
    );

    const futureDb = await createDatabase(future);
    futureDb.pragma("user_version = 999");
    futureDb.close();
    assert.throws(
      () => database.preflightChatDatabaseMigrationForInstall(future),
      /chat_database_future_schema:999/,
    );

    database.openChatDatabase(current);
    database.closeChatDatabase(current);
    assert.equal(
      database.preflightChatDatabaseMigrationForInstall(current).fromVersion >
        0,
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
    assert.equal(database.migrateChatDatabaseForInstall(agentDir), first);

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

    assert.deepEqual(database.readChatState(agentDir, "telegram/1:2"), {
      chatKey: "telegram/1:2",
      currentGeneration: 0,
      nextSequence: 1,
    });
    assert.deepEqual(
      database.allocateChatSequenceInDatabase(first, "telegram/1:2"),
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
