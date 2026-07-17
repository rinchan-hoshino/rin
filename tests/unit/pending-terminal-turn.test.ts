import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

type ReplayCommand = {
  type: "replay_pending_terminal_turn_event";
  sessionFile?: string;
  sessionId?: string;
};

const pendingTurn = await importBuiltModule<{
  replayPendingTerminalTurnEvent(
    request: ((command: ReplayCommand) => Promise<unknown>) | undefined,
    ref:
      | string
      | { sessionFile?: string; sessionId?: string }
      | null
      | undefined,
  ): Promise<boolean>;
}>("dist/core/rin-frontend-sdk/pending-terminal-turn.js");

test("pending terminal turn replay rejects missing requester or selector", async () => {
  assert.equal(
    await pendingTurn.replayPendingTerminalTurnEvent(undefined, {
      sessionFile: "/tmp/session.jsonl",
    }),
    false,
  );

  let requests = 0;
  assert.equal(
    await pendingTurn.replayPendingTerminalTurnEvent(async () => {
      requests += 1;
      return { replayed: true };
    }, null),
    false,
  );
  assert.equal(requests, 0);
});

test("pending terminal turn replay sends only normalized selector fields", async () => {
  const commands: ReplayCommand[] = [];
  const request = async (command: ReplayCommand) => {
    commands.push(command);
    return { replayed: true };
  };

  assert.equal(
    await pendingTurn.replayPendingTerminalTurnEvent(request, {
      sessionFile: " /tmp/session.jsonl ",
    }),
    true,
  );
  assert.equal(
    await pendingTurn.replayPendingTerminalTurnEvent(request, {
      sessionId: " session-id ",
    }),
    true,
  );
  assert.equal(
    await pendingTurn.replayPendingTerminalTurnEvent(request, {
      sessionFile: "/tmp/both.jsonl",
      sessionId: "both-id",
    }),
    true,
  );
  assert.deepEqual(commands, [
    {
      type: "replay_pending_terminal_turn_event",
      sessionFile: "/tmp/session.jsonl",
    },
    { type: "replay_pending_terminal_turn_event", sessionId: "session-id" },
    {
      type: "replay_pending_terminal_turn_event",
      sessionFile: "/tmp/both.jsonl",
      sessionId: "both-id",
    },
  ]);
});

test("pending terminal turn replay converts request failures and responses to replay truth", async () => {
  assert.equal(
    await pendingTurn.replayPendingTerminalTurnEvent(
      async () => Promise.reject(new Error("offline")),
      "session-id",
    ),
    false,
  );
  assert.equal(
    await pendingTurn.replayPendingTerminalTurnEvent(
      async () => ({ replayed: 0 }),
      "session-id",
    ),
    false,
  );
});
