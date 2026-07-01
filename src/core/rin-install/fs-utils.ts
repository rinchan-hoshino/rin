import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { type InstalledReleaseInfo } from "../rin-lib/release.js";
import { type ManagedFilesManifest } from "./persist.js";
import {
  ensureDir,
  preferredTempRootCandidates,
  readJsonFile,
  stringifyJson,
  writeJsonFile,
} from "../platform/fs.js";
import { pickPrivilegeCommand, shellQuote } from "../rin-lib/system.js";
import { nowFileTimestamp } from "../time-utils.js";
import {
  appConfigDirForHome,
  currentRuntimeRoot,
  defaultInstallDirForHome,
  installedAppEntryCandidates,
  installedBuiltinSkillRoot,
  installedDocsRoot,
  installedPiDocsRoot,
  installedReleaseRoot,
  installedReleasesRoot,
  installedRinDocsRoot,
  launcherMetadataPathForHome,
  launcherPathForHome,
  localBinDirForHome,
  managedNodeBinDir,
  managedNodeCurrentRoot,
  managedNodeExecutablePath,
  managedNodeRoot,
  windowsLauncherPathForHome,
} from "./paths.js";
import { pruneDuplicatePiCodingAgentDependencies } from "./runtime-dependency-prune.js";

export { ensureDir, readJsonFile, writeJsonFile };

export function readJsonFileWithPrivilege<T>(filePath: string, fallback: T): T {
  const privilegeCommand = pickPrivilegeCommand();
  try {
    const raw = execFileSync(privilegeCommand, ["cat", filePath], {
      encoding: "utf8",
    });
    return JSON.parse(String(raw || "")) as T;
  } catch {
    return fallback;
  }
}

export function readInstallerJson<T>(
  filePath: string,
  fallback: T,
  elevated = false,
): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch (error: any) {
    const code = String(error?.code || "");
    if (code === "EACCES" || code === "EPERM") {
      if (!elevated) throw error;
      return readJsonFileWithPrivilege(filePath, fallback);
    }
    return fallback;
  }
}

export function writeTextFile(filePath: string, value: string, mode = 0o600) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, value, "utf8");
  fs.chmodSync(filePath, mode);
}

export function writeExecutable(filePath: string, content: string) {
  writeTextFile(filePath, content, 0o755);
}

const COMMON_RUNTIME_BIN_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

const INSTALLED_PI_DOC_NAMES = [
  "README.md",
  "CHANGELOG.md",
  "docs",
  "examples",
  "_upstream.json",
] as const;

const INSTALLED_UPSTREAM_BUILTIN_SKILL_NAMES = ["skill-creator"] as const;

const RUNTIME_COPY_ENTRY_NAMES = [
  "dist",
  "extensions",
  "node_modules",
  "package.json",
] as const;

export function installedRuntimePathValue(
  home?: string,
  prependDirs: string[] = [],
) {
  return [
    ...prependDirs,
    home ? path.join(home, ".local", "bin") : "",
    ...COMMON_RUNTIME_BIN_DIRS,
  ]
    .filter(Boolean)
    .join(path.delimiter);
}

export type InstalledRuntimeNodeCommandOptions =
  | NodeJS.Platform
  | {
      installDir?: string;
      platform?: NodeJS.Platform;
    };

function normalizeInstalledRuntimeNodeCommandOptions(
  options: InstalledRuntimeNodeCommandOptions = process.platform,
) {
  if (typeof options === "string") return { platform: options };
  return {
    installDir: options.installDir,
    platform: options.platform || process.platform,
  };
}

export function installedRuntimeNodePathDirs(
  options: InstalledRuntimeNodeCommandOptions = process.platform,
) {
  const { installDir, platform } =
    normalizeInstalledRuntimeNodeCommandOptions(options);
  if (!installDir) return [];
  const executable = managedNodeExecutablePath(installDir, platform);
  return fs.existsSync(executable)
    ? [managedNodeBinDir(installDir, platform)]
    : [];
}

export function installedRuntimeNodeCommandArgs(
  options: InstalledRuntimeNodeCommandOptions = {},
) {
  const { installDir, platform } =
    normalizeInstalledRuntimeNodeCommandOptions(options);
  if (!installDir) {
    throw new Error("rin_managed_node_runtime_missing:install_dir");
  }
  const executable = managedNodeExecutablePath(installDir, platform);
  if (fs.existsSync(executable)) return [executable];
  throw new Error(`rin_managed_node_runtime_missing:${executable}`);
}

export function sourceableRinEnvFile(launcherDir: string) {
  const quotedLauncherDir = shellQuote(launcherDir);
  return [
    "# Rin environment",
    "# Source this file to add Rin launchers to PATH for the current shell.",
    `_rin_bin_dir=${quotedLauncherDir}`,
    'case ":${PATH:-}:" in',
    '  *":$_rin_bin_dir:"*) ;;',
    '  *) export PATH="$_rin_bin_dir${PATH:+:$PATH}" ;;',
    "esac",
    "unset _rin_bin_dir",
    "",
  ].join("\n");
}

