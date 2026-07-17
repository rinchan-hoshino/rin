import fs from "node:fs";
import path from "node:path";

import { chatDataPath } from "../data-layout.js";
import { safeString } from "../text-utils.js";
import {
  finalizeLegacyChatKeyMigration,
  migrateLegacyChatKeys,
  preflightLegacyChatKeys,
} from "./chat-key-migration.js";
import {
  closeChatDatabase,
  importLegacyChatSessionBinding,
  migrateChatDatabaseForInstall,
  preflightChatDatabaseMigrationForInstall,
} from "./database.js";
import {
  retryUnresolvedLegacyChatKeyMessages,
  validateResolvedChatKeyLedger,
} from "./legacy-migration.js";
import { listChatStateFiles } from "./support.js";

function readInstalledSettings(settingsPath: string) {
  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT") return {};
    throw new Error(
      `chat_install_migration_invalid_settings:${String(error?.message || error)}`,
    );
  }
}

function importInstalledLegacySessionBindings(agentDir: string) {
  let imported = 0;
  const stateFiles = listChatStateFiles(
    chatDataPath(agentDir, "session-state"),
  );
  for (const item of stateFiles) {
    let state: any;
    try {
      state = JSON.parse(fs.readFileSync(item.statePath, "utf8"));
    } catch (error: any) {
      throw new Error(
        `chat_install_migration_invalid_session_state:${item.statePath}:${String(error?.message || error)}`,
      );
    }
    if (
      importLegacyChatSessionBinding(
        agentDir,
        item.chatKey,
        safeString(state?.sessionFile).trim(),
      )
    ) {
      imported += 1;
    }
  }
  return { scanned: stateFiles.length, imported };
}

export function preflightChatInstallMigrations(
  agentDirInput: string,
  settingsPathInput?: string,
) {
  const agentDir = path.resolve(agentDirInput);
  const settingsPath = settingsPathInput
    ? path.resolve(settingsPathInput)
    : path.join(agentDir, "settings.json");
  const settings = readInstalledSettings(settingsPath);
  const keyMigration = preflightLegacyChatKeys(agentDir, settings);
  validateResolvedChatKeyLedger(agentDir);
  const database = preflightChatDatabaseMigrationForInstall(agentDir);
  const stateFiles = listChatStateFiles(
    chatDataPath(agentDir, "session-state"),
  );
  for (const item of stateFiles) {
    try {
      JSON.parse(fs.readFileSync(item.statePath, "utf8"));
    } catch (error: any) {
      throw new Error(
        `chat_install_migration_invalid_session_state:${item.statePath}:${String(error?.message || error)}`,
      );
    }
  }
  return {
    keyMigration,
    database,
    sessionBindings: { scanned: stateFiles.length },
  };
}

export function runChatInstallMigrations(
  agentDirInput: string,
  settingsPathInput?: string,
) {
  const agentDir = path.resolve(agentDirInput);
  const settingsPath = settingsPathInput
    ? path.resolve(settingsPathInput)
    : path.join(agentDir, "settings.json");
  const keyMigration = migrateLegacyChatKeys(
    agentDir,
    settingsPath,
    readInstalledSettings(settingsPath),
  );
  try {
    const db = migrateChatDatabaseForInstall(agentDir);
    validateResolvedChatKeyLedger(agentDir);
    const deferredRecords = keyMigration.alreadyApplied
      ? {
          resolvedRecords: 0,
          unresolvedRecords: 0,
          unresolvedRecordReasons: {},
        }
      : retryUnresolvedLegacyChatKeyMessages(agentDir, db);
    const keyMigrationStatus = finalizeLegacyChatKeyMigration(agentDir, {
      unresolvedSettings: keyMigration.unresolvedSettings,
      unresolvedRecords: deferredRecords.unresolvedRecords,
      unresolvedRecordReasons: deferredRecords.unresolvedRecordReasons,
    });
    const sessionBindings = importInstalledLegacySessionBindings(agentDir);
    return {
      keyMigration: {
        id: keyMigration.id,
        alreadyApplied: keyMigration.alreadyApplied,
        complete: keyMigrationStatus.complete,
        migratedRecords: keyMigration.migratedRecords,
        mergedRecords: keyMigration.mergedRecords,
        resolvedRecords: keyMigration.resolvedRecords,
        deferredResolvedRecords: deferredRecords.resolvedRecords,
        unresolvedSettings: keyMigrationStatus.unresolvedSettings,
        unresolvedRecords: keyMigrationStatus.unresolvedRecords,
        unresolvedRecordReasons:
          keyMigrationStatus.unresolvedRecordReasons || {},
      },
      database: {
        path: path.join(agentDir, "data", "chat", "chat.sqlite"),
        schemaVersion: Number(db.pragma("user_version", { simple: true })),
      },
      sessionBindings,
    };
  } finally {
    closeChatDatabase(agentDir);
  }
}
