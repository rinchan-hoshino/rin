import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import readline from "node:readline";

import BetterSqlite3 from "better-sqlite3";
import lockfile from "proper-lockfile";

import { normalizeSessionValue } from "./ref.js";
import type { BoundSessionListItem } from "./listing.js";

const SESSION_CATALOG_DIR_NAME = ".rin-session-catalog";
const SESSION_CATALOG_VERSION = "v3";
const SESSION_CATALOG_SCHEMA_VERSION = 3;
const SESSION_CATALOG_DB_NAME = "catalog.sqlite";
const LEGACY_SESSION_CATALOG_VERSIONS = ["v1", "v2"];
const HEAD_READ_BYTES = 256 * 1024;
const TAIL_READ_BYTES = 128 * 1024;
const MAX_CONCURRENT_SESSION_SUMMARY_LOADS = 20;

export type SessionSummary = BoundSessionListItem & {
  parentSessionPath?: string;
};

type SessionCatalogRecord = {
  path: string;
  id: string;
  name?: string;
  firstMessage: string;
  modified: string;
  messageCount: number;
  cwd?: string;
  parentSessionPath?: string;
  allMessagesText: string;
  indexedEntryCount: number;
  indexedLastEntrySignature?: string;
  indexedEntriesHash: string;
  directoryOrdinal: number;
  fileSize: number;
  fileMtimeMs: number;
  fileCtimeMs: number;
};

type SessionCatalogExcludedRow = {
  path: string;
  file_size: number;
  file_mtime_ms: number;
  file_ctime_ms: number;
};

type SessionCatalogRow = {
  path: string;
  id: string;
  name: string | null;
  first_message: string;
  modified: string;
  modified_ms: number;
  message_count: number;
  cwd: string | null;
  resolved_cwd: string | null;
  parent_session_path: string | null;
  all_messages_text: string;
  indexed_entry_count: number;
  indexed_last_entry_signature: string | null;
  indexed_entries_hash: string;
  directory_ordinal: number;
  file_size: number;
  file_mtime_ms: number;
  file_ctime_ms: number;
};

export type SessionCatalogPage = {
  sessions: SessionSummary[];
  offset: number;
  limit: number;
  total: number;
  hasMore: boolean;
  nextOffset?: number;
};

function isSessionRecordFile(name: string): boolean {
  return name.endsWith(".jsonl");
}

export async function listSessionRecordFiles(
  sessionDir: string,
): Promise<string[]> {
  try {
    const entries = await fs.readdir(sessionDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && isSessionRecordFile(entry.name))
      .map((entry) => path.join(sessionDir, entry.name));
  } catch {
    return [];
  }
}

