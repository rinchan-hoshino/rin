import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  BUILT_IN_RIN_EXTENSIONS,
  isBuiltInRinExtensionEnabled,
  resolveBundledRinExtensionPath,
  setBuiltInRinExtensionEnabled,
  type BuiltInRinExtensionId,
} from "./rin-bundled-extensions.js";

export { BUILT_IN_RIN_EXTENSIONS, type BuiltInRinExtensionId };

export type BuiltInRinExtensionLifecycleStatus = {
  status: string;
  detail?: string;
  data?: unknown;
};

export type BuiltInRinExtensionState = {
  id: BuiltInRinExtensionId;
  label: string;
  description: string;
  enabled: boolean;
  lifecycle?: BuiltInRinExtensionLifecycleStatus;
};

type BuiltInExtensionLifecycle = {
  status?: (context: {
    agentDir?: string;
  }) =>
    | Promise<BuiltInRinExtensionLifecycleStatus>
    | BuiltInRinExtensionLifecycleStatus;
  install?: (context: {
    agentDir?: string;
    logger?: { info?: (message: string) => void };
  }) => Promise<unknown> | unknown;
  start?: (context: {
    agentDir?: string;
    logger?: { info?: (message: string) => void };
  }) => Promise<unknown> | unknown;
  stop?: (context: {
    agentDir?: string;
    logger?: { info?: (message: string) => void };
  }) => Promise<unknown> | unknown;
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

async function loadBuiltInExtensionLifecycle(
  id: BuiltInRinExtensionId,
): Promise<BuiltInExtensionLifecycle | null> {
  const extensionPath = resolveBundledRinExtensionPath(id);
  if (!extensionPath) return null;
  const entrypoint = path.join(extensionPath, "index.ts");
  const mod = await import(pathToFileURL(entrypoint).href);
  return (mod.builtInExtensionLifecycle ||
    null) as BuiltInExtensionLifecycle | null;
}

function extensionStateBase(
  definition: (typeof BUILT_IN_RIN_EXTENSIONS)[number],
  entries: string[],
): BuiltInRinExtensionState {
  return {
    id: definition.id,
    label: definition.label,
    description: definition.description,
    enabled: isBuiltInRinExtensionEnabled(entries, definition.id),
  };
}

export function listBuiltInRinExtensionStates(
  settingsManager: any,
): BuiltInRinExtensionState[] {
  const entries = rawGlobalExtensionPaths(settingsManager);
  return BUILT_IN_RIN_EXTENSIONS.map((definition) =>
    extensionStateBase(definition, entries),
  );
}

export async function listBuiltInRinExtensionStatesWithLifecycle(
  settingsManager: any,
): Promise<BuiltInRinExtensionState[]> {
  const entries = rawGlobalExtensionPaths(settingsManager);
  const agentDir = settingsManagerAgentDir(settingsManager);
  return await Promise.all(
    BUILT_IN_RIN_EXTENSIONS.map(async (definition) => {
      const state = extensionStateBase(definition, entries);
      const lifecycle = await loadBuiltInExtensionLifecycle(
        definition.id,
      ).catch(() => null);
      if (lifecycle?.status) {
        state.lifecycle = await lifecycle
          .status({ agentDir })
          .catch((error) => ({
            status: "error",
            detail: String(error?.message || error || "status_failed"),
          }));
      }
      return state;
    }),
  );
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
  const agentDir = options.agentDir || settingsManagerAgentDir(settingsManager);
  const lifecycle = await loadBuiltInExtensionLifecycle(definition.id).catch(
    () => null,
  );
  if (enabled) {
    if (lifecycle?.install || lifecycle?.start) {
      await lifecycle.install?.({ agentDir });
      await lifecycle.start?.({ agentDir });
    } else {
      await definition.onEnable?.({ agentDir });
    }
  } else {
    await lifecycle?.stop?.({ agentDir });
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
