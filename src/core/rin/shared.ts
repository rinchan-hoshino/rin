import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { safeString } from "../text-utils.js";

import { normalizeLanguageTag } from "../language.js";
import { bridgeDaemonSocketPath } from "../rin-lib/common.js";
import { readJsonFile } from "../platform/fs.js";
import { sleep } from "../platform/process.js";
import {
  buildDaemonSocketProbeScript,
  buildDaemonStatusScript,
  canConnectDaemonSocket,
  requestDaemonCommand,
} from "../rin-daemon/client.js";
import { RIN_DIR_ENV } from "../rin-lib/runtime.js";
import {
  buildUserShell,
  isSameSystemUser,
  readPasswdUser,
  socketPathForUser,
  targetUserRuntimeEnv,
} from "../rin-lib/system.js";
import { repoRootFromHere, runCommand } from "../rin-install/common.js";
import { createInstallerI18n } from "../rin-install/i18n.js";
import { readJsonFileWithPrivilege } from "../rin-install/fs-utils.js";
import { loadInstallRecordFromCandidates } from "../rin-install/install-record.js";
import {
  defaultInstallDirForHome,
  installRecordCandidatesForHome,
  installSettingsPath,
  installerManifestPath,
  launcherMetadataPathForHome,
  managedSystemdUnitCandidates,
} from "../rin-install/paths.js";
import { tryManagedSystemdAction } from "../rin-install/managed-service.js";
import { type ReleaseChannel } from "../rin-lib/release.js";
export {
  cleanupStaleUpdateWorkDirs,
  requireTool,
  runLoggedUpdateCommandSync,
  updateWorkRoot,
} from "../rin-install/update-workflow.js";

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
    | "gui"
    | "usage"
    | "self"
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
};

type InstallConfig = {
  defaultTargetUser?: string;
  defaultInstallDir?: string;
};

export { repoRootFromHere, runCommand, safeString };

const RIN_WRAPPER_FLAGS_WITH_VALUE = new Set(["-u", "--user", "--target"]);
const RIN_WRAPPER_FLAGS = new Set<string>();

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

export function captureInternalRinCommand(
  context: Pick<TargetExecutionContext, "repoRoot" | "capture">,
  internalCommand: string,
  rawArgv: string[],
  command: string,
) {
  const entry = path.join(context.repoRoot, "dist", "app", "rin", "main.js");
  return context.capture([
    process.execPath,
    entry,
    internalCommand,
    ...extractSubcommandArgv(rawArgv, command),
  ]);
}

export function installConfigPath() {
  return launcherMetadataPathForHome(os.homedir());
}

export function loadInstallConfigForHome(home = os.homedir()): InstallConfig {
  return (
    loadInstallRecordFromCandidates(
      home,
      installRecordCandidatesForHome(home),
      (filePath) => readJsonFile(filePath, null),
    ) || {}
  );
}

export function loadInstallConfig() {
  return loadInstallConfigForHome(os.homedir());
}

type TargetJsonReadOptions = {
  targetUser?: string;
  currentUser?: string;
  readJson?: typeof readJsonFile;
  readPrivilegedJson?: typeof readJsonFileWithPrivilege;
};

function shouldUsePrivilegedTargetRead(options: TargetJsonReadOptions = {}) {
  const currentUser = safeString(
    options.currentUser || os.userInfo().username,
  ).trim();
  const targetUser = safeString(options.targetUser || currentUser).trim();
  return Boolean(targetUser && !isSameSystemUser(targetUser, currentUser));
}

export function readTargetJsonFile<T>(
  filePath: string,
  fallback: T,
  options: TargetJsonReadOptions = {},
): T {
  const reader = shouldUsePrivilegedTargetRead(options)
    ? options.readPrivilegedJson || readJsonFileWithPrivilege
    : options.readJson || readJsonFile;
  return reader<T>(filePath, fallback);
}

export function readInstallerManifestForTarget<T = any>(
  installDir: string,
  options: TargetJsonReadOptions = {},
): T {
  return readTargetJsonFile<T>(
    installerManifestPath(installDir),
    {} as T,
    options,
  );
}

export function readUpdateDisplayLanguage(
  installDir: string,
  options: TargetJsonReadOptions = {},
) {
  return normalizeLanguageTag(
    readTargetJsonFile<any>(installSettingsPath(installDir), {}, options)
      ?.language,
    "",
  );
}

export function createUpdateI18n(installDir: string, targetUser?: string) {
  return createInstallerI18n(
    readUpdateDisplayLanguage(installDir, { targetUser }),
  );
}

type TargetExecutionContextBase = ReturnType<typeof daemonControlContext>;
export type TargetExecutionContext = TargetExecutionContextBase & {
  currentUser: string;
  isTargetUser: boolean;
  exec: (argv: string[], options?: any) => void;
  capture: (argv: string[], options?: any) => string;
  canConnectSocket: () => Promise<boolean>;
  queryDaemonStatus: () => Promise<any>;
};

