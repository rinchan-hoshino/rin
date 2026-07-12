import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeStoredChatSettings } from "../chat/settings.js";
import { stripRemovedBuiltInRinExtensionEntries } from "../rin-bundled-extensions.js";
import {
  chatDataPath,
  LEGACY_DATA_LAYOUT_MOVES,
  schedulerDataPath,
} from "../data-layout.js";
import {
  listChatStateFiles,
  listDetachedControllerStateFiles,
} from "../chat/support.js";
import { isJsonRecord } from "../json-utils.js";
import { DEFAULT_LANGUAGE_TAG, normalizeLanguageTag } from "../language.js";
import { stringifyJson } from "../platform/fs.js";
import { nowIso } from "../time-utils.js";
import { safeString } from "../text-utils.js";
import { loadFirstValidCandidate } from "./candidate-loader.js";
import { type InstalledReleaseInfo } from "../rin-lib/release.js";
import { initStatePath } from "../self-improve/paths.js";
import { getManagedChatSessionDir } from "../session/managed-paths.js";
import { applyInstallUpgradeMigrations } from "./install-upgrade-migrations.js";
import {
  defaultHomeForUser,
  installAuthPath,
  installerManifestPaths,
  installSettingsPath,
} from "./paths.js";

export { applyInstallUpgradeMigrations } from "./install-upgrade-migrations.js";

export type ManagedFilesManifest = {
  trees: Record<string, string[]>;
};

function resolveInstallOwner(
  targetUser: string,
  findSystemUser: (targetUser: string) => any,
) {
  const target = findSystemUser(targetUser) as any;
  const ownerUser = target?.name || targetUser;
  return {
    ownerUser,
    ownerGroup: target?.gid,
    ownerHome: target?.home || defaultHomeForUser(ownerUser),
  };
}

function writeInstallerJson(
  filePath: string,
  value: unknown,
  options: {
    elevated?: boolean;
    ownerUser?: string;
    ownerGroup?: string | number;
  },
  deps: {
    writeJsonFileWithPrivilege: (
      filePath: string,
      value: unknown,
      ownerUser?: string,
      ownerGroup?: string | number,
    ) => void;
    writeJsonFile: (filePath: string, value: unknown) => void;
  },
) {
  if (options.elevated) {
    deps.writeJsonFileWithPrivilege(
      filePath,
      value,
      options.ownerUser,
      options.ownerGroup,
    );
    return;
  }
  deps.writeJsonFile(filePath, value);
}

function removeFile(
  filePath: string,
  elevated: boolean,
  runPrivileged: (command: string, args: string[]) => void,
) {
  try {
    if (elevated) {
      runPrivileged("rm", ["-f", filePath]);
      return;
    }
    fs.rmSync(filePath, { force: true });
  } catch {}
}

function userSkillDir(installDir: string) {
  return path.join(installDir, "self_improve", "skills");
}

function ensureRuntimeUserDirs(
  options: { targetUser: string; installDir: string; elevated?: boolean },
  deps: {
    ensureDir: (dir: string) => void;
    runCommandAsUser?: (
      targetUser: string,
      command: string,
      args: string[],
    ) => void;
  },
) {
  const skillDir = userSkillDir(options.installDir);
  if (options.elevated && deps.runCommandAsUser) {
    deps.runCommandAsUser(options.targetUser, "mkdir", ["-p", skillDir]);
    return;
  }
  deps.ensureDir(skillDir);
}

function normalizeInstallerRecord(value: unknown) {
  return isJsonRecord(value) ? value : {};
}

function normalizeConfiguredLanguage(language: unknown) {
  const normalizedLanguage = String(language || "").trim();
  return normalizedLanguage
    ? normalizeLanguageTag(normalizedLanguage, DEFAULT_LANGUAGE_TAG)
    : "";
}

