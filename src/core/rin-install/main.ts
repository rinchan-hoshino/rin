import fs from "node:fs";
import { parseArgs } from "node:util";

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
  cleanupConsumedFinalizeInstallPlan,
  runFinalizeInstallPlanInChild,
  type FinalizeInstallOptions,
} from "./apply-plan.js";
import { readJsonFileOrDefault } from "./fs-utils.js";
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
import { createInstallerCopy } from "../product-copy.js";
import { startLegacyPreparedUpdatePayload } from "./update-payload.js";
import { detectCurrentUser, repoRootFromHere, runCommand } from "./common.js";
import { finalizeCoreUpdate, finalizeInstallPlan } from "./finalize.js";
import { releaseInfoFromFile } from "../rin-lib/release.js";
import { requestProcessTermination } from "../platform/process-lifetime.js";
import {
  describeOwnership,
  isSameSystemUser,
  listSystemUsers,
  shouldUseElevatedWrite,
  targetHomeForUser,
} from "./users.js";
import { defaultInstallDirForHome } from "./paths.js";
import { runInstallerProgress } from "./progress.js";
import { runQuickRun } from "./quick-run.js";
import {
  installContainerTarget,
  installExistingSshTarget,
  registerLocalUserTarget,
} from "./deployment-targets.js";

