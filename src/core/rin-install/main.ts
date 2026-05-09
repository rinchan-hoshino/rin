#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";

import {
  cancel,
  confirm,
  intro,
  isCancel,
  outro,
  select,
  text,
} from "@clack/prompts";
import chalk from "chalk";

import {
  runFinalizeInstallPlanInChild,
  type FinalizeInstallOptions,
} from "./apply-plan.js";
import { readJsonFile } from "./fs-utils.js";
import {
  buildFinalRequirements,
  buildInstallPlanText,
  buildInstallSafetyBoundaryText,
  buildPostInstallInitExitText,
  renderInstallerNote,
  wrapInstallerNoteText,
  describeInstallDirState,
  promptChatSetup,
  promptDefaultTargetUser,
  promptProviderSetup,
  promptInstallTarget,
} from "./interactive.js";
import { createInstallerI18n, promptInstallerLanguage } from "./i18n.js";
import { detectCurrentUser, repoRootFromHere, runCommand } from "./common.js";
import { finalizeInstallPlan } from "./finalize.js";
import { detectLocalLanguageTag, normalizeLanguageTag } from "../language.js";
import { releaseInfoFromEnv } from "../rin-lib/release.js";
import { runGuiInstaller, shouldStartGuiInstaller } from "./gui.js";
import {
  describeOwnership,
  listSystemUsers,
  targetHomeForUser,
} from "./users.js";
import {
  defaultInstallDirForHome,
  installSettingsPath,
  installerManifestPaths,
  launcherMetadataCandidatesForHome,
} from "./paths.js";
import { startUpdater } from "./updater.js";
import { runInstallerProgress } from "./progress.js";
import {
  installCloudTarget,
  installContainerTarget,
  installExistingSshTarget,
  installNasTarget,
  installVmTarget,
  registerLocalUserTarget,
} from "./deployment-targets.js";

function ensureNotCancelled<T>(value: T | symbol): T {
  if (isCancel(value)) {
    const i18n = createInstallerI18n(process.env.RIN_INSTALL_LANGUAGE || "en");
    cancel(i18n.installerCancelled);
    process.exit(1);
  }
  return value as T;
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

function readInstalledUpdateLanguage(options: {
  currentUser: string;
  targetUser: string;
  installDir: string;
  ownerHome?: string;
}) {
  const ownerHome = options.ownerHome || targetHomeForUser(options.targetUser);
  const currentHome = targetHomeForUser(options.currentUser);
  const candidates = [
    installSettingsPath(options.installDir),
    ...installerManifestPaths(options.installDir, ownerHome).recoveryPaths,
    ...launcherMetadataCandidatesForHome(currentHome),
  ];
  for (const candidate of candidates) {
    const language = normalizeLanguageTag(
      readJsonFile<any>(candidate, {})?.language,
      "",
    );
    if (language) return language;
  }
  return (
    normalizeLanguageTag(process.env.RIN_INSTALL_LANGUAGE, "") ||
    detectLocalLanguageTag("en")
  );
}

async function launchInstallerInitTui(options: {
  rinPath: string;
  sourceRoot: string;
}) {
  return await runCommand(options.rinPath, ["--init"], {
    cwd: options.sourceRoot,
  });
}

export async function startInstaller() {
  const applyPlanRaw = String(process.env.RIN_INSTALL_APPLY_PLAN || "").trim();
  const applyPlanFile = String(
    process.env.RIN_INSTALL_APPLY_PLAN_FILE || "",
  ).trim();
  if (applyPlanRaw || applyPlanFile) {
    const resultPath = String(
      process.env.RIN_INSTALL_APPLY_RESULT || "",
    ).trim();
    const errorPath = String(process.env.RIN_INSTALL_APPLY_ERROR || "").trim();
    try {
      const rawPlan = applyPlanRaw || fs.readFileSync(applyPlanFile, "utf8");
      const result = await finalizeInstallPlan(
        JSON.parse(rawPlan) as FinalizeInstallOptions,
      );
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

  if (
    String(process.env.RIN_INSTALL_MODE || "")
      .trim()
      .toLowerCase() === "update"
  ) {
    const updateCurrentUser = detectCurrentUser();
    const updateTargetUser = String(
      process.env.RIN_UPDATE_TARGET_USER || updateCurrentUser,
    ).trim();
    const updateTargetHome = targetHomeForUser(updateTargetUser);
    const selectedLanguage = readInstalledUpdateLanguage({
      currentUser: updateCurrentUser,
      targetUser: updateTargetUser,
      installDir:
        String(process.env.RIN_UPDATE_INSTALL_DIR || "").trim() ||
        defaultInstallDirForHome(updateTargetHome),
    });
    process.env.RIN_INSTALL_LANGUAGE = selectedLanguage;
    const i18n = createInstallerI18n(selectedLanguage);
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
      release: releaseInfoFromEnv(),
      select,
      confirm: localizedConfirm,
      i18n,
      readInstalledUpdateLanguage,
    });
    return;
  }

  if (shouldStartGuiInstaller(process.argv.slice(2))) {
    await runGuiInstaller(process.argv.slice(2));
    return;
  }

  const selectedLanguage = await promptInstallerLanguage({
    ensureNotCancelled,
    select,
    text,
  });
  process.env.RIN_INSTALL_LANGUAGE = selectedLanguage;
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
  const setDefaultTarget =
    targetUser === currentUser
      ? false
      : await promptDefaultTargetUser(promptApi, targetUser, i18n);

  const { provider, modelId, thinkingLevel, authResult } =
    await promptProviderSetup(promptApi, installDir, readJsonFile, {}, i18n);
  const { chatDescription, chatDetail, chatConfig } = await promptChatSetup(
    promptApi,
    i18n,
  );

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
          chatDescription,
          chatDetail,
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

  const installServiceNow =
    process.platform === "darwin" || process.platform === "linux";
  const needsElevatedWrite = !ownership.writable;
  const needsElevatedService = installServiceNow && targetUser !== currentUser;
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
          chatDescription,
          chatDetail,
          chatConfig,
          authData: authResult.authData || {},
          release: releaseInfoFromEnv(),
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
    await launchInstallerInitTui({
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
  outro(i18n.outroInstalled(targetUser, installedService?.kind));
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
