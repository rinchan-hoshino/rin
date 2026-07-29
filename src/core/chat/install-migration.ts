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
} from "./database.js";
import {
  completeCanonicalReconciliationInstallState,
  migrateChatDatabaseForInstall,
  preflightChatDatabaseMigrationForInstall,
  readAdmissionModelInstallMigrationSummary,
  readCanonicalReconciliationInstallState,
} from "./database-install-migration.js";
import {
  readLegacyControlMigrationPreservedSummary,
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

function readInstalledLegacySessionState(statePath: string) {
  let text: string;
  try {
    text = fs.readFileSync(statePath, "utf8");
  } catch (error: any) {
    throw new Error(
      `chat_install_migration_session_state_read_failed:${statePath}:${String(error?.message || error)}`,
    );
  }
  try {
    const state = JSON.parse(text);
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      return { state: null, preservedReason: "invalid_shape" };
    }
    return { state, preservedReason: "" };
  } catch {
    return { state: null, preservedReason: "invalid_json" };
  }
}

function summarizeInstalledLegacySessionStates(
  stateFiles: ReturnType<typeof listChatStateFiles>,
) {
  const readable: Array<{
    item: (typeof stateFiles)[number];
    state: Record<string, unknown>;
  }> = [];
  const preservedReasons: Record<string, number> = {};
  let withoutBinding = 0;
  for (const item of stateFiles) {
    const result = readInstalledLegacySessionState(item.statePath);
    if (result.state) {
      if (!Object.prototype.hasOwnProperty.call(result.state, "sessionFile")) {
        withoutBinding += 1;
        continue;
      }
      if (
        typeof result.state.sessionFile === "string" &&
        result.state.sessionFile.trim()
      ) {
        readable.push({ item, state: result.state });
        continue;
      }
      preservedReasons.invalid_session_file =
        (preservedReasons.invalid_session_file || 0) + 1;
      continue;
    }
    preservedReasons[result.preservedReason] =
      (preservedReasons[result.preservedReason] || 0) + 1;
  }
  const preserved = Object.values(preservedReasons).reduce(
    (total, count) => total + count,
    0,
  );
  return { readable, preserved, preservedReasons, withoutBinding };
}

function fsyncDirectory(directory: string) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function retireCanonicalReconciliationSessionBindings(
  agentDir: string,
  db: ReturnType<typeof migrateChatDatabaseForInstall>,
) {
  const reconciliation = readCanonicalReconciliationInstallState(db);
  if (!reconciliation || reconciliation.state === "complete") return 0;
  const targets = new Set(reconciliation.chatKeys);
  const stateFiles = listChatStateFiles(
    chatDataPath(agentDir, "session-state"),
  );
  let retired = 0;
  for (const item of stateFiles) {
    if (!targets.has(item.chatKey)) continue;
    const backupPath = `${item.statePath}.canonical-v8-retired`;
    if (fs.existsSync(backupPath)) {
      throw new Error(
        `chat_install_migration_canonical_reconciliation_backup_exists:${backupPath}`,
      );
    }
    fs.renameSync(item.statePath, backupPath);
    fsyncDirectory(path.dirname(item.statePath));
    retired += 1;
    targets.delete(item.chatKey);
  }
  if (targets.size) {
    for (const chatKey of targets) {
      const stillBound = db
        .prepare(`SELECT session_file FROM chat_state WHERE chat_key = ?`)
        .get(chatKey) as { session_file?: string | null } | undefined;
      if (safeString(stillBound?.session_file).trim()) {
        throw new Error(
          `chat_install_migration_canonical_reconciliation_binding_remains:${chatKey}`,
        );
      }
    }
  }
  db.transaction(() => {
    completeCanonicalReconciliationInstallState(db);
  })();
  return retired;
}

function importInstalledLegacySessionBindings(agentDir: string) {
  let imported = 0;
  const stateFiles = listChatStateFiles(
    chatDataPath(agentDir, "session-state"),
  );
  const summary = summarizeInstalledLegacySessionStates(stateFiles);
  for (const { item, state } of summary.readable) {
    if (
      importLegacyChatSessionBinding(
        agentDir,
        item.chatKey,
        safeString(state.sessionFile).trim(),
      )
    ) {
      imported += 1;
    }
  }
  return {
    scanned: stateFiles.length,
    imported,
    preserved: summary.preserved,
    preservedReasons: summary.preservedReasons,
    withoutBinding: summary.withoutBinding,
  };
}

export function preflightChatInstallMigrations(
  agentDirInput: string,
  settingsPathInput?: string,
  options: { runtimeWillBeQuiesced?: boolean } = {},
) {
  const agentDir = path.resolve(agentDirInput);
  const settingsPath = settingsPathInput
    ? path.resolve(settingsPathInput)
    : path.join(agentDir, "settings.json");
  const settings = readInstalledSettings(settingsPath);
  const keyMigration = preflightLegacyChatKeys(agentDir, settings);
  validateResolvedChatKeyLedger(agentDir);
  const database = preflightChatDatabaseMigrationForInstall(agentDir, options);
  const stateFiles = listChatStateFiles(
    chatDataPath(agentDir, "session-state"),
  );
  const sessionStates = summarizeInstalledLegacySessionStates(stateFiles);
  return {
    keyMigration,
    database,
    sessionBindings: {
      scanned: stateFiles.length,
      preserved: sessionStates.preserved,
      preservedReasons: sessionStates.preservedReasons,
      withoutBinding: sessionStates.withoutBinding,
    },
  };
}

export function runChatInstallMigrations(
  agentDirInput: string,
  settingsPathInput?: string,
  options: { runtimeQuiesced?: boolean } = {},
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
    const db = migrateChatDatabaseForInstall(agentDir, options);
    const oldAdmissions = readAdmissionModelInstallMigrationSummary(db);
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
    const retiredCanonicalReconciliation =
      retireCanonicalReconciliationSessionBindings(agentDir, db);
    const sessionBindings = {
      ...importInstalledLegacySessionBindings(agentDir),
      retiredCanonicalReconciliation,
    };
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
        preservedRecords: readLegacyControlMigrationPreservedSummary(db),
        oldAdmissions,
      },
      sessionBindings,
    };
  } finally {
    closeChatDatabase(agentDir);
  }
}
