import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  ensureDir,
  preferredTempRootCandidates,
  readJsonFile,
  stringifyJson,
  writeJsonFile,
} from "../platform/fs.js";
import { pickPrivilegeCommand, shellQuote } from "../rin-lib/system.js";
import {
  appConfigDirForHome,
  currentRuntimeRoot,
  installedAppEntryCandidates,
  installedBuiltinSkillRoot,
  installedDocsRoot,
  installedPiDocsRoot,
  installedReleaseRoot,
  installedReleasesRoot,
  installedRinDocsRoot,
  launcherMetadataPathForHome,
  launcherPathForHome,
  windowsGuiDesktopLauncherPathForHome,
  windowsGuiStartMenuLauncherPathForHome,
} from "./paths.js";

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

const RUNTIME_COPY_ENTRY_NAMES = [
  "dist",
  "node_modules",
  "package.json",
] as const;

export function installedRuntimePathValue() {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const dir of [
    ...String(process.env.PATH || "").split(path.delimiter),
    ...COMMON_RUNTIME_BIN_DIRS,
  ]) {
    const next = String(dir || "").trim();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    dirs.push(next);
  }
  return dirs.join(path.delimiter);
}

export function installedRuntimeNodeCommandArgs() {
  return [fs.existsSync("/usr/bin/env") ? "/usr/bin/env" : "env", "node"];
}

export function launcherScript(candidates: string[]) {
  const runtimePath = installedRuntimePathValue();
  const nodeCommand = installedRuntimeNodeCommandArgs()
    .map((entry) => shellQuote(entry))
    .join(" ");
  const checks = candidates
    .map(
      (candidate) =>
        `if [ -f ${shellQuote(candidate)} ]; then exec ${nodeCommand} ${shellQuote(candidate)} "$@"; fi`,
    )
    .join("\n");
  return `#!/usr/bin/env sh\nPATH=${shellQuote(runtimePath)}\nexport PATH\n${checks}\necho "rin: installed runtime entry not found" >&2\nexit 1\n`;
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
    rinGui: installedAppEntryCandidates(installDir, "rin-gui"),
  };
}

export type LauncherWriteOptions = {
  elevated?: boolean;
  findSystemUser?: (user: string) => any;
  platform?: NodeJS.Platform;
};

function writeLauncherExecutableForUser(
  userName: string,
  filePath: string,
  content: string,
  options: LauncherWriteOptions = {},
) {
  if (!options.elevated) {
    writeExecutable(filePath, content);
    return;
  }
  const target = options.findSystemUser?.(userName) as any;
  const ownerUser = target?.name || userName;
  const ownerGroup = target?.name ? String(target?.gid ?? "") : "";
  writeTextFileWithPrivilege(filePath, content, ownerUser, ownerGroup, 0o755);
}

