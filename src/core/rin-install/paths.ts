import path from "node:path";

const INSTALLED_APP_ENTRY_LAYOUT = {
  rin: {
    current: ["app", "rin", "main.js"],
    legacy: ["index.js"],
  },
  "rin-daemon": {
    current: ["app", "rin-daemon", "daemon.js"],
    legacy: ["daemon.js"],
  },
  "rin-install": {
    current: ["app", "rin-install", "main.js"],
  },
  "rin-gui": {
    current: ["app", "rin-gui", "main.js"],
  },
} as const;

const INSTALLER_MANIFEST_RELATIVE_PATH = ["installer.json"] as const;
const LEGACY_INSTALLER_MANIFEST_RELATIVE_PATH = [
  "config",
  "installer.json",
] as const;
const LAUNCHER_METADATA_FILE_NAME = "install.json";

export type InstalledAppKey = keyof typeof INSTALLED_APP_ENTRY_LAYOUT;

function uniqueNonEmptyStrings(values: Array<string | undefined | null>) {
  return Array.from(
    new Set(values.map((value) => String(value || "").trim()).filter(Boolean)),
  );
}

const SUPPORTED_HOME_DISCOVERY_PLATFORMS = ["linux", "darwin"] as const;

function pathCandidatesForSupportedHomeDiscoveryPlatforms(
  buildPath: (platform: NodeJS.Platform) => string,
) {
  return uniqueNonEmptyStrings(
    SUPPORTED_HOME_DISCOVERY_PLATFORMS.map((platform) => buildPath(platform)),
  );
}

export function defaultHomeRoot(platform = process.platform) {
  if (platform === "darwin") return "/Users";
  if (platform === "win32") return "C:\\Users";
  return "/home";
}

export function installDiscoveryHomeRoots() {
  return pathCandidatesForSupportedHomeDiscoveryPlatforms(defaultHomeRoot);
}

export function defaultHomeForUser(user: string, platform = process.platform) {
  return path.join(defaultHomeRoot(platform), user);
}

export function defaultInstallDirForHome(home: string) {
  return path.join(home, ".rin");
}

export function installSettingsPath(installDir: string) {
  return path.join(installDir, "settings.json");
}

export function installAuthPath(installDir: string) {
  return path.join(installDir, "auth.json");
}

export function installAppRoot(installDir: string) {
  return path.join(installDir, "app");
}

export function currentRuntimeRoot(installDir: string) {
  return path.join(installAppRoot(installDir), "current");
}

export function installedReleasesRoot(installDir: string) {
  return path.join(installAppRoot(installDir), "releases");
}

export function installedReleaseRoot(installDir: string, releaseId: string) {
  return path.join(installedReleasesRoot(installDir), releaseId);
}

export function installedDocsRoot(installDir: string) {
  return path.join(installDir, "docs");
}

export function installedRinDocsRoot(installDir: string) {
  return path.join(installedDocsRoot(installDir), "rin");
}

export function installedBuiltinSkillsRoot(installDir: string) {
  return path.join(installedRinDocsRoot(installDir), "builtin-skills");
}

export function installedBuiltinSkillRoot(
  installDir: string,
  skillName: string,
) {
  return path.join(installedBuiltinSkillsRoot(installDir), skillName);
}

export function installedPiDocsRoot(installDir: string) {
  return path.join(installedDocsRoot(installDir), "pi");
}

function installedAppDistRoot(installDir: string) {
  return path.join(currentRuntimeRoot(installDir), "dist");
}

function buildPathCandidates(
  primaryPath: string,
  fallbackPaths: Array<string | undefined | null>,
) {
  return uniqueNonEmptyStrings([primaryPath, ...fallbackPaths]);
}

function joinPathSegments(root: string, segments?: readonly string[]) {
  return segments?.length ? path.join(root, ...segments) : "";
}

function installedAppEntryPathFromSegments(
  installDir: string,
  segments?: readonly string[],
) {
  return joinPathSegments(installedAppDistRoot(installDir), segments);
}

function installDirPath(installDir: string, segments: readonly string[]) {
  return joinPathSegments(installDir, segments);
}

function defaultInstallDirPathForHome(
  home: string,
  segments: readonly string[],
) {
  return installDirPath(defaultInstallDirForHome(home), segments);
}

export function installedAppEntryPaths(
  installDir: string,
  app: InstalledAppKey,
) {
  const layout = INSTALLED_APP_ENTRY_LAYOUT[app];
  const currentPath = installedAppEntryPathFromSegments(
    installDir,
    layout.current,
  );
  const legacyPath = installedAppEntryPathFromSegments(
    installDir,
    "legacy" in layout ? layout.legacy : undefined,
  );
  return {
    currentPath,
    legacyPath,
    candidates: buildPathCandidates(currentPath, [legacyPath]),
  };
}

export function currentInstalledAppEntryPath(
  installDir: string,
  app: InstalledAppKey,
) {
  return installedAppEntryPaths(installDir, app).currentPath;
}

