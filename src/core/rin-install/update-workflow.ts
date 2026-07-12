import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";

import { safeString } from "../text-utils.js";
import { shellQuote } from "../rin-lib/system.js";
import {
  buildGitHubRefArchiveUrl,
  platformReleaseAssetUrl,
  selectPlatformReleaseAsset,
  type ResolvedRelease,
} from "../rin-lib/release.js";
import { type InstallerI18n } from "./i18n.js";
import { restoreTerminalCursor, runInstallerProgress } from "./progress.js";
import { readJsonFile } from "../platform/fs.js";
import {
  forwardChildSignals,
  signalExitCode,
} from "../platform/child-signals.js";
import {
  appendDependencyPruneLog,
  pruneDuplicatePiCodingAgentDependencies,
} from "./runtime-dependency-prune.js";

export type UpdateRuntimeSourceWorkspace = {
  tempRoot: string;
  tmpDir: string;
  archivePath: string;
  sourceRoot: string;
  logFile: string;
  releaseFile: string;
};

export function requireTool(name: string, paths: string[] = []) {
  for (const candidate of paths) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  try {
    if (process.platform === "win32") {
      return (
        execFileSync("where", [name], { encoding: "utf8" })
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean) || name
      );
    }
    return (
      execFileSync("sh", ["-lc", `command -v ${shellQuote(name)}`], {
        encoding: "utf8",
      }).trim() || name
    );
  } catch {
    throw new Error(`rin_missing_required_tool:${name}`);
  }
}

async function downloadFile(url: string, outFile: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`rin_download_failed:${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outFile, buffer);
}

export async function runUpdateCommand(
  command: string,
  args: string[],
  options: any = {},
) {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  const forwarding = forwardChildSignals(child, {
    beforeForward: restoreTerminalCursor,
  });

  try {
    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    if (forwarding.forwardedSignal) {
      process.exit(signalExitCode(forwarding.forwardedSignal));
    }
    if (result.signal) process.exit(signalExitCode(result.signal));
    if (result.code && result.code !== 0) {
      const error: any = new Error(`rin_update_command_failed:${result.code}`);
      error.status = result.code;
      throw error;
    }
  } finally {
    forwarding.cleanup();
    restoreTerminalCursor();
  }
}

export async function runLoggedUpdateCommandSync(
  command: string,
  args: string[],
  label: string,
  logFile: string,
  options: any = {},
  buildFailureHeader: (label: string) => string = (value) =>
    `${value} failed; recent log:`,
) {
  if (!process.stderr.isTTY) {
    await runUpdateCommand(command, args, options);
    return;
  }

  const fd = fs.openSync(logFile, "a");
  try {
    fs.writeSync(fd, `\n$ ${[command, ...args].join(" ")}\n`);
    await runUpdateCommand(command, args, {
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
    restoreTerminalCursor();
  }
}

export function resolveGitCommitForRelease(
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
        archiveUrl: buildGitHubRefArchiveUrl(repoUrl, hash),
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

export function disablePackageRootPrepareScript(sourceRoot: string) {
  const packageJsonPath = path.join(sourceRoot, "package.json");
  const parsed = readJsonFile<any>(packageJsonPath, null);
  if (!parsed?.scripts?.prepare) return;
  delete parsed.scripts.prepare;
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(parsed, null, 2)}\n`);
}

