import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";

import { coreDataPath } from "../data-layout.js";
import type {
  NerveEmitResult,
  NerveStimulusInput,
  NerveStimulusState,
  NerveStoredStimulus,
} from "./contracts.js";

type StimulusRow = {
  id: string;
  dedupe_key: string | null;
  body: string;
  body_hash: string;
  state: NerveStimulusState;
  created_at: string;
  delivered_at: string | null;
  last_error: string | null;
};

type LegacyStimulusRow = {
  id: string;
  body: string;
  state: NerveStimulusState;
  created_at: string;
  delivered_at: string | null;
  last_error: string | null;
};

function exactOptionalKey(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  const text = String(value);
  if (!text.trim() || text !== text.trim()) {
    throw new Error("nerve_dedupe_key_invalid");
  }
  return text;
}

function requiredBody(value: unknown) {
  const text = typeof value === "string" ? value : "";
  if (!text.trim()) throw new Error("nerve_body_required");
  return text;
}

function hashBody(body: string) {
  return createHash("sha256").update(body).digest("hex");
}

function rowToStimulus(row: StimulusRow): NerveStoredStimulus {
  return {
    id: row.id,
    ...(row.dedupe_key ? { dedupeKey: row.dedupe_key } : {}),
    body: row.body,
    bodyHash: row.body_hash,
    state: row.state,
    createdAt: row.created_at,
    ...(row.delivered_at ? { deliveredAt: row.delivered_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}

function createSchema(db: BetterSqlite3.Database, table = "stimuli") {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT PRIMARY KEY,
      dedupe_key TEXT UNIQUE,
      body TEXT NOT NULL,
      body_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued', 'inflight', 'delivered')),
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      last_error TEXT
    )
  `);
}

function migrateLegacySchema(db: BetterSqlite3.Database) {
  const table = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stimuli'",
    )
    .get();
  if (!table) {
    createSchema(db);
    return;
  }
  const columns = db.prepare("PRAGMA table_info(stimuli)").all() as Array<{
    name: string;
  }>;
  if (columns.some((column) => column.name === "dedupe_key")) return;

  db.transaction(() => {
    createSchema(db, "stimuli_next");
    const rows = db
      .prepare(
        "SELECT id, body, state, created_at, delivered_at, last_error FROM stimuli ORDER BY created_at, id",
      )
      .all() as LegacyStimulusRow[];
    const insert = db.prepare(`
      INSERT INTO stimuli_next (
        id, dedupe_key, body, body_hash, state, created_at, delivered_at, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      insert.run(
        row.id,
        row.id,
        row.body,
        hashBody(row.body),
        row.state,
        row.created_at,
        row.delivered_at,
        row.last_error,
      );
    }
    db.exec("DROP TABLE stimuli; ALTER TABLE stimuli_next RENAME TO stimuli;");
  })();
}

export type NerveStore = ReturnType<typeof openNerveStore>;

export function openNerveStore(agentDir: string) {
  const databasePath = coreDataPath(agentDir, "nerve", "nerve.sqlite");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new BetterSqlite3(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  migrateLegacySchema(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_nerve_stimuli_state_created
      ON stimuli(state, created_at, id)
  `);
  db.prepare(
    "UPDATE stimuli SET state = 'queued' WHERE state = 'inflight'",
  ).run();
  let closed = false;

  const enqueue = (input: NerveStimulusInput): NerveEmitResult => {
    const dedupeKey = exactOptionalKey(input.dedupeKey);
    const body = requiredBody(input.body);
    const bodyHash = hashBody(body);
    if (dedupeKey) {
      const existing = db
        .prepare("SELECT * FROM stimuli WHERE dedupe_key = ?")
        .get(dedupeKey) as StimulusRow | undefined;
      if (existing) {
        if (existing.body_hash !== bodyHash) {
          throw new Error(`nerve_dedupe_key_conflict:${dedupeKey}`);
        }
        return { stimulusId: existing.id, status: "duplicate" };
      }
    }

    const id = randomUUID();
    db.prepare(
      `INSERT INTO stimuli (
        id, dedupe_key, body, body_hash, state, created_at
      ) VALUES (?, ?, ?, ?, 'queued', ?)`,
    ).run(id, dedupeKey ?? null, body, bodyHash, new Date().toISOString());
    return { stimulusId: id, status: "queued" };
  };

  const claimNext = () =>
    db.transaction(() => {
      const row = db
        .prepare(
          "SELECT * FROM stimuli WHERE state = 'queued' ORDER BY created_at, id LIMIT 1",
        )
        .get() as StimulusRow | undefined;
      if (!row) return undefined;
      db.prepare(
        "UPDATE stimuli SET state = 'inflight', last_error = NULL WHERE id = ?",
      ).run(row.id);
      return rowToStimulus({ ...row, state: "inflight" as const });
    })();

  const markDelivered = (id: string) => {
    db.prepare(
      "UPDATE stimuli SET state = 'delivered', delivered_at = ?, last_error = NULL WHERE id = ?",
    ).run(new Date().toISOString(), id);
  };

  const requeue = (id: string, error: unknown) => {
    db.prepare(
      "UPDATE stimuli SET state = 'queued', last_error = ? WHERE id = ?",
    ).run(error instanceof Error ? error.message : String(error), id);
  };

  const counts = () => {
    const result = { queued: 0, inflight: 0, delivered: 0 };
    const rows = db
      .prepare("SELECT state, COUNT(*) AS count FROM stimuli GROUP BY state")
      .all() as Array<{ state: NerveStimulusState; count: number }>;
    for (const row of rows) result[row.state] = Number(row.count);
    return result;
  };

  const close = () => {
    if (closed) return;
    closed = true;
    db.close();
  };

  return {
    databasePath: path.resolve(databasePath),
    enqueue,
    claimNext,
    markDelivered,
    requeue,
    counts,
    close,
  };
}
