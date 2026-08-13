import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { type FinalizeInstallOptions } from "./apply-plan.js";
import {
  activateInstalledRuntimeReplacement,
  buildInstalledManagedFilesManifest,
  captureCommandAsUser,
  commitInstalledRuntimeReplacement,
  currentInstalledReleaseName,
  discardStagedInstalledRuntime,
  ensureDir,
  launcherMetadataPathForUser,
  pruneInstalledReleases,
  publishInstalledRuntime,
  publishManagedNodeRuntime,
  readInstallerJson,
  readJsonFileOrDefault,
  rollbackInstalledRuntimeReplacement,
  runCommandAsUser,
  runPrivileged,
  switchInstalledCurrentRelease,
  syncInstalledDocs,
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
import { buildGitHubRefArchiveUrl } from "../rin-lib/release.js";
import { sleep } from "../platform/process.js";
import {
  acquireTargetDaemonMigrationLock,
  acquireTargetDaemonUpdateFence,
} from "./daemon-update-fence.js";
import {
  createManagedRuntimeServiceActionContext,
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

async function stopManagedRuntimeForUpdate(
  context: ReturnType<typeof createManagedRuntimeServiceActionContext>,
  service?: ManagedRuntimeService,
) {
  await tryManagedServiceAction(context, "stop", service);
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    if (!(await context.canConnectSocket())) return;
    await sleep(150);
  }
  if (!(await context.canConnectSocket())) return;
  throw new Error("rin_update_daemon_stop_incomplete");
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
  const readLauncherJson = deps.readJsonFile || readJsonFileOrDefault;
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

export async function releaseManagedRuntimeFences(options: {
  releaseMigration: () => Promise<void>;
  releaseUpdate: () => Promise<void>;
}) {
  const releaseErrors: unknown[] = [];
  try {
    await options.releaseMigration();
  } catch (error) {
    releaseErrors.push(error);
  }
  try {
    await options.releaseUpdate();
  } catch (error) {
    releaseErrors.push(error);
  }
  if (releaseErrors.length > 0) {
    throw new AggregateError(
      releaseErrors,
      "rin_update_composite_fence_release_failed",
    );
  }
}

export async function runManagedRuntimeTransition<
  TMutation,
  TActivation,
>(steps: {
  acquireFence?: () =>
    | { release(): unknown | Promise<unknown> }
    | Promise<{ release(): unknown | Promise<unknown> }>;
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
  let fence: { release(): unknown | Promise<unknown> } | null = null;
  let stopAttempted = false;
  let commitCompleted = false;
  let restartAttempted = false;
  const releaseFence = async () => {
    if (!fence) return;
    const heldFence = fence;
    await heldFence.release();
    fence = null;
  };
  const releaseFenceWithRetry = async () => {
    try {
      await releaseFence();
    } catch (firstReleaseError) {
      try {
        await releaseFence();
      } catch (secondReleaseError) {
        throw new AggregateError(
          [firstReleaseError, secondReleaseError],
          "rin_update_fence_release_failed",
        );
      }
    }
  };
  try {
    fence = (await steps.acquireFence?.()) || null;
    stopAttempted = true;
    await steps.stop();
    const mutation = await steps.mutate();
    const activation = await steps.activate(mutation);
    await steps.commit?.(mutation, activation);
    commitCompleted = true;
    await releaseFence();
    restartAttempted = true;
    await steps.restart();
    return { mutation, activation };
  } catch (error) {
    if (stopAttempted && !restartAttempted) {
      if (!commitCompleted) {
        try {
          await steps.recover?.(error);
        } catch (recoveryError) {
          try {
            await releaseFenceWithRetry();
          } catch (releaseError) {
            throw new AggregateError(
              [error, recoveryError, releaseError],
              "rin_update_failure_recovery_and_fence_release_failed",
              { cause: error },
            );
          }
          throw new AggregateError(
            [error, recoveryError],
            "rin_update_failure_recovery_failed",
            { cause: error },
          );
        }
      }
      try {
        await releaseFenceWithRetry();
        restartAttempted = true;
        await steps.restart();
      } catch (restartError) {
        throw new AggregateError(
          [error, restartError],
          "rin_update_failure_recovery_restart_failed",
          { cause: error },
        );
      }
    } else {
      await releaseFenceWithRetry();
    }
    throw error;
  }
}

export function createInstalledRuntimeReplacementLifecycle(
  options: {
    releaseRoot: string;
    stagedReleaseRoot?: string;
    elevated?: boolean;
    migrationOptions: { migrationRuntimeRoot: string };
  },
  deps: {
    activate: typeof activateInstalledRuntimeReplacement;
    commit: typeof commitInstalledRuntimeReplacement;
    rollback: typeof rollbackInstalledRuntimeReplacement;
  } = {
    activate: activateInstalledRuntimeReplacement,
    commit: commitInstalledRuntimeReplacement,
    rollback: rollbackInstalledRuntimeReplacement,
  },
) {
  let replacement: { backupReleaseRoot: string } | null = null;
  return {
    isActive() {
      return replacement !== null;
    },
    activate() {
      if (!options.stagedReleaseRoot) return false;
      replacement = deps.activate(
        options.releaseRoot,
        options.stagedReleaseRoot,
        Boolean(options.elevated),
      );
      options.migrationOptions.migrationRuntimeRoot = options.releaseRoot;
      return true;
    },
    commit() {
      if (!replacement) return;
      deps.commit(replacement.backupReleaseRoot, Boolean(options.elevated));
      replacement = null;
    },
    rollback() {
      if (!replacement) return;
      deps.rollback(
        options.releaseRoot,
        replacement.backupReleaseRoot,
        Boolean(options.elevated),
      );
      replacement = null;
    },
  };
}

async function applyInstalledRuntime(
  options: FinalizeInstallOptions & {
    persistInstallerState?: boolean;
    daemonFailureCode: string;
    publishRuntime?: boolean;
    manageDaemon?: boolean;
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
          replaceExisting: Boolean(options.reinstallCurrentRelease),
        },
      )
    : { releaseRoot: "", currentLink: "", stagedReleaseRoot: undefined };
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
    let migrationRuntimeRoot =
      publishedRuntime.stagedReleaseRoot ||
      publishedRuntime.releaseRoot ||
      sourceRoot;
    const migrationOptions = {
      targetUser,
      installDir,
      elevated: useElevatedWrite,
      currentReleaseRoot: publishedRuntime.releaseRoot,
      migrationRuntimeRoot,
      targetNodePath: executionContext.targetNodePath,
      chatRuntimeWillBeQuiesced: Boolean(manageDaemon && publishRuntime),
      chatRuntimeQuiesced: false,
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
              chatRuntimeWillBeQuiesced:
                migrationOptions.chatRuntimeWillBeQuiesced,
              chatRuntimeQuiesced: migrationOptions.chatRuntimeQuiesced,
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
              readJsonFile: readJsonFileOrDefault,
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

    const runtimeReplacement = createInstalledRuntimeReplacementLifecycle({
      releaseRoot: publishedRuntime.releaseRoot,
      stagedReleaseRoot: publishedRuntime.stagedReleaseRoot,
      elevated: useElevatedWrite,
      migrationOptions,
    });
    const reconcileInstalledState = () => {
      if (runtimeReplacement.activate()) {
        migrationRuntimeRoot = publishedRuntime.releaseRoot;
        stagedRuntimeNeedsCleanup = false;
      } else if (deferRuntimeActivation) {
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
    const daemonSocketPath = daemonSocketPathForUser(targetUser, serviceDeps);
    const service =
      managedRuntimeServiceFromInstallSpec(installedService) ||
      buildInstallStageManagedRuntimeService(targetUser, installDir);
    const lockModulePath = path.join(
      sourceRoot,
      "dist/core/rin-daemon/lock.js",
    );
    let migrationLock: Awaited<
      ReturnType<typeof acquireTargetDaemonMigrationLock>
    > | null = null;
    const transition = await runManagedRuntimeTransition({
      acquireFence:
        manageDaemon && publishRuntime
          ? async () => {
              const updateFence = await acquireTargetDaemonUpdateFence({
                targetUser,
                nodePath: executionContext.targetNodePath,
                lockModulePath,
                agentDir: serviceContext.agentDir,
                socketPath: daemonSocketPath,
              });
              return {
                async release() {
                  await releaseManagedRuntimeFences({
                    releaseMigration: async () => {
                      if (!migrationLock) return;
                      const heldMigrationLock = migrationLock;
                      await heldMigrationLock.release();
                      migrationLock = null;
                    },
                    releaseUpdate: async () => updateFence.release(),
                  });
                },
              };
            }
          : undefined,
      stop: async () => {
        if (manageDaemon && publishRuntime) {
          await stopManagedRuntimeForUpdate(serviceContext, service);
          migrationLock = await acquireTargetDaemonMigrationLock({
            targetUser,
            nodePath: executionContext.targetNodePath,
            lockModulePath,
            agentDir: serviceContext.agentDir,
            socketPath: daemonSocketPath,
          });
          migrationOptions.chatRuntimeQuiesced = true;
        }
      },
      mutate: writeInstalledState,
      activate: async () => reconcileInstalledState(),
      commit: async () => {
        if (publishRuntime) {
          finalizeInstallUpgradeMigrations(migrationOptions, migrationDeps);
          runtimeReplacement.commit();
        }
      },
      recover: async () => {
        if (publishRuntime) {
          rollbackInstallUpgradeMigrations(migrationOptions, migrationDeps);
          if (runtimeReplacement.isActive()) {
            runtimeReplacement.rollback();
          } else if (deferRuntimeActivation && previousReleaseName) {
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
          daemonSocketPath,
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
          publishedRuntime.stagedReleaseRoot || publishedRuntime.releaseRoot,
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
    writeLaunchers: false,
    setDefaultTarget: false,
    daemonFailureCode: "rin_quick_run_install_failed",
  });
}
