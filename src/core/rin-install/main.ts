#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";

import {
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  outro,
  select,
  text,
} from "@clack/prompts";
import chalk from "chalk";

import {
  runFinalizeInstallPlanInChild,
  type FinalizeInstallOptions,
} from "./apply-plan.js";
import { readInstallerJson, readJsonFile } from "./fs-utils.js";
import {
  buildFinalRequirements,
  buildInstallPlanText,
  buildInstallSafetyBoundaryText,
  buildInstallOutroText,
  buildPostInstallInitExitText,
  renderInstallerNote,
  wrapInstallerNoteText,
  describeInstallDirState,
  promptDefaultTargetUser,
  promptProviderSetup,
  promptInstallTarget,
} from "./interactive.js";
import { createInstallerI18n, promptInstallerLanguage } from "./i18n.js";
import { detectCurrentUser, repoRootFromHere, runCommand } from "./common.js";
import { finalizeCoreUpdate, finalizeInstallPlan } from "./finalize.js";
import {
  DEFAULT_LANGUAGE_TAG,
  detectLocalLanguageTag,
  normalizeLanguageTag,
} from "../language.js";
import {
  releaseInfoFromFile,
  type ReleaseChannel,
} from "../rin-lib/release.js";
import {
  describeOwnership,
  isSameSystemUser,
  listSystemUsers,
  shouldUseElevatedWrite,
  targetHomeForUser,
} from "./users.js";
import { defaultInstallDirForHome, installSettingsPath } from "./paths.js";
import { startUpdater } from "./updater.js";
import { runInstallerProgress } from "./progress.js";
import { runQuickRun } from "./quick-run.js";
import {
  installCloudTarget,
  installContainerTarget,
  installExistingSshTarget,
  installNasTarget,
  installVmTarget,
  registerLocalUserTarget,
} from "./deployment-targets.js";

let currentInstallerLanguage = DEFAULT_LANGUAGE_TAG;

function ensureNotCancelled<T>(value: T | symbol): T {
  if (isCancel(value)) {
    const i18n = createInstallerI18n(currentInstallerLanguage);
    cancel(i18n.installerCancelled);
    process.exit(1);
  }
  return value as T;
}

function readValueArg(argv: string[], name: string) {
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || "").trim();
    if (value === name) return String(argv[index + 1] || "").trim();
    if (value.startsWith(`${name}=`))
      return value.slice(name.length + 1).trim();
  }
  return "";
}

function readOptionalFlagValue(argv: string[], name: string) {
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || "").trim();
    if (value === name) {
      const next = String(argv[index + 1] || "").trim();
      return !next || next.startsWith("-") ? "" : next;
    }
    if (value.startsWith(`${name}=`))
      return value.slice(name.length + 1).trim();
  }
  return "";
}

function parseInstallerUpdateReleaseArgs(argv: string[]) {
  const hasFlag = (name: string) =>
    argv.some((arg) => String(arg || "").trim() === name);
  const selected = [
    hasFlag("--stable") ? "stable" : "",
    hasFlag("--beta") ? "beta" : "",
    hasFlag("--nightly") ? "nightly" : "",
    hasFlag("--git") ? "git" : "",
  ].filter(Boolean) as ReleaseChannel[];
  if (selected.length > 1) throw new Error("rin_release_channel_conflict");
  let branch = readValueArg(argv, "--branch");
  let version = readValueArg(argv, "--version");
  const gitSelector = readOptionalFlagValue(argv, "--git");
  if (!branch && !version && gitSelector) {
    if (
      /^[0-9a-f]{7,40}$/i.test(gitSelector) ||
      gitSelector.startsWith("refs/")
    )
      version = gitSelector;
    else branch = gitSelector;
  }
  return {
    channel: selected[0] || "stable",
    branch,
    version,
    explicitReleaseChannel: selected.length > 0,
  };
}

function parseInstallerCliArgs(argv: string[]) {
  const hasFlag = (name: string) =>
    argv.some((arg) => String(arg || "").trim() === name);
  const guiDisabled = hasFlag("--gui");
  const updateReleaseRequest = parseInstallerUpdateReleaseArgs(argv);
  return {
    applyPlanFile: readValueArg(argv, "--apply-plan-file"),
    applyResultFile: readValueArg(argv, "--apply-result-file"),
    applyErrorFile: readValueArg(argv, "--apply-error-file"),
    update: hasFlag("--update"),
    updateTargetUser: readValueArg(argv, "--target-user"),
    updateInstallDir: readValueArg(argv, "--install-dir"),
    updateAssumeYes: hasFlag("--yes"),
    updatePreconfirmed: hasFlag("--preconfirmed"),
    quickRun: hasFlag("--quick-run"),
    guiDisabled,
    language: normalizeLanguageTag(readValueArg(argv, "--language"), ""),
    releaseFile: readValueArg(argv, "--release-file"),
    updateReleaseRequest,
  };
}

