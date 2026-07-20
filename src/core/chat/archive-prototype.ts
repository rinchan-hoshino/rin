import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import BetterSqlite3 from "better-sqlite3";

export type ChatArchiveSearchLevel = "quick" | "standard" | "exhaustive";
export type ChatArchivePayloadTier = "hot" | "conversation" | "ambient";

export type ChatArchiveMessage = {
  id: string;
  chatKey: string;
  receivedAt: string;
  disposition: string;
  text: string;
  rawContent?: string;
  strippedContent?: string;
  elements?: unknown;
  quote?: unknown;
  recordJson: string;
};

export type ChatArchiveSearchResult = {
  id: string;
  tier: ChatArchivePayloadTier;
  receivedAt: string;
  score: number;
  message: ChatArchiveMessage;
};

export type ChatArchiveSearchResponse = {
  searchLevel: ChatArchiveSearchLevel;
  searchedTiers: ChatArchivePayloadTier[];
  segmentsScanned: number;
  coverage: "partial" | "complete";
  deeperSearchAvailable: boolean;
  moreResultsAvailable: boolean;
  candidateCount: number;
  candidateCountIsLowerBound: boolean;
  results: ChatArchiveSearchResult[];
};

type PrototypeOptions = {
  beforeCatalogCommit?: () => void;
  afterHeaderRead?: () => void;
  afterHotSearch?: () => void;
};

type CatalogMessageRow = {
  id: string;
  chat_key: string;
  received_at: string;
  disposition: string;
  storage_tier: ChatArchivePayloadTier;
  segment_id: string;
  payload_hash: string;
};

type StoredPayloadRow = {
  message_id: string;
  received_at: string;
  payload_json: string;
  payload_hash: string;
  search_text: string;
};

type SegmentRow = {
  id: string;
  period: string;
  sequence: number;
  tier: "conversation" | "ambient";
  file_path: string;
  row_count: number;
  checksum: string;
  state: "staging" | "committed" | "rolled_back" | "abandoned";
  owner_nonce: string;
  owner_pid: number;
  created_at: number;
};

const ACTIVE_DISPOSITIONS = new Set([
  "pending",
  "claimed",
  "processing",
  "retry",
]);

function processIsRunning(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalPayload(message: ChatArchiveMessage) {
  return JSON.stringify(message);
}

function collectSearchText(value: unknown, output: string[], depth = 0) {
  if (depth > 12 || value == null) return;
  if (typeof value === "string") {
    const text = value.trim();
    if (text) output.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSearchText(item, output, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectSearchText(item, output, depth + 1);
    }
  }
}

function buildSearchText(message: ChatArchiveMessage) {
  const output: string[] = [];
  collectSearchText(message.text, output);
  collectSearchText(message.rawContent, output);
  collectSearchText(message.strippedContent, output);
  collectSearchText(message.elements, output);
  collectSearchText(message.quote, output);
  collectSearchText(message.recordJson, output);
  try {
    collectSearchText(JSON.parse(message.recordJson), output);
  } catch {}
  return [...new Set(output)].join("\n");
}

function monthPeriod(timestamp: string) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid_received_at");
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function normalizeMessage(message: ChatArchiveMessage): ChatArchiveMessage {
  const normalized = {
    ...message,
    id: String(message.id || "").trim(),
    chatKey: String(message.chatKey || "").trim(),
    receivedAt: String(message.receivedAt || "").trim(),
    disposition: String(message.disposition || "").trim(),
    text: String(message.text || ""),
    recordJson: String(message.recordJson || ""),
  };
  if (!normalized.id || !normalized.chatKey || !normalized.receivedAt) {
    throw new Error("chat_archive_message_identity_required");
  }
  monthPeriod(normalized.receivedAt);
  return normalized;
}

function initializePayloadSchema(
  db: BetterSqlite3.Database,
  table = "payloads",
) {
  const ftsTable = `${table}_fts`;
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      rowid INTEGER PRIMARY KEY,
      message_id TEXT NOT NULL UNIQUE,
      received_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      search_text TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS ${ftsTable} USING fts5(
      message_id UNINDEXED,
      search_text,
      content = '${table}',
      content_rowid = 'rowid',
      tokenize = 'trigram'
    );

    CREATE TRIGGER IF NOT EXISTS ${table}_fts_insert AFTER INSERT ON ${table} BEGIN
      INSERT INTO ${ftsTable}(rowid, message_id, search_text)
      VALUES (new.rowid, new.message_id, new.search_text);
    END;

    CREATE TRIGGER IF NOT EXISTS ${table}_fts_delete AFTER DELETE ON ${table} BEGIN
      INSERT INTO ${ftsTable}(${ftsTable}, rowid, message_id, search_text)
      VALUES ('delete', old.rowid, old.message_id, old.search_text);
    END;

    CREATE TRIGGER IF NOT EXISTS ${table}_fts_update AFTER UPDATE ON ${table} BEGIN
      INSERT INTO ${ftsTable}(${ftsTable}, rowid, message_id, search_text)
      VALUES ('delete', old.rowid, old.message_id, old.search_text);
      INSERT INTO ${ftsTable}(rowid, message_id, search_text)
      VALUES (new.rowid, new.message_id, new.search_text);
    END;
  `);
}

function initializeCatalog(db: BetterSqlite3.Database) {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_headers (
      id TEXT PRIMARY KEY,
      chat_key TEXT NOT NULL,
      received_at TEXT NOT NULL,
      disposition TEXT NOT NULL,
      storage_tier TEXT NOT NULL CHECK(storage_tier IN ('hot', 'conversation', 'ambient')),
      segment_id TEXT NOT NULL DEFAULT '',
      payload_hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS archive_segments (
      id TEXT PRIMARY KEY,
      period TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      tier TEXT NOT NULL CHECK(tier IN ('conversation', 'ambient')),
      file_path TEXT NOT NULL UNIQUE,
      row_count INTEGER NOT NULL DEFAULT 0,
      checksum TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL CHECK(state IN ('staging', 'committed', 'rolled_back', 'abandoned')),
      owner_nonce TEXT NOT NULL,
      owner_pid INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(period, sequence)
    );
  `);
  initializePayloadSchema(db, "hot_payloads");
}

