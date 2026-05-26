import {
  BUILT_IN_RIN_EXTENSIONS,
  isBuiltInRinExtensionEnabled,
  setBuiltInRinExtensionEnabled,
  type BuiltInRinExtensionId,
} from "./rin-bundled-extensions.js";

export { BUILT_IN_RIN_EXTENSIONS, type BuiltInRinExtensionId };

export type BuiltInRinExtensionState = {
  id: BuiltInRinExtensionId;
  label: string;
  description: string;
  enabled: boolean;
};

function rawGlobalExtensionPaths(settingsManager: any): string[] {
  const raw = Array.isArray(settingsManager?.globalSettings?.extensions)
    ? settingsManager.globalSettings.extensions
    : undefined;
  if (raw) return raw.map((entry: unknown) => String(entry));
  const globalSettings = settingsManager?.getGlobalSettings?.();
  return Array.isArray(globalSettings?.extensions)
    ? globalSettings.extensions.map((entry: unknown) => String(entry))
    : [];
}

async function flushSettings(settingsManager: any) {
  await settingsManager?.flush?.();
}

export function listBuiltInRinExtensionStates(
  settingsManager: any,
): BuiltInRinExtensionState[] {
  const entries = rawGlobalExtensionPaths(settingsManager);
  return BUILT_IN_RIN_EXTENSIONS.map((definition) => ({
    id: definition.id,
    label: definition.label,
    description: definition.description,
    enabled: isBuiltInRinExtensionEnabled(entries, definition.id),
  }));
}

function settingsManagerAgentDir(settingsManager: any) {
  return (
    String(settingsManager?.agentDir || "").trim() ||
    String(settingsManager?.storage?.agentDir || "").trim()
  );
}

export async function setBuiltInRinExtensionState(
  settingsManager: any,
  id: BuiltInRinExtensionId | string,
  enabled: boolean,
  options: { agentDir?: string } = {},
): Promise<BuiltInRinExtensionState> {
  const definition = BUILT_IN_RIN_EXTENSIONS.find((entry) => entry.id === id);
  if (!definition) throw new Error(`Unknown built-in Rin extension: ${id}`);
  const entries = setBuiltInRinExtensionEnabled(
    rawGlobalExtensionPaths(settingsManager),
    definition.id,
    enabled,
  );
  settingsManager?.setExtensionPaths?.(entries);
  if (enabled) {
    await definition.onEnable?.({
      agentDir: options.agentDir || settingsManagerAgentDir(settingsManager),
    });
  }
  await flushSettings(settingsManager);
  return {
    id: definition.id,
    label: definition.label,
    description: definition.description,
    enabled,
  };
}

export async function enableBuiltInRinExtension(
  settingsManager: any,
  id: BuiltInRinExtensionId | string,
) {
  return await setBuiltInRinExtensionState(settingsManager, id, true);
}

export async function disableBuiltInRinExtension(
  settingsManager: any,
  id: BuiltInRinExtensionId | string,
) {
  return await setBuiltInRinExtensionState(settingsManager, id, false);
}
