import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import BetterSqlite3 from "better-sqlite3";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const ledger: any = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-daemon", "turn-ledger.js"),
  ).href
);

async function withAgentDir(run: (agentDir: string) => Promise<void> | void) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-turn-ledger-"));
  const agentDir = path.join(root, "agent");
  try {
    await run(agentDir);
  } finally {
    ledger.closeDaemonTurnLedger(agentDir);
    await fs.rm(root, { recursive: true, force: true });
  }
}

const invocationContext = {
  source: "chat-bridge",
  frontendIdentity: { kind: "chat", key: "discord/guild/channel" },
  promptContext: {
    source: "chat-bridge",
    chatKey: "discord/guild/channel",
    selfImproveEligible: true,
  },
};

const chatContext = {
  turnId: "transport-turn-1",
  chatKey: "discord/guild/channel",
  messageId: "message-1",
};

function begin(agentDir: string, overrides: Record<string, unknown> = {}) {
  return ledger.beginDaemonTurn(agentDir, {
    requestTag: "request-1",
    sessionFile: "/sessions/one.jsonl",
    sessionId: "session-1",
    chatDeliveryContext: chatContext,
    invocationContext,
    ...overrides,
  }).record;
}

test("daemon turn ledger owns one immutable lifecycle record per request", async () => {
  await withAgentDir(async (agentDir) => {
    const active = begin(agentDir);
    assert.equal(active.state, "active");
    assert.deepEqual(active.chatDeliveryContext, chatContext);
    assert.deepEqual(active.invocationContext, invocationContext);
    assert.deepEqual(begin(agentDir), active);
    assert.throws(
      () => begin(agentDir, { sessionId: "different-session" }),
      /rin_turn_ledger_begin_conflict/,
    );
    assert.throws(
      () =>
        begin(agentDir, {
          invocationContext: { ...invocationContext, source: "tui" },
        }),
      /rin_turn_ledger_begin_conflict/,
    );

    const terminalEvent = {
      type: "rpc_turn_event",
      event: "complete",
      requestTag: "request-1",
      turnGeneration: 1,
      sessionFile: "/sessions/one.jsonl",
      sessionId: "session-1",
      finalText: "done",
      result: {
        content: [
          { type: "text", text: "done" },
          { type: "image", source: { type: "url", url: "https://x/y.png" } },
        ],
      },
    };
    const terminal = ledger.recordDaemonTurnTerminal(agentDir, {
      requestTag: "request-1",
      terminalKind: "complete",
      terminalEvent,
    });
    assert.equal(terminal.state, "complete");
    assert.match(terminal.terminalId, /^terminal-[a-f0-9]{64}$/);
    assert.deepEqual(terminal.terminalEvent, terminalEvent);
    assert.deepEqual(
      ledger.recordDaemonTurnTerminal(agentDir, {
        requestTag: "request-1",
        terminalKind: "complete",
        terminalEvent,
      }),
      terminal,
    );
    assert.throws(
      () =>
        ledger.recordDaemonTurnTerminal(agentDir, {
          requestTag: "request-1",
          terminalKind: "error",
          terminalEvent: { ...terminalEvent, event: "error", error: "wrong" },
        }),
      /rin_turn_ledger_terminal_conflict/,
    );
  });
});

test("direct supervisor interruption is terminal while restart recovery keeps active work", async () => {
  await withAgentDir(async (agentDir) => {
    begin(agentDir);
    begin(agentDir, {
      requestTag: "request-2",
      chatDeliveryContext: {
        turnId: "transport-turn-2",
        chatKey: chatContext.chatKey,
        messageId: "message-2",
      },
    });

    const interrupted = ledger.interruptDaemonTurn(
      agentDir,
      "request-1",
      "rin_worker_exit",
    );
    assert.equal(interrupted.state, "interrupted");
    assert.equal(interrupted.terminalEvent.event, "error");
    assert.equal(interrupted.terminalEvent.error, "rin_worker_exit");

    assert.equal(ledger.readDaemonTurn(agentDir, "request-2").state, "active");
    assert.deepEqual(
      ledger.listActiveDaemonTurns(agentDir).map((record) => record.requestTag),
      ["request-2"],
    );
  });
});

