import fs from "node:fs";

import { type FinalizeInstallOptions } from "./apply-plan.js";
import {
  launcherMetadataPathForUser,
  currentInstalledReleaseName,
  ensureDir,
  publishInstalledRuntime,
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
import {
  getBrowseStatus,
  prepareSearxngRuntime,
  stopSearxngSidecar,
} from "../rin-browse/service.js";
import {
  describeOwnership,
  findSystemUser,
  homeForUser,
  shouldUseElevatedWrite,
  targetHomeForUser,
} from "./users.js";

function isFreshInstallDirectory(installDir: string) {
  try {
    return fs.readdirSync(installDir).length === 0;
  } catch {
    return true;
  }
}

async function stopInstalledBrowseSidecars(installDir: string) {
  const status = getBrowseStatus(installDir);
  const instances = Array.isArray(status.instances) ? status.instances : [];
  for (const instance of instances) {
    const instanceId = String(instance?.instanceId || "").trim();
    if (!instanceId) continue;
    await stopSearxngSidecar(installDir, { instanceId });
  }
}

async function applyInstalledRuntime(
  options: FinalizeInstallOptions & {
    persistInstallerState?: boolean;
    daemonFailureCode: string;
    prepareBrowseRuntime?: boolean;
    stopRuntimeBeforePublish?: boolean;
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
  const builtInExtensions = Array.isArray(options.builtInExtensions)
    ? options.builtInExtensions
    : undefined;
  const sourceRoot =
    String(options.sourceRoot || "").trim() || repoRootFromHere();
  const persistInstallerState = Boolean(options.persistInstallerState);
  const release = options.release;
  const freshInstallDirectory = isFreshInstallDirectory(installDir);

  const ownership = describeOwnership(targetUser, installDir);
  const installServiceNow = ["darwin", "linux", "win32"].includes(
    process.platform,
  );
  const useElevatedWrite = shouldUseElevatedWrite(targetUser, ownership);
  const useElevatedService = installServiceNow && targetUser !== currentUser;
  const serviceDeps = { findSystemUser, targetHomeForUser };

  if (options.stopRuntimeBeforePublish) {
    await stopInstalledBrowseSidecars(installDir);
  }

  const previousReleaseName = currentInstalledReleaseName(
    installDir,
    useElevatedWrite,
  );
  const publishedRuntime = publishInstalledRuntime(
    sourceRoot,
    installDir,
    targetUser,
    useElevatedWrite,
    { findSystemUser, release },
  );
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
  const prunedReleases = pruneInstalledReleases(
    installDir,
    3,
    publishedRuntime.releaseRoot,
    useElevatedWrite,
  );
  refreshManagedServiceFiles(
    targetUser,
    installDir,
    useElevatedWrite,
    serviceDeps,
  );
  await preparePiManagedToolsForInstall({
    currentUser,
    targetUser,
    targetHome: targetHomeForUser(targetUser),
    installDir,
  });
  if (
    options.prepareBrowseRuntime !== false &&
    builtInExtensions?.includes("rin:browse")
  ) {
    await prepareSearxngRuntime(installDir).catch(() => undefined);
  }
  const shouldRestartBeforePersist = !options.stopRuntimeBeforePublish;
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
          builtInExtensions,
          release,
          currentReleaseName,
          currentReleaseRoot: publishedRuntime.releaseRoot,
          managedFiles: buildInstalledManagedFilesManifest(sourceRoot),
          previousReleaseName,
          previousReleaseRoot: previousReleaseName
            ? installedReleaseRoot(installDir, previousReleaseName)
            : undefined,
          elevated: useElevatedWrite,
          initializationComplete: !freshInstallDirectory,
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

  if (!shouldRestartBeforePersist) {
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
    : 5000;
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
    installedDocs,
    installedDocsDir: installedDocs.rin,
    prunedReleases,
    installedService,
    daemonReady,
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
    prepareBrowseRuntime: false,
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