function summarizeDirState(dir: string) {
  try {
    const entries = fs.readdirSync(dir);
    return {
      exists: true,
      entryCount: entries.length,
      sample: entries.slice(0, 8),
    };
  } catch {
    return { exists: false, entryCount: 0, sample: [] as string[] };
  }
}

function note(message?: string, title?: string) {
  process.stdout.write(
    `${renderInstallerNote(String(message || ""), String(title || ""), {
      border: chalk.gray,
      body: chalk.dim,
      symbol: chalk.green,
      title: chalk.reset,
    })}\n`,
  );
}

export function readInstalledUpdateLanguage(
  options: {
    currentUser: string;
    targetUser: string;
    installDir: string;
    ownerHome?: string;
  },
  deps: {
    readInstallerJson?: typeof readInstallerJson;
  } = {},
) {
  const readSettings = deps.readInstallerJson || readInstallerJson;
  const elevated = options.targetUser !== options.currentUser;
  return normalizeLanguageTag(
    readSettings<any>(installSettingsPath(options.installDir), {}, elevated)
      ?.language,
    "",
  );
}

async function launchInstallerTui(options: {
  rinPath: string;
  sourceRoot: string;
}) {
  return await runCommand(options.rinPath, [], {
    cwd: options.sourceRoot,
  });
}

