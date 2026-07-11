import test from "node:test";
import assert from "node:assert/strict";

import {
  activateDaemonRestart,
  daemonChatStartedAt,
  isActivatedDaemonStatus,
  snapshotDaemonRestart,
  waitForActivatedDaemon,
} from "../../dist/core/rin/daemon-activation.js";

test("daemon restart snapshot requires a generation for a live daemon", () => {
  assert.equal(
    daemonChatStartedAt({ data: { chat: { startedAt: "existing" } } }),
    "existing",
  );
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
      { chat: { ready: true, startedAt: "new" } },
      previousStartedAt,
      true,
    ),
    true,
  );
  assert.equal(
    isActivatedDaemonStatus(
      { chat: { ready: true, stopping: true, startedAt: "new" } },
      previousStartedAt,
      true,
    ),
    false,
  );
});

test("daemon activation polling rejects the original process and accepts its replacement", async () => {
  const previousStartedAt = "old";
  let calls = 0;
  const result = await waitForActivatedDaemon(
    async () => {
      calls += 1;
      return {
        chat: {
          ready: true,
          startedAt: calls === 1 ? previousStartedAt : "new",
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

test("daemon restart rejects an unverified replacement", async () => {
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
