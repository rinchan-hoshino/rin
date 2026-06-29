import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const control = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "control.js")).href
);

function createSystemdContext(socketAvailable: () => boolean) {
  const events: string[] = [];
  return {
    context: {
      repoRoot: rootDir,
      installDir: "/opt/rin",
      agentDir: "/opt/rin",
      targetUser: "demo",
      targetHome: "/home/demo",
      runtimeEnv: {},
      systemctl: "/usr/bin/systemctl",
      socketPath: "/tmp/rin-daemon-demo.sock",
      managedServiceUnits: ["rin-daemon-demo.service"],
      currentUser: "demo",
      isTargetUser: true,
      readJson(filePath: string, fallback: any) {
        assert.equal(filePath, path.join("/opt/rin", "installer.json"));
        assert.deepEqual(fallback, {});
        return {
          service: {
            kind: "systemd",
            label: "rin-daemon-demo.service",
          },
        };
      },
      readPrivilegedJson() {
        throw new Error("privileged reader should not be used");
      },
      capture(argv: string[]) {
        events.push(`capture:${argv.join(" ")}`);
        assert.doesNotEqual(argv[2], "status");
        return "";
      },
      exec(argv: string[]) {
        events.push(`exec:${argv.join(" ")}`);
        throw Object.assign(new Error("systemctl command failed"), {
          stderr: "systemctl reported a transient failure\n",
        });
      },
      canConnectSocket: async () => socketAvailable(),
      queryDaemonStatus: async () => ({}),
    },
    events,
  };
}

async function captureWarnings(fn: () => Promise<void>) {
  const warnings: string[] = [];
  const previousError = console.error;
  const previousLog = console.log;
  console.error = (...args: any[]) => warnings.push(args.join(" "));
  console.log = () => {};
  try {
    await fn();
  } finally {
    console.error = previousError;
    console.log = previousLog;
  }
  return warnings;
}

test("rin restart warns instead of failing when service control fails but daemon is reachable", async () => {
  const { context, events } = createSystemdContext(() => true);

  const warnings = await captureWarnings(async () => {
    await control.runLifecycleActionForContext(context as any, "restart");
  });

  assert.deepEqual(events, [
    "capture:/usr/bin/systemctl --user daemon-reload",
    "exec:/usr/bin/systemctl --user restart rin-daemon-demo.service",
  ]);
  assert.match(warnings.join("\n"), /managed service control reported failure/);
  assert.match(warnings.join("\n"), /rin-daemon-demo\.service/);
});

test("rin stop warns instead of failing when service control fails but daemon becomes unreachable", async () => {
  const { context, events } = createSystemdContext(() => false);

  const warnings = await captureWarnings(async () => {
    await control.runLifecycleActionForContext(context as any, "stop");
  });

  assert.deepEqual(events, [
    "capture:/usr/bin/systemctl --user daemon-reload",
    "exec:/usr/bin/systemctl --user stop rin-daemon-demo.service",
  ]);
  assert.match(warnings.join("\n"), /managed service control reported failure/);
  assert.match(warnings.join("\n"), /rin-daemon-demo\.service/);
});
