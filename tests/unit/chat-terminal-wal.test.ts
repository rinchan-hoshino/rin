import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const wal = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-daemon", "chat-terminal-wal.js"),
  ).href
);

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-terminal-wal-"),
  );
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function candidate(text = "done") {
  return {
    runId: "run/with unsafe filename",
    ownerEpoch: "epoch-1",
    producerIncarnation: "worker-1",
    terminalKind: "complete",
    terminalPayload: { text, requestTag: "chat-inbox-tag" },
  };
}

test("producer terminal WAL stages an immutable fsynced result and commits a tombstone", async () => {
  await withTempDir(async (agentDir) => {
    const staged = wal.stageChatTerminalWal(agentDir, candidate());
    assert.equal(staged.state, "staged");
    assert.equal(staged.runId, candidate().runId);
    assert.match(staged.payloadHash, /^[0-9a-f]{64}$/);

    assert.deepEqual(
      wal.readChatTerminalWal(agentDir, candidate().runId),
      staged,
    );
    assert.deepEqual(wal.stageChatTerminalWal(agentDir, candidate()), staged);
    assert.throws(
      () => wal.stageChatTerminalWal(agentDir, candidate("conflict")),
      /chat_terminal_wal_conflict/,
    );

    const committed = wal.commitChatTerminalWal(agentDir, {
      runId: staged.runId,
      ownerEpoch: staged.ownerEpoch,
      producerIncarnation: staged.producerIncarnation,
      payloadHash: staged.payloadHash,
      outboxId: "outbox-1",
    });
    assert.equal(committed.state, "committed");
    assert.equal(committed.outboxId, "outbox-1");
    assert.deepEqual(
      wal.commitChatTerminalWal(agentDir, {
        runId: staged.runId,
        ownerEpoch: staged.ownerEpoch,
        producerIncarnation: staged.producerIncarnation,
        payloadHash: staged.payloadHash,
        outboxId: "outbox-1",
      }),
      committed,
    );
  });
});

test("producer terminal WAL rejects stale producer commit and never stores executable commands", async () => {
  await withTempDir(async (agentDir) => {
    const staged = wal.stageChatTerminalWal(agentDir, candidate());
    assert.throws(
      () =>
        wal.commitChatTerminalWal(agentDir, {
          runId: staged.runId,
          ownerEpoch: staged.ownerEpoch,
          producerIncarnation: "worker-stale",
          payloadHash: staged.payloadHash,
          outboxId: "outbox-stale",
        }),
      /chat_terminal_wal_stale_producer/,
    );
    const serialized = JSON.stringify(
      wal.readChatTerminalWal(agentDir, staged.runId),
    );
    assert.doesNotMatch(
      serialized,
      /prompt|toolCall|resumeSession|retryCommand/,
    );
  });
});
