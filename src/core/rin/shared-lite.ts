import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readJsonFileOrDefault } from "../platform/fs.js";
import { type ReleaseChannel } from "../rin-lib/release.js";
import {
  defaultInstallDirForHome,
  installRecordCandidatesForHome,
  installerManifestPath,
  launcherMetadataPathForHome,
} from "../rin-install/paths.js";
import { loadInstallRecordFromCandidates } from "../rin-install/install-record.js";
import { safeString } from "../text-utils.js";

export type ParsedArgs = {
  command:
    | ""
    | "update"
    | "start"
    | "stop"
    | "restart"
    | "doctor"
    | "status"
    | "tasks"
    | "self-improve"
    | "versions"
    | "rollback"
    | "memory-index"
    | "target"
    | "version";
  targetUser: string;
  targetName: string;
  installDir: string;
  passthrough: string[];
  explicitUser: boolean;
  explicitTarget: boolean;
  hasSavedInstall: boolean;
  releaseChannel: ReleaseChannel;
  releaseBranch: string;
  releaseVersion: string;
  explicitReleaseChannel: boolean;
  updateAssumeYes: boolean;
  maintenanceMode: boolean;
};

type InstallConfig = {
  defaultTargetUser?: string;
  defaultInstallDir?: string;
};

const RIN_WRAPPER_FLAGS_WITH_VALUE = new Set(["-u", "--user", "--target"]);
const RIN_WRAPPER_FLAGS = new Set(["--maint"]);

function hasInlineWrapperValue(arg: string) {
  return arg.startsWith("--user=") || arg.startsWith("--target=");
}

export function stripRinWrapperArgs(rawArgv: string[]) {
  const args: string[] = [];
  for (let index = 0; index < rawArgv.length; index += 1) {
    const arg = safeString(rawArgv[index]).trim();
    if (!arg) continue;
    if (RIN_WRAPPER_FLAGS_WITH_VALUE.has(arg)) {
      index += 1;
      continue;
    }
    if (hasInlineWrapperValue(arg) || RIN_WRAPPER_FLAGS.has(arg)) continue;
    args.push(arg);
  }
  return args;
}

export function extractSubcommandArgv(rawArgv: string[], command: string) {
  const args = stripRinWrapperArgs(rawArgv);
  const commandIndex = args.indexOf(command);
  if (commandIndex < 0) return args;
  return args.slice(commandIndex + 1);
}

export function hasSubcommandHelpFlag(rawArgv: string[], command: string) {
  const args = stripRinWrapperArgs(rawArgv);
  const commandIndex = args.indexOf(command);
  if (commandIndex < 0) return false;
  return args
    .slice(commandIndex + 1)
    .some((arg) => arg === "--help" || arg === "-h");
}

export function installConfigPath() {
  return launcherMetadataPathForHome(os.homedir());
}

export function loadInstallConfigForHome(home = os.homedir()): InstallConfig {
  return (
    loadInstallRecordFromCandidates(
      home,
      installRecordCandidatesForHome(home),
      (filePath) => readJsonFileOrDefault(filePath, null),
    ) || {}
  );
}

export function loadInstallConfig() {
  return loadInstallConfigForHome(os.homedir());
}

export function collectTuiPassthroughArgs(argv: string[]) {
  return stripRinWrapperArgs(argv);
}

function installDirFromRuntimeRoot(repoRoot: string) {
  const normalized = path.resolve(repoRoot);
  if (
    path.basename(normalized) === "current" &&
    path.basename(path.dirname(normalized)) === "app"
  ) {
    return path.dirname(path.dirname(normalized));
  }
  if (
    path.basename(path.dirname(normalized)) === "releases" &&
    path.basename(path.dirname(path.dirname(normalized))) === "app"
  ) {
    return path.dirname(path.dirname(path.dirname(normalized)));
  }
  return "";
}

function isGitHash(value: unknown) {
  return /^[0-9a-f]{7,40}$/i.test(safeString(value).trim());
}

function readInstalledRuntimeVersion(installDir: string) {
  try {
    const manifest = JSON.parse(
      fs
        .readFileSync(installerManifestPath(installDir), "utf8")
        .replace(/^\uFEFF/, ""),
    );
    const release = manifest?.currentRelease?.release;
    const version = safeString(release?.version).trim();
    if (safeString(release?.channel).trim() === "git") {
      return isGitHash(version) ? version : "";
    }
    return version;
  } catch {
    return "";
  }
}

function repoRootFromHere() {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
  );
}

export function readRinPackageVersion(repoRoot = repoRootFromHere()) {
  const installDir = installDirFromRuntimeRoot(repoRoot);
  if (installDir) return readInstalledRuntimeVersion(installDir) || "unknown";
  return "unknown";
}

function looksLikeGitRefSelector(value: string) {
  const normalized = safeString(value).trim();
  return (
    /^[0-9a-f]{7,40}$/i.test(normalized) ||
    /^v\d/.test(normalized) ||
    normalized.startsWith("refs/") ||
    /[~^:]/.test(normalized)
  );
}

