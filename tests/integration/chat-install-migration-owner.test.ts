import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
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
    path.join(rootDir, "dist", "core", "chat", "install-migration.js"),
  ).href
);
const database = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "database.js")).href
);

async function withAgent(
  run: (agentDir: string, statePath: string) => Promise<void>,
) {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-install-migration-"),
  );
  const statePath = path.join(
    agentDir,
    "data",
    "chat",
    "session-state",
    "telegram",
    "bot-1",
    "chat-1",
    "state.json",
  );
  try {
    await run(agentDir, statePath);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

test("chat install migration preflights and commits session bindings", async () => {
  await withAgent(async (agentDir, statePath) => {
    const preflight = migration.preflightChatInstallMigrations(agentDir);
    assert.equal(preflight.sessionBindings.scanned, 0);

    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(
      statePath,
      `${JSON.stringify({ sessionFile: "sessions/chat-1.jsonl" })}\n`,
    );
    const committed = migration.runChatInstallMigrations(agentDir);
    assert.equal(committed.sessionBindings.scanned, 1);
    assert.equal(committed.sessionBindings.imported, 1);
    assert.equal(committed.database.schemaVersion > 0, true);

    const repeated = migration.runChatInstallMigrations(agentDir);
    assert.equal(repeated.keyMigration.alreadyApplied, true);
    assert.equal(repeated.sessionBindings.imported, 0);
  });
});

test("chat install migration rejects invalid settings and preserves invalid session state", async () => {
  await withAgent(async (agentDir, statePath) => {
    const settingsPath = path.join(agentDir, "custom-settings.json");
    await fs.writeFile(settingsPath, "not json");
    assert.throws(
      () => migration.preflightChatInstallMigrations(agentDir, settingsPath),
      /chat_install_migration_invalid_settings/,
    );
    assert.throws(
      () => migration.runChatInstallMigrations(agentDir, settingsPath),
      /chat_install_migration_invalid_settings/,
    );
    const originalReadFileSync = fsSync.readFileSync;
    fsSync.readFileSync = ((
      filePath: fsSync.PathOrFileDescriptor,
      ...args: any[]
    ) => {
      if (filePath === settingsPath) throw "settings read failed";
      return (originalReadFileSync as any)(filePath, ...args);
    }) as typeof fsSync.readFileSync;
    try {
      assert.throws(
        () => migration.preflightChatInstallMigrations(agentDir, settingsPath),
        /chat_install_migration_invalid_settings:settings read failed/,
      );
    } finally {
      fsSync.readFileSync = originalReadFileSync;
    }

    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, "not json");
    assert.deepEqual(
      migration.preflightChatInstallMigrations(agentDir).sessionBindings,
      {
        scanned: 1,
        preserved: 1,
        preservedReasons: { invalid_json: 1 },
        withoutBinding: 0,
      },
    );
    assert.deepEqual(
      migration.runChatInstallMigrations(agentDir).sessionBindings,
      {
        scanned: 1,
        imported: 0,
        preserved: 1,
        preservedReasons: { invalid_json: 1 },
        withoutBinding: 0,
        retiredCanonicalReconciliation: 0,
      },
    );
  });
});

test("chat install migration retires canonical reconciliation session bindings", async () => {
  await withAgent(async (agentDir, statePath) => {
    const chatKey = "telegram/bot-1:chat-1";
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(
      statePath,
      `${JSON.stringify({ sessionFile: "sessions/interrupted.jsonl" })}\n`,
    );

    const db = database.openChatDatabase(agentDir);
    db.prepare(
      `INSERT INTO schema_meta (key, value)
       VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(
      "canonical_run_reconciliation_v8",
      JSON.stringify({
        version: 1,
        state: "pending_session_retirement",
        chatKeys: [chatKey],
        interruptedTurnIds: ["interrupted-turn"],
        retiredRunIds: ["retired-run"],
        createdAt: "2026-08-01T00:00:00.000Z",
        completedAt: null,
      }),
    );
    database.closeChatDatabase(agentDir);

    const result = migration.runChatInstallMigrations(agentDir, undefined, {
      runtimeQuiesced: true,
    });
    assert.equal(result.sessionBindings.retiredCanonicalReconciliation, 1);
    assert.equal(fsSync.existsSync(statePath), false);
    assert.equal(fsSync.existsSync(`${statePath}.canonical-v8-retired`), true);

    const reopened = database.openChatDatabase(agentDir);
    const reconciliation = reopened
      .prepare(`SELECT value FROM schema_meta WHERE key = ?`)
      .get("canonical_run_reconciliation_v8") as { value: string };
    assert.equal(JSON.parse(reconciliation.value).state, "complete");
    database.closeChatDatabase(agentDir);
  });
});

test("chat install migration classifies preserved session-state variants", async () => {
  await withAgent(async (agentDir, statePath) => {
    await fs.mkdir(path.dirname(statePath), { recursive: true });

    await fs.writeFile(statePath, "[]\n");
    assert.deepEqual(
      migration.preflightChatInstallMigrations(agentDir).sessionBindings,
      {
        scanned: 1,
        preserved: 1,
        preservedReasons: { invalid_shape: 1 },
        withoutBinding: 0,
      },
    );

    await fs.writeFile(statePath, "{}\n");
    assert.deepEqual(
      migration.preflightChatInstallMigrations(agentDir).sessionBindings,
      {
        scanned: 1,
        preserved: 0,
        preservedReasons: {},
        withoutBinding: 1,
      },
    );

    await fs.writeFile(statePath, '{"sessionFile":""}\n');
    assert.deepEqual(
      migration.preflightChatInstallMigrations(agentDir).sessionBindings,
      {
        scanned: 1,
        preserved: 1,
        preservedReasons: { invalid_session_file: 1 },
        withoutBinding: 0,
      },
    );

    const originalReadFileSync = fsSync.readFileSync;
    fsSync.readFileSync = ((
      filePath: fsSync.PathOrFileDescriptor,
      ...args: any[]
    ) => {
      if (filePath === statePath) throw new Error("session state unavailable");
      return (originalReadFileSync as any)(filePath, ...args);
    }) as typeof fsSync.readFileSync;
    try {
      assert.throws(
        () => migration.preflightChatInstallMigrations(agentDir),
        /chat_install_migration_session_state_read_failed:.*session state unavailable/,
      );
    } finally {
      fsSync.readFileSync = originalReadFileSync;
    }
  });
});
