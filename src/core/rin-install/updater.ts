import fs from "node:fs";
import path from "node:path";

import { confirm, intro, outro, select } from "@clack/prompts";
import chalk from "chalk";

import {
  getReleaseRepoUrl,
  loadReleaseManifestForNetwork,
  requireConcreteGitRelease,
  resolveReleaseRequest,
  type InstalledReleaseInfo,
  type ReleaseChannel,
  type ReleaseRequest,
  type ResolvedRelease,
} from "../rin-lib/release.js";

import { createInstallerCopy, type InstallerCopy } from "../product-copy.js";
import { assertUpdateConfirmationAvailable } from "./update-confirmation.js";
import { discoverInstalledTargets } from "./update-targets.js";
import {
  runFinalizeInstallPlanInChild as runFinalizeInstallPlanInChildImpl,
  type FinalizeInstallOptions,
} from "./apply-plan.js";
import { renderInstallerNote, wrapInstallerNoteText } from "./interactive.js";
import { commandAsUserInvocation, readInstallerJson } from "./fs-utils.js";
import { installerManifestPath, managedNodeExecutablePath } from "./paths.js";
import { forwardedUpdateJobEnvironment } from "./update-job-auth.js";
import { runInstallerProgress } from "./progress.js";
import { isSameSystemUser, targetHomeForUser } from "./users.js";
import {
  createUpdateRuntimeSourceWorkspace,
  isInstalledReleaseCurrent,
  prepareUpdateRuntimeSource,
  preparedRuntimeNodeExecutable,
  resolveGitCommitForRelease,
  runUpdateCommand,
} from "./update-workflow.js";

export function renderUpdaterNote(message?: string, title?: string) {
  return renderInstallerNote(
    wrapInstallerNoteText(
      String(message || ""),
      process.stderr.columns || process.stdout.columns || 80,
    ),
    String(title || ""),
    {
      border: chalk.gray,
      body: chalk.dim,
      symbol: chalk.green,
      title: chalk.reset,
    },
  );
}

function note(message?: string, title?: string) {
  process.stdout.write(`${renderUpdaterNote(message, title)}\n`);
}

async function selectUpdateTarget(
  ensureNotCancelled: <T>(value: T | symbol) => T,
  promptSelect: typeof select,
  copy: InstallerCopy,
) {
  const targets = discoverInstalledTargets();
  if (!targets.length) return null;
  if (targets.length === 1) return targets[0]!;
  return targets[
    Number(
      ensureNotCancelled(
        await promptSelect({
          message: copy.chooseUpdateTargetMessage,
          options: targets.map((item, index) => ({
            value: index,
            label: `${item.targetUser} → ${item.installDir}`,
            hint: `${item.ownerHome} · ${item.source}`,
          })),
        }),
      ),
    )
  ]!;
}

function isReleaseChannel(value: string): value is ReleaseChannel {
  return ["stable", "beta", "nightly", "git"].includes(value);
}

function defaultReadInstalledRelease(target: {
  currentUser: string;
  targetUser: string;
  installDir: string;
}) {
  const elevated = target.targetUser !== target.currentUser;
  return (
    readInstallerJson<any>(
      installerManifestPath(target.installDir),
      {},
      elevated,
    )?.currentRelease?.release || null
  );
}

function readInstalledReleasePreference(installedRelease: any): {
  channel: ReleaseChannel;
  branch: string;
} | null {
  const channel = String(installedRelease?.channel || "").trim();
  if (!isReleaseChannel(channel)) return null;
  if (channel !== "git") return { channel, branch: "" };
  return { channel, branch: String(installedRelease?.branch || "").trim() };
}

async function resolveUpdateRelease(options: {
  installedRelease: any;
  releaseRequest?: ReleaseRequest & { explicitReleaseChannel?: boolean };
}): Promise<ResolvedRelease> {
  const manifest = await loadReleaseManifestForNetwork();
  const inherited = options.releaseRequest?.explicitReleaseChannel
    ? null
    : readInstalledReleasePreference(options.installedRelease);
  const requested = resolveReleaseRequest(manifest, {
    channel: inherited?.channel || options.releaseRequest?.channel || "stable",
    branch: options.releaseRequest?.branch || inherited?.branch || "",
    version: options.releaseRequest?.version || "",
  });
  return resolveGitCommitForRelease(
    manifest.git?.repoUrl || getReleaseRepoUrl(manifest),
    requested,
  );
}

