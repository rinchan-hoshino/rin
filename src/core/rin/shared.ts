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
  readPasswdUser,
  shellQuote,
  socketPathForUser,
  targetUserRuntimeEnv,
} from "../rin-lib/system.js";
import {
  detectCurrentUser,
  repoRootFromHere,
  runCommand,
} from "../rin-install/common.js";
import { createInstallerI18n } from "../rin-install/i18n.js";
import { readJsonFileWithPrivilege } from "../rin-install/fs-utils.js";
import { loadInstallRecordFromCandidates } from "../rin-install/install-record.js";
import { runInstallerProgress } from "../rin-install/progress.js";
import {
  defaultInstallDirForHome,
  installRecordCandidatesForHome,
  installSettingsPath,
  launcherMetadataPathForHome,
  managedSystemdUnitCandidates,
} from "../rin-install/paths.js";
import { tryManagedSystemdAction } from "../rin-install/managed-service.js";
import {
  type ReleaseChannel,
  type ResolvedRelease,
  getReleasePackageName,
  getReleaseRepoUrl,
  loadReleaseManifestForNetwork,
  resolveReleaseRequest,
} from "../rin-lib/release.js";

export type ParsedArgs = {
  command:
    | ""
    | "update"
    | "start"
    | "stop"
    | "restart"
    | "doctor"
    | "status"
    | "gui"
    | "usage"
    | "memory"
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

export function readUpdateDisplayLanguage(
  installDir: string,
  options: {
    targetUser?: string;
    currentUser?: string;
    readJson?: typeof readJsonFile;
    readPrivilegedJson?: typeof readJsonFileWithPrivilege;
  } = {},
) {
  const currentUser = safeString(options.currentUser || os.userInfo().username);
  const targetUser = safeString(options.targetUser || currentUser);
  const readSettings =
    targetUser === currentUser
      ? options.readJson || readJsonFile
      : options.readPrivilegedJson || readJsonFileWithPrivilege;
  return normalizeLanguageTag(
    readSettings<any>(installSettingsPath(installDir), {})?.language,
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

export function createTargetExecutionContext(
  parsed: ParsedArgs,
): TargetExecutionContext {
  const base = daemonControlContext(parsed);
  const currentUser = os.userInfo().username;
  const isTargetUser = !base.targetUser || base.targetUser === currentUser;

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

export function requireTool(name: string, paths: string[] = []) {
  for (const candidate of paths) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  try {
    return (
      execFileSync("sh", ["-lc", `command -v ${shellQuote(name)}`], {
        encoding: "utf8",
      }).trim() || name
    );
  } catch {
    throw new Error(`rin_missing_required_tool:${name}`);
  }
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

function runCommandSync(command: string, args: string[], options: any = {}) {
  execFileSync(command, args, { stdio: "inherit", ...options });
}

function runLoggedUpdateCommandSync(
  command: string,
  args: string[],
  label: string,
  logFile: string,
  options: any = {},
  buildFailureHeader: (label: string) => string = (value) =>
    `${value} failed; recent log:`,
) {
  if (!process.stderr.isTTY) {
    runCommandSync(command, args, options);
    return;
  }

  const fd = fs.openSync(logFile, "a");
  try {
    fs.writeSync(fd, `\n$ ${[command, ...args].join(" ")}\n`);
    execFileSync(command, args, {
      ...options,
      stdio: ["ignore", fd, fd],
    });
  } catch (error) {
    try {
      const log = fs.readFileSync(logFile, "utf8").trimEnd();
      const recent = log.split("\n").slice(-80).join("\n");
      if (recent)
        process.stderr.write(`\n${buildFailureHeader(label)}\n${recent}\n`);
    } catch {}
    throw error;
  } finally {
    fs.closeSync(fd);
  }
}

function resolveGitCommitForRelease(
  repoUrl: string,
  release: ResolvedRelease,
): ResolvedRelease {
  if (release.channel !== "git") return release;
  const selector = release.ref || release.version || release.branch || "HEAD";
  if (/^[0-9a-f]{7,40}$/i.test(selector)) return release;
  try {
    const git = requireTool("git", ["/usr/bin/git", "/bin/git"]);
    const raw = execFileSync(git, ["ls-remote", repoUrl, selector], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const hash = raw.split(/\s+/)[0] || "";
    if (/^[0-9a-f]{40}$/i.test(hash)) {
      const shortHash = hash.slice(0, 12);
      return {
        ...release,
        version: shortHash,
        ref: hash,
        sourceLabel: `${release.sourceLabel} @ ${shortHash}`,
      };
    }
  } catch {}
  return release;
}

export function updateWorkRoot() {
  const base =
    safeString(process.env.XDG_CACHE_HOME).trim() ||
    path.join(os.homedir(), ".cache");
  const dir = path.join(base, "rin-update");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function cleanupStaleUpdateWorkDirs(
  workRoot: string,
  options: {
    keepPaths?: string[];
    nowMs?: number;
    staleAfterMs?: number;
  } = {},
) {
  const rootPath = path.resolve(workRoot);
  const keepPaths = new Set(
    (options.keepPaths || []).map((item) => path.resolve(item)),
  );
  const nowMs = Number.isFinite(options.nowMs)
    ? Number(options.nowMs)
    : Date.now();
  const staleAfterMs = Number.isFinite(options.staleAfterMs)
    ? Math.max(0, Number(options.staleAfterMs))
    : 12 * 60 * 60 * 1000;
  const removed: string[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(rootPath, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith("work-")) continue;
    const fullPath = path.join(rootPath, entry.name);
    if (keepPaths.has(path.resolve(fullPath))) continue;
    try {
      const stat = fs.statSync(fullPath);
      const touchedAt = Number(stat.mtimeMs || 0);
      if (nowMs - touchedAt < staleAfterMs) continue;
      fs.rmSync(fullPath, { recursive: true, force: true });
      removed.push(fullPath);
    } catch {}
  }
  return removed;
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
  const targetHome = readPasswdUser(targetUser)?.home || os.homedir();
  const installDir = parsed.installDir || defaultInstallDirForHome(targetHome);
  const runtimeAgentDir =
    safeString(process.env[RIN_DIR_ENV]).trim() || installDir;
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
  const socketPath =
    targetUser === os.userInfo().username
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

export function readRinPackageVersion(repoRoot = repoRootFromHere()) {
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
): Pick<ParsedArgs, "releaseChannel" | "releaseBranch" | "releaseVersion"> {
  if (command !== "update") {
    return {
      releaseChannel: "stable",
      releaseBranch: "",
      releaseVersion: "",
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

export async function runUpdate(parsed: ParsedArgs) {
  const installDir = resolveInstallDirForTarget(parsed);
  const i18n = createUpdateI18n(installDir, parsed.targetUser);
  const manifest = await loadReleaseManifestForNetwork();
  const requestedRelease = resolveReleaseRequest(manifest, {
    channel: parsed.releaseChannel,
    branch: parsed.releaseBranch,
    version: parsed.releaseVersion,
  });
  const resolvedRelease = resolveGitCommitForRelease(
    manifest.git?.repoUrl || getReleaseRepoUrl(manifest),
    requestedRelease,
  );
  const npm = requireTool("npm", ["/usr/bin/npm", "/bin/npm"]);
  const installerEnv = { ...process.env };
  const baseInstallerArgs = [
    "--update",
    "--target-user",
    parsed.targetUser,
    "--install-dir",
    installDir,
    "--language",
    i18n.language,
    ...(parsed.updateAssumeYes ? ["--yes"] : []),
  ];

  const writeReleaseHandoffFile = (dir: string) => {
    const releaseFile = path.join(dir, "release.json");
    fs.writeFileSync(releaseFile, `${JSON.stringify(resolvedRelease)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return releaseFile;
  };

  if (resolvedRelease.channel === "stable") {
    const packageName = getReleasePackageName(manifest);
    const releaseDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "rin-update-release-"),
    );
    try {
      const installerArgs = [
        ...baseInstallerArgs,
        "--release-file",
        writeReleaseHandoffFile(releaseDir),
      ];
      await runInteractiveCommand(
        npm,
        [
          "exec",
          "--yes",
          "--loglevel=error",
          "--no-fund",
          "--no-audit",
          "--package",
          `${packageName}@${resolvedRelease.version}`,
          "--",
          "rin-install",
          ...installerArgs,
        ],
        { env: installerEnv },
      );
    } finally {
      try {
        fs.rmSync(releaseDir, { recursive: true, force: true });
      } catch {}
    }
    return;
  }

  const curl =
    process.platform === "win32"
      ? ""
      : fs.existsSync("/usr/bin/curl")
        ? "/usr/bin/curl"
        : "";
  const wget =
    process.platform === "win32"
      ? ""
      : fs.existsSync("/usr/bin/wget")
        ? "/usr/bin/wget"
        : "";
  const tar = requireTool("tar", ["/usr/bin/tar", "/bin/tar"]);
  const workRoot = updateWorkRoot();
  cleanupStaleUpdateWorkDirs(workRoot);
  const tempRoot = fs.mkdtempSync(path.join(workRoot, "work-"));
  const tmpDir = path.join(tempRoot, "tmp");
  const archivePath = path.join(tempRoot, "rin.tar.gz");
  const sourceRoot = path.join(tempRoot, "src");
  const logFile = path.join(tempRoot, "update.log");
  const buildEnv = {
    ...process.env,
    TMPDIR: tmpDir,
    TEMP: tmpDir,
    TMP: tmpDir,
  };

  try {
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(logFile, "", "utf8");
    const installerArgs = [
      ...baseInstallerArgs,
      "--release-file",
      writeReleaseHandoffFile(tempRoot),
    ];

    await runInstallerProgress(i18n.fetchingUpdateSourceMessage, () => {
      if (curl) {
        runLoggedUpdateCommandSync(
          curl,
          ["-fsSL", resolvedRelease.archiveUrl, "-o", archivePath],
          i18n.fetchingUpdateSourceMessage,
          logFile,
          {},
          i18n.buildUpdateCommandFailureHeader,
        );
      } else if (wget) {
        runLoggedUpdateCommandSync(
          wget,
          ["-qO", archivePath, resolvedRelease.archiveUrl],
          i18n.fetchingUpdateSourceMessage,
          logFile,
          {},
          i18n.buildUpdateCommandFailureHeader,
        );
      } else {
        throw new Error("rin_missing_required_tool:curl_or_wget");
      }
    });
    await runInstallerProgress(i18n.preparingUpdateSourceMessage, () =>
      runLoggedUpdateCommandSync(
        tar,
        ["-xzf", archivePath, "-C", sourceRoot, "--strip-components=1"],
        i18n.preparingUpdateSourceMessage,
        logFile,
        {},
        i18n.buildUpdateCommandFailureHeader,
      ),
    );

    await runInstallerProgress(i18n.installingUpdateDependenciesMessage, () => {
      if (fs.existsSync(path.join(sourceRoot, "package-lock.json"))) {
        runLoggedUpdateCommandSync(
          npm,
          ["ci", "--no-fund", "--no-audit", "--loglevel=error"],
          i18n.installingUpdateDependenciesMessage,
          logFile,
          { cwd: sourceRoot, env: buildEnv },
          i18n.buildUpdateCommandFailureHeader,
        );
      } else {
        runLoggedUpdateCommandSync(
          npm,
          ["install", "--no-fund", "--no-audit", "--loglevel=error"],
          i18n.installingUpdateDependenciesMessage,
          logFile,
          { cwd: sourceRoot, env: buildEnv },
          i18n.buildUpdateCommandFailureHeader,
        );
      }
    });
    await runInstallerProgress(i18n.buildingUpdateRuntimeMessage, () =>
      runLoggedUpdateCommandSync(
        npm,
        ["run", "build", "--silent"],
        i18n.buildingUpdateRuntimeMessage,
        logFile,
        { cwd: sourceRoot, env: buildEnv },
        i18n.buildUpdateCommandFailureHeader,
      ),
    );

    await runInteractiveCommand(
      process.execPath,
      [
        path.join(sourceRoot, "dist", "app", "rin-install", "main.js"),
        ...installerArgs,
      ],
      { env: installerEnv, cwd: sourceRoot },
    );
  } finally {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {}
  }
}
