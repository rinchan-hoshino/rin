import test from "node:test";
import assert from "node:assert/strict";

import {
  activateDaemonRestart,
  captureDaemonRestartSnapshot,
  daemonChatStartedAt,
  isActivatedDaemonStatus,
  snapshotDaemonRestart,
  waitForActivatedDaemon,
} from "../../dist/core/rin/daemon-activation.js";

test("daemon generation reader accepts status values and response envelopes", () => {
  assert.equal(
    daemonChatStartedAt({ chat: { startedAt: "direct" } }),
    "direct",
  );
  assert.equal(
    daemonChatStartedAt({ data: { chat: { startedAt: "enveloped" } } }),
    "enveloped",
  );
});

test("daemon restart snapshot aborts before restart when a live generation is unavailable", () => {
  assert.deepEqual(snapshotDaemonRestart(undefined, false), {
    previousChatStartedAt: "",
    requireNewGeneration: false,
  });
  assert.deepEqual(
    snapshotDaemonRestart({ data: { chat: { startedAt: "existing" } } }, true),
    {
      previousChatStartedAt: "existing",
      requireNewGeneration: true,
    },
  );
  assert.throws(
    () => snapshotDaemonRestart(undefined, true),
    /rin_daemon_restart_snapshot_unavailable/,
  );
});

test("daemon restart snapshot retries transient status loss before activation", async () => {
  let queryCalls = 0;
  const snapshot = await captureDaemonRestartSnapshot({
    queryStatus: async () => {
      queryCalls += 1;
      return queryCalls === 1 ? undefined : { chat: { startedAt: "existing" } };
    },
    canConnect: async () => true,
    timeoutMs: 100,
    pollIntervalMs: 10,
  });

  assert.deepEqual(snapshot, {
    previousChatStartedAt: "existing",
    requireNewGeneration: true,
  });
  assert.equal(queryCalls, 2);
});

test("daemon restart snapshot distinguishes confirmed absence from unavailable live status", async () => {
  let absenceProbeCalls = 0;
  assert.deepEqual(
    await captureDaemonRestartSnapshot({
      queryStatus: async () => undefined,
      canConnect: async () => {
        absenceProbeCalls += 1;
        return false;
      },
      timeoutMs: 100,
      pollIntervalMs: 10,
      absenceConfirmMs: 10,
    }),
    { previousChatStartedAt: "", requireNewGeneration: false },
  );
  assert.equal(absenceProbeCalls, 2);

  let zeroWindowProbeCalls = 0;
  await captureDaemonRestartSnapshot({
    queryStatus: async () => undefined,
    canConnect: async () => {
      zeroWindowProbeCalls += 1;
      return false;
    },
    timeoutMs: 100,
    pollIntervalMs: 10,
    absenceConfirmMs: 0,
  });
  assert.equal(zeroWindowProbeCalls, 2);

  await assert.rejects(
    captureDaemonRestartSnapshot({
      queryStatus: async () => undefined,
      canConnect: async () => true,
      timeoutMs: 0,
    }),
    /rin_daemon_restart_snapshot_unavailable/,
  );
});

test("daemon restart snapshot does not false-pass a query error and one failed socket probe", async () => {
  let queryCalls = 0;
  const snapshot = await captureDaemonRestartSnapshot({
    queryStatus: async () => {
      queryCalls += 1;
      if (queryCalls === 1) throw new Error("transient query failure");
      return { chat: { startedAt: "existing" } };
    },
    canConnect: async () => false,
    timeoutMs: 200,
    pollIntervalMs: 10,
    absenceConfirmMs: 100,
  });

  assert.equal(snapshot.previousChatStartedAt, "existing");
  assert.equal(queryCalls, 2);
});

test("daemon restart snapshot preserves false-probe evidence across an indeterminate probe", async () => {
  let probeCalls = 0;
  const snapshot = await captureDaemonRestartSnapshot({
    queryStatus: async () => undefined,
    canConnect: async () => {
      probeCalls += 1;
      if (probeCalls === 2) throw new Error("indeterminate probe");
      return false;
    },
    timeoutMs: 100,
    pollIntervalMs: 10,
    absenceConfirmMs: 0,
  });

  assert.equal(snapshot.requireNewGeneration, false);
  assert.equal(probeCalls, 3);
});

