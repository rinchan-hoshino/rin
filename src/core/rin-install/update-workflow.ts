import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";

import {
  createRinHttpTransport,
  discardRinHttpResponseBody,
} from "../http/transport.js";
import { requestProcessTermination } from "../platform/process-lifetime.js";
import { safeString } from "../text-utils.js";
import { shellQuote } from "../rin-lib/system.js";
import {
  buildGitHubRefArchiveUrl,
  platformReleaseAssetUrl,
  requireConcreteGitRelease,
  selectPlatformReleaseAsset,
  type ResolvedRelease,
} from "../rin-lib/release.js";
import { type InstallerI18n } from "./i18n.js";
import { restoreTerminalCursor, runInstallerProgress } from "./progress.js";
import { readJsonFileOrDefault } from "../platform/fs.js";
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
  const transport = createRinHttpTransport();
  try {
    const response = await transport.fetch(url);
    try {
      if (!response.ok) {
        throw new Error(`rin_download_failed:${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(outFile, buffer);
    } finally {
      await discardRinHttpResponseBody(response);
    }
  } finally {
    await transport.close();
  }
}

const FORWARDED_UPDATE_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const MANAGED_NPM_VERSION = "10.9.3";
const MANAGED_NPM_SHA512 =
  "e84875bb943e908557780f1eee5d9cfc7a67145730ae4b77ef10ccba30f96ded6096859af69ea3dc5b2fde60725d79aa247cbed9c12544c30bf28a4d4fbc4825";

function signalExitCode(signal: NodeJS.Signals) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  if (signal === "SIGHUP") return 129;
  return 1;
}

export async function runUpdateCommand(
  command: string,
  args: string[],
  options: any = {},
) {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  let forwardedSignal: NodeJS.Signals | null = null;
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of FORWARDED_UPDATE_SIGNALS) {
    const handler = () => {
      forwardedSignal = signal;
      restoreTerminalCursor();
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
    if (forwardedSignal) {
      requestProcessTermination(signalExitCode(forwardedSignal));
    }
    if (result.signal) {
      requestProcessTermination(signalExitCode(result.signal));
    }
    if (result.code && result.code !== 0) {
      const error: any = new Error(`rin_update_command_failed:${result.code}`);
      error.status = result.code;
      throw error;
    }
  } finally {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
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
  deps: {
    readRemoteRefs?: (repoUrl: string, selector: string) => string;
  } = {},
): ResolvedRelease {
  if (release.channel !== "git") return release;
  const selector = release.ref || release.version || release.branch || "HEAD";
  if (/^[0-9a-f]{7,40}$/i.test(selector)) {
    return requireConcreteGitRelease(release);
  }

  let raw = "";
  try {
    if (deps.readRemoteRefs) {
      raw = deps.readRemoteRefs(repoUrl, selector).trim();
    } else {
      const git = requireTool("git", ["/usr/bin/git", "/bin/git"]);
      raw = execFileSync(git, ["ls-remote", repoUrl, selector], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    }
  } catch (cause) {
    throw new Error(`rin_git_ref_not_resolved:${selector}`, { cause });
  }

  const records = raw.split(/\r?\n/).map((line) => {
    const match = /^([0-9a-f]{40})\t(\S+)$/i.exec(line);
    return match ? { hash: match[1]!, ref: match[2]! } : null;
  });
  const matchingRecords = records.filter(
    (record) =>
      record &&
      (selector === "HEAD"
        ? record.ref === "HEAD"
        : selector.startsWith("refs/")
          ? record.ref === selector
          : record.ref === `refs/heads/${selector}` ||
            record.ref === `refs/tags/${selector}`),
  );
  if (
    records.length !== 1 ||
    records.some((record) => !record) ||
    matchingRecords.length !== 1
  ) {
    throw new Error(`rin_git_ref_not_resolved:${selector}`);
  }
  const hash = matchingRecords[0]!.hash;
  const shortHash = hash.slice(0, 12);
  return {
    ...release,
    archiveUrl: buildGitHubRefArchiveUrl(repoUrl, hash),
    version: shortHash,
    ref: hash,
    sourceLabel: `${release.sourceLabel} @ ${shortHash}`,
  };
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
  const parsed = readJsonFileOrDefault<any>(packageJsonPath, null);
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

function preparedRuntimeNodeCurrentRoot(sourceRoot: string) {
  return path.join(sourceRoot, "runtime", "node", "current");
}

function findPreparedRuntimeNodeExecutable(sourceRoot: string) {
  for (const candidate of [
    path.join(preparedRuntimeNodeCurrentRoot(sourceRoot), "bin", "node"),
    path.join(preparedRuntimeNodeCurrentRoot(sourceRoot), "node.exe"),
  ]) {
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function preparedRuntimeNodeExecutablePath(sourceRoot: string) {
  return process.platform === "win32"
    ? path.join(preparedRuntimeNodeCurrentRoot(sourceRoot), "node.exe")
    : path.join(preparedRuntimeNodeCurrentRoot(sourceRoot), "bin", "node");
}

function preparedRuntimeNpmCliPath(sourceRoot: string) {
  return process.platform === "win32"
    ? path.join(
        preparedRuntimeNodeCurrentRoot(sourceRoot),
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      )
    : path.join(
        preparedRuntimeNodeCurrentRoot(sourceRoot),
        "lib",
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      );
}

function processNpmPackageRoot() {
  const nodeRoot =
    process.platform === "win32"
      ? path.dirname(process.execPath)
      : path.dirname(path.dirname(process.execPath));
  return process.platform === "win32"
    ? path.join(nodeRoot, "node_modules", "npm")
    : path.join(nodeRoot, "lib", "node_modules", "npm");
}

function managedNpmArchivePath() {
  const cacheRoot =
    safeString(process.env.XDG_CACHE_HOME).trim() ||
    path.join(os.homedir(), ".cache");
  return path.join(
    cacheRoot,
    "rin",
    "node-toolchain",
    `npm-${MANAGED_NPM_VERSION}.tgz`,
  );
}

function verifyManagedNpmArchive(archivePath: string) {
  const actual = createHash("sha512")
    .update(fs.readFileSync(archivePath))
    .digest("hex");
  if (actual !== MANAGED_NPM_SHA512) {
    throw new Error("rin_managed_npm_checksum_mismatch");
  }
}

function downloadManagedNpmPackage(targetNpmPackageRoot: string) {
  const archivePath = managedNpmArchivePath();
  if (fs.existsSync(archivePath)) {
    try {
      verifyManagedNpmArchive(archivePath);
    } catch {
      fs.rmSync(archivePath, { force: true });
    }
  }
  if (!fs.existsSync(archivePath)) {
    const curl = requireTool("curl", ["/usr/bin/curl", "/bin/curl"]);
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    const temporaryArchive = `${archivePath}.${process.pid}.tmp`;
    try {
      execFileSync(
        curl,
        [
          "-fsSL",
          `https://registry.npmjs.org/npm/-/npm-${MANAGED_NPM_VERSION}.tgz`,
          "-o",
          temporaryArchive,
        ],
        { stdio: "ignore" },
      );
      verifyManagedNpmArchive(temporaryArchive);
      try {
        fs.renameSync(temporaryArchive, archivePath);
      } catch {
        if (!fs.existsSync(archivePath))
          throw new Error("rin_managed_npm_cache_write_failed");
      }
    } finally {
      fs.rmSync(temporaryArchive, { force: true });
    }
  }
  verifyManagedNpmArchive(archivePath);
  const targetParent = path.dirname(targetNpmPackageRoot);
  fs.mkdirSync(targetParent, { recursive: true });
  const extractRoot = fs.mkdtempSync(
    path.join(targetParent, ".rin-managed-npm-"),
  );
  try {
    const tar = requireTool("tar", ["/usr/bin/tar", "/bin/tar"]);
    execFileSync(tar, ["-xzf", archivePath, "-C", extractRoot], {
      stdio: "ignore",
    });
    fs.cpSync(path.join(extractRoot, "package"), targetNpmPackageRoot, {
      recursive: true,
      force: true,
      dereference: true,
      verbatimSymlinks: false,
    });
  } finally {
    fs.rmSync(extractRoot, { recursive: true, force: true });
  }
}

