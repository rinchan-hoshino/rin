import fs from "node:fs";
import path from "node:path";

import { cloneJson, isJsonRecord } from "./json-utils.js";
import { readJsonFile } from "./platform/fs.js";
import { safeString } from "./text-utils.js";

export type RinExtensionWorkerConfig = {
  name: string;
  packageName: string;
  version: string;
  config: Record<string, any>;
};

export type RinExtensionConfigOptions = {
  cwd?: string;
};

export function readRuntimeSettings(agentDir: string): Record<string, any> {
  const settingsPath = path.join(agentDir, "settings.json");
  return readJsonFile<Record<string, any>>(settingsPath, {}) || {};
}

export function getRinExtensionRoot(settings: unknown): Record<string, any> {
  if (!isJsonRecord(settings)) return {};
  return isJsonRecord(settings.rinExtensions)
    ? cloneJson(settings.rinExtensions)
    : {};
}

function normalizeWorkerConfig(
  value: unknown,
): RinExtensionWorkerConfig | null {
  if (!isJsonRecord(value)) return null;
  if (value.enabled === false) return null;
  const packageName = safeString(value.packageName).trim();
  if (!packageName) return null;
  const name =
    safeString(value.name).trim() ||
    packageName.replace(/^@/, "").replace(/[^A-Za-z0-9._-]+/g, "-");
  return {
    name,
    packageName,
    version: safeString(value.version).trim() || "latest",
    config: isJsonRecord(value.config) ? cloneJson(value.config) : {},
  };
}

function stripExtensionMarker(value: string) {
  const text = safeString(value).trim();
  if (!text || text.startsWith("!") || text.startsWith("-")) return "";
  return text.startsWith("+") ? text.slice(1).trim() : text;
}

function resolveLocalExtensionPath(entry: unknown, cwd: string) {
  const text = stripExtensionMarker(safeString(entry));
  if (!text) return "";
  if (
    !text.startsWith(".") &&
    !text.startsWith("/") &&
    !text.startsWith("file:")
  ) {
    return "";
  }
  const rawPath = text.startsWith("file:") ? text.slice("file:".length) : text;
  const resolved = path.resolve(cwd || process.cwd(), rawPath);
  if (!fs.existsSync(resolved)) return "";
  return fs.statSync(resolved).isDirectory()
    ? resolved
    : path.dirname(resolved);
}

function packageDeclaresDaemonExtension(packageJson: any) {
  return (
    packageJson?.rin?.daemonExtension === true ||
    packageJson?.rin?.daemonWorker === true
  );
}

function normalizeDirectExtensionWorkerConfig(
  entry: unknown,
  cwd: string,
): RinExtensionWorkerConfig | null {
  const extensionPath = resolveLocalExtensionPath(entry, cwd);
  if (!extensionPath) return null;
  const packageJsonPath = path.join(extensionPath, "package.json");
  const packageJson = readJsonFile<any>(packageJsonPath, null);
  if (!packageDeclaresDaemonExtension(packageJson)) return null;
  const packageName = safeString(packageJson?.name).trim();
  if (!packageName) return null;
  return {
    name: packageName.replace(/^@/, "").replace(/[^A-Za-z0-9._-]+/g, "-"),
    packageName,
    version: `file:${extensionPath}`,
    config: {},
  };
}

export function listRinDaemonWorkerConfigs(
  settings: unknown,
  options: RinExtensionConfigOptions = {},
): RinExtensionWorkerConfig[] {
  const root = getRinExtensionRoot(settings);
  const workers = Array.isArray(root.daemonWorkers) ? root.daemonWorkers : [];
  const configuredWorkers = workers
    .map((entry) => normalizeWorkerConfig(entry))
    .filter((entry): entry is RinExtensionWorkerConfig => Boolean(entry));
  const directExtensions =
    isJsonRecord(settings) && Array.isArray(settings.extensions)
      ? settings.extensions
          .map((entry) =>
            normalizeDirectExtensionWorkerConfig(
              entry,
              safeString(options.cwd).trim() || process.cwd(),
            ),
          )
          .filter((entry): entry is RinExtensionWorkerConfig => Boolean(entry))
      : [];
  return [...configuredWorkers, ...directExtensions];
}

export function getRinDaemonRuntimeRoot(agentDir: string): string {
  return path.join(agentDir, "data", "daemon-runtime");
}

export function ensureRuntimeImporter(runtimeRoot: string, fileName: string) {
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const importerPath = path.join(runtimeRoot, fileName);
  if (!fs.existsSync(importerPath)) {
    fs.writeFileSync(
      importerPath,
      "export async function importProvider(specifier) { return await import(specifier); }\n",
      "utf8",
    );
  }
  return importerPath;
}
