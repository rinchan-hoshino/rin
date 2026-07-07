import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { type FinalizeInstallOptions } from "./apply-plan.js";
import {
  launcherMetadataPathForUser,
  currentInstalledReleaseName,
  ensureDir,
  publishInstalledRuntime,
  publishManagedNodeRuntime,
  pruneInstalledReleases,
  readInstallerJson,
  readJsonFile,
  runCommandAsUser,
  runPrivileged,
  captureCommandAsUser,
  buildInstalledManagedFilesManifest,
  syncInstalledDocs,
  writeJsonFile,
  writeJsonFileWithPrivilege,
  writeLaunchersForUser,
} from "./fs-utils.js";
import { defaultInstallDirForHome, installedReleaseRoot } from "./paths.js";
import {
  normalizeInstalledChatSettings,
  persistInstallerOutputs,
  reconcileInstallerManifest,
} from "./persist.js";
import {
  collectDaemonFailureDetails,
  daemonSocketPathForUser,
  buildSystemdUserService,
  installDaemonService,
  reconcileSystemdUserService,
  refreshManagedServiceFiles,
  waitForSocket,
} from "./service.js";
import { detectCurrentUser, repoRootFromHere } from "./common.js";
import { preparePiManagedToolsForInstall } from "./pi-tools.js";
import { buildGitHubRefArchiveUrl } from "../rin-lib/release.js";
import {
  describeOwnership,
  findSystemUser,
  homeForUser,
  isSameSystemUser,
  shouldUseElevatedWrite,
  targetHomeForUser,
} from "./users.js";

export function defaultDaemonReadyTimeoutMs() {
  return 30_000;
}

export function readExistingInitializationComplete(installDir: string) {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(
        path.join(installDir, "self_improve", "state", "init-state.json"),
        "utf8",
      ),
    ) as Record<string, any>;
    return Boolean(parsed?.initialized || parsed?.completedAt);
  } catch {
    return false;
  }
}

