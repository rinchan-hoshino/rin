import fs from "node:fs";
import BetterSqlite3 from "better-sqlite3";

import { resolveTranscriptSearchDbPath } from "./transcript-archive.js";
import {
  readTranscriptSearchSchemaMarker,
  repairTranscriptSearchIndex,
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

export async function migrateTranscriptSearchIndexForInstall(
  rootOverride = "",
) {
  const preflight = preflightTranscriptSearchMigration(rootOverride);
  if (preflight.skipped) return { ...preflight, action: "none" as const };

  const dbPath = resolveTranscriptSearchDbPath(rootOverride);
  writeTranscriptSearchSchemaMarker(dbPath, "installer-migrating");
  for (const candidate of [
    dbPath,
    `${dbPath}-wal`,
    `${dbPath}-shm`,
    `${dbPath}.migrate.lock`,
  ]) {
    fs.rmSync(candidate, { recursive: true, force: true });
  }
  await repairTranscriptSearchIndex(rootOverride, true);

  const migratedState = verifyMigratedTranscriptSearchDb(dbPath);
  if (
    migratedState.version !== TRANSCRIPT_SEARCH_SCHEMA_VERSION ||
    migratedState.rebuildRequired
  ) {
    throw new Error("transcript_search_install_migration_incomplete");
  }
  writeTranscriptSearchSchemaMarker(dbPath, "current");
  return {
    ...preflight,
    action: "rebuilt" as const,
    currentVersion: migratedState.version,
    skipped: false,
    markerPath: transcriptSearchSchemaMarkerPath(dbPath),
  };
}