export function buildTargetUserUpdaterCommand(
  options: {
    sourceRoot: string;
    targetUser: string;
    ownerHome: string;
    installDir: string;
    release: ResolvedRelease;
  },
  deps: {
    commandAsUserInvocation?: typeof commandAsUserInvocation;
  } = {},
) {
  const releaseArgs = [
    "--version",
    options.release.channel === "git"
      ? options.release.ref
      : options.release.version,
  ];
  const invocation = (deps.commandAsUserInvocation ?? commandAsUserInvocation)(
    options.targetUser,
    managedNodeExecutablePath(options.installDir),
    [
      path.join(
        options.sourceRoot,
        "dist",
        "app",
        "rin-install",
        "update-payload.js",
      ),
      "--target-user",
      options.targetUser,
      "--install-dir",
      options.installDir,
      "--yes",
      "--preconfirmed",
      `--${options.release.channel}`,
      ...releaseArgs,
    ],
    {
      HOME: options.ownerHome,
      ...forwardedUpdateJobEnvironment(),
    },
  );
  return {
    ...invocation,
    options: {
      cwd: options.sourceRoot,
      env: process.env,
    },
  };
}

async function runTargetUserUpdater(options: {
  sourceRoot: string;
  targetUser: string;
  ownerHome: string;
  installDir: string;
  release: ResolvedRelease;
}) {
  const command = buildTargetUserUpdaterCommand(options);
  await runUpdateCommand(command.command, command.args, command.options);
}

export function buildPreparedUpdaterCommand(options: {
  sourceRoot: string;
  releaseFile: string;
  currentUser: string;
  targetUser: string;
  installDir: string;
}) {
  return {
    command: preparedRuntimeNodeExecutable(options.sourceRoot),
    args: [
      path.join(
        options.sourceRoot,
        "dist",
        "app",
        "rin-install",
        "update-payload.js",
      ),
      "--target-user",
      options.targetUser,
      "--install-dir",
      options.installDir,
      "--yes",
      "--preconfirmed",
      "--release-file",
      options.releaseFile,
    ],
    options: { cwd: options.sourceRoot, env: { ...process.env } },
  };
}

async function runPreparedUpdater(options: {
  sourceRoot: string;
  releaseFile: string;
  currentUser: string;
  targetUser: string;
  installDir: string;
}) {
  const command = buildPreparedUpdaterCommand(options);
  await runUpdateCommand(command.command, command.args, command.options);
}

