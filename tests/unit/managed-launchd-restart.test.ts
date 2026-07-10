import test from "node:test";
import assert from "node:assert/strict";

import { runManagedLaunchdServiceAction } from "../../dist/core/rin/managed-runtime-service.js";

function createContext(
  options: {
    kickstartFails?: boolean;
    serviceLoaded?: boolean;
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
        if (argv[1] === "print" && options.serviceLoaded === false) {
          throw new Error("service not loaded");
        }
        return "";
      },
      exec(argv: string[]) {
        events.push(argv.join(" "));
        if (
          options.kickstartFails &&
          argv[1] === "kickstart" &&
          argv[2] === "-k"
        ) {
          throw new Error("kickstart failed");
        }
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

test("launchd restart atomically hands replacement to launchd", async () => {
  const { context, events } = createContext();

  const result = await runManagedLaunchdServiceAction(
    context as any,
    service,
    "restart",
    { resolveDomain: () => "gui/501" },
  );

  assert.equal(result, service.label);
  assert.deepEqual(events, [
    "launchctl kickstart -k gui/501/com.rin.daemon.demo",
  ]);
});

test("launchd restart fails closed when atomic kickstart cannot replace a loaded job", async () => {
  const { context, events } = createContext({ kickstartFails: true });

  await assert.rejects(
    runManagedLaunchdServiceAction(context as any, service, "restart", {
      resolveDomain: () => "gui/501",
    }),
    /rin_launchd_restart_failed/,
  );

  assert.deepEqual(events, [
    "launchctl kickstart -k gui/501/com.rin.daemon.demo",
    "launchctl print gui/501/com.rin.daemon.demo",
  ]);
});

test("launchd restart bootstraps an unloaded job only when no daemon is live", async () => {
  const { context, events } = createContext({
    kickstartFails: true,
    serviceLoaded: false,
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
    "launchctl kickstart -k gui/501/com.rin.daemon.demo",
    "launchctl print gui/501/com.rin.daemon.demo",
    "socket-probe",
    "launchctl bootstrap gui/501 /Users/demo/Library/LaunchAgents/com.rin.daemon.demo.plist",
  ]);
});
