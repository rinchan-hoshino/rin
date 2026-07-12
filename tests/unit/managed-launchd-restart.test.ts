import test from "node:test";
import assert from "node:assert/strict";

import { runManagedLaunchdServiceAction } from "../../dist/core/rin/managed-runtime-service.js";

function createContext(
  options: {
    bootoutFails?: boolean;
    bootstrapFails?: boolean;
    kickstartFails?: boolean;
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
          throw new Error("service already loaded");
        }
        return "";
      },
      exec(argv: string[]) {
        events.push(argv.join(" "));
        if (options.kickstartFails && argv[1] === "kickstart") {
          throw new Error("kickstart failed");
        }
      },
      async canConnectSocket() {
        events.push("socket-probe");
        return false;
      },
    },
  };
}

const service = {
  kind: "launchd" as const,
  label: "com.rin.daemon.demo",
  path: "/Users/demo/Library/LaunchAgents/com.rin.daemon.demo.plist",
};

test("launchd restart reloads the managed plist before kickstarting the job", async () => {
  const { context, events } = createContext();

  const result = await runManagedLaunchdServiceAction(
    context as any,
    service,
    "restart",
    { resolveDomain: () => "gui/501" },
  );

  assert.equal(result, service.label);
  assert.deepEqual(events, [
    "launchctl bootout gui/501/com.rin.daemon.demo",
    "launchctl bootstrap gui/501 /Users/demo/Library/LaunchAgents/com.rin.daemon.demo.plist",
    "launchctl kickstart -k gui/501/com.rin.daemon.demo",
  ]);
});

test("launchd restart still kickstarts when the job was not loaded", async () => {
  const { context, events } = createContext({ bootoutFails: true });

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
    "launchctl bootstrap gui/501 /Users/demo/Library/LaunchAgents/com.rin.daemon.demo.plist",
    "launchctl kickstart -k gui/501/com.rin.daemon.demo",
  ]);
});

test("launchd restart kickstarts an already loaded job when bootstrap cannot reload it", async () => {
  const { context, events } = createContext({
    bootoutFails: true,
    bootstrapFails: true,
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
    "launchctl bootstrap gui/501 /Users/demo/Library/LaunchAgents/com.rin.daemon.demo.plist",
    "launchctl kickstart -k gui/501/com.rin.daemon.demo",
  ]);
});
