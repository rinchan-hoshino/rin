import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { type FinalizeInstallOptions } from "./apply-plan.js";
import {
  launcherMetadataPathForUser,
  currentInstalledReleaseName,
  discardStagedInstalledRuntime,
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
  switchInstalledCurrentRelease,
  writeJsonFile,
  writeJsonFileWithPrivilege,
  writeLaunchersForUser,
} from "./fs-utils.js";
import { createInstallExecutionContext } from "./execution-context.js";
import { defaultInstallDirForHome, installedReleaseRoot } from "./paths.js";
import {
  finalizeInstallUpgradeMigrations,
  normalizeInstalledChatSettings,
  persistInstallerOutputs,
  preflightInstallUpgradeMigrations,
  reconcileInstallerManifest,
  rollbackInstallUpgradeMigrations,
} from "./persist.js";
import {
  collectDaemonFailureDetails,
  daemonSocketPathForUser,
  buildSystemdUserService,
  installDaemonService,
  refreshManagedServiceFiles,
  waitForSocket,
} from "./service.js";
import { detectCurrentUser, repoRootFromHere } from "./common.js";
import { preparePiManagedToolsForInstall } from "./pi-tools.js";
import { buildGitHubRefArchiveUrl } from "../rin-lib/release.js";
import {
  createManagedRuntimeServiceActionContext,
  setManagedServiceStartHold,
  tryManagedServiceAction,
  type ManagedRuntimeService,
} from "../rin/managed-runtime-service.js";
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

function managedRuntimeServiceFromInstallSpec(
  service: null | {
    kind: "launchd" | "systemd" | "windows-startup";
    label: string;
    servicePath: string;
  },
): ManagedRuntimeService | undefined {
  if (!service?.kind || !service.label) return undefined;
  return {
    kind: service.kind,
    label: service.label,
    path: service.servicePath || undefined,
  };
}

