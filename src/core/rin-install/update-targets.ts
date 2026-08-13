import fs from "node:fs";
import path from "node:path";

import { readJsonFileOrDefault } from "../platform/fs.js";
import { resolveInstallRecordTargetFromCandidates } from "./install-record.js";
import {
  installDirFromManagedLaunchdPlist,
  installDirFromManagedSystemdUnit,
  installDiscoveryHomeRoots,
  installRecordSourcesForHome,
  isManagedLaunchdPlistName,
  isManagedSystemdUnitName,
  launchAgentsDirForHome,
  systemdUserUnitDirForHome,
} from "./paths.js";

export type InstalledTarget = {
  targetUser: string;
  installDir: string;
  ownerHome: string;
  source: "manifest" | "systemd" | "launchd" | "launcher";
};

type InstallRecordSource = Extract<
  InstalledTarget["source"],
  "manifest" | "launcher"
>;

type ManagedInstallDiscovery = {
  source: Extract<InstalledTarget["source"], "systemd" | "launchd">;
  dirForHome: (home: string) => string;
  isManagedName: (name: string) => boolean;
  installDirFromText: (text: string) => string;
};

type HomeInstallDiscovery = {
  discover: (homeDir: string, userName: string) => InstalledTarget[];
};

const INSTALLED_TARGET_SOURCE_PRIORITY = {
  manifest: 0,
  launcher: 1,
  systemd: 2,
  launchd: 3,
} as const satisfies Record<InstalledTarget["source"], number>;

const MANAGED_INSTALL_DISCOVERY: ManagedInstallDiscovery[] = [
  {
    source: "systemd",
    dirForHome: systemdUserUnitDirForHome,
    isManagedName: isManagedSystemdUnitName,
    installDirFromText: installDirFromManagedSystemdUnit,
  },
  {
    source: "launchd",
    dirForHome: launchAgentsDirForHome,
    isManagedName: isManagedLaunchdPlistName,
    installDirFromText: installDirFromManagedLaunchdPlist,
  },
];

function normalizeInstalledTarget(
  targetUser: unknown,
  installDir: unknown,
  ownerHome: unknown,
  source: InstalledTarget["source"],
): InstalledTarget | null {
  const nextTargetUser = String(targetUser || "").trim();
  const nextInstallDir = String(installDir || "").trim();
  const nextOwnerHome = String(ownerHome || "").trim();
  if (!nextTargetUser || !nextInstallDir || !nextOwnerHome) return null;
  return {
    targetUser: nextTargetUser,
    installDir: nextInstallDir,
    ownerHome: nextOwnerHome,
    source,
  };
}

function installedTargetKey(target: InstalledTarget) {
  return `${target.targetUser}\t${target.installDir}\t${target.ownerHome}`;
}

function installedTargetSourcePriority(source: InstalledTarget["source"]) {
  return INSTALLED_TARGET_SOURCE_PRIORITY[source];
}

function addInstalledTarget(
  rowsByKey: Map<string, InstalledTarget>,
  target: InstalledTarget | null,
) {
  if (!target) return;
  const key = installedTargetKey(target);
  const existing = rowsByKey.get(key);
  if (
    existing &&
    installedTargetSourcePriority(existing.source) <=
      installedTargetSourcePriority(target.source)
  ) {
    return;
  }
  rowsByKey.set(key, target);
}

function readDirectoryEntries(dir: string) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readUtf8File(filePath: string) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function discoverInstallRecordTarget(
  homeDir: string,
  userName: string,
  source: InstallRecordSource,
  filePaths: string[],
) {
  const target = resolveInstallRecordTargetFromCandidates(
    homeDir,
    userName,
    filePaths,
    (filePath) => readJsonFileOrDefault<any>(filePath, null),
  );
  return normalizeInstalledTarget(
    target?.targetUser,
    target?.installDir,
    homeDir,
    source,
  );
}

function discoverInstallRecordTargets(homeDir: string, userName: string) {
  return installRecordSourcesForHome(homeDir)
    .map(({ source, filePaths }) =>
      discoverInstallRecordTarget(homeDir, userName, source, filePaths),
    )
    .filter((target): target is InstalledTarget => Boolean(target));
}

function discoverManagedInstallTargets(
  homeDir: string,
  userName: string,
  discovery: ManagedInstallDiscovery,
) {
  const installDirPath = discovery.dirForHome(homeDir);
  const rows: InstalledTarget[] = [];
  for (const entry of readDirectoryEntries(installDirPath)) {
    if (!entry.isFile()) continue;
    if (!discovery.isManagedName(entry.name)) continue;
    const installDir = discovery.installDirFromText(
      readUtf8File(path.join(installDirPath, entry.name)),
    );
    const target = normalizeInstalledTarget(
      userName,
      installDir,
      homeDir,
      discovery.source,
    );
    if (target) rows.push(target);
  }
  return rows;
}

const HOME_INSTALL_DISCOVERY: HomeInstallDiscovery[] = [
  {
    discover: discoverInstallRecordTargets,
  },
  ...MANAGED_INSTALL_DISCOVERY.map((discovery) => ({
    discover: (homeDir: string, userName: string) =>
      discoverManagedInstallTargets(homeDir, userName, discovery),
  })),
];

function discoverHomeInstalledTargets(homeDir: string, userName: string) {
  return HOME_INSTALL_DISCOVERY.flatMap((discovery) =>
    discovery.discover(homeDir, userName),
  );
}

function compareInstalledTargets(a: InstalledTarget, b: InstalledTarget) {
  return (
    a.targetUser.localeCompare(b.targetUser) ||
    a.installDir.localeCompare(b.installDir) ||
    a.ownerHome.localeCompare(b.ownerHome)
  );
}

export function discoverInstalledTargets(
  homeRoots = installDiscoveryHomeRoots(),
) {
  const rowsByKey = new Map<string, InstalledTarget>();

  for (const root of homeRoots) {
    for (const entry of readDirectoryEntries(root)) {
      if (!entry.isDirectory()) continue;
      const homeDir = path.join(root, entry.name);
      for (const target of discoverHomeInstalledTargets(homeDir, entry.name)) {
        addInstalledTarget(rowsByKey, target);
      }
    }
  }

  return Array.from(rowsByKey.values()).sort(compareInstalledTargets);
}
