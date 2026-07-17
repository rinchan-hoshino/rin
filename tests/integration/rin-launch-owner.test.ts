import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

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
      ensureDaemonAvailable: async (received) => {
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
      ensureDaemonAvailable: async () => {
        throw new Error("not ready");
      },
    },
  );
  assert.equal(unavailable.runtimeEnv, runtimeEnv);
  assert.match(unavailable.maintenanceModeNotice || "", /not ready/);
  assert.equal(calls, 1);
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
  await fs.mkdir(path.dirname(socketPath), { recursive: true });
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
