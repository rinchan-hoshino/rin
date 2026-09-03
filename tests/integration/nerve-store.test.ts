import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import BetterSqlite3 from "better-sqlite3";

import { importBuiltModule } from "../support/import-built-module.js";

const nerveStore = await importBuiltModule<
  typeof import("../../src/core/nerve/store.js")
>("dist/core/nerve/store.js");

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "rin-nerve-store-"));
}

const stimulus = {
  dedupeKey: "opaque-key-1",
  body: "hello",
};

test("nerve store durably owns opaque idempotent input and recovery", async () => {
  const agentDir = await tempDir();
  const store = nerveStore.openNerveStore(agentDir);
  try {
    const accepted = store.enqueue(stimulus);
    assert.equal(accepted.status, "queued");
    assert.notEqual(accepted.stimulusId, stimulus.dedupeKey);
    assert.deepEqual(store.enqueue(stimulus), {
      stimulusId: accepted.stimulusId,
      status: "duplicate",
    });
    assert.throws(
      () => store.enqueue({ ...stimulus, body: "different" }),
      /nerve_dedupe_key_conflict/,
    );

    const claimed = store.claimNext();
    assert.equal(claimed?.id, accepted.stimulusId);
    assert.equal(claimed?.dedupeKey, stimulus.dedupeKey);
    assert.equal(claimed?.body, "hello");
    assert.equal(claimed?.state, "inflight");
    assert.equal(store.counts().inflight, 1);

    store.close();
    const reopened = nerveStore.openNerveStore(agentDir);
    try {
      assert.equal(reopened.counts().queued, 1);
      const recovered = reopened.claimNext();
      assert.equal(recovered?.id, accepted.stimulusId);
      reopened.markDelivered(accepted.stimulusId);
      const inspection = new BetterSqlite3(
        path.join(agentDir, "data", "core", "nerve", "nerve.sqlite"),
        { readonly: true },
      );
      try {
        assert.equal(
          inspection
            .prepare("SELECT body FROM stimuli WHERE id = ?")
            .get(accepted.stimulusId).body,
          "",
        );
      } finally {
        inspection.close();
      }
      assert.deepEqual(reopened.counts(), {
        queued: 0,
        inflight: 0,
        delivered: 1,
      });
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("nerve store migrates legacy envelopes without retaining source semantics", async () => {
  const agentDir = await tempDir();
  const databasePath = path.join(
    agentDir,
    "data",
    "core",
    "nerve",
    "nerve.sqlite",
  );
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  const legacy = new BetterSqlite3(databasePath);
  legacy.exec(`
    CREATE TABLE stimuli (
      id TEXT PRIMARY KEY,
      producer TEXT NOT NULL,
      sensation TEXT NOT NULL,
      body TEXT NOT NULL,
      context_json TEXT,
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      delivered_at TEXT
    );
    INSERT INTO stimuli VALUES (
      'legacy-message', 'owner-chat', 'owner_message', 'old body',
      '{"trust":"OWNER"}', 'legacy-hash', 'delivered',
      '2026-09-03T00:00:00.000Z', 0, NULL, '2026-09-03T00:00:01.000Z'
    );
  `);
  legacy.close();

  const store = nerveStore.openNerveStore(agentDir);
  store.close();

  const migrated = new BetterSqlite3(databasePath, { readonly: true });
  try {
    const columns = migrated
      .prepare("PRAGMA table_info(stimuli)")
      .all()
      .map((row: any) => row.name);
    assert.deepEqual(columns, [
      "id",
      "dedupe_key",
      "body",
      "body_hash",
      "state",
      "created_at",
      "delivered_at",
      "last_error",
    ]);
    const row = migrated.prepare("SELECT * FROM stimuli").get() as Record<
      string,
      unknown
    >;
    assert.equal(row.id, "legacy-message");
    assert.equal(row.dedupe_key, null);
    assert.equal(row.body, "");
    assert.match(String(row.body_hash), /^[a-f0-9]{64}$/);
    assert.equal(row.state, "delivered");
    assert.equal(row.last_error, null);
  } finally {
    migrated.close();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});
