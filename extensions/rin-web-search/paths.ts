import fs from "node:fs";
import path from "node:path";

export type RuntimeBootstrapState = {
  ready?: boolean;
  sourceDir?: string;
  pythonBin?: string;
  pipBin?: string;
  managedPythonBin?: string;
  uvBin?: string;
  installedAt?: string;
};

export type WebSearchInstanceState = {
  pid?: number;
  port?: number;
  baseUrl?: string;
  pythonBin?: string;
  sourceDir?: string;
  settingsPath?: string;
  startedAt?: string;
  ownerPid?: number;
};

const RUNTIME_SEGMENT = "runtime";
const INSTANCES_SEGMENT = "instances";
const WINDOWS_VENV_BIN_DIR = "Scripts";
const POSIX_VENV_BIN_DIR = "bin";
const LOCK_FILE_MODE = 0o600;
const INSTANCE_STATE_FILE = "state.json";

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function ensurePrivateDir(dir: string): void {
  ensureDir(dir);
  try {
    fs.chmodSync(dir, 0o700);
  } catch {}
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(
  filePath: string,
  value: unknown,
  mode = LOCK_FILE_MODE,
  privateDir = false,
): void {
  const dir = path.dirname(filePath);
  if (privateDir) ensurePrivateDir(dir);
  else ensureDir(dir);
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, mode);
  } catch {}
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sidecarDataPath(stateRoot: string, ...segments: string[]): string {
  return path.join(path.resolve(stateRoot), "data", "sidecars", ...segments);
}

function sharedRuntimeDataPath(
  stateRoot: string,
  ...segments: string[]
): string {
  return path.join(path.resolve(stateRoot), "data", "runtime", ...segments);
}

function dataPathForState(stateRoot: string, ...segments: string[]): string {
  return sidecarDataPath(stateRoot, "web-search", ...segments);
}

function runtimePathForState(stateRoot: string, ...segments: string[]): string {
  return dataPathForState(stateRoot, RUNTIME_SEGMENT, ...segments);
}

function sharedRuntimePathForState(
  stateRoot: string,
  ...segments: string[]
): string {
  return sharedRuntimeDataPath(stateRoot, ...segments);
}

function instancePathForState(
  stateRoot: string,
  instanceId: string,
  ...segments: string[]
): string {
  return dataPathForState(
    stateRoot,
    INSTANCES_SEGMENT,
    instanceId,
    ...segments,
  );
}

function runtimeVenvBinPathForState(
  stateRoot: string,
  posixName: string,
  windowsName: string,
): string {
  return path.join(
    runtimeVenvDirForState(stateRoot),
    process.platform === "win32" ? WINDOWS_VENV_BIN_DIR : POSIX_VENV_BIN_DIR,
    process.platform === "win32" ? windowsName : posixName,
  );
}

export function dataRootForState(stateRoot: string): string {
  return dataPathForState(stateRoot);
}

export function runtimeRootForState(stateRoot: string): string {
  return runtimePathForState(stateRoot);
}

export function instancesRootForState(stateRoot: string): string {
  return dataPathForState(stateRoot, INSTANCES_SEGMENT);
}

export function runtimeSourceDirForState(stateRoot: string): string {
  return runtimePathForState(stateRoot, "src");
}

export function runtimeVenvDirForState(stateRoot: string): string {
  return runtimePathForState(stateRoot, "venv");
}

export function runtimeToolsDirForState(
  stateRoot: string,
  ...segments: string[]
): string {
  return sharedRuntimePathForState(stateRoot, "tools", ...segments);
}

export function runtimeUvDirForState(stateRoot: string): string {
  return runtimeToolsDirForState(stateRoot, "uv");
}

export function runtimeUvBinForState(stateRoot: string): string {
  return path.join(
    runtimeUvDirForState(stateRoot),
    process.platform === "win32" ? "uv.exe" : "uv",
  );
}

export function runtimeManagedPythonDirForState(stateRoot: string): string {
  return sharedRuntimePathForState(stateRoot, "python");
}

export function runtimeTmpDirForState(stateRoot: string): string {
  return runtimePathForState(stateRoot, "tmp");
}

export function runtimeBootstrapStateFileForState(stateRoot: string): string {
  return runtimePathForState(stateRoot, "bootstrap.json");
}

export function runtimePythonBinForState(stateRoot: string): string {
  return runtimeVenvBinPathForState(stateRoot, "python", "python.exe");
}

export function runtimePipBinForState(stateRoot: string): string {
  return runtimeVenvBinPathForState(stateRoot, "pip", "pip.exe");
}

export function instanceRootForState(
  stateRoot: string,
  instanceId: string,
): string {
  return instancePathForState(stateRoot, instanceId);
}

export function instanceStateFileForState(
  stateRoot: string,
  instanceId: string,
): string {
  return instancePathForState(stateRoot, instanceId, "state.json");
}

export function instanceSettingsFileForState(
  stateRoot: string,
  instanceId: string,
): string {
  return instancePathForState(stateRoot, instanceId, "settings.yml");
}

export function readRuntimeBootstrapState(
  stateRoot: string,
): RuntimeBootstrapState | null {
  return readJsonFile<RuntimeBootstrapState | null>(
    runtimeBootstrapStateFileForState(stateRoot),
    null,
  );
}

export function writeRuntimeBootstrapState(
  stateRoot: string,
  value: RuntimeBootstrapState,
): void {
  writeJsonAtomic(runtimeBootstrapStateFileForState(stateRoot), value);
}

export function readInstanceState(
  stateRoot: string,
  instanceId: string,
): WebSearchInstanceState | null {
  const value = readJsonFile<unknown>(
    instanceStateFileForState(stateRoot, instanceId),
    null,
  );
  return isJsonRecord(value) ? (value as WebSearchInstanceState) : null;
}

export function listInstanceIds(stateRoot: string): string[] {
  try {
    return fs
      .readdirSync(instancesRootForState(stateRoot), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          fs.existsSync(
            path.join(
              instancesRootForState(stateRoot),
              entry.name,
              INSTANCE_STATE_FILE,
            ),
          ),
      )
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [] as string[];
  }
}

export function writeInstanceState(
  stateRoot: string,
  instanceId: string,
  value: WebSearchInstanceState,
): void {
  writeJsonAtomic(
    instanceStateFileForState(stateRoot, instanceId),
    value,
    LOCK_FILE_MODE,
    true,
  );
}

export function removeInstanceRoot(
  stateRoot: string,
  instanceId: string,
): void {
  try {
    fs.rmSync(instanceRootForState(stateRoot, instanceId), {
      recursive: true,
      force: true,
    });
  } catch {}
}

export function removeInstanceState(
  stateRoot: string,
  instanceId: string,
): void {
  removeInstanceRoot(stateRoot, instanceId);
}
