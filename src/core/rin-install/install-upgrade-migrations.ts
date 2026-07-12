import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  chatDataPath,
  LEGACY_DATA_LAYOUT_MOVES,
  schedulerDataPath,
} from "../data-layout.js";
import {
  listChatStateFiles,
  listDetachedControllerStateFiles,
} from "../chat/support.js";
import { stringifyJson } from "../platform/fs.js";
import { getManagedChatSessionDir } from "../session/managed-paths.js";
import { nowIso } from "../time-utils.js";
import { safeString } from "../text-utils.js";

type InstallPathMoveResult = {
  id: string;
  fromPath: string;
  toPath: string;
  moved: boolean;
  skipped: boolean;
};

type InstallMigrationCommandDeps = {
  runPrivileged: (command: string, args: string[]) => void;
  runCommandAsUser?: (
    targetUser: string,
    command: string,
    args: string[],
  ) => void;
  captureCommandAsUser?: (
    targetUser: string,
    command: string,
    args: string[],
  ) => string;
};

type InstallMigrationOptions = {
  targetUser: string;
  elevated?: boolean;
};

type InstallMigrationFileOps = {
  pathExists: (filePath: string) => boolean;
  readJsonObject: (filePath: string) => Record<string, unknown> | null;
  writeJsonObject: (filePath: string, value: unknown) => void;
  ensureDir: (dirPath: string) => void;
  rename: (fromPath: string, toPath: string) => void;
  remove: (targetPath: string) => void;
};