test("daemon restart snapshot never treats a generation-less status response as absence", async () => {
  let probeCalls = 0;
  await assert.rejects(
    captureDaemonRestartSnapshot({
      queryStatus: async () => ({ chat: { ready: true } }),
      canConnect: async () => {
        probeCalls += 1;
        return false;
      },
      timeoutMs: 30,
      pollIntervalMs: 10,
      absenceConfirmMs: 10,
    }),
    /rin_daemon_restart_snapshot_unavailable/,
  );
  assert.equal(probeCalls, 0);
});

test("daemon restart snapshot bounds individual status and socket operations", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    captureDaemonRestartSnapshot({
      queryStatus: async () => await new Promise(() => {}),
      canConnect: async () => await new Promise(() => {}),
      timeoutMs: 30,
      operationTimeoutMs: 10,
      pollIntervalMs: 10,
    }),
    /rin_daemon_restart_snapshot_unavailable/,
  );
  assert.ok(Date.now() - startedAt < 150);
});

test("daemon restart snapshot never probes or accepts absence after its total deadline", async () => {
  let probeCalls = 0;
  await assert.rejects(
    captureDaemonRestartSnapshot({
      queryStatus: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return undefined;
      },
      canConnect: async () => {
        probeCalls += 1;
        return false;
      },
      timeoutMs: 10,
      operationTimeoutMs: 50,
    }),
    /rin_daemon_restart_snapshot_unavailable/,
  );
  assert.equal(probeCalls, 0);
});

test("daemon activation requires a different ready chat generation", () => {
  const previousStartedAt = "2026-07-10T04:08:23.458Z";

  assert.equal(
    isActivatedDaemonStatus(
      { chat: { ready: true, startedAt: previousStartedAt } },
      previousStartedAt,
      true,
    ),
    false,
  );
  assert.equal(
    isActivatedDaemonStatus(
      {
        chat: {
          ready: true,
          startedAt: "2026-07-10T09:30:00.000Z",
        },
      },
      previousStartedAt,
      true,
    ),
    true,
  );
  assert.equal(
    isActivatedDaemonStatus(
      {
        chat: {
          ready: true,
          stopping: true,
          startedAt: "2026-07-10T09:30:00.000Z",
        },
      },
      previousStartedAt,
      true,
    ),
    false,
  );
});

test("daemon activation fails closed when a live predecessor has no generation id", () => {
  assert.equal(
    isActivatedDaemonStatus(
      { chat: { ready: true, startedAt: "new-or-unchanged" } },
      "",
      true,
    ),
    false,
  );
  assert.equal(
    isActivatedDaemonStatus(
      { chat: { ready: true, startedAt: "first-generation" } },
      "",
      false,
    ),
    true,
  );
});

test("daemon activation polling rejects the original process and accepts its replacement", async () => {
  const previousStartedAt = "2026-07-10T04:08:23.458Z";
  let calls = 0;
  const result = await waitForActivatedDaemon(
    async () => {
      calls += 1;
      return {
        chat: {
          ready: true,
          startedAt:
            calls === 1 ? previousStartedAt : "2026-07-10T09:30:00.000Z",
        },
      };
    },
    {
      previousChatStartedAt: previousStartedAt,
      requireNewGeneration: true,
      timeoutMs: 100,
      pollIntervalMs: 10,
    },
  );

  assert.equal(result.activated, true);
  assert.equal(calls, 2);
});

test("daemon restart returns only after replacement activation is verified", async () => {
  const result = await activateDaemonRestart({
    previousChatStartedAt: "old",
    requireNewGeneration: true,
    restart: async () => "com.rin.daemon.demo",
    queryStatus: async () => ({
      chat: { ready: true, startedAt: "new" },
    }),
    timeoutMs: 0,
    activationError: "replacement unverified",
  });

  assert.equal(result, "com.rin.daemon.demo");
});

test("daemon restart rejects an unverified replacement without rollback state", async () => {
  await assert.rejects(
    activateDaemonRestart({
      previousChatStartedAt: "old",
      requireNewGeneration: true,
      restart: async () => "com.rin.daemon.demo",
      queryStatus: async () => ({
        chat: { ready: true, startedAt: "old" },
      }),
      timeoutMs: 0,
      activationError: "replacement unverified",
    }),
    /replacement unverified/,
  );
});
