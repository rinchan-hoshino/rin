import { confirm, intro, outro, select } from "@clack/prompts";
import chalk from "chalk";

import { type InstalledReleaseInfo } from "../rin-lib/release.js";

import { discoverInstalledTargets } from "./update-targets.js";
import {
  runFinalizeInstallPlanInChild,
  type FinalizeInstallOptions,
} from "./apply-plan.js";
import { renderInstallerNote, wrapInstallerNoteText } from "./interactive.js";

export function renderUpdaterNote(message?: string, title?: string) {
  return renderInstallerNote(
    wrapInstallerNoteText(String(message || ""), process.stderr.columns),
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
}) {
  const currentUser = deps.detectCurrentUser();
  intro("Rin Updater");

  const targets = discoverInstalledTargets();
  if (!targets.length) {
    note(
      "No installed Rin daemon targets were discovered on this system.",
      "Update targets",
    );
    outro("Nothing updated.");
    return;
  }

  const target =
    targets.length === 1
      ? targets[0]!
      : targets[
          Number(
            deps.ensureNotCancelled(
              await select({
                message: "Choose an installed Rin target to update.",
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
    [
      `Current user: ${currentUser}`,
      `Selected daemon user: ${targetUser}`,
      `Install dir: ${installDir}`,
      `Discovered from: ${target.source}`,
      `Owner home: ${target.ownerHome}`,
      deps.release?.sourceLabel
        ? `Requested source: ${deps.release.sourceLabel}`
        : "Requested source: stable latest",
      "",
      "Updater policy:",
      "- publish a new runtime release into the existing install dir",
      "- prune old runtime releases and keep only the 3 most recent ones",
      "- refresh launchers and installer metadata for the current user",
      "- refresh managed daemon service files and restart the daemon when applicable",
      "- preserve existing provider/auth/settings unless changed elsewhere",
    ].join("\n"),
    "Update plan",
  );

  const shouldProceed = deps.ensureNotCancelled(
    await confirm({
      message: "Publish the latest built runtime to this installed target now?",
      initialValue: true,
    }),
  );
  if (!shouldProceed) {
    outro("Updater finished without writing changes.");
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
    "Publishing runtime and refreshing the installed target...",
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
    [
      `Written: ${written.launcherPath}`,
      `Written: ${written.rinPath}`,
      `Written: ${written.rinInstallPath}`,
      `Written: ${publishedRuntime.currentLink}`,
      `Written: ${publishedRuntime.releaseRoot}`,
      installedDocsDir ? `Written: ${installedDocsDir}` : "",
      ...(Array.isArray(installedDocs?.pi)
        ? installedDocs.pi.map((item: string) => `Written: ${item}`)
        : []),
      result.prunedReleases.removed.length
        ? `Removed old releases: ${result.prunedReleases.removed.length}`
        : "Removed old releases: 0",
      installedService ? `Written: ${installedService.servicePath}` : "",
      installedService
        ? `${installedService.kind} label: ${installedService.label}`
        : "",
      "",
      `Service/platform note: ${serviceHint}`,
      `Daemon started now: ${daemonReady ? "yes" : "no"}`,
      "",
      "Recommended next commands:",
      `- doctor: rin doctor${userSuffix}`,
      `- open Rin: rin${userSuffix}`,
      "- if RPC mode fails, run `rin doctor` or reopen Rin to enter temporary maintenance mode",
    ]
      .filter(Boolean)
      .join("\n"),
    "Updated target",
  );

  outro(
    `Updater refreshed ${targetUser} at ${installDir}. ${daemonReady ? `Open with rin${userSuffix}.` : `Use rin start${userSuffix} if you need to start the daemon manually.`}`,
  );
}