function writePreparedNpmLaunchers(sourceRoot: string) {
  const currentRoot = preparedRuntimeNodeCurrentRoot(sourceRoot);
  if (process.platform === "win32") {
    for (const [name, cli] of [
      ["npm", "npm-cli.js"],
      ["npx", "npx-cli.js"],
    ] as const) {
      fs.writeFileSync(
        path.join(currentRoot, `${name}.cmd`),
        `@ECHO off\r\n"%~dp0\\node.exe" "%~dp0\\node_modules\\npm\\bin\\${cli}" %*\r\n`,
      );
    }
    return;
  }
  const binDir = path.join(currentRoot, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  for (const [name, target] of [
    ["npm", "../lib/node_modules/npm/bin/npm-cli.js"],
    ["npx", "../lib/node_modules/npm/bin/npx-cli.js"],
  ] as const) {
    const launcher = path.join(binDir, name);
    fs.rmSync(launcher, { force: true });
    fs.symlinkSync(target, launcher);
  }
}

export function preparedRuntimeNodeExecutable(sourceRoot: string) {
  const executable = findPreparedRuntimeNodeExecutable(sourceRoot);
  if (executable) return executable;
  throw new Error(
    `rin_managed_node_runtime_missing:${preparedRuntimeNodeExecutablePath(sourceRoot)}`,
  );
}

function verifyPreparedManagedNpm(sourceRoot: string) {
  const nodeExecutable = preparedRuntimeNodeExecutable(sourceRoot);
  const npmCli = preparedRuntimeNpmCliPath(sourceRoot);
  if (!fs.existsSync(npmCli)) return false;
  try {
    execFileSync(nodeExecutable, [npmCli, "--version"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: path.dirname(nodeExecutable),
        NODE_PATH: "",
        npm_node_execpath: nodeExecutable,
        npm_execpath: npmCli,
      },
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

export function provisionPreparedCurrentNodeRuntime(sourceRoot: string) {
  const targetExecutable = preparedRuntimeNodeExecutablePath(sourceRoot);
  const targetNpmCli = preparedRuntimeNpmCliPath(sourceRoot);
  let copiedProcessNode = false;
  if (!findPreparedRuntimeNodeExecutable(sourceRoot)) {
    if (!process.execPath || !fs.existsSync(process.execPath)) {
      throw new Error(`rin_managed_node_runtime_missing:${targetExecutable}`);
    }
    fs.mkdirSync(path.dirname(targetExecutable), { recursive: true });
    fs.copyFileSync(process.execPath, targetExecutable);
    copiedProcessNode = true;
    try {
      fs.chmodSync(targetExecutable, 0o755);
    } catch {}
  }
  if (!verifyPreparedManagedNpm(sourceRoot)) {
    const targetNpmPackageRoot = path.dirname(path.dirname(targetNpmCli));
    fs.rmSync(targetNpmPackageRoot, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(targetNpmPackageRoot), { recursive: true });
    const localNpmPackageRoot = processNpmPackageRoot();
    if (copiedProcessNode && fs.existsSync(localNpmPackageRoot)) {
      fs.cpSync(localNpmPackageRoot, targetNpmPackageRoot, {
        recursive: true,
        force: true,
        dereference: true,
        verbatimSymlinks: false,
      });
      writePreparedNpmLaunchers(sourceRoot);
    }
    if (!verifyPreparedManagedNpm(sourceRoot)) {
      fs.rmSync(targetNpmPackageRoot, { recursive: true, force: true });
      downloadManagedNpmPackage(targetNpmPackageRoot);
      writePreparedNpmLaunchers(sourceRoot);
    }
  }
  if (!verifyPreparedManagedNpm(sourceRoot)) {
    throw new Error(`rin_managed_node_npm_missing:${targetNpmCli}`);
  }
  return targetExecutable;
}

export function preparedRuntimeNpmCommand(
  sourceRoot: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  const nodeExecutable = preparedRuntimeNodeExecutable(sourceRoot);
  const npmCli = preparedRuntimeNpmCliPath(sourceRoot);
  if (!fs.existsSync(npmCli)) {
    throw new Error(`rin_managed_node_npm_missing:${npmCli}`);
  }
  const managedBin = path.dirname(nodeExecutable);
  const inheritedPath = safeString(env.PATH).trim();
  return {
    command: nodeExecutable,
    args: [npmCli, ...args],
    options: {
      env: {
        ...env,
        PATH: [managedBin, inheritedPath].filter(Boolean).join(path.delimiter),
        NODE_PATH: "",
        npm_node_execpath: nodeExecutable,
        npm_execpath: npmCli,
      },
    },
  };
}

async function verifyPreparedRuntimeNativeDependencies(options: {
  sourceRoot: string;
  env: NodeJS.ProcessEnv;
  label: string;
  logFile: string;
  buildFailureHeader: (label: string) => string;
}) {
  await runLoggedUpdateCommandSync(
    preparedRuntimeNodeExecutable(options.sourceRoot),
    [
      "-e",
      "const Database=require('better-sqlite3');const db=new Database(':memory:');db.prepare('select 1').get();db.close();",
    ],
    options.label,
    options.logFile,
    { cwd: options.sourceRoot, env: options.env },
    options.buildFailureHeader,
  );
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
    const npmCommand = preparedRuntimeNpmCommand(
      workspace.sourceRoot,
      ["--version"],
      buildEnv,
    );
    await runLoggedUpdateCommandSync(
      npmCommand.command,
      npmCommand.args,
      i18n.preparingUpdateSourceMessage,
      workspace.logFile,
      { cwd: workspace.sourceRoot, ...npmCommand.options },
      i18n.buildUpdateCommandFailureHeader,
    );
    await verifyPreparedRuntimeNativeDependencies({
      sourceRoot: workspace.sourceRoot,
      env: npmCommand.options.env,
      label: i18n.preparingUpdateSourceMessage,
      logFile: workspace.logFile,
      buildFailureHeader: i18n.buildUpdateCommandFailureHeader,
    });
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

  provisionPreparedCurrentNodeRuntime(workspace.sourceRoot);
  const runPreparedNpm = (args: string[], label: string) => {
    const command = preparedRuntimeNpmCommand(
      workspace.sourceRoot,
      args,
      buildEnv,
    );
    return runLoggedUpdateCommandSync(
      command.command,
      command.args,
      label,
      workspace.logFile,
      { cwd: workspace.sourceRoot, ...command.options },
      i18n.buildUpdateCommandFailureHeader,
    );
  };
  await runInstallerProgress(
    i18n.installingUpdateDependenciesMessage,
    async () => {
      if (release.channel === "stable") {
        disablePackageRootPrepareScript(workspace.sourceRoot);
        await runPreparedNpm(
          [
            "install",
            "--omit=dev",
            "--no-fund",
            "--no-audit",
            "--loglevel=error",
          ],
          i18n.installingUpdateDependenciesMessage,
        );
      } else if (
        fs.existsSync(path.join(workspace.sourceRoot, "package-lock.json"))
      ) {
        await runPreparedNpm(
          ["ci", "--no-fund", "--no-audit", "--loglevel=error"],
          i18n.installingUpdateDependenciesMessage,
        );
      } else {
        await runPreparedNpm(
          ["install", "--no-fund", "--no-audit", "--loglevel=error"],
          i18n.installingUpdateDependenciesMessage,
        );
      }
    },
  );
  if (release.channel !== "stable") {
    await runInstallerProgress(i18n.buildingUpdateRuntimeMessage, () =>
      runPreparedNpm(
        ["run", "build", "--silent"],
        i18n.buildingUpdateRuntimeMessage,
      ),
    );
    await runInstallerProgress(i18n.pruningUpdateDependenciesMessage, () =>
      runPreparedNpm(
        ["prune", "--omit=dev", "--no-fund", "--no-audit", "--loglevel=error"],
        i18n.pruningUpdateDependenciesMessage,
      ),
    );
  }

  appendDependencyPruneLog(
    workspace.logFile,
    pruneDuplicatePiCodingAgentDependencies(workspace.sourceRoot),
  );
  const verificationCommand = preparedRuntimeNpmCommand(
    workspace.sourceRoot,
    [],
    buildEnv,
  );
  await verifyPreparedRuntimeNativeDependencies({
    sourceRoot: workspace.sourceRoot,
    env: verificationCommand.options.env,
    label: i18n.preparingUpdateSourceMessage,
    logFile: workspace.logFile,
    buildFailureHeader: i18n.buildUpdateCommandFailureHeader,
  });

  return workspace;
}
