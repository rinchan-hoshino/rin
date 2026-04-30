import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const pathsMod = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-install", "paths.js"))
    .href
);

test("installer path helpers keep installed runtime roots stable", () => {
  const installDir = "/tmp/rin";
  assert.equal(
    pathsMod.installAppRoot(installDir),
    path.join(installDir, "app"),
  );
  assert.equal(
    pathsMod.currentRuntimeRoot(installDir),
    path.join(installDir, "app", "current"),
  );
  assert.equal(
    pathsMod.installedReleasesRoot(installDir),
    path.join(installDir, "app", "releases"),
  );
  assert.equal(
    pathsMod.installedReleaseRoot(installDir, "2026-04-17T10-00-00Z"),
    path.join(installDir, "app", "releases", "2026-04-17T10-00-00Z"),
  );
});

test("installer path helpers centralize installed entrypoints", () => {
  const installDir = "/tmp/rin";

  assert.deepEqual(pathsMod.installedAppEntryPaths(installDir, "rin"), {
    currentPath: path.join(
      installDir,
      "app",
      "current",
      "dist",
      "app",
      "rin",
      "main.js",
    ),
    legacyPath: path.join(installDir, "app", "current", "dist", "index.js"),
    candidates: [
      path.join(installDir, "app", "current", "dist", "app", "rin", "main.js"),
      path.join(installDir, "app", "current", "dist", "index.js"),
    ],
  });
  assert.deepEqual(
    pathsMod.installedAppEntryCandidates(installDir, "rin-install"),
    [
      path.join(
        installDir,
        "app",
        "current",
        "dist",
        "app",
        "rin-install",
        "main.js",
      ),
    ],
  );
  assert.deepEqual(pathsMod.installedAppEntryPaths(installDir, "rin-daemon"), {
    currentPath: path.join(
      installDir,
      "app",
      "current",
      "dist",
      "app",
      "rin-daemon",
      "daemon.js",
    ),
    legacyPath: path.join(installDir, "app", "current", "dist", "daemon.js"),
    candidates: [
      path.join(
        installDir,
        "app",
        "current",
        "dist",
        "app",
        "rin-daemon",
        "daemon.js",
      ),
      path.join(installDir, "app", "current", "dist", "daemon.js"),
    ],
  });

  const daemonCandidates = pathsMod.installedAppEntryCandidates(
    installDir,
    "rin-daemon",
  );
  const seen = [];
  assert.equal(
    pathsMod.resolveInstalledAppEntryPath(
      installDir,
      "rin-daemon",
      (candidate) => {
        seen.push(candidate);
        return candidate === daemonCandidates[1];
      },
    ),
    daemonCandidates[1],
  );
  assert.deepEqual(seen, daemonCandidates);
  assert.equal(
    pathsMod.resolveInstalledAppEntryPath(
      installDir,
      "rin-install",
      () => false,
    ),
    null,
  );
});

