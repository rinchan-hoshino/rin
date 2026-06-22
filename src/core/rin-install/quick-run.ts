import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { cancel, confirm, isCancel, select, text } from "@clack/prompts";

import { detectLocalLanguageTag, normalizeLanguageTag } from "../language.js";
import { readJsonFile } from "../platform/fs.js";
import { PI_CODING_AGENT_DIR_ENV, RIN_DIR_ENV } from "../rin-lib/profile.js";
import { safeString } from "../text-utils.js";
import { detectCurrentUser, repoRootFromHere } from "./common.js";
import { finalizeQuickRunInstall } from "./finalize.js";
import { createInstallerI18n } from "./i18n.js";
import { promptProviderSetup, wrapInstallerNoteText } from "./interactive.js";
import {
  defaultInstallDirForHome,
  installAuthPath,
  installSettingsPath,
} from "./paths.js";
import {
  computeAvailableThinkingLevels,
  loadModelChoices,
  type InstallerModelChoice,
} from "./provider-auth.js";
import { runInstallerProgress } from "./progress.js";

function normalizeRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

export function quickRunInstallDirForCurrentUser(home = os.homedir()) {
  return defaultInstallDirForHome(home);
}

export function createQuickRunRuntimeEnv(
  installDir: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  return {
    ...env,
    [RIN_DIR_ENV]: installDir,
    [PI_CODING_AGENT_DIR_ENV]: installDir,
  };
}

function resolveQuickRunLanguage(installDir: string) {
  return (
    normalizeLanguageTag(
      readJsonFile<any>(installSettingsPath(installDir), {})?.language,
      "",
    ) || detectLocalLanguageTag()
  );
}

function hasStoredProviderAuth(
  authData: Record<string, any>,
  provider: string,
) {
  return Object.prototype.hasOwnProperty.call(authData, provider);
}

function quickRunChoiceFromModel(
  model: InstallerModelChoice,
  authData: Record<string, any>,
  thinkingLevel = "",
) {
  const levels = computeAvailableThinkingLevels(model);
  return {
    provider: model.provider,
    modelId: model.id,
    thinkingLevel: levels.includes(thinkingLevel as any)
      ? thinkingLevel
      : levels[0] || "off",
    authResult: {
      available: true,
      authKind: "existing",
      authData,
    },
  };
}

export function pickQuickRunExistingProvider(options: {
  models: InstallerModelChoice[];
  settings: Record<string, any>;
  authData: Record<string, any>;
}) {
  const models = Array.isArray(options.models) ? options.models : [];
  const settings = normalizeRecord(options.settings);
  const authData = normalizeRecord(options.authData);
  const provider = safeString(settings.defaultProvider).trim();
  const modelId = safeString(settings.defaultModel).trim();
  const thinkingLevel = safeString(settings.defaultThinkingLevel).trim();

  const configuredModel = models.find(
    (model) =>
      model.provider === provider &&
      model.id === modelId &&
      (model.available || hasStoredProviderAuth(authData, provider)),
  );
  if (configuredModel) {
    return quickRunChoiceFromModel(configuredModel, authData, thinkingLevel);
  }

  const providerDefault = provider
    ? models.find((model) => model.provider === provider && model.available)
    : undefined;
  if (providerDefault)
    return quickRunChoiceFromModel(providerDefault, authData);

  const availableDefault = models.find((model) => model.available);
  if (availableDefault)
    return quickRunChoiceFromModel(availableDefault, authData);

  return null;
}

async function resolveExistingQuickRunProviderSetup(
  installDir: string,
  i18n: ReturnType<typeof createInstallerI18n>,
) {
  const models = await runInstallerProgress(
    i18n.loadingModelChoicesMessage,
    () => loadModelChoices(installDir, readJsonFile),
    {
      successMessage: i18n.installStepComplete,
      failureMessage: i18n.installStepFailed,
    },
  );
  return pickQuickRunExistingProvider({
    models,
    settings: readJsonFile<any>(installSettingsPath(installDir), {}),
    authData: readJsonFile<any>(installAuthPath(installDir), {}),
  });
}

