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

test("chat install migration rejects invalid settings and session state", async () => {
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
    assert.throws(
      () => migration.preflightChatInstallMigrations(agentDir),
      /chat_install_migration_invalid_session_state/,
    );
    assert.throws(
      () => migration.runChatInstallMigrations(agentDir),
      /chat_install_migration_invalid_session_state/,
    );
  });
});
