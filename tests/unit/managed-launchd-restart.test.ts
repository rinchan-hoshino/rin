import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runManagedLaunchdServiceAction } from "../../dist/core/rin/managed-runtime-service.js";

function createContext(
  options: {
    bootoutFails?: boolean;
    bootstrapFails?: boolean;
    socketReady?: boolean;
  } = {},
) {
  const events: string[] = [];
  return {
    events,
    context: {
      targetUser: "demo",
      agentDir: "/Users/demo/.rin",
      socketPath: "/Users/demo/Library/Caches/rin-daemon/daemon.sock",
      capture(argv: string[]) {
        events.push(argv.join(" "));
        if (argv[1] === "bootout" && options.bootoutFails) {
          throw new Error("service not loaded");
        }
        if (argv[1] === "bootstrap" && options.bootstrapFails) {
          throw new Error("bootstrap failed");
        }
        return "";
      },
      exec(argv: string[]) {
        events.push(argv.join(" "));
      },
      async canConnectSocket() {
        events.push("socket-probe");
        return options.socketReady === true;
      },
    },
  };
}

const service = {
  kind: "launchd" as const,
  label: "com.rin.daemon.demo",
  path: "/Users/demo/Library/LaunchAgents/com.rin.daemon.demo.plist",
};

function waitSequence(events: string[], results: boolean[]) {
  let index = 0;
  return async (_context: unknown, timeoutMs?: number) => {
    events.push(`wait-for-daemon-unavailable:${timeoutMs}`);
    return results[index++] ?? false;
  };
}

function forceResult(events: string[], result: boolean) {
  return () => {
    events.push("force-stop-lock-owner");
    return result;
  };
}

test("launchd restart bootstraps after graceful daemon shutdown", async () => {
  const { context, events } = createContext();

  const result = await runManagedLaunchdServiceAction(
    context as any,
    service,
    "restart",
    {
      resolveDomain: () => "gui/501",
      waitForDaemonUnavailable: waitSequence(events, [true]) as any,
      forceStopDaemon: forceResult(events, true),
    } as any,
  );

  assert.equal(result, service.label);
  assert.deepEqual(events, [
    "launchctl bootout gui/501/com.rin.daemon.demo",
    "wait-for-daemon-unavailable:5000",
    "launchctl bootstrap gui/501 /Users/demo/Library/LaunchAgents/com.rin.daemon.demo.plist",
  ]);
});

test("launchd restart force-stops a lock-owned daemon that ignores graceful shutdown", async () => {
  const { context, events } = createContext();

  const result = await runManagedLaunchdServiceAction(
    context as any,
    service,
    "restart",
    {
      resolveDomain: () => "gui/501",
      waitForDaemonUnavailable: waitSequence(events, [false, true]) as any,
      forceStopDaemon: forceResult(events, true),
    } as any,
  );

  assert.equal(result, service.label);
  assert.deepEqual(events, [
    "launchctl bootout gui/501/com.rin.daemon.demo",
    "wait-for-daemon-unavailable:5000",
    "force-stop-lock-owner",
    "wait-for-daemon-unavailable:5000",
    "launchctl bootstrap gui/501 /Users/demo/Library/LaunchAgents/com.rin.daemon.demo.plist",
  ]);
});

test("launchd restart force-stops an orphaned lock owner after its job is gone", async () => {
  const { context, events } = createContext({
    bootoutFails: true,
    socketReady: true,
  });

  const result = await runManagedLaunchdServiceAction(
    context as any,
    service,
    "restart",
    {
      resolveDomain: () => "gui/501",
      waitForDaemonUnavailable: waitSequence(events, [false, true]) as any,
      forceStopDaemon: forceResult(events, true),
    } as any,
  );

  assert.equal(result, service.label);
  assert.deepEqual(events, [
    "launchctl bootout gui/501/com.rin.daemon.demo",
    "launchctl bootout /Users/demo/Library/LaunchAgents/com.rin.daemon.demo.plist",
    "socket-probe",
    "wait-for-daemon-unavailable:5000",
    "force-stop-lock-owner",
    "wait-for-daemon-unavailable:5000",
    "launchctl bootstrap gui/501 /Users/demo/Library/LaunchAgents/com.rin.daemon.demo.plist",
  ]);
});