test("installer path helpers centralize home, manifest, config, service, doc, and log locations", () => {
  const linuxHome = "/home/demo";
  const macHome = "/Users/demo";
  const installDir = "/srv/rin-demo";

  assert.equal(pathsMod.defaultHomeRoot("linux"), "/home");
  assert.equal(pathsMod.defaultHomeRoot("darwin"), "/Users");
  assert.equal(pathsMod.defaultHomeRoot("win32"), "C:\\Users");
  assert.deepEqual(pathsMod.installDiscoveryHomeRoots(), ["/home", "/Users"]);
  assert.equal(pathsMod.defaultHomeForUser("demo", "linux"), linuxHome);
  assert.equal(pathsMod.defaultHomeForUser("demo", "darwin"), macHome);
  assert.equal(
    pathsMod.installSettingsPath(installDir),
    path.join(installDir, "settings.json"),
  );
  assert.equal(
    pathsMod.installAuthPath(installDir),
    path.join(installDir, "auth.json"),
  );
  assert.equal(
    pathsMod.installedDocsRoot(installDir),
    path.join(installDir, "docs"),
  );
  assert.equal(
    pathsMod.installedRinDocsRoot(installDir),
    path.join(installDir, "docs", "rin"),
  );
  assert.equal(
    pathsMod.installedBuiltinSkillsRoot(installDir),
    path.join(installDir, "docs", "rin", "builtin-skills"),
  );
  assert.equal(
    pathsMod.installedBuiltinSkillRoot(installDir, "skill-creator"),
    path.join(installDir, "docs", "rin", "builtin-skills", "skill-creator"),
  );
  assert.equal(
    pathsMod.installedPiDocsRoot(installDir),
    path.join(installDir, "docs", "pi"),
  );
  assert.deepEqual(pathsMod.installerLocatorCandidatesForHome(linuxHome), [
    path.join(linuxHome, ".rin", "installer.json"),
    path.join(linuxHome, ".rin", "config", "installer.json"),
  ]);
  assert.deepEqual(pathsMod.installerManifestPaths(installDir, linuxHome), {
    manifestPath: path.join(installDir, "installer.json"),
    locatorManifestPath: path.join(linuxHome, ".rin", "installer.json"),
    legacyManifestPath: path.join(installDir, "config", "installer.json"),
    legacyLocatorManifestPath: path.join(
      linuxHome,
      ".rin",
      "config",
      "installer.json",
    ),
    writePaths: [
      path.join(installDir, "installer.json"),
      path.join(linuxHome, ".rin", "installer.json"),
    ],
    cleanupPaths: [
      path.join(installDir, "config", "installer.json"),
      path.join(linuxHome, ".rin", "config", "installer.json"),
    ],
    recoveryPaths: [
      path.join(installDir, "installer.json"),
      path.join(linuxHome, ".rin", "installer.json"),
      path.join(installDir, "config", "installer.json"),
      path.join(linuxHome, ".rin", "config", "installer.json"),
    ],
  });
  assert.deepEqual(
    pathsMod.installerManifestPaths(path.join(linuxHome, ".rin"), linuxHome)
      .writePaths,
    [path.join(linuxHome, ".rin", "installer.json")],
  );
  assert.deepEqual(
    pathsMod.installerManifestPaths(path.join(linuxHome, ".rin"), linuxHome)
      .recoveryPaths,
    [
      path.join(linuxHome, ".rin", "installer.json"),
      path.join(linuxHome, ".rin", "config", "installer.json"),
    ],
  );
  assert.deepEqual(
    pathsMod.installerRecoveryManifestCandidates(installDir, linuxHome),
    [
      path.join(installDir, "installer.json"),
      path.join(linuxHome, ".rin", "installer.json"),
      path.join(installDir, "config", "installer.json"),
      path.join(linuxHome, ".rin", "config", "installer.json"),
    ],
  );
  assert.equal(
    pathsMod.localBinDirForHome(linuxHome),
    path.join(linuxHome, ".local", "bin"),
  );
  assert.equal(
    pathsMod.launcherPathForHome(linuxHome, "rin"),
    path.join(linuxHome, ".local", "bin", "rin"),
  );
  assert.equal(
    pathsMod.launcherPathForHome(linuxHome, "rin-gui"),
    path.join(linuxHome, ".local", "bin", "rin-gui"),
  );
  assert.equal(
    pathsMod.launcherMetadataPathForHome(linuxHome, "linux"),
    path.join(linuxHome, ".config", "rin", "install.json"),
  );
  assert.equal(
    pathsMod.launcherMetadataPathForHome(macHome, "darwin"),
    path.join(macHome, "Library", "Application Support", "rin", "install.json"),
  );
  assert.equal(
    pathsMod.launcherMetadataPathForHome("C:\\Users\\demo", "win32"),
    path.join("C:\\Users\\demo", "AppData", "Roaming", "rin", "install.json"),
  );
  assert.equal(
    pathsMod.windowsStartupLauncherPathForHome("C:\\Users\\demo"),
    path.join(
      "C:\\Users\\demo",
      "AppData",
      "Roaming",
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Startup",
      "Rin Daemon.cmd",
    ),
  );
  assert.equal(
    pathsMod.windowsGuiStartMenuLauncherPathForHome("C:\\Users\\demo"),
    path.join(
      "C:\\Users\\demo",
      "AppData",
      "Roaming",
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Rin GUI.cmd",
    ),
  );
  assert.equal(
    pathsMod.windowsGuiDesktopLauncherPathForHome("C:\\Users\\demo"),
    path.join("C:\\Users\\demo", "Desktop", "Rin GUI.cmd"),
  );
  const alternateLauncherMetadataPath = pathsMod.launcherMetadataPathForHome(
    linuxHome,
    process.platform === "darwin" ? "linux" : "darwin",
  );
  assert.deepEqual(pathsMod.launcherMetadataPathsForHome(linuxHome), {
    currentPlatformPath: pathsMod.launcherMetadataPathForHome(linuxHome),
    alternatePlatformPath: alternateLauncherMetadataPath,
    recoveryPaths: [
      pathsMod.launcherMetadataPathForHome(linuxHome),
      alternateLauncherMetadataPath,
    ],
  });
  assert.deepEqual(pathsMod.launcherMetadataCandidatesForHome(linuxHome), [
    pathsMod.launcherMetadataPathForHome(linuxHome),
    alternateLauncherMetadataPath,
  ]);
  assert.deepEqual(pathsMod.installRecordSourcesForHome(linuxHome), [
    {
      source: "manifest",
      filePaths: [
        path.join(linuxHome, ".rin", "installer.json"),
        path.join(linuxHome, ".rin", "config", "installer.json"),
      ],
    },
    {
      source: "launcher",
      filePaths: [
        pathsMod.launcherMetadataPathForHome(linuxHome),
        alternateLauncherMetadataPath,
      ],
    },
  ]);
  assert.deepEqual(pathsMod.installRecordCandidatesForHome(linuxHome), [
    pathsMod.launcherMetadataPathForHome(linuxHome),
    alternateLauncherMetadataPath,
    path.join(linuxHome, ".rin", "installer.json"),
    path.join(linuxHome, ".rin", "config", "installer.json"),
  ]);
  assert.equal(
    pathsMod.managedLaunchdLabel("demo.user+test"),
    "com.rin.daemon.demo.user-test",
  );
  assert.equal(
    pathsMod.managedLaunchdPlistName("demo.user+test"),
    "com.rin.daemon.demo.user-test.plist",
  );
  assert.equal(
    pathsMod.launchAgentPlistPathForHome(
      macHome,
      pathsMod.managedLaunchdLabel("demo"),
    ),
    path.join(macHome, "Library", "LaunchAgents", "com.rin.daemon.demo.plist"),
  );
  assert.equal(
    pathsMod.isManagedLaunchdPlistName("com.rin.daemon.demo.plist"),
    true,
  );
  assert.equal(
    pathsMod.isManagedLaunchdPlistName("  com.rin.daemon.demo.plist  "),
    true,
  );
  assert.equal(
    pathsMod.isManagedLaunchdPlistName("com.example.demo.plist"),
    false,
  );
  assert.equal(
    pathsMod.installDirFromManagedLaunchdPlist(
      "\n<key>RIN_DIR</key>\n<string>/Users/demo/.rin</string>\n",
    ),
    "/Users/demo/.rin",
  );
  assert.equal(
    pathsMod.managedSystemdUnitName("demo.user+test"),
    "rin-daemon-demo.user-test.service",
  );
  assert.deepEqual(pathsMod.managedSystemdUnitCandidates("demo"), [
    "rin-daemon-demo.service",
    "rin-daemon.service",
  ]);
  assert.equal(
    pathsMod.isManagedSystemdUnitName("rin-daemon-demo.service"),
    true,
  );
  assert.equal(
    pathsMod.isManagedSystemdUnitName("  rin-daemon.service  "),
    true,
  );
  assert.equal(pathsMod.isManagedSystemdUnitName("other.service"), false);
  assert.equal(
    pathsMod.installDirFromManagedSystemdUnit(
      "Environment=RIN_DIR=/srv/rin-demo\nExecStart=node daemon.js\n",
    ),
    "/srv/rin-demo",
  );
  assert.equal(
    pathsMod.installDirFromManagedSystemdUnit(
      '\nEnvironment="RIN_DIR=/srv/rin-demo quoted"\nExecStart=node daemon.js\n',
    ),
    "/srv/rin-demo quoted",
  );
  assert.equal(
    pathsMod.systemdUserUnitPathForHome(
      linuxHome,
      pathsMod.managedSystemdUnitName("demo"),
    ),
    path.join(
      linuxHome,
      ".config",
      "systemd",
      "user",
      "rin-daemon-demo.service",
    ),
  );
  assert.deepEqual(pathsMod.managedSystemdUnitPathsForHome(linuxHome, "demo"), [
    path.join(
      linuxHome,
      ".config",
      "systemd",
      "user",
      "rin-daemon-demo.service",
    ),
    path.join(linuxHome, ".config", "systemd", "user", "rin-daemon.service"),
  ]);
  assert.equal(
    pathsMod.daemonSocketPathForHome(macHome, { platform: "darwin" }),
    path.join(macHome, "Library", "Caches", "rin-daemon", "daemon.sock"),
  );
  assert.equal(
    pathsMod.daemonSocketPathForHome(linuxHome, {
      uid: 123,
      platform: "linux",
    }),
    path.join("/run/user", "123", "rin-daemon", "daemon.sock"),
  );
  assert.equal(
    pathsMod.daemonSocketPathForHome(linuxHome, { uid: -1, platform: "linux" }),
    path.join(linuxHome, ".cache", "rin-daemon", "daemon.sock"),
  );
  assert.equal(
    pathsMod.daemonStdoutLogPath(installDir),
    path.join(installDir, "data", "logs", "daemon.stdout.log"),
  );
  assert.equal(
    pathsMod.daemonStderrLogPath(installDir),
    path.join(installDir, "data", "logs", "daemon.stderr.log"),
  );
});