function parseJsonObject(text: string) {
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function runMigrationCommandAsTargetUser(
  options: InstallMigrationOptions,
  deps: InstallMigrationCommandDeps,
  command: string,
  args: string[],
) {
  if (!deps.runCommandAsUser) {
    throw new Error("Install migration requires target-user command support.");
  }
  deps.runCommandAsUser(options.targetUser, command, args);
}

function writeTextFileAsTargetUser(
  filePath: string,
  value: string,
  options: InstallMigrationOptions,
  deps: InstallMigrationCommandDeps,
  mode = 0o600,
) {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-install-migration-write-"),
  );
  const tempFile = path.join(tempDir, "payload");
  try {
    fs.chmodSync(tempDir, 0o755);
    fs.writeFileSync(tempFile, value, "utf8");
    fs.chmodSync(tempFile, 0o644);
    runMigrationCommandAsTargetUser(options, deps, "mkdir", [
      "-p",
      path.dirname(filePath),
    ]);
    runMigrationCommandAsTargetUser(options, deps, "install", [
      "-m",
      mode.toString(8),
      tempFile,
      filePath,
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function createInstallMigrationFileOps(
  options: InstallMigrationOptions,
  deps: InstallMigrationCommandDeps,
): InstallMigrationFileOps {
  const elevated = Boolean(options.elevated);
  return {
    pathExists(filePath: string) {
      try {
        fs.accessSync(filePath);
        return true;
      } catch (error: any) {
        const code = String(error?.code || "");
        if ((code === "EACCES" || code === "EPERM") && elevated) {
          try {
            runMigrationCommandAsTargetUser(options, deps, "test", [
              "-e",
              filePath,
            ]);
            return true;
          } catch {}
        }
        return false;
      }
    },
    readJsonObject(filePath: string) {
      try {
        return parseJsonObject(fs.readFileSync(filePath, "utf8"));
      } catch (error: any) {
        const code = String(error?.code || "");
        if (
          (code === "EACCES" || code === "EPERM") &&
          elevated &&
          deps.captureCommandAsUser
        ) {
          try {
            return parseJsonObject(
              deps.captureCommandAsUser(options.targetUser, "cat", [filePath]),
            );
          } catch {}
        }
        return null;
      }
    },
    writeJsonObject(filePath: string, value: unknown) {
      if (elevated) {
        writeTextFileAsTargetUser(
          filePath,
          stringifyJson(value),
          options,
          deps,
        );
        return;
      }
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, stringifyJson(value), "utf8");
    },
    ensureDir(dirPath: string) {
      if (elevated) {
        runMigrationCommandAsTargetUser(options, deps, "mkdir", [
          "-p",
          dirPath,
        ]);
        return;
      }
      fs.mkdirSync(dirPath, { recursive: true });
    },
    rename(fromPath: string, toPath: string) {
      if (elevated) {
        runMigrationCommandAsTargetUser(options, deps, "mv", [
          fromPath,
          toPath,
        ]);
        return;
      }
      fs.renameSync(fromPath, toPath);
    },
    remove(targetPath: string) {
      if (elevated) {
        runMigrationCommandAsTargetUser(options, deps, "rm", [
          "-rf",
          targetPath,
        ]);
        return;
      }
      fs.rmSync(targetPath, { recursive: true, force: true });
    },
  };
}

function moveInstalledPathIfNeeded(
  move: {
    id: string;
    fromPath: string;
    toPath: string;
  },
  fileOps: InstallMigrationFileOps,
): InstallPathMoveResult {
  const hasSource = fileOps.pathExists(move.fromPath);
  if (!hasSource) {
    return { ...move, moved: false, skipped: false };
  }
  const hasTarget = fileOps.pathExists(move.toPath);
  if (hasTarget) {
    return { ...move, moved: false, skipped: true };
  }
  fileOps.ensureDir(path.dirname(move.toPath));
  fileOps.rename(move.fromPath, move.toPath);
  return { ...move, moved: true, skipped: false };
}

type InstallDataLayoutMigrationResult = {
  id: "data-layout-v1";
  skipped: boolean;
  moved: number;
  skippedExistingTarget: number;
  movedPaths: Array<{ id: string; fromPath: string; toPath: string }>;
};

function migrateInstalledDataLayout(
  installDir: string,
  fileOps: InstallMigrationFileOps,
): InstallDataLayoutMigrationResult {
  const root = path.resolve(String(installDir || "").trim() || ".");
  const movedPaths: InstallDataLayoutMigrationResult["movedPaths"] = [];
  let skippedExistingTarget = 0;
  for (const move of LEGACY_DATA_LAYOUT_MOVES) {
    const result = moveInstalledPathIfNeeded(
      {
        id: move.id,
        fromPath: path.join(root, "data", move.from),
        toPath: path.join(root, "data", move.to),
      },
      fileOps,
    );
    if (result.moved) {
      movedPaths.push({
        id: move.id,
        fromPath: result.fromPath,
        toPath: result.toPath,
      });
    } else if (result.skipped) {
      skippedExistingTarget += 1;
    }
  }
  return {
    id: "data-layout-v1",
    skipped: movedPaths.length === 0,
    moved: movedPaths.length,
    skippedExistingTarget,
    movedPaths,
  };
}

const CHAT_STATE_SESSION_FILE_MIGRATION_ID = "chat-state-session-file-v1";
const CHAT_SESSION_MANAGED_FILE_MIGRATION_ID = "chat-session-managed-file-v1";

type InstallStateRewriteResult = {
  id: string;
  markerPath: string;
  alreadyApplied: boolean;
  skipped: boolean;
  scanned: number;
  migrated: number;
  migratedFiles: string[];
};

function uniqueStatePaths(paths: unknown[]) {
  return Array.from(
    new Set(
      (Array.isArray(paths) ? paths : [])
        .map((value) => safeString(value).trim())
        .filter(Boolean)
        .map((value) => path.resolve(value)),
    ),
  );
}

function rewriteChatStateSessionFileKey(
  statePath: string,
  fileOps: InstallMigrationFileOps,
) {
  const state = fileOps.readJsonObject(statePath);
  if (!state) return false;
  if (!Object.prototype.hasOwnProperty.call(state, "piSessionFile")) {
    return false;
  }

  const nextState: Record<string, unknown> = { ...state };
  const sessionFile = safeString(nextState.sessionFile).trim();
  const previousSessionFile = safeString(nextState.piSessionFile).trim();
  if (!sessionFile && previousSessionFile) {
    nextState.sessionFile = previousSessionFile;
  }
  delete nextState.piSessionFile;
  fileOps.writeJsonObject(statePath, nextState);
  return true;
}

function chatStateSessionFileMigrationMarkerPath(installDir: string) {
  return path.join(
    path.resolve(String(installDir || "").trim() || "."),
    "data",
    "migrations",
    `${CHAT_STATE_SESSION_FILE_MIGRATION_ID}.json`,
  );
}

function rewriteInstalledChatStateSessionFileKeys(
  installDir: string,
  fileOps: InstallMigrationFileOps,
): InstallStateRewriteResult {
  const markerPath = chatStateSessionFileMigrationMarkerPath(installDir);
  const marker = fileOps.readJsonObject(markerPath);
  if (
    marker &&
    safeString(marker.id || marker.migrationId).trim() ===
      CHAT_STATE_SESSION_FILE_MIGRATION_ID
  ) {
    return {
      id: CHAT_STATE_SESSION_FILE_MIGRATION_ID,
      markerPath,
      alreadyApplied: true,
      skipped: true,
      scanned: 0,
      migrated: 0,
      migratedFiles: [],
    };
  }

  const root = path.resolve(String(installDir || "").trim() || ".");
  const statePaths = uniqueStatePaths([
    ...listChatStateFiles(chatDataPath(root, "session-state")).map(
      (item) => item.statePath,
    ),
    ...listChatStateFiles(path.join(root, "data", "chats")).map(
      (item) => item.statePath,
    ),
    ...listDetachedControllerStateFiles(schedulerDataPath(root, "turns")).map(
      (item) => item.statePath,
    ),
    ...listDetachedControllerStateFiles(
      path.join(root, "data", "cron-turns"),
    ).map((item) => item.statePath),
  ]);
  const migratedFiles: string[] = [];
  for (const statePath of statePaths) {
    if (!rewriteChatStateSessionFileKey(statePath, fileOps)) continue;
    migratedFiles.push(statePath);
  }

  const scanned = statePaths.length;
  const migrated = migratedFiles.length;
  if (migrated === 0) {
    return {
      id: CHAT_STATE_SESSION_FILE_MIGRATION_ID,
      markerPath,
      alreadyApplied: false,
      skipped: true,
      scanned,
      migrated,
      migratedFiles,
    };
  }

  fileOps.writeJsonObject(markerPath, {
    id: CHAT_STATE_SESSION_FILE_MIGRATION_ID,
    appliedAt: nowIso(),
    scanned,
    migrated,
  });
  return {
    id: CHAT_STATE_SESSION_FILE_MIGRATION_ID,
    markerPath,
    alreadyApplied: false,
    skipped: false,
    scanned,
    migrated,
    migratedFiles,
  };
}

function chatSessionManagedFileMigrationMarkerPath(installDir: string) {
  return path.join(
    path.resolve(String(installDir || "").trim() || "."),
    "data",
    "migrations",
    `${CHAT_SESSION_MANAGED_FILE_MIGRATION_ID}.json`,
  );
}

function sessionFilePathForInstalledChatState(
  installDir: string,
  sessionFile: string,
) {
  const sessionsDir = path.join(path.resolve(installDir), "sessions");
  const raw = safeString(sessionFile).trim();
  if (!raw) return null;
  const absolute = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.join(sessionsDir, raw);
  const basename = path.basename(absolute);
  if (!basename.endsWith(".jsonl")) return null;
  if (absolute !== path.join(sessionsDir, basename)) return null;
  return { sessionsDir, absolute, basename };
}

function pickAvailableManagedChatSessionPath(
  managedDir: string,
  basename: string,
  fileOps: InstallMigrationFileOps,
) {
  const parsed = path.parse(basename);
  let candidate = path.join(managedDir, basename);
  let index = 2;
  while (fileOps.pathExists(candidate)) {
    candidate = path.join(
      managedDir,
      `${parsed.name}-${index}${parsed.ext || ".jsonl"}`,
    );
    index += 1;
  }
  return candidate;
}

function migrateChatStateSessionFileToManaged(
  installDir: string,
  statePath: string,
  fileOps: InstallMigrationFileOps,
) {
  const state = fileOps.readJsonObject(statePath);
  if (!state) return "";
  const sessionFile = safeString(state.sessionFile).trim();
  if (!sessionFile || sessionFile.startsWith("managed/")) return "";
  const source = sessionFilePathForInstalledChatState(installDir, sessionFile);
  if (!source) return "";

  const managedDir = getManagedChatSessionDir(installDir);
  const targetPath = pickAvailableManagedChatSessionPath(
    managedDir,
    source.basename,
    fileOps,
  );
  if (!fileOps.pathExists(source.absolute)) return "";
  fileOps.ensureDir(path.dirname(targetPath));
  fileOps.rename(source.absolute, targetPath);

  const nextState: Record<string, unknown> = { ...state };
  nextState.sessionFile = path.relative(source.sessionsDir, targetPath);
  fileOps.writeJsonObject(statePath, nextState);
  return targetPath;
}

function migrateInstalledChatSessionFilesToManaged(
  installDir: string,
  fileOps: InstallMigrationFileOps,
): InstallStateRewriteResult {
  const markerPath = chatSessionManagedFileMigrationMarkerPath(installDir);
  const marker = fileOps.readJsonObject(markerPath);
  if (
    marker &&
    safeString(marker.id || marker.migrationId).trim() ===
      CHAT_SESSION_MANAGED_FILE_MIGRATION_ID
  ) {
    return {
      id: CHAT_SESSION_MANAGED_FILE_MIGRATION_ID,
      markerPath,
      alreadyApplied: true,
      skipped: true,
      scanned: 0,
      migrated: 0,
      migratedFiles: [],
    };
  }

  const root = path.resolve(String(installDir || "").trim() || ".");
  const statePaths = uniqueStatePaths([
    ...listChatStateFiles(chatDataPath(root, "session-state")).map(
      (item) => item.statePath,
    ),
    ...listChatStateFiles(path.join(root, "data", "chats")).map(
      (item) => item.statePath,
    ),
  ]);
  const migratedFiles: string[] = [];
  for (const statePath of statePaths) {
    const migratedFile = migrateChatStateSessionFileToManaged(
      root,
      statePath,
      fileOps,
    );
    if (migratedFile) migratedFiles.push(migratedFile);
  }

  const scanned = statePaths.length;
  const migrated = migratedFiles.length;
  if (migrated === 0) {
    return {
      id: CHAT_SESSION_MANAGED_FILE_MIGRATION_ID,
      markerPath,
      alreadyApplied: false,
      skipped: true,
      scanned,
      migrated,
      migratedFiles,
    };
  }

  fileOps.writeJsonObject(markerPath, {
    id: CHAT_SESSION_MANAGED_FILE_MIGRATION_ID,
    appliedAt: nowIso(),
    scanned,
    migrated,
  });
  return {
    id: CHAT_SESSION_MANAGED_FILE_MIGRATION_ID,
    markerPath,
    alreadyApplied: false,
    skipped: false,
    scanned,
    migrated,
    migratedFiles,
  };
}

function normalizeStringList(value: unknown) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => safeString(item).trim()).filter(Boolean))]
    : [];
}

