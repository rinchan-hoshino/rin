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

  const targets = discoverInstalledTargets();
  if (!targets.length) {
    note(i18n.noUpdateTargetsText, i18n.updateTargetsTitle);
    outro(i18n.updaterNothingUpdated);
    return;
  }

  const target =
    targets.length === 1
      ? targets[0]!
      : targets[
          Number(
            deps.ensureNotCancelled(
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

  const installDir =
    String(process.env.RIN_UPDATE_INSTALL_DIR || target.installDir).trim() ||
    target.installDir;
  const targetUser =
    String(process.env.RIN_UPDATE_TARGET_USER || target.targetUser).trim() ||
    target.targetUser;

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

  const shouldProceed = deps.ensureNotCancelled(
    await promptConfirm({
      message: i18n.publishUpdateConfirmMessage,
      initialValue: true,
    }),
  );
  if (!shouldProceed) {
    outro(i18n.updaterFinishedWithoutWritingChanges);
    return;
  }

  const result = await runFinalizeInstallPlanInChild(
    {
      currentUser,
      targetUser,
      installDir,
      sourceRoot: deps.repoRootFromHere(),
      ...(deps.release ? { release: deps.release } : {}),
    } satisfies FinalizeInstallOptions,
    i18n.publishingUpdateMessage,
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
      serviceHint,
      daemonReady,
      userSuffix,
    }),
    i18n.updatedTargetTitle,
  );

  outro(
    i18n.updaterOutroUpdated(targetUser, installDir, daemonReady, userSuffix),
  );
}
