import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import {
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
  runtimeRoot: string;
  provider: RinDaemonMemoryProvider;
  logger: RinExtensionLogger;
};

const requireFromHere = createRequire(import.meta.url);

function readJson(filePath: string) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function resolveJitiStaticPath() {
  return path.join(
    path.dirname(requireFromHere.resolve("jiti/package.json")),
    "lib",
    "jiti-static.mjs",
  );
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

async function importDaemonExtensionModule(entry: RinDaemonExtensionConfig) {
  return await importDaemonExtensionPath(entry.modulePath!);
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
  const packageManager = new DefaultPackageManager({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
  });
  const resolved = await packageManager.resolve();
  return resolved.extensions
    .map((entry: any) => daemonExtensionEntryFromResolvedExtension(entry))
    .filter(
      (
        entry: RinDaemonExtensionConfig | null,
      ): entry is RinDaemonExtensionConfig => Boolean(entry),
    );
}

function hasConfiguredExtensionSources(settings: unknown) {
  if (!settings || typeof settings !== "object") return false;
  const value = settings as Record<string, unknown>;
  return [value.extensions, value.packages].some(
    (entries) => Array.isArray(entries) && entries.length > 0,
  );
}

function hasPiExtensionSources(
  settings: unknown,
  agentDir: string,
  cwd: string,
) {
  if (hasConfiguredExtensionSources(settings)) return true;
  const projectSettings = readJson(path.join(cwd, ".pi", "settings.json"));
  if (hasConfiguredExtensionSources(projectSettings)) return true;
  return [
    path.join(agentDir, "extensions"),
    path.join(cwd, ".pi", "extensions"),
  ].some((dir) => fs.existsSync(dir));
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
    let entries: RinDaemonExtensionConfig[] = [];
    try {
      const runtimeSettings = readRuntimeSettings(this.options.agentDir);
      const resolvedEntries = hasPiExtensionSources(
        runtimeSettings,
        this.options.agentDir,
        this.options.cwd,
      )
        ? await listPiResolvedDaemonExtensionConfigs(this.options)
        : [];
      const configOverrides = listRinDaemonExtensionConfigs(runtimeSettings);
      entries = resolvedEntries.map((entry) => {
        const override = configOverrides.find(
          (candidate) =>
            candidate.packageName === entry.packageName ||
            candidate.name === entry.name,
        );
        return override
          ? {
              ...entry,
              name: override.name,
              config: override.config,
            }
          : entry;
      });
    } catch (error: any) {
      this.options.logger?.warn?.(
        `daemon extension package resolution failed err=${safeString(
          error?.message || error,
        )}`,
      );
    }
    if (!entries.length) return [];
    const started: Array<{ name: string; packageName: string }> = [];
    for (const entry of entries) {
      const beforeChatAdapterCount = this.chatAdapters.length;
      const beforeMemoryProviderCount = this.memoryProviders.length;
      const controller = new AbortController();
      const tasks = new Set<Promise<void>>();
      const stopHandlers: Array<() => Promise<void> | void> = [];
      try {
        const runtimeRoot = nearestPackageRoot(
          entry.modulePath || this.options.cwd,
        );
        const moduleValue = await importDaemonExtensionModule(entry);
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
              runtimeRoot,
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
        if (!handled) continue;
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
      runtimeRoot: entry.runtimeRoot,
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
