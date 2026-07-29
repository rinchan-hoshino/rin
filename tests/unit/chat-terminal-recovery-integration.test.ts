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
const distImport = (relativePath: string) =>
  import(pathToFileURL(path.join(rootDir, "dist", relativePath)).href);

const { ChatController } = await distImport("core/chat/controller.js");
const { closeChatDatabase, openChatDatabase } = await distImport(
  "core/chat/database.js",
);
const { createCanonicalChatRun } = await distImport("core/chat/run-store.js");
const { enqueueChatInboxItem, claimChatInboxItem } =
  await distImport("core/chat/inbox.js");
const { WorkerPool } = await distImport("core/rin-daemon/worker-pool.js");
const { readChatTerminalWal, stageChatTerminalWal } = await distImport(
  "core/rin-daemon/chat-terminal-wal.js",
);

async function waitFor(check: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for canonical terminal settlement");
}

test("a staged worker terminal survives notification loss and a cold controller commits it atomically", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-terminal-recovery-"),
  );
  const agentDir = path.join(root, "agents", "default");
  await fs.mkdir(agentDir, { recursive: true });
  const chatKey = "discord/1:2";
  const messageId = "discord-terminal-recovery";
  const inboxItem = enqueueChatInboxItem(agentDir, {
    chatKey,
    messageId,
    session: {
      platform: "discord",
      selfId: "1",
      channelId: "2",
      messageId,
      content: "recover this final",
      stripped: { content: "recover this final" },
    },
    elements: [{ type: "text", attrs: { content: "recover this final" } }],
  }).item;
  const claim = claimChatInboxItem(agentDir, inboxItem.itemId);
  assert.ok(claim);

  const runContext = {
    runId: claim.itemId,
    ownerEpoch: claim.ownerEpoch,
    producerIncarnation: "worker-incarnation-before-socket-loss",
  };
  createCanonicalChatRun(agentDir, {
    producerIncarnation: runContext.producerIncarnation,
    turnFence: {
      agentDir,
      turnId: claim.itemId,
      chatKey,
      messageId,
      ownerEpoch: claim.ownerEpoch,
      attempt: claim.attemptCount,
    },
  });

  const sessionFile = path.join(agentDir, "sessions", "recovery.jsonl");
  const staged = stageChatTerminalWal(agentDir, {
    ...runContext,
    terminalKind: "complete",
    terminalPayload: {
      event: "complete",
      requestTag: "discord-terminal-recovery-request",
      finalText: "durable recovered final",
      result: {
        messages: [{ type: "text", text: "durable recovered final" }],
      },
      sessionId: "recovery-session",
      sessionFile,
    },
  });

  // The original frontend notification is intentionally dropped here. A new
  // daemon connection replays the worker WAL to a fresh controller instead.
  const pool = new WorkerPool({
    workerPath: path.join(root, "unused-worker"),
    cwd: root,
    agentDir,
  });
  const writes: string[] = [];
  const connection = {
    socket: {
      destroyed: false,
      write(value: string) {
        writes.push(String(value));
      },
    },
    clientBuffer: "",
  };
  assert.equal(
    pool.replayPendingTerminalTurnEvent(connection, { sessionFile }),
    true,
  );
  const replayed = JSON.parse(writes.at(-1) || "null");
  assert.equal(replayed.terminalWal.payloadHash, staged.payloadHash);

  const controller = new ChatController(
    {},
    path.join(agentDir, "sessions"),
    chatKey,
    {
      logger: { info() {}, warn() {} },
      h: {
        text(content: string) {
          return { type: "text", attrs: { content } };
        },
        quote(id: string) {
          return { type: "quote", attrs: { id } };
        },
      },
    },
  );
  assert.equal(controller.agentDir, agentDir);
  controller.app = { bots: [] };
  await controller.handleFrontendEvent({
    type: "turn_complete",
    finalText: replayed.finalText,
    result: replayed.result,
    sessionId: replayed.sessionId,
    sessionFile: replayed.sessionFile,
    requestTag: replayed.requestTag,
    chatRunContext: replayed.chatRunContext,
    terminalWal: replayed.terminalWal,
  });

  const database = openChatDatabase(agentDir);
  await waitFor(() => {
    const run = database
      .prepare("SELECT state FROM chat_runs WHERE run_id = ?")
      .get(runContext.runId) as { state?: string } | undefined;
    return run?.state === "terminal";
  });

  const turn = database
    .prepare(
      `SELECT state, heartbeat_at AS heartbeatAt, owner_epoch AS ownerEpoch
         FROM turns
        WHERE turn_id = ?`,
    )
    .get(claim.itemId) as {
    state: string;
    heartbeatAt: number | null;
    ownerEpoch: string | null;
  };
  assert.deepEqual(turn, {
    state: "terminal",
    heartbeatAt: null,
    ownerEpoch: null,
  });
  const outbox = database
    .prepare(
      `SELECT outbox_id AS outboxId,
              delivery_kind AS kind,
              payload_json AS payloadJson
         FROM outbox
        WHERE idempotency_key = ?`,
    )
    .get(`terminal:${runContext.runId}`) as
    | { outboxId: string; kind: string; payloadJson: string }
    | undefined;
  assert.equal(outbox?.kind, "final");
  assert.match(outbox?.payloadJson || "", /durable recovered final/);
  const committedWal = readChatTerminalWal(agentDir, runContext.runId);
  assert.equal(committedWal?.state, "committed");
  assert.equal(committedWal?.outboxId, outbox?.outboxId);
  assert.equal(controller.activeCanonicalRun, null);

  controller.dispose();
  pool.destroyAll();
  closeChatDatabase(agentDir);
  await fs.rm(root, { recursive: true, force: true });
});
