import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ensureRuntimeImporter,
  getRinExtensionRuntimeRoot,
  listRinBackgroundExtensionConfigs,
  readRuntimeSettings,
  type RinBackgroundExtensionConfig,
} from "../rin-extension-settings.js";
import { loadRinAgentRuntime } from "../rin-lib/agent-runtime.js";
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

export type RinBackgroundExtensionLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export type RinDaemonMemorySearchRequest = {
  readonly mode: "search" | "recent";
  readonly query: string;
  readonly limit: number;
  readonly params: Record<string, any>;
};

export type RinDaemonMemoryProviderContext = {
  readonly cwd: string;
  readonly agentDir: string;
  readonly dataDir: string;
  readonly runtimeRoot: string;
  readonly key: string;
  readonly name: string;
  readonly packageName: string;
  readonly config: Record<string, any>;
  readonly logger: RinBackgroundExtensionLogger;
};

export type RinDaemonMemoryProvider = {
  search?: (
    request: RinDaemonMemorySearchRequest,
    context: RinDaemonMemoryProviderContext,
  ) =>
    | Promise<ExternalMemoryResult[] | { results?: ExternalMemoryResult[] }>
    | ExternalMemoryResult[]
    | { results?: ExternalMemoryResult[] };
  listRecent?: (
    request: RinDaemonMemorySearchRequest,
    context: RinDaemonMemoryProviderContext,
  ) =>
    | Promise<ExternalMemoryResult[] | { results?: ExternalMemoryResult[] }>
    | ExternalMemoryResult[]
    | { results?: ExternalMemoryResult[] };
  write?: (
    entry: TranscriptArchiveEntry,
    context: RinDaemonMemoryProviderContext,
  ) => Promise<void> | void;
};

export type RinBackgroundExtensionContext = {
  readonly cwd: string;
  readonly agentDir: string;
  readonly dataDir: string;
  readonly runtimeRoot: string;
  readonly name: string;
  readonly packageName: string;
  readonly config: Record<string, any>;
  readonly signal: AbortSignal;
  readonly logger: RinBackgroundExtensionLogger;
  runAsync: (label: string, work: () => Promise<void> | void) => void;
  registerChatAdapter: (
    provider: ChatRuntimeExternalAdapterProvider,
    options?: {
      key?: string;
      name?: string;
      config?: Record<string, any>;
    },
  ) => void;
  registerMemoryProvider: (
    provider: RinDaemonMemoryProvider,
    options?: {
      key?: string;
      name?: string;
      config?: Record<string, any>;
    },
  ) => void;
};

type BackgroundServiceStop = { stop?: () => Promise<void> | void };

type BackgroundServiceProvider = {
  start?: (
    context: RinBackgroundExtensionContext,
  ) => Promise<void | BackgroundServiceStop> | void | BackgroundServiceStop;
};

type BackgroundServiceFactory = NonNullable<BackgroundServiceProvider["start"]>;

type RinBackgroundExtensionApi = RinBackgroundExtensionContext & {
  registerBackgroundService: (
    provider: BackgroundServiceProvider | BackgroundServiceFactory,
  ) => void;
  on: (...args: unknown[]) => void;
  registerTool: (...args: unknown[]) => void;
  registerCommand: (...args: unknown[]) => void;
  registerShortcut: (...args: unknown[]) => void;
  registerFlag: (...args: unknown[]) => void;
  registerProvider: (...args: unknown[]) => void;
};

