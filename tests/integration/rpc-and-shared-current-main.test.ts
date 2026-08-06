import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
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
const control = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "control.js")).href
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

test("rpc builtin slash commands compose Pi commands with Rin-only overlay", () => {
  const names = rpc.BUILTIN_SLASH_COMMANDS.map((command) => command.name);
  assert.equal(names.includes("clone"), true);
  assert.equal(names.includes("trust"), true);
  assert.equal(
    rpc.BUILTIN_SLASH_COMMANDS.find((command) => command.name === "quit")
      ?.description,
    "Quit rin",
  );
  assert.deepEqual(
    rpc.RIN_BUILTIN_SLASH_COMMANDS.map((command) => command.name),
    ["help", "abort", "usage", "status"],
  );
  assert.equal(names.includes("todos"), false);
  assert.equal(rpc.isGenericPromptRunCommandBuiltinSlashCommand("usage"), true);
  assert.equal(
    rpc.isGenericPromptRunCommandBuiltinSlashCommand("todos"),
    false,
  );
  assert.equal(
    rpc.isGenericPromptRunCommandBuiltinSlashCommand("model"),
    false,
  );
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

test("assertDaemonAvailable observes a ready daemon without lifecycle mutation", async () => {
  const execCalls: string[][] = [];
  await shared.assertDaemonAvailable({
    targetUser: "demo",
    canConnectSocket: async () => true,
    exec: (argv: string[]) => execCalls.push(argv),
  } as any);
  assert.deepEqual(execCalls, []);
});

test("assertDaemonAvailable reports an unavailable daemon without lifecycle mutation", async () => {
  const execCalls: string[][] = [];
  await assert.rejects(
    shared.assertDaemonAvailable({
      targetUser: "demo",
      systemctl: "/usr/bin/systemctl",
      managedServiceUnits: ["rin-daemon-demo.service"],
      canConnectSocket: async () => false,
      exec: (argv: string[]) => execCalls.push(argv),
    } as any),
    /rin_daemon_unavailable: managed daemon service is unavailable for demo/,
  );
  assert.deepEqual(execCalls, []);
});

test("target execution context ignores current RIN_DIR for cross-user commands", () => {
  const previousRinDir = process.env.RIN_DIR;
  const currentUser = os.userInfo().username;
  const installDir = "/srv/rin-target";

  try {
    process.env.RIN_DIR = "/tmp/current-user-rin";
    const sameUserContext = shared.createTargetExecutionContext({
      targetUser: currentUser,
      installDir,
    } as any);
    assert.equal(sameUserContext.agentDir, "/tmp/current-user-rin");
    assert.equal(sameUserContext.runtimeEnv.RIN_DIR, "/tmp/current-user-rin");

    const crossUserContext = shared.createTargetExecutionContext({
      targetUser: `${currentUser}-daemon`,
      installDir,
    } as any);
    assert.equal(crossUserContext.agentDir, installDir);
    assert.equal(crossUserContext.runtimeEnv.RIN_DIR, installDir);

    const crossUserTuiEnv = launch.buildTuiRuntimeEnv(
      `${currentUser}-daemon`,
      currentUser,
      installDir,
    );
    assert.equal(crossUserTuiEnv.RIN_DIR, installDir);
  } finally {
    if (previousRinDir === undefined) delete process.env.RIN_DIR;
    else process.env.RIN_DIR = previousRinDir;
  }
});

test("managed runtime service manifest reads cross-user installer metadata with privilege", () => {
  const installDir = "/home/rin/.rin";
  const service = control.readManagedRuntimeService({
    installDir,
    targetUser: "rin",
    currentUser: "operator",
    readJson() {
      throw new Error("current_user_reader_must_not_be_used");
    },
    readPrivilegedJson(filePath: string, fallback: any) {
      assert.equal(filePath, path.join(installDir, "installer.json"));
      assert.deepEqual(fallback, {});
      return {
        service: {
          kind: "systemd",
          label: "rin-daemon-rin.service",
          path: "/home/rin/.config/systemd/user/rin-daemon-rin.service",
        },
      };
    },
  } as any);

  assert.deepEqual(service, {
    kind: "systemd",
    label: "rin-daemon-rin.service",
    path: "/home/rin/.config/systemd/user/rin-daemon-rin.service",
  });
});

test("shared reuses installer common repo helpers", async () => {
  assert.equal(shared.repoRootFromHere(), installCommon.repoRootFromHere());
  assert.equal(
    await shared.runCommand(process.execPath, ["-e", ""], { stdio: "ignore" }),
    0,
  );
});

test("shared loadInstallConfigForHome prefers launcher metadata and ignores retired config manifests", async () => {
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
    assert.deepEqual(shared.loadInstallConfigForHome(home), {});
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

test("TUI launch observes daemon availability without starting the managed service", async () => {
  const executed: string[][] = [];
  let probes = 0;
  const context = {
    systemctl: "/usr/bin/systemctl",
    managedServiceUnits: ["rin-daemon-rin.service"],
    exec(argv: string[]) {
      executed.push(argv);
    },
    async canConnectSocket() {
      probes += 1;
      return probes > 1;
    },
  } as any;

  const unavailable = await launch.resolveTuiLaunchEnvironment(context, {
    BASE: "1",
  } as any);

  assert.deepEqual(executed, []);
  assert.equal(probes, 1);
  assert.equal(unavailable.runtimeEnv.BASE, "1");
  assert.equal(unavailable.runtimeEnv.RIN_TUI_RUNTIME_ROLE, "maintenance-tui");
  assert.match(unavailable.maintenanceModeNotice, /Rin daemon is unavailable/);
  assert.match(
    unavailable.maintenanceModeNotice,
    /Entering temporary maintenance mode\./,
  );
});

test("tui runtime env targets only the Rin runtime root", () => {
  const currentUser = os.userInfo().username;
  const installDir = installPaths.defaultInstallDirForHome(os.homedir());
  const env = launch.buildTuiRuntimeEnv(currentUser, "THE_cattail", installDir);
  assert.equal(env.RIN_DIR, installDir);
  assert.equal("RIN_INVOKING_SYSTEM_USER" in env, false);
  assert.equal("RIN_DAEMON_SOCKET_PATH" in env, false);
  assert.equal("PI_CODING_AGENT_DIR" in env, false);
});

test("tui runtime env preserves explicit Rin dir override only", () => {
  const currentUser = os.userInfo().username;
  const previousRinDir = process.env.RIN_DIR;

  try {
    process.env.RIN_DIR = "/tmp/custom-rin-dir";
    const rinEnv = launch.buildTuiRuntimeEnv(
      currentUser,
      "THE_cattail",
      installPaths.defaultInstallDirForHome(os.homedir()),
    );
    assert.equal(rinEnv.RIN_DIR, "/tmp/custom-rin-dir");
    assert.equal("PI_CODING_AGENT_DIR" in rinEnv, false);
  } finally {
    if (previousRinDir === undefined) delete process.env.RIN_DIR;
    else process.env.RIN_DIR = previousRinDir;
  }
});
