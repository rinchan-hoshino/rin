import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const rpc = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "rpc.js")).href
);
const shared = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "shared.js")).href
);
const installCommon = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-install", "common.js"))
    .href
);
const launch = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "launch.js")).href
);
const installPaths = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-install", "paths.js"))
    .href
);

test("rpc helpers build success and failure envelopes", () => {
  assert.deepEqual(rpc.ok("1", "get_state", { ok: true }), {
    id: "1",
    type: "response",
    command: "get_state",
    success: true,
    data: { ok: true },
  });
  assert.deepEqual(rpc.fail("2", "prompt", new Error("boom")), {
    id: "2",
    type: "response",
    command: "prompt",
    success: false,
    error: "boom",
  });
  assert.deepEqual(rpc.fail("3", "prompt", { error: "bad_state" }), {
    id: "3",
    type: "response",
    command: "prompt",
    success: false,
    error: "bad_state",
  });
  assert.deepEqual(rpc.fail("4", "prompt", { message: "  " }), {
    id: "4",
    type: "response",
    command: "prompt",
    success: false,
    error: "rin_request_failed",
  });
});

test("rpc helpers normalize scoped commands and return fresh empty session state", () => {
  assert.equal(rpc.isSessionScopedCommand(" reload "), true);
  assert.equal(rpc.isSessionScopedCommand(" nope "), false);

  const first = rpc.emptySessionState();
  const second = rpc.emptySessionState();
  first.pendingMessageCount = 9;
  first.sessionId = "changed";

  assert.equal(second.pendingMessageCount, 0);
  assert.equal(second.sessionId, "");
  assert.notEqual(first, second);
});

test("shared resolveParsedArgs keeps passthrough and install defaults coherent", () => {
  const parsed = shared.resolveParsedArgs("", { user: "demo" }, [
    "--foo",
    "bar",
  ]);
  assert.equal(parsed.targetUser, "demo");
  assert.deepEqual(parsed.passthrough, ["--foo", "bar"]);
  assert.deepEqual(
    shared.stripRinWrapperArgs(["--user=demo", "usage", "--limit", "5"]),
    ["usage", "--limit", "5"],
  );
  assert.deepEqual(shared.stripRinWrapperArgs(["--session=old"]), [
    "--session=old",
  ]);
  assert.equal(
    shared.installConfigPath(),
    installPaths.launcherMetadataPathForHome(os.homedir()),
  );
  assert.equal(
    shared.resolveInstallDirForTarget({ ...parsed, installDir: "" }),
    installPaths.defaultInstallDirForHome(os.homedir()),
  );
});

test("ensureDaemonAvailable uses the managed service without spawning an unmanaged daemon", async () => {
  const execCalls: string[][] = [];
  let socketChecks = 0;
  await shared.ensureDaemonAvailable({
    targetUser: "demo",
    systemctl: "/usr/bin/systemctl",
    managedServiceUnits: ["rin-daemon-demo.service"],
    canConnectSocket: async () => ++socketChecks > 1,
    exec: (argv: string[]) => execCalls.push(argv),
  } as any);
  assert.deepEqual(execCalls, [
    ["/usr/bin/systemctl", "--user", "start", "rin-daemon-demo.service"],
  ]);
});

test("ensureDaemonAvailable does not spawn unmanaged daemon without a managed service", async () => {
  const execCalls: string[][] = [];
  await assert.rejects(
    shared.ensureDaemonAvailable({
      targetUser: "demo",
      systemctl: "",
      managedServiceUnits: [],
      canConnectSocket: async () => false,
      exec: (argv: string[]) => execCalls.push(argv),
    } as any),
    /rin_daemon_unavailable: managed daemon service did not become available for demo/,
  );
  assert.deepEqual(execCalls, []);
});

test("shared reuses installer common repo helpers", async () => {
  assert.equal(shared.repoRootFromHere(), installCommon.repoRootFromHere());
  assert.equal(
    await shared.runCommand(process.execPath, ["-e", ""], { stdio: "ignore" }),
    0,
  );
});

