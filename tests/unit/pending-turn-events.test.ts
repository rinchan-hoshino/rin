import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const pending = await importBuiltModule<
  typeof import("../../src/core/rin-daemon/pending-turn-events.js")
>("dist/core/rin-daemon/pending-turn-events.js");

async function withAgentDir(run: (agentDir: string) => Promise<void>) {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-pending-turn-"),
  );
  try {
    await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

test("pending turn events ignore incomplete inputs", async () => {
  await withAgentDir(async (agentDir) => {
    pending.rememberPendingTerminalTurnEvent(undefined, {});
    pending.rememberPendingTerminalTurnEvent(agentDir, {
      type: "rpc_turn_event",
      event: "heartbeat",
      sessionFile: "/tmp/session.jsonl",
    });
    pending.rememberPendingTerminalTurnEvent(agentDir, {
      type: "rpc_turn_event",
      event: "complete",
    });
    assert.equal(pending.clearPendingTerminalTurnEvent(undefined, {}), false);
    assert.equal(pending.clearPendingTerminalTurnEvent(agentDir, {}), false);
    assert.equal(
      pending.clearPendingTerminalTurnEvent(agentDir, {
        sessionFile: "/tmp/missing.jsonl",
      }),
      false,
    );
    assert.equal(pending.takePendingTerminalTurnEvent(undefined, {}), null);
    assert.equal(pending.takePendingTerminalTurnEvent(agentDir, {}), null);
  });
});

test("pending turn events remember, filter, take, and clear terminal events", async () => {
  await withAgentDir(async (agentDir) => {
    const complete = {
      type: "rpc_turn_event",
      event: "complete",
      sessionFile: " /tmp/complete.jsonl ",
      requestTag: "tag-1",
      finalText: "done",
    };
    const error = {
      type: "rpc_turn_event",
      event: "error",
      sessionFile: "/tmp/error.jsonl",
      requestTag: "tag-2",
      error: "failed",
    };
    pending.rememberPendingTerminalTurnEvent(agentDir, complete);
    pending.rememberPendingTerminalTurnEvent(agentDir, error);

    assert.equal(
      pending.takePendingTerminalTurnEvent(
        agentDir,
        { sessionFile: "/tmp/complete.jsonl" },
        { requestTag: "other" },
      ),
      null,
    );
    assert.deepEqual(
      pending.takePendingTerminalTurnEvent(
        agentDir,
        { sessionFile: "/tmp/complete.jsonl" },
        { requestTag: "tag-1" },
      ),
      complete,
    );
    assert.equal(
      pending.takePendingTerminalTurnEvent(agentDir, {
        sessionFile: "/tmp/complete.jsonl",
      }),
      null,
    );
    assert.equal(
      pending.clearPendingTerminalTurnEvent(agentDir, {
        sessionFile: "/tmp/error.jsonl",
      }),
      true,
    );
    assert.equal(
      pending.clearPendingTerminalTurnEvent(agentDir, {
        sessionFile: "/tmp/error.jsonl",
      }),
      false,
    );
  });
});

test("pending turn event state tolerates corrupt and stale records", async () => {
  await withAgentDir(async (agentDir) => {
    const statePath = pending.pendingTurnEventsStatePath(agentDir);
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, "not json");
    assert.equal(
      pending.takePendingTerminalTurnEvent(agentDir, {
        sessionFile: "/tmp/missing.jsonl",
      }),
      null,
    );

    await fs.writeFile(
      statePath,
      JSON.stringify({
        eventsBySessionFile: {
          " ": { type: "rpc_turn_event", event: "complete" },
          "/tmp/nonterminal.jsonl": {
            type: "rpc_turn_event",
            event: "heartbeat",
          },
          "/tmp/valid.jsonl": {
            type: "rpc_turn_event",
            event: "error",
            sessionFile: "/tmp/valid.jsonl",
          },
        },
      }),
    );
    assert.deepEqual(
      pending.takePendingTerminalTurnEvent(agentDir, {
        sessionFile: "/tmp/valid.jsonl",
      }),
      {
        type: "rpc_turn_event",
        event: "error",
        sessionFile: "/tmp/valid.jsonl",
      },
    );
  });
});
