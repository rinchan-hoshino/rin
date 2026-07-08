import test from "node:test";
import assert from "node:assert/strict";

import {
  formatActiveDaemonWorkers,
  listActiveDaemonWorkers,
  waitForDaemonDrain,
} from "../../dist/core/rin/daemon-drain.js";

test("daemon drain treats active turn workers as not drainable", async () => {
  const workers = listActiveDaemonWorkers({
    workers: [
      { sessionId: "idle", state: "idle" },
      { sessionId: "active", state: "working", turnActive: true },
    ],
  });

  assert.equal(workers.length, 1);
  assert.equal(formatActiveDaemonWorkers(workers), "active(working)");
});

test("daemon drain ignores display-only working state without explicit active work", async () => {
  const workers = listActiveDaemonWorkers({
    workers: [
      { sessionId: "summary", state: "working" },
      { sessionId: "rin", state: "working", rinWorking: true },
    ],
  });

  assert.deepEqual(workers, []);
});

test("daemon drain requires quiescing status when requested", async () => {
  const result = await waitForDaemonDrain({
    pollIntervalMs: 100,
    timeoutMs: 1000,
    requireQuiescing: true,
    queryStatus: async () => ({
      workers: [],
      chat: { quiescing: false },
    }),
  });

  assert.equal(result.drained, false);
  assert.equal(result.quiesceUnavailable, true);
});

test("daemon drain accepts quiesced idle status", async () => {
  const result = await waitForDaemonDrain({
    pollIntervalMs: 100,
    timeoutMs: 1000,
    requireQuiescing: true,
    queryStatus: async () => ({
      workers: [],
      chat: { quiescing: true },
    }),
  });

  assert.equal(result.drained, true);
});

test("daemon drain waits until active workers become idle", async () => {
  let calls = 0;
  const result = await waitForDaemonDrain({
    pollIntervalMs: 100,
    timeoutMs: 1000,
    queryStatus: async () => {
      calls += 1;
      return calls < 3
        ? {
            workers: [
              { sessionId: "active", state: "working", turnActive: true },
            ],
          }
        : { workers: [{ sessionId: "active", state: "idle" }] };
    },
  });

  assert.equal(result.drained, true);
  assert.equal(calls, 3);
});

test("daemon drain fails closed when daemon status is unavailable", async () => {
  const result = await waitForDaemonDrain({
    pollIntervalMs: 100,
    timeoutMs: 1000,
    queryStatus: async () => undefined,
  });

  assert.equal(result.drained, false);
  assert.equal(result.statusUnavailable, true);
});

test("daemon drain fails closed when daemon status provider throws", async () => {
  const result = await waitForDaemonDrain({
    pollIntervalMs: 100,
    timeoutMs: 1000,
    queryStatus: async () => {
      throw new Error("status failed");
    },
  });

  assert.equal(result.drained, false);
  assert.equal(result.statusUnavailable, true);
});

test("daemon drain times out instead of killing active workers", async () => {
  const result = await waitForDaemonDrain({
    pollIntervalMs: 100,
    timeoutMs: 150,
    queryStatus: async () => ({
      workers: [{ sessionId: "active", state: "working", turnActive: true }],
    }),
  });

  assert.equal(result.drained, false);
  assert.equal(result.activeWorkers.length, 1);
});
