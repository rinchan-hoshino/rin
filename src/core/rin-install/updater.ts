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

import { createInstallerI18n, type InstallerI18n } from "./i18n.js";
import { discoverInstalledTargets } from "./update-targets.js";
import {
  runFinalizeInstallPlanInChild as runFinalizeInstallPlanInChildImpl,
  type FinalizeInstallOptions,
} from "./apply-plan.js";
import { renderInstallerNote, wrapInstallerNoteText } from "./interactive.js";
import { commandAsUserInvocation, readInstallerJson } from "./fs-utils.js";
import { installerManifestPath, managedNodeExecutablePath } from "./paths.js";
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
  i18n: InstallerI18n,
) {
  const targets = discoverInstalledTargets();
  if (!targets.length) return null;
  if (targets.length === 1) return targets[0]!;
  return targets[
    Number(
      ensureNotCancelled(
        await promptSelect({
          message: i18n.chooseUpdateTargetMessage,
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
  const releaseArgs =
    options.release.channel === "git"
      ? ["--branch", options.release.ref]
      : ["--version", options.release.version];
  const invocation = (deps.commandAsUserInvocation ?? commandAsUserInvocation)(
    options.targetUser,
    managedNodeExecutablePath(options.installDir),
    [
      path.join(options.sourceRoot, "dist", "app", "rin-install", "main.js"),
      "--update",
      "--target-user",
      options.targetUser,
      "--install-dir",
      options.installDir,
      "--yes",
      "--preconfirmed",
      "--release-channel",
      options.release.channel,
      ...releaseArgs,
    ],
    { HOME: options.ownerHome },
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
      path.join(options.sourceRoot, "dist", "app", "rin-install", "main.js"),
      "--update",
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
  i18n?: InstallerI18n;
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
  const initialI18n = deps.i18n || createInstallerI18n();
  const runFinalizeInstallPlanInChild =
    deps.runFinalizeInstallPlanInChild || runFinalizeInstallPlanInChildImpl;

  intro(initialI18n.updaterIntroTitle);

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
          initialI18n,
        );
  if (!target) {
    note(initialI18n.noUpdateTargetsText, initialI18n.updateTargetsTitle);
    outro(initialI18n.updaterNothingUpdated);
    return;
  }

  const installDir = target.installDir;
  const targetUser = target.targetUser;
  const i18n = initialI18n;

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
      i18n.buildUpdateReinstallCurrentText({
        installDir,
        sourceLabel: resolvedRelease.sourceLabel,
      }),
      i18n.updateReinstallCurrentTitle,
    );
  }

  if (!deps.preconfirmed) {
    note(
      i18n.buildUpdateTargetText({
        currentUser,
        targetUser,
        installDir,
        source: target.source,
        ownerHome: target.ownerHome,
      }),
      i18n.updateTargetsTitle,
    );

    note(
      i18n.buildUpdatePlanText({
        currentUser,
        targetUser,
        installDir,
        source: target.source,
        ownerHome: target.ownerHome,
        sourceLabel: resolvedRelease.sourceLabel,
      }),
      i18n.updatePlanTitle,
    );

    if (!deps.assumeYes && (!process.stdin.isTTY || !process.stdout.isTTY)) {
      throw new Error(
        "rin_update_confirmation_required: pass --yes in non-interactive mode",
      );
    }
    const shouldProceed = deps.assumeYes
      ? true
      : deps.ensureNotCancelled(
          await promptConfirm({
            message: deps.release
              ? i18n.publishUpdateConfirmMessage
              : i18n.fetchAndApplyUpdateConfirmMessage,
            initialValue: true,
          }),
        );
    if (!shouldProceed) {
      outro(i18n.updaterFinishedWithoutWritingChanges);
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
        i18n,
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
    i18n.refreshingInstalledTargetMessage,
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
        i18n.refreshingInstalledTargetMessage,
        { writeStatus() {} },
      ),
    {
      successMessage: i18n.installStepComplete,
      failureMessage: i18n.installStepFailed,
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
    i18n.buildUpdatedTargetText({
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
    i18n.writtenPathsTitle,
  );

  note(
    i18n.buildAfterUpdateText({ serviceHint, daemonReady, userSuffix }),
    i18n.afterInitTitle,
  );

  outro(
    i18n.updaterOutroUpdated(targetUser, installDir, daemonReady, userSuffix),
  );
}
