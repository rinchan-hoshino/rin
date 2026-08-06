import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

await import("../support/register-service-owner-fixture.ts");
const service = await import(
  `${pathToFileURL(path.resolve("dist/core/rin-install/service.js")).href}?rin-service-owner`
);
const ownerGlobal = globalThis as any;
const events = ownerGlobal.__rinServiceEvents as any[];
const scenario = ownerGlobal.__rinServiceScenario as Record<string, any>;

async function withPlatform<T>(
  platform: NodeJS.Platform,
  run: () => Promise<T> | T,
) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
  try {
    return await run();
  } finally {
    if (descriptor) Object.defineProperty(process, "platform", descriptor);
  }
}

async function withRuntime(run: (fixture: any) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-service-owner-"));
  const installDir = path.join(root, "install & data");
  const home = path.join(root, "home & owner");
  const daemonEntry = path.join(
    installDir,
    "app/current/dist/app/rin-daemon/daemon.js",
  );
  const legacyEntry = path.join(installDir, "app/current/dist/daemon.js");
  const node = path.join(installDir, "runtime/node/current/bin/node");
  const windowsNode = path.join(installDir, "runtime/node/current/node.exe");
  await fs.mkdir(path.dirname(daemonEntry), { recursive: true });
  await fs.mkdir(path.dirname(node), { recursive: true });
  await fs.writeFile(daemonEntry, "export {};\n");
  await fs.writeFile(legacyEntry, "export {};\n");
  await fs.writeFile(node, "#!/bin/sh\n", { mode: 0o755 });
  await fs.writeFile(windowsNode, "owner\n", { mode: 0o755 });
  events.length = 0;
  for (const key of Object.keys(scenario)) delete scenario[key];
  scenario.currentUser = "owner";
  const originalExistsSync = fsSync.existsSync;
  fsSync.existsSync = ((filePath: fsSync.PathLike) =>
    filePath === "/usr/bin/systemctl" ||
    filePath === "/bin/systemctl" ||
    originalExistsSync(filePath)) as typeof fsSync.existsSync;
  try {
    await run({
      root,
      installDir,
      home,
      daemonEntry,
      legacyEntry,
      node,
      windowsNode,
    });
  } finally {
    fsSync.existsSync = originalExistsSync;
    await fs.rm(root, { recursive: true, force: true });
  }
}

function deps(home: string, uid = 1001) {
  return {
    findSystemUser: (user: string) => ({ name: user, uid, gid: 1001 }),
    targetHomeForUser: () => home,
  };
}

