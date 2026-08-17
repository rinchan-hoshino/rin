import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { sessionActivityState } from "../../dist/core/session/activity-status.js";

const base = {
  agentDir: "/tmp/rin-agent",
  daemonReachable: true,
  sessionFile: "/tmp/rin-agent/sessions/current.jsonl",
  localTurnActive: false,
};

test("session activity follows only the selected session worker", () => {
  assert.equal(
    sessionActivityState({ ...base, daemonReachable: false }),
    "unavailable",
  );
  assert.equal(
    sessionActivityState({ ...base, sessionFile: undefined }),
    "not started",
  );
  assert.equal(
    sessionActivityState({
      ...base,
      sessionFile: undefined,
      localTurnActive: true,
    }),
    "working",
  );
  assert.equal(
    sessionActivityState({ ...base, activity: { workers: [] } }),
    "idle",
  );
  assert.equal(
    sessionActivityState({
      ...base,
      activity: {
        workers: [
          {
            sessionFile: "/tmp/rin-agent/sessions/old.jsonl",
            turnActive: true,
          },
          { sessionFile: base.sessionFile, turnActive: false },
        ],
      },
    }),
    "idle",
  );
  assert.equal(
    sessionActivityState({
      ...base,
      activity: {
        workers: [{ sessionFile: base.sessionFile, turnActive: true }],
      },
    }),
    "working",
  );
  assert.equal(
    sessionActivityState({
      ...base,
      activity: {
        workers: [{ sessionFile: base.sessionFile, isCompacting: true }],
      },
    }),
    "compacting",
  );
  assert.equal(
    sessionActivityState({
      ...base,
      activity: {
        workers: [
          { sessionFile: base.sessionFile, gracefulShutdownRequested: true },
        ],
      },
    }),
    "stopping",
  );
});