export function launcherScript(
  candidates: string[],
  nodeCommandArgs = installedRuntimeNodeCommandArgs(),
) {
  const nodeCommand = nodeCommandArgs
    .map((entry) => shellQuote(entry))
    .join(" ");
  const checks = candidates
    .map(
      (candidate) =>
        `if [ -f ${shellQuote(candidate)} ]; then exec ${nodeCommand} ${shellQuote(candidate)} "$@"; fi`,
    )
    .join("\n");
  return `#!/usr/bin/env sh\n${checks}\necho "rin: installed runtime entry not found" >&2\nexit 1\n`;
}

export function installerTempRootCandidates() {
  return preferredTempRootCandidates();
}

function createInstallerTempDir(prefix: string) {
  for (const root of installerTempRootCandidates()) {
    try {
      fs.mkdirSync(root, { recursive: true });
      return fs.mkdtempSync(path.join(root, prefix));
    } catch {}
  }
  throw new Error("rin_install_temp_dir_unavailable");
}

function shellCommandArgs(args: string[]) {
  return args.map((value) => shellQuote(String(value))).join(" ");
}

function shellCommandEnv(extraEnv: Record<string, string>) {
  return Object.entries(extraEnv).map(
    ([key, value]) => `${key}=${shellQuote(String(value))}`,
  );
}

export function launcherTargetsForInstallDir(installDir: string) {
  return {
    rin: installedAppEntryCandidates(installDir, "rin"),
    rinInstall: installedAppEntryCandidates(installDir, "rin-install"),
  };
}

export type LauncherWriteOptions = {
  elevated?: boolean;
  findSystemUser?: (user: string) => any;
  platform?: NodeJS.Platform;
};

function normalizePathEntryForComparison(value: string) {
  return path.win32.normalize(String(value || "").trim()).toLowerCase();
}

export function pathValueIncludesDirectory(
  pathValue: string,
  directory: string,
  delimiter = process.platform === "win32" ? ";" : path.delimiter,
) {
  const normalizedDirectory = normalizePathEntryForComparison(directory);
  if (!normalizedDirectory) return true;
  return String(pathValue || "")
    .split(delimiter)
    .some(
      (entry) => normalizePathEntryForComparison(entry) === normalizedDirectory,
    );
}

export function buildPathValueWithDirectory(
  pathValue: string,
  directory: string,
  delimiter = process.platform === "win32" ? ";" : path.delimiter,
) {
  const normalizedDirectory = String(directory || "").trim();
  if (
    !normalizedDirectory ||
    pathValueIncludesDirectory(pathValue, directory, delimiter)
  ) {
    return String(pathValue || "");
  }
  const currentEntries = String(pathValue || "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [normalizedDirectory, ...currentEntries].join(delimiter);
}

export function ensureWindowsUserPathIncludes(
  directory: string,
  deps: {
    platform?: NodeJS.Platform;
    readUserPath?: () => string;
    writeUserPath?: (nextPath: string) => void;
  } = {},
) {
  const platform = deps.platform || process.platform;
  const launcherDir = String(directory || "").trim();
  if (platform !== "win32" || !launcherDir) {
    return { updated: false, skipped: true, launcherDir };
  }
  try {
    const currentUserPath = deps.readUserPath
      ? deps.readUserPath()
      : execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            "[Environment]::GetEnvironmentVariable('Path', 'User')",
          ],
          { encoding: "utf8" },
        ).trim();
    const nextUserPath = buildPathValueWithDirectory(
      currentUserPath,
      launcherDir,
      ";",
    );
    const processPathKey = process.env.Path == null ? "PATH" : "Path";
    process.env[processPathKey] = buildPathValueWithDirectory(
      process.env[processPathKey] || "",
      launcherDir,
      ";",
    );
    if (nextUserPath === currentUserPath) {
      return { updated: false, skipped: false, launcherDir };
    }
    if (deps.writeUserPath) {
      deps.writeUserPath(nextUserPath);
    } else {
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          "[Environment]::SetEnvironmentVariable('Path', $args[0], 'User')",
          nextUserPath,
        ],
        { stdio: "ignore" },
      );
    }
    return { updated: true, skipped: false, launcherDir };
  } catch (error) {
    return {
      updated: false,
      skipped: true,
      launcherDir,
      error: error instanceof Error ? error.message : String(error || ""),
    };
  }
}

function writeFileForUser(
  userName: string,
  filePath: string,
  content: string,
  mode: number,
  options: LauncherWriteOptions = {},
) {
  if (!options.elevated) {
    writeTextFile(filePath, content, mode);
    return;
  }
  const target = options.findSystemUser?.(userName) as any;
  const ownerUser = target?.name || userName;
  const ownerGroup = target?.name ? String(target?.gid ?? "") : "";
  writeTextFileWithPrivilege(filePath, content, ownerUser, ownerGroup, mode);
}

