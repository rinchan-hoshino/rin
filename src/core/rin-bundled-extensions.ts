import path from "node:path";
import { fileURLToPath } from "node:url";

import { safeString } from "./text-utils.js";

export type BuiltInRinExtensionId = "rin:web-search";

export type BuiltInRinExtensionDefinition = {
  id: BuiltInRinExtensionId;
  label: string;
  description: string;
  directory: string;
  defaultEnabled?: boolean;
  installOnEnable?: boolean;
  onEnable?: (context: { agentDir?: string }) => Promise<void> | void;
};

export const BUILT_IN_RIN_EXTENSIONS: BuiltInRinExtensionDefinition[] = [
  {
    id: "rin:web-search",
    label: "Web search",
    description:
      "Adds the web_search tool and prepares Rin-managed SearXNG when enabled.",
    directory: "rin-web-search",
    defaultEnabled: true,
    installOnEnable: true,
    async onEnable(context) {
      const agentDir = String(context.agentDir || "").trim();
      if (!agentDir) return;
      const { prepareSearxngRuntime } =
        await import("./rin-web-search/service.js");
      await prepareSearxngRuntime(agentDir).catch(() => undefined);
    },
  },
];

const BUNDLED_RIN_EXTENSION_DIRS: Record<string, string> = Object.fromEntries(
  BUILT_IN_RIN_EXTENSIONS.map((entry) => [entry.id, entry.directory]),
);

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

function stripEntryMarker(entry: string) {
  const text = safeString(entry).trim();
  const marker = ["!", "+", "-"].includes(text[0]) ? text[0] : "";
  return { marker, value: marker ? text.slice(1) : text };
}

function builtInEntryMatches(entry: string, id: BuiltInRinExtensionId) {
  const { value } = stripEntryMarker(entry);
  if (value === id) return true;
  const extensionPath = resolveBundledRinExtensionPath(id);
  return (
    value === extensionPath ||
    value === path.join(extensionPath, "index.ts") ||
    value === path.join(extensionPath, "index.js")
  );
}

export function isBuiltInRinExtensionEnabled(
  entries: unknown,
  id: BuiltInRinExtensionId,
) {
  if (!Array.isArray(entries)) return false;
  let enabled = false;
  for (const rawEntry of entries) {
    const text = safeString(rawEntry).trim();
    if (!text || !builtInEntryMatches(text, id)) continue;
    const { marker } = stripEntryMarker(text);
    enabled = marker !== "!" && marker !== "-";
  }
  return enabled;
}

export function setBuiltInRinExtensionEnabled(
  entries: unknown,
  id: BuiltInRinExtensionId,
  enabled: boolean,
) {
  const current = Array.isArray(entries)
    ? entries.map((entry) => safeString(entry).trim()).filter(Boolean)
    : [];
  const withoutTarget = current.filter(
    (entry) => !builtInEntryMatches(entry, id),
  );
  return enabled ? [...withoutTarget, id] : withoutTarget;
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
