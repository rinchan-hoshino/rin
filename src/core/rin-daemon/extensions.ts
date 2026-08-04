import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { applyBundledRinExtensionAliases } from "../rin-bundled-extensions.js";
import {
  ensureRuntimeImporter,
  getRinExtensionRuntimeRoot,
  listRinDaemonExtensionConfigs,
  readRuntimeSettings,
  type RinDaemonExtensionConfig,
} from "../rin-extension-settings.js";
import { loadRinAgentRuntime } from "../rin-lib/agent-runtime.js";
import { resolveRuntimePackageAliases } from "../rin-lib/jiti-aliases.js";
import type {
  ChatRuntimeExternalAdapterEntry,
  ChatRuntimeExternalAdapterProvider,
} from "../chat-runtime/index.js";
import {
  normalizeExternalMemoryLimit,
  normalizeExternalMemoryResults,
} from "../memory/external-results.js";
import type {
  ExternalMemoryResult,
  TranscriptArchiveEntry,
} from "../memory/transcript-types.js";
import { ensureDir, stringifyJson } from "../platform/fs.js";
import { sleep } from "../platform/process.js";
import { safeString } from "../text-utils.js";
import type {
  RinBackgroundServiceContext,
  RinBackgroundServiceFactory as BackgroundServiceFactory,
  RinBackgroundServiceProvider as BackgroundServiceProvider,
  RinBackgroundServiceStop as BackgroundServiceStop,
  RinDaemonExtensionAPI,
  RinDaemonMemoryProvider,
  RinDaemonMemoryProviderContext,
  RinDaemonMemorySearchRequest,
  RinExtensionLogger,
} from "../rin-extension-api.js";

type RunningWorker = {
  entry: RinDaemonExtensionConfig;
  controller: AbortController;
  stop?: () => Promise<void> | void;
  tasks: Set<Promise<void>>;
};

type RinDaemonMemoryProviderEntry = {
  key: string;
  name: string;
  packageName: string;
  config: Record<string, any>;
  provider: RinDaemonMemoryProvider;
  logger: RinExtensionLogger;
};

function buildRuntimePackage(dependencies: Record<string, string>) {
  return {
    private: true,
    type: "module",
    dependencies,
  };
}

function dependencyInstallPath(runtimeRoot: string, packageName: string) {
  const parts = packageName.startsWith("@")
    ? packageName.split("/")
    : [packageName];
  return path.join(runtimeRoot, "node_modules", ...parts);
}

function shouldInstallDaemonExtensionDependencies(
  runtimeRoot: string,
  dependencies: Record<string, string>,
) {
  if (!Object.keys(dependencies).length) return false;
  const packageJsonPath = path.join(runtimeRoot, "package.json");
  const lockPath = path.join(runtimeRoot, "package-lock.json");
  const expectedText = stringifyJson(buildRuntimePackage(dependencies));
  const currentText = fs.existsSync(packageJsonPath)
    ? fs.readFileSync(packageJsonPath, "utf8")
    : "";
  if (currentText !== expectedText) return true;
  if (!fs.existsSync(lockPath)) return true;
  return Object.keys(dependencies).some(
    (packageName) =>
      !fs.existsSync(dependencyInstallPath(runtimeRoot, packageName)),
  );
}

