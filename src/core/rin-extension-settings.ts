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

export function listRinDaemonWorkerConfigs(
  settings: unknown,
): RinExtensionWorkerConfig[] {
  const root = getRinExtensionRoot(settings);
  const workers = Array.isArray(root.daemonWorkers) ? root.daemonWorkers : [];
  return workers
    .map((entry) => normalizeWorkerConfig(entry))
    .filter((entry): entry is RinExtensionWorkerConfig => Boolean(entry));
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