function writeLauncherExecutableForUser(
  userName: string,
  filePath: string,
  content: string,
  options: LauncherWriteOptions = {},
) {
  writeFileForUser(userName, filePath, content, 0o755, options);
}

function windowsCmdQuote(value: string) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

export function windowsCmdLauncherScript(
  candidates: string[],
  args: string[] = [],
  options: {
    detached?: boolean;
    missingMessage?: string;
    nodeCommandArgs?: string[];
  } = {},
) {
  const nodeCommand = (
    options.nodeCommandArgs || installedRuntimeNodeCommandArgs("win32")
  )
    .map(windowsCmdQuote)
    .join(" ");
  const fixedArgs = args.map((arg) => ` ${windowsCmdQuote(arg)}`).join("");
  const forwardedArgs = " %*";
  const missingMessage =
    options.missingMessage || "rin: installed runtime entry not found";
  const checks = candidates
    .map((candidate) => {
      const entry = windowsCmdQuote(candidate);
      const command = options.detached
        ? `start "" ${nodeCommand} ${entry}${fixedArgs}${forwardedArgs}\r\n  exit /b 0`
        : `${nodeCommand} ${entry}${fixedArgs}${forwardedArgs}\r\n  exit /b %ERRORLEVEL%`;
      return `if exist ${entry} (\r\n  ${command}\r\n)`;
    })
    .join("\r\n");
  return `@echo off\r\n${checks}\r\necho ${missingMessage}\r\nexit /b 1\r\n`;
}

export function writeLaunchersForUser(
  userName: string,
  installDir: string,
  homeForUser: (user: string) => string,
  options: LauncherWriteOptions = {},
) {
  const home = homeForUser(userName);
  const platform = options.platform || process.platform;
  const targets = launcherTargetsForInstallDir(installDir);
  const nodeCommandArgs = installedRuntimeNodeCommandArgs({
    installDir,
    platform,
  });
  const rinPath =
    platform === "win32"
      ? windowsLauncherPathForHome(home, "rin")
      : launcherPathForHome(home, "rin");
  const rinInstallPath =
    platform === "win32"
      ? windowsLauncherPathForHome(home, "rin-install")
      : launcherPathForHome(home, "rin-install");
  const launcherSpecs =
    platform === "win32"
      ? [
          [
            rinPath,
            windowsCmdLauncherScript(targets.rin, [], { nodeCommandArgs }),
          ],
          [
            rinInstallPath,
            windowsCmdLauncherScript(targets.rinInstall, [], {
              nodeCommandArgs,
            }),
          ],
        ]
      : [
          [rinPath, launcherScript(targets.rin, nodeCommandArgs)],
          [rinInstallPath, launcherScript(targets.rinInstall, nodeCommandArgs)],
        ];
  for (const [filePath, script] of launcherSpecs) {
    writeLauncherExecutableForUser(userName, filePath, script, options);
  }
  const envPath = path.join(defaultInstallDirForHome(home), "env");
  if (platform !== "win32") {
    writeFileForUser(
      userName,
      envPath,
      sourceableRinEnvFile(localBinDirForHome(home)),
      0o644,
      options,
    );
  }
  const windowsPathUpdate =
    platform === "win32" && process.platform === "win32" && !options.elevated
      ? ensureWindowsUserPathIncludes(localBinDirForHome(home))
      : {
          updated: false,
          skipped: true,
          launcherDir: localBinDirForHome(home),
        };
  return {
    rinPath,
    rinInstallPath,
    envPath: platform === "win32" ? undefined : envPath,
    windowsPathUpdate,
  };
}

export function appConfigDirForUser(
  userName: string,
  homeForUser: (user: string) => string,
) {
  return appConfigDirForHome(homeForUser(userName));
}

export function launcherMetadataPathForUser(
  userName: string,
  homeForUser: (user: string) => string,
) {
  return launcherMetadataPathForHome(homeForUser(userName));
}

export function runPrivileged(command: string, args: string[]) {
  const privilegeCommand = pickPrivilegeCommand();
  execFileSync(privilegeCommand, [command, ...args], { stdio: "inherit" });
}