export function ensureDaemonExtensionDependencies(
  agentDir: string,
  entries: RinDaemonExtensionConfig[],
) {
  const dependencies = Object.fromEntries(
    entries
      .filter((entry) => !entry.modulePath)
      .map((entry) => [entry.packageName, entry.version || "latest"] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const runtimeRoot = getRinExtensionRuntimeRoot(agentDir);
  if (!shouldInstallDaemonExtensionDependencies(runtimeRoot, dependencies)) {
    return runtimeRoot;
  }
  ensureDir(runtimeRoot);
  fs.writeFileSync(
    path.join(runtimeRoot, "package.json"),
    stringifyJson(buildRuntimePackage(dependencies)),
    "utf8",
  );
  execFileSync(
    "npm",
    ["install", "--omit=dev", "--no-audit", "--no-fund", "--legacy-peer-deps"],
    {
      cwd: runtimeRoot,
      stdio: "pipe",
      timeout: 120_000,
    },
  );
  return runtimeRoot;
}

const requireFromHere = createRequire(import.meta.url);

function readJson(filePath: string) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function resolveJitiStaticPath() {
  try {
    return path.join(
      path.dirname(requireFromHere.resolve("jiti/package.json")),
      "lib",
      "jiti-static.mjs",
    );
  } catch {
    return path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "node_modules",
      "jiti",
      "lib",
      "jiti-static.mjs",
    );
  }
}

async function importDaemonExtensionPath(modulePath: string) {
  if (modulePath.endsWith(".ts")) {
    const { createJiti } = await import(
      pathToFileURL(resolveJitiStaticPath()).href
    );
    const jiti = createJiti(import.meta.url, {
      moduleCache: false,
      alias: resolveRuntimePackageAliases({ includeDevDependencies: true }),
    });
    return await jiti.import(modulePath, { default: false });
  }
  return await import(pathToFileURL(modulePath).href);
}

async function importDaemonExtensionModule(
  runtimeRoot: string,
  entry: RinDaemonExtensionConfig,
) {
  if (entry.modulePath)
    return await importDaemonExtensionPath(entry.modulePath);
  const { packageName } = entry;
  try {
    const importerPath = ensureRuntimeImporter(
      runtimeRoot,
      ".rin-extension-importer.mjs",
    );
    const importer = await import(pathToFileURL(importerPath).href);
    return await importer.importProvider(packageName);
  } catch (error: any) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    const requireFromRuntimeRoot = createRequire(
      path.join(runtimeRoot, "package.json"),
    );
    return await import(
      pathToFileURL(requireFromRuntimeRoot.resolve(packageName)).href
    );
  }
}

function createDaemonExtensionApi(
  context: RinBackgroundServiceContext,
  services: BackgroundServiceProvider[],
  registerChatAdapter: RinDaemonExtensionAPI["registerChatAdapter"],
  registerMemoryProvider: RinDaemonExtensionAPI["registerMemoryProvider"],
): RinDaemonExtensionAPI {
  return {
    cwd: context.cwd,
    agentDir: context.agentDir,
    dataDir: context.dataDir,
    runtimeRoot: context.runtimeRoot,
    name: context.name,
    packageName: context.packageName,
    config: context.config,
    logger: context.logger,
    registerBackgroundService: (provider) => {
      if (typeof provider === "function") {
        services.push({ start: provider });
        return;
      }
      if (!provider || typeof provider !== "object") return;
      if (typeof provider.start !== "function") return;
      services.push(provider);
    },
    registerChatAdapter,
    registerMemoryProvider,
  };
}

async function collectDaemonExtensionRegistrations(
  moduleValue: any,
  context: RinBackgroundServiceContext,
  registerChatAdapter: RinDaemonExtensionAPI["registerChatAdapter"],
  registerMemoryProvider: RinDaemonExtensionAPI["registerMemoryProvider"],
): Promise<{ services: BackgroundServiceProvider[]; handled: boolean }> {
  const extensionFactory = moduleValue?.rinDaemonExtension;
  if (typeof extensionFactory !== "function") {
    return { services: [], handled: false };
  }
  const services: BackgroundServiceProvider[] = [];
  await extensionFactory(
    createDaemonExtensionApi(
      context,
      services,
      registerChatAdapter,
      registerMemoryProvider,
    ),
  );
  return { services, handled: true };
}

function createWorkerLogger(
  base: RinExtensionLogger | undefined,
  entry: RinDaemonExtensionConfig,
): RinExtensionLogger {
  const prefix = `daemon-extension:${entry.name}`;
  return {
    info: (message) => base?.info?.(`${prefix}: ${message}`),
    warn: (message) => base?.warn?.(`${prefix}: ${message}`),
    error: (message) => base?.error?.(`${prefix}: ${message}`),
  };
}

function normalizeEntryName(value: string) {
  return safeString(value)
    .trim()
    .replace(/^@/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-");
}

function nearestPackageRoot(startPath: string) {
  let dir =
    fs.existsSync(startPath) && fs.statSync(startPath).isDirectory()
      ? startPath
      : path.dirname(startPath);
  while (true) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.dirname(startPath);
    dir = parent;
  }
}

