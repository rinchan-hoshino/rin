import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after, mock } from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";
import { createSocketTestSandbox } from "../support/socket-test-sandbox.js";

const socketSandbox = createSocketTestSandbox("launch-owner");
after(() => socketSandbox.cleanup());

const launch = await importBuiltModule<
  typeof import("../../src/core/rin/launch.js")
>("dist/core/rin/launch.js");
const shared = await importBuiltModule<
  typeof import("../../src/core/rin/shared.js")
>("dist/core/rin/shared.js");

function parsed(overrides: Record<string, unknown> = {}) {
  return {
    command: "",
    targetUser: os.userInfo().username,
    targetName: "",
    installDir: "/tmp/rin-owner-install",
    passthrough: [],
    explicitUser: true,
    explicitTarget: false,
    hasSavedInstall: false,
    releaseChannel: "stable",
    releaseBranch: "",
    releaseVersion: "",
    explicitReleaseChannel: false,
    updateAssumeYes: false,
    ...overrides,
  } as any;
}

test("maintenance mode notice keeps useful daemon failure detail", () => {
  assert.equal(
    launch.formatMaintenanceModeNotice(new Error(" socket refused ")),
    [
      "Rin daemon is unavailable (socket refused).",
      "Entering temporary maintenance mode.",
      "Some features may be unavailable or not match daemon/RPC behavior.",
    ].join("\n"),
  );
  assert.match(
    launch.formatMaintenanceModeNotice(""),
    /^Rin daemon is unavailable\./,
  );
});

test("TUI launch arguments preserve the current Node executable and passthrough", () => {
  assert.deepEqual(
    launch.buildDirectTuiArgs("/repo/dist/app/rin-tui/main.js", {
      passthrough: ["--resume", "session-1"],
    }),
    [
      process.execPath,
      "/repo/dist/app/rin-tui/main.js",
      "--resume",
      "session-1",
    ],
  );
});

test("cross-user CLI delegation excludes same-user and remote-target routes", () => {
  assert.equal(
    launch.shouldDelegateCrossUserCli(
      parsed({ targetUser: "runtime-owner", explicitTarget: false }),
      "invoker",
    ),
    true,
  );
  assert.equal(
    launch.shouldDelegateCrossUserCli(
      parsed({ targetUser: "invoker", explicitTarget: false }),
      "invoker",
    ),
    false,
  );
  assert.equal(
    launch.shouldDelegateCrossUserCli(
      parsed({ targetUser: "runtime-owner", explicitTarget: true }),
      "invoker",
    ),
    false,
  );
});

test("TUI runtime environment selects explicit Rin dirs only for matching users", () => {
  const currentUser = os.userInfo().username;
  const previousRinDir = process.env.RIN_DIR;
  try {
    process.env.RIN_DIR = "/tmp/current-rin-agent";
    assert.equal(
      launch.buildTuiRuntimeEnv(currentUser, currentUser).RIN_DIR,
      "/tmp/current-rin-agent",
    );
    assert.equal(
      launch.buildTuiRuntimeEnv("different-owner", currentUser, "/srv/rin")
        .RIN_DIR,
      "/srv/rin",
    );
    assert.equal(
      launch.buildTuiRuntimeEnv("different-owner", currentUser).RIN_DIR,
      "/tmp/current-rin-agent",
    );
  } finally {
    if (previousRinDir === undefined) delete process.env.RIN_DIR;
    else process.env.RIN_DIR = previousRinDir;
  }
});