function readGitValue(sourceRoot: string, args: string[]) {
  try {
    return String(
      execFileSync("git", ["-C", sourceRoot, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    ).trim();
  } catch {
    return "";
  }
}

function deriveGitReleaseMetadata(sourceRoot: string, branchHint = "") {
  const ref = readGitValue(sourceRoot, ["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/i.test(ref)) return undefined;
  const version = ref.slice(0, 12);
  const branch =
    branchHint ||
    readGitValue(sourceRoot, ["branch", "--show-current"]) ||
    "main";
  const remoteUrl =
    readGitValue(sourceRoot, ["config", "--get", "remote.origin.url"]) ||
    "https://github.com/rinchan-hoshino/rin";
  return {
    channel: "git" as const,
    version,
    branch,
    ref,
    sourceLabel: `git ${branch} @ ${version}`,
    archiveUrl: buildGitHubRefArchiveUrl(remoteUrl, ref),
    installedAt: new Date().toISOString(),
  };
}

function normalizeReleaseMetadataForInstall(
  release: FinalizeInstallOptions["release"],
  sourceRoot: string,
) {
  if (release?.channel === "git") {
    return deriveGitReleaseMetadata(sourceRoot, release.branch) || release;
  }
  return release || deriveGitReleaseMetadata(sourceRoot);
}

function launcherMetadataMatchesTarget(
  metadata: any,
  targetUser: string,
  installDir: string,
) {
  return (
    String(metadata?.defaultTargetUser || "").trim() === targetUser &&
    String(metadata?.defaultInstallDir || "").trim() === installDir
  );
}

export function refreshCoreUpdateLaunchers(
  options: {
    currentUser: string;
    targetUser: string;
    installDir: string;
    elevated?: boolean;
  },
  deps: {
    homeForUser?: (user: string) => string;
    findSystemUser?: (user: string) => any;
    readJsonFile?: <T>(filePath: string, fallback: T) => T;
    launcherMetadataPathForUser?: typeof launcherMetadataPathForUser;
    writeLaunchersForUser?: typeof writeLaunchersForUser;
  } = {},
) {
  const resolveHomeForUser = deps.homeForUser || homeForUser;
  const resolveLauncherMetadataPath =
    deps.launcherMetadataPathForUser || launcherMetadataPathForUser;
  const readLauncherJson = deps.readJsonFile || readJsonFile;
  const writeUserLaunchers =
    deps.writeLaunchersForUser || writeLaunchersForUser;
  const findUser = deps.findSystemUser || findSystemUser;
  const writeForUser = (userName: string, elevated: boolean) =>
    writeUserLaunchers(userName, options.installDir, resolveHomeForUser, {
      elevated,
      findSystemUser: findUser,
    });

  const targetLaunchers = writeForUser(
    options.targetUser,
    Boolean(options.elevated),
  );
  if (options.currentUser === options.targetUser) {
    return { targetLaunchers, currentLaunchers: targetLaunchers };
  }

  const currentLauncherMetadata = readLauncherJson<any>(
    resolveLauncherMetadataPath(options.currentUser, resolveHomeForUser),
    {},
  );
  if (
    launcherMetadataMatchesTarget(
      currentLauncherMetadata,
      options.targetUser,
      options.installDir,
    )
  ) {
    return {
      targetLaunchers,
      currentLaunchers: writeForUser(options.currentUser, false),
    };
  }

  return { targetLaunchers, currentLaunchers: null };
}

async function applyInstalledRuntime(
  options: FinalizeInstallOptions & {
    persistInstallerState?: boolean;
    daemonFailureCode: string;
    stopRuntimeBeforePublish?: boolean;
    publishRuntime?: boolean;
    manageDaemon?: boolean;
    prepareManagedTools?: boolean;
    writeLaunchers?: boolean;
  },
) {
  const currentUser =
    String(options.currentUser || "").trim() || detectCurrentUser();
  const targetUser = String(options.targetUser || "").trim() || currentUser;
  const installDir =
    String(options.installDir || "").trim() ||
    defaultInstallDirForHome(targetHomeForUser(targetUser));
  const provider = String(options.provider || "");
  const modelId = String(options.modelId || "");
  const thinkingLevel = String(options.thinkingLevel || "");
  const language = String(options.language || "").trim();
  const setDefaultTarget = options.setDefaultTarget !== false;
  const authData = options.authData || {};
  const publishRuntime = options.publishRuntime !== false;
  const manageDaemon = options.manageDaemon !== false;
  const prepareManagedTools = options.prepareManagedTools !== false;
  const writeLaunchers = options.writeLaunchers !== false;
  const sourceRoot =
    String(options.sourceRoot || "").trim() || repoRootFromHere();
  const persistInstallerState = Boolean(options.persistInstallerState);
  const release = normalizeReleaseMetadataForInstall(
    options.release,
    sourceRoot,
  );
  const existingInitializationComplete =
    readExistingInitializationComplete(installDir);

  const ownership = describeOwnership(targetUser, installDir);
  const installServiceNow =
    manageDaemon && ["darwin", "linux", "win32"].includes(process.platform);
  const useElevatedWrite = shouldUseElevatedWrite(
    targetUser,
    ownership,
    currentUser,
  );
  const useElevatedService =
    installServiceNow && !isSameSystemUser(targetUser, currentUser);
  const serviceDeps = { findSystemUser, targetHomeForUser };

  const previousReleaseName = publishRuntime
    ? currentInstalledReleaseName(installDir, useElevatedWrite)
    : "";
  const publishedRuntime = publishRuntime
    ? publishInstalledRuntime(
        sourceRoot,
        installDir,
        targetUser,
        useElevatedWrite,
        {
          findSystemUser,
          release,
        },
      )
    : { releaseRoot: "", currentLink: "" };
  const currentReleaseName = publishedRuntime.releaseRoot
    ? publishedRuntime.releaseRoot.split(/[\\/]/).pop() || ""
    : "";
  const installedDocs = syncInstalledDocs(
    sourceRoot,
    installDir,
    targetUser,
    useElevatedWrite,
    { findSystemUser },
  );
  const prunedReleases = publishRuntime
    ? pruneInstalledReleases(
        installDir,
        3,
        publishedRuntime.releaseRoot,
        useElevatedWrite,
      )
    : [];
  const managedNodeRuntime = publishManagedNodeRuntime(
    sourceRoot,
    installDir,
    targetUser,
    useElevatedWrite,
    { findSystemUser },
  );
  const coreUpdateLaunchers =
    !persistInstallerState && writeLaunchers
      ? refreshCoreUpdateLaunchers({
          currentUser,
          targetUser,
          installDir,
          elevated: useElevatedWrite,
        })
      : null;
  if (manageDaemon) {
    refreshManagedServiceFiles(
      targetUser,
      installDir,
      useElevatedWrite,
      serviceDeps,
    );
  }
  if (prepareManagedTools) {
    await preparePiManagedToolsForInstall({
      currentUser,
      targetUser,
      targetHome: targetHomeForUser(targetUser),
      installDir,
    });
  }
  const shouldRestartBeforePersist =
    manageDaemon && !options.stopRuntimeBeforePublish;
  if (shouldRestartBeforePersist) {
    reconcileSystemdUserService(
      targetUser,
      installDir,
      "restart",
      useElevatedWrite,
      { findSystemUser },
    );
  }

  const written = persistInstallerState
    ? await persistInstallerOutputs(
        {
          currentUser,
          targetUser,
          installDir,
          provider,
          modelId,
          thinkingLevel,
          language,
          setDefaultTarget,
          authData,
          release,
          currentReleaseName,
          currentReleaseRoot: publishedRuntime.releaseRoot,
          managedFiles: buildInstalledManagedFilesManifest(sourceRoot),
          previousReleaseName,
          previousReleaseRoot: previousReleaseName
            ? installedReleaseRoot(installDir, previousReleaseName)
            : undefined,
          elevated: useElevatedWrite,
          initializationComplete: existingInitializationComplete,
          writeLaunchers,
        },
        {
          findSystemUser,
          ensureDir,
          readInstallerJson,
          writeJsonFileWithPrivilege,
          writeJsonFile,
          launcherMetadataPathForUser: (user) =>
            launcherMetadataPathForUser(user, homeForUser),
          readJsonFile,
          writeLaunchersForUser: (user, dir, launcherOptions) =>
            writeLaunchersForUser(user, dir, homeForUser, {
              ...launcherOptions,
              findSystemUser,
            }),
          reconcileInstallerManifest,
          runPrivileged,
          runCommandAsUser,
          captureCommandAsUser,
        },
      )
    : normalizeInstalledChatSettings(
        {
          targetUser,
          installDir,
          elevated: useElevatedWrite,
        },
        {
          findSystemUser,
          readInstallerJson,
          writeJsonFileWithPrivilege,
          writeJsonFile,
          runPrivileged,
          runCommandAsUser,
          captureCommandAsUser,
        },
      );

  let installedService: null | {
    kind: "launchd" | "systemd" | "windows-startup";
    label: string;
    servicePath: string;
    stdoutPath?: string;
    stderrPath?: string;
    service?: string;
  } = null;
  if (installServiceNow && shouldRestartBeforePersist) {
    try {
      installedService = installDaemonService(
        targetUser,
        installDir,
        useElevatedService,
        serviceDeps,
      );
    } catch (error) {
      if (persistInstallerState) throw error;
      installedService = null;
    }
  } else if (installServiceNow && process.platform === "linux") {
    installedService = buildSystemdUserService(
      targetUser,
      installDir,
      targetHomeForUser,
    );
  }

  const installerManifest = reconcileInstallerManifest(
    {
      targetUser,
      installDir,
      release,
      currentReleaseName,
      currentReleaseRoot: publishedRuntime.releaseRoot,
      managedFiles: buildInstalledManagedFilesManifest(sourceRoot),
      previousReleaseName,
      previousReleaseRoot: previousReleaseName
        ? installedReleaseRoot(installDir, previousReleaseName)
        : undefined,
      elevated: useElevatedWrite,
      ...(installedService
        ? {
            service: {
              kind: installedService.kind,
              label: installedService.label,
              path: installedService.servicePath,
            },
          }
        : {}),
    },
    {
      findSystemUser,
      ensureDir,
      readInstallerJson,
      writeJsonFileWithPrivilege,
      writeJsonFile,
      runPrivileged,
    },
  );

  if (manageDaemon && !shouldRestartBeforePersist) {
    if (installServiceNow) {
      try {
        installedService = installDaemonService(
          targetUser,
          installDir,
          useElevatedService,
          serviceDeps,
        );
      } catch (error) {
        if (persistInstallerState) throw error;
        installedService = null;
      }
    }
    reconcileSystemdUserService(
      targetUser,
      installDir,
      "restart",
      useElevatedWrite,
      { findSystemUser },
    );
  }

  const daemonReadyTimeoutMs = Number.isFinite(options.daemonReadyTimeoutMs)
    ? Math.max(0, Number(options.daemonReadyTimeoutMs))
    : defaultDaemonReadyTimeoutMs();
  const daemonReady = installedService
    ? await waitForSocket(
        daemonSocketPathForUser(targetUser, serviceDeps),
        daemonReadyTimeoutMs,
        targetUser,
      )
    : false;
  if (!daemonReady && installServiceNow && installedService) {
    throw new Error(
      `${options.daemonFailureCode}\n${collectDaemonFailureDetails(targetUser, installDir, { findSystemUser, targetHomeForUser })}`,
    );
  }

  return {
    currentUser,
    targetUser,
    installDir,
    written,
    installerManifest,
    publishedRuntime,
    managedNodeRuntime,
    coreUpdateLaunchers,
    installedDocs,
    installedDocsDir: installedDocs.rin,
    prunedReleases,
    installedService,
    daemonReady,
    initializationRequired: !existingInitializationComplete,
    ownership,
    serviceHint:
      process.platform === "darwin"
        ? installServiceNow
          ? "A macOS launchd LaunchAgent will be installed and started for this daemon."
          : "You skipped launchd installation for now; start the daemon explicitly when needed."
        : process.platform === "linux"
          ? installServiceNow
            ? "A Linux user service will be installed and started for this daemon when supported."
            : "You skipped dedicated Linux service installation for now; start the daemon explicitly when needed."
          : process.platform === "win32"
            ? "A Windows Startup launcher will be installed for this daemon."
            : "No dedicated service was installed; the installer will not start the daemon for you.",
  };
}

export async function finalizeCoreUpdate(options: {
  currentUser: string;
  targetUser: string;
  installDir: string;
  sourceRoot?: string;
  release?: FinalizeInstallOptions["release"];
}) {
  const result = await applyInstalledRuntime({
    ...options,
    persistInstallerState: false,
    stopRuntimeBeforePublish: true,
    daemonFailureCode: "rin_core_update_daemon_not_ready",
  });
  return { ...result, mode: "core-only" as const };
}

export async function finalizeInstallPlan(options: FinalizeInstallOptions) {
  return await applyInstalledRuntime({
    ...options,
    persistInstallerState: true,
    daemonFailureCode: "rin_installer_daemon_not_ready",
  });
}

export async function finalizeQuickRunInstall(options: FinalizeInstallOptions) {
  return await applyInstalledRuntime({
    ...options,
    persistInstallerState: true,
    publishRuntime: false,
    manageDaemon: false,
    prepareManagedTools: false,
    writeLaunchers: false,
    setDefaultTarget: false,
    daemonFailureCode: "rin_quick_run_install_failed",
  });
}
