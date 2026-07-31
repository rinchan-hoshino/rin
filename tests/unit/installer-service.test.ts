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
const service = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-install", "service.js"))
    .href
);
const managedService = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-install", "managed-service.js"),
  ).href
);

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-install-service-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeXml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

test("waitForSocket probes a cross-user daemon with the target runtime node", async () => {
  const invocations = [];
  const ok = await service.waitForSocket(
    "/run/user/1001/rin-daemon/daemon.sock",
    100,
    "rin",
    {
      currentUser: "THE_cattail",
      targetNodePath: "/home/rin/.rin/runtime/node/current/bin/node",
      captureCommandAsUser: (targetUser, command, args) => {
        invocations.push({ targetUser, command, args });
        return "";
      },
    },
  );

  assert.equal(ok, true);
  assert.deepEqual(invocations, [
    {
      targetUser: "rin",
      command: "/home/rin/.rin/runtime/node/current/bin/node",
      args: ["-e", invocations[0].args[1]],
    },
  ]);
  assert.match(invocations[0].args[1], /net\.createConnection/);
});

test("installer service helpers prefer current daemon entry, quote systemd values, and escape plist XML", async () => {
  await withTempDir(async (dir) => {
    const installDir = path.join(dir, "install & data");
    const targetLinuxHome = "/home/demo space";
    const targetMacHome = "/Users/demo & test";
    const currentDaemon = path.join(
      installDir,
      "app",
      "current",
      "dist",
      "app",
      "rin-daemon",
      "daemon.js",
    );
    const managedNode = path.join(
      installDir,
      "runtime",
      "node",
      "current",
      "bin",
      "node",
    );
    const managedWindowsNode = path.join(
      installDir,
      "runtime",
      "node",
      "current",
      "node.exe",
    );
    await fs.mkdir(path.dirname(currentDaemon), { recursive: true });
    await fs.mkdir(path.dirname(managedNode), { recursive: true });
    await fs.writeFile(currentDaemon, "export {};\n", "utf8");
    await fs.writeFile(managedNode, "#!/bin/sh\n", { mode: 0o755 });
    await fs.writeFile(managedWindowsNode, "", { mode: 0o755 });

    const oldPath = process.env.PATH;
    let spec;
    let plist;
    try {
      process.env.PATH =
        "/home/THE_cattail/.local/bin:/tmp/installer-only-bin:/usr/bin";
      spec = service.buildSystemdUserService(
        "demo.user+test",
        installDir,
        () => targetLinuxHome,
      );
      plist = service.buildLaunchdPlist(
        "demo.user+test",
        installDir,
        () => targetMacHome,
      );
    } finally {
      process.env.PATH = oldPath;
    }
    const windowsHome = path.join("C:\\Users", "demo space");
    const windowsStartup = service.buildWindowsStartupLauncher(
      "demo.user+test",
      installDir,
      () => windowsHome,
    );
    const windowsDaemonLaunch = service.buildWindowsDaemonLaunchSpec(
      "demo.user+test",
      installDir,
      () => windowsHome,
    );

    assert.equal(spec.kind, "systemd");
    assert.equal(spec.label, "rin-daemon-demo.user-test.service");
    assert.ok(
      spec.servicePath.endsWith(
        path.join(
          targetLinuxHome,
          ".config",
          "systemd",
          "user",
          "rin-daemon-demo.user-test.service",
        ),
      ),
    );
    assert.match(
      spec.service,
      new RegExp(`^WorkingDirectory=${escapeRegex(targetLinuxHome)}$`, "m"),
    );
    assert.match(
      spec.service,
      new RegExp(`^Environment="RIN_DIR=${escapeRegex(installDir)}"$`, "m"),
    );
    assert.match(
      spec.service,
      /^ConditionPathExists=!%t\/rin-daemon\/update\.lock$/m,
    );
    assert.match(
      spec.service,
      new RegExp(
        `^ExecStart="${escapeRegex(managedNode)}" "${escapeRegex(currentDaemon)}"$`,
        "m",
      ),
    );
    assert.doesNotMatch(spec.service, /\/usr\/bin\/env|"node"/);
    assert.match(spec.service, /^Environment="PATH=.+"$/m);
    assert.match(
      spec.service,
      /^Environment="RIN_SYSTEMD_CGROUP_DELEGATION=1"$/m,
    );
    assert.match(spec.service, /^Delegate=memory$/m);
    assert.match(spec.service, /^DelegateSubgroup=daemon$/m);
    assert.match(spec.service, /^OOMPolicy=continue$/m);
    assert.ok(spec.service.includes(`${targetLinuxHome}/.local/bin`));
    assert.equal(spec.service.includes("/home/THE_cattail"), false);
    assert.equal(spec.service.includes("/tmp/installer-only-bin"), false);

    assert.equal(plist.label, "com.rin.daemon.demo.user-test");
    assert.ok(
      plist.plistPath.endsWith(
        path.join(
          "Library",
          "LaunchAgents",
          "com.rin.daemon.demo.user-test.plist",
        ),
      ),
    );
    assert.ok(
      plist.plist.includes(`<string>${escapeXml(managedNode)}</string>`),
    );
    assert.equal(plist.plist.includes(`<string>/usr/bin/env</string>`), false);
    assert.equal(plist.plist.includes(`<string>node</string>`), false);
    assert.ok(
      plist.plist.includes(`<string>${escapeXml(currentDaemon)}</string>`),
    );
    assert.ok(plist.plist.includes(`<key>PATH</key>`));
    assert.ok(plist.plist.includes(`${escapeXml(targetMacHome)}/.local/bin`));
    assert.equal(plist.plist.includes("/home/THE_cattail"), false);
    assert.equal(plist.plist.includes("/tmp/installer-only-bin"), false);
    assert.ok(
      plist.plist.includes(`<string>${escapeXml(installDir)}</string>`),
    );
    assert.ok(
      plist.plist.includes(`<string>${escapeXml(targetMacHome)}</string>`),
    );

    assert.equal(windowsStartup.kind, "windows-startup");
    assert.equal(
      windowsStartup.stdoutPath,
      path.join(installDir, "data", "logs", "daemon.stdout.log"),
    );
    assert.equal(
      windowsStartup.stderrPath,
      path.join(installDir, "data", "logs", "daemon.stderr.log"),
    );
    assert.ok(
      windowsStartup.servicePath.endsWith(
        path.join(
          "AppData",
          "Roaming",
          "Microsoft",
          "Windows",
          "Start Menu",
          "Programs",
          "Startup",
          "Rin Daemon.cmd",
        ),
      ),
    );
    assert.match(windowsStartup.service, /^@echo off\r?$/m);
    assert.match(
      windowsStartup.service,
      /^set "RIN_DIR=.*install & data"\r?$/m,
    );
    assert.match(windowsStartup.service, /start "" \/min /);
    assert.match(
      windowsStartup.service,
      new RegExp(escapeRegex(currentDaemon)),
    );
    assert.equal(windowsDaemonLaunch.command, managedWindowsNode);
    assert.deepEqual(windowsDaemonLaunch.args, [currentDaemon]);
    assert.equal(windowsDaemonLaunch.cwd, windowsHome);
    assert.deepEqual(windowsDaemonLaunch.env, { RIN_DIR: installDir });
    assert.equal(windowsDaemonLaunch.stdoutPath, windowsStartup.stdoutPath);
    assert.equal(windowsDaemonLaunch.stderrPath, windowsStartup.stderrPath);
  });
});