type RunningWorker = {
  entry: RinBackgroundExtensionConfig;
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
  logger: RinBackgroundExtensionLogger;
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

function shouldInstallBackgroundExtensionDependencies(
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

export function ensureBackgroundExtensionDependencies(
  agentDir: string,
  entries: RinBackgroundExtensionConfig[],
) {
  const dependencies = Object.fromEntries(
    entries
      .filter((entry) => !entry.modulePath)
      .map((entry) => [entry.packageName, entry.version || "latest"] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const runtimeRoot = getRinExtensionRuntimeRoot(agentDir);
  if (
    !shouldInstallBackgroundExtensionDependencies(runtimeRoot, dependencies)
  ) {
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

function pickBackgroundServiceProvider(
  moduleValue: any,
  options: { allowDefault?: boolean } = {},
): BackgroundServiceProvider | null {
  const candidates = [
    moduleValue?.createBackgroundService,
    options.allowDefault ? moduleValue?.rinBackgroundService : undefined,
    options.allowDefault ? moduleValue?.backgroundServiceProvider : undefined,
    options.allowDefault ? moduleValue : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate?.start === "function") return candidate;
    if (typeof candidate === "function") return { start: candidate };
  }
  return null;
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

function resolveJitiAliases() {
  const pkg = readJson(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "package.json",
    ),
  );
  const names = Object.keys({
    ...(pkg?.dependencies || {}),
    ...(pkg?.devDependencies || {}),
  });
  return Object.fromEntries(
    names.flatMap((name) => {
      try {
        return [[name, requireFromHere.resolve(name)]];
      } catch {
        return [];
      }
    }),
  );
}

async function importBackgroundExtensionPath(modulePath: string) {
  if (modulePath.endsWith(".ts")) {
    const { createJiti } = await import(
      pathToFileURL(resolveJitiStaticPath()).href
    );
    const jiti = createJiti(import.meta.url, {
      moduleCache: false,
      alias: resolveJitiAliases(),
    });
    return await jiti.import(modulePath, { default: true });
  }
  return await import(pathToFileURL(modulePath).href);
}

async function importBackgroundExtensionModule(
  runtimeRoot: string,
  entry: RinBackgroundExtensionConfig,
) {
  if (entry.modulePath)
    return await importBackgroundExtensionPath(entry.modulePath);
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

function createBackgroundExtensionApi(
  context: RinBackgroundExtensionContext,
  services: BackgroundServiceProvider[],
): RinBackgroundExtensionApi {
  const noop = () => {};
  return {
    ...context,
    registerBackgroundService: (provider) => {
      if (typeof provider === "function") {
        services.push({ start: provider });
        return;
      }
      if (!provider || typeof provider !== "object") return;
      if (typeof provider.start !== "function") return;
      services.push(provider);
    },
    registerChatAdapter: context.registerChatAdapter,
    registerMemoryProvider: context.registerMemoryProvider,
    on: noop,
    registerTool: noop,
    registerCommand: noop,
    registerShortcut: noop,
    registerFlag: noop,
    registerProvider: noop,
  };
}

async function collectBackgroundServicesFromModule(
  moduleValue: any,
  context: RinBackgroundExtensionContext,
  options: { allowDefault?: boolean } = {},
): Promise<{ services: BackgroundServiceProvider[]; handled: boolean }> {
  const services: BackgroundServiceProvider[] = [];
  const extensionFactory =
    moduleValue?.createRinExtension ||
    moduleValue?.rinExtension ||
    (typeof moduleValue?.default === "function"
      ? moduleValue.default
      : undefined);
  if (typeof extensionFactory === "function") {
    const result = await extensionFactory(
      createBackgroundExtensionApi(context, services),
    );
    if (result && typeof result === "object") {
      if (typeof result.start === "function") {
        services.push(result as BackgroundServiceProvider);
      } else if (typeof result.stop === "function") {
        services.push({ start: () => result as BackgroundServiceStop });
      }
    }
    return { services, handled: true };
  }

  const service = pickBackgroundServiceProvider(moduleValue, options);
  if (service) return { services: [service], handled: true };
  return { services, handled: false };
}

function createWorkerLogger(
  base: RinBackgroundExtensionLogger | undefined,
  entry: RinBackgroundExtensionConfig,
): RinBackgroundExtensionLogger {
  const prefix = `background-extension:${entry.name}`;
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

function backgroundEntryFromResolvedExtension(
  entry: any,
): RinBackgroundExtensionConfig | null {
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

async function listPiResolvedBackgroundExtensionConfigs(options: {
  cwd: string;
  agentDir: string;
}): Promise<RinBackgroundExtensionConfig[]> {
  const agentRuntimeModule = await loadRinAgentRuntime();
  const { DefaultPackageManager, SettingsManager } = agentRuntimeModule as any;
  const settingsManager = SettingsManager.create(options.cwd, options.agentDir);
  const packageManager = new DefaultPackageManager({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
  });
  const resolved = await packageManager.resolve();
  return (resolved.extensions || [])
    .map((entry: any) => backgroundEntryFromResolvedExtension(entry))
    .filter(
      (
        entry: RinBackgroundExtensionConfig | null,
      ): entry is RinBackgroundExtensionConfig => Boolean(entry),
    );
}

function dedupeBackgroundEntries(entries: RinBackgroundExtensionConfig[]) {
  const seen = new Set<string>();
  const result: RinBackgroundExtensionConfig[] = [];
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

export class RinBackgroundExtensionManager {
  private readonly workers: RunningWorker[] = [];
  private readonly chatAdapters: ChatRuntimeExternalAdapterEntry[] = [];
  private readonly memoryProviders: RinDaemonMemoryProviderEntry[] = [];

  constructor(
    private readonly options: {
      cwd: string;
      agentDir: string;
      logger?: RinBackgroundExtensionLogger;
    },
  ) {}

  async start() {
    this.chatAdapters.length = 0;
    this.memoryProviders.length = 0;
    const explicitEntries = listRinBackgroundExtensionConfigs(
      readRuntimeSettings(this.options.agentDir),
      { cwd: this.options.cwd },
    );
    let piResolvedEntries: RinBackgroundExtensionConfig[] = [];
    try {
      piResolvedEntries = await listPiResolvedBackgroundExtensionConfigs(
        this.options,
      );
    } catch (error: any) {
      this.options.logger?.warn?.(
        `background extension package resolution failed err=${safeString(
          error?.message || error,
        )}`,
      );
    }
    const entries = dedupeBackgroundEntries([
      ...explicitEntries,
      ...piResolvedEntries,
    ]);
    if (!entries.length) return [];
    let runtimeRoot: string;
    try {
      runtimeRoot = ensureBackgroundExtensionDependencies(
        this.options.agentDir,
        entries,
      );
    } catch (error: any) {
      this.options.logger?.warn?.(
        `background extension dependency install failed err=${safeString(
          error?.stderr || error?.stdout || error?.message || error,
        )}`,
      );
      return [];
    }
    const started: Array<{ name: string; packageName: string }> = [];
    for (const entry of entries) {
      try {
        const moduleValue = await importBackgroundExtensionModule(
          runtimeRoot,
          entry,
        );
        const controller = new AbortController();
        const tasks = new Set<Promise<void>>();
        const running: RunningWorker = { entry, controller, tasks };
        const logger = createWorkerLogger(this.options.logger, entry);
        const context: RinBackgroundExtensionContext = {
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
          registerChatAdapter: (provider, options = {}) => {
            const key = safeString(options.key).trim() || entry.name;
            const name = safeString(options.name).trim() || key;
            this.chatAdapters.push({
              key,
              name,
              packageName: entry.packageName,
              config: options.config || entry.config,
              provider,
            });
          },
          registerMemoryProvider: (provider, options = {}) => {
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
              config: options.config || entry.config,
              provider,
              logger,
            });
          },
        };
        const beforeChatAdapterCount = this.chatAdapters.length;
        const beforeMemoryProviderCount = this.memoryProviders.length;
        const { services, handled } = await collectBackgroundServicesFromModule(
          moduleValue,
          context,
          { allowDefault: !entry.optional },
        );
        if (!handled && entry.optional) continue;
        if (!handled)
          throw new Error("background_extension_entrypoint_missing");
        const stopHandlers: Array<() => Promise<void> | void> = [];
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
        this.options.logger?.warn?.(
          `background extension init failed name=${entry.name} package=${entry.packageName} err=${safeString(
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

  async searchMemoryProviders(params: Record<string, any> = {}) {
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
            `background extension stop failed name=${worker.entry.name} err=${safeString(
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