test("Chat acknowledges only an exact durable terminal after outbox commit", async () => {
  await withAgentDir(async (agentDir) => {
    begin(agentDir);
    const terminal = ledger.interruptDaemonTurn(
      agentDir,
      "request-1",
      "rin_worker_exit",
    );
    assert.deepEqual(
      ledger.listUnacknowledgedChatTerminals(agentDir, chatContext.chatKey),
      [terminal],
    );
    assert.throws(
      () =>
        ledger.acknowledgeDaemonTurnTerminal(agentDir, {
          requestTag: "request-1",
          terminalId: "terminal-wrong",
        }),
      /rin_turn_ledger_terminal_id_mismatch/,
    );
    const acknowledged = ledger.acknowledgeDaemonTurnTerminal(agentDir, {
      requestTag: "request-1",
      terminalId: terminal.terminalId,
    });
    assert.ok(acknowledged.acknowledgedAt);
    assert.deepEqual(
      ledger.listUnacknowledgedChatTerminals(agentDir, chatContext.chatKey),
      [],
    );
  });
});

test("daemon turn ledger rejects mismatched terminals and preserves idempotent settlement", async () => {
  await withAgentDir(async (agentDir) => {
    const active = begin(agentDir);
    assert.throws(
      () =>
        ledger.recordDaemonTurnTerminal(agentDir, {
          requestTag: "request-1",
          terminalKind: "complete",
          terminalEvent: {
            type: "rpc_turn_event",
            event: "complete",
            requestTag: "request-other",
          },
        }),
      /rin_turn_ledger_terminal_request_mismatch/,
    );
    assert.throws(
      () =>
        ledger.recordDaemonTurnTerminal(agentDir, {
          requestTag: "request-1",
          terminalKind: "complete",
          terminalEvent: {
            type: "rpc_turn_event",
            event: "error",
            requestTag: "request-1",
          },
        }),
      /rin_turn_ledger_terminal_kind_mismatch/,
    );
    assert.throws(
      () => ledger.interruptDaemonTurn(agentDir, "missing", "owner"),
      /rin_turn_ledger_record_missing/,
    );
    assert.throws(
      () => ledger.interruptDaemonTurn(agentDir, "request-1", ""),
      /rin_turn_ledger_interrupt_reason_required/,
    );
    assert.throws(
      () => ledger.daemonTurnTerminalEvent(active),
      /rin_turn_ledger_terminal_missing/,
    );
    assert.throws(
      () =>
        ledger.acknowledgeDaemonTurnTerminal(agentDir, {
          requestTag: "request-1",
          terminalId: "terminal-active",
        }),
      /rin_turn_ledger_terminal_missing/,
    );

    const terminal = ledger.interruptDaemonTurn(
      agentDir,
      "request-1",
      "owner interrupt",
    );
    assert.deepEqual(
      ledger.interruptDaemonTurn(agentDir, "request-1", "ignored"),
      terminal,
    );
    assert.deepEqual(ledger.listUnacknowledgedChatTerminals(agentDir), [
      terminal,
    ]);
    assert.equal(
      ledger.daemonTurnTerminalEvent(terminal).chatDeliveryContext.chatKey,
      chatContext.chatKey,
    );
    const acknowledged = ledger.acknowledgeDaemonTurnTerminal(agentDir, {
      requestTag: "request-1",
      terminalId: terminal.terminalId,
    });
    assert.deepEqual(
      ledger.acknowledgeDaemonTurnTerminal(agentDir, {
        requestTag: "request-1",
        terminalId: terminal.terminalId,
      }),
      acknowledged,
    );

    ledger.beginDaemonTurn(agentDir, { requestTag: "request-no-chat" });
    const noChat = ledger.recordDaemonTurnTerminal(agentDir, {
      requestTag: "request-no-chat",
      terminalKind: "complete",
      terminalEvent: {
        type: "rpc_turn_event",
        event: "complete",
        requestTag: "request-no-chat",
      },
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        ledger.daemonTurnTerminalEvent(noChat),
        "chatDeliveryContext",
      ),
      false,
    );
  });
});

test("daemon turn ledger uses SQLite WAL instead of an application file WAL", async () => {
  await withAgentDir(async (agentDir) => {
    begin(agentDir);
    const info = ledger.inspectDaemonTurnLedger(agentDir);
    assert.equal(info.journalMode, "wal");
    assert.equal(info.userVersion, 3);
    assert.match(info.path, /data\/core\/daemon\/turn-ledger\.sqlite$/);
  });
});