test("core update can write a launchd service without activating it early", async () => {
  await withTempDir(async (dir) => {
    const installDir = path.join(dir, "install");
    const targetHome = path.join(dir, "home");
    const currentDaemon = path.join(
      installDir,
      "app",
      "current",
      "dist",
      "app",
      "rin-daemon",
      "daemon.js",
    );
    const managedNode = path.join(
      installDir,
      "runtime",
      "node",
      "current",
      "bin",
      "node",
    );
    await fs.mkdir(path.dirname(currentDaemon), { recursive: true });
    await fs.mkdir(path.dirname(managedNode), { recursive: true });
    await fs.writeFile(currentDaemon, "export {};\n", "utf8");
    await fs.writeFile(managedNode, "#!/bin/sh\n", { mode: 0o755 });

    const spec = service.installLaunchdAgent(
      "demo",
      installDir,
      false,
      {
        findSystemUser: () => ({ uid: 501, gid: 20, home: targetHome }),
        targetHomeForUser: () => targetHome,
      },
      { activate: false },
    );

    assert.equal(spec.kind, "launchd");
    assert.match(
      await fs.readFile(spec.servicePath, "utf8"),
      /<string>com\.rin\.daemon\.demo<\/string>/,
    );
  });
});

test("installer service uses managed node runtime when present", async () => {
  await withTempDir(async (dir) => {
    const installDir = path.join(dir, "install");
    const targetHome = "/home/demo";
    const currentDaemon = path.join(
      installDir,
      "app",
      "current",
      "dist",
      "app",
      "rin-daemon",
      "daemon.js",
    );
    const managedNode = path.join(
      installDir,
      "runtime",
      "node",
      "current",
      "bin",
      "node",
    );
    await fs.mkdir(path.dirname(currentDaemon), { recursive: true });
    await fs.mkdir(path.dirname(managedNode), { recursive: true });
    await fs.writeFile(currentDaemon, "export {};\n", "utf8");
    await fs.writeFile(managedNode, "#!/bin/sh\n", { mode: 0o755 });

    const spec = service.buildSystemdUserService(
      "demo",
      installDir,
      () => targetHome,
    );
    const plist = service.buildLaunchdPlist(
      "demo",
      installDir,
      () => targetHome,
    );

    assert.match(
      spec.service,
      new RegExp(
        `^ExecStart="${escapeRegex(managedNode)}" "${escapeRegex(currentDaemon)}"$`,
        "m",
      ),
    );
    assert.match(
      spec.service,
      new RegExp(
        `^Environment="PATH=${escapeRegex(path.dirname(managedNode))}:`,
        "m",
      ),
    );
    assert.ok(
      plist.plist.includes(`<string>${escapeXml(managedNode)}</string>`),
    );
    assert.ok(plist.plist.includes(`${escapeXml(path.dirname(managedNode))}:`));
  });
});

