import test from "node:test";
import assert from "node:assert/strict";

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
    }),
    /rin_launchd_daemon_stop_incomplete/,
  );

  assert.deepEqual(events, [
    "launchctl bootout gui/501/com.rin.daemon.demo",
    "launchctl bootout /Users/demo/Library/LaunchAgents/com.rin.daemon.demo.plist",
    "socket-probe",
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
