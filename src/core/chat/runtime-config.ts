import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { listChatBridgeAdapterSpecs } from "../chat-bridge/adapters.js";
import { cloneJson, isJsonRecord } from "../json-utils.js";
import { ensureDir, writeJsonFile } from "../platform/fs.js";
import { safeString } from "../text-utils.js";
import { getStoredChatConfigRoot } from "./settings.js";

type AdapterEntry = {
  name: string;
  config: Record<string, any>;
};

type NormalizedChatRuntimeAdapter = {
  key: string;
  pluginKey: string;
  entries: AdapterEntry[];
};

type ChatRuntimePackageJson = {
  name: string;
  private: boolean;
  version: string;
  dependencies: Record<string, string>;
};

type ChatRuntimeAdapterSource = {
  key: string;
  pluginKey: string;
  value: unknown;
  defaults: Record<string, any>;
};

const SETUP_ONLY_ADAPTER_FIELDS = new Set([
  "name",
  "owners",
  "ownerUserIds",
  "botId",
]);

const SINGLE_ADAPTER_CONFIG_KEYS = new Set([
  "name",
  "enabled",
  "endpoint",
  "selfId",
  "token",
  "protocol",
  "slash",
  "owners",
  "ownerUserIds",
  "botId",
]);

function normalizeChatAdapterConfig(
  value: unknown,
  defaults: Record<string, any> = {},
) {
  const current = isJsonRecord(value) ? cloneJson(value) : {};
  return { ...defaults, ...current };
}

function stripAdapterSetupFields(config: Record<string, any>) {
  const normalized = { ...config };
  for (const key of SETUP_ONLY_ADAPTER_FIELDS) {
    delete normalized[key];
  }
  return normalized;
}

function sanitizeAdapterName(value: unknown, fallback: string) {
  const raw = safeString(value)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-");
  return raw || fallback;
}

function looksLikeSingleAdapterConfig(value: unknown) {
  if (!isJsonRecord(value)) return false;
  const keys = Object.keys(value);
  if (!keys.length) return true;
  if (keys.some((key) => SINGLE_ADAPTER_CONFIG_KEYS.has(key))) return true;
  return keys.some((key) => !isJsonRecord(value[key]));
}

function collectRawAdapterEntries(
  value: unknown,
  fallbackPrefix: string,
): AdapterEntry[] {
  const rawEntries: AdapterEntry[] = [];

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      if (!isJsonRecord(entry)) return;
      rawEntries.push({
        name: sanitizeAdapterName(entry.name, `${fallbackPrefix}-${index + 1}`),
        config: cloneJson(entry),
      });
    });
    return rawEntries;
  }

  if (looksLikeSingleAdapterConfig(value)) {
    rawEntries.push({
      name: sanitizeAdapterName(
        isJsonRecord(value) ? value.name : undefined,
        fallbackPrefix,
      ),
      config: isJsonRecord(value) ? cloneJson(value) : {},
    });
    return rawEntries;
  }

  if (isJsonRecord(value)) {
    for (const [name, entry] of Object.entries(value)) {
      if (!isJsonRecord(entry)) continue;
      rawEntries.push({
        name: sanitizeAdapterName(
          entry.name || name,
          safeString(name) || fallbackPrefix,
        ),
        config: cloneJson(entry),
      });
    }
  }

  return rawEntries;
}

function normalizeAdapterEntries(
  value: unknown,
  defaults: Record<string, any>,
  fallbackPrefix: string,
): AdapterEntry[] {
  return collectRawAdapterEntries(value, fallbackPrefix)
    .filter((entry) => entry.config.enabled !== false)
    .map((entry) => ({
      name: entry.name,
      config: stripAdapterSetupFields(
        normalizeChatAdapterConfig(entry.config, defaults),
      ),
    }));
}

function applyNormalizedAdapterEntries(
  plugins: Record<string, any>,
  baseName: string,
  entries: AdapterEntry[],
) {
  if (!entries.length) return;
  entries.forEach((entry, index) => {
    const key =
      index === 0 ? baseName : `${baseName}:${entry.name || index + 1}`;
    plugins[key] = entry.config;
  });
}

function collectBuiltInChatAdapterSources(
  chat: Record<string, any> | undefined,
): ChatRuntimeAdapterSource[] {
  return listChatBridgeAdapterSpecs().map((adapter) => ({
    key: adapter.key,
    pluginKey: adapter.pluginKey,
    value: chat?.[adapter.key],
    defaults: adapter.defaults,
  }));
}

function normalizeChatRuntimeAdapter(
  source: ChatRuntimeAdapterSource,
): NormalizedChatRuntimeAdapter {
  return {
    key: source.key,
    pluginKey: source.pluginKey,
    entries: normalizeAdapterEntries(source.value, source.defaults, source.key),
  };
}

function collectRuntimeDependencies(): Record<string, string> {
  return {};
}

function buildNormalizedChatRuntime(settings: unknown) {
  const chat = getStoredChatConfigRoot(settings);
  const adapters = collectBuiltInChatAdapterSources(chat).map((adapter) =>
    normalizeChatRuntimeAdapter(adapter),
  );

  return {
    adapters,
    dependencies: collectRuntimeDependencies(),
  };
}

export function buildChatConfigFromSettings(settings: unknown) {
  const config = {
    name: "rin",
    prefix: ["/"],
    prefixMode: "strict",
    plugins: {
      "proxy-agent": {},
      http: {},
    } as Record<string, any>,
  };
  const runtime = buildNormalizedChatRuntime(settings);

  for (const adapter of runtime.adapters) {
    applyNormalizedAdapterEntries(
      config.plugins,
      adapter.pluginKey,
      adapter.entries,
    );
  }

  return config;
}

export type ChatRuntimeAdapterEntry = {
  key: string;
  name: string;
  config: Record<string, any>;
};

export function listChatRuntimeAdapterEntries(settings: unknown) {
  return buildNormalizedChatRuntime(settings).adapters.flatMap((adapter) =>
    adapter.entries.map((entry) => ({
      key: adapter.key,
      name: entry.name,
      config: entry.config,
    })),
  );
}

export function buildChatRuntimePackageJson(
  settings: unknown,
): ChatRuntimePackageJson {
  return {
    name: "rin-chat-runtime",
    private: true,
    version: "0.0.0",
    dependencies: buildNormalizedChatRuntime(settings).dependencies,
  };
}

function shouldInstallChatRuntimePackage(
  _rootDir: string,
  _runtimePackage: ChatRuntimePackageJson,
) {
  return false;
}

export function shouldInstallChatRuntimeDependencies(
  rootDir: string,
  settings: unknown,
) {
  return shouldInstallChatRuntimePackage(
    rootDir,
    buildChatRuntimePackageJson(settings),
  );
}

export function ensureChatRuntimeDependencies(
  rootDir: string,
  settings: unknown,
) {
  return {
    installed: false,
    dependencies: buildChatRuntimePackageJson(settings).dependencies,
    rootDir,
  };
}

export function materializeChatConfig(configPath: string, settings: unknown) {
  const rootDir = path.dirname(configPath);
  ensureDir(rootDir);
  const config = buildChatConfigFromSettings(settings);
  fs.writeFileSync(configPath, YAML.stringify(config), "utf8");
  const packageJsonPath = path.join(rootDir, "package.json");
  writeJsonFile(packageJsonPath, buildChatRuntimePackageJson(settings));
  return { configPath, config };
}