function applyInstalledDefaults(
  target: any,
  options: {
    provider?: string;
    modelId?: string;
    thinkingLevel?: string;
    language?: string;
  },
) {
  if (options.provider) target.defaultProvider = options.provider;
  if (options.modelId) target.defaultModel = options.modelId;
  if (options.thinkingLevel) {
    target.defaultThinkingLevel = options.thinkingLevel;
  }
  const language = normalizeConfiguredLanguage(options.language);
  if (language) target.language = language;
  if (Array.isArray(target.extensions)) {
    const extensions = stripRemovedBuiltInRinExtensionEntries(
      target.extensions,
    );
    if (extensions.length > 0) target.extensions = extensions;
    else delete target.extensions;
  }
}

function installerWriteOptions(
  ownerUser: string,
  ownerGroup: string | number | undefined,
  elevated: boolean | undefined,
) {
  return {
    elevated,
    ownerUser,
    ownerGroup,
  };
}

function isGitHash(value: string) {
  return /^[0-9a-f]{7,40}$/i.test(value.trim());
}

function normalizeInstalledReleaseInfo(
  release: InstalledReleaseInfo | undefined,
): InstalledReleaseInfo | undefined {
  if (!release || typeof release !== "object") return undefined;
  const channel = String(release.channel || "stable")
    .trim()
    .toLowerCase();
  const normalizedChannel =
    channel === "beta" || channel === "nightly" || channel === "git"
      ? channel
      : "stable";
  const version = String(release.version || "").trim();
  const branch = String(release.branch || "").trim();
  const rawRef = String(release.ref || "").trim();
  const sourceLabel = String(release.sourceLabel || "").trim();
  const archiveUrl = String(release.archiveUrl || "").trim();
  const installedAt = String(release.installedAt || "").trim();
  if (!version && !branch && !rawRef && !sourceLabel && !archiveUrl)
    return undefined;
  if (normalizedChannel === "git") {
    const concreteRef = isGitHash(rawRef)
      ? rawRef
      : isGitHash(version)
        ? version
        : "";
    return {
      channel: normalizedChannel,
      version: concreteRef ? concreteRef.slice(0, 12) : "unknown",
      branch: branch || "main",
      ref: concreteRef,
      sourceLabel: sourceLabel || `git ${branch || "main"}`,
      archiveUrl,
      installedAt: installedAt || undefined,
    };
  }
  return {
    channel: normalizedChannel,
    version: version || "unknown",
    branch: branch || (normalizedChannel === "stable" ? "stable" : "main"),
    ref: rawRef || version || "main",
    sourceLabel:
      sourceLabel || `${normalizedChannel} ${version || rawRef || "unknown"}`,
    archiveUrl,
    installedAt: installedAt || undefined,
  };
}

function isInstalledReleaseRecord(value: any) {
  return isJsonRecord(value) && typeof value.name === "string";
}

function normalizeInstalledReleaseRecord(value: any) {
  if (!isInstalledReleaseRecord(value)) return undefined;
  return buildInstalledReleaseRecord({
    name: value.name,
    root: value.path,
    release: value.release,
  });
}

function buildInstalledReleaseRecord(options: {
  name?: string;
  root?: string;
  release?: InstalledReleaseInfo;
}) {
  const name = String(options.name || "").trim();
  if (!name) return undefined;
  const release = normalizeInstalledReleaseInfo(options.release);
  return {
    name,
    ...(String(options.root || "").trim()
      ? { path: String(options.root || "").trim() }
      : {}),
    ...(release ? { release } : {}),
  };
}

function legacyManagedFilesManifestPath(installDir: string) {
  return path.join(installDir, "data", ".managed", "install-home.json");
}

function normalizeManagedTreeFiles(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((entry) =>
          String(entry || "")
            .trim()
            .replace(/\\/g, "/"),
        )
        .filter((entry) => entry && !entry.startsWith("/") && entry !== "."),
    ),
  ).sort();
}

function normalizeManagedFilesManifest(
  value: unknown,
): ManagedFilesManifest | undefined {
  if (!isJsonRecord(value) || !isJsonRecord(value.trees)) return undefined;
  const trees: Record<string, string[]> = {};
  for (const [rawRoot, rawFiles] of Object.entries(value.trees)) {
    const root = String(rawRoot || "")
      .trim()
      .replace(/\\/g, "/");
    if (!root || root.startsWith("/") || root === ".") continue;
    const files = normalizeManagedTreeFiles(rawFiles);
    if (files.length) trees[root] = files;
  }
  return Object.keys(trees).length ? { trees } : undefined;
}