test("shared loadInstallConfigForHome prefers launcher metadata candidates and recovers installer manifests", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "rin-shared-home-"));
  try {
    await fs.mkdir(path.join(home, ".rin"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".rin", "installer.json"),
      JSON.stringify({ targetUser: "demo" }),
      "utf8",
    );
    assert.deepEqual(shared.loadInstallConfigForHome(home), {
      defaultTargetUser: "demo",
      defaultInstallDir: installPaths.defaultInstallDirForHome(home),
    });

    await fs.mkdir(path.join(home, ".config", "rin"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".config", "rin", "install.json"),
      JSON.stringify({
        defaultTargetUser: "launcher-demo",
        defaultInstallDir: "/srv/launcher-demo",
      }),
      "utf8",
    );
    assert.deepEqual(shared.loadInstallConfigForHome(home), {
      defaultTargetUser: "launcher-demo",
      defaultInstallDir: "/srv/launcher-demo",
    });

    await fs.rm(path.join(home, ".config", "rin", "install.json"), {
      force: true,
    });
    await fs.mkdir(path.join(home, "Library", "Application Support", "rin"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(home, "Library", "Application Support", "rin", "install.json"),
      JSON.stringify({
        defaultTargetUser: "mac-launcher-demo",
        defaultInstallDir: "/srv/mac-launcher-demo",
      }),
      "utf8",
    );
    assert.deepEqual(shared.loadInstallConfigForHome(home), {
      defaultTargetUser: "mac-launcher-demo",
      defaultInstallDir: "/srv/mac-launcher-demo",
    });

    await fs.rm(
      path.join(home, "Library", "Application Support", "rin", "install.json"),
      { force: true },
    );
    await fs.rm(path.join(home, ".rin", "installer.json"), { force: true });
    await fs.mkdir(path.join(home, ".rin", "config"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".rin", "config", "installer.json"),
      JSON.stringify({
        targetUser: "demo",
        installDir: "/srv/rin-demo",
      }),
      "utf8",
    );
    assert.deepEqual(shared.loadInstallConfigForHome(home), {
      defaultTargetUser: "demo",
      defaultInstallDir: "/srv/rin-demo",
    });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("tui launch helpers target the direct TUI runner", () => {
  assert.deepEqual(
    launch.buildDirectTuiArgs("/repo/dist/app/rin-tui/main.js", {
      passthrough: ["--foo", "bar"],
    }),
    [process.execPath, "/repo/dist/app/rin-tui/main.js", "--foo", "bar"],
  );
});

test("TUI launch environment enables maintenance mode only when the daemon is unavailable", async () => {
  const available = await launch.resolveTuiLaunchEnvironment(
    {} as any,
    { BASE: "1" } as any,
    { ensureDaemonAvailable: async () => undefined },
  );
  assert.equal(available.runtimeEnv.BASE, "1");
  assert.equal(available.runtimeEnv.RIN_TUI_RUNTIME_ROLE, "rpc-frontend");

  const unavailable = await launch.resolveTuiLaunchEnvironment(
    {} as any,
    { BASE: "1" } as any,
    {
      ensureDaemonAvailable: async () => {
        throw new Error("daemon down");
      },
    },
  );
  assert.equal(unavailable.runtimeEnv.BASE, "1");
  assert.equal(unavailable.runtimeEnv.RIN_TUI_RUNTIME_ROLE, "maintenance-tui");
  assert.match(
    unavailable.maintenanceModeNotice,
    /Rin daemon is unavailable \(daemon down\)\./,
  );
  assert.match(
    unavailable.maintenanceModeNotice,
    /Entering temporary maintenance mode\./,
  );
  assert.match(
    unavailable.maintenanceModeNotice,
    /features may be unavailable/,
  );
});

test("tui runtime env targets the target user's direct daemon socket", () => {
  const currentUser = os.userInfo().username;
  const installDir = installPaths.defaultInstallDirForHome(os.homedir());
  const env = launch.buildTuiRuntimeEnv(currentUser, "THE_cattail", installDir);
  assert.equal(env.RIN_DIR, installDir);
  assert.equal(env.PI_CODING_AGENT_DIR, installDir);
  assert.equal("RIN_INVOKING_SYSTEM_USER" in env, false);
  assert.ok(String(env.RIN_DAEMON_SOCKET_PATH || "").includes("rin-daemon"));
  assert.ok(!String(env.RIN_DAEMON_SOCKET_PATH || "").includes("bridge.sock"));
});

test("tui runtime env preserves explicit agent dir override precedence", () => {
  const currentUser = os.userInfo().username;
  const previousRinDir = process.env.RIN_DIR;
  const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;

  try {
    process.env.RIN_DIR = "/tmp/custom-rin-dir";
    delete process.env.PI_CODING_AGENT_DIR;
    const rinEnv = launch.buildTuiRuntimeEnv(
      currentUser,
      "THE_cattail",
      installPaths.defaultInstallDirForHome(os.homedir()),
    );
    assert.equal(rinEnv.RIN_DIR, "/tmp/custom-rin-dir");
    assert.equal(rinEnv.PI_CODING_AGENT_DIR, "/tmp/custom-rin-dir");

    process.env.RIN_DIR = "   ";
    process.env.PI_CODING_AGENT_DIR = "/tmp/custom-pi-dir";
    const piEnv = launch.buildTuiRuntimeEnv(
      currentUser,
      "THE_cattail",
      installPaths.defaultInstallDirForHome(os.homedir()),
    );
    assert.equal(piEnv.RIN_DIR, "/tmp/custom-pi-dir");
    assert.equal(piEnv.PI_CODING_AGENT_DIR, "/tmp/custom-pi-dir");
  } finally {
    if (previousRinDir === undefined) delete process.env.RIN_DIR;
    else process.env.RIN_DIR = previousRinDir;
    if (previousPiAgentDir === undefined)
      delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
  }
});