export function resolveRuntimeAgentDirForTarget(
  targetUser: string,
  currentUser: string,
  installDir: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const normalizedTargetUser = safeString(targetUser).trim();
  const processUser = os.userInfo().username;
  const normalizedCurrentUser = safeString(currentUser || processUser).trim();
  const normalizedProcessUser = safeString(processUser).trim();
  const normalizedInstallDir = safeString(installDir).trim();
  const explicitRinDir = safeString(env[RIN_DIR_ENV]).trim();
  if (
    explicitRinDir &&
    (!normalizedTargetUser ||
      isSameSystemUser(normalizedTargetUser, normalizedCurrentUser) ||
      isSameSystemUser(normalizedTargetUser, normalizedProcessUser))
  ) {
    return explicitRinDir;
  }
  return normalizedInstallDir || explicitRinDir;
}

export function createTargetExecutionContext(
  parsed: ParsedArgs,
): TargetExecutionContext {
  const base = daemonControlContext(parsed);
  const currentUser = os.userInfo().username;
  const isTargetUser =
    !base.targetUser || isSameSystemUser(base.targetUser, currentUser);

  const exec = (argv: string[], options: any = {}) => {
    const launch = buildUserShell(base.targetUser, argv, base.runtimeEnv);
    execFileSync(launch.command, launch.args, {
      stdio: "inherit",
      env: launch.env,
      cwd: base.repoRoot,
      ...options,
    });
  };

  const capture = (argv: string[], options: any = {}) => {
    const launch = buildUserShell(base.targetUser, argv, base.runtimeEnv);
    return execFileSync(launch.command, launch.args, {
      encoding: "utf8",
      env: launch.env,
      cwd: base.repoRoot,
      ...options,
    });
  };

  const canConnectSocketInContext = async () => {
    if (isTargetUser) return await canConnectDaemonSocket(base.socketPath, 500);
    try {
      capture(
        [
          process.execPath,
          "-e",
          buildDaemonSocketProbeScript(base.socketPath, 500),
        ],
        { stdio: "ignore" },
      );
      return true;
    } catch {
      return false;
    }
  };

  const queryDaemonStatusInContext = async () => {
    if (!isTargetUser) {
      try {
        const raw = capture([
          process.execPath,
          "-e",
          buildDaemonStatusScript(base.socketPath, 1500, "doctor_1"),
        ]);
        const decoded = JSON.parse(String(raw || "null"));
        return decoded == null ? undefined : decoded;
      } catch {
        return undefined;
      }
    }

    try {
      return await requestDaemonCommand(
        { id: "doctor_1", type: "daemon_status" },
        { socketPath: base.socketPath, timeoutMs: 1500 },
      );
    } catch {
      return undefined;
    }
  };

  return {
    ...base,
    currentUser,
    isTargetUser,
    exec,
    capture,
    canConnectSocket: canConnectSocketInContext,
    queryDaemonStatus: queryDaemonStatusInContext,
  };
}