export function legacyInstalledAppEntryPath(
  installDir: string,
  app: InstalledAppKey,
) {
  return installedAppEntryPaths(installDir, app).legacyPath;
}

export function installedAppEntryCandidates(
  installDir: string,
  app: InstalledAppKey,
) {
  return installedAppEntryPaths(installDir, app).candidates;
}

export function resolveInstalledAppEntryPath(
  installDir: string,
  app: InstalledAppKey,
  pathExists: (candidate: string) => boolean,
) {
  for (const candidate of installedAppEntryPaths(installDir, app).candidates) {
    if (pathExists(candidate)) return candidate;
  }
  return null;
}

export function installerManifestPath(installDir: string) {
  return installDirPath(installDir, INSTALLER_MANIFEST_RELATIVE_PATH);
}

export function legacyInstallerManifestPath(installDir: string) {
  return installDirPath(installDir, LEGACY_INSTALLER_MANIFEST_RELATIVE_PATH);
}

export function installerLocatorPathForHome(home: string) {
  return defaultInstallDirPathForHome(home, INSTALLER_MANIFEST_RELATIVE_PATH);
}

export function legacyInstallerLocatorPathForHome(home: string) {
  return defaultInstallDirPathForHome(
    home,
    LEGACY_INSTALLER_MANIFEST_RELATIVE_PATH,
  );
}

export function installerManifestPaths(installDir: string, home: string) {
  const manifestFiles = {
    manifestPath: installerManifestPath(installDir),
    locatorManifestPath: installerLocatorPathForHome(home),
    legacyManifestPath: legacyInstallerManifestPath(installDir),
    legacyLocatorManifestPath: legacyInstallerLocatorPathForHome(home),
  };
  const writePaths = uniqueNonEmptyStrings([
    manifestFiles.manifestPath,
    manifestFiles.locatorManifestPath,
  ]);
  const cleanupPaths = uniqueNonEmptyStrings([
    manifestFiles.legacyManifestPath,
    manifestFiles.legacyLocatorManifestPath,
  ]);
  return {
    ...manifestFiles,
    writePaths,
    cleanupPaths,
    recoveryPaths: uniqueNonEmptyStrings([...writePaths, ...cleanupPaths]),
  };
}

export function installerLocatorCandidatesForHome(home: string) {
  return installerManifestPaths(defaultInstallDirForHome(home), home)
    .recoveryPaths;
}

export function installerRecoveryManifestCandidates(
  installDir: string,
  home: string,
) {
  return installerManifestPaths(installDir, home).recoveryPaths;
}

export function localBinDirForHome(home: string) {
  return path.join(home, ".local", "bin");
}

export function launcherPathForHome(
  home: string,
  name: "rin" | "rin-install" | "rin-gui",
) {
  return path.join(localBinDirForHome(home), name);
}

export function windowsDesktopDirForHome(home: string) {
  return path.join(home, "Desktop");
}

export function windowsStartMenuProgramsDirForHome(home: string) {
  return path.join(
    home,
    "AppData",
    "Roaming",
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
  );
}

export function windowsGuiDesktopLauncherPathForHome(home: string) {
  return path.join(windowsDesktopDirForHome(home), "Rin GUI.cmd");
}

export function windowsGuiStartMenuLauncherPathForHome(home: string) {
  return path.join(windowsStartMenuProgramsDirForHome(home), "Rin GUI.cmd");
}

export function windowsStartupDirForHome(home: string) {
  return path.join(
    home,
    "AppData",
    "Roaming",
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
  );
}

export function windowsStartupLauncherPathForHome(home: string) {
  return path.join(windowsStartupDirForHome(home), "Rin Daemon.cmd");
}

export function appConfigDirForHome(home: string, platform = process.platform) {
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "rin");
  }
  if (platform === "win32") {
    return path.join(home, "AppData", "Roaming", "rin");
  }
  return path.join(home, ".config", "rin");
}

export function launcherMetadataPathForHome(
  home: string,
  platform = process.platform,
) {
  return path.join(
    appConfigDirForHome(home, platform),
    LAUNCHER_METADATA_FILE_NAME,
  );
}

function alternateLauncherMetadataPathForHome(
  home: string,
  currentPlatformPath: string,
) {
  return pathCandidatesForSupportedHomeDiscoveryPlatforms((platform) =>
    launcherMetadataPathForHome(home, platform),
  ).find((candidate) => candidate !== currentPlatformPath);
}

export function launcherMetadataPathsForHome(home: string) {
  const currentPlatformPath = launcherMetadataPathForHome(home);
  const alternatePlatformPath = alternateLauncherMetadataPathForHome(
    home,
    currentPlatformPath,
  );
  return {
    currentPlatformPath,
    alternatePlatformPath,
    recoveryPaths: buildPathCandidates(currentPlatformPath, [
      alternatePlatformPath,
    ]),
  };
}

export function launcherMetadataCandidatesForHome(home: string) {
  return launcherMetadataPathsForHome(home).recoveryPaths;
}

