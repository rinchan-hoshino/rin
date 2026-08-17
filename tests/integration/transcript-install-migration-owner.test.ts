import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as migration from "../../dist/core/memory/transcript-install-migration.js";

async function withTempDir(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-transcript-migrate-"),
  );
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function archiveEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "entry-1",
    timestamp: "2026-08-11T02:00:00.000Z",
    sessionId: "session-1",
    sessionFile: "/tmp/managed-session.jsonl",
    role: "toolResult",
    text: "read image [image:image/png]",
    content: [
      { type: "text", text: "read image" },
      {
        type: "image",
        data: "iVBORw0KGgoAAA",
        mimeType: "image/png",
        width: 2168,
        height: 725,
      },
    ],
    toolName: "read",
    ...overrides,
  };
}

function confirmedInterleavedLine() {
  const first = JSON.stringify(archiveEntry({ id: "broken-a" }));
  const second = JSON.stringify(archiveEntry({ id: "broken-b" }));
  return `${first.slice(0, first.indexOf("iVBOR"))}${second}${first.slice(
    first.indexOf("iVBOR") + 5,
  )}`;
}

test("install sanitizer removes binary content and records confirmed interleaving", async () => {
  await withTempDir(async (root) => {
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    const nested = path.join(source, "2026", "08");
    await fs.mkdir(nested, { recursive: true });
    const orphanedImageTail = `${"A".repeat(128)}","mimeType":"image/png"}]}`;
    const prefixedInterleavedRecord = `${"A".repeat(128)}${JSON.stringify(archiveEntry())}`;
    const unicodeSeparatorEntry = {
      ...archiveEntry(),
      id: "entry-unicode-separator",
      role: "assistant",
      text: "valid before\u2028valid after",
      content: [{ type: "text", text: "valid before\u2028valid after" }],
    };
    await fs.writeFile(
      path.join(nested, "session.jsonl"),
      `${JSON.stringify(archiveEntry())}\n${confirmedInterleavedLine()}\n${orphanedImageTail}\n${prefixedInterleavedRecord}\n${JSON.stringify(unicodeSeparatorEntry)}\n`,
    );

    const manifest = await migration.sanitizeTranscriptArchiveTreeForMigration(
      source,
      target,
    );
    assert.equal(manifest.summary.sourceFiles, 1);
    assert.equal(manifest.summary.writtenEntries, 2);
    assert.equal(manifest.summary.confirmedCorruptLines, 3);
    assert.equal(manifest.summary.unknownCorruptLines, 0);
    const output = await fs.readFile(
      path.join(target, "2026", "08", "session.jsonl"),
      "utf8",
    );
    assert.doesNotMatch(output, /"content"\s*:/);
    assert.doesNotMatch(output, /"data"\s*:/);
    const parsed = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(parsed[0].text, "read image [image:image/png]");
    assert.deepEqual(parsed[0].media, [
      {
        type: "image",
        mimeType: "image/png",
        width: 2168,
        height: 725,
      },
    ]);
    assert.equal(parsed[1].text, "valid before\u2028valid after");
    assert.equal(
      manifest.files[0].issues[0].classification,
      "confirmed-interleaved",
    );
    assert.match(manifest.files[0].issues[0].sha256, /^[0-9a-f]{64}$/);
  });
});

