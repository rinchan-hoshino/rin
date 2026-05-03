import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

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
  builtIn: boolean;
  packageName?: string;
  version?: string;
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
  builtIn: boolean;
  packageName?: string;
  version?: string;
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
    builtIn: true,
  }));
}

function normalizeCustomAdapterFallbackPrefix(
  adapter: Record<string, any>,
  pluginKey: string,
  packageName: string,
) {
  return (
    safeString(adapter.name).trim() ||
    pluginKey.replace(/^adapter-/, "") ||
    packageName.replace(/^@/, "").replace(/[^A-Za-z0-9._-]+/g, "-")
  );
}

function normalizeCustomChatAdapterSource(
  value: unknown,
): ChatRuntimeAdapterSource | null {
  if (!isJsonRecord(value)) return null;

  const packageName = safeString(value.packageName).trim();
  const version = safeString(value.version).trim() || "latest";
  const pluginKey = safeString(value.pluginKey).trim();
  const config = value.config;
  if (value.enabled === false || !packageName || !pluginKey || !config) {
    return null;
  }

  return {
    key: normalizeCustomAdapterFallbackPrefix(value, pluginKey, packageName),
    pluginKey,
    value: config,
    defaults: isJsonRecord(value.defaults) ? cloneJson(value.defaults) : {},
    builtIn: false,
    packageName,
    version,
  };
}

function collectCustomChatAdapterSources(
  chat: Record<string, any> | undefined,
): ChatRuntimeAdapterSource[] {
  const items = Array.isArray(chat?.customAdapters) ? chat.customAdapters : [];
  return items
    .map((item) => normalizeCustomChatAdapterSource(item))
    .filter((item): item is ChatRuntimeAdapterSource => Boolean(item));
}

function normalizeChatRuntimeAdapter(
  source: ChatRuntimeAdapterSource,
): NormalizedChatRuntimeAdapter {
  return {
    key: source.key,
    pluginKey: source.pluginKey,
    builtIn: source.builtIn,
    packageName: source.packageName,
    version: source.version,
    entries: normalizeAdapterEntries(source.value, source.defaults, source.key),
  };
}

function collectRuntimeDependencies(
  adapters: NormalizedChatRuntimeAdapter[],
): Record<string, string> {
  const dependencies = new Map<string, string>();

  for (const adapter of adapters) {
    if (!adapter.builtIn && adapter.packageName) {
      dependencies.set(adapter.packageName, adapter.version || "latest");
    }
  }

  return Object.fromEntries(
    [...dependencies.entries()].sort(([a], [b]) => a.localeCompare(b)),
  ) as Record<string, string>;
}

function buildNormalizedChatRuntime(settings: unknown) {
  const chat = getStoredChatConfigRoot(settings);
  const adapters = [
    ...collectBuiltInChatAdapterSources(chat),
    ...collectCustomChatAdapterSources(chat),
  ].map((adapter) => normalizeChatRuntimeAdapter(adapter));

  return {
    adapters,
    dependencies: collectRuntimeDependencies(adapters),
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
  builtIn: boolean;
  packageName?: string;
};

export function listChatRuntimeAdapterEntries(settings: unknown) {
  return buildNormalizedChatRuntime(settings).adapters.flatMap((adapter) =>
    adapter.entries.map((entry) => ({
      key: adapter.key,
      name: entry.name,
      config: entry.config,
      builtIn: adapter.builtIn,
      packageName: adapter.packageName,
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

function dependencyInstallPath(rootDir: string, packageName: string) {
  const normalized = safeString(packageName).trim();
  if (!normalized) return "";
  return path.join(rootDir, "node_modules", ...normalized.split("/"));
}

function shouldInstallChatRuntimePackage(
  rootDir: string,
  runtimePackage: ChatRuntimePackageJson,
) {
  const dependencies = runtimePackage.dependencies || {};
  if (!Object.keys(dependencies).length) return false;
  const packageJsonPath = path.join(rootDir, "package.json");
  const lockPath = path.join(rootDir, "package-lock.json");
  const expectedText = `${JSON.stringify(runtimePackage, null, 2)}\n`;
  const currentText = fs.existsSync(packageJsonPath)
    ? fs.readFileSync(packageJsonPath, "utf8")
    : "";
  if (currentText !== expectedText) return true;
  if (!fs.existsSync(lockPath)) return true;
  return Object.keys(dependencies).some(
    (packageName) =>
      !fs.existsSync(dependencyInstallPath(rootDir, packageName)),
  );
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
  const runtimePackage = buildChatRuntimePackageJson(settings);
  const dependencies = runtimePackage.dependencies || {};
  if (!Object.keys(dependencies).length) {
    return {
      installed: false,
      dependencies,
      rootDir,
    };
  }
  if (!shouldInstallChatRuntimePackage(rootDir, runtimePackage)) {
    return {
      installed: false,
      dependencies,
      rootDir,
    };
  }
  ensureDir(rootDir);
  const packageJsonPath = path.join(rootDir, "package.json");
  writeJsonFile(packageJsonPath, runtimePackage);
  try {
    execFileSync(
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        "--omit=dev",
        "--legacy-peer-deps",
      ],
      {
        cwd: rootDir,
        stdio: "pipe",
        encoding: "utf8",
        timeout: 120000,
      },
    );
  } catch (error: any) {
    const detail = safeString(
      error?.stderr || error?.stdout || error?.message || error,
    ).trim();
    throw new Error(`chat_runtime_install_failed${detail ? `:${detail}` : ""}`);
  }
  return {
    installed: true,
    dependencies,
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
