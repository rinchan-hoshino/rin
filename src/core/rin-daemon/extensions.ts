import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import {
  ensureRuntimeImporter,
  getRinDaemonRuntimeRoot,
  listRinDaemonWorkerConfigs,
  readRuntimeSettings,
  type RinExtensionWorkerConfig,
} from "../rin-extension-settings.js";
import type {
  ChatRuntimeExternalAdapterEntry,
  ChatRuntimeExternalAdapterProvider,
} from "../chat-runtime/index.js";
import { ensureDir, stringifyJson } from "../platform/fs.js";
import { safeString } from "../text-utils.js";

export type RinDaemonExtensionLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export type RinDaemonExtensionContext = {
  readonly cwd: string;
  readonly agentDir: string;
  readonly dataDir: string;
  readonly runtimeRoot: string;
  readonly name: string;
  readonly packageName: string;
  readonly config: Record<string, any>;
  readonly signal: AbortSignal;
  readonly logger: RinDaemonExtensionLogger;
  runAsync: (label: string, work: () => Promise<void> | void) => void;
  registerChatAdapter: (
    provider: ChatRuntimeExternalAdapterProvider,
    options?: {
      key?: string;
      name?: string;
      config?: Record<string, any>;
    },
  ) => void;
};

type DaemonWorkerProvider = {
  start?: (context: RinDaemonExtensionContext) =>
    | Promise<void | { stop?: () => Promise<void> | void }>
    | void
    | {
        stop?: () => Promise<void> | void;
      };
  createDaemonWorker?: (context: RinDaemonExtensionContext) =>
    | Promise<void | { stop?: () => Promise<void> | void }>
    | void
    | {
        stop?: () => Promise<void> | void;
      };
};

type RunningWorker = {
  entry: RinExtensionWorkerConfig;
  controller: AbortController;
  stop?: () => Promise<void> | void;
  tasks: Set<Promise<void>>;
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
  entries: RinExtensionWorkerConfig[],
) {
  const dependencies = Object.fromEntries(
    entries
      .map((entry) => [entry.packageName, entry.version || "latest"] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const runtimeRoot = getRinDaemonRuntimeRoot(agentDir);
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

function pickDaemonWorkerProvider(
  moduleValue: any,
  options: { allowDefault?: boolean } = {},
): DaemonWorkerProvider | null {
  const candidates = [
    moduleValue?.createDaemonWorker,
    options.allowDefault ? moduleValue?.rinDaemonExtension : undefined,
    options.allowDefault ? moduleValue?.daemonWorkerProvider : undefined,
    options.allowDefault ? moduleValue?.default : undefined,
    options.allowDefault ? moduleValue : undefined,
  ];
  for (const candidate of candidates) {
    if (
      typeof candidate?.start === "function" ||
      typeof candidate?.createDaemonWorker === "function"
    ) {
      return candidate;
    }
    if (typeof candidate === "function") {
      return { createDaemonWorker: candidate };
    }
  }
  return null;
}

async function importDaemonWorkerProviderModule(
  runtimeRoot: string,
  packageName: string,
) {
  try {
    const importerPath = ensureRuntimeImporter(
      runtimeRoot,
      ".rin-daemon-extension-importer.mjs",
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

async function loadDaemonWorkerProvider(
  runtimeRoot: string,
  packageName: string,
  options: { allowDefault?: boolean } = {},
) {
  const moduleValue = await importDaemonWorkerProviderModule(
    runtimeRoot,
    packageName,
  );
  const provider = pickDaemonWorkerProvider(moduleValue, options);
  if (!provider && options.allowDefault) {
    throw new Error("provider_missing_createDaemonWorker");
  }
  return provider;
}

function createWorkerLogger(
  base: RinDaemonExtensionLogger | undefined,
  entry: RinExtensionWorkerConfig,
): RinDaemonExtensionLogger {
  const prefix = `daemon-extension:${entry.name}`;
  return {
    info: (message) => base?.info?.(`${prefix}: ${message}`),
    warn: (message) => base?.warn?.(`${prefix}: ${message}`),
    error: (message) => base?.error?.(`${prefix}: ${message}`),
  };
}

export class RinDaemonExtensionManager {
  private readonly workers: RunningWorker[] = [];
  private readonly chatAdapters: ChatRuntimeExternalAdapterEntry[] = [];

  constructor(
    private readonly options: {
      cwd: string;
      agentDir: string;
      logger?: RinDaemonExtensionLogger;
    },
  ) {}

  async start() {
    this.chatAdapters.length = 0;
    const entries = listRinDaemonWorkerConfigs(
      readRuntimeSettings(this.options.agentDir),
      { cwd: this.options.cwd },
    );
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
      try {
        const provider = await loadDaemonWorkerProvider(
          runtimeRoot,
          entry.packageName,
          { allowDefault: !entry.optional },
        );
        if (!provider && entry.optional) continue;
        const controller = new AbortController();
        const tasks = new Set<Promise<void>>();
        const running: RunningWorker = { entry, controller, tasks };
        const logger = createWorkerLogger(this.options.logger, entry);
        const context: RinDaemonExtensionContext = {
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
        };
        const result = await (provider.createDaemonWorker || provider.start)?.(
          context,
        );
        if (result && typeof result === "object") running.stop = result.stop;
        this.workers.push(running);
        started.push({ name: entry.name, packageName: entry.packageName });
      } catch (error: any) {
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
          new Promise((resolve) => setTimeout(resolve, timeoutMs)),
        ]);
      }),
    );
  }
}