test("Chat message identity is scoped by chat instead of globally", async () => {
  await withAgentDir(async (agentDir) => {
    const first = ledger.beginDaemonTurn(agentDir, {
      requestTag: "same-message-request-1",
      chatDeliveryContext: {
        turnId: "same-message-turn-1",
        chatKey: "discord/one",
        messageId: "platform-message-1",
      },
    });
    const second = ledger.beginDaemonTurn(agentDir, {
      requestTag: "same-message-request-2",
      chatDeliveryContext: {
        turnId: "same-message-turn-2",
        chatKey: "discord/two",
        messageId: "platform-message-1",
      },
    });
    assert.equal(first.created, true);
    assert.equal(second.created, true);
    assert.equal(
      first.record.chatDeliveryContext.messageId,
      "platform-message-1",
    );
    assert.equal(
      second.record.chatDeliveryContext.messageId,
      "platform-message-1",
    );
  });
});

test("daemon turn ledger migrates v1 global message uniqueness to the current schema", async () => {
  await withAgentDir(async (agentDir) => {
    const dbPath = ledger.resolveDaemonTurnLedgerPath(agentDir);
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const db = new BetterSqlite3(dbPath);
    db.exec(`
      CREATE TABLE turn_records (
        request_tag TEXT PRIMARY KEY,
        session_file TEXT,
        session_id TEXT,
        transport_turn_id TEXT UNIQUE,
        chat_key TEXT,
        message_id TEXT UNIQUE,
        state TEXT NOT NULL,
        terminal_id TEXT UNIQUE,
        terminal_event_json TEXT,
        created_at TEXT NOT NULL,
        terminal_at TEXT,
        acknowledged_at TEXT
      );
      INSERT INTO turn_records (
        request_tag, transport_turn_id, chat_key, message_id, state, created_at
      ) VALUES (
        'v1-request', 'v1-turn', 'discord/one', 'same-platform-id',
        'active', '2026-07-30T00:00:00.000Z'
      );
      PRAGMA user_version = 1;
    `);
    db.close();

    assert.equal(ledger.inspectDaemonTurnLedger(agentDir).userVersion, 3);
    assert.equal(ledger.readDaemonTurn(agentDir, "v1-request").state, "active");
    assert.equal(
      ledger.beginDaemonTurn(agentDir, {
        requestTag: "v2-request",
        chatDeliveryContext: {
          turnId: "v2-turn",
          chatKey: "discord/two",
          messageId: "same-platform-id",
        },
      }).created,
      true,
    );
  });
});

test("daemon turn ledger adds nullable invocation provenance to v2 records", async () => {
  await withAgentDir(async (agentDir) => {
    const dbPath = ledger.resolveDaemonTurnLedgerPath(agentDir);
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const db = new BetterSqlite3(dbPath);
    db.exec(`
      CREATE TABLE turn_records (
        request_tag TEXT PRIMARY KEY,
        session_file TEXT,
        session_id TEXT,
        transport_turn_id TEXT UNIQUE,
        chat_key TEXT,
        message_id TEXT,
        state TEXT NOT NULL,
        terminal_id TEXT UNIQUE,
        terminal_event_json TEXT,
        created_at TEXT NOT NULL,
        terminal_at TEXT,
        acknowledged_at TEXT
      );
      INSERT INTO turn_records (
        request_tag, session_file, state, created_at
      ) VALUES (
        'v2-request', '/sessions/v2.jsonl', 'active',
        '2026-08-11T00:00:00.000Z'
      );
      PRAGMA user_version = 2;
    `);
    db.close();

    assert.equal(ledger.inspectDaemonTurnLedger(agentDir).userVersion, 3);
    const legacy = ledger.readDaemonTurn(agentDir, "v2-request");
    assert.equal(legacy.state, "active");
    assert.equal(legacy.invocationContext, undefined);
    const rejoinedLegacy = ledger.beginDaemonTurn(agentDir, {
      requestTag: "v2-request",
      sessionFile: "/sessions/v2.jsonl",
      invocationContext,
    });
    assert.equal(rejoinedLegacy.created, false);
    assert.equal(rejoinedLegacy.record.invocationContext, undefined);
    const current = begin(agentDir);
    assert.deepEqual(current.invocationContext, invocationContext);
  });
});
