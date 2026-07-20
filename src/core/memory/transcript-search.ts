import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import BetterSqlite3 from "better-sqlite3";

import { sleep } from "../platform/process.js";
import {
  normalizeNeedle,
  parseTimestampMs,
  safeString,
  sha,
  trimText,
  uniqueStrings,
} from "./utils.js";
import type {
  IndexedSessionBucket,
  IndexedTranscriptEntry,
  TranscriptArchiveEntry,
  TranscriptFileState,
  TranscriptSessionResult,
} from "./transcript-types.js";
import {
  MAX_MATCHED_ENTRIES_PER_SESSION,
  appendTranscriptArchiveRecord,
  buildResultMessage,
  collectTranscriptFiles,
  isLegacySyntheticSessionSummaryEntry,
  loadTranscriptArchiveFile,
  presentSessionResult,
  resolveTranscriptRoot,
  resolveTranscriptSearchDbPath,
  sessionGroupingKey,
  transcriptPreviewText,
} from "./transcript-archive.js";

type Database = BetterSqlite3.Database;
type Statement = BetterSqlite3.Statement;

type IndexedEntryInsertValues = [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  number,
  number,
  string,
  string,
  string,
  string,
  string,
];

type TranscriptSearchWriteStatements = {
  deleteEntriesByArchivePath: Statement;
  deleteFileStateByArchivePath: Statement;
  insertEntry: Statement;
  upsertFileState: Statement;
  selectMaxLineNumberByArchivePath: Statement;
};

const transcriptSearchWriteStatementCache = new WeakMap<
  Database,
  TranscriptSearchWriteStatements
>();

type TranscriptIndexWriter = {
  rootOverride: string;
  db: Database;
  pendingCount: number;
  timer?: NodeJS.Timeout;
};

const transcriptIndexWriters = new Map<string, TranscriptIndexWriter>();
const transcriptSearchNeedsSync = new Set<string>();
const ownedTranscriptWriterMarkers = new Map<
  string,
  { markerPath: string; rootOverride: string }
>();
const transcriptWriterMarkerId = `${process.pid}-${Date.now()}-${Math.random()
  .toString(16)
  .slice(2)}`;
let transcriptWriterExitHookInstalled = false;
export const TRANSCRIPT_SEARCH_SCHEMA_VERSION = 5;
export type TranscriptSearchSchemaMarkerState =
  | "current"
  | "runtime-initializing"
  | "installer-migrating";
export type TranscriptSearchSchemaMarker = {
  schemaVersion: number;
  state: TranscriptSearchSchemaMarkerState;
};
const TRANSCRIPT_INDEX_BATCH_SIZE = 32;
const TRANSCRIPT_INDEX_BATCH_DELAY_MS = 10;
const DEFAULT_RESULT_LIMIT = 8;
const RAW_SEARCH_LIMIT = 50;

export function transcriptSearchSchemaMarkerPath(dbPath: string) {
  return `${dbPath}.schema.json`;
}

export function readTranscriptSearchSchemaMarker(
  dbPath: string,
): TranscriptSearchSchemaMarker | null {
  try {
    const parsed = JSON.parse(
      fssync.readFileSync(transcriptSearchSchemaMarkerPath(dbPath), "utf8"),
    ) as Partial<TranscriptSearchSchemaMarker>;
    if (
      parsed.schemaVersion !== TRANSCRIPT_SEARCH_SCHEMA_VERSION ||
      !["current", "runtime-initializing", "installer-migrating"].includes(
        String(parsed.state),
      )
    ) {
      return null;
    }
    return parsed as TranscriptSearchSchemaMarker;
  } catch {
    return null;
  }
}

export function writeTranscriptSearchSchemaMarker(
  dbPath: string,
  state: TranscriptSearchSchemaMarkerState,
) {
  const markerPath = transcriptSearchSchemaMarkerPath(dbPath);
  const tmpPath = `${markerPath}.${process.pid}.${Math.random()
    .toString(16)
    .slice(2)}.tmp`;
  fssync.mkdirSync(path.dirname(markerPath), { recursive: true });
  try {
    fssync.writeFileSync(
      tmpPath,
      `${JSON.stringify({
        schemaVersion: TRANSCRIPT_SEARCH_SCHEMA_VERSION,
        state,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    fssync.renameSync(tmpPath, markerPath);
  } finally {
    try {
      fssync.unlinkSync(tmpPath);
    } catch {}
  }
}

function buildStructuredTokens(value: string): string[] {
  const raw = safeString(value).toLowerCase().trim();
  if (!raw) return [];
  const primary = raw
    .split(/[^a-z0-9_./:#@-]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
  const expanded: string[] = [];
  for (const token of primary) {
    expanded.push(token);
    if (/[./:#@_-]/.test(token)) {
      expanded.push(
        ...token
          .split(/[./:#@_-]+/g)
          .map((item) => item.trim())
          .filter(Boolean),
      );
    }
  }
  return uniqueStrings(
    expanded.filter((token) => token.length >= 2 || /\d/.test(token)),
  );
}

function createCjkTrigrams(value: string): string[] {
  const chars = [...safeString(value).replace(/\s+/g, "")].filter((char) =>
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char),
  );
  const out: string[] = [];
  for (let index = 0; index < chars.length - 2; index += 1) {
    out.push(`${chars[index]}${chars[index + 1]}${chars[index + 2]}`);
  }
  return uniqueStrings(out);
}

function escapeFtsPhrase(value: string): string {
  return safeString(value).replace(/"/g, '""');
}

function buildTokenFtsQuery(value: string): string {
  const raw = safeString(value).trim();
  if (!raw) return "";
  const normalized = raw.toLowerCase();
  const compact = normalized.replace(/\s+/g, " ").trim();
  const structured = buildStructuredTokens(normalized);
  const terms = uniqueStrings([
    ...structured,
    ...(compact.length >= 2 ? [compact] : []),
    ...(compact.length >= 2 && !compact.includes(" ")
      ? [compact.replace(/['`]/g, "")]
      : []),
  ]);
  return terms.length
    ? terms.map((term) => `"${escapeFtsPhrase(term)}"`).join(" OR ")
    : "";
}