function mergeManagedFilesManifests(
  prior: ManagedFilesManifest | undefined,
  next: ManagedFilesManifest | undefined,
) {
  if (!prior && !next) return undefined;
  return {
    trees: {
      ...(prior?.trees || {}),
      ...(next?.trees || {}),
    },
  };
}

export function reconcileInstallerManifest(
  options: {
    targetUser: string;
    installDir: string;
    release?: InstalledReleaseInfo;
    currentReleaseName?: string;
    currentReleaseRoot?: string;
    previousReleaseName?: string;
    previousReleaseRoot?: string;
    elevated?: boolean;
    managedFiles?: ManagedFilesManifest;
    service?: {
      kind: "launchd" | "systemd" | "windows-startup";
      label: string;
      path?: string;
    } | null;
  },
  deps: {
    findSystemUser: (targetUser: string) => any;
    ensureDir: (dir: string) => void;
    readInstallerJson: <T>(
      filePath: string,
      fallback: T,
      elevated?: boolean,
    ) => T;
    writeJsonFileWithPrivilege: (
      filePath: string,
      value: unknown,
      ownerUser?: string,
      ownerGroup?: string | number,
    ) => void;
    writeJsonFile: (filePath: string, value: unknown) => void;
    runPrivileged: (command: string, args: string[]) => void;
  },
) {
  const { ownerUser, ownerGroup, ownerHome } = resolveInstallOwner(
    options.targetUser,
    deps.findSystemUser,
  );
  if (!options.elevated) deps.ensureDir(options.installDir);

  const manifestPaths = installerManifestPaths(options.installDir, ownerHome);
  const { manifestPath, locatorManifestPath } = manifestPaths;
  const writeOptions = installerWriteOptions(
    ownerUser,
    ownerGroup,
    options.elevated,
  );
  const legacyManagedFilesPath = legacyManagedFilesManifestPath(
    options.installDir,
  );
  const priorManifest: any =
    loadFirstValidCandidate(
      manifestPaths.recoveryPaths,
      (filePath) =>
        deps.readInstallerJson<any>(filePath, null, Boolean(options.elevated)),
      (value) => (isJsonRecord(value) ? value : null),
    ) || {};
  const priorManagedFiles =
    normalizeManagedFilesManifest(priorManifest.managedFiles) ||
    normalizeManagedFilesManifest(
      deps.readInstallerJson<any>(
        legacyManagedFilesPath,
        null,
        Boolean(options.elevated),
      ),
    );
  const manifestJson: any = {
    targetUser: options.targetUser,
    installDir: options.installDir,
  };
  const normalizedRelease = normalizeInstalledReleaseInfo(options.release);
  const priorCurrentRelease = normalizeInstalledReleaseRecord(
    priorManifest.currentRelease,
  );
  const priorPreviousRelease = normalizeInstalledReleaseRecord(
    priorManifest.previousRelease,
  );
  const previousReleaseName = String(options.previousReleaseName || "").trim();
  const previousReleaseMetadata = previousReleaseName
    ? priorCurrentRelease?.name === previousReleaseName
      ? priorCurrentRelease.release
      : priorPreviousRelease?.name === previousReleaseName
        ? priorPreviousRelease.release
        : undefined
    : undefined;
  const currentRelease =
    buildInstalledReleaseRecord({
      name: options.currentReleaseName,
      root: options.currentReleaseRoot,
      release: normalizedRelease,
    }) || priorCurrentRelease;
  const previousRelease = buildInstalledReleaseRecord({
    name: options.previousReleaseName,
    root: options.previousReleaseRoot,
    release: previousReleaseMetadata,
  });
  if (currentRelease) manifestJson.currentRelease = currentRelease;
  const managedFiles = mergeManagedFilesManifests(
    priorManagedFiles,
    normalizeManagedFilesManifest(options.managedFiles),
  );
  if (managedFiles) manifestJson.managedFiles = managedFiles;
  if (options.service) {
    manifestJson.service = {
      kind: options.service.kind,
      label: options.service.label,
      ...(options.service.path ? { path: options.service.path } : {}),
    };
  } else if (isJsonRecord(priorManifest.service)) {
    manifestJson.service = priorManifest.service;
  }
  if (
    previousRelease &&
    previousRelease.name !== String(currentRelease?.name || "")
  ) {
    manifestJson.previousRelease = previousRelease;
  } else if (
    priorPreviousRelease &&
    priorPreviousRelease.name !== String(currentRelease?.name || "")
  ) {
    manifestJson.previousRelease = priorPreviousRelease;
  }
  manifestJson.updatedAt = nowIso();

  for (const filePath of manifestPaths.writePaths) {
    writeInstallerJson(filePath, manifestJson, writeOptions, deps);
  }
  removeFile(
    legacyManagedFilesPath,
    Boolean(options.elevated),
    deps.runPrivileged,
  );
  return {
    manifestPath,
    locatorManifestPath,
  };
}

