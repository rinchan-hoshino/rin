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
    status?: any;
  } = {},
) {
  const events: string[] = [];
  return {
    events,
    context: {
      targetUser: "demo",
      agentDir: "/Users/demo/.rin",
      socketPath: "/Users/demo/Library/Caches/rin-daemon/daemon.sock",
      async queryDaemonStatus() {
        return options.status;
      },
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

test("launchd restart waits for the old daemon to stop before bootstrapping", async () => {
  const { context, events } = createContext();

  const result = await runManagedLaunchdServiceAction(
    context as any,
    service,
    "restart",
    {
      resolveDomain: () => "gui/501",
      async waitForDaemonUnavailable() {
        events.push("wait-for-daemon-unavailable");
        return true;
      },
    },
  );

  assert.equal(result, service.label);
  assert.deepEqual(events, [
    "launchctl bootout gui/501/com.rin.daemon.demo",
    "wait-for-daemon-unavailable",
    "launchctl bootstrap gui/501 /Users/demo/Library/LaunchAgents/com.rin.daemon.demo.plist",
  ]);
});

test("launchd restart fails before bootstrap when the old daemon remains live", async () => {
  const { context, events } = createContext();

  await assert.rejects(
    runManagedLaunchdServiceAction(context as any, service, "restart", {
      resolveDomain: () => "gui/501",
      async waitForDaemonUnavailable() {
        events.push("wait-for-daemon-unavailable");
        return false;
      },
    }),
    /rin_launchd_daemon_stop_incomplete/,
  );

  assert.deepEqual(events, [
    "launchctl bootout gui/501/com.rin.daemon.demo",
    "wait-for-daemon-unavailable",
  ]);
});

test("launchd restart replaces an obsolete quiescing daemon after bounded shutdown fails", async () => {
  const { context, events } = createContext({
    status: { chat: { quiescing: true } },
  });
  const unavailable = [false, true];

  const result = await runManagedLaunchdServiceAction(
    context as any,
    service,
    "restart",
    {
      resolveDomain: () => "gui/501",
      async waitForDaemonUnavailable() {
        events.push("wait-for-daemon-unavailable");
        return unavailable.shift() ?? false;
      },
      forceStopDaemon() {
        events.push("force-stop-obsolete-daemon");
        return true;
      },
    },
  );

  assert.equal(result, service.label);
  assert.deepEqual(events, [
    "launchctl bootout gui/501/com.rin.daemon.demo",
    "wait-for-daemon-unavailable",
    "force-stop-obsolete-daemon",
    "wait-for-daemon-unavailable",
    "launchctl bootstrap gui/501 /Users/demo/Library/LaunchAgents/com.rin.daemon.demo.plist",
  ]);
});

test("launchd restart refuses a stale migration lock owner without socket ownership", async () => {
  const { context, events } = createContext({
    status: { chat: { quiescing: true } },
  });
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
        async waitForDaemonUnavailable() {
          events.push("wait-for-daemon-unavailable");
          return false;
        },
      }),
      /rin_launchd_daemon_stop_incomplete/,
    );
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }

  assert.deepEqual(events, [
    "launchctl bootout gui/501/com.rin.daemon.demo",
    "wait-for-daemon-unavailable",
    "/usr/sbin/lsof -a -p 999999 -U -Fn",
  ]);
});

test("launchd restart does not force-stop a current daemon", async () => {
  const { context, events } = createContext({ status: { chat: {} } });

  await assert.rejects(
    runManagedLaunchdServiceAction(context as any, service, "restart", {
      resolveDomain: () => "gui/501",
      async waitForDaemonUnavailable() {
        events.push("wait-for-daemon-unavailable");
        return false;
      },
      forceStopDaemon() {
        events.push("force-stop-obsolete-daemon");
        return true;
      },
    }),
    /rin_launchd_daemon_stop_incomplete/,
  );

  assert.deepEqual(events, [
    "launchctl bootout gui/501/com.rin.daemon.demo",
    "wait-for-daemon-unavailable",
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

test("launchd restart fails when an unowned daemon remains live", async () => {
  const { context, events } = createContext({
    bootoutFails: true,
    socketReady: true,
  });

  await assert.rejects(
    runManagedLaunchdServiceAction(context as any, service, "restart", {
      resolveDomain: () => "gui/501",
      async waitForDaemonUnavailable() {
        events.push("wait-for-daemon-unavailable");
        return false;
      },
    }),
    /rin_launchd_daemon_stop_incomplete/,
  );

  assert.deepEqual(events, [
    "launchctl bootout gui/501/com.rin.daemon.demo",
    "launchctl bootout /Users/demo/Library/LaunchAgents/com.rin.daemon.demo.plist",
    "socket-probe",
    "wait-for-daemon-unavailable",
  ]);
});

test("launchd restart propagates bootstrap failures", async () => {
  const { context, events } = createContext({ bootstrapFails: true });

  await assert.rejects(
    runManagedLaunchdServiceAction(context as any, service, "restart", {
      resolveDomain: () => "gui/501",
      async waitForDaemonUnavailable() {
        events.push("wait-for-daemon-unavailable");
        return true;
      },
    }),
    /bootstrap failed/,
  );

  assert.deepEqual(events, [
    "launchctl bootout gui/501/com.rin.daemon.demo",
    "wait-for-daemon-unavailable",
    "launchctl bootstrap gui/501 /Users/demo/Library/LaunchAgents/com.rin.daemon.demo.plist",
  ]);
});
