import path from "node:path";

import { cancel, confirm, isCancel, select } from "@clack/prompts";

import { requestProcessTermination } from "../platform/process-lifetime.js";
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

function assertKnownUpdatePayloadArgs(argv: string[]) {
  const booleanOptions = new Set([
    "--stable",
    "--beta",
    "--nightly",
    "--yes",
    "--preconfirmed",
  ]);
  const valueOptions = new Set([
    "--target-user",
    "--install-dir",
    "--branch",
    "--version",
    "--release-file",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || "").trim();
    if (booleanOptions.has(value)) continue;
    if (value === "--git") {
      const next = String(argv[index + 1] || "").trim();
      if (next && !next.startsWith("--")) index += 1;
      continue;
    }
    if (value.startsWith("--git=")) continue;
    const option = value.split("=", 1)[0];
    if (valueOptions.has(option)) {
      if (value === option) {
        const next = String(argv[index + 1] || "").trim();
        if (next && !next.startsWith("--")) index += 1;
      }
      continue;
    }
    throw new Error(`unknown_run_option:${value}`);
  }
}

export function parseUpdatePayloadArgs(argv: string[]) {
  assertKnownUpdatePayloadArgs(argv);
  const hasFlag = (name: string) =>
    argv.some((arg) => String(arg || "").trim() === name);
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
    exit: deps.exit ?? requestProcessTermination,
  };
}

async function runUpdatePayload(
  payload: ReturnType<typeof parseUpdatePayloadArgs>,
  deps: ReturnType<typeof resolveUpdatePayloadDependencies>,
) {
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

export async function startUpdatePayload(
  argv = process.argv.slice(2),
  dependencies: UpdatePayloadDependencies = {},
) {
  const payload = parseUpdatePayloadArgs(argv);
  const deps = resolveUpdatePayloadDependencies(dependencies);
  deps.assertAuthorizedUpdateJob(payload.requestedInstallDir);
  await runUpdatePayload(payload, deps);
}

function legacyPreparedUpdateHandoffError(): never {
  throw new Error("unknown_run_option:--update");
}

export async function startLegacyPreparedUpdatePayload(
  argv = process.argv.slice(2),
  dependencies: UpdatePayloadDependencies = {},
) {
  if (argv.filter((arg) => arg === "--update").length !== 1) {
    return legacyPreparedUpdateHandoffError();
  }
  const payload = parseUpdatePayloadArgs(
    argv.filter((arg) => arg !== "--update"),
  );
  const deps = resolveUpdatePayloadDependencies(dependencies);
  const sourceRoot = path.resolve(deps.repoRootFromHere());
  const releaseFile = path.resolve(payload.releaseFile);
  if (
    !payload.assumeYes ||
    !payload.preconfirmed ||
    !payload.requestedTargetUser ||
    !payload.requestedInstallDir ||
    !payload.releaseFile ||
    path.basename(sourceRoot) !== "src" ||
    path.basename(releaseFile) !== "release.json" ||
    path.dirname(sourceRoot) !== path.dirname(releaseFile)
  ) {
    return legacyPreparedUpdateHandoffError();
  }
  await runUpdatePayload(payload, deps);
}