test("resolveDaemonEntryForInstall falls back to legacy installed daemon entry and fails without an installed runtime", async () => {
  await withTempDir(async (dir) => {
    const installDir = path.join(dir, "install");
    const legacyDaemon = path.join(
      installDir,
      "app",
      "current",
      "dist",
      "daemon.js",
    );
    await fs.mkdir(path.dirname(legacyDaemon), { recursive: true });
    await fs.writeFile(legacyDaemon, "export {};\n", "utf8");

    assert.equal(
      service.resolveDaemonEntryForInstall(installDir),
      legacyDaemon,
    );

    await fs.rm(installDir, { recursive: true, force: true });
    assert.throws(
      () => service.resolveDaemonEntryForInstall(installDir),
      /rin_installed_daemon_entry_missing:/,
    );
  });
});

test("refreshManagedServiceFiles updates existing managed units without creating missing candidates", async () => {
  if (process.platform !== "linux") return;

  await withTempDir(async (dir) => {
    const installDir = path.join(dir, "install");
    const currentDaemon = path.join(
      installDir,
      "app",
      "current",
      "dist",
      "app",
      "rin-daemon",
      "daemon.js",
    );
    const managedNode = path.join(
      installDir,
      "runtime",
      "node",
      "current",
      "bin",
      "node",
    );
    const targetHome = path.join(dir, "home");
    const unitDir = path.join(targetHome, ".config", "systemd", "user");
    const currentUnit = path.join(unitDir, "rin-daemon-demo.user-test.service");
    const bareUnit = path.join(unitDir, "rin-daemon.service");

    await fs.mkdir(path.dirname(currentDaemon), { recursive: true });
    await fs.mkdir(path.dirname(managedNode), { recursive: true });
    await fs.writeFile(currentDaemon, "export {};\n", "utf8");
    await fs.writeFile(managedNode, "#!/bin/sh\n", { mode: 0o755 });
    await fs.mkdir(unitDir, { recursive: true });
    await fs.writeFile(currentUnit, "stale\n", "utf8");

    service.refreshManagedServiceFiles("demo.user+test", installDir, false, {
      findSystemUser: () => ({ gid: 123 }),
      targetHomeForUser: () => targetHome,
    });

    const spec = service.buildSystemdUserService(
      "demo.user+test",
      installDir,
      () => targetHome,
    );
    assert.equal(await fs.readFile(currentUnit, "utf8"), spec.service);
    assert.equal((await fs.stat(currentUnit)).mode & 0o777, 0o644);
    await assert.rejects(fs.access(bareUnit), /ENOENT/);
  });
});

