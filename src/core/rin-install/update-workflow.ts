import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

import { safeString } from "../text-utils.js";
import { shellQuote } from "../rin-lib/system.js";
import {
  buildGitHubRefArchiveUrl,
  type ResolvedRelease,
} from "../rin-lib/release.js";
import { type InstallerI18n } from "./i18n.js";
import { restoreTerminalCursor, runInstallerProgress } from "./progress.js";
import { readJsonFile } from "../platform/fs.js";

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

const FORWARDED_UPDATE_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

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
    if (forwardedSignal) process.exit(signalExitCode(forwardedSignal));
    if (result.signal) process.exit(signalExitCode(result.signal));
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
  const npm = requireTool("npm", ["/usr/bin/npm", "/bin/npm"]);
  const tar = requireTool("tar", ["/usr/bin/tar", "/bin/tar"]);
  const buildEnv = {
    ...(options.env || process.env),
    TMPDIR: workspace.tmpDir,
    TEMP: workspace.tmpDir,
    TMP: workspace.tmpDir,
  };

  await runInstallerProgress(i18n.fetchingUpdateSourceMessage, async () => {
    if (curl) {
      await runLoggedUpdateCommandSync(
        curl,
        ["-fsSL", release.archiveUrl, "-o", workspace.archivePath],
        i18n.fetchingUpdateSourceMessage,
        workspace.logFile,
        {},
        i18n.buildUpdateCommandFailureHeader,
      );
    } else if (wget) {
      await runLoggedUpdateCommandSync(
        wget,
        ["-qO", workspace.archivePath, release.archiveUrl],
        i18n.fetchingUpdateSourceMessage,
        workspace.logFile,
        {},
        i18n.buildUpdateCommandFailureHeader,
      );
    } else {
      await downloadFile(release.archiveUrl, workspace.archivePath);
    }
  });
  await runInstallerProgress(i18n.preparingUpdateSourceMessage, () =>
    runLoggedUpdateCommandSync(
      tar,
      [
        "-xzf",
        workspace.archivePath,
        "-C",
        workspace.sourceRoot,
        "--strip-components=1",
      ],
      i18n.preparingUpdateSourceMessage,
      workspace.logFile,
      {},
      i18n.buildUpdateCommandFailureHeader,
    ),
  );

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
  }

  return workspace;
}