function extractOptionalFlagSelector(
  rawArgv: string[],
  command: string,
  flag: "--stable" | "--beta" | "--nightly" | "--git",
) {
  const args = extractSubcommandArgv(rawArgv, command);
  for (let index = 0; index < args.length; index += 1) {
    const arg = safeString(args[index]).trim();
    if (!arg) continue;
    if (arg === "--") break;
    if (arg === flag) {
      const next = safeString(args[index + 1]).trim();
      if (!next || next.startsWith("-")) return "";
      return next;
    }
    if (arg.startsWith(`${flag}=`)) {
      return safeString(arg.slice(flag.length + 1)).trim();
    }
    if (arg === "--branch" || arg === "--version") {
      index += 1;
    }
  }
  return "";
}

function hasReleaseChannelFlag(
  rawArgv: string[],
  command: string,
  flag: "--stable" | "--beta" | "--nightly" | "--git",
) {
  return extractSubcommandArgv(rawArgv, command).some(
    (arg) => arg === flag || arg.startsWith(`${flag}=`),
  );
}

function resolveParsedReleaseArgs(
  command: ParsedArgs["command"],
  options: any,
  rawArgv: string[],
): Pick<
  ParsedArgs,
  | "releaseChannel"
  | "releaseBranch"
  | "releaseVersion"
  | "explicitReleaseChannel"
> {
  if (command !== "update") {
    return {
      releaseChannel: "stable",
      releaseBranch: "",
      releaseVersion: "",
      explicitReleaseChannel: false,
    };
  }

  const selectedChannels = [
    options.stable || hasReleaseChannelFlag(rawArgv, command, "--stable")
      ? "stable"
      : "",
    options.beta || hasReleaseChannelFlag(rawArgv, command, "--beta")
      ? "beta"
      : "",
    options.nightly || hasReleaseChannelFlag(rawArgv, command, "--nightly")
      ? "nightly"
      : "",
    options.git || hasReleaseChannelFlag(rawArgv, command, "--git")
      ? "git"
      : "",
  ].filter(Boolean) as ReleaseChannel[];

  if (selectedChannels.length > 1) {
    throw new Error("rin_release_channel_conflict");
  }

  const explicitReleaseChannel = selectedChannels.length > 0;
  const releaseChannel = selectedChannels[0] || "stable";
  let releaseBranch = safeString(options.branch).trim();
  let releaseVersion = safeString(options.version).trim();
  const stableSelector = extractOptionalFlagSelector(
    rawArgv,
    command,
    "--stable",
  );
  const betaSelector = extractOptionalFlagSelector(rawArgv, command, "--beta");
  const nightlySelector = extractOptionalFlagSelector(
    rawArgv,
    command,
    "--nightly",
  );
  const gitSelector = extractOptionalFlagSelector(rawArgv, command, "--git");

  if (stableSelector) throw new Error("rin_stable_selector_not_supported");
  if (betaSelector) throw new Error("rin_beta_selector_not_supported");
  if (nightlySelector) throw new Error("rin_nightly_selector_not_supported");

  if (!releaseBranch && !releaseVersion && gitSelector) {
    if (looksLikeGitRefSelector(gitSelector)) {
      releaseVersion = gitSelector;
    } else {
      releaseBranch = gitSelector;
    }
  }

  if (releaseBranch && releaseVersion) {
    throw new Error("rin_release_branch_and_version_conflict");
  }
  if (releaseChannel === "stable" && releaseBranch) {
    throw new Error("rin_stable_branch_not_supported");
  }
  if (releaseChannel === "beta" && (releaseBranch || releaseVersion)) {
    throw new Error("rin_beta_selector_not_supported");
  }
  if (releaseChannel === "nightly" && (releaseBranch || releaseVersion)) {
    throw new Error("rin_nightly_selector_not_supported");
  }

  return {
    releaseChannel,
    releaseBranch,
    releaseVersion,
    explicitReleaseChannel,
  };
}

export function resolveParsedArgs(
  command: ParsedArgs["command"],
  options: any,
  rawArgv: string[],
): ParsedArgs {
  const installConfig = loadInstallConfig();
  const targetUser = safeString(options.user).trim();
  const targetName = safeString(options.target).trim();
  return {
    command,
    targetUser:
      targetUser ||
      safeString(installConfig.defaultTargetUser).trim() ||
      os.userInfo().username,
    targetName,
    installDir: safeString(installConfig.defaultInstallDir).trim(),
    passthrough: command ? [] : collectTuiPassthroughArgs(rawArgv),
    explicitUser: Boolean(targetUser),
    explicitTarget: Boolean(targetName),
    hasSavedInstall: Boolean(
      safeString(installConfig.defaultTargetUser).trim() ||
      safeString(installConfig.defaultInstallDir).trim(),
    ),
    ...resolveParsedReleaseArgs(command, options, rawArgv),
    updateAssumeYes: command === "update" && Boolean(options.yes),
    maintenanceMode: !command && rawArgv.includes("--maint"),
  };
}

export { safeString };