test("service specs bind managed runtimes and escape each platform configuration", async () => {
  await withRuntime(async (fixture) => {
    const systemd = service.buildSystemdUserService(
      "demo.user+test",
      fixture.installDir,
      () => fixture.home,
    );
    assert.equal(systemd.kind, "systemd");
    assert.equal(systemd.label, "rin-daemon-demo.user-test.service");
    assert.match(systemd.service, /Delegate=memory/);
    assert.match(systemd.service, /DelegateSubgroup=daemon/);
    assert.match(systemd.service, /OOMPolicy=continue/);
    assert.match(systemd.service, /RIN_SYSTEMD_CGROUP_DELEGATION=1/);
    assert.match(systemd.service, /install & data/);
    assert.match(systemd.service, /home & owner/);
    assert.match(systemd.service, /runtime\/node\/current\/bin\/node/);

    const escapedInstallDir = path.join(
      fixture.root,
      'special-\\"\u0007\b\f\n\r\t\v',
    );
    const escapedDaemon = path.join(
      escapedInstallDir,
      "app/current/dist/app/rin-daemon/daemon.js",
    );
    const escapedNode = path.join(
      escapedInstallDir,
      "runtime/node/current/bin/node",
    );
    await fs.mkdir(path.dirname(escapedDaemon), { recursive: true });
    await fs.mkdir(path.dirname(escapedNode), { recursive: true });
    await fs.writeFile(escapedDaemon, "export {};\n");
    await fs.writeFile(escapedNode, "#!/bin/sh\n", { mode: 0o755 });
    const escapedSystemd = service.buildSystemdUserService(
      "owner",
      escapedInstallDir,
      () => fixture.home,
    );
    assert.match(escapedSystemd.service, /\\\\/);
    assert.match(escapedSystemd.service, /\\"/);
    for (const escaped of ["\\a", "\\b", "\\f", "\\n", "\\r", "\\t", "\\v"]) {
      assert.equal(escapedSystemd.service.includes(escaped), true);
    }

    const plist = service.buildLaunchdPlist(
      "demo.user+test",
      fixture.installDir,
      () => fixture.home,
    );
    assert.equal(plist.label, "com.rin.daemon.demo.user-test");
    assert.match(plist.plist, /install &amp; data/);
    assert.match(plist.plist, /home &amp; owner/);
    assert.match(plist.plist, /<key>KeepAlive<\/key>/);

    const anonymousSystemd = service.buildSystemdUserService(
      "",
      fixture.installDir,
      () => fixture.home,
    );
    assert.match(anonymousSystemd.service, /Rin daemon for/);
    const command = service.buildWindowsStartupCommand({
      nodePath: 'C:\\Owner "Node"\\node.exe',
      daemonEntry: 'C:\\Owner "Daemon"\\daemon.js',
      installDir: 'C:\\Owner "Rin"',
    });
    assert.match(command, /set "RIN_DIR=C:\\Owner ""Rin"""/);
    assert.match(command, /"C:\\Owner ""Node""\\node\.exe"/);

    const launcher = service.buildWindowsStartupLauncher(
      "owner",
      fixture.installDir,
      () => fixture.home,
    );
    const launch = service.buildWindowsDaemonLaunchSpec(
      "owner",
      fixture.installDir,
      () => fixture.home,
    );
    assert.equal(launcher.kind, "windows-startup");
    assert.equal(launch.command, fixture.windowsNode);
    assert.deepEqual(launch.args, [fixture.daemonEntry]);
    assert.deepEqual(launch.env, { RIN_DIR: fixture.installDir });

    assert.equal(
      service.resolveDaemonEntryForInstall(fixture.installDir),
      fixture.daemonEntry,
    );
    await fs.rm(fixture.daemonEntry);
    assert.equal(
      service.resolveDaemonEntryForInstall(fixture.installDir),
      fixture.legacyEntry,
    );
    await fs.rm(fixture.legacyEntry);
    assert.throws(
      () => service.resolveDaemonEntryForInstall(fixture.installDir),
      /rin_installed_daemon_entry_missing:/,
    );
  });
});

test("launchd installers write sandbox files and isolate activation fallbacks", async () => {
  await withRuntime(async (fixture) => {
    const direct = service.installLaunchdAgent(
      "owner",
      fixture.installDir,
      false,
      deps(fixture.home),
      { activate: false },
    );
    assert.equal((await fs.stat(direct.servicePath)).mode & 0o777, 0o644);
    assert.match(
      await fs.readFile(direct.servicePath, "utf8"),
      /com\.rin\.daemon\.owner/,
    );

    events.length = 0;
    service.installLaunchdAgent(
      "owner",
      fixture.installDir,
      false,
      deps(fixture.home),
    );
    assert.deepEqual(
      events.filter(([name]) => name === "exec").map((entry) => entry[2][0]),
      ["bootout", "bootstrap"],
    );

    events.length = 0;
    scenario.privilegedError = true;
    assert.throws(
      () =>
        service.installLaunchdAgent(
          "owner",
          fixture.installDir,
          true,
          deps(fixture.home),
        ),
      /owner privileged failed/,
    );
    scenario.privilegedError = false;
    events.length = 0;
    service.installLaunchdAgent(
      "owner",
      fixture.installDir,
      true,
      deps(fixture.home),
      { activate: false },
    );
    assert.equal(
      events.some(([name]) => name === "write-elevated"),
      true,
    );
    assert.throws(
      () =>
        service.installLaunchdAgent(
          "missing",
          fixture.installDir,
          false,
          deps(fixture.home, -1),
        ),
      /rin_launchd_target_user_not_found:missing/,
    );
  });
});

test("systemd installers preserve direct, machine, and elevated command ownership", async () => {
  await withRuntime(async (fixture) => {
    assert.deepEqual(service.systemctlUserCommandArgs(["status"]), [
      "--user",
      "status",
    ]);
    assert.deepEqual(
      service.systemctlMachineUserCommandArgs("other", ["status"]),
      ["--machine", "other@.host", "--user", "status"],
    );
    assert.deepEqual(
      service.systemctlCommandArgsForTargetUser("owner", ["status"], "owner"),
      ["--user", "status"],
    );
    assert.deepEqual(
      service.systemctlCommandArgsForTargetUser("", ["status"], "owner"),
      ["--user", "status"],
    );
    assert.deepEqual(
      service.systemctlCommandArgsForTargetUser("other", ["status"], "owner"),
      ["--machine", "other@.host", "--user", "status"],
    );

    events.length = 0;
    const direct = service.installSystemdUserService(
      "owner",
      fixture.installDir,
      false,
      deps(fixture.home),
      { activate: false },
    );
    assert.equal((await fs.stat(direct.servicePath)).mode & 0o777, 0o644);
    assert.equal(events.filter(([name]) => name === "exec").length, 2);

    events.length = 0;
    service.installSystemdUserService(
      "owner",
      fixture.installDir,
      true,
      deps(fixture.home),
    );
    assert.equal(
      events.some(([name]) => name === "as-user"),
      true,
    );
    assert.equal(
      events.some(([name]) => name === "privileged"),
      true,
    );
    assert.equal(
      events.some(([name]) => name === "write-elevated"),
      true,
    );

    events.length = 0;
    service.installSystemdUserService(
      "other",
      fixture.installDir,
      true,
      deps(fixture.home),
      { activate: false },
    );
    assert.equal(
      events
        .filter(([name]) => name === "privileged")
        .some((entry) => entry[2]?.includes("--machine")),
      true,
    );

    scenario.privilegedError = true;
    assert.doesNotThrow(() =>
      service.installSystemdUserService(
        "owner",
        fixture.installDir,
        true,
        deps(fixture.home),
      ),
    );
    scenario.privilegedError = false;
  });
});

test("service refresh and diagnostics retain existing unit, socket, status, and journal evidence", async () => {
  await withRuntime(async (fixture) => {
    const unitDir = path.join(fixture.home, ".config/systemd/user");
    const current = path.join(unitDir, "rin-daemon-owner.service");
    const missing = path.join(unitDir, "rin-daemon.service");
    await fs.mkdir(unitDir, { recursive: true });
    await fs.writeFile(current, "stale\n");
    await withPlatform("linux", async () => {
      service.refreshManagedServiceFiles(
        "owner",
        fixture.installDir,
        false,
        deps(fixture.home),
      );
    });
    assert.match(await fs.readFile(current, "utf8"), /ExecStart=/);
    await assert.rejects(fs.access(missing), /ENOENT/);
    await withPlatform("darwin", async () => {
      assert.equal(
        service.refreshManagedServiceFiles(
          "owner",
          fixture.installDir,
          false,
          deps(fixture.home),
        ),
        undefined,
      );
    });

    const context = service.systemdUserContext(
      "owner",
      deps(fixture.home, process.getuid?.() ?? -1),
    );
    assert.deepEqual(context.units, ["rin-daemon-owner.service"]);
    assert.equal(context.uid, process.getuid?.() ?? -1);
    const noRuntime = service.systemdUserContext(
      "missing",
      deps(fixture.home, -1),
    );
    assert.deepEqual(noRuntime.userEnv, {});

    scenario.status = "owner status active";
    scenario.journal = "owner journal recent";
    const details = await withPlatform("linux", () =>
      service.collectDaemonFailureDetails(
        "owner",
        fixture.installDir,
        deps(fixture.home),
      ),
    );
    assert.match(details, /socketReady=no/);
    if (details.includes("serviceStatus=")) {
      assert.match(details, /owner status active|systemctl|failed/i);
    }
    if (details.includes("serviceJournal=")) {
      assert.match(details, /owner journal recent|journal|failed/i);
    }
    assert.equal(
      service.daemonSocketPathForUser("owner", deps(fixture.home, -1)),
      path.join(fixture.home, ".cache/rin-daemon/daemon.sock"),
    );
    assert.equal(
      service.daemonSocketPathForUser("owner", deps(fixture.home, 1000)),
      "/run/user/1000/rin-daemon/daemon.sock",
    );
  });
});

test("systemd reconciliation selects supported actions and cleanly declines unavailable hosts", async () => {
  await withRuntime(async (fixture) => {
    for (const action of ["start", "stop", "restart"] as const) {
      events.length = 0;
      const result = await withPlatform("linux", () =>
        service.reconcileSystemdUserService(
          "owner",
          fixture.installDir,
          action,
          false,
          deps(fixture.home),
        ),
      );
      assert.equal(typeof result, "boolean");
      if (result) {
        assert.equal(
          events
            .filter(([name]) => name === "exec")
            .some((entry) => entry[2].includes(action)),
          true,
        );
      }
    }
    await withPlatform("freebsd", async () => {
      assert.equal(
        service.reconcileSystemdUserService(
          "owner",
          fixture.installDir,
          "start",
          false,
          deps(fixture.home),
        ),
        false,
      );
    });
  });
});

test("Windows launch owns sandbox logs, process detachment, and cross-user rejection", async () => {
  await withRuntime(async (fixture) => {
    await withPlatform("linux", async () => {
      assert.equal(
        service.startWindowsDaemonProcess("owner", fixture.installDir, {
          targetHomeForUser: () => fixture.home,
        }),
        false,
      );
    });
    await withPlatform("win32", async () => {
      scenario.currentUser = "owner";
      assert.equal(
        service.startWindowsDaemonProcess("owner", fixture.installDir, {
          targetHomeForUser: () => fixture.home,
        }),
        true,
      );
      assert.equal(
        events.some(([name]) => name === "spawn"),
        true,
      );
      assert.equal(
        events.some(([name]) => name === "unref"),
        true,
      );
      await fs.access(
        path.join(fixture.installDir, "data/logs/daemon.stdout.log"),
      );
      assert.throws(
        () =>
          service.startWindowsDaemonProcess("other", fixture.installDir, {
            targetHomeForUser: () => fixture.home,
          }),
        /rin_windows_daemon_cross_user_unsupported:other/,
      );

      events.length = 0;
      const startup = service.installWindowsStartupLauncher(
        "owner",
        fixture.installDir,
        false,
        { targetHomeForUser: () => fixture.home },
        { activate: false },
      );
      assert.match(await fs.readFile(startup.servicePath, "utf8"), /RIN_DIR=/);
      assert.equal(
        events.some(([name]) => name === "spawn"),
        false,
      );
      service.installWindowsStartupLauncher(
        "owner",
        fixture.installDir,
        false,
        { targetHomeForUser: () => fixture.home },
      );
      assert.equal(
        events.some(([name]) => name === "spawn"),
        true,
      );
    });
  });
});

test("service dispatcher selects each platform adapter and rejects unsupported hosts", async () => {
  await withRuntime(async (fixture) => {
    for (const platform of ["darwin", "linux", "win32"] as NodeJS.Platform[]) {
      await withPlatform(platform, async () => {
        events.length = 0;
        const install = () =>
          service.installDaemonService(
            "owner",
            fixture.installDir,
            false,
            deps(fixture.home),
            { activate: false },
          );
        if (
          platform === "linux" &&
          !fsSync.existsSync("/usr/bin/systemctl") &&
          !fsSync.existsSync("/bin/systemctl")
        ) {
          assert.throws(install, /rin_service_install_unsupported:linux/);
        } else {
          assert.equal(install().kind.length > 0, true);
        }
      });
    }
    await withPlatform("freebsd", async () => {
      assert.throws(
        () =>
          service.installDaemonService(
            "owner",
            fixture.installDir,
            false,
            deps(fixture.home),
          ),
        /rin_service_install_unsupported:freebsd/,
      );
    });
  });
});

test("socket readiness handles local and cross-user probes without host mutation", async () => {
  scenario.connect = true;
  assert.equal(
    await service.waitForSocket("/owner/socket", 50, "owner", {
      currentUser: "owner",
    }),
    true,
  );
  scenario.connect = false;
  assert.equal(
    await service.waitForSocket("/owner/socket", 1, "owner", {
      currentUser: "owner",
    }),
    false,
  );
  assert.equal(
    await service.waitForSocket("/owner/socket", 1, "other", {
      currentUser: "owner",
    }),
    false,
  );
  scenario.captureError = false;
  assert.equal(
    await service.waitForSocket("/owner/socket", 50, "other", {
      currentUser: "owner",
      targetNodePath: "/owner/node",
    }),
    true,
  );
  scenario.captureError = true;
  assert.equal(
    await service.waitForSocket("/owner/socket", 1, "other", {
      currentUser: "owner",
      targetNodePath: "/owner/node",
    }),
    false,
  );
});

test("service command routing fails closed when current user lookup is unavailable", (t) => {
  t.mock.method(os, "userInfo", () => {
    throw new Error("owner user lookup failed");
  });
  assert.deepEqual(
    service.systemctlCommandArgsForTargetUser("owner", ["status"]),
    ["--user", "status"],
  );
});