test("launchd restart fails closed without a verified lock owner", async () => {
  const { context, events } = createContext();

  await assert.rejects(
    runManagedLaunchdServiceAction(context as any, service, "restart", {
      resolveDomain: () => "gui/501",
      waitForDaemonUnavailable: waitSequence(events, [false]) as any,
      forceStopDaemon: forceResult(events, false),
    } as any),
    /rin_launchd_daemon_stop_incomplete/,
  );

  assert.deepEqual(events, [
    "launchctl bootout gui/501/com.rin.daemon.demo",
    "wait-for-daemon-unavailable:5000",
    "force-stop-lock-owner",
  ]);
});

test("launchd restart refuses a stale lock owner that does not own the socket", async () => {
  const { context, events } = createContext();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "rin-launchd-lock-"));
  context.agentDir = agentDir;
  const lockDir = path.join(agentDir, "data", "core", "daemon", "daemon.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    path.join(lockDir, "owner.json"),
    JSON.stringify({
      pid: 999_999,
      socketPath: context.socketPath,
      token: "stale",
    }),
  );

  try {
    await assert.rejects(
      runManagedLaunchdServiceAction(context as any, service, "restart", {
        resolveDomain: () => "gui/501",
        waitForDaemonUnavailable: waitSequence(events, [false]) as any,
      }),
      /rin_launchd_daemon_stop_incomplete/,
    );
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }

  assert.deepEqual(events, [
    "launchctl bootout gui/501/com.rin.daemon.demo",
    "wait-for-daemon-unavailable:5000",
    "/usr/sbin/lsof -a -p 999999 -U -Fn",
  ]);
});

test("launchd restart fails if the forced daemon still owns the socket", async () => {
  const { context, events } = createContext();

  await assert.rejects(
    runManagedLaunchdServiceAction(context as any, service, "restart", {
      resolveDomain: () => "gui/501",
      waitForDaemonUnavailable: waitSequence(events, [false, false]) as any,
      forceStopDaemon: forceResult(events, true),
    } as any),
    /rin_launchd_daemon_stop_incomplete/,
  );

  assert.deepEqual(events, [
    "launchctl bootout gui/501/com.rin.daemon.demo",
    "wait-for-daemon-unavailable:5000",
    "force-stop-lock-owner",
    "wait-for-daemon-unavailable:5000",
  ]);
});

test("launchd restart bootstraps an unloaded job when no daemon is live", async () => {
  const { context, events } = createContext({
    bootoutFails: true,
    socketReady: false,
  });

  const result = await runManagedLaunchdServiceAction(
    context as any,
    service,
    "restart",
    { resolveDomain: () => "gui/501" },
  );

  assert.equal(result, service.label);
  assert.deepEqual(events, [
    "launchctl bootout gui/501/com.rin.daemon.demo",
    "launchctl bootout /Users/demo/Library/LaunchAgents/com.rin.daemon.demo.plist",
    "socket-probe",
    "launchctl bootstrap gui/501 /Users/demo/Library/LaunchAgents/com.rin.daemon.demo.plist",
  ]);
});

test("launchd restart propagates bootstrap failures", async () => {
  const { context, events } = createContext({ bootstrapFails: true });

  await assert.rejects(
    runManagedLaunchdServiceAction(context as any, service, "restart", {
      resolveDomain: () => "gui/501",
      waitForDaemonUnavailable: waitSequence(events, [true]) as any,
      forceStopDaemon: forceResult(events, true),
    } as any),
    /bootstrap failed/,
  );

  assert.deepEqual(events, [
    "launchctl bootout gui/501/com.rin.daemon.demo",
    "wait-for-daemon-unavailable:5000",
    "launchctl bootstrap gui/501 /Users/demo/Library/LaunchAgents/com.rin.daemon.demo.plist",
  ]);
});
