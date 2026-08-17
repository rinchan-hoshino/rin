import "../support/require-test-sandbox.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import BetterSqlite3 from "better-sqlite3";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const archiveModule = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat", "archive-prototype.js"),
  ).href
);

async function withTempRoot(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-archive-"));
  try {
    await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function message(id, disposition, suffix, overrides = {}) {
  const sequence = Number(id.match(/\d+$/)?.[0] || 0);
  const day = String(1 + (sequence % 9)).padStart(2, "0");
  return {
    id,
    chatKey: "onebot/group/demo",
    receivedAt: `2026-07-${day}T10:00:00.000Z`,
    disposition,
    text: `tierneedle ${suffix}`,
    rawContent: `raw ${suffix}`,
    strippedContent: `stripped ${suffix}`,
    elements: [{ type: "text", text: `element ${suffix}` }],
    quote: { text: `quote ${suffix}` },
    recordJson: ` { "exact": "record tierneedle ${suffix}", "spacing": true } `,
    ...overrides,
  };
}

function ids(response) {
  return response.results.map((row) => row.id).sort();
}

test("agent-selected search levels cover hot, conversation, and ambient payload tiers", async () => {
  await withTempRoot(async (root) => {
    const archive = new archiveModule.ChatArchivePrototype(root);
    const hot = message("message-1", "processed", "hot");
    const conversation = message("message-2", "processed", "conversation");
    const ambient = message("message-3", "record_only", "ambient", {
      text: "ambient body",
    });
    archive.ingestHot(hot);
    archive.ingestHot(conversation);
    archive.ingestHot(ambient);

    const conversationSegment = archive.archiveHotMessages(
      [conversation.id],
      "conversation",
    );
    const ambientSegment = archive.archiveHotMessages([ambient.id], "ambient");

    assert.match(conversationSegment.filePath, /messages-0001\.sqlite$/);
    assert.match(ambientSegment.filePath, /messages-0002\.sqlite$/);
    assert.equal(
      (await fs.stat(conversationSegment.filePath)).mode & 0o777,
      0o400,
    );

    const quick = archive.search("tierneedle", { searchLevel: "quick" });
    assert.deepEqual(ids(quick), [hot.id]);
    assert.deepEqual(quick.searchedTiers, ["hot"]);
    assert.equal(quick.coverage, "partial");
    assert.equal(quick.deeperSearchAvailable, true);

    const standard = archive.search("tierneedle", {
      searchLevel: "standard",
    });
    assert.deepEqual(ids(standard), [conversation.id, hot.id].sort());
    assert.deepEqual(standard.searchedTiers, ["hot", "conversation"]);
    assert.equal(standard.segmentsScanned, 1);

    const exhaustive = archive.search("tierneedle", {
      searchLevel: "exhaustive",
    });
    assert.deepEqual(
      ids(exhaustive),
      [ambient.id, conversation.id, hot.id].sort(),
    );
    assert.deepEqual(exhaustive.searchedTiers, [
      "hot",
      "conversation",
      "ambient",
    ]);
    assert.equal(exhaustive.segmentsScanned, 2);
    assert.equal(exhaustive.coverage, "complete");
    assert.equal(exhaustive.deeperSearchAvailable, false);
    assert.equal(exhaustive.moreResultsAvailable, false);
    assert.equal(exhaustive.candidateCount, 3);
    assert.equal(exhaustive.candidateCountIsLowerBound, false);

    const firstPage = archive.search("tierneedle", {
      searchLevel: "exhaustive",
      limit: 2,
    });
    const secondPage = archive.search("tierneedle", {
      searchLevel: "exhaustive",
      limit: 2,
      offset: 2,
    });
    assert.equal(firstPage.results.length, 2);
    assert.equal(firstPage.moreResultsAvailable, true);
    assert.equal(secondPage.results.length, 1);
    assert.equal(secondPage.moreResultsAvailable, false);
    assert.deepEqual(
      [...ids(firstPage), ...ids(secondPage)].sort(),
      [ambient.id, conversation.id, hot.id].sort(),
    );

    assert.deepEqual(
      ids(
        archive.search("tierneedle conversation", {
          searchLevel: "standard",
        }),
      ),
      [conversation.id],
    );

    assert.deepEqual(
      archive.ingestHot(conversation),
      archive.ingestHot(conversation),
    );
    assert.throws(
      () =>
        archive.ingestHot({
          ...conversation,
          text: "changed archived payload",
        }),
      /chat_archive_reingest_requires_restore/,
    );
    assert.deepEqual(archive.getMessage(hot.id), hot);
    assert.deepEqual(archive.getMessage(conversation.id), conversation);
    assert.deepEqual(archive.getMessage(ambient.id), ambient);
    assert.equal(archive.getMessage(ambient.id).recordJson, ambient.recordJson);
  });
});

test("concurrent segment publishers reserve distinct immutable files", async () => {
  await withTempRoot(async (root) => {
    const second = new archiveModule.ChatArchivePrototype(root);
    const firstMessage = message("message-7", "processed", "first publisher");
    const secondMessage = message("message-8", "processed", "second publisher");
    second.ingestHot(firstMessage);
    second.ingestHot(secondMessage);
    let secondSegment;
    let nested = false;
    const first = new archiveModule.ChatArchivePrototype(root, {
      beforeCatalogCommit: () => {
        if (nested) return;
        nested = true;
        secondSegment = second.archiveHotMessages(
          [secondMessage.id],
          "conversation",
        );
      },
    });

    const firstSegment = first.archiveHotMessages(
      [firstMessage.id],
      "conversation",
    );
    assert.match(firstSegment.filePath, /messages-0001\.sqlite$/);
    assert.match(secondSegment.filePath, /messages-0002\.sqlite$/);
    await fs.access(firstSegment.filePath);
    await fs.access(secondSegment.filePath);
    assert.deepEqual(first.getMessage(firstMessage.id), firstMessage);
    assert.deepEqual(first.getMessage(secondMessage.id), secondMessage);
  });
});

test("catalog snapshots keep reads complete across archive and rollback switches", async () => {
  await withTempRoot(async (root) => {
    const writer = new archiveModule.ChatArchivePrototype(root);
    const archived = message("message-9", "processed", "snapshot archived");
    writer.ingestHot(archived);
    const segment = writer.archiveHotMessages([archived.id], "conversation");
    let rolledBack = false;
    const archivedReader = new archiveModule.ChatArchivePrototype(root, {
      afterHeaderRead: () => {
        if (rolledBack) return;
        rolledBack = true;
        writer.rollbackSegment(segment.segmentId);
      },
    });
    assert.deepEqual(archivedReader.getMessage(archived.id), archived);
    assert.deepEqual(writer.getMessage(archived.id), archived);

    const moving = message("message-10", "processed", "snapshot moving");
    writer.ingestHot(moving);
    let moved = false;
    const searchReader = new archiveModule.ChatArchivePrototype(root, {
      afterHotSearch: () => {
        if (moved) return;
        moved = true;
        writer.archiveHotMessages([moving.id], "conversation");
      },
    });
    assert.deepEqual(
      ids(
        searchReader.search("snapshot moving", {
          searchLevel: "exhaustive",
        }),
      ),
      [moving.id],
    );
  });
});

test("abandoned segment reservations reconcile without deleting hot payloads", async () => {
  await withTempRoot(async (root) => {
    const archived = message("message-11", "processed", "abandoned");
    const parent = new archiveModule.ChatArchivePrototype(root);
    parent.ingestHot(archived);
    const archiveUrl = pathToFileURL(
      path.join(rootDir, "dist", "core", "chat", "archive-prototype.js"),
    ).href;
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const { ChatArchivePrototype } = await import(${JSON.stringify(archiveUrl)});\n` +
          `const archive = new ChatArchivePrototype(${JSON.stringify(root)}, { beforeCatalogCommit: () => process.kill(process.pid, "SIGKILL") });\n` +
          `archive.archiveHotMessages([${JSON.stringify(archived.id)}], "conversation");`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(child.signal, "SIGKILL", child.stderr);

    const reconciler = new archiveModule.ChatArchivePrototype(root);
    assert.deepEqual(
      reconciler.reconcileAbandonedSegments({ olderThanMs: 0 }),
      { removed: 1 },
    );
    assert.deepEqual(reconciler.getMessage(archived.id), archived);
    assert.deepEqual(
      ids(reconciler.search("tierneedle", { searchLevel: "quick" })),
      [archived.id],
    );
    const retried = reconciler.archiveHotMessages(
      [archived.id],
      "conversation",
    );
    assert.match(retried.filePath, /messages-0002\.sqlite$/);
  });
});

test("archive failure before locator commit leaves the hot payload authoritative", async () => {
  await withTempRoot(async (root) => {
    const archived = message("message-4", "processed", "failure");
    const archive = new archiveModule.ChatArchivePrototype(root, {
      beforeCatalogCommit: () => {
        throw new Error("forced catalog failure");
      },
    });
    archive.ingestHot(archived);

    assert.throws(
      () => archive.archiveHotMessages([archived.id], "conversation"),
      /forced catalog failure/,
    );
    assert.deepEqual(archive.getMessage(archived.id), archived);
    assert.deepEqual(
      ids(archive.search("tierneedle", { searchLevel: "quick" })),
      [archived.id],
    );
    const archiveFiles = await fs
      .readdir(path.join(root, "archive", "2026", "07"))
      .catch(() => []);
    assert.deepEqual(archiveFiles, []);
  });
});

test("archive rollback restores hot payloads without losing full-text search", async () => {
  await withTempRoot(async (root) => {
    const archived = message("message-5", "record_only", "rollback");
    const archive = new archiveModule.ChatArchivePrototype(root);
    archive.ingestHot(archived);
    const segment = archive.archiveHotMessages([archived.id], "ambient");
    assert.deepEqual(
      ids(archive.search("tierneedle", { searchLevel: "quick" })),
      [],
    );

    assert.deepEqual(archive.rollbackSegment(segment.segmentId), {
      segmentId: segment.segmentId,
      restored: 1,
    });
    assert.deepEqual(archive.getMessage(archived.id), archived);
    assert.deepEqual(
      ids(archive.search("tierneedle", { searchLevel: "quick" })),
      [archived.id],
    );
    assert.deepEqual(
      ids(archive.search("tierneedle", { searchLevel: "exhaustive" })),
      [archived.id],
    );
  });
});

test("operational messages cannot enter an immutable archive segment", async () => {
  await withTempRoot(async (root) => {
    const active = message("message-6", "processing", "active");
    const archive = new archiveModule.ChatArchivePrototype(root);
    archive.ingestHot(active);
    assert.throws(
      () => archive.archiveHotMessages([active.id], "conversation"),
      /chat_archive_message_still_operational/,
    );
    assert.deepEqual(archive.getMessage(active.id), active);
  });
});

test("archive prototype detects missing and corrupted payload authorities", async () => {
  await withTempRoot(async (root) => {
    const archive = new archiveModule.ChatArchivePrototype(root);
    assert.equal(archive.getMessage("missing"), null);
    assert.throws(
      () => archive.archiveHotMessages(["missing"], "conversation"),
      /chat_archive_hot_payload_missing/,
    );

    const corrupted = message("corrupt-1", "processed", "corrupted");
    archive.ingestHot(corrupted);
    const db = new BetterSqlite3(
      path.join(root, "chat-archive-prototype.sqlite"),
    );
    db.prepare(
      "UPDATE hot_payloads SET payload_json = ? WHERE message_id = ?",
    ).run(JSON.stringify({ ...corrupted, text: "tampered" }), corrupted.id);
    db.close();
    assert.throws(
      () => archive.getMessage(corrupted.id),
      /chat_archive_payload_hash_mismatch/,
    );
    assert.throws(
      () => archive.search("tierneedle corrupted", { searchLevel: "quick" }),
      /chat_archive_payload_hash_mismatch/,
    );
  });

  await withTempRoot(async (root) => {
    const archive = new archiveModule.ChatArchivePrototype(root);
    const archived = message("missing-segment-1", "processed", "segment");
    archive.ingestHot(archived);
    const segment = archive.archiveHotMessages([archived.id], "conversation");
    await fs.rm(segment.filePath);
    assert.throws(
      () => archive.getMessage(archived.id),
      /chat_archive_segment_missing/,
    );
    assert.throws(
      () => archive.search("segment", { searchLevel: "standard" }),
      /chat_archive_segment_missing/,
    );
    assert.throws(
      () => archive.rollbackSegment(segment.segmentId),
      /chat_archive_segment_missing/,
    );
  });

  await withTempRoot(async (root) => {
    const archive = new archiveModule.ChatArchivePrototype(root);
    const archived = message("checksum-1", "processed", "checksum");
    archive.ingestHot(archived);
    const segment = archive.archiveHotMessages([archived.id], "conversation");
    await fs.chmod(segment.filePath, 0o600);
    await fs.appendFile(segment.filePath, "tamper");
    assert.throws(
      () => archive.rollbackSegment(segment.segmentId),
      /chat_archive_segment_checksum_mismatch/,
    );
  });
});

test("archive prototype validates edge identities, periods, queries, and live reservations", async () => {
  await withTempRoot(async (root) => {
    const archive = new archiveModule.ChatArchivePrototype(root);
    for (const overrides of [{ id: "" }, { chatKey: "" }, { receivedAt: "" }]) {
      assert.throws(
        () =>
          archive.ingestHot(message("edge-1", "processed", "edge", overrides)),
        /chat_archive_message_identity_required/,
      );
    }
    assert.throws(
      () =>
        archive.ingestHot(
          message("edge-2", "processed", "edge", {
            receivedAt: "not-a-date",
          }),
        ),
      /invalid_received_at/,
    );
    assert.throws(
      () => archive.archiveHotMessages([], "conversation"),
      /chat_archive_messages_required/,
    );

    const nested = message("edge-3", "processed", "nested", {
      recordJson: "not-json",
      elements: [
        null,
        " direct text ",
        { nested: [[{ value: "deep searchable owner" }]] },
      ],
    });
    archive.ingestHot(nested);
    assert.deepEqual(ids(archive.search("", { searchLevel: "quick" })), []);
    assert.deepEqual(ids(archive.search("de", { searchLevel: "quick" })), [
      nested.id,
    ]);
    assert.deepEqual(ids(archive.search("a b", { searchLevel: "quick" })), []);

    const august = message("edge-4", "processed", "august", {
      receivedAt: "2026-08-01T00:00:00.000Z",
    });
    archive.ingestHot(august);
    assert.throws(
      () => archive.archiveHotMessages([nested.id, august.id], "conversation"),
      /chat_archive_single_period_required/,
    );
    assert.throws(
      () => archive.rollbackSegment("missing"),
      /chat_archive_segment_not_committed/,
    );

    const db = new BetterSqlite3(
      path.join(root, "chat-archive-prototype.sqlite"),
    );
    db.prepare(
      `INSERT INTO archive_segments(
         id, period, sequence, tier, file_path, state, owner_nonce,
         owner_pid, created_at
       ) VALUES (?, ?, ?, ?, ?, 'staging', ?, ?, ?)`,
    ).run(
      "live-reservation",
      "2026-09",
      1,
      "conversation",
      path.join(root, "live.sqlite"),
      "owner",
      process.pid,
      0,
    );
    db.close();
    assert.deepEqual(archive.reconcileAbandonedSegments({ olderThanMs: 0 }), {
      removed: 0,
    });
    const staleDb = new BetterSqlite3(
      path.join(root, "chat-archive-prototype.sqlite"),
    );
    staleDb
      .prepare("UPDATE archive_segments SET owner_pid = 0 WHERE id = ?")
      .run("live-reservation");
    staleDb.close();
    assert.deepEqual(archive.reconcileAbandonedSegments({ olderThanMs: 0 }), {
      removed: 1,
    });
  });
});