test("launch environment reports success and maintenance fallback without mutating env", async () => {
  const runtimeEnv = { RIN_DIR: "/tmp/agent" };
  const context = {} as any;
  let calls = 0;
  const available = await launch.resolveTuiLaunchEnvironment(
    context,
    runtimeEnv,
    {
      assertDaemonAvailable: async (received) => {
        calls += 1;
        assert.equal(received, context);
      },
    },
  );
  assert.deepEqual(available, { runtimeEnv });

  const unavailable = await launch.resolveTuiLaunchEnvironment(
    context,
    runtimeEnv,
    {
      assertDaemonAvailable: async () => {
        throw new Error("not ready");
      },
    },
  );
  assert.deepEqual(unavailable.runtimeEnv, {
    ...runtimeEnv,
    RIN_TUI_RUNTIME_ROLE: "maintenance-tui",
  });
  assert.match(unavailable.maintenanceModeNotice || "", /not ready/);
  assert.equal(calls, 1);

  let forcedProbeCalls = 0;
  const forced = await launch.resolveTuiLaunchEnvironment(context, runtimeEnv, {
    forceMaintenance: true,
    assertDaemonAvailable: async () => {
      forcedProbeCalls += 1;
    },
  });
  assert.deepEqual(forced.runtimeEnv, {
    ...runtimeEnv,
    RIN_TUI_RUNTIME_ROLE: "maintenance-tui",
  });
  assert.equal(forcedProbeCalls, 0);
});

test("cross-user CLI delegation runs the target CLI entry with stripped arguments", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-cli-delegate-owner-"),
  );
  const managedNode = path.join(
    installDir,
    "runtime",
    "node",
    "current",
    process.platform === "win32" ? "node.exe" : "bin/node",
  );
  await fs.mkdir(path.dirname(managedNode), { recursive: true });
  await fs.writeFile(managedNode, "");
  const spawnCalls: any[][] = [];
  const spawn = mock.method(childProcess, "spawn", (...values: any[]) => {
    spawnCalls.push(values);
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0, null));
    return child as any;
  });
  syncBuiltinESMExports();
  try {
    const code = await launch.delegateRinCliToTarget(parsed({ installDir }), [
      "usage",
      "--days",
      "7",
    ]);
    assert.equal(code, 0);
  } finally {
    spawn.mock.restore();
    syncBuiltinESMExports();
    process.exitCode = 0;
    await fs.rm(installDir, { recursive: true, force: true });
  }
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0][0], managedNode);
  assert.ok(
    spawnCalls[0][1].some((value: string) =>
      value.endsWith("dist/app/rin/main.js"),
    ),
  );
  assert.deepEqual(spawnCalls[0][1].slice(-3), ["usage", "--days", "7"]);
});

test("default launch refuses an uninstalled implicit target before spawning", async () => {
  await assert.rejects(
    () =>
      launch.launchDefaultRin(
        parsed({ explicitUser: false, hasSavedInstall: false }),
      ),
    /rin_not_installed:.*rin-install/,
  );
  assert.match(
    String(
      path.basename(
        launch.buildDirectTuiArgs("/repo/tui.js", { passthrough: [] })[1],
      ),
    ),
    /tui\.js/,
  );
});

test("default launch runs the selected TUI command and returns its exit code", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-launch-owner-"),
  );
  const args = parsed({ installDir, passthrough: ["--help"] });
  const socketPath = shared.createTargetExecutionContext(args).socketPath;
  socketSandbox.assertOwnedSocketPath(socketPath);
  await fs.mkdir(path.dirname(socketPath), { recursive: true });
  await socketSandbox.removeOwnedSocket(socketPath);
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  const spawnCalls: any[][] = [];
  const spawn = mock.method(childProcess, "spawn", (...values: any[]) => {
    spawnCalls.push(values);
    const child = new EventEmitter() as EventEmitter & {
      killed: boolean;
      kill: () => boolean;
    };
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      return true;
    };
    queueMicrotask(() => child.emit("exit", 7, null));
    return child as any;
  });
  const exits: number[] = [];
  const exit = mock.method(process, "exit", ((code?: number) => {
    exits.push(code ?? 0);
  }) as never);
  syncBuiltinESMExports();
  try {
    await launch.launchDefaultRin(args);
  } finally {
    spawn.mock.restore();
    syncBuiltinESMExports();
    exit.mock.restore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await socketSandbox.removeOwnedSocket(socketPath);
    await fs.rm(installDir, { recursive: true, force: true });
  }

  assert.equal(spawnCalls.length, 1);
  assert.ok(spawnCalls[0][1].includes("--help"));
  assert.ok(
    spawnCalls[0][1].some((value: string) =>
      value.endsWith("dist/app/rin-tui/main.js"),
    ),
  );
  assert.deepEqual(exits, [7]);
});