export async function startInstaller(argv = process.argv.slice(2)) {
  const cli = parseInstallerCliArgs(argv);
  if (cli.applyPlanFile) {
    const resultPath = cli.applyResultFile;
    const errorPath = cli.applyErrorFile;
    try {
      const rawPlan = fs.readFileSync(cli.applyPlanFile, "utf8");
      const plan = JSON.parse(rawPlan) as FinalizeInstallOptions;
      const result = plan.coreUpdate
        ? await finalizeCoreUpdate(plan)
        : await finalizeInstallPlan(plan);
      if (resultPath)
        fs.writeFileSync(resultPath, `${JSON.stringify(result)}\n`, "utf8");
      return;
    } catch (error: any) {
      if (errorPath)
        fs.writeFileSync(
          errorPath,
          String(error?.message || error || "rin_installer_apply_failed"),
          "utf8",
        );
      throw error;
    }
  }

  if (cli.guiDisabled) {
    throw new Error("rin_installer_gui_disabled");
  }

  if (cli.quickRun) {
    if (cli.update) throw new Error("rin_quick_run_update_not_supported");
    await runQuickRun();
    return;
  }

  if (cli.update) {
    const updateCurrentUser = detectCurrentUser();
    const updateTargetUser = cli.updateTargetUser || updateCurrentUser;
    const updateTargetHome = targetHomeForUser(updateTargetUser);
    const selectedLanguage = readInstalledUpdateLanguage({
      currentUser: updateCurrentUser,
      targetUser: updateTargetUser,
      installDir:
        cli.updateInstallDir || defaultInstallDirForHome(updateTargetHome),
    });
    const displayLanguage =
      selectedLanguage || cli.language || detectLocalLanguageTag();
    currentInstallerLanguage = displayLanguage;
    const i18n = createInstallerI18n(displayLanguage);
    const localizedConfirm: typeof confirm = (options) =>
      confirm({
        active: i18n.confirmActiveLabel,
        inactive: i18n.confirmInactiveLabel,
        ...options,
      });
    await startUpdater({
      detectCurrentUser: () => updateCurrentUser,
      repoRootFromHere,
      ensureNotCancelled,
      release: releaseInfoFromFile(cli.releaseFile),
      releaseRequest: cli.updateReleaseRequest,
      select,
      confirm: localizedConfirm,
      i18n,
      readInstalledUpdateLanguage,
      requestedInstallDir: cli.updateInstallDir,
      requestedTargetUser: cli.updateTargetUser,
      assumeYes: cli.updateAssumeYes,
      preconfirmed: cli.updatePreconfirmed,
    });
    return;
  }

  const selectedLanguage = await promptInstallerLanguage({
    ensureNotCancelled,
    select,
    text,
  });
  currentInstallerLanguage = selectedLanguage;
  const i18n = createInstallerI18n(selectedLanguage);

  const { currentUser, allUsers } = await runInstallerProgress(
    i18n.preparingInstallerMessage,
    () => ({
      currentUser: detectCurrentUser(),
      allUsers: listSystemUsers(),
    }),
    { successMessage: i18n.installStepComplete },
  );
  intro(i18n.introTitle);
  const localizedConfirm: typeof confirm = (options) =>
    confirm({
      active: i18n.confirmActiveLabel,
      inactive: i18n.confirmInactiveLabel,
      ...options,
    });

  note(
    wrapInstallerNoteText(
      buildInstallSafetyBoundaryText(i18n),
      process.stderr.columns,
    ),
    i18n.safetyBoundaryTitle,
  );

  const promptApi = {
    ensureNotCancelled,
    select,
    text,
    multiselect,
    confirm: localizedConfirm,
  };
  const target = await promptInstallTarget(
    promptApi,
    currentUser,
    allUsers,
    targetHomeForUser,
    i18n,
  );
  if (target.cancelled) {
    note(
      i18n.noEligibleUsersText(
        currentUser,
        allUsers.map((entry) => entry.name),
      ),
      i18n.targetUserTitle,
    );
    outro(i18n.nothingInstalled);
    return;
  }

  if (target.kind === "ssh") {
    const registered = await runInstallerProgress(
      i18n.applyingTargetSelectionMessage,
      () => installExistingSshTarget(target),
      {
        successMessage: i18n.installStepComplete,
        failureMessage: i18n.installStepFailed,
      },
    );
    outro(
      `Installed and registered Rin target ${registered.name}. Open with rin --target ${registered.name}.`,
    );
    return;
  }
  if (target.kind === "container") {
    const registered = await runInstallerProgress(
      i18n.applyingTargetSelectionMessage,
      () => installContainerTarget(target),
      {
        successMessage: i18n.installStepComplete,
        failureMessage: i18n.installStepFailed,
      },
    );
    outro(
      `Installed and registered Rin target ${registered.name}. Open with rin --target ${registered.name}.`,
    );
    return;
  }
  if (target.kind === "cloud") {
    const registered = await runInstallerProgress(
      i18n.applyingTargetSelectionMessage,
      () => installCloudTarget(target),
      {
        successMessage: i18n.installStepComplete,
        failureMessage: i18n.installStepFailed,
      },
    );
    outro(
      `Provisioned, installed, and registered Rin target ${registered.name}. Open with rin --target ${registered.name}.`,
    );
    return;
  }
  if (target.kind === "nas") {
    const registered = await runInstallerProgress(
      i18n.applyingTargetSelectionMessage,
      () => installNasTarget(target),
      {
        successMessage: i18n.installStepComplete,
        failureMessage: i18n.installStepFailed,
      },
    );
    outro(
      `Installed and registered Rin target ${registered.name}. Open with rin --target ${registered.name}.`,
    );
    return;
  }
  if (target.kind === "vm") {
    const registered = await runInstallerProgress(
      i18n.applyingTargetSelectionMessage,
      () => installVmTarget(target),
      {
        successMessage: i18n.installStepComplete,
        failureMessage: i18n.installStepFailed,
      },
    );
    outro(
      `Provisioned, installed, and registered Rin target ${registered.name}. Open with rin --target ${registered.name}.`,
    );
    return;
  }

  const { targetUser, installDir } = target;
  const installDirNote = await runInstallerProgress(
    i18n.inspectingInstallDirectoryMessage,
    () =>
      describeInstallDirState(installDir, summarizeDirState(installDir), i18n),
    { successMessage: i18n.installStepComplete },
  );
  note(installDirNote.text, installDirNote.title);
  const setDefaultTarget = isSameSystemUser(targetUser, currentUser)
    ? false
    : await promptDefaultTargetUser(promptApi, targetUser, i18n);

  const { provider, modelId, thinkingLevel, authResult } =
    await promptProviderSetup(promptApi, installDir, readJsonFile, {}, i18n);
  note(
    wrapInstallerNoteText(
      buildInstallPlanText(
        {
          currentUser,
          targetUser,
          installDir,
          provider,
          modelId,
          thinkingLevel,
          authAvailable: Boolean(authResult.available),
          language: selectedLanguage,
          setDefaultTarget,
        },
        i18n,
      ),
      process.stderr.columns,
    ),
    i18n.installChoicesTitle,
  );

  const ownership = describeOwnership(targetUser, installDir);
  if (!ownership.ownerMatches && ownership.targetUid >= 0) {
    note(i18n.ownershipMismatchText(ownership), i18n.ownershipCheckTitle);
  }
  if (!ownership.writable) {
    note(i18n.ownershipNotWritableText, i18n.ownershipCheckTitle);
  }

  const installServiceNow = ["darwin", "linux", "win32"].includes(
    process.platform,
  );
  const needsElevatedWrite = shouldUseElevatedWrite(
    targetUser,
    ownership,
    currentUser,
  );
  const needsElevatedService =
    installServiceNow && !isSameSystemUser(targetUser, currentUser);
  const finalRequirements = buildFinalRequirements(
    {
      installServiceNow,
      needsElevatedWrite,
      needsElevatedService,
    },
    i18n,
  );
  const shouldProceed = ensureNotCancelled(
    await localizedConfirm({
      message: wrapInstallerNoteText(
        i18n.finalizeInstallationMessage(finalRequirements),
        process.stderr.columns,
      ),
      initialValue: true,
    }),
  );
  if (!shouldProceed) {
    outro(i18n.installerFinishedWithoutWritingChanges);
    return;
  }

  const installSpinnerMessage = needsElevatedWrite
    ? i18n.publishingRuntimeMessageElevated
    : i18n.publishingRuntimeMessage;
  const result = await runInstallerProgress(
    installSpinnerMessage,
    () =>
      runFinalizeInstallPlanInChild(
        {
          currentUser,
          targetUser,
          installDir,
          provider,
          modelId,
          thinkingLevel,
          language: selectedLanguage,
          setDefaultTarget,
          authData: authResult.authData || {},
          release: releaseInfoFromFile(cli.releaseFile),
        },
        installSpinnerMessage,
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

  note(
    [
      `${i18n.targetInstallDirLabel}: ${installDir}`,
      `${i18n.writtenPathLabel}: ${written.settingsPath}`,
      `${i18n.writtenPathLabel}: ${written.authPath}`,
      `${i18n.writtenPathLabel}: ${written.manifestPath}`,
      written.locatorManifestPath &&
      written.locatorManifestPath !== written.manifestPath
        ? `${i18n.writtenPathLabel}: ${written.locatorManifestPath}`
        : "",
      `${i18n.writtenPathLabel}: ${written.launcherPath}`,
      `${i18n.writtenPathLabel}: ${written.rinPath}`,
      `${i18n.writtenPathLabel}: ${written.rinInstallPath}`,
      written.targetRinPath && written.targetRinPath !== written.rinPath
        ? `${i18n.writtenPathLabel}: ${written.targetRinPath}`
        : "",
      written.targetRinInstallPath &&
      written.targetRinInstallPath !== written.rinInstallPath
        ? `${i18n.writtenPathLabel}: ${written.targetRinInstallPath}`
        : "",
      `${i18n.writtenPathLabel}: ${publishedRuntime.currentLink}`,
      `${i18n.writtenPathLabel}: ${publishedRuntime.releaseRoot}`,
      installedDocsDir ? `${i18n.writtenPathLabel}: ${installedDocsDir}` : "",
      ...(Array.isArray(installedDocs?.pi)
        ? installedDocs.pi.map(
            (item: string) => `${i18n.writtenPathLabel}: ${item}`,
          )
        : []),
      installedService
        ? `${i18n.writtenPathLabel}: ${installedService.servicePath}`
        : "",
      installedService
        ? `${installedService.kind} ${i18n.serviceLabelLabel}: ${installedService.label}`
        : "",
    ].join("\n"),
    i18n.writtenPathsTitle,
  );

  if (daemonReady) {
    note(i18n.launchingInitText, i18n.launchingInitTitle);
    await launchInstallerTui({
      rinPath: written.rinPath,
      sourceRoot: repoRootFromHere(),
    });
    note(
      buildPostInstallInitExitText(
        { currentUser, targetUser, rinPath: written.rinPath },
        i18n,
      ),
      i18n.afterInitTitle,
    );
  }

  registerLocalUserTarget(targetUser);
  outro(
    buildInstallOutroText(
      {
        currentUser,
        targetUser,
        rinPath: written.rinPath,
        installedServiceKind: installedService?.kind,
      },
      i18n,
    ),
  );
}

async function main() {
  await startInstaller();
}

const isDirectEntry =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectEntry) {
  main().catch((error) => {
    const message =
      error instanceof Error
        ? error.message
        : String(error || "rin_installer_failed");
    console.error(message);
    process.exit(1);
  });
}
