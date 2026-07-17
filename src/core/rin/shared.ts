import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

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
import {
  defaultInstallDirForHome,
  installSettingsPath,
  installerManifestPath,
  managedNodeExecutablePath,
  managedSystemdUnitCandidates,
} from "../rin-install/paths.js";
import { tryManagedSystemdAction } from "../rin-install/managed-service.js";
import { type ReleaseChannel } from "../rin-lib/release.js";
import { launchDaemonIndependentUpdateJob } from "./update-job.js";
import {
  extractSubcommandArgv,
  safeString,
  type ParsedArgs,
} from "./shared-lite.js";
export {
  cleanupStaleUpdateWorkDirs,
  requireTool,
  runLoggedUpdateCommandSync,
  updateWorkRoot,
} from "../rin-install/update-workflow.js";

export { repoRootFromHere, runCommand };
export {
  collectTuiPassthroughArgs,
  extractSubcommandArgv,
  hasSubcommandHelpFlag,
  installConfigPath,
  loadInstallConfig,
  loadInstallConfigForHome,
  readRinPackageVersion,
  resolveParsedArgs,
  safeString,
  stripRinWrapperArgs,
} from "./shared-lite.js";
export type { ParsedArgs } from "./shared-lite.js";

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
          buildDaemonStatusScript(base.socketPath, 5000, "doctor_1"),
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
        { socketPath: base.socketPath, timeoutMs: 5000 },
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

export function rinInstallUpdateNodeCommand(installDir: string) {
  const managedNode = managedNodeExecutablePath(installDir);
  if (fs.existsSync(managedNode)) return managedNode;
  throw new Error(`rin_managed_node_runtime_missing:${managedNode}`);
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
  const nodePath = rinInstallUpdateNodeCommand(installDir);
  const updateEntryPath = path.join(
    repoRoot,
    "dist",
    "app",
    "rin-install",
    "main.js",
  );
  const updateArgs = buildRinInstallUpdateArgs(parsed, installDir);
  const detachedJob = launchDaemonIndependentUpdateJob({
    targetUser: parsed.targetUser,
    installDir,
    nodePath,
    updateEntryPath,
    executorEntryPath: path.join(
      repoRoot,
      "dist",
      "app",
      "rin-install",
      "update-job.js",
    ),
    updateArgs,
    cwd: repoRoot,
  });
  if (detachedJob) {
    process.stdout.write(
      [
        `Rin update job accepted: ${detachedJob.id}`,
        `Status: ${detachedJob.jobPath}`,
        `Logs: journalctl --user -u ${detachedJob.unit}`,
        "",
      ].join("\n"),
    );
    return;
  }
  await runInteractiveCommand(nodePath, [updateEntryPath, ...updateArgs], {
    env: { ...process.env },
    cwd: repoRoot,
  });
}