export type InstallRecordSource = "manifest" | "launcher";

export type InstallRecordSourceCandidate = {
  source: InstallRecordSource;
  filePaths: string[];
};

export function installRecordSourcesForHome(
  home: string,
): InstallRecordSourceCandidate[] {
  return [
    { source: "manifest", filePaths: installerLocatorCandidatesForHome(home) },
    { source: "launcher", filePaths: launcherMetadataCandidatesForHome(home) },
  ];
}

export function installRecordCandidatesForHome(home: string) {
  const [manifestSource, launcherSource] = installRecordSourcesForHome(home);
  return uniqueNonEmptyStrings([
    ...launcherSource.filePaths,
    ...manifestSource.filePaths,
  ]);
}

const LEGACY_MANAGED_SYSTEMD_UNIT_NAME = "rin-daemon.service";

function normalizeManagedUserFragment(targetUser: string, pattern: RegExp) {
  return String(targetUser).trim().replace(pattern, "-");
}

function managedSystemdUnitUserFragment(targetUser: string) {
  return normalizeManagedUserFragment(targetUser, /[^A-Za-z0-9_.@-]+/g);
}

function managedLaunchdUserFragment(targetUser: string) {
  return normalizeManagedUserFragment(targetUser, /[^A-Za-z0-9_.-]+/g);
}

export function managedSystemdUnitName(targetUser: string) {
  return `rin-daemon-${managedSystemdUnitUserFragment(targetUser)}.service`;
}

export function managedSystemdUnitCandidates(targetUser: string) {
  return uniqueNonEmptyStrings([
    managedSystemdUnitName(targetUser),
    LEGACY_MANAGED_SYSTEMD_UNIT_NAME,
  ]);
}

export function isManagedSystemdUnitName(unitName: string) {
  const normalizedUnitName = String(unitName || "").trim();
  return (
    normalizedUnitName === LEGACY_MANAGED_SYSTEMD_UNIT_NAME ||
    /^rin-daemon(?:-.+)?\.service$/.test(normalizedUnitName)
  );
}

export function installDirFromManagedSystemdUnit(text: string) {
  const match = String(text || "")
    .trim()
    .match(/^Environment=(?:"|')?RIN_DIR=(.+?)(?:"|')?$/m);
  return String(match?.[1] || "").trim();
}

export function managedLaunchdLabel(targetUser: string) {
  return `com.rin.daemon.${managedLaunchdUserFragment(targetUser)}`;
}

export function managedLaunchdPlistName(targetUser: string) {
  return `${managedLaunchdLabel(targetUser)}.plist`;
}

export function isManagedLaunchdPlistName(fileName: string) {
  return /^com\.rin\.daemon\..+\.plist$/.test(String(fileName || "").trim());
}

export function installDirFromManagedLaunchdPlist(text: string) {
  const match = String(text || "")
    .trim()
    .match(/<key>RIN_DIR<\/key>\s*<string>([^<]+)<\/string>/);
  return String(match?.[1] || "").trim();
}

export function launchAgentsDirForHome(home: string) {
  return path.join(home, "Library", "LaunchAgents");
}

export function launchAgentPlistPathForHome(home: string, label: string) {
  return path.join(launchAgentsDirForHome(home), `${label}.plist`);
}

export function systemdUserUnitDirForHome(home: string) {
  return path.join(home, ".config", "systemd", "user");
}

export function systemdUserUnitPathForHome(home: string, unitName: string) {
  return path.join(systemdUserUnitDirForHome(home), unitName);
}

export function managedSystemdUnitPathsForHome(
  home: string,
  targetUser: string,
) {
  return managedSystemdUnitCandidates(targetUser).map((unit) =>
    systemdUserUnitPathForHome(home, unit),
  );
}

function userCacheDirForHome(home: string, platform = process.platform) {
  if (platform === "darwin") {
    return path.join(home, "Library", "Caches");
  }
  return path.join(home, ".cache");
}

export function daemonSocketPathForHome(
  home: string,
  options: {
    uid?: number;
    platform?: NodeJS.Platform;
  } = {},
) {
  const platform = options.platform || process.platform;
  const uid = Number(options.uid ?? -1);
  if (platform === "darwin") {
    return path.join(
      userCacheDirForHome(home, platform),
      "rin-daemon",
      "daemon.sock",
    );
  }
  if (uid >= 0) {
    return path.join("/run/user", String(uid), "rin-daemon", "daemon.sock");
  }
  return path.join(
    userCacheDirForHome(home, platform),
    "rin-daemon",
    "daemon.sock",
  );
}

export function daemonLogsDir(installDir: string) {
  return path.join(installDir, "data", "logs");
}

export function daemonStdoutLogPath(installDir: string) {
  return path.join(daemonLogsDir(installDir), "daemon.stdout.log");
}

export function daemonStderrLogPath(installDir: string) {
  return path.join(daemonLogsDir(installDir), "daemon.stderr.log");
}