export function normalizeInstalledChatSettings(
  options: {
    targetUser: string;
    installDir: string;
    elevated?: boolean;
  },
  deps: {
    findSystemUser: (targetUser: string) => any;
    readInstallerJson: <T>(
      filePath: string,
      fallback: T,
      elevated?: boolean,
    ) => T;
    writeJsonFileWithPrivilege: (
      filePath: string,
      value: unknown,
      ownerUser?: string,
      ownerGroup?: string | number,
    ) => void;
    writeJsonFile: (filePath: string, value: unknown) => void;
    runPrivileged: (command: string, args: string[]) => void;
    runCommandAsUser?: (
      targetUser: string,
      command: string,
      args: string[],
    ) => void;
    captureCommandAsUser?: (
      targetUser: string,
      command: string,
      args: string[],
    ) => string;
  },
) {
  const { ownerUser, ownerGroup } = resolveInstallOwner(
    options.targetUser,
    deps.findSystemUser,
  );
  const migrations = applyInstallUpgradeMigrations(options, deps);
  const settingsPath = installSettingsPath(options.installDir);
  const settingsJson = normalizeStoredChatSettings(
    deps.readInstallerJson<any>(settingsPath, {}, Boolean(options.elevated)),
  );
  writeInstallerJson(
    settingsPath,
    settingsJson,
    installerWriteOptions(ownerUser, ownerGroup, options.elevated),
    deps,
  );
  return { settingsPath, migrations };
}