function ensureNotCancelled<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel("Rin quick run cancelled.");
    process.exit(1);
  }
  return value as T;
}

async function waitForChildExit(child: ChildProcess) {
  return await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function terminateChild(child: ChildProcess | undefined) {
  if (!child || child.killed || child.exitCode != null || child.signalCode) {
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {}
}

async function stopChild(child: ChildProcess | undefined) {
  if (!child || child.exitCode != null || child.signalCode) return;
  terminateChild(child);
  const timeout = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {}
  }, 2500);
  try {
    await waitForChildExit(child).catch(() => undefined);
  } finally {
    clearTimeout(timeout);
  }
}

function exitCodeFromSignal(signal: NodeJS.Signals | null) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  if (signal === "SIGHUP") return 129;
  return 1;
}

async function launchQuickRunTui(plan: {
  installDir: string;
  sourceRoot: string;
}) {
  const tuiEntry = path.join(
    plan.sourceRoot,
    "dist",
    "app",
    "rin-tui",
    "main.js",
  );
  const tui = spawn(process.execPath, [tuiEntry], {
    cwd: plan.sourceRoot,
    env: createQuickRunRuntimeEnv(plan.installDir),
    stdio: "inherit",
  });
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) {
    const handler = () => {
      process.exitCode = exitCodeFromSignal(signal);
      terminateChild(tui);
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
  try {
    const result = await waitForChildExit(tui);
    if (result.signal) process.exitCode = exitCodeFromSignal(result.signal);
    else process.exitCode = result.code ?? 0;
  } finally {
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    await stopChild(tui);
  }
}

async function prepareQuickRunInstallPlan() {
  const currentUser = detectCurrentUser();
  const installDir = quickRunInstallDirForCurrentUser();
  fs.mkdirSync(installDir, { recursive: true });
  const language = resolveQuickRunLanguage(installDir);
  const i18n = createInstallerI18n(language);
  const promptApi = {
    ensureNotCancelled,
    select,
    text,
    confirm: (options: any) =>
      confirm({
        active: i18n.confirmActiveLabel,
        inactive: i18n.confirmInactiveLabel,
        ...options,
      }),
  };

  const setup =
    (await resolveExistingQuickRunProviderSetup(installDir, i18n)) ||
    (await promptProviderSetup(promptApi, installDir, readJsonFile, {}, i18n));
  const { provider, modelId, thinkingLevel, authResult } = setup;
  return {
    currentUser,
    targetUser: currentUser,
    installDir,
    provider,
    modelId,
    thinkingLevel,
    language,
    authData: authResult.authData || {},
    sourceRoot: repoRootFromHere(),
  };
}

export async function runQuickRun() {
  const plan = await prepareQuickRunInstallPlan();
  const i18n = createInstallerI18n(resolveQuickRunLanguage(plan.installDir));

  process.stdout.write(
    `${wrapInstallerNoteText(
      [
        "Rin quick run will prepare the current user's ~/.rin documents and configuration.",
        `Install dir: ${plan.installDir}`,
        `Model: ${plan.provider}/${plan.modelId}`,
        `Thinking: ${plan.thinkingLevel}`,
        "No app release, launcher, daemon service, or daemon process will be left behind.",
      ].join("\n"),
      process.stdout.columns,
    )}\n`,
  );

  const result = await runInstallerProgress(
    i18n.preparingInstallerMessage,
    () => finalizeQuickRunInstall(plan),
    {
      successMessage: i18n.installStepComplete,
      failureMessage: i18n.installStepFailed,
    },
  );

  process.stdout.write(
    `${wrapInstallerNoteText(
      [
        "Rin quick run is ready.",
        `Docs: ${result.installedDocsDir}`,
        `Settings: ${result.written?.settingsPath || installSettingsPath(plan.installDir)}`,
        "The installed app runtime and daemon were not started or recorded.",
        "Launching Rin TUI...",
      ].join("\n"),
      process.stdout.columns,
    )}\n`,
  );

  await launchQuickRunTui(plan);
}