function buildTrigramFtsQuery(value: string): string {
  const raw = safeString(value).trim();
  if (!raw) return "";
  const compact = raw.replace(/\s+/g, " ").trim();
  const terms = uniqueStrings([
    ...createCjkTrigrams(compact),
    ...buildStructuredTokens(compact).filter((token) => token.length >= 3),
    ...(compact.replace(/\s+/g, "").length >= 3 ? [compact] : []),
  ]);
  return terms.length
    ? terms.map((term) => `"${escapeFtsPhrase(term)}"`).join(" OR ")
    : "";
}

function initializeTranscriptSearchDb(db: Database, busyTimeoutMs = 5000) {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma(`busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))}`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS file_state (
      archive_path TEXT PRIMARY KEY,
      mtime_ms INTEGER NOT NULL,
      size INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entries (
      row_key TEXT PRIMARY KEY,
      archive_path TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      session_file TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      line_number INTEGER NOT NULL,
      role TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      custom_type TEXT NOT NULL,
      text TEXT NOT NULL,
      preview TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_entries_archive_path ON entries(archive_path);
    CREATE INDEX IF NOT EXISTS idx_entries_session_key_ts ON entries(session_key, timestamp_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_entries_session_id_ts ON entries(session_id, timestamp_ms DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts_token USING fts5(
      row_key UNINDEXED,
      session_id,
      role,
      tool_name,
      custom_type,
      text,
      content = 'entries',
      content_rowid = 'rowid',
      tokenize = "unicode61 remove_diacritics 2 tokenchars '-_./:#@'"
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts_trigram USING fts5(
      row_key UNINDEXED,
      session_id,
      role,
      tool_name,
      custom_type,
      text,
      content = 'entries',
      content_rowid = 'rowid',
      tokenize = 'trigram'
    );

    CREATE TRIGGER IF NOT EXISTS entries_search_insert AFTER INSERT ON entries BEGIN
      INSERT INTO entries_fts_token(rowid, row_key, session_id, role, tool_name, custom_type, text)
      VALUES (new.rowid, new.row_key, new.session_id, new.role, new.tool_name, new.custom_type, new.text);
      INSERT INTO entries_fts_trigram(rowid, row_key, session_id, role, tool_name, custom_type, text)
      VALUES (new.rowid, new.row_key, new.session_id, new.role, new.tool_name, new.custom_type, new.text);
    END;

    CREATE TRIGGER IF NOT EXISTS entries_search_delete AFTER DELETE ON entries BEGIN
      INSERT INTO entries_fts_token(entries_fts_token, rowid, row_key, session_id, role, tool_name, custom_type, text)
      VALUES ('delete', old.rowid, old.row_key, old.session_id, old.role, old.tool_name, old.custom_type, old.text);
      INSERT INTO entries_fts_trigram(entries_fts_trigram, rowid, row_key, session_id, role, tool_name, custom_type, text)
      VALUES ('delete', old.rowid, old.row_key, old.session_id, old.role, old.tool_name, old.custom_type, old.text);
    END;

    CREATE TRIGGER IF NOT EXISTS entries_search_update AFTER UPDATE ON entries BEGIN
      INSERT INTO entries_fts_token(entries_fts_token, rowid, row_key, session_id, role, tool_name, custom_type, text)
      VALUES ('delete', old.rowid, old.row_key, old.session_id, old.role, old.tool_name, old.custom_type, old.text);
      INSERT INTO entries_fts_trigram(entries_fts_trigram, rowid, row_key, session_id, role, tool_name, custom_type, text)
      VALUES ('delete', old.rowid, old.row_key, old.session_id, old.role, old.tool_name, old.custom_type, old.text);
      INSERT INTO entries_fts_token(rowid, row_key, session_id, role, tool_name, custom_type, text)
      VALUES (new.rowid, new.row_key, new.session_id, new.role, new.tool_name, new.custom_type, new.text);
      INSERT INTO entries_fts_trigram(rowid, row_key, session_id, role, tool_name, custom_type, text)
      VALUES (new.rowid, new.row_key, new.session_id, new.role, new.tool_name, new.custom_type, new.text);
    END;
  `);
  const insertMetadata = db.prepare(
    "INSERT OR IGNORE INTO metadata(key, value) VALUES (?, ?)",
  );
  insertMetadata.run(
    "schema_version",
    String(TRANSCRIPT_SEARCH_SCHEMA_VERSION),
  );
  insertMetadata.run("rebuild_required", "0");
}

function isRebuildableTranscriptSearchDbError(error: unknown): boolean {
  const code = String((error as any)?.code || "").trim();
  const message = String((error as any)?.message || error || "").toLowerCase();
  return code === "SQLITE_NOTADB" || message.includes("file is not a database");
}

function isSqliteBusyError(error: unknown): boolean {
  const code = String((error as any)?.code || "").trim();
  const message = String((error as any)?.message || error || "").toLowerCase();
  return code === "SQLITE_BUSY" || message.includes("database is locked");
}

function transcriptSearchSchemaVersion(db: Database) {
  const metadataExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'metadata'",
    )
    .get() as { name?: string } | undefined;
  if (!metadataExists) return null;
  const versionRow = db
    .prepare("SELECT value FROM metadata WHERE key = ?")
    .get("schema_version") as { value?: string } | undefined;
  return Number(versionRow?.value || 0);
}

function openTranscriptSearchDb(
  rootOverride = "",
  allowReset = true,
  busyTimeoutMs = 5000,
  allowInstallerMigration = false,
): Database {
  const dbPath = resolveTranscriptSearchDbPath(rootOverride);
  const parent = path.dirname(dbPath);
  if (!fssync.existsSync(parent)) fssync.mkdirSync(parent, { recursive: true });
  const dbExistedBeforeOpen = fssync.existsSync(dbPath);
  let schemaMarker = readTranscriptSearchSchemaMarker(dbPath);

  if (
    dbExistedBeforeOpen &&
    (!schemaMarker ||
      (schemaMarker.state === "installer-migrating" &&
        !allowInstallerMigration))
  ) {
    throw new Error("transcript_search_install_migration_required");
  }
  if (
    !dbExistedBeforeOpen &&
    schemaMarker?.state === "installer-migrating" &&
    !allowInstallerMigration
  ) {
    throw new Error("transcript_search_install_migration_required");
  }
  if (!dbExistedBeforeOpen) {
    const initializingState = allowInstallerMigration
      ? "installer-migrating"
      : "runtime-initializing";
    writeTranscriptSearchSchemaMarker(dbPath, initializingState);
    schemaMarker = {
      schemaVersion: TRANSCRIPT_SEARCH_SCHEMA_VERSION,
      state: initializingState,
    };
  }

  let db: Database | undefined;
  try {
    db = new BetterSqlite3(dbPath);
    const version = transcriptSearchSchemaVersion(db);
    if (version !== null && version !== TRANSCRIPT_SEARCH_SCHEMA_VERSION) {
      const mismatch = new Error("transcript_search_schema_marker_mismatch");
      (mismatch as any).code = "SQLITE_NOTADB";
      throw mismatch;
    }
    if (version === null && schemaMarker?.state === "current") {
      const incomplete = new Error("transcript_search_schema_marker_mismatch");
      (incomplete as any).code = "SQLITE_NOTADB";
      throw incomplete;
    }

    initializeTranscriptSearchDb(db, busyTimeoutMs);
    if (!dbExistedBeforeOpen) {
      db.prepare(
        "UPDATE metadata SET value = '1' WHERE key = 'rebuild_required'",
      ).run();
    }
    if (schemaMarker?.state === "runtime-initializing") {
      writeTranscriptSearchSchemaMarker(dbPath, "current");
    }
    return db;
  } catch (error) {
    try {
      db?.close();
    } catch {}
    if (allowReset && isRebuildableTranscriptSearchDbError(error)) {
      for (const candidate of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
          fssync.rmSync(candidate, { force: true });
        } catch {}
      }
      writeTranscriptSearchSchemaMarker(
        dbPath,
        allowInstallerMigration
          ? "installer-migrating"
          : "runtime-initializing",
      );
      transcriptSearchNeedsSync.add(dbPath);
      const resetDb = openTranscriptSearchDb(
        rootOverride,
        false,
        busyTimeoutMs,
        allowInstallerMigration,
      );
      resetDb
        .prepare(
          "UPDATE metadata SET value = '1' WHERE key = 'rebuild_required'",
        )
        .run();
      return resetDb;
    }
    throw error;
  }
}

function timestampValue(value: string): number {
  return parseTimestampMs(value);
}

function toIndexedEntry(
  entry: TranscriptArchiveEntry,
  archivePath: string,
  rowIndex: number,
): IndexedTranscriptEntry {
  const lineNumber = Math.max(
    1,
    Number(entry.archiveLine || rowIndex + 1) || rowIndex + 1,
  );
  const rowKey = sha(
    [
      archivePath,
      String(lineNumber),
      safeString(entry.id || "").trim(),
      safeString(entry.timestamp || "").trim(),
      safeString(entry.role || "").trim(),
      safeString(entry.toolCallId || "").trim(),
      safeString(entry.toolName || "").trim(),
    ].join("\n"),
  );
  return {
    rowKey,
    archivePath,
    sessionKey: sessionGroupingKey(entry),
    entry,
    timestampMs: timestampValue(entry.timestamp),
    preview: trimText(transcriptPreviewText(entry), 240),
    lineNumber,
  };
}

function getTranscriptSearchWriteStatements(
  db: Database,
): TranscriptSearchWriteStatements {
  const cached = transcriptSearchWriteStatementCache.get(db);
  if (cached) return cached;

  const statements = {
    deleteEntriesByArchivePath: db.prepare(
      "DELETE FROM entries WHERE archive_path = ?",
    ),
    deleteFileStateByArchivePath: db.prepare(
      "DELETE FROM file_state WHERE archive_path = ?",
    ),
    insertEntry: db.prepare(
      `
      INSERT INTO entries(
        row_key, archive_path, entry_id, session_key, session_id, session_file,
        timestamp, timestamp_ms, line_number, role, tool_name, custom_type, text, preview
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ),
    upsertFileState: db.prepare(
      "INSERT OR REPLACE INTO file_state(archive_path, mtime_ms, size) VALUES (?, ?, ?)",
    ),
    selectMaxLineNumberByArchivePath: db.prepare(
      "SELECT MAX(line_number) AS max_line_number FROM entries WHERE archive_path = ?",
    ),
  } satisfies TranscriptSearchWriteStatements;

  transcriptSearchWriteStatementCache.set(db, statements);
  return statements;
}

function buildIndexedEntryValues(
  item: IndexedTranscriptEntry,
): IndexedEntryInsertValues {
  const sessionId = safeString(item.entry.sessionId || "").trim();
  const sessionFile = safeString(item.entry.sessionFile || "").trim();
  const timestamp = safeString(item.entry.timestamp || "").trim();
  const role = safeString(item.entry.role || "").trim();
  const toolName = safeString(item.entry.toolName || "").trim();
  const customType = safeString(item.entry.customType || "").trim();
  const text = safeString(item.entry.text || "").trim();
  return [
    item.rowKey,
    item.archivePath,
    item.entry.id,
    item.sessionKey,
    sessionId,
    sessionFile,
    timestamp,
    item.timestampMs,
    item.lineNumber,
    role,
    toolName,
    customType,
    text,
    item.preview,
  ];
}

function removeIndexedArchiveEntries(db: Database, archivePath: string) {
  const statements = getTranscriptSearchWriteStatements(db);
  statements.deleteEntriesByArchivePath.run(archivePath);
  statements.deleteFileStateByArchivePath.run(archivePath);
}

function insertIndexedEntry(db: Database, item: IndexedTranscriptEntry) {
  const statements = getTranscriptSearchWriteStatements(db);
  statements.insertEntry.run(...buildIndexedEntryValues(item));
}

function replaceIndexedArchiveEntries(
  db: Database,
  state: TranscriptFileState,
  entries: TranscriptArchiveEntry[],
) {
  const indexedEntries = entries.map((entry, index) =>
    toIndexedEntry(entry, state.archivePath, index),
  );
  const statements = getTranscriptSearchWriteStatements(db);
  const tx = db.transaction(() => {
    removeIndexedArchiveEntries(db, state.archivePath);
    for (const item of indexedEntries) insertIndexedEntry(db, item);
    statements.upsertFileState.run(
      state.archivePath,
      state.mtimeMs,
      state.size,
    );
  });
  tx();
}

function appendIndexedArchiveEntry(
  db: Database,
  state: TranscriptFileState,
  entry: TranscriptArchiveEntry,
) {
  const statements = getTranscriptSearchWriteStatements(db);
  const row = statements.selectMaxLineNumberByArchivePath.get(
    state.archivePath,
  ) as { max_line_number?: number } | undefined;
  const nextIndex = Math.max(0, Number(row?.max_line_number || 0));
  const item = toIndexedEntry(entry, state.archivePath, nextIndex);
  insertIndexedEntry(db, item);
  statements.upsertFileState.run(state.archivePath, state.mtimeMs, state.size);
}

async function syncTranscriptSearchIndex(db: Database, rootOverride = "") {
  const transcriptRoot = resolveTranscriptRoot(rootOverride);
  const files = await collectTranscriptFiles(transcriptRoot);
  const actualStates = new Map<string, TranscriptFileState>();
  for (const archivePath of files) {
    const stat = await fs.stat(archivePath);
    actualStates.set(archivePath, {
      archivePath,
      mtimeMs: Math.trunc(stat.mtimeMs),
      size: stat.size,
    });
  }

  const indexedStates = new Map(
    (
      db
        .prepare("SELECT archive_path, mtime_ms, size FROM file_state")
        .all() as Array<{
        archive_path: string;
        mtime_ms: number;
        size: number;
      }>
    ).map((row) => [
      row.archive_path,
      { archivePath: row.archive_path, mtimeMs: row.mtime_ms, size: row.size },
    ]),
  );

  const deleteTx = db.transaction((paths: string[]) => {
    for (const archivePath of paths)
      removeIndexedArchiveEntries(db, archivePath);
  });
  const deletedPaths = [...indexedStates.keys()].filter(
    (archivePath) => !actualStates.has(archivePath),
  );
  if (deletedPaths.length) deleteTx(deletedPaths);

  const refreshStates = [...actualStates.values()].filter((state) => {
    const indexed = indexedStates.get(state.archivePath);
    return (
      !indexed ||
      indexed.mtimeMs !== state.mtimeMs ||
      indexed.size !== state.size
    );
  });

  for (const state of refreshStates) {
    const entries = await loadTranscriptArchiveFile(state.archivePath);
    replaceIndexedArchiveEntries(db, state, entries);
  }
}

function scheduleTranscriptIndexWriteFlush(
  dbPath: string,
  writer: TranscriptIndexWriter,
) {
  if (writer.timer) return;
  writer.timer = setTimeout(() => {
    writer.timer = undefined;
    flushTranscriptIndexWrites(writer.rootOverride);
  }, TRANSCRIPT_INDEX_BATCH_DELAY_MS);
}

function flushTranscriptIndexWrites(rootOverride = "") {
  const dbPath = resolveTranscriptSearchDbPath(rootOverride);
  const writer = transcriptIndexWriters.get(dbPath);
  if (!writer) return;
  if (writer.timer) {
    clearTimeout(writer.timer);
    writer.timer = undefined;
  }
  transcriptIndexWriters.delete(dbPath);
  try {
    writer.db.exec("COMMIT");
  } catch (error) {
    try {
      writer.db.exec("ROLLBACK");
    } catch {}
    transcriptSearchNeedsSync.add(dbPath);
    markTranscriptWriterFailed(rootOverride);
  } finally {
    writer.db.close();
  }
}

function appendTranscriptIndexWrite(
  state: TranscriptFileState,
  entry: TranscriptArchiveEntry,
  rootOverride = "",
) {
  const dbPath = resolveTranscriptSearchDbPath(rootOverride);
  let writer = transcriptIndexWriters.get(dbPath);
  if (!writer) {
    const db = openTranscriptSearchDb(rootOverride);
    try {
      // DB repair can remove this process's previously failed marker. Restore
      // it before another index transaction can become crash-sensitive.
      ensureTranscriptWriterMarker(rootOverride);
      db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      db.close();
      transcriptSearchNeedsSync.add(dbPath);
      throw error;
    }
    writer = { rootOverride, db, pendingCount: 0 };
    transcriptIndexWriters.set(dbPath, writer);
  }
  try {
    appendIndexedArchiveEntry(writer.db, state, entry);
    writer.pendingCount += 1;
    if (writer.pendingCount >= TRANSCRIPT_INDEX_BATCH_SIZE) {
      flushTranscriptIndexWrites(rootOverride);
    } else {
      scheduleTranscriptIndexWriteFlush(dbPath, writer);
    }
  } catch (error) {
    try {
      writer.db.exec("ROLLBACK");
    } catch {}
    try {
      writer.db.close();
    } catch {}
    transcriptIndexWriters.delete(dbPath);
    transcriptSearchNeedsSync.add(dbPath);
    throw error;
  }
}

function transcriptWriterMarkerDir(rootOverride = "") {
  return path.join(
    path.dirname(resolveTranscriptSearchDbPath(rootOverride)),
    "search-writers",
  );
}

function processIsAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readProcessStartIdentity(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  try {
    if (process.platform === "linux") {
      const stat = fssync.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/g);
      return fields[19] ? `linux:${fields[19]}` : "";
    }
    if (process.platform === "darwin") {
      const started = execFileSync(
        "/bin/ps",
        ["-o", "lstart=", "-p", String(pid)],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      return started ? `darwin:${started}` : "";
    }
    if (process.platform === "win32") {
      const started = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      return started ? `win32:${started}` : "";
    }
  } catch {}
  return "";
}

function processMarkerIsStale(markerPath: string) {
  try {
    const marker = JSON.parse(fssync.readFileSync(markerPath, "utf8")) as {
      pid?: number;
      processStartIdentity?: string;
      createdAt?: number;
      failed?: boolean;
    };
    if (marker.failed === true) return true;
    const pid = Number(marker.pid || 0);
    if (!processIsAlive(pid)) return true;
    const actualIdentity = readProcessStartIdentity(pid);
    if (marker.processStartIdentity && actualIdentity) {
      return marker.processStartIdentity !== actualIdentity;
    }
    return false;
  } catch {
    return true;
  }
}

function staleTranscriptWriterMarkers(rootOverride = "") {
  const markerDir = transcriptWriterMarkerDir(rootOverride);
  if (!fssync.existsSync(markerDir)) return [];
  return fssync
    .readdirSync(markerDir)
    .filter((name) => name.endsWith(".dirty"))
    .map((name) => path.join(markerDir, name))
    .filter((markerPath) => processMarkerIsStale(markerPath));
}

function transcriptWriterMarkerContent(failed: boolean) {
  return `${JSON.stringify({
    pid: process.pid,
    processStartIdentity: readProcessStartIdentity(process.pid),
    createdAt: Date.now(),
    failed,
  })}\n`;
}

function markTranscriptWriterFailed(rootOverride = "") {
  const dbPath = resolveTranscriptSearchDbPath(rootOverride);
  const ownedMarker = ownedTranscriptWriterMarkers.get(dbPath);
  if (!ownedMarker) return;
  const tmpPath = `${ownedMarker.markerPath}.${process.pid}.tmp`;
  try {
    fssync.writeFileSync(tmpPath, transcriptWriterMarkerContent(true), {
      encoding: "utf8",
      mode: 0o600,
    });
    fssync.renameSync(tmpPath, ownedMarker.markerPath);
  } catch {
    try {
      fssync.unlinkSync(tmpPath);
    } catch {}
  }
}

function ensureTranscriptWriterMarker(rootOverride = "") {
  const dbPath = resolveTranscriptSearchDbPath(rootOverride);
  const ownedMarker = ownedTranscriptWriterMarkers.get(dbPath);
  if (ownedMarker && fssync.existsSync(ownedMarker.markerPath)) return;
  if (ownedMarker) ownedTranscriptWriterMarkers.delete(dbPath);
  const markerDir = transcriptWriterMarkerDir(rootOverride);
  fssync.mkdirSync(markerDir, { recursive: true, mode: 0o700 });
  const markerPath = path.join(markerDir, `${transcriptWriterMarkerId}.dirty`);
  fssync.writeFileSync(markerPath, transcriptWriterMarkerContent(false), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  ownedTranscriptWriterMarkers.set(dbPath, { markerPath, rootOverride });
  if (transcriptWriterExitHookInstalled) return;
  transcriptWriterExitHookInstalled = true;
  process.once("exit", () => {
    for (const [ownedDbPath, marker] of ownedTranscriptWriterMarkers) {
      try {
        flushTranscriptIndexWrites(marker.rootOverride);
      } catch {}
      if (transcriptSearchNeedsSync.has(ownedDbPath)) continue;
      try {
        fssync.unlinkSync(marker.markerPath);
      } catch {}
    }
  });
}

export function flushTranscriptSearchIndexWrites(rootOverride = "") {
  flushTranscriptIndexWrites(rootOverride);
}

export async function appendTranscriptArchiveEntry(
  input: Record<string, unknown>,
  rootOverride = "",
) {
  ensureTranscriptWriterMarker(rootOverride);
  const dbPath = resolveTranscriptSearchDbPath(rootOverride);
  let appended: Awaited<ReturnType<typeof appendTranscriptArchiveRecord>>;
  try {
    appended = await appendTranscriptArchiveRecord(input, rootOverride);
  } catch (error) {
    transcriptSearchNeedsSync.add(dbPath);
    markTranscriptWriterFailed(rootOverride);
    throw error;
  }
  if (!appended) return;
  try {
    appendTranscriptIndexWrite(
      appended.fileState,
      appended.entry,
      rootOverride,
    );
  } catch {
    transcriptSearchNeedsSync.add(dbPath);
    markTranscriptWriterFailed(rootOverride);
  }
}

export async function repairTranscriptSearchIndex(
  rootOverride = "",
  allowInstallerMigration = false,
) {
  flushTranscriptIndexWrites(rootOverride);
  const dbPath = resolveTranscriptSearchDbPath(rootOverride);
  const transcriptRoot = resolveTranscriptRoot(rootOverride);
  const existingMarker = readTranscriptSearchSchemaMarker(dbPath);
  if (
    fssync.existsSync(dbPath) &&
    (!existingMarker ||
      (existingMarker.state === "installer-migrating" &&
        !allowInstallerMigration))
  ) {
    throw new Error("transcript_search_install_migration_required");
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      for (const candidate of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
          fssync.rmSync(candidate, { force: true });
        } catch {}
      }
      const db = openTranscriptSearchDb(
        rootOverride,
        false,
        60_000,
        allowInstallerMigration,
      );
      try {
        await syncTranscriptSearchIndex(db, rootOverride);
        db.prepare(
          "UPDATE metadata SET value = '0' WHERE key = 'rebuild_required'",
        ).run();
        for (const markerPath of staleTranscriptWriterMarkers(rootOverride)) {
          try {
            fssync.unlinkSync(markerPath);
          } catch {}
        }
        transcriptSearchNeedsSync.delete(dbPath);
        const fileCountRow = db
          .prepare("SELECT COUNT(*) AS count FROM file_state")
          .get() as { count?: number } | undefined;
        const entryCountRow = db
          .prepare("SELECT COUNT(*) AS count FROM entries")
          .get() as { count?: number } | undefined;
        return {
          dbPath,
          transcriptRoot,
          fileCount: Number(fileCountRow?.count || 0),
          entryCount: Number(entryCountRow?.count || 0),
        };
      } finally {
        db.close();
      }
    } catch (error) {
      if (!isSqliteBusyError(error) || attempt >= 3) throw error;
      await sleep(500 * (attempt + 1));
    }
  }
  return { dbPath, transcriptRoot, fileCount: 0, entryCount: 0 };
}

async function withTranscriptSearchDb<T>(
  rootOverride: string,
  fn: (db: Database) => T | Promise<T>,
): Promise<T> {
  flushTranscriptIndexWrites(rootOverride);
  const dbPath = resolveTranscriptSearchDbPath(rootOverride);
  const db = openTranscriptSearchDb(rootOverride);
  try {
    const staleWriterMarkers = staleTranscriptWriterMarkers(rootOverride);
    const rebuildRequired = db
      .prepare("SELECT value FROM metadata WHERE key = 'rebuild_required'")
      .get() as { value?: string } | undefined;
    if (
      transcriptSearchNeedsSync.has(dbPath) ||
      staleWriterMarkers.length > 0 ||
      rebuildRequired?.value === "1"
    ) {
      await syncTranscriptSearchIndex(db, rootOverride);
      db.prepare(
        "UPDATE metadata SET value = '0' WHERE key = 'rebuild_required'",
      ).run();
      for (const markerPath of staleWriterMarkers) {
        try {
          fssync.unlinkSync(markerPath);
        } catch {}
      }
      transcriptSearchNeedsSync.delete(dbPath);
    }
    return await fn(db);
  } finally {
    db.close();
  }
}

type IndexedEntryRow = {
  entry_id: string;
  timestamp: string;
  session_id: string;
  session_file: string;
  role: string;
  text: string;
  tool_name: string;
  custom_type: string;
  line_number: number;
  archive_path: string;
};

function indexedRowToEntry(
  row: IndexedEntryRow,
): TranscriptArchiveEntry | null {
  const text = safeString(row.text).trim();
  if (!text) return null;
  return {
    id: safeString(row.entry_id).trim(),
    timestamp: safeString(row.timestamp).trim(),
    sessionId: safeString(row.session_id).trim(),
    sessionFile: safeString(row.session_file).trim(),
    role: safeString(row.role).trim(),
    text,
    toolName: safeString(row.tool_name).trim() || undefined,
    customType: safeString(row.custom_type).trim() || undefined,
    archiveLine: Math.max(1, Number(row.line_number) || 1),
    archivePath: safeString(row.archive_path).trim() || undefined,
  };
}

function loadSessionEntriesByKeys(
  db: Database,
  sessionKeys: string[],
): Map<string, TranscriptArchiveEntry[]> {
  const normalizedKeys = uniqueStrings(
    sessionKeys
      .map((sessionKey) => safeString(sessionKey).trim())
      .filter(Boolean),
  );
  const grouped = new Map<string, TranscriptArchiveEntry[]>(
    normalizedKeys.map((sessionKey) => [sessionKey, []]),
  );
  if (!normalizedKeys.length) return grouped;

  const placeholders = normalizedKeys.map(() => "?").join(",");
  const rows = db
    .prepare(
      `
      SELECT session_key, entry_id, timestamp, session_id, session_file, role,
             text, tool_name, custom_type, line_number, archive_path
      FROM entries
      WHERE session_key IN (${placeholders})
      ORDER BY timestamp_ms ASC, line_number ASC, row_key ASC
    `,
    )
    .all(...normalizedKeys) as Array<IndexedEntryRow & { session_key: string }>;
  for (const row of rows) {
    const entry = indexedRowToEntry(row);
    if (!entry) continue;
    grouped.get(row.session_key)?.push(entry);
  }
  return grouped;
}

async function loadFullSessionEntriesByKey(
  db: Database,
  sessionKey: string,
): Promise<TranscriptArchiveEntry[]> {
  const rows = db
    .prepare(
      "SELECT DISTINCT archive_path FROM entries WHERE session_key = ? ORDER BY archive_path ASC",
    )
    .all(sessionKey) as Array<{ archive_path: string }>;
  const entries: TranscriptArchiveEntry[] = [];
  for (const row of rows) {
    const archivePath = safeString(row.archive_path).trim();
    if (!archivePath || !fssync.existsSync(archivePath)) {
      throw new Error(`transcript_archive_missing:${archivePath}`);
    }
    const archiveEntries = await loadTranscriptArchiveFile(archivePath);
    entries.push(
      ...archiveEntries.filter(
        (entry) => sessionGroupingKey(entry) === sessionKey,
      ),
    );
  }
  return entries.sort((left, right) => {
    const timestampDiff =
      timestampValue(left.timestamp) - timestampValue(right.timestamp);
    if (timestampDiff) return timestampDiff;
    return Number(left.archiveLine || 0) - Number(right.archiveLine || 0);
  });
}

export async function loadTranscriptSessionEntries(
  params: { sessionId?: string; sessionFile?: string; path?: string } = {},
  rootOverride = "",
): Promise<TranscriptArchiveEntry[]> {
  const sessionId = safeString(params.sessionId || "").trim();
  const sessionFile = safeString(params.sessionFile || "").trim();
  const archivePath = safeString(params.path || "").trim();
  const resolvedArchivePath = archivePath
    ? path.isAbsolute(archivePath)
      ? archivePath
      : path.join(resolveTranscriptRoot(rootOverride), archivePath)
    : "";
  if (resolvedArchivePath && !sessionId && !sessionFile) {
    if (!fssync.existsSync(resolvedArchivePath)) {
      throw new Error(`transcript_archive_missing:${resolvedArchivePath}`);
    }
    return loadTranscriptArchiveFile(resolvedArchivePath);
  }
  if (!sessionId && !sessionFile) return [];
  return withTranscriptSearchDb(rootOverride, async (db) => {
    if (sessionFile) {
      const row = db
        .prepare(
          "SELECT session_key FROM entries WHERE session_file = ? ORDER BY timestamp_ms DESC LIMIT 1",
        )
        .get(sessionFile) as { session_key?: string } | undefined;
      if (row?.session_key) {
        return loadFullSessionEntriesByKey(db, row.session_key);
      }
    }
    if (sessionId) {
      const row = db
        .prepare(
          "SELECT session_key FROM entries WHERE session_id = ? ORDER BY timestamp_ms DESC LIMIT 1",
        )
        .get(sessionId) as { session_key?: string } | undefined;
      if (row?.session_key) {
        return loadFullSessionEntriesByKey(db, row.session_key);
      }
    }
    if (resolvedArchivePath) {
      if (!fssync.existsSync(resolvedArchivePath)) {
        throw new Error(`transcript_archive_missing:${resolvedArchivePath}`);
      }
      const hintedEntries =
        await loadTranscriptArchiveFile(resolvedArchivePath);
      return hintedEntries.filter(
        (entry) =>
          (!sessionFile || entry.sessionFile === sessionFile) &&
          (!sessionId || entry.sessionId === sessionId),
      );
    }
    return [];
  });
}

export async function loadRecentTranscriptSessions(
  params: Record<string, unknown> = {},
  rootOverride = "",
): Promise<TranscriptSessionResult[]> {
  const limit = Math.max(
    1,
    Number(params.limit || DEFAULT_RESULT_LIMIT) || DEFAULT_RESULT_LIMIT,
  );
  return withTranscriptSearchDb(rootOverride, (db) => {
    const sessionRows = db
      .prepare(
        `
        SELECT session_key, MAX(timestamp_ms) AS latest_timestamp_ms
        FROM entries
        GROUP BY session_key
        ORDER BY latest_timestamp_ms DESC
        LIMIT ?
      `,
      )
      .all(limit) as Array<{
      session_key: string;
      latest_timestamp_ms: number;
    }>;
    const sessionEntries = loadSessionEntriesByKeys(
      db,
      sessionRows.map((row) => row.session_key),
    );
    return sessionRows
      .map((row, index) => {
        const entries = sessionEntries.get(row.session_key) || [];
        const result = presentSessionResult(
          entries,
          Math.max(1, limit - index),
          rootOverride,
        );
        return safeString(result?.sessionFile || "").trim() ? result : null;
      })
      .filter((item): item is TranscriptSessionResult => Boolean(item));
  });
}

function addCandidateScore(
  candidates: Map<string, number>,
  rowKey: string,
  score: number,
) {
  if (!rowKey || score <= 0) return;
  candidates.set(rowKey, Math.max(candidates.get(rowKey) || 0, score));
}

type SearchCandidateRow = {
  row_key: string;
  text: string;
  role: string;
  tool_name: string;
  custom_type: string;
  session_id: string;
  session_file: string;
};

function candidateHaystack(row: SearchCandidateRow): string {
  return normalizeNeedle(
    [
      row.text,
      row.role,
      row.tool_name,
      row.session_id,
      row.session_file,
      row.custom_type,
    ].join(" "),
  );
}

function exactCandidateBoost(
  row: SearchCandidateRow,
  rawQuery: string,
): number {
  const normalizedQuery = normalizeNeedle(rawQuery);
  if (!normalizedQuery) return 0;

  const haystack = candidateHaystack(row);
  if (!haystack.includes(normalizedQuery)) return 0;

  let boost = 40;
  if (haystack === normalizedQuery) boost += 30;
  if (normalizeNeedle(row.text).includes(normalizedQuery)) boost += 18;
  return boost;
}

function queryFtsCandidates(
  db: Database,
  tableName: "entries_fts_token" | "entries_fts_trigram",
  query: string,
  rawHitLimit: number,
  baseScore: number,
  step: number,
  candidates: Map<string, number>,
) {
  if (!query) return;
  const rows = db
    .prepare(
      `
      SELECT row_key
      FROM ${tableName}
      WHERE ${tableName} MATCH ?
      ORDER BY bm25(${tableName})
      LIMIT ?
    `,
    )
    .all(query, rawHitLimit) as Array<{ row_key: string }>;
  rows.forEach((row, index) => {
    addCandidateScore(candidates, row.row_key, baseScore - index * step);
  });
}

function aggregateSearchResults(
  db: Database,
  candidates: Map<string, number>,
  limit: number,
  rootOverride = "",
  options: { rawQuery?: string; exactOnly?: boolean } = {},
): TranscriptSessionResult[] {
  if (!candidates.size) return [];

  const placeholders = [...candidates.keys()].map(() => "?").join(",");
  const rows = db
    .prepare(
      `
      SELECT row_key, archive_path, entry_id, session_key, session_id,
             session_file, timestamp, timestamp_ms, line_number, role,
             tool_name, custom_type, text, preview
      FROM entries
      WHERE row_key IN (${placeholders})
    `,
    )
    .all(...candidates.keys()) as Array<{
    row_key: string;
    archive_path: string;
    entry_id: string;
    session_key: string;
    session_id: string;
    session_file: string;
    timestamp: string;
    timestamp_ms: number;
    line_number: number;
    role: string;
    tool_name: string;
    custom_type: string;
    text: string;
    preview: string;
  }>;

  const orderedRows = rows
    .map((row) => ({
      ...row,
      score:
        (candidates.get(row.row_key) || 0) +
        exactCandidateBoost(row, options.rawQuery || ""),
    }))
    .filter(
      (row) =>
        !options.exactOnly ||
        candidateHaystack(row).includes(
          normalizeNeedle(options.rawQuery || ""),
        ),
    )
    .sort((a, b) => {
      const diff = b.score - a.score;
      if (diff) return diff;
      return b.timestamp_ms - a.timestamp_ms;
    })
    .slice(0, RAW_SEARCH_LIMIT);

  const grouped = new Map<string, IndexedSessionBucket>();
  for (const row of orderedRows) {
    const bucket = grouped.get(row.session_key) || {
      sessionKey: row.session_key,
      sessionId: row.session_id,
      sessionFile: row.session_file,
      bestScore: row.score,
      totalScore: 0,
      hitCount: 0,
      latestHitTimestampMs: row.timestamp_ms,
      messages: [],
      displayEntries: [],
    };
    bucket.bestScore = Math.max(bucket.bestScore, row.score);
    bucket.totalScore += row.score;
    bucket.hitCount += 1;
    bucket.latestHitTimestampMs = Math.max(
      bucket.latestHitTimestampMs,
      row.timestamp_ms,
    );
    if (bucket.messages.length < MAX_MATCHED_ENTRIES_PER_SESSION) {
      const entry = indexedRowToEntry({
        entry_id: row.entry_id,
        timestamp: row.timestamp,
        session_id: row.session_id,
        session_file: row.session_file,
        role: row.role,
        text: row.text,
        tool_name: row.tool_name,
        custom_type: row.custom_type,
        line_number: row.line_number,
        archive_path: row.archive_path,
      });
      if (entry && !isLegacySyntheticSessionSummaryEntry(entry)) {
        bucket.messages.push(buildResultMessage(entry));
        bucket.displayEntries.push(entry);
      }
    }
    grouped.set(row.session_key, bucket);
  }

  const rankedSessions = [...grouped.values()]
    .map((bucket) => ({
      ...bucket,
      score:
        bucket.bestScore +
        Math.min(bucket.hitCount, 8) * 14 +
        Math.min(bucket.totalScore, 400) / 10,
    }))
    .sort((a, b) => {
      const diff = b.score - a.score;
      if (diff) return diff;
      return b.latestHitTimestampMs - a.latestHitTimestampMs;
    })
    .slice(0, limit);

  return rankedSessions
    .map((bucket) => {
      if (!bucket.displayEntries.length) return null;
      const result = presentSessionResult(
        bucket.displayEntries,
        bucket.score,
        rootOverride,
        {
          hitCount: bucket.hitCount,
          messages: bucket.messages,
        },
      );
      return safeString(result?.sessionFile || "").trim() ? result : null;
    })
    .filter((item): item is TranscriptSessionResult => Boolean(item));
}

export async function searchTranscriptArchive(
  query: string,
  params: Record<string, unknown> = {},
  rootOverride = "",
): Promise<TranscriptSessionResult[]> {
  const rawQuery = safeString(query).trim();
  if (!rawQuery) return [];
  const limit = Math.max(
    1,
    Number(params.limit || DEFAULT_RESULT_LIMIT) || DEFAULT_RESULT_LIMIT,
  );
  const fidelity = safeString(params.fidelity || "").trim();

  return withTranscriptSearchDb(rootOverride, (db) => {
    const tokenQuery = buildTokenFtsQuery(rawQuery);
    const trigramQuery = buildTrigramFtsQuery(rawQuery);
    const candidates = new Map<string, number>();

    queryFtsCandidates(
      db,
      "entries_fts_token",
      tokenQuery,
      RAW_SEARCH_LIMIT,
      140,
      3,
      candidates,
    );
    queryFtsCandidates(
      db,
      "entries_fts_trigram",
      trigramQuery,
      RAW_SEARCH_LIMIT,
      100,
      2,
      candidates,
    );

    return aggregateSearchResults(db, candidates, limit, rootOverride, {
      rawQuery,
      exactOnly: fidelity === "exact",
    });
  });
}
