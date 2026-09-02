import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";

import { coreDataPath } from "../data-layout.js";
import type {
  NerveEmitResult,
  NerveQueueCounts,
  NerveStoredStimulus,
  NerveStimulusInput,
} from "./contracts.js";

type StimulusRow = {
  id: string;
  producer: string;
  sensation: string;
  body: string;
  context_json: string | null;
  state: NerveStoredStimulus["state"];
  created_at: string;
};

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(",")}}`;
}

function exactNonblank(value: unknown, error: string) {
  const text = String(value ?? "");
  if (!text.trim() || text !== text.trim()) throw new Error(error);
  return text;
}

function normalizeInput(input: NerveStimulusInput) {
  const id =
    input.id === undefined
      ? randomUUID()
      : exactNonblank(input.id, "nerve_stimulus_id_invalid");
  const producer = exactNonblank(
    input.producer,
    "nerve_stimulus_producer_required",
  );
  const sensation = exactNonblank(
    input.sensation,
    "nerve_stimulus_sensation_required",
  );
  const body = String(input.body ?? "");
  const context = input.context;
  const payloadHash = createHash("sha256")
    .update(stableSerialize({ producer, sensation, body, context }))
    .digest("hex");
  return { id, producer, sensation, body, context, payloadHash };
}

export function nerveDatabasePath(agentDir: string) {
  return coreDataPath(agentDir, "nerve", "nerve.sqlite");
}

export function openNerveStore(agentDir: string) {
  const filePath = nerveDatabasePath(agentDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new BetterSqlite3(filePath);
  db.pragma("busy_timeout = 120000");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS stimuli (
      id TEXT PRIMARY KEY,
      payload_hash TEXT NOT NULL,
      producer TEXT NOT NULL,
      sensation TEXT NOT NULL,
      body TEXT NOT NULL,
      context_json TEXT,
      state TEXT NOT NULL CHECK (state IN ('queued', 'inflight', 'delivered')),
      created_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      delivered_at TEXT
    );
    CREATE INDEX IF NOT EXISTS stimuli_dispatch
      ON stimuli(state, created_at, id);
  `);
  db.prepare(
    `UPDATE stimuli SET state = 'queued' WHERE state = 'inflight'`,
  ).run();
  let closed = false;

  const rowToStimulus = (row: StimulusRow): NerveStoredStimulus => ({
    id: String(row.id),
    producer: String(row.producer),
    sensation: String(row.sensation),
    body: String(row.body),
    ...(row.context_json
      ? { context: JSON.parse(String(row.context_json)) }
      : {}),
    createdAt: String(row.created_at),
    state: row.state,
  });

  return {
    path: filePath,
    enqueue(input: NerveStimulusInput): NerveEmitResult {
      const normalized = normalizeInput(input);
      const existing = db
        .prepare(`SELECT payload_hash, state FROM stimuli WHERE id = ?`)
        .get(normalized.id) as
        | { payload_hash: string; state: string }
        | undefined;
      if (existing) {
        if (existing.payload_hash !== normalized.payloadHash) {
          throw new Error(`nerve_stimulus_id_conflict:${normalized.id}`);
        }
        return { stimulusId: normalized.id, status: "duplicate" };
      }
      db.prepare(
        `INSERT INTO stimuli (
          id, payload_hash, producer, sensation, body, context_json,
          state, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
      ).run(
        normalized.id,
        normalized.payloadHash,
        normalized.producer,
        normalized.sensation,
        normalized.body,
        normalized.context === undefined
          ? null
          : JSON.stringify(normalized.context),
        new Date().toISOString(),
      );
      return { stimulusId: normalized.id, status: "queued" };
    },
    claimNext(): NerveStoredStimulus | null {
      const claim = db.transaction(() => {
        const row = db
          .prepare(
            `SELECT * FROM stimuli
             WHERE state = 'queued'
             ORDER BY created_at ASC, id ASC
             LIMIT 1`,
          )
          .get() as StimulusRow | undefined;
        if (!row) return null;
        db.prepare(
          `UPDATE stimuli
           SET state = 'inflight', attempt_count = attempt_count + 1,
               last_error = NULL
           WHERE id = ? AND state = 'queued'`,
        ).run(row.id);
        return { ...row, state: "inflight" as const };
      });
      const row = claim();
      return row ? rowToStimulus(row) : null;
    },
    markDelivered(id: string) {
      db.prepare(
        `UPDATE stimuli
         SET state = 'delivered', delivered_at = ?, last_error = NULL
         WHERE id = ?`,
      ).run(new Date().toISOString(), id);
    },
    requeue(id: string, error?: unknown) {
      db.prepare(
        `UPDATE stimuli SET state = 'queued', last_error = ? WHERE id = ?`,
      ).run(
        String(error instanceof Error ? error.message : (error ?? "")).slice(
          0,
          4_000,
        ),
        id,
      );
    },
    counts(): NerveQueueCounts {
      const rows = db
        .prepare(`SELECT state, COUNT(*) AS count FROM stimuli GROUP BY state`)
        .all() as Array<{ state: keyof NerveQueueCounts; count: number }>;
      const counts: NerveQueueCounts = {
        queued: 0,
        inflight: 0,
        delivered: 0,
      };
      for (const row of rows) counts[row.state] = Number(row.count) || 0;
      return counts;
    },
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

export type NerveStore = ReturnType<typeof openNerveStore>;
