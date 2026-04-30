import { type FinalizeInstallOptions } from "./apply-plan.js";
import {
  launcherMetadataPathForUser,
  ensureDir,
  publishInstalledRuntime,
  pruneInstalledReleases,
  readInstallerJson,
  readJsonFile,
  runPrivileged,
  syncInstalledDocs,
  writeJsonFile,
  writeJsonFileWithPrivilege,
  writeLaunchersForUser,
} from "./fs-utils.js";
import { defaultInstallDirForHome } from "./paths.js";
import {
  normalizeInstalledChatSettings,
  persistInstallerOutputs,
  reconcileInstallerManifest,
} from "./persist.js";
import {
  collectDaemonFailureDetails,
  daemonSocketPathForUser,
  installDaemonService,
  reconcileSystemdUserService,
  refreshManagedServiceFiles,
  waitForSocket,
} from "./service.js";
import { detectCurrentUser, repoRootFromHere } from "./common.js";
import {
  describeOwnership,
  findSystemUser,
  homeForUser,
  shouldUseElevatedWrite,
  targetHomeForUser,
} from "./users.js";

async function applyInstalledRuntime(
  options: FinalizeInstallOptions & {
    persistInstallerState?: boolean;
    daemonFailureCode: string;
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
  const chatConfig = options.chatConfig || null;
  const authData = options.authData || {};
  const sourceRoot =
    String(options.sourceRoot || "").trim() || repoRootFromHere();
  const persistInstallerState = Boolean(options.persistInstallerState);
  const release = options.release;

  const ownership = describeOwnership(targetUser, installDir);
  const installServiceNow = ["darwin", "linux", "win32"].includes(
    process.platform,
  );
  const useElevatedWrite = shouldUseElevatedWrite(targetUser, ownership);
  const useElevatedService = installServiceNow && targetUser !== currentUser;
  const serviceDeps = { findSystemUser, targetHomeForUser };

  const publishedRuntime = publishInstalledRuntime(
    sourceRoot,
    installDir,
    targetUser,
    useElevatedWrite,
    { findSystemUser, release },
  );
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
  const installerManifest = reconcileInstallerManifest(
    {
      targetUser,
      installDir,
      provider,
      modelId,
      thinkingLevel,
      language,
      chatConfig,
      release,
      elevated: useElevatedWrite,
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
  refreshManagedServiceFiles(
    targetUser,
    installDir,
    useElevatedWrite,
    serviceDeps,
  );
  reconcileSystemdUserService(
    targetUser,
    installDir,
    "restart",
    useElevatedWrite,
    { findSystemUser },
  );

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
          chatConfig,
          authData,
          release,
          elevated: useElevatedWrite,
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

  const daemonReady = installedService
    ? await waitForSocket(
        daemonSocketPathForUser(targetUser, serviceDeps),
        5000,
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
