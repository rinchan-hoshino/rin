import fs from "node:fs";
import path from "node:path";
import { extensionDataPath } from "./data-layout.js";
import { resolveBundledRinExtensionPath } from "./rin-bundled-extensions.js";

import { cloneJson, isJsonRecord } from "./json-utils.js";
import { readJsonFile } from "./platform/fs.js";
import { safeString } from "./text-utils.js";

export type RinBackgroundExtensionConfig = {
  name: string;
  packageName: string;
  version: string;
  config: Record<string, any>;
  optional?: boolean;
  modulePath?: string;
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

function normalizeBackgroundExtensionConfig(
  value: unknown,
): RinBackgroundExtensionConfig | null {
  if (!isJsonRecord(value)) return null;
  if (value.enabled === false) return null;
  const packageName = safeString(value.packageName).trim();
  if (!packageName) return null;
  const bundledPath = resolveBundledRinExtensionPath(packageName);
  if (bundledPath) return null;
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

export function listRinBackgroundExtensionConfigs(
  settings: unknown,
  options: RinExtensionConfigOptions = {},
): RinBackgroundExtensionConfig[] {
  const root = getRinExtensionRoot(settings);
  const configured = Array.isArray(root.backgroundServices)
    ? root.backgroundServices
    : [];
  const configuredExtensions = configured
    .map((entry) => normalizeBackgroundExtensionConfig(entry))
    .filter((entry): entry is RinBackgroundExtensionConfig => Boolean(entry));
  return configuredExtensions;
}

export function getRinExtensionRuntimeRoot(agentDir: string): string {
  return extensionDataPath(agentDir, "runtime");
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
