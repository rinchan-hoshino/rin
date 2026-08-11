import fs from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";

import {
  resolveTranscriptRoot,
  resolveTranscriptSearchDbPath,
} from "./transcript-archive.js";
import {
  sanitizeTranscriptArchiveTreeForInstall,
  synchronizeSanitizedTranscriptArchiveTreeForInstall,
  type TranscriptArchiveMigrationManifest,
} from "./transcript-install-migration.js";
import {
  readTranscriptSearchSchemaMarker,
  rebuildTranscriptSearchIndexAtPathForInstall,
  synchronizeTranscriptSearchIndexAtPathForInstall,
  transcriptSearchSchemaMarkerPath,
  TRANSCRIPT_SEARCH_SCHEMA_VERSION,
  writeTranscriptSearchSchemaMarker,
} from "./transcript-search.js";

export type TranscriptSearchMigrationPreflight = {
  id: "transcript-search-schema-v6";
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

type TranscriptBackupManifest = {
  version: 1;
  phase: "guarded" | "published";
  existed: boolean;
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

function transcriptMigrationStagingRoot(dbPath: string) {
  return path.join(transcriptSearchMigrationStagingDir(dbPath), "transcripts");
}

function transcriptMigrationStagingManifestPath(dbPath: string) {
  return path.join(
    transcriptSearchMigrationStagingDir(dbPath),
    "transcript-manifest.json",
  );
}

function transcriptMigrationBackupRoot(rootOverride = "") {
  return `${resolveTranscriptRoot(rootOverride)}.migration-backup-v${TRANSCRIPT_SEARCH_SCHEMA_VERSION}`;
}

function transcriptMigrationQuarantineRoot(rootOverride = "") {
  return `${resolveTranscriptRoot(rootOverride)}.migration-quarantine-v${TRANSCRIPT_SEARCH_SCHEMA_VERSION}`;
}

function transcriptMigrationBackupManifestPath(backupRoot: string) {
  return path.join(backupRoot, ".migration-manifest.json");
}

function transcriptMigrationSanitizationManifestPath(backupRoot: string) {
  return path.join(backupRoot, ".sanitization-manifest.json");
}

function transcriptMigrationCompletedReportPath(rootOverride = "") {
  return path.join(
    path.dirname(resolveTranscriptRoot(rootOverride)),
    `transcript-migration-v${TRANSCRIPT_SEARCH_SCHEMA_VERSION}.json`,
  );
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

function hasTranscriptArchives(rootOverride = "") {
  const root = resolveTranscriptRoot(rootOverride);
  const visit = (dir: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error: any) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    return entries.some((entry) => {
      if (entry.isSymbolicLink()) return false;
      const candidate = path.join(dir, entry.name);
      return entry.isDirectory()
        ? visit(candidate)
        : entry.isFile() && entry.name.endsWith(".jsonl");
    });
  };
  return visit(root);
}

function readTranscriptMigrationManifest(
  manifestPath: string,
): TranscriptArchiveMigrationManifest {
  const parsed = JSON.parse(
    fs.readFileSync(manifestPath, "utf8"),
  ) as TranscriptArchiveMigrationManifest;
  if (
    parsed?.version !== 1 ||
    !Array.isArray(parsed.files) ||
    parsed.summary?.unknownCorruptLines !== 0
  ) {
    throw new Error("transcript_archive_install_manifest_invalid");
  }
  return parsed;
}

function readTranscriptStagingManifest(
  dbPath: string,
): TranscriptArchiveMigrationManifest {
  return readTranscriptMigrationManifest(
    transcriptMigrationStagingManifestPath(dbPath),
  );
}

function writeTranscriptStagingManifest(
  dbPath: string,
  manifest: TranscriptArchiveMigrationManifest,
) {
  durableWriteJson(transcriptMigrationStagingManifestPath(dbPath), manifest);
}

function assertPreparedTranscriptArchive(dbPath: string) {
  const stagingRoot = transcriptMigrationStagingRoot(dbPath);
  if (pathEntry(stagingRoot)?.isDirectory() !== true) {
    throw new Error("transcript_archive_install_staging_path_invalid");
  }
  const manifest = readTranscriptStagingManifest(dbPath);
  for (const file of manifest.files) {
    const filePath = path.resolve(stagingRoot, file.relativePath);
    if (
      !filePath.startsWith(`${path.resolve(stagingRoot)}${path.sep}`) ||
      !isRegularFile(filePath) ||
      fs.statSync(filePath).size !== file.writtenSize
    ) {
      throw new Error("transcript_archive_install_staging_path_invalid");
    }
  }
  return manifest;
}

async function prepareTranscriptArchiveStaging(
  dbPath: string,
  rootOverride: string,
  reuse: boolean,
) {
  const sourceRoot = resolveTranscriptRoot(rootOverride);
  const stagingRoot = transcriptMigrationStagingRoot(dbPath);
  let manifest: TranscriptArchiveMigrationManifest;
  if (reuse) {
    manifest = await synchronizeSanitizedTranscriptArchiveTreeForInstall(
      sourceRoot,
      stagingRoot,
      readTranscriptStagingManifest(dbPath),
      { quarantineRoot: transcriptMigrationQuarantineRoot(rootOverride) },
    );
  } else {
    durableRemove(stagingRoot);
    manifest = await sanitizeTranscriptArchiveTreeForInstall(
      sourceRoot,
      stagingRoot,
      { quarantineRoot: transcriptMigrationQuarantineRoot(rootOverride) },
    );
  }
  writeTranscriptStagingManifest(dbPath, manifest);
  assertPreparedTranscriptArchive(dbPath);
  return { stagingTranscriptRoot: stagingRoot, transcriptManifest: manifest };
}

function readTranscriptBackupManifest(
  backupRoot: string,
): TranscriptBackupManifest {
  const parsed = JSON.parse(
    fs.readFileSync(transcriptMigrationBackupManifestPath(backupRoot), "utf8"),
  ) as Partial<TranscriptBackupManifest>;
  if (
    parsed.version !== 1 ||
    !["guarded", "published"].includes(String(parsed.phase)) ||
    typeof parsed.existed !== "boolean"
  ) {
    throw new Error("transcript_archive_install_backup_manifest_invalid");
  }
  return parsed as TranscriptBackupManifest;
}

function writeTranscriptBackupManifest(
  backupRoot: string,
  manifest: TranscriptBackupManifest,
) {
  durableWriteJson(transcriptMigrationBackupManifestPath(backupRoot), manifest);
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
  if (
    !fs.existsSync(dbPath) &&
    marker?.state !== "installer-migrating" &&
    !hasTranscriptArchives(rootOverride)
  ) {
    return {
      id: "transcript-search-schema-v6",
      skipped: true,
      action: "none",
      currentVersion: null,
      targetVersion: TRANSCRIPT_SEARCH_SCHEMA_VERSION,
      reason: "missing",
    };
  }
  if (marker?.state === "current") {
    return {
      id: "transcript-search-schema-v6",
      skipped: true,
      action: "none",
      currentVersion: marker.schemaVersion,
      targetVersion: TRANSCRIPT_SEARCH_SCHEMA_VERSION,
      reason: "current",
    };
  }
  return {
    id: "transcript-search-schema-v6",
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
  const stagingEntry = pathEntry(stagingDbPath);
  let reusable = false;
  if (stagingEntry) {
    if (
      !stagingEntry.isFile() ||
      pathEntry(stagingDir)?.isDirectory() !== true
    ) {
      throw new Error("transcript_search_install_staging_path_invalid");
    }
    try {
      reusable =
        verifyMigratedTranscriptSearchDb(stagingDbPath).version ===
          TRANSCRIPT_SEARCH_SCHEMA_VERSION &&
        pathEntry(transcriptMigrationStagingRoot(dbPath))?.isDirectory() ===
          true &&
        isRegularFile(transcriptMigrationStagingManifestPath(dbPath));
    } catch {
      reusable = false;
    }
  }
  if (!reusable) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  }
  try {
    const archive = await prepareTranscriptArchiveStaging(
      dbPath,
      rootOverride,
      reusable,
    );
    const indexOptions = {
      sourceTranscriptRoot: archive.stagingTranscriptRoot,
      logicalTranscriptRoot: resolveTranscriptRoot(rootOverride),
    };
    if (reusable) {
      await synchronizeTranscriptSearchIndexAtPathForInstall(
        stagingDbPath,
        rootOverride,
        indexOptions,
      );
    } else {
      await rebuildTranscriptSearchIndexAtPathForInstall(
        stagingDbPath,
        rootOverride,
        indexOptions,
      );
    }
    assertPreparedTranscriptSearchDb(stagingDbPath);
    return {
      ...preflight,
      prepared: true,
      reused: reusable,
      stagingDbPath,
      ...archive,
    };
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

function enterTranscriptPublishGuard(rootOverride: string, backupRoot: string) {
  const liveRoot = resolveTranscriptRoot(rootOverride);
  if (pathEntry(backupRoot)) {
    throw new Error("transcript_archive_install_backup_manifest_invalid");
  }
  const liveEntry = pathEntry(liveRoot);
  if (liveEntry && !liveEntry.isDirectory()) {
    throw new Error("transcript_archive_install_live_path_invalid");
  }
  const existed = Boolean(liveEntry);
  if (existed) {
    durableRename(liveRoot, backupRoot);
  } else {
    fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    fsyncDirectory(path.dirname(backupRoot));
  }
  try {
    writeTranscriptBackupManifest(backupRoot, {
      version: 1,
      phase: "guarded",
      existed,
    });
    fs.writeFileSync(liveRoot, "transcript migration guard\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    fsyncDirectory(path.dirname(liveRoot));
  } catch (error) {
    durableRemove(liveRoot);
    durableRemove(transcriptMigrationBackupManifestPath(backupRoot));
    if (existed) durableRename(backupRoot, liveRoot);
    else durableRemove(backupRoot);
    throw error;
  }
}

function publishPreparedTranscripts(
  dbPath: string,
  rootOverride: string,
  backupRoot: string,
) {
  const liveRoot = resolveTranscriptRoot(rootOverride);
  const stagingRoot = transcriptMigrationStagingRoot(dbPath);
  assertPreparedTranscriptArchive(dbPath);
  if (!isRegularFile(liveRoot)) {
    throw new Error("transcript_archive_install_publish_guard_missing");
  }
  const manifest = readTranscriptBackupManifest(backupRoot);
  durableRemove(liveRoot);
  durableRename(stagingRoot, liveRoot);
  writeTranscriptBackupManifest(backupRoot, {
    ...manifest,
    phase: "published",
  });
}

function restoreTranscriptBackup(
  rootOverride: string,
  backupRoot: string,
  manifest: TranscriptBackupManifest,
) {
  const liveRoot = resolveTranscriptRoot(rootOverride);
  durableRemove(liveRoot);
  durableRemove(transcriptMigrationBackupManifestPath(backupRoot));
  durableRemove(transcriptMigrationSanitizationManifestPath(backupRoot));
  if (manifest.existed) durableRename(backupRoot, liveRoot);
  else durableRemove(backupRoot);
}

function recoverTranscriptPublish(
  rootOverride: string,
  backupRoot: string,
  dbPath: string,
): "none" | "restored" | "published" {
  const backupEntry = pathEntry(backupRoot);
  if (!backupEntry) return "none";
  if (!backupEntry.isDirectory()) {
    throw new Error("transcript_archive_install_backup_manifest_invalid");
  }
  const manifestPath = transcriptMigrationBackupManifestPath(backupRoot);
  if (!isRegularFile(manifestPath)) {
    const liveEntry = pathEntry(resolveTranscriptRoot(rootOverride));
    if (liveEntry && !liveEntry.isFile()) {
      throw new Error("transcript_archive_install_backup_manifest_invalid");
    }
    durableRemove(resolveTranscriptRoot(rootOverride));
    durableRename(backupRoot, resolveTranscriptRoot(rootOverride));
    return "restored";
  }
  const manifest = readTranscriptBackupManifest(backupRoot);
  const liveEntry = pathEntry(resolveTranscriptRoot(rootOverride));
  if (liveEntry?.isDirectory() && isCompletedTranscriptSearchDb(dbPath)) {
    if (manifest.phase !== "published") {
      writeTranscriptBackupManifest(backupRoot, {
        ...manifest,
        phase: "published",
      });
    }
    return "published";
  }
  restoreTranscriptBackup(rootOverride, backupRoot, manifest);
  return "restored";
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
    runtimeQuiesced?: boolean;
    beforeBackupMove?: (livePath: string, index: number) => void;
    afterBackupMove?: (livePath: string, index: number) => void;
    onPublishGuard?: () => void;
    afterTranscriptPublish?: () => void;
    afterPublish?: () => void;
  } = {},
) {
  const dbPath = resolveTranscriptSearchDbPath(rootOverride);
  const stagingDir = transcriptSearchMigrationStagingDir(dbPath);
  const stagingDbPath = transcriptSearchMigrationStagingDbPath(dbPath);
  const backupDir = transcriptSearchMigrationBackupDir(dbPath);
  const transcriptBackupRoot = transcriptMigrationBackupRoot(rootOverride);
  if (
    (pathEntry(backupDir) || pathEntry(transcriptBackupRoot)) &&
    options.runtimeQuiesced !== true
  ) {
    throw new Error("memory_install_migration_runtime_not_quiesced");
  }
  const recoveredDb = recoverTranscriptSearchPublish(dbPath, backupDir);
  const recoveredTranscripts = recoverTranscriptPublish(
    rootOverride,
    transcriptBackupRoot,
    dbPath,
  );
  const preflight = preflightTranscriptSearchMigration(rootOverride);
  if (recoveredDb === "published" || recoveredTranscripts === "published") {
    const bothPublished =
      recoveredDb === "published" && recoveredTranscripts === "published";
    const completedOlderCleanup =
      preflight.skipped &&
      preflight.reason === "current" &&
      [recoveredDb, recoveredTranscripts].includes("published") &&
      [recoveredDb, recoveredTranscripts].includes("none");
    if (!bothPublished && !completedOlderCleanup) {
      throw new Error("memory_install_migration_publish_state_inconsistent");
    }
    durableRemove(stagingDir);
    return completedMigrationResult(preflight, dbPath);
  }
  if (preflight.skipped) {
    durableRemove(stagingDir);
    return { ...preflight, action: "none" as const };
  }

  let prepared: {
    stagingTranscriptRoot: string;
    transcriptManifest: TranscriptArchiveMigrationManifest;
  };
  if (pathEntry(stagingDbPath)) {
    prepared = {
      stagingTranscriptRoot: transcriptMigrationStagingRoot(dbPath),
      transcriptManifest: assertPreparedTranscriptArchive(dbPath),
    };
  } else {
    const preparedMigration =
      await prepareTranscriptSearchMigrationForInstall(rootOverride);
    if (
      !preparedMigration.prepared ||
      !("stagingTranscriptRoot" in preparedMigration) ||
      !("transcriptManifest" in preparedMigration)
    ) {
      throw new Error("memory_install_migration_prepare_incomplete");
    }
    prepared = {
      stagingTranscriptRoot: preparedMigration.stagingTranscriptRoot,
      transcriptManifest: preparedMigration.transcriptManifest,
    };
  }
  assertPreparedTranscriptSearchDb(stagingDbPath);
  if (options.runtimeQuiesced !== true) {
    throw new Error("memory_install_migration_runtime_not_quiesced");
  }
  try {
    writeTranscriptSearchSchemaMarker(dbPath, "installer-migrating");
    enterPublishGuard(dbPath, backupDir, options);
    enterTranscriptPublishGuard(rootOverride, transcriptBackupRoot);
    options.onPublishGuard?.();
    const synchronizedManifest =
      await synchronizeSanitizedTranscriptArchiveTreeForInstall(
        transcriptBackupRoot,
        prepared.stagingTranscriptRoot,
        prepared.transcriptManifest,
        { quarantineRoot: transcriptMigrationQuarantineRoot(rootOverride) },
      );
    writeTranscriptStagingManifest(dbPath, synchronizedManifest);
    durableWriteJson(
      transcriptMigrationSanitizationManifestPath(transcriptBackupRoot),
      synchronizedManifest,
    );
    prepared = {
      stagingTranscriptRoot: prepared.stagingTranscriptRoot,
      transcriptManifest: synchronizedManifest,
    };
    await synchronizeTranscriptSearchIndexAtPathForInstall(
      stagingDbPath,
      rootOverride,
      {
        sourceTranscriptRoot: prepared.stagingTranscriptRoot,
        logicalTranscriptRoot: resolveTranscriptRoot(rootOverride),
      },
    );
    assertPreparedTranscriptArchive(dbPath);
    assertPreparedTranscriptSearchDb(stagingDbPath);
    publishPreparedTranscripts(dbPath, rootOverride, transcriptBackupRoot);
    options.afterTranscriptPublish?.();
    publishPreparedDb(stagingDbPath, dbPath, backupDir);
    options.afterPublish?.();
    const result = completedMigrationResult(preflight, dbPath);
    durableRemove(stagingDir);
    durableRemove(`${dbPath}.migrate.lock`);
    return result;
  } catch (error) {
    const dbOutcome = recoverTranscriptSearchPublish(dbPath, backupDir);
    const transcriptOutcome = recoverTranscriptPublish(
      rootOverride,
      transcriptBackupRoot,
      dbPath,
    );
    if (dbOutcome === "published" && transcriptOutcome === "published") {
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
  const transcriptBackupRoot = transcriptMigrationBackupRoot(rootOverride);
  const backupEntry = pathEntry(backupDir);
  const transcriptBackupEntry = pathEntry(transcriptBackupRoot);
  if (!backupEntry && !transcriptBackupEntry) {
    return { skipped: true, cleanupPending: false };
  }
  if (backupEntry && !backupEntry.isDirectory()) {
    throw new Error("transcript_search_install_backup_manifest_invalid");
  }
  if (transcriptBackupEntry && !transcriptBackupEntry.isDirectory()) {
    throw new Error("transcript_archive_install_backup_manifest_invalid");
  }
  if (!isCompletedTranscriptSearchDb(dbPath)) {
    throw new Error("transcript_search_install_migration_incomplete");
  }
  if (backupEntry) {
    const manifest = readBackupManifest(backupDir, dbPath);
    if (manifest.phase !== "published") {
      throw new Error("transcript_search_install_migration_incomplete");
    }
    validatePublishedBackup(manifest, backupDir);
  }
  if (transcriptBackupEntry) {
    const transcriptManifest =
      readTranscriptBackupManifest(transcriptBackupRoot);
    if (
      transcriptManifest.phase !== "published" ||
      pathEntry(resolveTranscriptRoot(rootOverride))?.isDirectory() !== true ||
      !isRegularFile(
        transcriptMigrationSanitizationManifestPath(transcriptBackupRoot),
      )
    ) {
      throw new Error("transcript_archive_install_migration_incomplete");
    }
  }
  if (transcriptBackupEntry) {
    durableWriteJson(
      transcriptMigrationCompletedReportPath(rootOverride),
      readTranscriptMigrationManifest(
        transcriptMigrationSanitizationManifestPath(transcriptBackupRoot),
      ),
    );
  }
  writeTranscriptSearchSchemaMarker(dbPath, "current");
  let cleanupPending = false;
  for (const candidate of [backupDir, transcriptBackupRoot]) {
    try {
      durableRemove(candidate);
    } catch {
      cleanupPending = true;
    }
  }
  return { skipped: false, cleanupPending };
}

export function rollbackTranscriptSearchMigrationForInstall(rootOverride = "") {
  const dbPath = resolveTranscriptSearchDbPath(rootOverride);
  const backupDir = transcriptSearchMigrationBackupDir(dbPath);
  const transcriptBackupRoot = transcriptMigrationBackupRoot(rootOverride);
  const backupEntry = pathEntry(backupDir);
  const transcriptBackupEntry = pathEntry(transcriptBackupRoot);
  if (!backupEntry && !transcriptBackupEntry) {
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
  if (backupEntry && !backupEntry.isDirectory()) {
    throw new Error("transcript_search_install_backup_manifest_invalid");
  }
  if (transcriptBackupEntry && !transcriptBackupEntry.isDirectory()) {
    throw new Error("transcript_archive_install_backup_manifest_invalid");
  }
  durableRemove(transcriptMigrationCompletedReportPath(rootOverride));
  if (backupEntry) {
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
  }
  if (transcriptBackupEntry) {
    const transcriptManifest =
      readTranscriptBackupManifest(transcriptBackupRoot);
    restoreTranscriptBackup(
      rootOverride,
      transcriptBackupRoot,
      transcriptManifest,
    );
  }
  durableRemove(transcriptSearchMigrationStagingDir(dbPath));
  return { skipped: false };
}