export function commandAsUserInvocation(
  targetUser: string,
  command: string,
  args: string[],
  extraEnv: Record<string, string> = {},
  deps: {
    isRoot?: boolean;
    hasRunuser?: boolean;
    privilegeCommand?: string;
  } = {},
) {
  const shellCommand = [
    ...shellCommandEnv(extraEnv),
    shellCommandArgs([command, ...args]),
  ].join(" ");
  const isRoot =
    deps.isRoot ??
    (typeof process.getuid === "function" ? process.getuid() === 0 : false);
  const hasRunuser = deps.hasRunuser ?? fs.existsSync("/usr/sbin/runuser");

  if (isRoot && hasRunuser) {
    return {
      command: "/usr/sbin/runuser",
      args: ["-u", targetUser, "--", "sh", "-lc", shellCommand],
    };
  }
  const privilegeCommand = deps.privilegeCommand ?? pickPrivilegeCommand();
  if (privilegeCommand.endsWith("doas") || privilegeCommand.endsWith("sudo")) {
    return {
      command: privilegeCommand,
      args: ["-u", targetUser, "sh", "-lc", shellCommand],
    };
  }
  return {
    command: privilegeCommand,
    args: ["sh", "-lc", shellCommand],
  };
}

export function runCommandAsUser(
  targetUser: string,
  command: string,
  args: string[],
  extraEnv: Record<string, string> = {},
) {
  const invocation = commandAsUserInvocation(
    targetUser,
    command,
    args,
    extraEnv,
  );
  execFileSync(invocation.command, invocation.args, { stdio: "inherit" });
}

export function captureCommandAsUser(
  targetUser: string,
  command: string,
  args: string[],
  extraEnv: Record<string, string> = {},
) {
  const invocation = commandAsUserInvocation(
    targetUser,
    command,
    args,
    extraEnv,
  );
  return execFileSync(invocation.command, invocation.args, {
    encoding: "utf8",
  });
}

function ownerGroupValue(ownerGroup?: string | number) {
  return ownerGroup != null && `${ownerGroup}` !== "" ? String(ownerGroup) : "";
}

function ownerSpec(ownerUser?: string, ownerGroup?: string | number) {
  if (!ownerUser) return "";
  const group = ownerGroupValue(ownerGroup);
  return group ? `${ownerUser}:${group}` : ownerUser;
}

function ensurePrivilegedOwnedDir(
  dir: string,
  ownerUser?: string,
  ownerGroup?: string | number,
  mode = "755",
) {
  const args = ["-d", "-m", mode];
  if (ownerUser && process.platform !== "win32") {
    args.push("-o", ownerUser);
    const group = ownerGroupValue(ownerGroup);
    if (group) args.push("-g", group);
  }
  args.push(dir);
  runPrivileged("install", args);
}

