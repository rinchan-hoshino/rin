import fs from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";

import { resolveTranscriptSearchDbPath } from "./transcript-archive.js";
import {
  readTranscriptSearchSchemaMarker,
  rebuildTranscriptSearchIndexAtPathForInstall,
  synchronizeTranscriptSearchIndexAtPathForInstall,
  transcriptSearchSchemaMarkerPath,
  TRANSCRIPT_SEARCH_SCHEMA_VERSION,
  writeTranscriptSearchSchemaMarker,
} from "./transcript-search.js";

export type TranscriptSearchMigrationPreflight = {
  id: "transcript-search-schema-v5";
  skipped: boolean;
  action: "none" | "rebuild";
  currentVersion: number | null;
  targetVersion: number;
  reason: "missing" | "current" | "unmarked" | "incomplete";
};

type BackupPhase = "backing-up" | "guarded" | "published";
type BackupFile = { livePath: string; existed: boolean };
type BackupManifest = {
  version: 1;
  phase: BackupPhase;
  files: BackupFile[];
};

function fsyncDirectory(dirPath: string) {
  if (process.platform === "win32") return;
  const fd = fs.openSync(dirPath, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function durableWriteJson(filePath: string, value: unknown) {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  const fd = fs.openSync(tmpPath, "w", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
  fsyncDirectory(path.dirname(filePath));
}

function durableRename(fromPath: string, toPath: string) {
  fs.renameSync(fromPath, toPath);
  if (path.dirname(fromPath) !== path.dirname(toPath)) {
    fsyncDirectory(path.dirname(toPath));
  }
  fsyncDirectory(path.dirname(fromPath));
}

function durableRemove(targetPath: string) {
  if (!fs.existsSync(targetPath)) return;
  const parent = path.dirname(targetPath);
  fs.rmSync(targetPath, { recursive: true, force: true });
  fsyncDirectory(parent);
}

function transcriptSearchMigrationStagingDir(dbPath: string) {
  return `${dbPath}.migration-v${TRANSCRIPT_SEARCH_SCHEMA_VERSION}`;
}

function transcriptSearchMigrationStagingDbPath(dbPath: string) {
  return path.join(transcriptSearchMigrationStagingDir(dbPath), "search.db");
}

function transcriptSearchMigrationBackupDir(dbPath: string) {
  return `${dbPath}.migration-backup-v${TRANSCRIPT_SEARCH_SCHEMA_VERSION}`;
}

function liveTranscriptSearchFiles(dbPath: string) {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
}

function backupTranscriptSearchFilePath(backupDir: string, livePath: string) {
  return path.join(backupDir, path.basename(livePath));
}

function transcriptSearchBackupManifestPath(backupDir: string) {
  return path.join(backupDir, "manifest.json");
}

function cleanupBackupManifestTemps(backupDir: string) {
  for (const name of fs.readdirSync(backupDir)) {
    if (/^manifest\.json\.\d+\.tmp$/.test(name)) {
      durableRemove(path.join(backupDir, name));
    }
  }
}

function verifyMigratedTranscriptSearchDb(dbPath: string) {
  let db: BetterSqlite3.Database | undefined;
  try {
    db = new BetterSqlite3(dbPath, { fileMustExist: true });
    const version = db
      .prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
      .get() as { value?: string } | undefined;
    const rebuildRequired = db
      .prepare("SELECT value FROM metadata WHERE key = 'rebuild_required'")
      .get() as { value?: string } | undefined;
    return {
      version: Number(version?.value || 0),
      rebuildRequired: rebuildRequired?.value === "1",
    };
  } finally {
    db?.close();
  }
}

function isCompletedTranscriptSearchDb(dbPath: string) {
  try {
    const state = verifyMigratedTranscriptSearchDb(dbPath);
    return (
      state.version === TRANSCRIPT_SEARCH_SCHEMA_VERSION &&
      !state.rebuildRequired
    );
  } catch {
    return false;
  }
}

function assertPreparedTranscriptSearchDb(dbPath: string) {
  if (
    !isRegularFile(dbPath) ||
    pathEntry(path.dirname(dbPath))?.isDirectory() !== true
  ) {
    throw new Error("transcript_search_install_staging_path_invalid");
  }
  const state = verifyMigratedTranscriptSearchDb(dbPath);
  if (
    state.version !== TRANSCRIPT_SEARCH_SCHEMA_VERSION ||
    state.rebuildRequired
  ) {
    throw new Error("transcript_search_install_migration_incomplete");
  }
  return state;
}

function writeBackupManifest(
  backupDir: string,
  phase: BackupPhase,
  files: BackupFile[],
) {
  durableWriteJson(transcriptSearchBackupManifestPath(backupDir), {
    version: 1,
    phase,
    files,
  } satisfies BackupManifest);
}

function readBackupManifest(backupDir: string, dbPath: string): BackupManifest {
  const parsed = JSON.parse(
    fs.readFileSync(transcriptSearchBackupManifestPath(backupDir), "utf8"),
  ) as Partial<BackupManifest>;
  const expectedPaths = liveTranscriptSearchFiles(dbPath);
  if (
    parsed.version !== 1 ||
    !["backing-up", "guarded", "published"].includes(String(parsed.phase)) ||
    !Array.isArray(parsed.files) ||
    parsed.files.length !== expectedPaths.length
  ) {
    throw new Error("transcript_search_install_backup_manifest_invalid");
  }
  const files = parsed.files.map((item, index) => {
    if (
      item?.livePath !== expectedPaths[index] ||
      typeof item?.existed !== "boolean"
    ) {
      throw new Error("transcript_search_install_backup_manifest_invalid");
    }
    return { livePath: expectedPaths[index], existed: item.existed };
  });
  const expectedNames = new Set([
    "manifest.json",
    ...expectedPaths.map((livePath) => path.basename(livePath)),
  ]);
  if (fs.readdirSync(backupDir).some((name) => !expectedNames.has(name))) {
    throw new Error("transcript_search_install_backup_manifest_invalid");
  }
  return {
    version: 1,
    phase: parsed.phase as BackupPhase,
    files,
  };
}

function pathEntry(filePath: string) {
  try {
    return fs.lstatSync(filePath);
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function isRegularFile(filePath: string) {
  return pathEntry(filePath)?.isFile() === true;
}

function validateBackupForRestore(
  manifest: BackupManifest,
  dbPath: string,
  backupDir: string,
) {
  const guardExists = pathEntry(dbPath)?.isDirectory() === true;
  for (const { livePath, existed } of manifest.files) {
    const backupPath = backupTranscriptSearchFilePath(backupDir, livePath);
    const backupExists = pathEntry(backupPath) !== null;
    const liveExists = pathEntry(livePath) !== null;
    const backupIsFile = isRegularFile(backupPath);
    const liveIsFile = isRegularFile(livePath);
    if (!existed) {
      if (backupExists) {
        throw new Error("transcript_search_install_backup_manifest_invalid");
      }
      continue;
    }
    const guardedMain = livePath === dbPath && guardExists && backupIsFile;
    if (
      (backupExists && !backupIsFile) ||
      (liveExists && !liveIsFile && !guardedMain) ||
      (!guardedMain && backupIsFile === liveIsFile)
    ) {
      throw new Error("transcript_search_install_backup_manifest_invalid");
    }
  }
}

function restoreBackup(
  manifest: BackupManifest,
  dbPath: string,
  backupDir: string,
) {
  validateBackupForRestore(manifest, dbPath, backupDir);
  if (pathEntry(dbPath)?.isDirectory()) {
    durableRemove(dbPath);
  }
  for (const { livePath, existed } of manifest.files) {
    const backupPath = backupTranscriptSearchFilePath(backupDir, livePath);
    if (fs.existsSync(backupPath)) {
      durableRemove(livePath);
      durableRename(backupPath, livePath);
    } else if (!existed) {
      durableRemove(livePath);
    }
  }
  durableRemove(transcriptSearchSchemaMarkerPath(dbPath));
  durableRemove(backupDir);
}

function validatePublishedBackup(manifest: BackupManifest, backupDir: string) {
  for (const { livePath, existed } of manifest.files) {
    const backupPath = backupTranscriptSearchFilePath(backupDir, livePath);
    const backupExists = pathEntry(backupPath) !== null;
    if ((existed && !isRegularFile(backupPath)) || (!existed && backupExists)) {
      throw new Error("transcript_search_install_backup_manifest_invalid");
    }
  }
}

function restorePublishedBackup(
  manifest: BackupManifest,
  dbPath: string,
  backupDir: string,
) {
  validatePublishedBackup(manifest, backupDir);
  for (const { livePath, existed } of manifest.files) {
    const backupPath = backupTranscriptSearchFilePath(backupDir, livePath);
    durableRemove(livePath);
    if (existed) durableRename(backupPath, livePath);
  }
  durableRemove(transcriptSearchSchemaMarkerPath(dbPath));
  durableRemove(backupDir);
}

function recoverTranscriptSearchPublish(
  dbPath: string,
  backupDir: string,
): "none" | "restored" | "published" {
  const backupEntry = pathEntry(backupDir);
  if (!backupEntry) return "none";
  if (!backupEntry.isDirectory()) {
    throw new Error("transcript_search_install_backup_manifest_invalid");
  }
  if (
    readTranscriptSearchSchemaMarker(dbPath)?.state === "current" &&
    isCompletedTranscriptSearchDb(dbPath)
  ) {
    durableRemove(backupDir);
    return "published";
  }
  cleanupBackupManifestTemps(backupDir);
  const manifestPath = transcriptSearchBackupManifestPath(backupDir);
  if (!fs.existsSync(manifestPath)) {
    if (fs.readdirSync(backupDir).length > 0) {
      throw new Error("transcript_search_install_backup_manifest_invalid");
    }
    durableRemove(backupDir);
    return "none";
  }
  const manifest = readBackupManifest(backupDir, dbPath);
  if (
    (manifest.phase === "published" || manifest.phase === "guarded") &&
    isRegularFile(dbPath) &&
    isCompletedTranscriptSearchDb(dbPath)
  ) {
    validatePublishedBackup(manifest, backupDir);
    if (manifest.phase !== "published") {
      writeBackupManifest(backupDir, "published", manifest.files);
    }
    return "published";
  }
  restoreBackup(manifest, dbPath, backupDir);
  durableRemove(transcriptSearchSchemaMarkerPath(dbPath));
  return "restored";
}

export function preflightTranscriptSearchMigration(
  rootOverride = "",
): TranscriptSearchMigrationPreflight {
  const dbPath = resolveTranscriptSearchDbPath(rootOverride);
  const marker = readTranscriptSearchSchemaMarker(dbPath);
  if (!fs.existsSync(dbPath) && marker?.state !== "installer-migrating") {
    return {
      id: "transcript-search-schema-v5",
      skipped: true,
      action: "none",
      currentVersion: null,
      targetVersion: TRANSCRIPT_SEARCH_SCHEMA_VERSION,
      reason: "missing",
    };
  }
  if (marker?.state === "current") {
    return {
      id: "transcript-search-schema-v5",
      skipped: true,
      action: "none",
      currentVersion: marker.schemaVersion,
      targetVersion: TRANSCRIPT_SEARCH_SCHEMA_VERSION,
      reason: "current",
    };
  }
  return {
    id: "transcript-search-schema-v5",
    skipped: false,
    action: "rebuild",
    currentVersion: marker?.schemaVersion || null,
    targetVersion: TRANSCRIPT_SEARCH_SCHEMA_VERSION,
    reason: marker ? "incomplete" : "unmarked",
  };
}

export async function prepareTranscriptSearchMigrationForInstall(
  rootOverride = "",
) {
  const preflight = preflightTranscriptSearchMigration(rootOverride);
  if (preflight.skipped) return { ...preflight, prepared: false };

  const dbPath = resolveTranscriptSearchDbPath(rootOverride);
  const stagingDir = transcriptSearchMigrationStagingDir(dbPath);
  const stagingDbPath = transcriptSearchMigrationStagingDbPath(dbPath);
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  try {
    await rebuildTranscriptSearchIndexAtPathForInstall(
      stagingDbPath,
      rootOverride,
    );
    assertPreparedTranscriptSearchDb(stagingDbPath);
    return { ...preflight, prepared: true, stagingDbPath };
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

function enterPublishGuard(
  dbPath: string,
  backupDir: string,
  options: {
    beforeBackupMove?: (livePath: string, index: number) => void;
    afterBackupMove?: (livePath: string, index: number) => void;
  },
) {
  const files = liveTranscriptSearchFiles(dbPath).map((livePath) => ({
    livePath,
    existed: pathEntry(livePath) !== null,
  }));
  if (pathEntry(backupDir)) {
    throw new Error("transcript_search_install_backup_manifest_invalid");
  }
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  fsyncDirectory(path.dirname(backupDir));
  try {
    writeBackupManifest(backupDir, "backing-up", files);
    for (const [index, { livePath, existed }] of files.entries()) {
      if (!existed) continue;
      options.beforeBackupMove?.(livePath, index);
      durableRename(
        livePath,
        backupTranscriptSearchFilePath(backupDir, livePath),
      );
      options.afterBackupMove?.(livePath, index);
    }
    fs.mkdirSync(dbPath, { mode: 0o700 });
    fsyncDirectory(path.dirname(dbPath));
    writeBackupManifest(backupDir, "guarded", files);
  } catch (error) {
    recoverTranscriptSearchPublish(dbPath, backupDir);
    throw error;
  }
}

function publishPreparedDb(
  stagingDbPath: string,
  dbPath: string,
  backupDir: string,
) {
  assertPreparedTranscriptSearchDb(stagingDbPath);
  if (!pathEntry(dbPath)?.isDirectory()) {
    throw new Error("transcript_search_install_publish_guard_missing");
  }
  durableRemove(dbPath);
  durableRename(stagingDbPath, dbPath);
  const manifest = readBackupManifest(backupDir, dbPath);
  writeBackupManifest(backupDir, "published", manifest.files);
}

function completedMigrationResult(
  preflight: TranscriptSearchMigrationPreflight,
  dbPath: string,
) {
  const state = assertPreparedTranscriptSearchDb(dbPath);
  return {
    ...preflight,
    action: "rebuilt" as const,
    currentVersion: state.version,
    skipped: false,
    markerPath: transcriptSearchSchemaMarkerPath(dbPath),
  };
}

export async function migrateTranscriptSearchIndexForInstall(
  rootOverride = "",
  options: {
    beforeBackupMove?: (livePath: string, index: number) => void;
    afterBackupMove?: (livePath: string, index: number) => void;
    onPublishGuard?: () => void;
    afterPublish?: () => void;
  } = {},
) {
  const dbPath = resolveTranscriptSearchDbPath(rootOverride);
  const stagingDir = transcriptSearchMigrationStagingDir(dbPath);
  const stagingDbPath = transcriptSearchMigrationStagingDbPath(dbPath);
  const backupDir = transcriptSearchMigrationBackupDir(dbPath);
  const recovered = recoverTranscriptSearchPublish(dbPath, backupDir);
  const preflight = preflightTranscriptSearchMigration(rootOverride);
  if (recovered === "published") {
    durableRemove(stagingDir);
    return completedMigrationResult(preflight, dbPath);
  }
  if (preflight.skipped) {
    durableRemove(stagingDir);
    return { ...preflight, action: "none" as const };
  }

  if (!pathEntry(stagingDbPath)) {
    await prepareTranscriptSearchMigrationForInstall(rootOverride);
  }
  assertPreparedTranscriptSearchDb(stagingDbPath);
  try {
    writeTranscriptSearchSchemaMarker(dbPath, "installer-migrating");
    enterPublishGuard(dbPath, backupDir, options);
    options.onPublishGuard?.();
    await synchronizeTranscriptSearchIndexAtPathForInstall(
      stagingDbPath,
      rootOverride,
    );
    assertPreparedTranscriptSearchDb(stagingDbPath);
    publishPreparedDb(stagingDbPath, dbPath, backupDir);
    options.afterPublish?.();
    const result = completedMigrationResult(preflight, dbPath);
    durableRemove(stagingDir);
    durableRemove(`${dbPath}.migrate.lock`);
    return result;
  } catch (error) {
    const outcome = recoverTranscriptSearchPublish(dbPath, backupDir);
    if (outcome === "published") {
      durableRemove(stagingDir);
      return completedMigrationResult(preflight, dbPath);
    }
    durableRemove(transcriptSearchSchemaMarkerPath(dbPath));
    throw error;
  }
}

export function finalizeTranscriptSearchMigrationForInstall(rootOverride = "") {
  const dbPath = resolveTranscriptSearchDbPath(rootOverride);
  const backupDir = transcriptSearchMigrationBackupDir(dbPath);
  const backupEntry = pathEntry(backupDir);
  if (!backupEntry) return { skipped: true, cleanupPending: false };
  if (!backupEntry.isDirectory()) {
    throw new Error("transcript_search_install_backup_manifest_invalid");
  }
  const manifest = readBackupManifest(backupDir, dbPath);
  if (
    manifest.phase !== "published" ||
    !isCompletedTranscriptSearchDb(dbPath)
  ) {
    throw new Error("transcript_search_install_migration_incomplete");
  }
  validatePublishedBackup(manifest, backupDir);
  writeTranscriptSearchSchemaMarker(dbPath, "current");
  let cleanupPending = false;
  try {
    durableRemove(backupDir);
  } catch {
    cleanupPending = true;
  }
  return { skipped: false, cleanupPending };
}

export function rollbackTranscriptSearchMigrationForInstall(rootOverride = "") {
  const dbPath = resolveTranscriptSearchDbPath(rootOverride);
  const backupDir = transcriptSearchMigrationBackupDir(dbPath);
  const backupEntry = pathEntry(backupDir);
  if (!backupEntry) {
    const marker = readTranscriptSearchSchemaMarker(dbPath);
    if (marker?.state === "installer-migrating") {
      const dbEntry = pathEntry(dbPath);
      if (
        dbEntry?.isDirectory() ||
        (dbEntry?.isFile() && isCompletedTranscriptSearchDb(dbPath))
      ) {
        throw new Error("transcript_search_install_backup_manifest_invalid");
      }
      durableRemove(transcriptSearchSchemaMarkerPath(dbPath));
    }
    return { skipped: true };
  }
  if (!backupEntry.isDirectory()) {
    throw new Error("transcript_search_install_backup_manifest_invalid");
  }
  const manifest = readBackupManifest(backupDir, dbPath);
  if (
    manifest.phase === "published" &&
    isRegularFile(dbPath) &&
    isCompletedTranscriptSearchDb(dbPath)
  ) {
    restorePublishedBackup(manifest, dbPath, backupDir);
  } else {
    restoreBackup(manifest, dbPath, backupDir);
    durableRemove(transcriptSearchSchemaMarkerPath(dbPath));
  }
  durableRemove(transcriptSearchMigrationStagingDir(dbPath));
  return { skipped: false };
}
