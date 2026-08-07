import { cancel, confirm, isCancel, select } from "@clack/prompts";

import { repoRootFromHere, detectExecutorUser } from "./common.js";
import { createInstallerI18n } from "./i18n.js";
import {
  releaseInfoFromFile,
  type ReleaseChannel,
} from "../rin-lib/release.js";
import { assertAuthorizedUpdateJob } from "./update-job-auth.js";
import { startUpdater } from "./updater.js";

function readValueArg(argv: string[], name: string) {
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || "").trim();
    if (value === name) return String(argv[index + 1] || "").trim();
    if (value.startsWith(`${name}=`)) {
      return value.slice(name.length + 1).trim();
    }
  }
  return "";
}

function readOptionalFlagValue(
  argv: string[],
  name: string,
): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || "").trim();
    if (value === name) {
      const next = String(argv[index + 1] || "").trim();
      return !next || next.startsWith("-") ? "" : next;
    }
    if (value.startsWith(`${name}=`)) {
      return value.slice(name.length + 1).trim();
    }
  }
  return undefined;
}

export function parseUpdatePayloadArgs(argv: string[]) {
  const hasFlag = (name: string) =>
    argv.some((arg) => String(arg || "").trim() === name);
  if (hasFlag("--update")) {
    throw new Error("rin_installer_update_entry_removed");
  }
  const gitSelector = readOptionalFlagValue(argv, "--git");
  const selected = [
    hasFlag("--stable") ? "stable" : "",
    hasFlag("--beta") ? "beta" : "",
    hasFlag("--nightly") ? "nightly" : "",
    hasFlag("--git") || gitSelector !== undefined ? "git" : "",
  ].filter(Boolean) as ReleaseChannel[];
  if (selected.length > 1) throw new Error("rin_release_channel_conflict");
  let branch = readValueArg(argv, "--branch");
  let version = readValueArg(argv, "--version");
  if (!branch && !version && gitSelector) {
    if (
      /^[0-9a-f]{7,40}$/i.test(gitSelector) ||
      gitSelector.startsWith("refs/")
    ) {
      version = gitSelector;
    } else {
      branch = gitSelector;
    }
  }
  return {
    requestedTargetUser: readValueArg(argv, "--target-user"),
    requestedInstallDir: readValueArg(argv, "--install-dir"),
    assumeYes: hasFlag("--yes"),
    preconfirmed: hasFlag("--preconfirmed"),
    releaseFile: readValueArg(argv, "--release-file"),
    releaseRequest: {
      channel: selected[0] || "stable",
      branch,
      version,
      explicitReleaseChannel: selected.length > 0,
    },
  };
}

type UpdatePayloadDependencies = {
  assertAuthorizedUpdateJob?: typeof assertAuthorizedUpdateJob;
  detectExecutorUser?: typeof detectExecutorUser;
  createInstallerI18n?: typeof createInstallerI18n;
  repoRootFromHere?: typeof repoRootFromHere;
  releaseInfoFromFile?: typeof releaseInfoFromFile;
  startUpdater?: typeof startUpdater;
  isCancel?: typeof isCancel;
  cancel?: typeof cancel;
  confirm?: typeof confirm;
  select?: typeof select;
  exit?: (code: number) => never;
};

export function resolveUpdatePayloadDependencies(
  deps: UpdatePayloadDependencies = {},
) {
  return {
    assertAuthorizedUpdateJob:
      deps.assertAuthorizedUpdateJob ?? assertAuthorizedUpdateJob,
    detectExecutorUser: deps.detectExecutorUser ?? detectExecutorUser,
    createInstallerI18n: deps.createInstallerI18n ?? createInstallerI18n,
    repoRootFromHere: deps.repoRootFromHere ?? repoRootFromHere,
    releaseInfoFromFile: deps.releaseInfoFromFile ?? releaseInfoFromFile,
    startUpdater: deps.startUpdater ?? startUpdater,
    isCancel: deps.isCancel ?? isCancel,
    cancel: deps.cancel ?? cancel,
    confirm: deps.confirm ?? confirm,
    select: deps.select ?? select,
    exit: deps.exit ?? process.exit,
  };
}

export async function startUpdatePayload(
  argv = process.argv.slice(2),
  dependencies: UpdatePayloadDependencies = {},
) {
  const payload = parseUpdatePayloadArgs(argv);
  const deps = resolveUpdatePayloadDependencies(dependencies);
  deps.assertAuthorizedUpdateJob(payload.requestedInstallDir);
  const currentUser = deps.detectExecutorUser();
  const i18n = deps.createInstallerI18n();
  const ensureNotCancelled = <T>(value: T | symbol): T => {
    if (deps.isCancel(value)) {
      deps.cancel(i18n.installerCancelled);
      return deps.exit(1);
    }
    return value as T;
  };
  const localizedConfirm: typeof confirm = (options) =>
    deps.confirm({
      active: i18n.confirmActiveLabel,
      inactive: i18n.confirmInactiveLabel,
      ...options,
    });
  await deps.startUpdater({
    detectCurrentUser: () => currentUser,
    repoRootFromHere: deps.repoRootFromHere,
    ensureNotCancelled,
    release: deps.releaseInfoFromFile(payload.releaseFile),
    releaseRequest: payload.releaseRequest,
    select: deps.select,
    confirm: localizedConfirm,
    i18n,
    requestedInstallDir: payload.requestedInstallDir,
    requestedTargetUser: payload.requestedTargetUser,
    assumeYes: payload.assumeYes,
    preconfirmed: payload.preconfirmed,
  });
}
