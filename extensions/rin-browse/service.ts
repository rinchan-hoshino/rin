import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {}
}

function safeString(value: unknown): string {
  return value == null ? "" : String(value);
}

function isPidAlive(pid: unknown): boolean {
  const n = Number(pid || 0);
  if (!Number.isInteger(n) || n <= 1) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
import {
  dataRootForState,
  instanceSettingsFileForState,
  instanceStateFileForState,
  listInstanceIds,
  readInstanceState,
  readRuntimeBootstrapState,
  removeInstanceRoot,
  runtimeManagedPythonDirForState,
  runtimePipBinForState,
  runtimePythonBinForState,
  runtimeRootForState,
  runtimeSourceDirForState,
  runtimeTmpDirForState,
  runtimeUvBinForState,
  runtimeUvDirForState,
  runtimeVenvDirForState,
  writeInstanceState,
  writeRuntimeBootstrapState,
  type RuntimeBootstrapState,
  type BrowseInstanceState,
} from "./paths.js";
import {
  SEARXNG_BROWSE_PROVIDERS,
  searchWeb as performSearxngSearch,
  safeText,
  type BrowseRequest,
  type BrowseResponse,
} from "./query.js";

const START_TIMEOUT_MS = 90_000;
const START_POLL_INTERVAL_MS = 100;
const HEALTHCHECK_TIMEOUT_MS = 1_500;
const SEARXNG_HEALTH_PATH = "/healthz";
const MIN_SEARXNG_PYTHON_MAJOR = 3;
const MIN_SEARXNG_PYTHON_MINOR = 10;
const MANAGED_PYTHON_VERSION = "3.12";
const SEARXNG_ARCHIVE_URL =
  "https://github.com/searxng/searxng/archive/refs/heads/master.tar.gz";

type LoggerLike = {
  info?: (message: string) => void;
};

type EnsureSearxngSidecarOptions = {
  logger?: LoggerLike;
  timeoutMs?: number;
  instanceId?: string;
};

type StopSearxngSidecarOptions = {
  logger?: LoggerLike;
  instanceId?: string;
};

type CleanupSearxngSidecarsOptions = {
  logger?: LoggerLike;
};

type SearchWebOptions = {
  stateRoot?: string;
  logger?: LoggerLike;
  instanceId?: string;
};

type SearxngRuntimeInstall = {
  sourceDir: string;
  pythonBin: string;
  pipBin: string;
  reused: boolean;
};

type NormalizedInstanceState = {
  pid: number;
  ownerPid: number;
  alive: boolean;
  baseUrl: string;
  port?: number;
  pythonBin: string;
  sourceDir: string;
  settingsPath: string;
  startedAt: string;
  statePath: string;
};

function logInfo(logger: LoggerLike | undefined, message: string): void {
  try {
    logger?.info?.(message);
  } catch {}
}

function toNumber(value: unknown): number {
  const numberValue = Number(value || 0);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function trimString(value: unknown): string {
  return safeString(value).trim();
}

function isLivePid(pid: unknown): boolean {
  const numberValue = toNumber(pid);
  return numberValue > 1 && isPidAlive(numberValue);
}

function defaultStateRoot(): string {
  return process.env.RIN_DIR?.trim() || path.join(os.homedir(), ".rin");
}

function defaultInstanceId() {
  return `process-${process.pid}`;
}

function normalizeInstanceState(
  stateRoot: string,
  instanceId: string,
  state: BrowseInstanceState | null | undefined,
): NormalizedInstanceState {
  const pid = toNumber(state?.pid);
  const ownerPid = toNumber(state?.ownerPid);
  const port = toNumber(state?.port);
  return {
    pid,
    ownerPid,
    alive: isLivePid(pid),
    baseUrl: trimString(state?.baseUrl),
    port: port > 0 ? port : undefined,
    pythonBin: trimString(state?.pythonBin),
    sourceDir: trimString(state?.sourceDir),
    settingsPath: trimString(state?.settingsPath),
    startedAt: trimString(state?.startedAt),
    statePath: instanceStateFileForState(stateRoot, instanceId),
  };
}

function readNormalizedInstanceState(
  stateRoot: string,
  instanceId: string,
): NormalizedInstanceState {
  return normalizeInstanceState(
    stateRoot,
    instanceId,
    readInstanceState(stateRoot, instanceId),
  );
}

function removeStoredInstance(stateRoot: string, instanceId: string): void {
  removeInstanceRoot(stateRoot, instanceId);
}

function reuseStoredSearxngInstance(
  stateRoot: string,
  instanceId: string,
): {
  ok: true;
  instanceId: string;
  baseUrl: string;
  reused: true;
} | null {
  const existing = readNormalizedInstanceState(stateRoot, instanceId);
  if (existing.alive && existing.baseUrl) {
    return {
      ok: true,
      instanceId,
      baseUrl: existing.baseUrl,
      reused: true,
    };
  }
  if (existing.pid > 0 || existing.baseUrl || existing.settingsPath) {
    removeStoredInstance(stateRoot, instanceId);
  }
  return null;
}

function reuseAnySearxngInstance(stateRoot: string) {
  for (const instanceId of listInstanceIds(stateRoot)) {
    const existing = readNormalizedInstanceState(stateRoot, instanceId);
    if (existing.alive && existing.baseUrl) {
      return {
        ok: true as const,
        instanceId,
        baseUrl: existing.baseUrl,
        reused: true as const,
      };
    }
    if (existing.pid > 0 || existing.baseUrl || existing.settingsPath) {
      removeStoredInstance(stateRoot, instanceId);
    }
  }
  return null;
}

function findExecutableOnPath(name: string): string {
  const raw = trimString(process.env.PATH);
  const parts = raw ? raw.split(path.delimiter) : [];
  const suffixes =
    process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of parts) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      const candidate = path.join(dir, `${name}${suffix}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return "";
}

function runCommandSync(
  command: string,
  args: string[],
  options: Parameters<typeof spawnSync>[2] = {},
): ReturnType<typeof spawnSync> {
  const result = spawnSync(command, args, {
    stdio: "pipe",
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.status === 0) return result;
  const detail = safeText(
    result.stderr ||
      result.stdout ||
      result.error?.message ||
      `exit_${result.status}`,
  );
  throw new Error(`${path.basename(command)}:${detail}`);
}

function parsePythonVersion(value: string) {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] || 0),
  };
}

function isSearxngPythonSupported(python: string): boolean {
  let versionText = "";
  try {
    const result = runCommandSync(python, [
      "-c",
      "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')",
    ]);
    versionText = safeText(result.stdout);
  } catch {
    return false;
  }
  const version = parsePythonVersion(versionText);
  return Boolean(
    version &&
    (version.major > MIN_SEARXNG_PYTHON_MAJOR ||
      (version.major === MIN_SEARXNG_PYTHON_MAJOR &&
        version.minor >= MIN_SEARXNG_PYTHON_MINOR)),
  );
}

function uvCommandEnv(stateRoot: string, tmpDir: string): NodeJS.ProcessEnv {
  return {
    ...runtimeCommandEnv(tmpDir),
    UV_INSTALL_DIR: runtimeUvDirForState(stateRoot),
    UV_PYTHON_INSTALL_DIR: runtimeManagedPythonDirForState(stateRoot),
    UV_MANAGED_PYTHON: "1",
    UV_NO_MODIFY_PATH: "1",
  };
}

function installPrivateUv(
  stateRoot: string,
  tmpDir: string,
  logger?: LoggerLike,
): string {
  const uvBin = runtimeUvBinForState(stateRoot);
  if (fs.existsSync(uvBin)) return uvBin;

  ensurePrivateDir(runtimeUvDirForState(stateRoot));
  const env = uvCommandEnv(stateRoot, tmpDir);
  if (process.platform === "win32") {
    const powershell =
      findExecutableOnPath("pwsh") || findExecutableOnPath("powershell");
    if (!powershell) throw new Error("browse_runtime_fetch_tools_not_found");
    logInfo(logger, "browse: installing private uv helper");
    runCommandSync(
      powershell,
      [
        "-ExecutionPolicy",
        "ByPass",
        "-NoProfile",
        "-Command",
        "irm https://astral.sh/uv/install.ps1 | iex",
      ],
      { cwd: runtimeRootForState(stateRoot), env },
    );
  } else {
    const shell = findExecutableOnPath("sh");
    const curl = findExecutableOnPath("curl");
    const wget = findExecutableOnPath("wget");
    if (!shell || (!curl && !wget)) {
      throw new Error("browse_runtime_fetch_tools_not_found");
    }
    logInfo(logger, "browse: installing private uv helper");
    const command = curl
      ? "curl -LsSf https://astral.sh/uv/install.sh | sh"
      : "wget -qO- https://astral.sh/uv/install.sh | sh";
    runCommandSync(shell, ["-c", command], {
      cwd: runtimeRootForState(stateRoot),
      env,
    });
  }

  if (!fs.existsSync(uvBin)) throw new Error("uv_install_failed");
  return uvBin;
}

function findUvForManagedPython(
  stateRoot: string,
  tmpDir: string,
  logger?: LoggerLike,
): string {
  const privateUv = runtimeUvBinForState(stateRoot);
  if (fs.existsSync(privateUv)) return privateUv;
  return installPrivateUv(stateRoot, tmpDir, logger);
}

function ensureManagedSearxngPython(
  stateRoot: string,
  tmpDir: string,
  logger?: LoggerLike,
): string {
  const current = readRuntimeBootstrapState(stateRoot);
  if (
    current?.managedPythonBin &&
    fs.existsSync(current.managedPythonBin) &&
    isSearxngPythonSupported(current.managedPythonBin)
  ) {
    return current.managedPythonBin;
  }

  ensurePrivateDir(runtimeManagedPythonDirForState(stateRoot));
  const uvBin = findUvForManagedPython(stateRoot, tmpDir, logger);
  const env = uvCommandEnv(stateRoot, tmpDir);
  logInfo(
    logger,
    `browse: installing private Python ${MANAGED_PYTHON_VERSION}`,
  );
  runCommandSync(uvBin, ["python", "install", MANAGED_PYTHON_VERSION], {
    cwd: runtimeRootForState(stateRoot),
    env,
  });
  const findResult = runCommandSync(
    uvBin,
    ["python", "find", MANAGED_PYTHON_VERSION],
    { cwd: runtimeRootForState(stateRoot), env },
  );
  const python = safeText(findResult.stdout).split(/\r?\n/)[0]?.trim() || "";
  if (!python || !fs.existsSync(python) || !isSearxngPythonSupported(python)) {
    throw new Error("python_version_unsupported");
  }
  return python;
}

function findSearxngPython(
  stateRoot: string,
  tmpDir: string,
  logger?: LoggerLike,
): string {
  const current = readRuntimeBootstrapState(stateRoot);
  if (
    current?.managedPythonBin &&
    fs.existsSync(current.managedPythonBin) &&
    isSearxngPythonSupported(current.managedPythonBin)
  ) {
    return current.managedPythonBin;
  }
  return ensureManagedSearxngPython(stateRoot, tmpDir, logger);
}

function runtimeCommandEnv(tmpDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TMPDIR: tmpDir,
    TEMP: tmpDir,
    TMP: tmpDir,
  };
}

async function probeSearxngHealth(
  baseUrl: string,
  timeoutMs = HEALTHCHECK_TIMEOUT_MS,
): Promise<boolean> {
  const target = trimString(baseUrl);
  if (!target) return false;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`timeout:${timeoutMs}`)),
    Math.max(1, timeoutMs),
  );
  try {
    const response = await fetch(new URL(SEARXNG_HEALTH_PATH, `${target}/`), {
      method: "GET",
      headers: { Accept: "text/plain" },
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const body = safeText(await response.text());
    return !body || body.toUpperCase() === "OK";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForSearxngReady(
  baseUrl: string,
  pid: unknown,
  timeoutMs: number,
): Promise<number> {
  const resolvedPid = toNumber(pid);
  if (!(resolvedPid > 1)) {
    throw new Error("searxng_start_failed");
  }

  const deadline = Date.now() + Math.max(1, timeoutMs);
  while (Date.now() < deadline) {
    if (!isLivePid(resolvedPid)) {
      throw new Error("searxng_start_failed");
    }
    if (await probeSearxngHealth(baseUrl)) {
      return resolvedPid;
    }
    await sleep(START_POLL_INTERVAL_MS);
  }

  throw new Error("searxng_start_timeout");
}

function removePathIfExists(targetPath: string): void {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } catch {}
}

function hasSearxngSourceTree(sourceDir: string): boolean {
  return (
    fs.existsSync(path.join(sourceDir, "requirements.txt")) &&
    fs.existsSync(path.join(sourceDir, "searx"))
  );
}

function installSearxngSourceFromArchive(
  runtimeDir: string,
  sourceDir: string,
  tmpDir: string,
): void {
  const tar = findExecutableOnPath("tar");
  const curl = findExecutableOnPath("curl");
  const wget = findExecutableOnPath("wget");
  if (!tar || (!curl && !wget)) {
    throw new Error("browse_runtime_fetch_tools_not_found");
  }

  const archivePath = path.join(runtimeDir, "searxng-source.tar.gz");
  ensurePrivateDir(sourceDir);
  try {
    if (curl) {
      runCommandSync(curl, ["-fsSL", SEARXNG_ARCHIVE_URL, "-o", archivePath], {
        cwd: runtimeDir,
        env: runtimeCommandEnv(tmpDir),
      });
    } else {
      runCommandSync(wget, ["-qO", archivePath, SEARXNG_ARCHIVE_URL], {
        cwd: runtimeDir,
        env: runtimeCommandEnv(tmpDir),
      });
    }
    runCommandSync(
      tar,
      ["-xzf", archivePath, "-C", sourceDir, "--strip-components=1"],
      {
        cwd: runtimeDir,
        env: runtimeCommandEnv(tmpDir),
      },
    );
  } finally {
    try {
      fs.rmSync(archivePath, { force: true });
    } catch {}
  }
}

function ensureSearxngSourceInstalled(
  runtimeDir: string,
  sourceDir: string,
  tmpDir: string,
  logger?: LoggerLike,
): void {
  if (hasSearxngSourceTree(sourceDir)) return;

  removePathIfExists(sourceDir);
  const git = findExecutableOnPath("git");
  try {
    if (git) {
      logInfo(logger, "browse: cloning searxng source");
      runCommandSync(
        git,
        [
          "clone",
          "--depth",
          "1",
          "https://github.com/searxng/searxng.git",
          sourceDir,
        ],
        { cwd: runtimeDir, env: runtimeCommandEnv(tmpDir) },
      );
    } else {
      logInfo(logger, "browse: downloading searxng source archive");
      installSearxngSourceFromArchive(runtimeDir, sourceDir, tmpDir);
    }
  } catch (error) {
    removePathIfExists(sourceDir);
    throw error;
  }

  if (!hasSearxngSourceTree(sourceDir)) {
    removePathIfExists(sourceDir);
    throw new Error("browse_runtime_source_invalid");
  }
}

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address ? Number(address.port || 0) : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
    server.on("error", reject);
  });
}

function writeSearxngSettingsForInstance(
  stateRoot: string,
  instanceId: string,
  baseUrl: string,
  port: number,
): string {
  const settingsPath = instanceSettingsFileForState(stateRoot, instanceId);
  ensurePrivateDir(path.dirname(settingsPath));
  const secret = crypto
    .createHash("sha256")
    .update(`${baseUrl}|${stateRoot}|${instanceId}|rin-browse`)
    .digest("hex")
    .slice(0, 32);
  const yaml = [
    "use_default_settings: true",
    "",
    "general:",
    "  enable_metrics: false",
    "",
    "search:",
    "  formats:",
    "    - html",
    "    - json",
    "",
    "server:",
    `  port: ${port}`,
    '  bind_address: "127.0.0.1"',
    `  base_url: ${JSON.stringify(`${baseUrl}/`)}`,
    `  secret_key: ${JSON.stringify(secret)}`,
    "  limiter: false",
    "  public_instance: false",
    "",
    "valkey:",
    "  url: false",
    "",
  ].join("\n");
  fs.writeFileSync(settingsPath, yaml, { mode: 0o600 });
  return settingsPath;
}

function ensureSearxngRuntimeInstalled(
  stateRoot: string,
  logger?: LoggerLike,
): SearxngRuntimeInstall {
  const runtimeDir = runtimeRootForState(stateRoot);
  const sourceDir = runtimeSourceDirForState(stateRoot);
  const venvDir = runtimeVenvDirForState(stateRoot);
  const tmpDir = runtimeTmpDirForState(stateRoot);
  const pythonBin = runtimePythonBinForState(stateRoot);
  const pipBin = runtimePipBinForState(stateRoot);
  const current = readRuntimeBootstrapState(stateRoot);
  if (
    current?.ready &&
    hasSearxngSourceTree(sourceDir) &&
    fs.existsSync(pythonBin) &&
    fs.existsSync(pipBin) &&
    isSearxngPythonSupported(pythonBin)
  ) {
    return { sourceDir, pythonBin, pipBin, reused: true };
  }

  if (fs.existsSync(pythonBin) && !isSearxngPythonSupported(pythonBin)) {
    removePathIfExists(venvDir);
  }

  ensurePrivateDir(runtimeDir);
  ensurePrivateDir(tmpDir);

  const managedPythonBin = findSearxngPython(stateRoot, tmpDir, logger);

  ensureSearxngSourceInstalled(runtimeDir, sourceDir, tmpDir, logger);

  if (!fs.existsSync(pythonBin)) {
    logInfo(logger, "browse: creating searxng virtualenv");
    runCommandSync(managedPythonBin, ["-m", "venv", venvDir], {
      cwd: runtimeDir,
      env: runtimeCommandEnv(tmpDir),
    });
  }

  logInfo(logger, "browse: installing searxng runtime dependencies");
  runCommandSync(
    pipBin,
    ["install", "--upgrade", "pip", "wheel", "setuptools"],
    { cwd: runtimeDir, env: runtimeCommandEnv(tmpDir) },
  );
  runCommandSync(
    pipBin,
    ["install", "-r", path.join(sourceDir, "requirements.txt")],
    { cwd: runtimeDir, env: runtimeCommandEnv(tmpDir) },
  );
  runCommandSync(pipBin, ["install", "--no-build-isolation", "-e", sourceDir], {
    cwd: runtimeDir,
    env: runtimeCommandEnv(tmpDir),
  });

  const nextState: RuntimeBootstrapState = {
    ready: true,
    sourceDir,
    pythonBin,
    pipBin,
    managedPythonBin,
    uvBin: runtimeUvBinForState(stateRoot),
    installedAt: new Date().toISOString(),
  };
  writeRuntimeBootstrapState(stateRoot, nextState);
  return { sourceDir, pythonBin, pipBin, reused: false };
}

function readInstalledSearxngRuntime(stateRoot: string): SearxngRuntimeInstall {
  const sourceDir = runtimeSourceDirForState(stateRoot);
  const pythonBin = runtimePythonBinForState(stateRoot);
  const pipBin = runtimePipBinForState(stateRoot);
  const current = readRuntimeBootstrapState(stateRoot);
  if (
    current?.ready &&
    hasSearxngSourceTree(sourceDir) &&
    fs.existsSync(pythonBin) &&
    fs.existsSync(pipBin) &&
    isSearxngPythonSupported(pythonBin)
  ) {
    return { sourceDir, pythonBin, pipBin, reused: true };
  }
  throw new Error("browse_runtime_not_installed");
}

function createInstanceId(prefix = "ws"): string {
  const rand = crypto.randomBytes(6).toString("hex");
  return `${prefix}-${process.pid}-${rand}`;
}

async function prepareSearxngRuntime(
  stateRoot: string,
  options: EnsureSearxngSidecarOptions = {},
) {
  const runtime = ensureSearxngRuntimeInstalled(stateRoot, options.logger);
  return { ok: true as const, ...runtime };
}

async function startSearxngSidecar(
  stateRoot: string,
  options: EnsureSearxngSidecarOptions = {},
) {
  const logger = options.logger;
  const instanceId =
    trimString(options.instanceId) || createInstanceId("searxng");
  const existing =
    reuseStoredSearxngInstance(stateRoot, instanceId) ||
    reuseAnySearxngInstance(stateRoot);
  if (existing) return existing;

  let child: ChildProcess | null = null;
  let baseUrl = "";
  let ready = false;
  try {
    const runtime = readInstalledSearxngRuntime(stateRoot);
    const port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    const settingsPath = writeSearxngSettingsForInstance(
      stateRoot,
      instanceId,
      baseUrl,
      port,
    );
    const tmpDir = runtimeTmpDirForState(stateRoot);
    ensurePrivateDir(tmpDir);

    logInfo(
      logger,
      `browse: starting searxng instance=${instanceId} baseUrl=${baseUrl}`,
    );
    child = spawn(runtime.pythonBin, ["-m", "searx.webapp"], {
      cwd: runtime.sourceDir,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        TMPDIR: tmpDir,
        PYTHONUNBUFFERED: "1",
        SEARXNG_SETTINGS_PATH: settingsPath,
        SEARXNG_PORT: String(port),
        SEARXNG_BIND_ADDRESS: "127.0.0.1",
        SEARXNG_BASE_URL: `${baseUrl}/`,
        SEARXNG_LIMITER: "false",
      },
    });
    try {
      child.unref();
    } catch {}

    const pid = toNumber(child.pid);
    const nextState: BrowseInstanceState = {
      pid,
      port,
      baseUrl,
      pythonBin: runtime.pythonBin,
      sourceDir: runtime.sourceDir,
      settingsPath,
      startedAt: new Date().toISOString(),
      ownerPid: process.pid,
    };
    writeInstanceState(stateRoot, instanceId, nextState);

    const timeoutMs = Math.max(
      1,
      Number(options.timeoutMs ?? START_TIMEOUT_MS) || START_TIMEOUT_MS,
    );
    await waitForSearxngReady(baseUrl, pid, timeoutMs);
    ready = true;
    return {
      ok: true,
      instanceId,
      baseUrl,
      pid,
    };
  } finally {
    if (!ready) {
      if (child && isLivePid(child.pid)) {
        try {
          process.kill(toNumber(child.pid), "SIGTERM");
        } catch {}
      }
      removeStoredInstance(stateRoot, instanceId);
    }
    if (child && !isLivePid(child.pid)) {
      removeStoredInstance(stateRoot, instanceId);
    }
  }
}

async function stopSearxngSidecar(
  stateRoot: string,
  options: StopSearxngSidecarOptions = {},
) {
  const logger = options.logger;
  const instanceId = trimString(options.instanceId);
  if (!instanceId) return { ok: false, error: "browse_instance_required" };

  const current = readNormalizedInstanceState(stateRoot, instanceId);
  if (current.alive) {
    try {
      process.kill(current.pid, "SIGTERM");
    } catch {}
  }
  removeStoredInstance(stateRoot, instanceId);
  logInfo(logger, `browse: stopped searxng instance=${instanceId}`);
  return { ok: true, pid: current.pid };
}

function cleanupReasonForInstanceState(state: NormalizedInstanceState): string {
  const hasStoredState = Boolean(
    state.pid > 0 || state.baseUrl || state.settingsPath,
  );
  if (!hasStoredState) return "";
  if (state.ownerPid > 1 && !isPidAlive(state.ownerPid)) return "owner_dead";
  if (state.pid > 1 && !state.alive) return "pid_dead";
  if (!(state.pid > 1) && (state.baseUrl || state.settingsPath)) {
    return "stale_state";
  }
  return "";
}

async function cleanupOrphanSearxngSidecars(
  stateRoot: string,
  options: CleanupSearxngSidecarsOptions = {},
) {
  const logger = options.logger;
  const cleaned: Array<{ instanceId: string; pid: number; ownerPid?: number }> =
    [];
  for (const instanceId of listInstanceIds(stateRoot)) {
    const state = readNormalizedInstanceState(stateRoot, instanceId);
    const reason = cleanupReasonForInstanceState(state);
    if (!reason) continue;
    if (reason === "owner_dead" && state.alive) {
      try {
        process.kill(state.pid, "SIGTERM");
      } catch {}
      await sleep(150);
    }
    removeStoredInstance(stateRoot, instanceId);
    cleaned.push({
      instanceId,
      pid: state.pid,
      ownerPid: state.ownerPid || undefined,
    });
    logInfo(
      logger,
      `browse: cleaned stale instance=${instanceId} pid=${state.pid} ownerPid=${state.ownerPid} reason=${reason}`,
    );
  }
  return { ok: true, cleaned };
}

let searchSidecarStartInFlight: Promise<{ baseUrl?: string }> | null = null;

async function resolveSearxngSearchBaseUrl(options: SearchWebOptions) {
  const stateRoot = trimString(options.stateRoot) || defaultStateRoot();
  const instanceId = trimString(options.instanceId) || defaultInstanceId();
  const sidecar =
    reuseStoredSearxngInstance(stateRoot, instanceId) ||
    reuseAnySearxngInstance(stateRoot);
  if (sidecar?.baseUrl) return sidecar.baseUrl;

  searchSidecarStartInFlight ??= (async () => {
    await cleanupOrphanSearxngSidecars(stateRoot, {
      logger: options.logger,
    }).catch(() => {});
    return await startSearxngSidecar(stateRoot, {
      instanceId,
      logger: options.logger,
    });
  })().finally(() => {
    searchSidecarStartInFlight = null;
  });
  const started = await searchSidecarStartInFlight;
  if (!started?.baseUrl) throw new Error("browse_sidecar_unavailable");
  return started.baseUrl;
}

async function searchWeb(
  request: BrowseRequest,
  options: SearchWebOptions = {},
): Promise<BrowseResponse> {
  const baseUrl = await resolveSearxngSearchBaseUrl(options);
  return await performSearxngSearch(baseUrl, request);
}

function getBrowseStatus(stateRoot: string) {
  const runtime = readRuntimeBootstrapState(stateRoot) || {};
  const instances = listInstanceIds(stateRoot).map((instanceId) => {
    const state = readNormalizedInstanceState(stateRoot, instanceId);
    return {
      instanceId,
      pid: state.pid,
      alive: state.alive,
      baseUrl: state.baseUrl,
      port: state.port,
      startedAt: state.startedAt,
      ownerPid: state.ownerPid || undefined,
      statePath: state.statePath,
      settingsPath: state.settingsPath,
    };
  });
  return {
    root: dataRootForState(stateRoot),
    runtime: {
      ready: Boolean(runtime?.ready || instances.some((item) => item.alive)),
      mode: "searxng-sidecar",
      providerCount: SEARXNG_BROWSE_PROVIDERS.length,
      providers: [...SEARXNG_BROWSE_PROVIDERS],
      installedAt: trimString(runtime?.installedAt),
      pythonBin: trimString(runtime?.pythonBin),
      sourceDir: trimString(runtime?.sourceDir),
    },
    instances,
  };
}

export {
  cleanupOrphanSearxngSidecars,
  prepareSearxngRuntime,
  startSearxngSidecar,
  getBrowseStatus,
  stopSearxngSidecar,
  searchWeb,
  type BrowseRequest,
  type BrowseResponse,
};