function ensureNotCancelled<T>(value: T | symbol): T {
  if (isCancel(value)) {
    const copy = createInstallerCopy();
    cancel(copy.installerCancelled);
    requestProcessTermination(1);
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

function parseInstallerCliArgs(argv: string[]) {
  parseArgs({
    args: argv,
    allowPositionals: false,
    strict: true,
    options: {
      "apply-plan-file": { type: "string" },
      "apply-result-file": { type: "string" },
      "apply-error-file": { type: "string" },
      "quick-run": { type: "boolean" },
      "release-file": { type: "string" },
      language: { type: "string" },
    },
  });
  const hasFlag = (name: string) =>
    argv.some((arg) => String(arg || "").trim() === name);
  return {
    applyPlanFile: readValueArg(argv, "--apply-plan-file"),
    applyResultFile: readValueArg(argv, "--apply-result-file"),
    applyErrorFile: readValueArg(argv, "--apply-error-file"),
    quickRun: hasFlag("--quick-run"),
    releaseFile: readValueArg(argv, "--release-file"),
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

async function launchInstallerTui(options: {
  rinPath: string;
  sourceRoot: string;
}) {
  return await runCommand(options.rinPath, [], {
    cwd: options.sourceRoot,
  });
}

export async function startInstaller(argv = process.argv.slice(2)) {
  if (argv.includes("--update") && argv.includes("--preconfirmed")) {
    await startLegacyPreparedUpdatePayload(argv);
    return;
  }
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
      if (errorPath) {
        try {
          fs.writeFileSync(
            errorPath,
            String(error?.message || error || "rin_installer_apply_failed"),
            "utf8",
          );
          error.rinApplyPlanErrorHandoffWritten = true;
        } catch {}
      }
      throw error;
    } finally {
      cleanupConsumedFinalizeInstallPlan(cli.applyPlanFile);
    }
  }

  if (cli.quickRun) return await runQuickRun();

  const copy = createInstallerCopy();

  const { currentUser, allUsers } = await runInstallerProgress(
    copy.preparingInstallerMessage,
    () => ({
      currentUser: detectCurrentUser(),
      allUsers: listSystemUsers(),
    }),
    { successMessage: copy.installStepComplete },
  );
  intro(copy.introTitle);
  const confirmWithCopy: typeof confirm = (options) =>
    confirm({
      active: copy.confirmActiveLabel,
      inactive: copy.confirmInactiveLabel,
      ...options,
    });

  note(
    wrapInstallerNoteText(
      buildInstallSafetyBoundaryText(copy),
      process.stderr.columns,
    ),
    copy.safetyBoundaryTitle,
  );

  const promptApi = {
    ensureNotCancelled,
    select,
    text,
    multiselect,
    confirm: confirmWithCopy,
  };
  const target = await promptInstallTarget(
    promptApi,
    currentUser,
    allUsers,
    targetHomeForUser,
    copy,
  );
  if (target.cancelled) {
    note(
      copy.noEligibleUsersText(
        currentUser,
        allUsers.map((entry) => entry.name),
      ),
      copy.targetUserTitle,
    );
    outro(copy.nothingInstalled);
    return;
  }

  if (target.kind === "ssh") {
    const registered = await runInstallerProgress(
      copy.applyingTargetSelectionMessage,
      () => installExistingSshTarget(target),
      {
        successMessage: copy.installStepComplete,
        failureMessage: copy.installStepFailed,
      },
    );
    outro(
      `Installed and registered Rin target ${registered.name}. Open with rin --target ${registered.name}.`,
    );
    return;
  }
  if (target.kind === "container") {
    const registered = await runInstallerProgress(
      copy.applyingTargetSelectionMessage,
      () => installContainerTarget(target),
      {
        successMessage: copy.installStepComplete,
        failureMessage: copy.installStepFailed,
      },
    );
    outro(
      `Installed and registered Rin target ${registered.name}. Open with rin --target ${registered.name}.`,
    );
    return;
  }
  const { targetUser, installDir, createSystemUser } = target;
  const installDirNote = await runInstallerProgress(
    copy.inspectingInstallDirectoryMessage,
    () =>
      describeInstallDirState(installDir, summarizeDirState(installDir), copy),
    { successMessage: copy.installStepComplete },
  );
  note(installDirNote.text, installDirNote.title);
  const setDefaultTarget = isSameSystemUser(targetUser, currentUser)
    ? false
    : await promptDefaultTargetUser(promptApi, targetUser, copy);

  const { provider, modelId, thinkingLevel, authResult } =
    await promptProviderSetup(
      promptApi,
      installDir,
      readJsonFileOrDefault,
      {},
      copy,
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
          setDefaultTarget,
          createSystemUser,
        },
        copy,
      ),
      process.stderr.columns,
    ),
    copy.installChoicesTitle,
  );

  const ownership = describeOwnership(targetUser, installDir);
  if (!ownership.ownerMatches && ownership.targetUid >= 0) {
    note(copy.ownershipMismatchText(ownership), copy.ownershipCheckTitle);
  }
  if (!ownership.writable) {
    note(copy.ownershipNotWritableText, copy.ownershipCheckTitle);
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
    copy,
  );
  const shouldProceed = ensureNotCancelled(
    await confirmWithCopy({
      message: wrapInstallerNoteText(
        copy.finalizeInstallationMessage(finalRequirements),
        process.stderr.columns,
      ),
      initialValue: true,
    }),
  );
  if (!shouldProceed) {
    outro(copy.installerFinishedWithoutWritingChanges);
    return;
  }

  const installSpinnerMessage = needsElevatedWrite
    ? copy.publishingRuntimeMessageElevated
    : copy.publishingRuntimeMessage;
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
          setDefaultTarget,
          createTargetUser: createSystemUser,
          authData: authResult.authData || {},
          release: releaseInfoFromFile(cli.releaseFile),
        },
        installSpinnerMessage,
        { writeStatus() {} },
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
    initializationRequired,
    serviceHint,
  } = result;

  note(
    [
      `${copy.targetInstallDirLabel}: ${installDir}`,
      `${copy.writtenPathLabel}: ${written.settingsPath}`,
      `${copy.writtenPathLabel}: ${written.authPath}`,
      `${copy.writtenPathLabel}: ${written.manifestPath}`,
      written.locatorManifestPath &&
      written.locatorManifestPath !== written.manifestPath
        ? `${copy.writtenPathLabel}: ${written.locatorManifestPath}`
        : "",
      `${copy.writtenPathLabel}: ${written.launcherPath}`,
      `${copy.writtenPathLabel}: ${written.rinPath}`,
      `${copy.writtenPathLabel}: ${written.rinInstallPath}`,
      written.targetRinPath && written.targetRinPath !== written.rinPath
        ? `${copy.writtenPathLabel}: ${written.targetRinPath}`
        : "",
      written.targetRinInstallPath &&
      written.targetRinInstallPath !== written.rinInstallPath
        ? `${copy.writtenPathLabel}: ${written.targetRinInstallPath}`
        : "",
      `${copy.writtenPathLabel}: ${publishedRuntime.currentLink}`,
      `${copy.writtenPathLabel}: ${publishedRuntime.releaseRoot}`,
      installedDocsDir ? `${copy.writtenPathLabel}: ${installedDocsDir}` : "",
      ...(Array.isArray(installedDocs?.pi)
        ? installedDocs.pi.map(
            (item: string) => `${copy.writtenPathLabel}: ${item}`,
          )
        : []),
      installedService
        ? `${copy.writtenPathLabel}: ${installedService.servicePath}`
        : "",
      installedService
        ? `${installedService.kind} ${copy.serviceLabelLabel}: ${installedService.label}`
        : "",
    ].join("\n"),
    copy.writtenPathsTitle,
  );

  if (daemonReady && initializationRequired) {
    note(copy.launchingInitText, copy.launchingInitTitle);
    await launchInstallerTui({
      rinPath: written.rinPath,
      sourceRoot: repoRootFromHere(),
    });
    note(
      buildPostInstallInitExitText(
        { currentUser, targetUser, rinPath: written.rinPath },
        copy,
      ),
      copy.afterInitTitle,
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
      copy,
    ),
  );
}