function getObjectAtPath(root: any, keys: string[]) {
  let current = root;
  for (const key of keys) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function ensureObjectAtPath(root: Record<string, unknown>, keys: string[]) {
  let current: Record<string, unknown> = root;
  for (const key of keys) {
    const next = current[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  return current;
}

function removeKeyAtPath(root: any, keys: string[]) {
  const parent = getObjectAtPath(root, keys.slice(0, -1));
  if (!parent || typeof parent !== "object" || Array.isArray(parent)) return;
  delete parent[keys[keys.length - 1]];
}

function legacyTelegramFramesFromI18n(value: any) {
  const initial = safeString(
    value?.workingInitial || value?.thinkingInitial,
  ).trim();
  const suffix = safeString(
    value?.workingSuffix || value?.thinkingSuffix,
  ).trim();
  return normalizeStringList([
    initial,
    suffix,
    suffix ? `${suffix}.` : "",
    suffix ? `${suffix}..` : "",
  ]);
}

function migrateInstalledChatWorkingFramesI18n(
  installDir: string,
  fileOps: InstallMigrationFileOps,
) {
  const root = path.resolve(String(installDir || "").trim() || ".");
  const i18nPath = path.join(root, "i18n.json");
  const markerPath = path.join(
    root,
    "data",
    "migrations",
    "chat-working-frames-i18n-v1.json",
  );
  const marker = fileOps.readJsonObject(markerPath);
  if (marker) return null;
  const raw = fileOps.readJsonObject(i18nPath);
  const scanned = raw ? 1 : 0;
  if (!raw) return null;
  const existing = normalizeStringList(
    getObjectAtPath(raw, ["chat", "runtime", "working", "frames"]),
  );
  const legacyFrames = normalizeStringList(
    getObjectAtPath(raw, ["chatRuntime", "working", "frames"]),
  );
  const telegramFrames = legacyTelegramFramesFromI18n(
    getObjectAtPath(raw, ["chatRuntime", "telegramWorking"]),
  );
  const frames = existing.length
    ? existing
    : legacyFrames.length
      ? legacyFrames
      : telegramFrames;
  removeKeyAtPath(raw, ["chatRuntime"]);
  if (!frames.length) return null;
  const working = ensureObjectAtPath(raw, ["chat", "runtime", "working"]);
  working.frames = frames;
  fileOps.writeJsonObject(i18nPath, raw);
  fileOps.writeJsonObject(markerPath, {
    id: "chat-working-frames-i18n-v1",
    appliedAt: nowIso(),
    scanned,
    migrated: 1,
  });
  return {
    id: "chat-working-frames-i18n-v1",
    markerPath,
    alreadyApplied: false,
    skipped: false,
    scanned,
    migrated: 1,
    migratedFiles: [i18nPath],
  };
}

function listJsonFilesRecursive(root: string) {
  const output: string[] = [];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const current = path.join(root, entry.name);
      if (entry.isDirectory()) output.push(...listJsonFilesRecursive(current));
      else if (entry.isFile() && entry.name.endsWith(".json"))
        output.push(current);
    }
  } catch {}
  return output;
}

function migrateAssistantDeliveryKindsFromOutboxHistory(
  installDir: string,
  fileOps: InstallMigrationFileOps,
) {
  const root = path.resolve(String(installDir || "").trim() || ".");
  const markerPath = path.join(
    root,
    "data",
    "migrations",
    "assistant-delivery-kind-v1.json",
  );
  const marker = fileOps.readJsonObject(markerPath);
  if (marker) return null;
  const recordsDir = chatDataPath(root, "message-store", "records");
  const outboxDir = path.join(
    root,
    "data",
    "chat",
    "outbox",
    "history",
    "delivered",
  );
  const deliveryById = new Map<string, string>();
  let scanned = 0;
  for (const filePath of listJsonFilesRecursive(outboxDir)) {
    const item = fileOps.readJsonObject(filePath);
    scanned += 1;
    const deliveryKind = safeString(
      item?.deliveryKind || (item?.payload as any)?.deliveryKind,
    ).trim();
    if (!deliveryKind) continue;
    for (const id of normalizeStringList((item as any)?.deliveryResult)) {
      deliveryById.set(id, deliveryKind);
    }
  }
  const migratedFiles: string[] = [];
  for (const filePath of listJsonFilesRecursive(recordsDir)) {
    const record = fileOps.readJsonObject(filePath);
    if (!record || record.role !== "assistant") continue;
    if (safeString(record.deliveryKind).trim()) continue;
    const deliveryKind = deliveryById.get(safeString(record.messageId).trim());
    if (!deliveryKind) continue;
    record.deliveryKind = deliveryKind;
    fileOps.writeJsonObject(filePath, record);
    migratedFiles.push(filePath);
  }
  if (migratedFiles.length === 0) return null;
  fileOps.writeJsonObject(markerPath, {
    id: "assistant-delivery-kind-v1",
    appliedAt: nowIso(),
    scanned,
    migrated: migratedFiles.length,
  });
  return {
    id: "assistant-delivery-kind-v1",
    markerPath,
    alreadyApplied: false,
    skipped: migratedFiles.length === 0,
    scanned,
    migrated: migratedFiles.length,
    migratedFiles,
  };
}

function removeInstalledBrowseRuntime(
  installDir: string,
  fileOps: InstallMigrationFileOps,
) {
  const root = path.resolve(String(installDir || "").trim() || ".");
  const removedPaths: string[] = [];
  for (const targetPath of [
    path.join(root, "data", "sidecars", "browse"),
    path.join(root, "data", "browse"),
  ]) {
    if (!fileOps.pathExists(targetPath)) continue;
    fileOps.remove(targetPath);
    removedPaths.push(targetPath);
  }
  return {
    id: "remove-browse-runtime",
    skipped: removedPaths.length === 0,
    removedPaths,
  };
}

export function applyInstallUpgradeMigrations(
  options: {
    targetUser: string;
    installDir: string;
    elevated?: boolean;
  },
  deps: InstallMigrationCommandDeps,
) {
  const fileOps = createInstallMigrationFileOps(options, deps);
  return [
    migrateInstalledDataLayout(options.installDir, fileOps),
    removeInstalledBrowseRuntime(options.installDir, fileOps),
    migrateInstalledChatWorkingFramesI18n(options.installDir, fileOps),
    migrateAssistantDeliveryKindsFromOutboxHistory(options.installDir, fileOps),
    rewriteInstalledChatStateSessionFileKeys(options.installDir, fileOps),
    migrateInstalledChatSessionFilesToManaged(options.installDir, fileOps),
  ].filter(Boolean);
}