async function readFileSlice(
  filePath: string,
  start: number,
  length: number,
): Promise<string> {
  if (length <= 0) return "";
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function completeHeadLines(text: string, complete: boolean): string[] {
  const lines = text.split("\n");
  if (!complete && !text.endsWith("\n")) lines.pop();
  return lines.map((line) => line.trim()).filter(Boolean);
}

function completeTailLines(text: string, startsAtFileStart: boolean): string[] {
  const lines = text.split("\n");
  if (!startsAtFileStart) lines.shift();
  return lines.map((line) => line.trim()).filter(Boolean);
}

function parseJsonLine(line: string): any | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function normalizeEntryTimestamp(entry: any): Date | undefined {
  const timestamp = normalizeSessionValue(entry?.timestamp);
  if (!timestamp) return undefined;
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function isMessageWithContent(message: any): boolean {
  // Keep this deliberately aligned with Pi's buildSessionInfo behavior.
  return typeof message.role === "string" && "content" in message;
}

function extractMessageText(entry: any): string {
  if (entry?.type !== "message") return "";
  const message = entry.message;
  if (!isMessageWithContent(message)) return "";
  if (message.role !== "user" && message.role !== "assistant") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  return content
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text)
    .join(" ");
}

function messageActivityTime(entry: any): number | undefined {
  if (entry?.type !== "message") return undefined;
  const message = entry.message;
  if (!isMessageWithContent(message)) return undefined;
  if (message.role !== "user" && message.role !== "assistant") {
    return undefined;
  }
  if (typeof message.timestamp === "number") return message.timestamp;
  const timestamp = new Date(entry.timestamp).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function entrySignature(entry: any): string {
  if (!entry) return "";
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(entry))
    .digest("hex");
}

type SessionFileFreshness = {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
};

function fileFreshness(stats: fsSync.Stats): SessionFileFreshness {
  return {
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    dev: Number(stats.dev),
    ino: Number(stats.ino),
  };
}

function sameFileFreshness(
  left: SessionFileFreshness,
  right: SessionFileFreshness,
): boolean {
  return (
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

function createSessionRecordAccumulator(
  filePath: string,
  fallbackModified?: Date,
  freshness: Partial<SessionFileFreshness> = {},
) {
  let id = "";
  let sawEntry = false;
  let sawHeader = false;
  let invalidHeader = false;
  let cwd: string | undefined;
  let parentSessionPath: string | undefined;
  let headerModified: Date | undefined;
  let lastActivityTime: number | undefined;
  let name: string | undefined;
  let firstUserMessage = "";
  let messageCount = 0;
  let indexedEntryCount = 0;
  let indexedLastEntrySignature = "";
  const indexedEntriesHasher = crypto.createHash("sha256");
  const allMessages: string[] = [];

  return {
    add(entry: any) {
      indexedEntryCount += 1;
      indexedLastEntrySignature = entrySignature(entry);
      indexedEntriesHasher.update(JSON.stringify(entry));
      indexedEntriesHasher.update("\n");
      if (!sawEntry) {
        sawEntry = true;
        invalidHeader = entry?.type !== "session";
        if (!invalidHeader) {
          sawHeader = true;
          // Pi keeps the raw header id, then Rin's common list normalizer turns
          // malformed ids into text/path fallbacks. Store that final equivalent.
          id = normalizeSessionValue(entry.id) || filePath;
          cwd = typeof entry.cwd === "string" ? entry.cwd : "";
          parentSessionPath = entry.parentSession;
          if (typeof entry.timestamp === "string") {
            const headerTime = new Date(entry.timestamp);
            if (Number.isFinite(headerTime.getTime())) {
              headerModified = headerTime;
            }
          }
        }
      }
      if (entry?.type === "session_info") {
        name = entry.name?.trim() || undefined;
      }
      if (entry?.type !== "message") return;
      messageCount += 1;
      const activityTime = messageActivityTime(entry);
      if (typeof activityTime === "number") {
        lastActivityTime = Math.max(lastActivityTime || 0, activityTime);
      }
      const text = extractMessageText(entry);
      if (!text) return;
      allMessages.push(text);
      if (!firstUserMessage && entry.message?.role === "user") {
        firstUserMessage = text;
      }
    },
    finish(): SessionCatalogRecord | null {
      if (!sawHeader || invalidHeader) return null;
      const modified =
        typeof lastActivityTime === "number" && lastActivityTime > 0
          ? new Date(lastActivityTime)
          : headerModified || fallbackModified || new Date();
      const firstMessage = firstUserMessage || "(no messages)";
      return {
        path: filePath,
        id,
        name,
        firstMessage,
        modified: modified.toISOString(),
        messageCount,
        cwd,
        parentSessionPath,
        allMessagesText: allMessages.join(" "),
        indexedEntryCount,
        indexedLastEntrySignature: indexedLastEntrySignature || undefined,
        indexedEntriesHash: indexedEntriesHasher.digest("hex"),
        directoryOrdinal: 0,
        fileSize: Math.max(0, Number(freshness.size) || 0),
        fileMtimeMs: Math.max(0, Number(freshness.mtimeMs) || 0),
        fileCtimeMs: Math.max(0, Number(freshness.ctimeMs) || 0),
      };
    },
  };
}

function summarizeEntries(
  filePath: string,
  entries: Iterable<any>,
  fallbackModified?: Date,
): SessionCatalogRecord | null {
  const accumulator = createSessionRecordAccumulator(
    filePath,
    fallbackModified,
  );
  for (const entry of entries) accumulator.add(entry);
  return accumulator.finish();
}

function catalogRecordToSummary(record: SessionCatalogRecord): SessionSummary {
  return {
    id: record.id,
    path: record.path,
    name: record.name,
    firstMessage: record.firstMessage,
    modified: new Date(record.modified),
    messageCount: record.messageCount,
    cwd: record.cwd,
    allMessagesText: record.allMessagesText,
    ...(record.parentSessionPath
      ? { parentSessionPath: record.parentSessionPath }
      : {}),
  };
}

export function summarizeSessionEntries(
  filePath: string,
  entries: any[],
  fallbackModified?: Date,
): SessionSummary | null {
  const record = summarizeEntries(filePath, entries, fallbackModified);
  return record ? catalogRecordToSummary(record) : null;
}

export async function readSessionSummary(
  filePath: string,
): Promise<SessionSummary | null> {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) return null;

    const size = stats.size;
    const headLength = Math.min(size, HEAD_READ_BYTES);
    const tailStart = Math.max(0, size - TAIL_READ_BYTES);
    const [headText, tailText] = await Promise.all([
      readFileSlice(filePath, 0, headLength),
      tailStart === 0
        ? Promise.resolve("")
        : readFileSlice(filePath, tailStart, size - tailStart),
    ]);
    const headLines = completeHeadLines(headText, headLength >= size);
    const tailLines = tailStart === 0 ? [] : completeTailLines(tailText, false);
    const entries = [...headLines, ...tailLines]
      .map(parseJsonLine)
      .filter((entry): entry is any => Boolean(entry));

    return summarizeSessionEntries(filePath, entries, stats.mtime);
  } catch {
    return null;
  }
}

type StableSessionRecordRead = {
  record: SessionCatalogRecord | null;
  freshness: SessionFileFreshness;
};

async function readCompleteSessionRecord(
  filePath: string,
): Promise<StableSessionRecordRead | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let beforeStats: fsSync.Stats;
    try {
      beforeStats = await fs.stat(filePath);
    } catch {
      return null;
    }
    if (!beforeStats.isFile()) return null;
    const before = fileFreshness(beforeStats);
    try {
      const accumulator = createSessionRecordAccumulator(
        filePath,
        beforeStats.mtime,
        before,
      );
      const lines = readline.createInterface({
        input: fsSync.createReadStream(filePath, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      for await (const line of lines) {
        const entry = parseJsonLine(line);
        if (entry) accumulator.add(entry);
      }
      const after = fileFreshness(await fs.stat(filePath));
      if (!sameFileFreshness(before, after)) continue;
      return { record: accumulator.finish(), freshness: after };
    } catch {
      try {
        const after = fileFreshness(await fs.stat(filePath));
        if (!sameFileFreshness(before, after)) continue;
        return { record: null, freshness: after };
      } catch {
        return null;
      }
    }
  }
  return null;
}

export async function loadSessionSummaries(
  files: string[],
): Promise<SessionSummary[]> {
  const results: Array<SessionSummary | null> = new Array(files.length).fill(
    null,
  );
  const inFlight = new Set<Promise<void>>();
  let nextIndex = 0;

  const startNext = () => {
    const index = nextIndex++;
    const file = files[index];
    if (!file) return;
    const task = readSessionSummary(file)
      .then((summary) => {
        results[index] = summary;
      })
      .catch(() => {
        results[index] = null;
      })
      .finally(() => {
        inFlight.delete(task);
      });
    inFlight.add(task);
  };

  while (nextIndex < files.length || inFlight.size > 0) {
    while (
      nextIndex < files.length &&
      inFlight.size < MAX_CONCURRENT_SESSION_SUMMARY_LOADS
    ) {
      startNext();
    }
    if (inFlight.size > 0) await Promise.race(inFlight);
  }

  return results.filter((summary): summary is SessionSummary =>
    Boolean(summary),
  );
}

function catalogBaseRoot(sessionDir: string): string {
  return path.join(path.resolve(sessionDir), SESSION_CATALOG_DIR_NAME);
}

function catalogRoot(sessionDir: string): string {
  return path.join(catalogBaseRoot(sessionDir), SESSION_CATALOG_VERSION);
}

function catalogDbPath(sessionDir: string): string {
  return path.join(catalogRoot(sessionDir), SESSION_CATALOG_DB_NAME);
}

function initializeCatalogDb(db: BetterSqlite3.Database): void {
  db.pragma("journal_mode = DELETE");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const storedVersion = readCatalogMeta(db, "schema_version");
  const sessionsTable = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
    )
    .get();
  if (
    (storedVersion &&
      storedVersion !== String(SESSION_CATALOG_SCHEMA_VERSION)) ||
    (storedVersion && !sessionsTable) ||
    (!storedVersion && sessionsTable)
  ) {
    throw new Error(
      `Unsupported session catalog schema: ${storedVersion || "missing"}`,
    );
  }
  if (storedVersion && sessionsTable) {
    const columns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    const expectedColumns = [
      ["path", "TEXT", 0, 1],
      ["id", "TEXT", 1, 0],
      ["name", "TEXT", 0, 0],
      ["first_message", "TEXT", 1, 0],
      ["modified", "TEXT", 1, 0],
      ["modified_ms", "INTEGER", 1, 0],
      ["message_count", "INTEGER", 1, 0],
      ["cwd", "TEXT", 0, 0],
      ["resolved_cwd", "TEXT", 0, 0],
      ["parent_session_path", "TEXT", 0, 0],
      ["all_messages_text", "TEXT", 1, 0],
      ["indexed_entry_count", "INTEGER", 1, 0],
      ["indexed_last_entry_signature", "TEXT", 0, 0],
      ["indexed_entries_hash", "TEXT", 1, 0],
      ["directory_ordinal", "INTEGER", 1, 0],
      ["file_size", "INTEGER", 1, 0],
      ["file_mtime_ms", "REAL", 1, 0],
      ["file_ctime_ms", "REAL", 1, 0],
    ] as const;
    const valid =
      columns.length === expectedColumns.length &&
      expectedColumns.every((expected, index) => {
        const column = columns[index];
        return (
          column?.name === expected[0] &&
          column.type.toUpperCase() === expected[1] &&
          column.notnull === expected[2] &&
          column.pk === expected[3]
        );
      });
    if (!valid) throw new Error("Invalid session catalog schema");
    const excludedColumns = db
      .prepare("PRAGMA table_info(excluded_files)")
      .all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    const expectedExcludedColumns = [
      ["path", "TEXT", 0, 1],
      ["file_size", "INTEGER", 1, 0],
      ["file_mtime_ms", "REAL", 1, 0],
      ["file_ctime_ms", "REAL", 1, 0],
    ] as const;
    const excludedValid =
      excludedColumns.length === expectedExcludedColumns.length &&
      expectedExcludedColumns.every((expected, index) => {
        const column = excludedColumns[index];
        return (
          column?.name === expected[0] &&
          column.type.toUpperCase() === expected[1] &&
          column.notnull === expected[2] &&
          column.pk === expected[3]
        );
      });
    if (!excludedValid) throw new Error("Invalid excluded catalog schema");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      path TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      name TEXT,
      first_message TEXT NOT NULL,
      modified TEXT NOT NULL,
      modified_ms INTEGER NOT NULL,
      message_count INTEGER NOT NULL,
      cwd TEXT,
      resolved_cwd TEXT,
      parent_session_path TEXT,
      all_messages_text TEXT NOT NULL,
      indexed_entry_count INTEGER NOT NULL,
      indexed_last_entry_signature TEXT,
      indexed_entries_hash TEXT NOT NULL,
      directory_ordinal INTEGER NOT NULL,
      file_size INTEGER NOT NULL,
      file_mtime_ms REAL NOT NULL,
      file_ctime_ms REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS excluded_files (
      path TEXT PRIMARY KEY,
      file_size INTEGER NOT NULL,
      file_mtime_ms REAL NOT NULL,
      file_ctime_ms REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_modified_idx
      ON sessions(modified_ms DESC, directory_ordinal ASC);
    CREATE INDEX IF NOT EXISTS sessions_cwd_modified_idx
      ON sessions(resolved_cwd, modified_ms DESC, directory_ordinal ASC);
  `);
  if (!storedVersion) {
    setCatalogMeta(
      db,
      "schema_version",
      String(SESSION_CATALOG_SCHEMA_VERSION),
    );
  }
}

function openCatalogDbPath(dbPath: string): BetterSqlite3.Database {
  fsSync.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new BetterSqlite3(dbPath);
  try {
    initializeCatalogDb(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function openCatalogDb(sessionDir: string): BetterSqlite3.Database {
  return openCatalogDbPath(catalogDbPath(sessionDir));
}

function setCatalogMeta(
  db: BetterSqlite3.Database,
  key: string,
  value: string,
): void {
  db.prepare(
    `INSERT INTO catalog_meta(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

function readCatalogMeta(
  db: BetterSqlite3.Database,
  key: string,
): string | undefined {
  const row = db
    .prepare("SELECT value FROM catalog_meta WHERE key = ?")
    .get(key) as { value?: unknown } | undefined;
  return normalizeSessionValue(row?.value) || undefined;
}

function rowToCatalogRecord(row: SessionCatalogRow): SessionCatalogRecord {
  return {
    path: row.path,
    id: row.id,
    name: normalizeSessionValue(row.name) || undefined,
    firstMessage: row.first_message,
    modified: row.modified,
    messageCount: Math.max(0, Number(row.message_count) || 0),
    cwd: normalizeSessionValue(row.cwd) || undefined,
    parentSessionPath:
      normalizeSessionValue(row.parent_session_path) || undefined,
    allMessagesText: row.all_messages_text,
    indexedEntryCount: Math.max(0, Number(row.indexed_entry_count) || 0),
    indexedLastEntrySignature:
      normalizeSessionValue(row.indexed_last_entry_signature) || undefined,
    indexedEntriesHash: normalizeSessionValue(row.indexed_entries_hash),
    directoryOrdinal: Math.max(0, Number(row.directory_ordinal) || 0),
    fileSize: Math.max(0, Number(row.file_size) || 0),
    fileMtimeMs: Math.max(0, Number(row.file_mtime_ms) || 0),
    fileCtimeMs: Math.max(0, Number(row.file_ctime_ms) || 0),
  };
}

function upsertCatalogRecord(
  db: BetterSqlite3.Database,
  record: SessionCatalogRecord,
): void {
  db.prepare(
    `
    INSERT INTO sessions (
      path, id, name, first_message, modified, modified_ms, message_count,
      cwd, resolved_cwd, parent_session_path, all_messages_text,
      indexed_entry_count, indexed_last_entry_signature, indexed_entries_hash,
      directory_ordinal, file_size, file_mtime_ms, file_ctime_ms
    ) VALUES (
      @path, @id, @name, @firstMessage, @modified, @modifiedMs, @messageCount,
      @cwd, @resolvedCwd, @parentSessionPath, @allMessagesText,
      @indexedEntryCount, @indexedLastEntrySignature, @indexedEntriesHash,
      @directoryOrdinal, @fileSize, @fileMtimeMs, @fileCtimeMs
    )
    ON CONFLICT(path) DO UPDATE SET
      id = excluded.id,
      name = excluded.name,
      first_message = excluded.first_message,
      modified = excluded.modified,
      modified_ms = excluded.modified_ms,
      message_count = excluded.message_count,
      cwd = excluded.cwd,
      resolved_cwd = excluded.resolved_cwd,
      parent_session_path = excluded.parent_session_path,
      all_messages_text = excluded.all_messages_text,
      indexed_entry_count = excluded.indexed_entry_count,
      indexed_last_entry_signature = excluded.indexed_last_entry_signature,
      indexed_entries_hash = excluded.indexed_entries_hash,
      directory_ordinal = excluded.directory_ordinal,
      file_size = excluded.file_size,
      file_mtime_ms = excluded.file_mtime_ms,
      file_ctime_ms = excluded.file_ctime_ms
  `,
  ).run({
    ...record,
    name: record.name || null,
    modifiedMs: new Date(record.modified).getTime(),
    cwd: record.cwd || null,
    resolvedCwd: record.cwd ? path.resolve(record.cwd) : null,
    parentSessionPath: record.parentSessionPath || null,
    indexedLastEntrySignature: record.indexedLastEntrySignature || null,
  });
}

function upsertExcludedFile(
  db: BetterSqlite3.Database,
  filePath: string,
  freshness: SessionFileFreshness,
): void {
  db.prepare(
    `INSERT INTO excluded_files(path, file_size, file_mtime_ms, file_ctime_ms)
     VALUES(?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       file_size = excluded.file_size,
       file_mtime_ms = excluded.file_mtime_ms,
       file_ctime_ms = excluded.file_ctime_ms`,
  ).run(filePath, freshness.size, freshness.mtimeMs, freshness.ctimeMs);
}

function catalogLockOptions() {
  return {
    realpath: false,
    stale: 60_000,
    update: 10_000,
    retries: {
      retries: 200,
      factor: 1.1,
      minTimeout: 25,
      maxTimeout: 250,
    },
  } as const;
}

function ensureCatalogLockTargets(sessionDir: string) {
  const root = catalogRoot(sessionDir);
  fsSync.mkdirSync(root, { recursive: true });
  const rebuildTarget = path.join(root, ".rebuild-target");
  if (!fsSync.existsSync(rebuildTarget))
    fsSync.writeFileSync(rebuildTarget, "");
  return { root, rebuildTarget };
}

function withCatalogWriteLockSync<T>(sessionDir: string, task: () => T): T {
  const { root } = ensureCatalogLockTargets(sessionDir);
  const deadline = Date.now() + 5000;
  let release: (() => void) | undefined;
  while (!release) {
    try {
      release = lockfile.lockSync(root, {
        realpath: false,
        stale: 60_000,
      });
    } catch (error: any) {
      if (error?.code !== "ELOCKED" || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return task();
  } finally {
    release();
  }
}

async function withCatalogWriteLock<T>(
  sessionDir: string,
  task: () => T,
): Promise<T> {
  const { root } = ensureCatalogLockTargets(sessionDir);
  const release = await lockfile.lock(root, catalogLockOptions());
  try {
    return task();
  } finally {
    await release();
  }
}

export function updateSessionCatalogFromSessionManagerSync(
  sessionManager: any,
): boolean {
  try {
    if (sessionManager?.isPersisted?.() === false) return false;
    const sessionFile = normalizeSessionValue(sessionManager?.sessionFile);
    if (!sessionFile || !fsSync.existsSync(sessionFile)) return false;
    const sessionDir =
      normalizeSessionValue(sessionManager?.getSessionDir?.()) ||
      path.dirname(sessionFile);
    if (path.dirname(path.resolve(sessionFile)) !== path.resolve(sessionDir)) {
      return false;
    }
    return withCatalogWriteLockSync(sessionDir, () => {
      const db = openCatalogDb(sessionDir);
      try {
        db.transaction(() => {
          // Keep Pi persistence O(1). Public listing hides dirty catalogs and
          // refreshes this file from a stable disk read before returning rows.
          setCatalogMeta(db, "dirty", "1");
          setCatalogMeta(
            db,
            "revision",
            String(Number(readCatalogMeta(db, "revision") || 0) + 1),
          );
        })();
        return true;
      } finally {
        db.close();
      }
    });
  } catch {
    return false;
  }
}

function removeLegacyCatalogs(sessionDir: string): void {
  for (const version of LEGACY_SESSION_CATALOG_VERSIONS) {
    fsSync.rmSync(path.join(catalogBaseRoot(sessionDir), version), {
      recursive: true,
      force: true,
    });
  }
}

function removeDatabaseArtifacts(dbPath: string): void {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    fsSync.rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

type SessionCatalogRebuildResult = {
  checked: number;
  indexed: number;
};

const catalogRebuilds = new Map<string, Promise<SessionCatalogRebuildResult>>();

type SessionCatalogReconcilePlan = {
  baseRevision: string;
  checked: number;
  observed: Map<string, SessionFileFreshness>;
  replacements: SessionCatalogRecord[];
  removals: string[];
  excludedReplacements: Array<{
    path: string;
    freshness: SessionFileFreshness;
  }>;
  excludedRemovals: string[];
};

function rowMatchesFreshness(
  row: SessionCatalogRow | SessionCatalogExcludedRow,
  freshness: SessionFileFreshness,
): boolean {
  return (
    Number(row.file_size) === freshness.size &&
    Number(row.file_mtime_ms) === freshness.mtimeMs &&
    Number(row.file_ctime_ms) === freshness.ctimeMs
  );
}

async function prepareCatalogReconciliation(
  db: BetterSqlite3.Database,
  sessionDir: string,
): Promise<SessionCatalogReconcilePlan | null> {
  const baseRevision = readCatalogMeta(db, "revision") || "0";
  const files = await listSessionRecordFiles(sessionDir);
  const existingRows = db.prepare("SELECT * FROM sessions").all() as
    | SessionCatalogRow[]
    | undefined;
  const existing = new Map(
    (existingRows || []).map((row) => [path.resolve(row.path), row]),
  );
  const excludedRows = db
    .prepare("SELECT * FROM excluded_files")
    .all() as SessionCatalogExcludedRow[];
  const excluded = new Map(
    excludedRows.map((row) => [path.resolve(row.path), row]),
  );
  const observed = new Map<string, SessionFileFreshness>();
  const replacements: SessionCatalogRecord[] = [];
  const removals: string[] = [];
  const excludedReplacements: Array<{
    path: string;
    freshness: SessionFileFreshness;
  }> = [];
  const excludedRemovals: string[] = [];
  const fileStats = await Promise.all(
    files.map(async (filePath) => {
      try {
        return { filePath, freshness: fileFreshness(await fs.stat(filePath)) };
      } catch {
        return null;
      }
    }),
  );

  for (const [directoryOrdinal, item] of fileStats.entries()) {
    if (!item) return null;
    const resolvedPath = path.resolve(item.filePath);
    const row = existing.get(resolvedPath);
    const excludedRow = excluded.get(resolvedPath);
    if (row && rowMatchesFreshness(row, item.freshness)) {
      observed.set(resolvedPath, item.freshness);
      if (Number(row.directory_ordinal) !== directoryOrdinal) {
        replacements.push({
          ...rowToCatalogRecord(row),
          directoryOrdinal,
        });
      }
      if (excludedRow) excludedRemovals.push(excludedRow.path);
      continue;
    }
    if (excludedRow && rowMatchesFreshness(excludedRow, item.freshness)) {
      observed.set(resolvedPath, item.freshness);
      if (row) removals.push(row.path);
      continue;
    }
    const stableRead = await readCompleteSessionRecord(item.filePath);
    if (!stableRead) return null;
    observed.set(resolvedPath, stableRead.freshness);
    if (stableRead.record) {
      replacements.push({ ...stableRead.record, directoryOrdinal });
      if (excludedRow) excludedRemovals.push(excludedRow.path);
    } else {
      if (row) removals.push(row.path);
      excludedReplacements.push({
        path: item.filePath,
        freshness: stableRead.freshness,
      });
    }
  }
  for (const row of existing.values()) {
    if (!observed.has(path.resolve(row.path))) removals.push(row.path);
  }
  for (const row of excluded.values()) {
    if (!observed.has(path.resolve(row.path))) excludedRemovals.push(row.path);
  }
  return {
    baseRevision,
    checked: files.length,
    observed,
    replacements,
    removals,
    excludedReplacements,
    excludedRemovals,
  };
}

function validateCatalogSourceSnapshotSync(
  sessionDir: string,
  observed: Map<string, SessionFileFreshness>,
): boolean {
  let files: string[];
  try {
    files = fsSync
      .readdirSync(sessionDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isSessionRecordFile(entry.name))
      .map((entry) => path.resolve(sessionDir, entry.name));
  } catch {
    return observed.size === 0;
  }
  if (files.length !== observed.size) return false;
  for (const filePath of files) {
    const expected = observed.get(filePath);
    if (!expected) return false;
    try {
      if (
        !sameFileFreshness(fileFreshness(fsSync.statSync(filePath)), expected)
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

function applyCatalogReconciliation(
  db: BetterSqlite3.Database,
  plan: SessionCatalogReconcilePlan,
): SessionCatalogRebuildResult | null {
  if ((readCatalogMeta(db, "revision") || "0") !== plan.baseRevision) {
    return null;
  }
  const remove = db.prepare("DELETE FROM sessions WHERE path = ?");
  const removeExcluded = db.prepare(
    "DELETE FROM excluded_files WHERE path = ?",
  );
  let indexed = 0;
  db.transaction(() => {
    for (const sessionPath of plan.removals) remove.run(sessionPath);
    for (const filePath of plan.excludedRemovals) removeExcluded.run(filePath);
    for (const record of plan.replacements) upsertCatalogRecord(db, record);
    for (const excluded of plan.excludedReplacements) {
      upsertExcludedFile(db, excluded.path, excluded.freshness);
    }
    setCatalogMeta(db, "checked", String(plan.checked));
    const count = db
      .prepare("SELECT COUNT(*) AS total FROM sessions")
      .get() as {
      total: number;
    };
    indexed = Number(count.total) || 0;
    setCatalogMeta(db, "indexed", String(indexed));
    setCatalogMeta(db, "reconciled_at", new Date().toISOString());
    setCatalogMeta(db, "complete", "1");
    setCatalogMeta(db, "dirty", "0");
    setCatalogMeta(db, "revision", String(Number(plan.baseRevision) + 1));
  })();
  return { checked: plan.checked, indexed };
}

async function buildSessionCatalogGeneration(
  sessionDir: string,
  dbPath: string,
): Promise<SessionCatalogRebuildResult> {
  removeDatabaseArtifacts(dbPath);
  const files = await listSessionRecordFiles(sessionDir);
  const db = openCatalogDbPath(dbPath);
  let indexed = 0;
  try {
    setCatalogMeta(db, "complete", "0");
    setCatalogMeta(db, "dirty", "1");
    setCatalogMeta(db, "revision", "0");
    setCatalogMeta(db, "checked", String(files.length));
    for (const [directoryOrdinal, filePath] of files.entries()) {
      const stableRead = await readCompleteSessionRecord(filePath);
      if (!stableRead) continue;
      if (stableRead.record) {
        upsertCatalogRecord(db, {
          ...stableRead.record,
          directoryOrdinal,
        });
        indexed += 1;
      } else {
        upsertExcludedFile(db, filePath, stableRead.freshness);
      }
    }
    setCatalogMeta(db, "indexed", String(indexed));
    setCatalogMeta(db, "rebuilt_at", new Date().toISOString());
  } finally {
    db.close();
  }
  return { checked: files.length, indexed };
}

async function publishSessionCatalogGeneration(
  sessionDir: string,
  generationPath: string,
): Promise<SessionCatalogRebuildResult> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const generationDb = openCatalogDbPath(generationPath);
    let plan: SessionCatalogReconcilePlan | null;
    try {
      plan = await prepareCatalogReconciliation(generationDb, sessionDir);
    } finally {
      generationDb.close();
    }
    if (!plan) continue;
    const published = await withCatalogWriteLock(sessionDir, () => {
      if (!validateCatalogSourceSnapshotSync(sessionDir, plan.observed)) {
        return null;
      }
      const generation = openCatalogDbPath(generationPath);
      try {
        const result = applyCatalogReconciliation(generation, plan);
        if (!result) return null;
      } finally {
        generation.close();
      }

      const livePath = catalogDbPath(sessionDir);
      let liveDb: BetterSqlite3.Database;
      try {
        liveDb = openCatalogDb(sessionDir);
      } catch {
        removeDatabaseArtifacts(livePath);
        liveDb = openCatalogDb(sessionDir);
      }
      try {
        liveDb.prepare("ATTACH DATABASE ? AS next_catalog").run(generationPath);
        try {
          liveDb.transaction(() => {
            liveDb.prepare("DELETE FROM sessions").run();
            liveDb.prepare("DELETE FROM excluded_files").run();
            liveDb.exec(`
              INSERT INTO sessions (
                path, id, name, first_message, modified, modified_ms,
                message_count, cwd, resolved_cwd, parent_session_path,
                all_messages_text, indexed_entry_count,
                indexed_last_entry_signature, indexed_entries_hash,
                directory_ordinal, file_size, file_mtime_ms, file_ctime_ms
              )
              SELECT
                path, id, name, first_message, modified, modified_ms,
                message_count, cwd, resolved_cwd, parent_session_path,
                all_messages_text, indexed_entry_count,
                indexed_last_entry_signature, indexed_entries_hash,
                directory_ordinal, file_size, file_mtime_ms, file_ctime_ms
              FROM next_catalog.sessions;
              INSERT INTO excluded_files (
                path, file_size, file_mtime_ms, file_ctime_ms
              )
              SELECT path, file_size, file_mtime_ms, file_ctime_ms
              FROM next_catalog.excluded_files;
              DELETE FROM catalog_meta;
              INSERT INTO catalog_meta(key, value)
              SELECT key, value FROM next_catalog.catalog_meta;
            `);
          })();
        } finally {
          liveDb.exec("DETACH DATABASE next_catalog");
        }
        return {
          checked: Number(readCatalogMeta(liveDb, "checked") || 0),
          indexed: Number(readCatalogMeta(liveDb, "indexed") || 0),
        };
      } finally {
        liveDb.close();
      }
    });
    if (published) {
      removeLegacyCatalogs(sessionDir);
      return published;
    }
  }
  throw new Error("Session catalog source did not stabilize");
}

async function runSessionCatalogRebuild(
  sessionDir: string,
  skipIfComplete: boolean,
): Promise<SessionCatalogRebuildResult> {
  const key = path.resolve(sessionDir);
  const existing = catalogRebuilds.get(key);
  if (existing) return await existing;
  const rebuild = (async () => {
    const { rebuildTarget } = ensureCatalogLockTargets(key);
    const release = await lockfile.lock(rebuildTarget, catalogLockOptions());
    const generationPath = path.join(
      catalogRoot(key),
      `catalog.sqlite.rebuild-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
    );
    try {
      if (skipIfComplete && hasFullCatalogState(key)) {
        return await reconcileSessionCatalog(key);
      }
      await buildSessionCatalogGeneration(key, generationPath);
      return await publishSessionCatalogGeneration(key, generationPath);
    } finally {
      removeDatabaseArtifacts(generationPath);
      await release();
    }
  })();
  catalogRebuilds.set(key, rebuild);
  try {
    return await rebuild;
  } finally {
    if (catalogRebuilds.get(key) === rebuild) catalogRebuilds.delete(key);
  }
}

export async function rebuildSessionCatalog(
  sessionDir: string,
): Promise<SessionCatalogRebuildResult> {
  return await runSessionCatalogRebuild(sessionDir, false);
}

function hasCatalogDb(sessionDir: string): boolean {
  return fsSync.existsSync(catalogDbPath(sessionDir));
}

function hasFullCatalogState(sessionDir: string): boolean {
  if (!hasCatalogDb(sessionDir)) return false;
  try {
    const db = openCatalogDb(sessionDir);
    try {
      return readCatalogMeta(db, "complete") === "1";
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

async function reconcileSessionCatalog(
  sessionDir: string,
): Promise<SessionCatalogRebuildResult> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const planningDb = openCatalogDb(sessionDir);
    let plan: SessionCatalogReconcilePlan | null;
    try {
      plan = await prepareCatalogReconciliation(planningDb, sessionDir);
    } finally {
      planningDb.close();
    }
    if (!plan) continue;
    const result = await withCatalogWriteLock(sessionDir, () => {
      if (!validateCatalogSourceSnapshotSync(sessionDir, plan.observed)) {
        return null;
      }
      const db = openCatalogDb(sessionDir);
      try {
        return applyCatalogReconciliation(db, plan);
      } finally {
        db.close();
      }
    });
    if (result) return result;
  }
  throw new Error("Session catalog source did not stabilize");
}

function queryCatalogRecords(options: {
  db: BetterSqlite3.Database;
  cwd?: string;
  offset: number;
  limit?: number;
}): { records: SessionCatalogRecord[]; total: number } | undefined {
  const resolvedCwd = normalizeSessionValue(options.cwd)
    ? path.resolve(String(options.cwd))
    : undefined;
  const where = resolvedCwd ? "WHERE resolved_cwd = ?" : "";
  const parameters = resolvedCwd ? [resolvedCwd] : [];
  return options.db.transaction(() => {
    if (
      readCatalogMeta(options.db, "complete") !== "1" ||
      readCatalogMeta(options.db, "dirty") !== "0"
    ) {
      return undefined;
    }
    const totalRow = options.db
      .prepare(`SELECT COUNT(*) AS total FROM sessions ${where}`)
      .get(...parameters) as { total: number };
    const limitClause = options.limit === undefined ? "" : "LIMIT ? OFFSET ?";
    const rows = options.db
      .prepare(
        `SELECT * FROM sessions ${where}
         ORDER BY modified_ms DESC, directory_ordinal ASC ${limitClause}`,
      )
      .all(
        ...parameters,
        ...(options.limit === undefined ? [] : [options.limit, options.offset]),
      ) as SessionCatalogRow[];
    return {
      records: rows.map(rowToCatalogRecord),
      total: Math.max(0, Number(totalRow?.total) || 0),
    };
  })();
}

export async function tryListSessionCatalogPage(options: {
  sessionDir: string;
  cwd?: string;
  offset: number;
  limit: number;
}): Promise<SessionCatalogPage | undefined> {
  if (!hasCatalogDb(options.sessionDir)) return undefined;
  try {
    const db = openCatalogDb(options.sessionDir);
    try {
      const result = queryCatalogRecords({
        db,
        cwd: options.cwd,
        offset: options.offset,
        limit: options.limit,
      });
      if (!result) return undefined;
      const { records, total } = result;
      const sessions = records.map(catalogRecordToSummary);
      const nextOffset = options.offset + sessions.length;
      const hasMore = nextOffset < total;
      return {
        sessions,
        offset: options.offset,
        limit: options.limit,
        total,
        hasMore,
        ...(hasMore ? { nextOffset } : {}),
      };
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

export async function listAllSessionCatalog(options: {
  sessionDir: string;
  cwd?: string;
}): Promise<SessionSummary[] | undefined> {
  await ensureSessionCatalog(options.sessionDir);
  if (!hasCatalogDb(options.sessionDir)) return undefined;
  try {
    const db = openCatalogDb(options.sessionDir);
    try {
      const result = queryCatalogRecords({
        db,
        cwd: options.cwd,
        offset: 0,
      });
      return result?.records.map(catalogRecordToSummary);
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

export async function ensureSessionCatalog(sessionDir: string): Promise<void> {
  if (!hasFullCatalogState(sessionDir)) {
    await runSessionCatalogRebuild(sessionDir, true);
    return;
  }
  await reconcileSessionCatalog(sessionDir);
}