export function windowsCmdLauncherScript(
  candidates: string[],
  args: string[] = [],
) {
  const nodeCommand = installedRuntimeNodeCommandArgs().join(" ");
  const forwardedArgs = args.map((arg) => ` ${arg}`).join("");
  const checks = candidates
    .map(
      (candidate) =>
        `if exist "${String(candidate).replace(/"/g, '""')}" start "" "${nodeCommand}" "${String(candidate).replace(/"/g, '""')}"${forwardedArgs}`,
    )
    .join("\r\n");
  return `@echo off\r\n${checks}\r\necho rin: installed GUI entry not found\r\nexit /b 1\r\n`;
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
  const rinPath = launcherPathForHome(home, "rin");
  const rinInstallPath = launcherPathForHome(home, "rin-install");
  const rinGuiPath = launcherPathForHome(home, "rin-gui");
  writeLauncherExecutableForUser(
    userName,
    rinPath,
    launcherScript(targets.rin),
    options,
  );
  writeLauncherExecutableForUser(
    userName,
    rinInstallPath,
    launcherScript(targets.rinInstall),
    options,
  );
  writeLauncherExecutableForUser(
    userName,
    rinGuiPath,
    launcherScript(targets.rinGui),
    options,
  );
  const windowsGuiShortcutPaths: string[] = [];
  if (platform === "win32") {
    const script = windowsCmdLauncherScript(targets.rinGui);
    for (const filePath of [
      windowsGuiStartMenuLauncherPathForHome(home),
      windowsGuiDesktopLauncherPathForHome(home),
    ]) {
      writeLauncherExecutableForUser(userName, filePath, script, options);
      windowsGuiShortcutPaths.push(filePath);
    }
  }
  return { rinPath, rinInstallPath, rinGuiPath, windowsGuiShortcutPaths };
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
    runPrivileged("mkdir", ["-p", path.dirname(filePath)]);
    runPrivileged("install", [
      "-m",
      String(mode.toString(8)),
      tempFile,
      filePath,
    ]);
    if (ownerUser && process.platform !== "win32") {
      const owner =
        ownerGroup != null && `${ownerGroup}` !== ""
          ? `${ownerUser}:${ownerGroup}`
          : ownerUser;
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

export function syncTree(sourcePath: string, destPath: string) {
  const destParent = path.dirname(destPath);
  const baseName = path.basename(destPath);
  const uniqueSuffix = `${process.pid}-${Date.now()}`;
  const tempPath = path.join(destParent, `.${baseName}.sync-${uniqueSuffix}`);
  const backupPath = fs.existsSync(destPath)
    ? path.join(destParent, `.${baseName}.backup-${uniqueSuffix}`)
    : null;

  ensureDir(destParent);
  try {
    execFileSync("rm", ["-rf", tempPath], { stdio: "inherit" });
  } catch {}
  execFileSync("cp", ["-a", sourcePath, tempPath], { stdio: "inherit" });
  if (backupPath) fs.renameSync(destPath, backupPath);
  try {
    fs.renameSync(tempPath, destPath);
  } catch (error) {
    try {
      execFileSync("rm", ["-rf", tempPath], { stdio: "inherit" });
    } catch {}
    if (backupPath && !fs.existsSync(destPath) && fs.existsSync(backupPath)) {
      try {
        fs.renameSync(backupPath, destPath);
      } catch {}
    }
    throw error;
  }
  if (backupPath) {
    try {
      execFileSync("rm", ["-rf", backupPath], { stdio: "inherit" });
    } catch {}
  }
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
    runPrivileged("rm", ["-rf", destDir]);
    runPrivileged("mkdir", ["-p", path.dirname(destDir)]);
    runPrivileged("cp", ["-a", sourceDir, destDir]);
    if (target?.name)
      runPrivileged("chown", [
        "-R",
        `${target.name}${targetGroup ? `:${targetGroup}` : ""}`,
        destDir,
      ]);
    return destDir;
  }
  syncTree(sourceDir, destDir);
  return destDir;
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
  syncInstalledDocTree(
    path.join(sourceRoot, "upstream", "skill-creator"),
    installedBuiltinSkillRoot(installDir, "skill-creator"),
    targetUser,
    elevated,
    deps,
  );
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

export function releaseIdNow() {
  return new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");
}

export function publishInstalledRuntime(
  sourceRoot: string,
  installDir: string,
  targetUser: string,
  elevated = false,
  deps: { findSystemUser: (user: string) => any },
) {
  const releaseRoot = installedReleaseRoot(installDir, releaseIdNow());
  const currentLink = currentRuntimeRoot(installDir);
  const currentTmpLink = `${currentLink}.tmp`;
  if (elevated) {
    const target = deps.findSystemUser(targetUser) as any;
    const targetGroup = target?.name ? String(target?.gid ?? "") : "";
    runPrivileged("mkdir", ["-p", releaseRoot]);
    for (const name of RUNTIME_COPY_ENTRY_NAMES) {
      runPrivileged("rm", ["-rf", path.join(releaseRoot, name)]);
      runPrivileged("cp", [
        "-a",
        path.join(sourceRoot, name),
        path.join(releaseRoot, name),
      ]);
    }
    try {
      runPrivileged("rm", ["-rf", currentTmpLink]);
    } catch {}
    runPrivileged("ln", ["-s", releaseRoot, currentTmpLink]);
    try {
      runPrivileged("rm", ["-rf", currentLink]);
    } catch {}
    runPrivileged("mv", [currentTmpLink, currentLink]);
    if (target?.name) {
      runPrivileged("chown", [
        "-R",
        `${target.name}${targetGroup ? `:${targetGroup}` : ""}`,
        releaseRoot,
      ]);
      try {
        runPrivileged("chown", [
          "-h",
          `${target.name}${targetGroup ? `:${targetGroup}` : ""}`,
          currentLink,
        ]);
      } catch {}
    }
    return { releaseRoot, currentLink };
  }
  ensureDir(path.dirname(releaseRoot));
  for (const name of RUNTIME_COPY_ENTRY_NAMES)
    syncTree(path.join(sourceRoot, name), path.join(releaseRoot, name));
  try {
    fs.rmSync(currentTmpLink, { recursive: true, force: true });
  } catch {}
  fs.symlinkSync(releaseRoot, currentTmpLink);
  try {
    fs.rmSync(currentLink, { recursive: true, force: true });
  } catch {}
  fs.renameSync(currentTmpLink, currentLink);
  return { releaseRoot, currentLink };
}

export function listInstalledReleaseNames(
  installDir: string,
  elevated = false,
) {
  const releasesDir = installedReleasesRoot(installDir);
  if (!elevated) {
    try {
      return fs
        .readdirSync(releasesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [] as string[];
    }
  }
  const privilegeCommand = pickPrivilegeCommand();
  try {
    const raw = execFileSync(
      privilegeCommand,
      [
        process.execPath,
        "-e",
        `const fs=require('node:fs');const dir=process.argv[1];try{const names=fs.readdirSync(dir,{withFileTypes:true}).filter((entry)=>entry.isDirectory()).map((entry)=>entry.name);process.stdout.write(JSON.stringify(names));}catch{process.stdout.write('[]')}`,
        releasesDir,
      ],
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(String(raw || "[]"));
    return Array.isArray(parsed) ? parsed.map((value) => String(value)) : [];
  } catch {
    return [] as string[];
  }
}

export function pruneInstalledReleases(
  installDir: string,
  keepCount: number,
  currentReleaseRoot: string,
  elevated = false,
) {
  const releasesDir = installedReleasesRoot(installDir);
  const currentReleaseName = path.basename(currentReleaseRoot);
  const names = listInstalledReleaseNames(installDir, elevated).sort((a, b) =>
    b.localeCompare(a),
  );
  const keep = new Set(names.slice(0, Math.max(keepCount, 1)));
  keep.add(currentReleaseName);
  const removed: string[] = [];
  for (const name of names) {
    if (keep.has(name)) continue;
    const releasePath = path.join(releasesDir, name);
    if (elevated) runPrivileged("rm", ["-rf", releasePath]);
    else fs.rmSync(releasePath, { recursive: true, force: true });
    removed.push(releasePath);
  }
  return {
    keepCount: Math.max(keepCount, 1),
    kept: [...keep].sort((a, b) => b.localeCompare(a)),
    removed,
  };
}