test("install sanitizer aborts on unexplained corruption without changing source", async () => {
  await withTempDir(async (root) => {
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    const file = path.join(source, "session.jsonl");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(archiveEntry())}\nnot-json\n`);
    const before = await fs.readFile(file);

    await assert.rejects(
      migration.sanitizeTranscriptArchiveTreeForMigration(source, target),
      /transcript_archive_install_unknown_corruption:session\.jsonl:2/,
    );
    assert.deepEqual(await fs.readFile(file), before);
    const quarantineFiles = await fs.readdir(`${target}.quarantine`);
    assert.equal(quarantineFiles.length, 2);
    const metadataName = quarantineFiles.find((name) => name.endsWith(".json"));
    assert.ok(metadataName);
    const metadata = JSON.parse(
      await fs.readFile(
        path.join(`${target}.quarantine`, metadataName),
        "utf8",
      ),
    );
    assert.equal(metadata.relativePath, "session.jsonl");
    assert.equal(metadata.classification, "unknown-corruption");
  });
});

test("install sanitizer quarantines exact unexplained source bytes", async () => {
  for (const rawLine of ["  not-json  ", "null"]) {
    await withTempDir(async (root) => {
      const source = path.join(root, "source");
      const target = path.join(root, "target");
      await fs.mkdir(source);
      await fs.writeFile(path.join(source, "session.jsonl"), `${rawLine}\n`);
      await assert.rejects(
        migration.sanitizeTranscriptArchiveTreeForMigration(source, target),
        /transcript_archive_install_unknown_corruption:session\.jsonl:1/,
      );
      const quarantineFiles = await fs.readdir(`${target}.quarantine`);
      const metadataName = quarantineFiles.find((name) =>
        name.endsWith(".json"),
      );
      const fragmentName = quarantineFiles.find((name) =>
        name.endsWith(".jsonl-fragment"),
      );
      assert.ok(metadataName);
      assert.ok(fragmentName);
      const metadata = JSON.parse(
        await fs.readFile(
          path.join(`${target}.quarantine`, metadataName),
          "utf8",
        ),
      );
      assert.equal(metadata.bytes, Buffer.byteLength(rawLine));
      assert.equal(
        metadata.sha256,
        crypto.createHash("sha256").update(rawLine).digest("hex"),
      );
      assert.equal(
        await fs.readFile(
          path.join(`${target}.quarantine`, fragmentName),
          "utf8",
        ),
        `${rawLine}\n`,
      );
    });
  }
});

test("install sanitizer keeps searchable metadata without binary fields", () => {
  assert.equal(
    migration.sanitizeTranscriptArchiveEntryForMigration({ text: "" }),
    null,
  );
  const sanitized = migration.sanitizeTranscriptArchiveEntryForMigration({
    ...archiveEntry(),
    content: [
      { type: "text", text: "searchable" },
      {
        type: "image",
        data: "base64-binary",
        mimeType: "image/png",
        width: 640,
        height: 480,
      },
      {
        type: "file",
        name: "report.txt",
        mimeType: "text/plain",
        size: 12,
      },
    ],
    toolName: "read",
    toolCallId: "call-1",
    customType: "custom-note",
    stopReason: "stop",
    errorMessage: "error",
    provider: "provider",
    model: "model",
    display: false,
  });
  assert.ok(sanitized);
  assert.equal(sanitized.content, undefined);
  assert.equal(sanitized.media?.length, 2);
  assert.equal(sanitized.toolName, "read");
  assert.equal(sanitized.display, false);
  assert.doesNotMatch(JSON.stringify(sanitized), /base64-binary/);
});

test("install sanitizer validates roots and empty migrations", async () => {
  await withTempDir(async (root) => {
    const emptyTarget = path.join(root, "empty-target");
    const empty = await migration.sanitizeTranscriptArchiveTreeForMigration(
      path.join(root, "missing-source"),
      emptyTarget,
    );
    assert.equal(empty.summary.sourceFiles, 0);

    const nonEmptyTarget = path.join(root, "non-empty-target");
    await fs.mkdir(nonEmptyTarget);
    await fs.writeFile(path.join(nonEmptyTarget, "owned"), "data");
    await assert.rejects(
      migration.sanitizeTranscriptArchiveTreeForMigration(
        path.join(root, "missing-source"),
        nonEmptyTarget,
      ),
      /transcript_archive_install_target_not_empty/,
    );

    const invalidSource = path.join(root, "source-file");
    await fs.writeFile(invalidSource, "not-a-directory");
    await assert.rejects(
      migration.sanitizeTranscriptArchiveTreeForMigration(
        invalidSource,
        path.join(root, "invalid-source-target"),
      ),
      /transcript_archive_install_source_path_invalid/,
    );
  });
});

test("install sanitizer incrementally refreshes changed archive files", async () => {
  await withTempDir(async (root) => {
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    const first = path.join(source, "first.jsonl");
    const removed = path.join(source, "removed.jsonl");
    await fs.mkdir(source);
    await fs.writeFile(
      first,
      `${JSON.stringify(archiveEntry({ id: "first" }))}\n`,
    );
    await fs.writeFile(
      removed,
      `${JSON.stringify(archiveEntry({ id: "removed" }))}\n`,
    );
    const initial = await migration.sanitizeTranscriptArchiveTreeForMigration(
      source,
      target,
    );
    const unchanged =
      await migration.synchronizeSanitizedTranscriptArchiveTreeForMigration(
        source,
        target,
        initial,
      );
    assert.deepEqual(unchanged, initial);

    await fs.appendFile(
      first,
      `${JSON.stringify(archiveEntry({ id: "second" }))}\n`,
    );
    await fs.rm(removed);
    const nested = path.join(source, "nested", "new.jsonl");
    await fs.mkdir(path.dirname(nested));
    await fs.writeFile(
      nested,
      `${JSON.stringify(archiveEntry({ id: "nested" }))}\n`,
    );
    const refreshed =
      await migration.synchronizeSanitizedTranscriptArchiveTreeForMigration(
        source,
        target,
        initial,
      );
    assert.equal(refreshed.summary.sourceFiles, 2);
    assert.equal(refreshed.summary.writtenEntries, 3);
    assert.equal(
      await fs
        .readFile(path.join(target, "removed.jsonl"), "utf8")
        .catch(() => "missing"),
      "missing",
    );
    assert.match(
      await fs.readFile(path.join(target, "first.jsonl"), "utf8"),
      /second/,
    );

    await assert.rejects(
      migration.synchronizeSanitizedTranscriptArchiveTreeForMigration(
        source,
        target,
        { ...refreshed, version: 2 },
      ),
      /transcript_archive_install_manifest_invalid/,
    );
  });
});