function queryPayloadRows(
  db: BetterSqlite3.Database,
  table: string,
  query: string,
  limit: number,
): Array<StoredPayloadRow & { rank: number }> {
  const normalized = query.trim();
  if (!normalized) return [];
  const likeRows = () =>
    db
      .prepare(
        `SELECT message_id, received_at, payload_json, payload_hash, search_text, 0 AS rank
         FROM ${table}
         WHERE search_text LIKE ?
         ORDER BY received_at DESC, message_id ASC
         LIMIT ?`,
      )
      .all(`%${normalized}%`, limit) as Array<
      StoredPayloadRow & { rank: number }
    >;
  if ([...normalized].length < 3) return likeRows();
  const ftsTable = `${table}_fts`;
  const terms = normalized
    .split(/\s+/g)
    .map((term) => term.trim())
    .filter((term) => [...term].length >= 3);
  if (!terms.length) return likeRows();
  const ftsQuery = terms
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(" AND ");
  return db
    .prepare(
      `SELECT p.message_id, p.received_at, p.payload_json, p.payload_hash,
              p.search_text, 0 AS rank
       FROM ${ftsTable}
       JOIN ${table} p ON p.rowid = ${ftsTable}.rowid
       WHERE ${ftsTable} MATCH ?
       ORDER BY p.received_at DESC, p.message_id ASC
       LIMIT ?`,
    )
    .all(ftsQuery, limit) as Array<StoredPayloadRow & { rank: number }>;
}

function parseStoredPayload(
  row: Pick<StoredPayloadRow, "payload_json" | "payload_hash">,
) {
  if (sha256(row.payload_json) !== row.payload_hash) {
    throw new Error("chat_archive_payload_hash_mismatch");
  }
  return JSON.parse(row.payload_json) as ChatArchiveMessage;
}

export class ChatArchivePrototype {
  readonly root: string;
  readonly catalogPath: string;
  readonly options: PrototypeOptions;

  constructor(root: string, options: PrototypeOptions = {}) {
    this.root = path.resolve(root);
    this.catalogPath = path.join(this.root, "chat-archive-prototype.sqlite");
    this.options = options;
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const db = new BetterSqlite3(this.catalogPath);
    try {
      initializeCatalog(db);
    } finally {
      db.close();
    }
    this.reconcileAbandonedSegments();
  }

  private openCatalog() {
    const db = new BetterSqlite3(this.catalogPath);
    db.pragma("foreign_keys = ON");
    return db;
  }