function archivePathForUrl(tempRoot: string, url: string) {
  return /\.zip(?:[?#].*)?$/i.test(url)
    ? path.join(tempRoot, "rin.zip")
    : path.join(tempRoot, "rin.tar.gz");
}

function verifyArchiveSha256(filePath: string, expected?: string) {
  const normalizedExpected = safeString(expected).trim().toLowerCase();
  if (!normalizedExpected) {
    throw new Error("rin_update_platform_bundle_checksum_missing");
  }
  const actual = createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
  if (actual !== normalizedExpected) {
    throw new Error("rin_update_platform_bundle_checksum_mismatch");
  }
}

async function extractZipArchive(options: {
  archivePath: string;
  sourceRoot: string;
  workspace: UpdateRuntimeSourceWorkspace;
  i18n: InstallerI18n;
}) {
  const unzip = requireTool("unzip", ["/usr/bin/unzip", "/bin/unzip"]);
  const zipRoot = path.join(options.workspace.tempRoot, "zip-extract");
  fs.rmSync(zipRoot, { recursive: true, force: true });
  fs.mkdirSync(zipRoot, { recursive: true });
  await runLoggedUpdateCommandSync(
    unzip,
    ["-q", options.archivePath, "-d", zipRoot],
    options.i18n.preparingUpdateSourceMessage,
    options.workspace.logFile,
    {},
    options.i18n.buildUpdateCommandFailureHeader,
  );
  const children = fs.readdirSync(zipRoot);
  const copyRoot =
    children.length === 1 &&
    fs.statSync(path.join(zipRoot, children[0] || "")).isDirectory()
      ? path.join(zipRoot, children[0] || "")
      : zipRoot;
  fs.cpSync(copyRoot, options.sourceRoot, {
    recursive: true,
    force: true,
    dereference: false,
    verbatimSymlinks: true,
  });
}

async function extractUpdateArchive(options: {
  archivePath: string;
  sourceRoot: string;
  workspace: UpdateRuntimeSourceWorkspace;
  i18n: InstallerI18n;
}) {
  if (/\.zip$/i.test(options.archivePath)) {
    await extractZipArchive(options);
    return;
  }
  const tar = requireTool("tar", ["/usr/bin/tar", "/bin/tar"]);
  await runLoggedUpdateCommandSync(
    tar,
    [
      "-xzf",
      options.archivePath,
      "-C",
      options.sourceRoot,
      "--strip-components=1",
    ],
    options.i18n.preparingUpdateSourceMessage,
    options.workspace.logFile,
    {},
    options.i18n.buildUpdateCommandFailureHeader,
  );
}

function isExecutableFile(filePath: string) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findPreparedRuntimeNodeExecutable(sourceRoot: string) {
  for (const candidate of [
    path.join(sourceRoot, "runtime", "node", "current", "bin", "node"),
    path.join(sourceRoot, "runtime", "node", "current", "node.exe"),
  ]) {
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function preparedRuntimeNodeExecutablePath(sourceRoot: string) {
  return process.platform === "win32"
    ? path.join(sourceRoot, "runtime", "node", "current", "node.exe")
    : path.join(sourceRoot, "runtime", "node", "current", "bin", "node");
}

export function preparedRuntimeNodeExecutable(sourceRoot: string) {
  const executable = findPreparedRuntimeNodeExecutable(sourceRoot);
  if (executable) return executable;
  throw new Error(
    `rin_managed_node_runtime_missing:${preparedRuntimeNodeExecutablePath(sourceRoot)}`,
  );
}

export function provisionPreparedCurrentNodeRuntime(sourceRoot: string) {
  const existing = findPreparedRuntimeNodeExecutable(sourceRoot);
  if (existing) return existing;
  const targetExecutable = preparedRuntimeNodeExecutablePath(sourceRoot);
  if (!process.execPath || !fs.existsSync(process.execPath)) {
    throw new Error(`rin_managed_node_runtime_missing:${targetExecutable}`);
  }
  fs.mkdirSync(path.dirname(targetExecutable), { recursive: true });
  fs.copyFileSync(process.execPath, targetExecutable);
  try {
    fs.chmodSync(targetExecutable, 0o755);
  } catch {}
  return targetExecutable;
}

export function isInstalledReleaseCurrent(
  installedRelease: any,
  resolvedRelease: ResolvedRelease,
) {
  const installedChannel = safeString(installedRelease?.channel).trim();
  const resolvedChannel = safeString(resolvedRelease.channel).trim();
  if (!installedChannel || installedChannel !== resolvedChannel) return false;

  const installedVersion = safeString(installedRelease?.version).trim();
  const resolvedVersion = safeString(resolvedRelease.version).trim();
  const installedRef = safeString(installedRelease?.ref).trim();
  const resolvedRef = safeString(resolvedRelease.ref).trim();

  if (resolvedChannel === "stable") {
    return Boolean(installedVersion && installedVersion === resolvedVersion);
  }
  if (resolvedChannel === "git") {
    return Boolean(installedRef && installedRef === resolvedRef);
  }
  return Boolean(
    installedVersion &&
    installedVersion === resolvedVersion &&
    (!resolvedRef || !installedRef || installedRef === resolvedRef),
  );
}

export function createUpdateRuntimeSourceWorkspace(
  release: ResolvedRelease,
  workRoot = updateWorkRoot(),
): UpdateRuntimeSourceWorkspace {
  cleanupStaleUpdateWorkDirs(workRoot);
  const tempRoot = fs.mkdtempSync(path.join(workRoot, "work-"));
  try {
    const workspace = {
      tempRoot,
      tmpDir: path.join(tempRoot, "tmp"),
      archivePath: path.join(tempRoot, "rin.tar.gz"),
      sourceRoot: path.join(tempRoot, "src"),
      logFile: path.join(tempRoot, "update.log"),
      releaseFile: path.join(tempRoot, "release.json"),
    };
    fs.mkdirSync(workspace.sourceRoot, { recursive: true });
    fs.mkdirSync(workspace.tmpDir, { recursive: true });
    fs.writeFileSync(workspace.logFile, "", "utf8");
    fs.writeFileSync(workspace.releaseFile, `${JSON.stringify(release)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return workspace;
  } catch (error) {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {}
    throw error;
  }
}

export async function prepareUpdateRuntimeSource(options: {
  release: ResolvedRelease;
  workspace: UpdateRuntimeSourceWorkspace;
  i18n: InstallerI18n;
  env?: NodeJS.ProcessEnv;
}) {
  const { release, workspace, i18n } = options;
  const curl = fs.existsSync("/usr/bin/curl") ? "/usr/bin/curl" : "";
  const wget = fs.existsSync("/usr/bin/wget") ? "/usr/bin/wget" : "";
  const platformAsset = selectPlatformReleaseAsset(release);
  const platformAssetUrl = platformReleaseAssetUrl(platformAsset);
  const buildEnv = {
    ...(options.env || process.env),
    TMPDIR: workspace.tmpDir,
    TEMP: workspace.tmpDir,
    TMP: workspace.tmpDir,
  };

  const downloadUpdateArchive = async (url: string, archivePath: string) => {
    if (curl) {
      await runLoggedUpdateCommandSync(
        curl,
        ["-fsSL", url, "-o", archivePath],
        i18n.fetchingUpdateSourceMessage,
        workspace.logFile,
        {},
        i18n.buildUpdateCommandFailureHeader,
      );
    } else if (wget) {
      await runLoggedUpdateCommandSync(
        wget,
        ["-qO", archivePath, url],
        i18n.fetchingUpdateSourceMessage,
        workspace.logFile,
        {},
        i18n.buildUpdateCommandFailureHeader,
      );
    } else {
      await downloadFile(url, archivePath);
    }
  };

  if (platformAssetUrl) {
    workspace.archivePath = archivePathForUrl(
      workspace.tempRoot,
      platformAssetUrl,
    );
    await runInstallerProgress(i18n.fetchingUpdateSourceMessage, async () => {
      await downloadUpdateArchive(platformAssetUrl, workspace.archivePath);
      verifyArchiveSha256(workspace.archivePath, platformAsset?.sha256);
    });
    await runInstallerProgress(i18n.preparingUpdateSourceMessage, () =>
      extractUpdateArchive({
        archivePath: workspace.archivePath,
        sourceRoot: workspace.sourceRoot,
        workspace,
        i18n,
      }),
    );
    return workspace;
  }

  await runInstallerProgress(i18n.fetchingUpdateSourceMessage, () =>
    downloadUpdateArchive(release.archiveUrl, workspace.archivePath),
  );
  await runInstallerProgress(i18n.preparingUpdateSourceMessage, () =>
    extractUpdateArchive({
      archivePath: workspace.archivePath,
      sourceRoot: workspace.sourceRoot,
      workspace,
      i18n,
    }),
  );

  const npm = requireTool("npm", ["/usr/bin/npm", "/bin/npm"]);
  await runInstallerProgress(
    i18n.installingUpdateDependenciesMessage,
    async () => {
      if (release.channel === "stable") {
        disablePackageRootPrepareScript(workspace.sourceRoot);
        await runLoggedUpdateCommandSync(
          npm,
          [
            "install",
            "--omit=dev",
            "--no-fund",
            "--no-audit",
            "--loglevel=error",
          ],
          i18n.installingUpdateDependenciesMessage,
          workspace.logFile,
          { cwd: workspace.sourceRoot, env: buildEnv },
          i18n.buildUpdateCommandFailureHeader,
        );
      } else if (
        fs.existsSync(path.join(workspace.sourceRoot, "package-lock.json"))
      ) {
        await runLoggedUpdateCommandSync(
          npm,
          ["ci", "--no-fund", "--no-audit", "--loglevel=error"],
          i18n.installingUpdateDependenciesMessage,
          workspace.logFile,
          { cwd: workspace.sourceRoot, env: buildEnv },
          i18n.buildUpdateCommandFailureHeader,
        );
      } else {
        await runLoggedUpdateCommandSync(
          npm,
          ["install", "--no-fund", "--no-audit", "--loglevel=error"],
          i18n.installingUpdateDependenciesMessage,
          workspace.logFile,
          { cwd: workspace.sourceRoot, env: buildEnv },
          i18n.buildUpdateCommandFailureHeader,
        );
      }
    },
  );
  if (release.channel !== "stable") {
    await runInstallerProgress(i18n.buildingUpdateRuntimeMessage, () =>
      runLoggedUpdateCommandSync(
        npm,
        ["run", "build", "--silent"],
        i18n.buildingUpdateRuntimeMessage,
        workspace.logFile,
        { cwd: workspace.sourceRoot, env: buildEnv },
        i18n.buildUpdateCommandFailureHeader,
      ),
    );
    await runInstallerProgress(i18n.pruningUpdateDependenciesMessage, () =>
      runLoggedUpdateCommandSync(
        npm,
        ["prune", "--omit=dev", "--no-fund", "--no-audit", "--loglevel=error"],
        i18n.pruningUpdateDependenciesMessage,
        workspace.logFile,
        { cwd: workspace.sourceRoot, env: buildEnv },
        i18n.buildUpdateCommandFailureHeader,
      ),
    );
  }

  appendDependencyPruneLog(
    workspace.logFile,
    pruneDuplicatePiCodingAgentDependencies(workspace.sourceRoot),
  );
  provisionPreparedCurrentNodeRuntime(workspace.sourceRoot);

  return workspace;
}