function daemonExtensionEntryFromResolvedExtension(
  entry: any,
): RinDaemonExtensionConfig | null {
  if (!entry?.enabled) return null;
  const modulePath = safeString(entry.path).trim();
  if (!modulePath) return null;
  const baseDir =
    safeString(entry.metadata?.baseDir).trim() ||
    nearestPackageRoot(modulePath);
  const pkg = readJson(path.join(baseDir, "package.json"));
  const metadataSource = safeString(entry.metadata?.source).trim();
  const packageName =
    safeString(pkg?.name).trim() ||
    (entry.metadata?.origin === "package" && metadataSource !== "auto"
      ? metadataSource
      : "") ||
    modulePath;
  return {
    name:
      packageName === modulePath
        ? normalizeEntryName(path.basename(modulePath))
        : normalizeEntryName(packageName) ||
          normalizeEntryName(path.basename(modulePath)),
    packageName,
    version: "",
    config: {},
    optional: true,
    modulePath,
  };
}

async function listPiResolvedDaemonExtensionConfigs(options: {
  cwd: string;
  agentDir: string;
}): Promise<RinDaemonExtensionConfig[]> {
  const agentRuntimeModule = await loadRinAgentRuntime();
  const { DefaultPackageManager, SettingsManager } = agentRuntimeModule as any;
  const settingsManager = SettingsManager.create(options.cwd, options.agentDir);
  applyBundledRinExtensionAliases(settingsManager);
  const packageManager = new DefaultPackageManager({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
  });
  const resolved = await packageManager.resolve();
  return (resolved.extensions || [])
    .map((entry: any) => daemonExtensionEntryFromResolvedExtension(entry))
    .filter(
      (
        entry: RinDaemonExtensionConfig | null,
      ): entry is RinDaemonExtensionConfig => Boolean(entry),
    );
}

function listAutoDiscoveredDaemonExtensionConfigs(options: {
  cwd: string;
}): RinDaemonExtensionConfig[] {
  const extensionsDir = path.join(options.cwd, "extensions");
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const modulePath = path.join(extensionsDir, entry.name, "index.js");
    if (!fs.existsSync(modulePath)) return [];
    const daemonExtensionEntry = daemonExtensionEntryFromResolvedExtension({
      enabled: true,
      path: modulePath,
      metadata: { source: "auto", baseDir: path.dirname(modulePath) },
    });
    return daemonExtensionEntry ? [daemonExtensionEntry] : [];
  });
}

function shouldResolvePiDaemonExtensions(settings: unknown, agentDir: string) {
  const value = settings as any;
  if (Array.isArray(value?.extensions) && value.extensions.length > 0)
    return true;
  if (Array.isArray(value?.packages) && value.packages.length > 0) return true;
  return fs.existsSync(path.join(agentDir, "extensions"));
}