export function targetPathExists(
  context: Pick<TargetExecutionContext, "isTargetUser" | "capture">,
  filePath: string,
  fileExists: (filePath: string) => boolean = fs.existsSync,
) {
  if ((context as any).isTargetUser !== false) return fileExists(filePath);
  try {
    context.capture(["test", "-e", filePath], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function ensureDaemonAvailable(context: TargetExecutionContext) {
  if (await context.canConnectSocket()) return;

  if (context.systemctl) {
    tryManagedSystemdAction(context.managedServiceUnits, {
      runAction: (unit) =>
        context.exec([context.systemctl, "--user", "start", unit]),
    });
    const startedAt = Date.now();
    while (Date.now() - startedAt < 5000) {
      if (await context.canConnectSocket()) return;
      await sleep(150);
    }
  }

  throw new Error(
    `rin_daemon_unavailable: managed daemon service did not become available for ${context.targetUser}`,
  );
}

const FORWARDED_CHILD_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

function signalExitCode(signal: NodeJS.Signals) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  if (signal === "SIGHUP") return 129;
  return 1;
}

async function runInteractiveCommand(
  command: string,
  args: string[],
  options: any = {},
) {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  let forwardedSignal: NodeJS.Signals | null = null;
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of FORWARDED_CHILD_SIGNALS) {
    const handler = () => {
      forwardedSignal = signal;
      if (!child.killed) child.kill(signal);
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }

  try {
    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    if (forwardedSignal) process.exit(signalExitCode(forwardedSignal));
    if (result.signal) process.exit(signalExitCode(result.signal));
    if (result.code && result.code !== 0) {
      const error: any = new Error(`rin_child_command_failed:${result.code}`);
      error.status = result.code;
      throw error;
    }
  } finally {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
  }
}

export function resolveInstallDirForTarget(parsed: ParsedArgs) {
  const target = readPasswdUser(parsed.targetUser);
  return (
    parsed.installDir || defaultInstallDirForHome(target?.home || os.homedir())
  );
}

function daemonControlContext(parsed: ParsedArgs) {
  const repoRoot = repoRootFromHere();
  const targetUser = parsed.targetUser;
  const currentUser = os.userInfo().username;
  const targetHome = readPasswdUser(targetUser)?.home || os.homedir();
  const installDir = parsed.installDir || defaultInstallDirForHome(targetHome);
  const runtimeAgentDir = resolveRuntimeAgentDirForTarget(
    targetUser,
    currentUser,
    installDir,
  );
  const runtimeEnv = targetUserRuntimeEnv(targetUser, {
    [RIN_DIR_ENV]: runtimeAgentDir,
  });
  const systemctl =
    process.platform === "linux"
      ? fs.existsSync("/usr/bin/systemctl")
        ? "/usr/bin/systemctl"
        : fs.existsSync("/bin/systemctl")
          ? "/bin/systemctl"
          : ""
      : "";
  const socketPath = isSameSystemUser(targetUser, currentUser)
    ? socketPathForUser(targetUser)
    : bridgeDaemonSocketPath(installDir);
  return {
    repoRoot,
    installDir,
    agentDir: runtimeAgentDir,
    targetUser,
    targetHome,
    runtimeEnv,
    systemctl,
    socketPath,
    managedServiceUnits: managedSystemdUnitCandidates(targetUser),
  };
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

function parseInstalledChangelogVersion(installDir: string) {
  try {
    const changelog = fs.readFileSync(
      path.join(installDir, "docs", "release", "CHANGELOG.md"),
      "utf8",
    );
    const match = /^##\s+([^\s]+)/m.exec(changelog);
    return safeString(match?.[1]).trim();
  } catch {
    return "";
  }
}

function readInstalledRuntimeVersionForRoot(repoRoot: string) {
  const installDir = installDirFromRuntimeRoot(repoRoot);
  if (!installDir) return "";
  try {
    const manifest = JSON.parse(
      fs.readFileSync(installerManifestPath(installDir), "utf8"),
    );
    const releaseVersion = safeString(
      manifest?.currentRelease?.release?.version,
    ).trim();
    if (releaseVersion) return releaseVersion;
    const releaseName = safeString(manifest?.currentRelease?.name).trim();
    if (releaseName && releaseName !== "0.0.0") return releaseName;
  } catch {}
  return parseInstalledChangelogVersion(installDir);
}

export function readRinPackageVersion(repoRoot = repoRootFromHere()) {
  const installedVersion = readInstalledRuntimeVersionForRoot(repoRoot);
  if (installedVersion) return installedVersion;
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    );
    return safeString(packageJson.version).trim() || "unknown";
  } catch {
    return "unknown";
  }
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
    options.stable ? "stable" : "",
    options.beta ? "beta" : "",
    options.nightly ? "nightly" : "",
    options.git ? "git" : "",
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
  };
}

function isReleaseChannel(value: string): value is ReleaseChannel {
  return ["stable", "beta", "nightly", "git"].includes(value);
}

export function readInstalledUpdateReleasePreference(
  installDir: string,
  options: TargetJsonReadOptions = {},
): {
  channel: ReleaseChannel;
  branch: string;
} {
  const release = readInstallerManifestForTarget<any>(installDir, options)
    ?.currentRelease?.release;
  const channel = safeString(release?.channel).trim();
  if (!isReleaseChannel(channel)) {
    throw new Error("rin_update_installed_release_channel_missing");
  }
  if (channel !== "git") return { channel, branch: "" };
  return { channel, branch: safeString(release?.branch).trim() };
}

function buildRinInstallUpdateArgs(parsed: ParsedArgs, installDir: string) {
  const args = [
    "--update",
    "--target-user",
    parsed.targetUser,
    "--install-dir",
    installDir,
  ];
  if (parsed.updateAssumeYes) args.push("--yes");
  if (parsed.explicitReleaseChannel) args.push(`--${parsed.releaseChannel}`);
  if (parsed.releaseBranch) args.push("--branch", parsed.releaseBranch);
  if (parsed.releaseVersion) args.push("--version", parsed.releaseVersion);
  return args;
}

export async function runUpdate(parsed: ParsedArgs) {
  const installDir = resolveInstallDirForTarget(parsed);
  const repoRoot = repoRootFromHere();
  await runInteractiveCommand(
    process.execPath,
    [
      path.join(repoRoot, "dist", "app", "rin-install", "main.js"),
      ...buildRinInstallUpdateArgs(parsed, installDir),
    ],
    { env: { ...process.env }, cwd: repoRoot },
  );
}