export async function startUpdater(deps: {
  detectCurrentUser: () => string;
  repoRootFromHere: () => string;
  ensureNotCancelled: <T>(value: T | symbol) => T;
  release?: InstalledReleaseInfo;
  releaseRequest?: ReleaseRequest & { explicitReleaseChannel?: boolean };
  select?: typeof select;
  confirm?: typeof confirm;
  copy?: InstallerCopy;
  resolveUpdateRelease?: typeof resolveUpdateRelease;
  readInstalledRelease?: (target: {
    currentUser: string;
    targetUser: string;
    installDir: string;
    ownerHome: string;
  }) => any;
  runFinalizeInstallPlanInChild?: typeof runFinalizeInstallPlanInChildImpl;
  runTargetUserUpdater?: typeof runTargetUserUpdater;
  requestedInstallDir?: string;
  requestedTargetUser?: string;
  assumeYes?: boolean;
  preconfirmed?: boolean;
}) {
  const currentUser = deps.detectCurrentUser();
  const promptSelect = deps.select || select;
  const promptConfirm = deps.confirm || confirm;
  const initialCopy = deps.copy || createInstallerCopy();
  const runFinalizeInstallPlanInChild =
    deps.runFinalizeInstallPlanInChild || runFinalizeInstallPlanInChildImpl;

  intro(initialCopy.updaterIntroTitle);

  const requestedInstallDir = String(deps.requestedInstallDir || "").trim();
  const requestedTargetUser = String(deps.requestedTargetUser || "").trim();
  const target =
    requestedInstallDir && requestedTargetUser
      ? {
          targetUser: requestedTargetUser,
          installDir: requestedInstallDir,
          ownerHome: targetHomeForUser(requestedTargetUser),
          source: "launcher" as const,
        }
      : await selectUpdateTarget(
          deps.ensureNotCancelled,
          promptSelect,
          initialCopy,
        );
  if (!target) {
    note(initialCopy.noUpdateTargetsText, initialCopy.updateTargetsTitle);
    outro(initialCopy.updaterNothingUpdated);
    return;
  }

  const installDir = target.installDir;
  const targetUser = target.targetUser;
  const copy = initialCopy;

  const installedRelease = (
    deps.readInstalledRelease || defaultReadInstalledRelease
  )({
    currentUser,
    targetUser,
    installDir,
    ownerHome: target.ownerHome,
  });
  const resolvedRelease = requireConcreteGitRelease(
    deps.release ||
      (await (deps.resolveUpdateRelease ?? resolveUpdateRelease)({
        installedRelease,
        releaseRequest: deps.releaseRequest,
      })),
  );

  const reinstallCurrentRelease = isInstalledReleaseCurrent(
    installedRelease,
    resolvedRelease,
  );
  if (reinstallCurrentRelease) {
    note(
      copy.buildUpdateReinstallCurrentText({
        installDir,
        sourceLabel: resolvedRelease.sourceLabel,
      }),
      copy.updateReinstallCurrentTitle,
    );
  }

  if (!deps.preconfirmed) {
    note(
      copy.buildUpdateTargetText({
        currentUser,
        targetUser,
        installDir,
        source: target.source,
        ownerHome: target.ownerHome,
      }),
      copy.updateTargetsTitle,
    );

    note(
      copy.buildUpdatePlanText({
        currentUser,
        targetUser,
        installDir,
        source: target.source,
        ownerHome: target.ownerHome,
        sourceLabel: resolvedRelease.sourceLabel,
      }),
      copy.updatePlanTitle,
    );

    assertUpdateConfirmationAvailable({
      assumeYes: deps.assumeYes,
      stdinIsTTY: process.stdin.isTTY === true,
      stdoutIsTTY: process.stdout.isTTY === true,
    });
    const shouldProceed = deps.assumeYes
      ? true
      : deps.ensureNotCancelled(
          await promptConfirm({
            message: deps.release
              ? copy.publishUpdateConfirmMessage
              : copy.fetchAndApplyUpdateConfirmMessage,
            initialValue: true,
          }),
        );
    if (!shouldProceed) {
      outro(copy.updaterFinishedWithoutWritingChanges);
      return;
    }
  }

  if (
    !deps.release &&
    process.platform !== "win32" &&
    !isSameSystemUser(currentUser, targetUser)
  ) {
    await (deps.runTargetUserUpdater ?? runTargetUserUpdater)({
      sourceRoot: deps.repoRootFromHere(),
      targetUser,
      ownerHome: target.ownerHome,
      installDir,
      release: resolvedRelease,
    });
    return;
  }

  if (!deps.release) {
    const workspace = createUpdateRuntimeSourceWorkspace(resolvedRelease);
    try {
      await prepareUpdateRuntimeSource({
        release: resolvedRelease,
        workspace,
        copy,
      });
      await runPreparedUpdater({
        sourceRoot: workspace.sourceRoot,
        releaseFile: workspace.releaseFile,
        currentUser,
        targetUser,
        installDir,
      });
    } finally {
      try {
        fs.rmSync(workspace.tempRoot, { recursive: true, force: true });
      } catch {}
    }
    return;
  }

  const result = await runInstallerProgress(
    copy.refreshingInstalledTargetMessage,
    () =>
      runFinalizeInstallPlanInChild(
        {
          currentUser,
          targetUser,
          installDir,
          sourceRoot: deps.repoRootFromHere(),
          daemonReadyTimeoutMs: 30_000,
          coreUpdate: true,
          reinstallCurrentRelease,
          release: resolvedRelease,
        } satisfies FinalizeInstallOptions,
        copy.refreshingInstalledTargetMessage,
        {
          writeStatus() {},
          entryPath: path.join(
            deps.repoRootFromHere(),
            "dist",
            "app",
            "rin-install",
            "main.js",
          ),
        },
      ),
    {
      successMessage: copy.installStepComplete,
      failureMessage: copy.installStepFailed,
    },
  );

  const {
    written,
    publishedRuntime,
    installedDocs,
    installedDocsDir,
    installedService,
    daemonReady,
    serviceHint,
  } = result;
  const userSuffix = currentUser === targetUser ? "" : ` -u ${targetUser}`;

  note(
    copy.buildUpdatedTargetText({
      installDir,
      writtenPaths: [
        written.launcherPath,
        written.rinPath,
        written.rinInstallPath,
        publishedRuntime.currentLink,
        publishedRuntime.releaseRoot,
        installedDocsDir,
        ...(Array.isArray(installedDocs?.pi) ? installedDocs.pi : []),
        installedService?.servicePath,
      ].filter(Boolean) as string[],
      prunedReleaseCount: result.prunedReleases.removed.length,
      ...(installedService
        ? {
            serviceKind: installedService.kind,
            serviceLabel: installedService.label,
          }
        : {}),
    }),
    copy.writtenPathsTitle,
  );

  note(
    copy.buildAfterUpdateText({ serviceHint, daemonReady, userSuffix }),
    copy.afterInitTitle,
  );

  outro(
    copy.updaterOutroUpdated(targetUser, installDir, daemonReady, userSuffix),
  );
}
