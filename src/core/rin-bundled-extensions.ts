import path from "node:path";
import { fileURLToPath } from "node:url";

import { safeString } from "./text-utils.js";

const BUNDLED_RIN_EXTENSION_DIRS: Record<string, string> = {
  "rin:browser-use": "rin-browser-use",
  "rin:computer-use": "rin-computer-use",
  "rin:heartbeat-notifier": "rin-heartbeat-notifier",
};

function getRepoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

export function resolveBundledRinExtensionPath(name: string) {
  const extensionDir = BUNDLED_RIN_EXTENSION_DIRS[name];
  if (!extensionDir) return "";
  return path.join(getRepoRoot(), "extensions", extensionDir);
}

export function expandBundledRinExtensionEntry(entry: string) {
  const text = safeString(entry).trim();
  if (!text) return text;
  const marker = ["!", "+", "-"].includes(text[0]) ? text[0] : "";
  const name = marker ? text.slice(1) : text;
  const extensionPath = resolveBundledRinExtensionPath(name);
  if (!extensionPath) return text;
  if (!marker) return extensionPath;
  return `${marker}${path.join(extensionPath, "index.ts")}`;
}

export function expandBundledRinExtensionEntries(entries: unknown) {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => expandBundledRinExtensionEntry(String(entry)));
}

function expandSettingsExtensions(settings: any) {
  if (!settings || typeof settings !== "object") return settings;
  if (!Array.isArray(settings.extensions)) return settings;
  return {
    ...settings,
    extensions: expandBundledRinExtensionEntries(settings.extensions),
  };
}

function applyBundledRinExtensionAliasOverrides(settingsManager: any) {
  if (
    !settingsManager ||
    typeof settingsManager.getExtensionPaths !== "function"
  ) {
    return;
  }
  const current = settingsManager.getExtensionPaths();
  const expanded = expandBundledRinExtensionEntries(current);
  if (
    expanded.length === current.length &&
    expanded.every((value, index) => value === current[index])
  ) {
    return;
  }
  settingsManager.applyOverrides({ extensions: expanded });
}

export function applyBundledRinExtensionAliases(settingsManager: any) {
  if (!settingsManager || settingsManager.__rinBundledExtensionAliasesApplied) {
    return;
  }
  settingsManager.__rinBundledExtensionAliasesApplied = true;
  const getGlobalSettings =
    settingsManager.getGlobalSettings?.bind(settingsManager);
  if (getGlobalSettings) {
    settingsManager.getGlobalSettings = () =>
      expandSettingsExtensions(getGlobalSettings());
  }
  const getProjectSettings =
    settingsManager.getProjectSettings?.bind(settingsManager);
  if (getProjectSettings) {
    settingsManager.getProjectSettings = () =>
      expandSettingsExtensions(getProjectSettings());
  }
  const reload = settingsManager.reload?.bind(settingsManager);
  if (reload) {
    settingsManager.reload = async () => {
      await reload();
      applyBundledRinExtensionAliasOverrides(settingsManager);
    };
  }
  applyBundledRinExtensionAliasOverrides(settingsManager);
}