  reconcileAbandonedSegments(options: { olderThanMs?: number } = {}) {
    const olderThanMs = Math.max(
      0,
      Number(options.olderThanMs ?? 60 * 60 * 1_000) || 0,
    );
    const cutoff = Date.now() - olderThanMs;
    const db = this.openCatalog();
    try {
      const abandoned = db
        .transaction(() => {
          const rows = db
            .prepare(
              `SELECT * FROM archive_segments
             WHERE state = 'staging' AND created_at <= ?
             ORDER BY created_at ASC`,
            )
            .all(cutoff) as SegmentRow[];
          const abandon = db.prepare(
            `UPDATE archive_segments SET state = 'abandoned'
           WHERE id = ? AND state = 'staging' AND owner_nonce = ?`,
          );
          return rows.filter(
            (row) =>
              !processIsRunning(row.owner_pid) &&
              abandon.run(row.id, row.owner_nonce).changes === 1,
          );
        })
        .immediate();
      for (const row of abandoned) {
        for (const candidate of [
          row.file_path,
          `${row.file_path}.staging-${row.owner_nonce}`,
        ]) {
          if (fs.existsSync(candidate)) fs.rmSync(candidate, { force: true });
        }
      }
      return { removed: abandoned.length };
    } finally {
      db.close();
    }
  }

  ingestHot(message: ChatArchiveMessage) {
    const normalized = normalizeMessage(message);
    const payloadJson = canonicalPayload(normalized);
    const payloadHash = sha256(payloadJson);
    const searchText = buildSearchText(normalized);
    const db = this.openCatalog();
    try {
      const existing = db
        .prepare(
          "SELECT storage_tier, payload_hash FROM message_headers WHERE id = ?",
        )
        .get(normalized.id) as
        | { storage_tier: ChatArchivePayloadTier; payload_hash: string }
        | undefined;
      if (existing && existing.storage_tier !== "hot") {
        if (existing.payload_hash === payloadHash) {
          return { id: normalized.id, payloadHash };
        }
        throw new Error("chat_archive_reingest_requires_restore");
      }
      db.transaction(() => {
        db.prepare(
          `INSERT INTO message_headers(
             id, chat_key, received_at, disposition, storage_tier, segment_id, payload_hash
           ) VALUES (?, ?, ?, ?, 'hot', '', ?)
           ON CONFLICT(id) DO UPDATE SET
             chat_key = excluded.chat_key,
             received_at = excluded.received_at,
             disposition = excluded.disposition,
             storage_tier = 'hot',
             segment_id = '',
             payload_hash = excluded.payload_hash`,
        ).run(
          normalized.id,
          normalized.chatKey,
          normalized.receivedAt,
          normalized.disposition,
          payloadHash,
        );
        db.prepare(
          `INSERT INTO hot_payloads(
             message_id, received_at, payload_json, payload_hash, search_text
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(message_id) DO UPDATE SET
             received_at = excluded.received_at,
             payload_json = excluded.payload_json,
             payload_hash = excluded.payload_hash,
             search_text = excluded.search_text`,
        ).run(
          normalized.id,
          normalized.receivedAt,
          payloadJson,
          payloadHash,
          searchText,
        );
      })();
      return { id: normalized.id, payloadHash };
    } finally {
      db.close();
    }
  }

