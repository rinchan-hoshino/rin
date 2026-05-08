import { confirm, intro, outro, select } from "@clack/prompts";
import chalk from "chalk";

import { type InstalledReleaseInfo } from "../rin-lib/release.js";

import { createInstallerI18n, type InstallerI18n } from "./i18n.js";
import { discoverInstalledTargets } from "./update-targets.js";
import {
  runFinalizeInstallPlanInChild,
  type FinalizeInstallOptions,
} from "./apply-plan.js";
import { renderInstallerNote, wrapInstallerNoteText } from "./interactive.js";
import { runInstallerProgress } from "./progress.js";
import { targetHomeForUser } from "./users.js";

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

function shouldAssumeYes() {
  return ["1", "true", "yes", "y"].includes(
    String(process.env.RIN_UPDATE_ASSUME_YES || "")
      .trim()
      .toLowerCase(),
  );
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

export async function startUpdater(deps: {
  detectCurrentUser: () => string;
  repoRootFromHere: () => string;
  ensureNotCancelled: <T>(value: T | symbol) => T;
  release?: InstalledReleaseInfo;
  select?: typeof select;
  confirm?: typeof confirm;
  i18n?: InstallerI18n;
}) {
  const currentUser = deps.detectCurrentUser();
  const promptSelect = deps.select || select;
  const promptConfirm = deps.confirm || confirm;
  const i18n =
    deps.i18n || createInstallerI18n(process.env.RIN_INSTALL_LANGUAGE || "en");

  intro(i18n.updaterIntroTitle);

  const requestedInstallDir = String(
    process.env.RIN_UPDATE_INSTALL_DIR || "",
  ).trim();
  const requestedTargetUser = String(
    process.env.RIN_UPDATE_TARGET_USER || "",
  ).trim();
  const target =
    requestedInstallDir && requestedTargetUser
      ? {
          targetUser: requestedTargetUser,
          installDir: requestedInstallDir,
          ownerHome: targetHomeForUser(requestedTargetUser),
          source: "launcher" as const,
        }
      : await selectUpdateTarget(deps.ensureNotCancelled, promptSelect, i18n);
  if (!target) {
    note(i18n.noUpdateTargetsText, i18n.updateTargetsTitle);
    outro(i18n.updaterNothingUpdated);
    return;
  }

  const installDir = target.installDir;
  const targetUser = target.targetUser;

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
      sourceLabel: deps.release?.sourceLabel || "stable latest",
    }),
    i18n.updatePlanTitle,
  );

  const shouldProceed = shouldAssumeYes()
    ? true
    : deps.ensureNotCancelled(
        await promptConfirm({
          message: i18n.publishUpdateConfirmMessage,
          initialValue: true,
        }),
      );
  if (!shouldProceed) {
    outro(i18n.updaterFinishedWithoutWritingChanges);
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
          language: i18n.language,
          daemonReadyTimeoutMs: 30_000,
          ...(deps.release ? { release: deps.release } : {}),
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