export function writeTextFileWithPrivilege(
  filePath: string,
  value: string,
  ownerUser?: string,
  ownerGroup?: string | number,
  mode = 0o600,
) {
  const tempDir = createInstallerTempDir("rin-install-write-");
  const tempFile = path.join(tempDir, "payload");
  try {
    fs.writeFileSync(tempFile, value, "utf8");
    ensurePrivilegedOwnedDir(path.dirname(filePath), ownerUser, ownerGroup);
    runPrivileged("install", [
      "-m",
      String(mode.toString(8)),
      tempFile,
      filePath,
    ]);
    const owner = ownerSpec(ownerUser, ownerGroup);
    if (owner && process.platform !== "win32") {
      runPrivileged("chown", [owner, filePath]);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function writeJsonFileWithPrivilege(
  filePath: string,
  value: unknown,
  ownerUser?: string,
  ownerGroup?: string | number,
) {
  writeTextFileWithPrivilege(
    filePath,
    stringifyJson(value),
    ownerUser,
    ownerGroup,
  );
}

function warnTreeCleanupFailed(treePath: string, error: unknown) {
  const reason =
    error instanceof Error && error.message ? `: ${error.message}` : "";
  process.stderr.write(
    `rin update warning: replaced old tree, but could not remove backup ${treePath}${reason}\n`,
  );
}

function removeTreeOrWarn(treePath: string, warnOnFailure = false) {
  try {
    if (process.platform === "win32") {
      fs.rmSync(treePath, { recursive: true, force: true });
    } else {
      execFileSync("rm", ["-rf", treePath], { stdio: "inherit" });
    }
    return true;
  } catch (error) {
    if (warnOnFailure) warnTreeCleanupFailed(treePath, error);
    return false;
  }
}

function copyTree(sourcePath: string, destPath: string) {
  fs.cpSync(sourcePath, destPath, {
    recursive: true,
    force: true,
    dereference: false,
    verbatimSymlinks: true,
  });
}

export function currentRuntimeLinkTypeForPlatform(
  platform: NodeJS.Platform = process.platform,
) {
  return platform === "win32" ? "junction" : "dir";
}

function replaceCurrentRuntimeLink(currentLink: string, targetRoot: string) {
  const currentTmpLink = `${currentLink}.tmp`;
  try {
    fs.rmSync(currentTmpLink, { recursive: true, force: true });
  } catch {}
  fs.symlinkSync(
    targetRoot,
    currentTmpLink,
    currentRuntimeLinkTypeForPlatform(),
  );
  try {
    fs.rmSync(currentLink, { recursive: true, force: true });
  } catch {}
  fs.renameSync(currentTmpLink, currentLink);
}

export function syncTree(sourcePath: string, destPath: string) {
  const destParent = path.dirname(destPath);
  const baseName = path.basename(destPath);
  const uniqueSuffix = `${process.pid}-${Date.now()}`;
  const tempPath = path.join(destParent, `.${baseName}.sync-${uniqueSuffix}`);
  const backupPath = fs.existsSync(destPath)
    ? path.join(destParent, `.${baseName}.backup-${uniqueSuffix}`)
    : null;

  ensureDir(destParent);
  removeTreeOrWarn(tempPath);
  copyTree(sourcePath, tempPath);
  if (backupPath) fs.renameSync(destPath, backupPath);
  try {
    fs.renameSync(tempPath, destPath);
  } catch (error) {
    removeTreeOrWarn(tempPath);
    if (backupPath && !fs.existsSync(destPath) && fs.existsSync(backupPath)) {
      try {
        fs.renameSync(backupPath, destPath);
      } catch {}
    }
    throw error;
  }
  if (backupPath) removeTreeOrWarn(backupPath, true);
}

export function syncInstalledDocTree(
  sourceDir: string,
  destDir: string,
  targetUser: string,
  elevated = false,
  deps: { findSystemUser: (user: string) => any },
) {
  if (!fs.existsSync(sourceDir)) return null;
  if (elevated) {
    const target = deps.findSystemUser(targetUser) as any;
    const targetGroup = target?.name ? String(target?.gid ?? "") : "";
    ensurePrivilegedOwnedDir(path.dirname(destDir), target?.name, targetGroup);
    runPrivileged("rm", ["-rf", destDir]);
    runPrivileged("cp", ["-a", sourceDir, destDir]);
    const owner = ownerSpec(target?.name, targetGroup);
    if (owner) runPrivileged("chown", ["-R", owner, destDir]);
    return destDir;
  }
  syncTree(sourceDir, destDir);
  return destDir;
}

function listRelativeFiles(root: string, prefix = "") {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        files.push(...listRelativeFiles(fullPath, relativePath));
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  } catch {}
  return files.sort();
}

function collectManagedFilesFromSource(
  files: string[],
  sourceRoot: string,
  installRelativePrefix = "",
) {
  if (!fs.existsSync(sourceRoot)) return files;
  if (fs.statSync(sourceRoot).isFile()) {
    const entry = installRelativePrefix || path.basename(sourceRoot);
    files.push(entry.replace(/\\/g, "/"));
    return files;
  }
  for (const file of listRelativeFiles(sourceRoot)) {
    files.push(
      path.posix.join(installRelativePrefix.replace(/\\/g, "/"), file),
    );
  }
  return files;
}

export function buildInstalledManagedFilesManifest(
  sourceRoot: string,
): ManagedFilesManifest {
  const rinDocFiles: string[] = [];
  collectManagedFilesFromSource(
    rinDocFiles,
    path.join(sourceRoot, "docs", "agent"),
  );
  for (const skillName of INSTALLED_UPSTREAM_BUILTIN_SKILL_NAMES) {
    collectManagedFilesFromSource(
      rinDocFiles,
      path.join(sourceRoot, "upstream", skillName),
      path.posix.join("builtin-skills", skillName),
    );
  }

  const releaseDocFiles = collectManagedFilesFromSource(
    [],
    path.join(sourceRoot, "docs", "release"),
  );

  const piDocFiles: string[] = [];
  const piDocRoot = path.join(sourceRoot, "upstream", "pi");
  for (const name of INSTALLED_PI_DOC_NAMES) {
    collectManagedFilesFromSource(piDocFiles, path.join(piDocRoot, name), name);
  }

  const trees: Record<string, string[]> = {};
  if (rinDocFiles.length)
    trees["docs/rin"] = Array.from(new Set(rinDocFiles)).sort();
  if (releaseDocFiles.length) trees["docs/release"] = releaseDocFiles;
  if (piDocFiles.length)
    trees["docs/pi"] = Array.from(new Set(piDocFiles)).sort();
  return { trees };
}

export function syncInstalledDocs(
  sourceRoot: string,
  installDir: string,
  targetUser: string,
  elevated = false,
  deps: { findSystemUser: (user: string) => any },
) {
  const installedRinDocsDir = syncInstalledDocTree(
    path.join(sourceRoot, "docs", "agent"),
    installedRinDocsRoot(installDir),
    targetUser,
    elevated,
    deps,
  );
  const installedReleaseDocsDir = syncInstalledDocTree(
    path.join(sourceRoot, "docs", "release"),
    path.join(installedDocsRoot(installDir), "release"),
    targetUser,
    elevated,
    deps,
  );
  for (const skillName of INSTALLED_UPSTREAM_BUILTIN_SKILL_NAMES) {
    syncInstalledDocTree(
      path.join(sourceRoot, "upstream", skillName),
      installedBuiltinSkillRoot(installDir, skillName),
      targetUser,
      elevated,
      deps,
    );
  }
  const piDocRoot = path.join(sourceRoot, "upstream", "pi");
  const piInstallRoot = installedPiDocsRoot(installDir);
  const installedPiDocs: string[] = [];
  for (const name of INSTALLED_PI_DOC_NAMES) {
    const synced = syncInstalledDocTree(
      path.join(piDocRoot, name),
      path.join(piInstallRoot, name),
      targetUser,
      elevated,
      deps,
    );
    if (synced) installedPiDocs.push(synced);
  }
  return {
    rin: installedRinDocsDir,
    release: installedReleaseDocsDir,
    pi: installedPiDocs,
  };
}

function sanitizeInstalledReleaseId(value: string) {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._+-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function isPlaceholderPackageVersion(value: string) {
  return !value || value === "0.0.0";
}

function readSourcePackageVersion(sourceRoot: string) {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8"),
    );
    return sanitizeInstalledReleaseId(String(parsed?.version || ""));
  } catch {
    return "";
  }
}

function readSourceGitCommit(sourceRoot: string) {
  try {
    return sanitizeInstalledReleaseId(
      execFileSync(
        "git",
        ["-C", sourceRoot, "rev-parse", "--short=12", "HEAD"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      ),
    );
  } catch {
    return "";
  }
}

export function installedRuntimeReleaseId(
  sourceRoot: string,
  release?: InstalledReleaseInfo,
) {
  const releaseVersion = sanitizeInstalledReleaseId(
    String(release?.version || ""),
  );
  const releaseRef = sanitizeInstalledReleaseId(String(release?.ref || ""));
  const packageVersion = readSourcePackageVersion(sourceRoot);
  const gitCommit = readSourceGitCommit(sourceRoot);

  if (release?.channel === "git") {
    if (/^[0-9a-f]{7,40}$/i.test(releaseVersion))
      return releaseVersion.slice(0, 12);
    if (/^[0-9a-f]{7,40}$/i.test(releaseRef)) return releaseRef.slice(0, 12);
    return gitCommit || releaseRef || releaseVersion || "unknown";
  }

  if (!isPlaceholderPackageVersion(releaseVersion)) return releaseVersion;
  if (!isPlaceholderPackageVersion(packageVersion)) return packageVersion;
  return (
    gitCommit || releaseRef || releaseVersion || packageVersion || "unknown"
  );
}

export function releaseIdNow() {
  return nowFileTimestamp();
}

function managedNodeExecutableInsideNodeRoot(
  nodeRoot: string,
  platform: NodeJS.Platform = process.platform,
) {
  return platform === "win32"
    ? path.join(nodeRoot, "current", "node.exe")
    : path.join(nodeRoot, "current", "bin", "node");
}

function isExecutableFile(filePath: string) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function publishManagedNodeRuntime(
  sourceRoot: string,
  installDir: string,
  targetUser: string,
  elevated = false,
  deps: { findSystemUser: (user: string) => any },
) {
  const sourceNodeRoot = path.join(sourceRoot, "runtime", "node");
  const sourceNodeExecutable =
    managedNodeExecutableInsideNodeRoot(sourceNodeRoot);
  const targetNodeRoot = managedNodeRoot(installDir);
  const targetCurrentRoot = managedNodeCurrentRoot(installDir);
  const targetExecutable = managedNodeExecutablePath(installDir);
  if (elevated && process.platform === "win32") {
    throw new Error("rin_elevated_install_unsupported_on_windows");
  }
  if (isExecutableFile(sourceNodeExecutable)) {
    if (elevated) {
      const target = deps.findSystemUser(targetUser) as any;
      const targetGroup = target?.name ? String(target?.gid ?? "") : "";
      const owner = ownerSpec(target?.name, targetGroup);
      ensurePrivilegedOwnedDir(
        path.dirname(targetNodeRoot),
        target?.name,
        targetGroup,
      );
      runPrivileged("rm", ["-rf", targetNodeRoot]);
      runPrivileged("cp", ["-a", sourceNodeRoot, targetNodeRoot]);
      if (owner) runPrivileged("chown", ["-R", owner, targetNodeRoot]);
    } else {
      syncTree(sourceNodeRoot, targetNodeRoot);
    }
    return {
      nodeRoot: targetNodeRoot,
      nodeExecutable: targetExecutable,
    };
  }

  if (isExecutableFile(targetExecutable)) {
    return {
      nodeRoot: targetNodeRoot,
      nodeExecutable: targetExecutable,
    };
  }

  const currentNodeExecutable = process.execPath;
  if (!currentNodeExecutable || !fs.existsSync(currentNodeExecutable)) {
    return null;
  }
  if (elevated) {
    const target = deps.findSystemUser(targetUser) as any;
    const targetGroup = target?.name ? String(target?.gid ?? "") : "";
    const owner = ownerSpec(target?.name, targetGroup);
    ensurePrivilegedOwnedDir(
      path.dirname(targetNodeRoot),
      target?.name,
      targetGroup,
    );
    runPrivileged("rm", ["-rf", targetCurrentRoot]);
    runPrivileged("mkdir", ["-p", path.dirname(targetExecutable)]);
    runPrivileged("cp", [currentNodeExecutable, targetExecutable]);
    runPrivileged("chmod", ["0755", targetExecutable]);
    if (owner) runPrivileged("chown", ["-R", owner, targetNodeRoot]);
  } else {
    fs.rmSync(targetCurrentRoot, { recursive: true, force: true });
    ensureDir(path.dirname(targetExecutable));
    fs.copyFileSync(currentNodeExecutable, targetExecutable);
    fs.chmodSync(targetExecutable, 0o755);
  }
  return {
    nodeRoot: targetNodeRoot,
    nodeExecutable: targetExecutable,
  };
}

export function publishInstalledRuntime(
  sourceRoot: string,
  installDir: string,
  targetUser: string,
  elevated = false,
  deps: {
    findSystemUser: (user: string) => any;
    release?: InstalledReleaseInfo;
  },
) {
  const releaseRoot = installedReleaseRoot(
    installDir,
    installedRuntimeReleaseId(sourceRoot, deps.release),
  );
  const currentLink = currentRuntimeRoot(installDir);
  const currentTmpLink = `${currentLink}.tmp`;
  if (elevated && process.platform === "win32") {
    throw new Error("rin_elevated_install_unsupported_on_windows");
  }
  if (elevated) {
    const target = deps.findSystemUser(targetUser) as any;
    const targetGroup = target?.name ? String(target?.gid ?? "") : "";
    const owner = ownerSpec(target?.name, targetGroup);
    ensurePrivilegedOwnedDir(
      path.dirname(path.dirname(releaseRoot)),
      target?.name,
      targetGroup,
    );
    ensurePrivilegedOwnedDir(
      path.dirname(releaseRoot),
      target?.name,
      targetGroup,
    );
    ensurePrivilegedOwnedDir(releaseRoot, target?.name, targetGroup);
    for (const name of RUNTIME_COPY_ENTRY_NAMES) {
      const sourcePath = path.join(sourceRoot, name);
      if (!fs.existsSync(sourcePath)) continue;
      runPrivileged("rm", ["-rf", path.join(releaseRoot, name)]);
      runPrivileged("cp", ["-a", sourcePath, path.join(releaseRoot, name)]);
    }
    runPrivileged(process.execPath, [
      "-e",
      `import(${JSON.stringify(new URL("./runtime-dependency-prune.js", import.meta.url).href)}).then((mod)=>mod.pruneDuplicatePiCodingAgentDependencies(process.argv[1]))`,
      releaseRoot,
    ]);
    runPrivileged("touch", [releaseRoot]);
    try {
      runPrivileged("rm", ["-rf", currentTmpLink]);
    } catch {}
    runPrivileged("ln", ["-s", releaseRoot, currentTmpLink]);
    try {
      runPrivileged("rm", ["-rf", currentLink]);
    } catch {}
    runPrivileged("mv", [currentTmpLink, currentLink]);
    if (owner) {
      runPrivileged("chown", ["-R", owner, releaseRoot]);
      try {
        runPrivileged("chown", ["-h", owner, currentLink]);
      } catch {}
    }
    return { releaseRoot, currentLink };
  }
  ensureDir(path.dirname(releaseRoot));
  for (const name of RUNTIME_COPY_ENTRY_NAMES) {
    const sourcePath = path.join(sourceRoot, name);
    if (fs.existsSync(sourcePath)) {
      syncTree(sourcePath, path.join(releaseRoot, name));
    }
  }
  pruneDuplicatePiCodingAgentDependencies(releaseRoot);
  try {
    fs.utimesSync(releaseRoot, new Date(), new Date());
  } catch {}
  replaceCurrentRuntimeLink(currentLink, releaseRoot);
  return { releaseRoot, currentLink };
}

export type InstalledReleaseEntry = {
  name: string;
  path: string;
  mtimeMs: number;
};

export function listInstalledReleaseEntries(
  installDir: string,
  elevated = false,
): InstalledReleaseEntry[] {
  const releasesDir = installedReleasesRoot(installDir);
  if (!elevated) {
    try {
      return fs
        .readdirSync(releasesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
          const releasePath = path.join(releasesDir, entry.name);
          let mtimeMs = 0;
          try {
            mtimeMs = fs.statSync(releasePath).mtimeMs;
          } catch {}
          return { name: entry.name, path: releasePath, mtimeMs };
        });
    } catch {
      return [];
    }
  }
  const privilegeCommand = pickPrivilegeCommand();
  try {
    const raw = execFileSync(
      privilegeCommand,
      [
        process.execPath,
        "-e",
        `const fs=require('node:fs');const path=require('node:path');const dir=process.argv[1];try{const entries=fs.readdirSync(dir,{withFileTypes:true}).filter((entry)=>entry.isDirectory()).map((entry)=>{const releasePath=path.join(dir,entry.name);let mtimeMs=0;try{mtimeMs=fs.statSync(releasePath).mtimeMs}catch{}return {name:entry.name,path:releasePath,mtimeMs};});process.stdout.write(JSON.stringify(entries));}catch{process.stdout.write('[]')}`,
        releasesDir,
      ],
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(String(raw || "[]"));
    return Array.isArray(parsed)
      ? parsed.map((value: any) => ({
          name: String(value?.name || ""),
          path: String(value?.path || ""),
          mtimeMs: Number(value?.mtimeMs || 0),
        }))
      : [];
  } catch {
    return [];
  }
}

function releaseEntrySortNewestFirst(
  a: InstalledReleaseEntry,
  b: InstalledReleaseEntry,
) {
  const byTime = b.mtimeMs - a.mtimeMs;
  if (byTime) return byTime;
  return b.name.localeCompare(a.name);
}

export function listInstalledReleaseNames(
  installDir: string,
  elevated = false,
) {
  return listInstalledReleaseEntries(installDir, elevated).map(
    (entry) => entry.name,
  );
}

export function currentInstalledReleaseName(
  installDir: string,
  elevated = false,
) {
  const currentLink = currentRuntimeRoot(installDir);
  try {
    const target = elevated
      ? execFileSync(
          pickPrivilegeCommand(),
          [
            process.execPath,
            "-e",
            `const fs=require('node:fs');try{process.stdout.write(fs.realpathSync(process.argv[1]))}catch{}`,
            currentLink,
          ],
          { encoding: "utf8" },
        )
      : fs.realpathSync(currentLink);
    const releasesDir = path.resolve(installedReleasesRoot(installDir));
    const normalizedTarget = path.resolve(String(target || ""));
    if (!normalizedTarget.startsWith(`${releasesDir}${path.sep}`)) return "";
    return path.basename(normalizedTarget);
  } catch {
    return "";
  }
}

export function switchInstalledCurrentRelease(
  installDir: string,
  releaseName: string,
  targetUser: string,
  elevated = false,
  deps: { findSystemUser: (user: string) => any },
) {
  const releasesDir = installedReleasesRoot(installDir);
  const targetRoot = path.join(releasesDir, releaseName);
  const currentLink = currentRuntimeRoot(installDir);
  const currentTmpLink = `${currentLink}.tmp`;
  if (!listInstalledReleaseNames(installDir, elevated).includes(releaseName)) {
    throw new Error(`rin_release_not_found:${releaseName}`);
  }
  if (elevated && process.platform === "win32") {
    throw new Error("rin_elevated_install_unsupported_on_windows");
  }
  if (elevated) {
    const target = deps.findSystemUser(targetUser) as any;
    const targetGroup = target?.name ? String(target?.gid ?? "") : "";
    try {
      runPrivileged("rm", ["-rf", currentTmpLink]);
    } catch {}
    runPrivileged("ln", ["-s", targetRoot, currentTmpLink]);
    try {
      runPrivileged("rm", ["-rf", currentLink]);
    } catch {}
    runPrivileged("mv", [currentTmpLink, currentLink]);
    if (target?.name) {
      try {
        runPrivileged("chown", [
          "-h",
          `${target.name}${targetGroup ? `:${targetGroup}` : ""}`,
          currentLink,
        ]);
      } catch {}
    }
    return { releaseRoot: targetRoot, currentLink };
  }
  replaceCurrentRuntimeLink(currentLink, targetRoot);
  return { releaseRoot: targetRoot, currentLink };
}

export function pruneInstalledReleases(
  installDir: string,
  keepCount: number,
  currentReleaseRoot: string,
  elevated = false,
) {
  const currentReleaseName = path.basename(currentReleaseRoot);
  const normalizedKeepCount = Math.max(keepCount, 1);
  const entries = listInstalledReleaseEntries(installDir, elevated).sort(
    releaseEntrySortNewestFirst,
  );
  const keep = new Set<string>();
  if (currentReleaseName) keep.add(currentReleaseName);
  for (const entry of entries) {
    if (keep.size >= normalizedKeepCount) break;
    keep.add(entry.name);
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (keep.has(entry.name)) continue;
    if (elevated) runPrivileged("rm", ["-rf", entry.path]);
    else fs.rmSync(entry.path, { recursive: true, force: true });
    removed.push(entry.path);
  }
  return {
    keepCount: normalizedKeepCount,
    kept: entries
      .filter((entry) => keep.has(entry.name))
      .map((entry) => entry.name),
    removed,
  };
}