function dedupeDaemonExtensionEntries(entries: RinDaemonExtensionConfig[]) {
  const seen = new Set<string>();
  const result: RinDaemonExtensionConfig[] = [];
  for (const entry of entries) {
    const key = entry.modulePath
      ? `module:${path.resolve(entry.modulePath)}`
      : `package:${entry.packageName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

export class RinDaemonExtensionManager {
  private readonly workers: RunningWorker[] = [];
  private readonly chatAdapters: ChatRuntimeExternalAdapterEntry[] = [];
  private readonly memoryProviders: RinDaemonMemoryProviderEntry[] = [];

  constructor(
    private readonly options: {
      cwd: string;
      agentDir: string;
      logger?: RinExtensionLogger;
    },
  ) {}

  async start() {
    this.chatAdapters.length = 0;
    this.memoryProviders.length = 0;
    const runtimeSettings = readRuntimeSettings(this.options.agentDir);
    const explicitEntries = listRinDaemonExtensionConfigs(runtimeSettings);
    const autoDiscoveredEntries = listAutoDiscoveredDaemonExtensionConfigs({
      cwd: this.options.cwd,
    });
    let piResolvedEntries: RinDaemonExtensionConfig[] = [];
    if (
      shouldResolvePiDaemonExtensions(runtimeSettings, this.options.agentDir)
    ) {
      try {
        piResolvedEntries = await listPiResolvedDaemonExtensionConfigs(
          this.options,
        );
      } catch (error: any) {
        this.options.logger?.warn?.(
          `daemon extension package resolution failed err=${safeString(
            error?.message || error,
          )}`,
        );
      }
    }
    const entries = dedupeDaemonExtensionEntries([
      ...explicitEntries,
      ...autoDiscoveredEntries,
      ...piResolvedEntries,
    ]);
    if (!entries.length) return [];
    let runtimeRoot: string;
    try {
      runtimeRoot = ensureDaemonExtensionDependencies(
        this.options.agentDir,
        entries,
      );
    } catch (error: any) {
      this.options.logger?.warn?.(
        `daemon extension dependency install failed err=${safeString(
          error?.stderr || error?.stdout || error?.message || error,
        )}`,
      );
      return [];
    }
    const started: Array<{ name: string; packageName: string }> = [];
    for (const entry of entries) {
      const beforeChatAdapterCount = this.chatAdapters.length;
      const beforeMemoryProviderCount = this.memoryProviders.length;
      const controller = new AbortController();
      const tasks = new Set<Promise<void>>();
      const stopHandlers: Array<() => Promise<void> | void> = [];
      try {
        const moduleValue = await importDaemonExtensionModule(
          runtimeRoot,
          entry,
        );
        const running: RunningWorker = { entry, controller, tasks };
        const logger = createWorkerLogger(this.options.logger, entry);
        const context: RinBackgroundServiceContext = {
          cwd: this.options.cwd,
          agentDir: this.options.agentDir,
          dataDir: path.join(this.options.agentDir, "data"),
          runtimeRoot,
          name: entry.name,
          packageName: entry.packageName,
          config: entry.config,
          signal: controller.signal,
          logger,
          runAsync: (label, work) => {
            const task = Promise.resolve()
              .then(work)
              .catch((error: any) => {
                logger.warn?.(
                  `async task failed label=${safeString(label)} err=${safeString(
                    error?.message || error,
                  )}`,
                );
              })
              .finally(() => tasks.delete(task));
            tasks.add(task);
          },
        };
        const registerChatAdapter: RinDaemonExtensionAPI["registerChatAdapter"] =
          (provider, options = {}) => {
            const key = safeString(options.key).trim() || entry.name;
            const name = safeString(options.name).trim() || key;
            this.chatAdapters.push({
              key,
              name,
              packageName: entry.packageName,
              config: (options.config || entry.config) as Record<string, any>,
              provider: provider as ChatRuntimeExternalAdapterProvider,
            });
          };
        const registerMemoryProvider: RinDaemonExtensionAPI["registerMemoryProvider"] =
          (provider, options = {}) => {
            if (
              !provider ||
              (typeof provider.search !== "function" &&
                typeof provider.listRecent !== "function" &&
                typeof provider.write !== "function")
            ) {
              return;
            }
            const key = safeString(options.key).trim() || entry.name;
            const name = safeString(options.name).trim() || key;
            this.memoryProviders.push({
              key,
              name,
              packageName: entry.packageName,
              config: (options.config || entry.config) as Record<string, any>,
              provider,
              logger,
            });
          };
        const { services, handled } = await collectDaemonExtensionRegistrations(
          moduleValue,
          context,
          registerChatAdapter,
          registerMemoryProvider,
        );
        if (!handled && entry.optional) continue;
        if (!handled) throw new Error("daemon_extension_entrypoint_missing");
        for (const service of services) {
          const result = await service.start?.(context);
          if (result && typeof result === "object" && result.stop) {
            stopHandlers.push(result.stop.bind(result));
          }
        }
        if (stopHandlers.length) {
          running.stop = async () => {
            for (const stop of [...stopHandlers].reverse()) await stop();
          };
        }
        if (
          services.length ||
          this.chatAdapters.length > beforeChatAdapterCount ||
          this.memoryProviders.length > beforeMemoryProviderCount
        ) {
          this.workers.push(running);
          started.push({ name: entry.name, packageName: entry.packageName });
        }
      } catch (error: any) {
        this.chatAdapters.length = beforeChatAdapterCount;
        this.memoryProviders.length = beforeMemoryProviderCount;
        controller.abort();
        for (const stop of [...stopHandlers].reverse()) {
          try {
            await stop();
          } catch {}
        }
        if (tasks.size > 0) {
          await Promise.race([
            Promise.allSettled([...tasks]),
            sleep(1_000),
          ]).catch(() => {});
        }
        this.options.logger?.warn?.(
          `daemon extension init failed name=${entry.name} package=${entry.packageName} err=${safeString(
            error?.message || error,
          )}`,
        );
      }
    }
    return started;
  }

  getChatAdapterProviders() {
    return [...this.chatAdapters];
  }

  getMemoryProviderMetadata() {
    return this.memoryProviders.map((entry) => ({
      key: entry.key,
      name: entry.name,
      packageName: entry.packageName,
    }));
  }

  private createMemoryProviderContext(
    entry: RinDaemonMemoryProviderEntry,
  ): RinDaemonMemoryProviderContext {
    return {
      cwd: this.options.cwd,
      agentDir: this.options.agentDir,
      dataDir: path.join(this.options.agentDir, "data"),
      runtimeRoot: getRinExtensionRuntimeRoot(this.options.agentDir),
      key: entry.key,
      name: entry.name,
      packageName: entry.packageName,
      config: entry.config,
      logger: entry.logger,
    };
  }

  async recallProviders(params: Record<string, any> = {}) {
    const query = safeString(params.query || "").trim();
    const limit = normalizeExternalMemoryLimit(params.limit, 8);
    const mode = query ? "search" : "recent";
    const request: RinDaemonMemorySearchRequest = {
      mode,
      query,
      limit,
      params: { ...(params || {}), query, limit },
    };
    const groups = await Promise.all(
      this.memoryProviders.map(async (entry) => {
        const search =
          mode === "recent" ? entry.provider.listRecent : entry.provider.search;
        if (typeof search !== "function") return [];
        try {
          const result = await search.call(
            entry.provider,
            request,
            this.createMemoryProviderContext(entry),
          );
          return normalizeExternalMemoryResults(result, {
            provider: entry.key,
            providerName: entry.name,
            startScore: limit,
          });
        } catch (error: any) {
          entry.logger.warn?.(
            `memory provider search failed key=${entry.key} err=${safeString(
              error?.message || error,
            )}`,
          );
          return [];
        }
      }),
    );
    return groups.flat();
  }

  async writeMemoryProviders(entry: Record<string, any>) {
    const text = safeString(entry?.text || "").trim();
    const role = safeString(entry?.role || "").trim();
    if (!text || !role) return { written: 0, providerCount: 0 };
    const writableProviders = this.memoryProviders.filter(
      (providerEntry) => typeof providerEntry.provider.write === "function",
    );
    let written = 0;
    await Promise.all(
      writableProviders.map(async (providerEntry) => {
        try {
          await providerEntry.provider.write?.(
            entry as TranscriptArchiveEntry,
            this.createMemoryProviderContext(providerEntry),
          );
          written += 1;
        } catch (error: any) {
          providerEntry.logger.warn?.(
            `memory provider write failed key=${providerEntry.key} err=${safeString(
              error?.message || error,
            )}`,
          );
        }
      }),
    );
    return { written, providerCount: writableProviders.length };
  }

  async stop(timeoutMs = 10_000) {
    const workers = [...this.workers].reverse();
    this.workers.length = 0;
    await Promise.all(
      workers.map(async (worker) => {
        worker.controller.abort();
        try {
          await worker.stop?.();
        } catch (error: any) {
          this.options.logger?.warn?.(
            `daemon extension stop failed name=${worker.entry.name} err=${safeString(
              error?.message || error,
            )}`,
          );
        }
        await Promise.race([
          Promise.allSettled([...worker.tasks]),
          sleep(timeoutMs),
        ]);
      }),
    );
  }
}
