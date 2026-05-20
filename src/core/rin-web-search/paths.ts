import fs from "node:fs";
import path from "node:path";

import {
  listInstanceIds as listSidecarInstanceIds,
  readInstanceState as readSidecarInstanceState,
  writeInstanceState as writeSidecarInstanceState,
} from "../sidecar/common.js";
import { readJsonFile, writeJsonAtomic } from "../platform/fs.js";

export type RuntimeBootstrapState = {
  ready?: boolean;
  sourceDir?: string;
  pythonBin?: string;
  pipBin?: string;
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

const WEB_SEARCH_DATA_SEGMENTS = ["data", "web-search"] as const;
const RUNTIME_SEGMENT = "runtime";
const INSTANCES_SEGMENT = "instances";
const WINDOWS_VENV_BIN_DIR = "Scripts";
const POSIX_VENV_BIN_DIR = "bin";

function dataPathForState(stateRoot: string, ...segments: string[]): string {
  return path.join(
    path.resolve(stateRoot),
    ...WEB_SEARCH_DATA_SEGMENTS,
    ...segments,
  );
}

function runtimePathForState(stateRoot: string, ...segments: string[]): string {
  return dataPathForState(stateRoot, RUNTIME_SEGMENT, ...segments);
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

export function runtimeLockPathForState(stateRoot: string): string {
  return runtimePathForState(stateRoot, "install.lock");
}

export function runtimeSourceDirForState(stateRoot: string): string {
  return runtimePathForState(stateRoot, "src");
}

export function runtimeVenvDirForState(stateRoot: string): string {
  return runtimePathForState(stateRoot, "venv");
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
  return readSidecarInstanceState<WebSearchInstanceState | null>(
    instanceStateFileForState(stateRoot, instanceId),
  );
}

export function listInstanceIds(stateRoot: string): string[] {
  return listSidecarInstanceIds(instancesRootForState(stateRoot));
}

export function writeInstanceState(
  stateRoot: string,
  instanceId: string,
  value: WebSearchInstanceState,
): void {
  writeSidecarInstanceState(
    instanceStateFileForState(stateRoot, instanceId),
    value,
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
