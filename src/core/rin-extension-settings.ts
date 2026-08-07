import path from "node:path";

import { cloneJson, isJsonRecord } from "./json-utils.js";
import { readJsonFile } from "./platform/fs.js";
import { safeString } from "./text-utils.js";

export type RinDaemonExtensionConfig = {
  name: string;
  packageName: string;
  version: string;
  config: Record<string, any>;
  optional?: boolean;
  modulePath?: string;
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

function normalizeDaemonExtensionConfig(
  value: unknown,
): RinDaemonExtensionConfig | null {
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

export function listRinDaemonExtensionConfigs(
  settings: unknown,
): RinDaemonExtensionConfig[] {
  const root = getRinExtensionRoot(settings);
  const configured = Array.isArray(root.daemon) ? root.daemon : [];
  const configuredExtensions = configured
    .map((entry) => normalizeDaemonExtensionConfig(entry))
    .filter((entry): entry is RinDaemonExtensionConfig => Boolean(entry));
  return configuredExtensions;
}