export async function persistInstallerOutputs(
  options: {
    currentUser: string;
    targetUser: string;
    installDir: string;
    provider: string;
    modelId: string;
    thinkingLevel: string;
    language?: string;
    setDefaultTarget?: boolean;
    authData: any;
    release?: InstalledReleaseInfo;
    currentReleaseName?: string;
    currentReleaseRoot?: string;
    managedFiles?: ManagedFilesManifest;
    previousReleaseName?: string;
    previousReleaseRoot?: string;
    elevated?: boolean;
    initializationComplete?: boolean;
    writeLaunchers?: boolean;
  },
  deps: {
    findSystemUser: (targetUser: string) => any;
    ensureDir: (dir: string) => void;
    readInstallerJson: <T>(
      filePath: string,
      fallback: T,
      elevated?: boolean,
    ) => T;
    writeJsonFileWithPrivilege: (
      filePath: string,
      value: unknown,
      ownerUser?: string,
      ownerGroup?: string | number,
    ) => void;
    writeJsonFile: (filePath: string, value: unknown) => void;
    launcherMetadataPathForUser: (userName: string) => string;
    readJsonFile: <T>(filePath: string, fallback: T) => T;
    writeLaunchersForUser: (
      userName: string,
      installDir: string,
      options?: { elevated?: boolean },
    ) => any;
    reconcileInstallerManifest: typeof reconcileInstallerManifest;
    runPrivileged: (command: string, args: string[]) => void;
    runCommandAsUser?: (
      targetUser: string,
      command: string,
      args: string[],
    ) => void;
    captureCommandAsUser?: (
      targetUser: string,
      command: string,
      args: string[],
    ) => string;
  },
) {
  const { ownerUser, ownerGroup } = resolveInstallOwner(
    options.targetUser,
    deps.findSystemUser,
  );
  const writeOptions = installerWriteOptions(
    ownerUser,
    ownerGroup,
    options.elevated,
  );
  if (!options.elevated) deps.ensureDir(options.installDir);
  ensureRuntimeUserDirs(options, deps);

  const migrations = applyInstallUpgradeMigrations(options, deps);
  const settingsPath = installSettingsPath(options.installDir);
  const settingsJson = normalizeStoredChatSettings(
    deps.readInstallerJson<any>(settingsPath, {}, Boolean(options.elevated)),
  );
  applyInstalledDefaults(settingsJson, options);

  const authPath = installAuthPath(options.installDir);
  const authJson = normalizeInstallerRecord(
    deps.readInstallerJson<any>(authPath, {}, Boolean(options.elevated)),
  );
  const nextAuthJson = {
    ...authJson,
    ...normalizeInstallerRecord(options.authData),
  };
  const initializationComplete = options.initializationComplete !== false;
  const initStateJson = {
    version: 2,
    promptedAt: "",
    completedAt: initializationComplete ? nowIso() : "",
    lastTrigger: initializationComplete ? "install_existing" : "install_fresh",
    pending: false,
    initialized: initializationComplete,
  };

  const writeLaunchers = options.writeLaunchers !== false;
  const launcherPath = writeLaunchers
    ? deps.launcherMetadataPathForUser(options.currentUser)
    : "";
  const shouldSetDefaultTarget = options.setDefaultTarget !== false;
  const launcherJson = writeLaunchers
    ? shouldSetDefaultTarget
      ? normalizeInstallerRecord(deps.readJsonFile<any>(launcherPath, {}))
      : {}
    : {};
  if (writeLaunchers) {
    if (shouldSetDefaultTarget) {
      launcherJson.defaultTargetUser = options.targetUser;
      launcherJson.defaultInstallDir = options.installDir;
    } else {
      delete launcherJson.defaultTargetUser;
      delete launcherJson.defaultInstallDir;
    }
    launcherJson.updatedAt = nowIso();
    launcherJson.installedBy = options.currentUser;
  }

  const { manifestPath, locatorManifestPath } = deps.reconcileInstallerManifest(
    {
      targetUser: options.targetUser,
      installDir: options.installDir,
      release: options.release,
      currentReleaseName: options.currentReleaseName,
      currentReleaseRoot: options.currentReleaseRoot,
      managedFiles: options.managedFiles,
      previousReleaseName: options.previousReleaseName,
      previousReleaseRoot: options.previousReleaseRoot,
      elevated: options.elevated,
    },
    deps,
  );

  const initStateFilePath = initStatePath(options.installDir);
  writeInstallerJson(settingsPath, settingsJson, writeOptions, deps);
  writeInstallerJson(authPath, nextAuthJson, writeOptions, deps);
  writeInstallerJson(initStateFilePath, initStateJson, writeOptions, deps);
  if (!writeLaunchers) {
    return {
      settingsPath,
      authPath,
      initStatePath: initStateFilePath,
      manifestPath,
      locatorManifestPath,
      migrations,
    };
  }

  deps.writeJsonFile(launcherPath, launcherJson);
  const currentLaunchers = deps.writeLaunchersForUser(
    options.currentUser,
    options.installDir,
    { elevated: false },
  );
  const targetLaunchers =
    options.targetUser === options.currentUser
      ? currentLaunchers
      : deps.writeLaunchersForUser(options.targetUser, options.installDir, {
          elevated: Boolean(options.elevated),
        });

  return {
    settingsPath,
    authPath,
    initStatePath: initStateFilePath,
    launcherPath,
    manifestPath,
    locatorManifestPath,
    migrations,
    ...currentLaunchers,
    currentRinPath: currentLaunchers.rinPath,
    currentRinInstallPath: currentLaunchers.rinInstallPath,
    targetRinPath: targetLaunchers.rinPath,
    targetRinInstallPath: targetLaunchers.rinInstallPath,
  };
}