function buildInstallStageManagedRuntimeService(
  targetUser: string,
  installDir: string,
): ManagedRuntimeService | undefined {
  if (process.platform !== "linux") return undefined;
  const service = buildSystemdUserService(
    targetUser,
    installDir,
    targetHomeForUser,
  );
  return managedRuntimeServiceFromInstallSpec(service);
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

export async function runManagedRuntimeTransition<
  TMutation,
  TActivation,
>(steps: {
  stop: () => unknown | Promise<unknown>;
  mutate: () => TMutation | Promise<TMutation>;
  activate: (mutation: TMutation) => TActivation | Promise<TActivation>;
  commit?: (
    mutation: TMutation,
    activation: TActivation,
  ) => unknown | Promise<unknown>;
  recover?: (error: unknown) => unknown | Promise<unknown>;
  restart: () => unknown | Promise<unknown>;
}) {
  let stopAttempted = false;
  let restartAttempted = false;
  try {
    stopAttempted = true;
    await steps.stop();
    const mutation = await steps.mutate();
    const activation = await steps.activate(mutation);
    await steps.commit?.(mutation, activation);
    restartAttempted = true;
    await steps.restart();
    return { mutation, activation };
  } catch (error) {
    if (stopAttempted && !restartAttempted) {
      try {
        await steps.recover?.(error);
      } catch (recoveryError) {
        throw new AggregateError(
          [error, recoveryError],
          "rin_update_failure_recovery_failed",
          { cause: error },
        );
      }
      try {
        restartAttempted = true;
        await steps.restart();
      } catch (restartError) {
        throw new AggregateError(
          [error, restartError],
          "rin_update_failure_recovery_restart_failed",
          { cause: error },
        );
      }
    }
    throw error;
  }
}

async function applyInstalledRuntime(
  options: FinalizeInstallOptions & {
    persistInstallerState?: boolean;
    daemonFailureCode: string;
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
  const setDefaultTarget = options.setDefaultTarget !== false;
  const authData = options.authData || {};
  const publishRuntime = options.publishRuntime !== false;
  const manageDaemon = options.manageDaemon !== false;
  if (publishRuntime && !manageDaemon) {
    throw new Error("Runtime publishing requires managed daemon control.");
  }
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
  const targetHome = targetHomeForUser(targetUser);

  const previousReleaseName = publishRuntime
    ? currentInstalledReleaseName(installDir, useElevatedWrite)
    : "";
  const deferRuntimeActivation = Boolean(
    publishRuntime && !persistInstallerState,
  );
  const publishedRuntime = publishRuntime
    ? publishInstalledRuntime(
        sourceRoot,
        installDir,
        targetUser,
        useElevatedWrite,
        {
          findSystemUser,
          release,
          activate: !deferRuntimeActivation,
        },
      )
    : { releaseRoot: "", currentLink: "" };
  let stagedRuntimeNeedsCleanup = deferRuntimeActivation;
  try {
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
    let prunedReleases =
      publishRuntime && !deferRuntimeActivation
        ? pruneInstalledReleases(
            installDir,
            3,
            publishedRuntime.releaseRoot,
            useElevatedWrite,
          )
        : { keepCount: 3, kept: [], removed: [] };
    const managedNodeRuntime = publishManagedNodeRuntime(
      sourceRoot,
      installDir,
      targetUser,
      useElevatedWrite,
      { findSystemUser },
    );
    const executionContext = createInstallExecutionContext(
      {
        currentUser,
        targetUser,
        targetHome,
        installDir,
        targetNodePath: managedNodeRuntime?.nodeExecutable,
      },
      serviceDeps,
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
        targetHome,
        installDir,
        targetNodePath: executionContext.targetNodePath,
      });
    }
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
          { activate: false },
        );
      } catch (error) {
        if (persistInstallerState) throw error;
      }
    }

    const daemonReadyTimeoutMs = Number.isFinite(options.daemonReadyTimeoutMs)
      ? Math.max(0, Number(options.daemonReadyTimeoutMs))
      : defaultDaemonReadyTimeoutMs();
    const migrationRuntimeRoot = publishedRuntime.releaseRoot || sourceRoot;
    const migrationOptions = {
      targetUser,
      installDir,
      elevated: useElevatedWrite,
      currentReleaseRoot: publishedRuntime.releaseRoot,
      migrationRuntimeRoot,
      targetNodePath: executionContext.targetNodePath,
    };
    const migrationDeps = {
      findSystemUser,
      readInstallerJson,
      writeJsonFileWithPrivilege,
      writeJsonFile,
      runPrivileged,
      runCommandAsUser,
      captureCommandAsUser,
    };
    if (!persistInstallerState && publishRuntime) {
      preflightInstallUpgradeMigrations(migrationOptions, migrationDeps);
    }

    const writeInstalledState = async () =>
      persistInstallerState
        ? await persistInstallerOutputs(
            {
              currentUser,
              targetUser,
              installDir,
              provider,
              modelId,
              thinkingLevel,
              setDefaultTarget,
              authData,
              release,
              currentReleaseName,
              currentReleaseRoot: publishedRuntime.releaseRoot,
              migrationRuntimeRoot,
              targetNodePath: executionContext.targetNodePath,
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
        : normalizeInstalledChatSettings(migrationOptions, migrationDeps);

    const reconcileInstalledState = () => {
      if (deferRuntimeActivation) {
        switchInstalledCurrentRelease(
          installDir,
          currentReleaseName,
          targetUser,
          useElevatedWrite,
          { findSystemUser },
        );
        stagedRuntimeNeedsCleanup = false;
      }
      return reconcileInstallerManifest(
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
    };
    const serviceContext = createManagedRuntimeServiceActionContext({
      currentUser,
      targetUser,
      installDir,
    });
    const service =
      managedRuntimeServiceFromInstallSpec(installedService) ||
      buildInstallStageManagedRuntimeService(targetUser, installDir);
    let serviceStartsHeld = false;
    const transition = await runManagedRuntimeTransition({
      stop: async () => {
        if (manageDaemon && publishRuntime) {
          serviceStartsHeld = true;
          await setManagedServiceStartHold(serviceContext, true, service);
          await tryManagedServiceAction(serviceContext, "stop", service);
        }
      },
      mutate: writeInstalledState,
      activate: async () => reconcileInstalledState(),
      commit: async () => {
        if (publishRuntime) {
          finalizeInstallUpgradeMigrations(migrationOptions, migrationDeps);
        }
      },
      recover: async () => {
        if (publishRuntime) {
          rollbackInstallUpgradeMigrations(migrationOptions, migrationDeps);
          if (deferRuntimeActivation && previousReleaseName) {
            switchInstalledCurrentRelease(
              installDir,
              previousReleaseName,
              targetUser,
              useElevatedWrite,
              { findSystemUser },
            );
          }
        }
      },
      restart: async () => {
        if (serviceStartsHeld) {
          await setManagedServiceStartHold(serviceContext, false, service);
          serviceStartsHeld = false;
        }
        if (manageDaemon) {
          await tryManagedServiceAction(serviceContext, "restart", service);
        }
      },
    });
    const written = transition.mutation;
    const installerManifest = transition.activation;
    if (publishRuntime && deferRuntimeActivation) {
      prunedReleases = pruneInstalledReleases(
        installDir,
        3,
        publishedRuntime.releaseRoot,
        useElevatedWrite,
      );
    }

    const daemonReady = installedService
      ? await waitForSocket(
          daemonSocketPathForUser(targetUser, serviceDeps),
          daemonReadyTimeoutMs,
          targetUser,
          {
            currentUser,
            targetNodePath: executionContext.targetNodePath,
          },
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
  } catch (error) {
    if (stagedRuntimeNeedsCleanup) {
      try {
        discardStagedInstalledRuntime(
          installDir,
          publishedRuntime.releaseRoot,
          useElevatedWrite,
        );
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "rin_staged_release_cleanup_failed",
          { cause: error },
        );
      }
    }
    throw error;
  }
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