  archiveHotMessages(messageIds: string[], tier: "conversation" | "ambient") {
    const ids = [
      ...new Set(messageIds.map((id) => String(id).trim()).filter(Boolean)),
    ];
    if (!ids.length) throw new Error("chat_archive_messages_required");
    const db = this.openCatalog();
    let stagingPath = "";
    let finalPath = "";
    let reservationId = "";
    const ownerNonce = randomUUID();
    let catalogCommitted = false;
    try {
      const placeholders = ids.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT h.id, h.chat_key, h.received_at, h.disposition,
                  h.storage_tier, h.segment_id, h.payload_hash,
                  p.message_id, p.payload_json, p.search_text
           FROM message_headers h
           JOIN hot_payloads p ON p.message_id = h.id
           WHERE h.id IN (${placeholders})`,
        )
        .all(...ids) as Array<
        CatalogMessageRow &
          Pick<StoredPayloadRow, "message_id" | "payload_json" | "search_text">
      >;
      if (rows.length !== ids.length)
        throw new Error("chat_archive_hot_payload_missing");
      if (rows.some((row) => ACTIVE_DISPOSITIONS.has(row.disposition))) {
        throw new Error("chat_archive_message_still_operational");
      }
      const periods = [
        ...new Set(rows.map((row) => monthPeriod(row.received_at))),
      ];
      if (periods.length !== 1)
        throw new Error("chat_archive_single_period_required");
      const period = periods[0]!;
      const reservation = db
        .transaction(() => {
          const sequenceRow = db
            .prepare(
              "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM archive_segments WHERE period = ?",
            )
            .get(period) as { sequence: number };
          const sequence = Number(sequenceRow.sequence || 0) + 1;
          const [year, month] = period.split("-");
          const segmentDir = path.join(this.root, "archive", year!, month!);
          const segmentName = `messages-${String(sequence).padStart(4, "0")}.sqlite`;
          const filePath = path.join(segmentDir, segmentName);
          const segmentId = `${period}-${String(sequence).padStart(4, "0")}`;
          db.prepare(
            `INSERT INTO archive_segments(
             id, period, sequence, tier, file_path, state,
             owner_nonce, owner_pid, created_at
           ) VALUES (?, ?, ?, ?, ?, 'staging', ?, ?, ?)`,
          ).run(
            segmentId,
            period,
            sequence,
            tier,
            filePath,
            ownerNonce,
            process.pid,
            Date.now(),
          );
          return { sequence, segmentDir, filePath, segmentId };
        })
        .immediate();
      const { segmentDir, segmentId } = reservation;
      reservationId = segmentId;
      finalPath = reservation.filePath;
      fs.mkdirSync(segmentDir, { recursive: true, mode: 0o700 });
      stagingPath = `${finalPath}.staging-${ownerNonce}`;

      const segmentDb = new BetterSqlite3(stagingPath);
      try {
        segmentDb.pragma("journal_mode = DELETE");
        segmentDb.pragma("synchronous = FULL");
        initializePayloadSchema(segmentDb);
        segmentDb.exec(`
          CREATE TABLE segment_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
        `);
        const insert = segmentDb.prepare(
          `INSERT INTO payloads(
             message_id, received_at, payload_json, payload_hash, search_text
           ) VALUES (?, ?, ?, ?, ?)`,
        );
        segmentDb.transaction(() => {
          for (const row of rows) {
            insert.run(
              row.id,
              row.received_at,
              row.payload_json,
              row.payload_hash,
              row.search_text,
            );
          }
          segmentDb
            .prepare("INSERT INTO segment_metadata(key, value) VALUES (?, ?)")
            .run("schema_version", "1");
          segmentDb
            .prepare("INSERT INTO segment_metadata(key, value) VALUES (?, ?)")
            .run("segment_id", segmentId);
          segmentDb
            .prepare("INSERT INTO segment_metadata(key, value) VALUES (?, ?)")
            .run("tier", tier);
        })();
        const integrity = segmentDb.pragma("integrity_check", { simple: true });
        if (integrity !== "ok")
          throw new Error("chat_archive_segment_integrity_failed");
        const count = segmentDb
          .prepare("SELECT COUNT(*) AS count FROM payloads")
          .get() as { count: number };
        if (Number(count.count) !== rows.length) {
          throw new Error("chat_archive_segment_count_mismatch");
        }
        for (const row of segmentDb
          .prepare("SELECT payload_json, payload_hash FROM payloads")
          .iterate() as Iterable<{
          payload_json: string;
          payload_hash: string;
        }>) {
          if (sha256(row.payload_json) !== row.payload_hash) {
            throw new Error("chat_archive_segment_hash_mismatch");
          }
        }
      } finally {
        segmentDb.close();
      }
      fs.linkSync(stagingPath, finalPath);
      fs.unlinkSync(stagingPath);
      stagingPath = "";
      const checksum = sha256(fs.readFileSync(finalPath));
      fs.chmodSync(finalPath, 0o400);
      this.options.beforeCatalogCommit?.();

      db.transaction(() => {
        const commitSegment = db
          .prepare(
            `UPDATE archive_segments
           SET row_count = ?, checksum = ?, state = 'committed'
           WHERE id = ? AND state = 'staging' AND owner_nonce = ?`,
          )
          .run(rows.length, checksum, segmentId, ownerNonce);
        if (commitSegment.changes !== 1) {
          throw new Error("chat_archive_segment_reservation_lost");
        }
        const updateHeader = db.prepare(
          `UPDATE message_headers
           SET storage_tier = ?, segment_id = ?
           WHERE id = ? AND storage_tier = 'hot' AND payload_hash = ?`,
        );
        const deletePayload = db.prepare(
          "DELETE FROM hot_payloads WHERE message_id = ? AND payload_hash = ?",
        );
        for (const row of rows) {
          if (
            updateHeader.run(tier, segmentId, row.id, row.payload_hash)
              .changes !== 1
          ) {
            throw new Error("chat_archive_header_compare_and_swap_failed");
          }
          if (deletePayload.run(row.id, row.payload_hash).changes !== 1) {
            throw new Error("chat_archive_hot_delete_failed");
          }
        }
      })();
      catalogCommitted = true;
      return {
        segmentId,
        filePath: finalPath,
        tier,
        rowCount: rows.length,
        checksum,
      };
    } catch (error) {
      if (stagingPath && fs.existsSync(stagingPath))
        fs.rmSync(stagingPath, { force: true });
      let ownedReservation = false;
      if (!catalogCommitted && reservationId) {
        ownedReservation =
          db
            .prepare(
              `UPDATE archive_segments SET state = 'abandoned'
               WHERE id = ? AND state = 'staging' AND owner_nonce = ?`,
            )
            .run(reservationId, ownerNonce).changes === 1;
      }
      if (ownedReservation && finalPath && fs.existsSync(finalPath)) {
        fs.rmSync(finalPath, { force: true });
      }
      throw error;
    } finally {
      db.close();
    }
  }

  rollbackSegment(segmentId: string) {
    const db = this.openCatalog();
    try {
      const segment = db
        .prepare(
          "SELECT * FROM archive_segments WHERE id = ? AND state = 'committed'",
        )
        .get(segmentId) as SegmentRow | undefined;
      if (!segment) throw new Error("chat_archive_segment_not_committed");
      if (!fs.existsSync(segment.file_path))
        throw new Error("chat_archive_segment_missing");
      if (sha256(fs.readFileSync(segment.file_path)) !== segment.checksum) {
        throw new Error("chat_archive_segment_checksum_mismatch");
      }
      const segmentDb = new BetterSqlite3(segment.file_path, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        const rows = segmentDb
          .prepare("SELECT * FROM payloads")
          .all() as StoredPayloadRow[];
        db.transaction(() => {
          const restore = db.prepare(
            `INSERT INTO hot_payloads(
               message_id, received_at, payload_json, payload_hash, search_text
             ) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(message_id) DO UPDATE SET
               received_at = excluded.received_at,
               payload_json = excluded.payload_json,
               payload_hash = excluded.payload_hash,
               search_text = excluded.search_text`,
          );
          const updateHeader = db.prepare(
            `UPDATE message_headers
             SET storage_tier = 'hot', segment_id = ''
             WHERE id = ? AND segment_id = ? AND payload_hash = ?`,
          );
          for (const row of rows) {
            if (sha256(row.payload_json) !== row.payload_hash) {
              throw new Error("chat_archive_payload_hash_mismatch");
            }
            restore.run(
              row.message_id,
              row.received_at,
              row.payload_json,
              row.payload_hash,
              row.search_text,
            );
            if (
              updateHeader.run(row.message_id, segmentId, row.payload_hash)
                .changes !== 1
            ) {
              throw new Error("chat_archive_rollback_header_mismatch");
            }
          }
          db.prepare(
            "UPDATE archive_segments SET state = 'rolled_back' WHERE id = ?",
          ).run(segmentId);
        })();
        return { segmentId, restored: rows.length };
      } finally {
        segmentDb.close();
      }
    } finally {
      db.close();
    }
  }

  getMessage(messageId: string): ChatArchiveMessage | null {
    const db = this.openCatalog();
    try {
      return db.transaction(() => {
        const header = db
          .prepare("SELECT * FROM message_headers WHERE id = ?")
          .get(messageId) as CatalogMessageRow | undefined;
        if (!header) return null;
        this.options.afterHeaderRead?.();
        let row:
          | Pick<StoredPayloadRow, "payload_json" | "payload_hash">
          | undefined;
        if (header.storage_tier === "hot") {
          row = db
            .prepare(
              "SELECT payload_json, payload_hash FROM hot_payloads WHERE message_id = ?",
            )
            .get(messageId) as typeof row;
        } else {
          const segment = db
            .prepare(
              "SELECT * FROM archive_segments WHERE id = ? AND state = 'committed'",
            )
            .get(header.segment_id) as SegmentRow | undefined;
          if (!segment || !fs.existsSync(segment.file_path)) {
            throw new Error("chat_archive_segment_missing");
          }
          const segmentDb = new BetterSqlite3(segment.file_path, {
            readonly: true,
            fileMustExist: true,
          });
          try {
            row = segmentDb
              .prepare(
                "SELECT payload_json, payload_hash FROM payloads WHERE message_id = ?",
              )
              .get(messageId) as typeof row;
          } finally {
            segmentDb.close();
          }
        }
        if (!row || row.payload_hash !== header.payload_hash) {
          throw new Error("chat_archive_payload_locator_mismatch");
        }
        if (sha256(row.payload_json) !== row.payload_hash) {
          throw new Error("chat_archive_payload_hash_mismatch");
        }
        return JSON.parse(row.payload_json) as ChatArchiveMessage;
      })();
    } finally {
      db.close();
    }
  }

  search(
    query: string,
    options: {
      searchLevel: ChatArchiveSearchLevel;
      limit?: number;
      offset?: number;
    },
  ): ChatArchiveSearchResponse {
    const level = options.searchLevel;
    const tiers: ChatArchivePayloadTier[] =
      level === "quick"
        ? ["hot"]
        : level === "standard"
          ? ["hot", "conversation"]
          : ["hot", "conversation", "ambient"];
    const limit = Math.max(1, Math.min(200, Number(options.limit || 20) || 20));
    const offset = Math.max(
      0,
      Math.min(10_000, Number(options.offset || 0) || 0),
    );
    const fetchLimit = offset + limit + 1;
    const db = this.openCatalog();
    try {
      return db.transaction((): ChatArchiveSearchResponse => {
        const candidates: ChatArchiveSearchResult[] = [];
        let sourceTruncated = false;
        if (tiers.includes("hot")) {
          const rows = queryPayloadRows(db, "hot_payloads", query, fetchLimit);
          sourceTruncated ||= rows.length === fetchLimit;
          this.options.afterHotSearch?.();
          for (const row of rows) {
            candidates.push({
              id: row.message_id,
              tier: "hot",
              receivedAt: row.received_at,
              score: -Number(row.rank || 0),
              message: parseStoredPayload(row),
            });
          }
        }
        const archiveTiers = tiers.filter(
          (tier): tier is "conversation" | "ambient" => tier !== "hot",
        );
        const segments = archiveTiers.length
          ? (db
              .prepare(
                `SELECT * FROM archive_segments
               WHERE state = 'committed' AND tier IN (${archiveTiers.map(() => "?").join(",")})
               ORDER BY period DESC, sequence DESC`,
              )
              .all(...archiveTiers) as SegmentRow[])
          : [];
        for (const segment of segments) {
          if (!fs.existsSync(segment.file_path)) {
            throw new Error(`chat_archive_segment_missing:${segment.id}`);
          }
          const segmentDb = new BetterSqlite3(segment.file_path, {
            readonly: true,
            fileMustExist: true,
          });
          try {
            const rows = queryPayloadRows(
              segmentDb,
              "payloads",
              query,
              fetchLimit,
            );
            sourceTruncated ||= rows.length === fetchLimit;
            for (const row of rows) {
              candidates.push({
                id: row.message_id,
                tier: segment.tier,
                receivedAt: row.received_at,
                score: -Number(row.rank || 0),
                message: parseStoredPayload(row),
              });
            }
          } finally {
            segmentDb.close();
          }
        }
        const deduped = new Map<string, ChatArchiveSearchResult>();
        for (const candidate of candidates) {
          const current = deduped.get(candidate.id);
          if (!current || candidate.score > current.score) {
            deduped.set(candidate.id, candidate);
          }
        }
        const ranked = [...deduped.values()].sort((left, right) => {
          const scoreDiff = right.score - left.score;
          if (scoreDiff) return scoreDiff;
          const timestampDiff = right.receivedAt.localeCompare(left.receivedAt);
          if (timestampDiff) return timestampDiff;
          return left.id.localeCompare(right.id);
        });
        const results = ranked.slice(offset, offset + limit);
        return {
          searchLevel: level,
          searchedTiers: tiers,
          segmentsScanned: segments.length,
          coverage: level === "exhaustive" ? "complete" : "partial",
          deeperSearchAvailable: level !== "exhaustive",
          moreResultsAvailable:
            sourceTruncated || ranked.length > offset + limit,
          candidateCount: ranked.length,
          candidateCountIsLowerBound: sourceTruncated,
          results,
        };
      })();
    } finally {
      db.close();
    }
  }
}