test("systemdUserContext keeps managed unit candidates ordered", () => {
  const context = service.systemdUserContext("demo.user+test", {
    findSystemUser: () => ({ uid: -1 }),
  });
  assert.deepEqual(context.units, ["rin-daemon-demo.user-test.service"]);
  assert.deepEqual(context.userEnv, {});
});

test("systemd user command helpers use direct local args for self and machine-host args for other users", () => {
  assert.deepEqual(service.systemctlUserCommandArgs(["daemon-reload"]), [
    "--user",
    "daemon-reload",
  ]);
  assert.deepEqual(
    service.systemctlMachineUserCommandArgs("demo.user+test", [
      "enable",
      "--now",
      "rin-daemon-demo.user-test.service",
    ]),
    [
      "--machine",
      "demo.user+test@.host",
      "--user",
      "enable",
      "--now",
      "rin-daemon-demo.user-test.service",
    ],
  );
  assert.deepEqual(
    service.systemctlCommandArgsForTargetUser("rin", ["daemon-reload"], "rin"),
    ["--user", "daemon-reload"],
  );
  assert.deepEqual(
    service.systemctlCommandArgsForTargetUser(
      "demo.user+test",
      ["daemon-reload"],
      "root",
    ),
    ["--machine", "demo.user+test@.host", "--user", "daemon-reload"],
  );
});

test("managed systemd helpers prefer richer successful snapshots while keeping action probe order", () => {
  const units = ["missing.service", "rin-daemon-demo.service", "other.service"];
  const calls = [];

  const status = managedService.findManagedSystemdStatusSnapshot(
    units,
    (unit) => {
      calls.push(`status:${unit}`);
      if (unit === "missing.service")
        throw { stderr: "Unit missing.service could not be found" };
      if (unit === "rin-daemon-demo.service")
        return "● rin-daemon-demo.service - Demo\n   Active: active (running)";
      return "";
    },
  );
  assert.deepEqual(status, {
    unit: "rin-daemon-demo.service",
    lines: ["● rin-daemon-demo.service - Demo", "   Active: active (running)"],
  });

  const errorStatus = managedService.findManagedSystemdStatusSnapshot(
    ["blank-stdout.service"],
    () => {
      throw {
        stdout: "   \n",
        stderr: "Unit blank-stdout.service could not be found\nHint line",
      };
    },
  );
  assert.deepEqual(errorStatus, {
    unit: "blank-stdout.service",
    lines: ["Unit blank-stdout.service could not be found", "Hint line"],
  });

  const journal = managedService.findManagedSystemdJournalSnapshot(
    units,
    (unit) => {
      calls.push(`journal:${unit}`);
      if (unit === "missing.service") return "";
      if (unit === "rin-daemon-demo.service")
        return "older\nrecent one\nrecent two";
      return "oldest\nother one\nother two";
    },
    2,
  );
  assert.deepEqual(journal, {
    unit: "rin-daemon-demo.service",
    lines: ["recent one", "recent two"],
  });

  const actionUnit = managedService.tryManagedSystemdAction(units, {
    daemonReload: () => calls.push("reload"),
    probeUnit: (unit) => {
      calls.push(`probe:${unit}`);
      if (unit === "missing.service") throw new Error("missing");
    },
    runAction: (unit) => calls.push(`run:${unit}`),
  });
  assert.equal(actionUnit, "rin-daemon-demo.service");
  assert.deepEqual(calls, [
    "status:missing.service",
    "status:rin-daemon-demo.service",
    "status:other.service",
    "journal:missing.service",
    "journal:rin-daemon-demo.service",
    "journal:other.service",
    "reload",
    "probe:missing.service",
    "probe:rin-daemon-demo.service",
    "run:rin-daemon-demo.service",
  ]);
});

test("daemonSocketPathForUser prefers runtime dir and falls back to home cache", () => {
  if (process.platform !== "linux") return;

  assert.equal(
    service.daemonSocketPathForUser("demo", {
      findSystemUser: () => ({ uid: 123 }),
      targetHomeForUser: () => "/home/demo",
    }),
    path.join("/run/user", "123", "rin-daemon", "daemon.sock"),
  );
  assert.equal(
    service.daemonSocketPathForUser("demo", {
      findSystemUser: () => ({ uid: -1 }),
      targetHomeForUser: () => "/home/demo",
    }),
    path.join("/home/demo", ".cache", "rin-daemon", "daemon.sock"),
  );
});
