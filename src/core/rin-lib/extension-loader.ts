import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { enrichResolvedExtensionResources } from "./extension-resource-metadata.js";

function text(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function noop() {}

function expandPath(value: string) {
  const normalized = text(value).trim();
  if (normalized.startsWith("~/"))
    return path.join(os.homedir(), normalized.slice(2));
  if (normalized.startsWith("~"))
    return path.join(os.homedir(), normalized.slice(1));
  return normalized;
}

function resolvePath(value: string, cwd: string) {
  const expanded = expandPath(value);
  return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

function readJson(filePath: string) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

const requireFromHere = createRequire(import.meta.url);

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

async function importExtensionModule(extensionPath: string) {
  if (extensionPath.endsWith(".ts")) {
    const { createJiti } = await import(
      pathToFileURL(resolveJitiStaticPath()).href
    );
    const jiti = createJiti(import.meta.url, {
      moduleCache: false,
      alias: resolveJitiAliases(),
    });
    return await jiti.import(extensionPath, { default: true });
  }
  return await import(pathToFileURL(extensionPath).href);
}

type ExtensionResource = {
  path: string;
  enabled?: boolean;
  metadata?: {
    source?: string;
    scope?: string;
    origin?: string;
    baseDir?: string;
    packageName?: string;
    packageRoot?: string;
  };
};

function createSourceInfo(resource: ExtensionResource) {
  const metadata = resource.metadata || {};
  return {
    path: resource.path,
    source: metadata.source || "local",
    scope: metadata.scope,
    origin: metadata.origin,
    baseDir: metadata.baseDir || path.dirname(resource.path),
    ...(metadata.packageName ? { packageName: metadata.packageName } : {}),
    ...(metadata.packageRoot ? { packageRoot: metadata.packageRoot } : {}),
  };
}

function createExtension(resource: ExtensionResource) {
  const sourceInfo = createSourceInfo(resource);
  return {
    name: sourceInfo.packageName || path.basename(resource.path),
    path: resource.path,
    resolvedPath: resource.path,
    sourceInfo,
    handlers: new Map(),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
}

function createExtensionApi(
  extension: any,
  options: { cwd: string; agentDir: string },
) {
  const dataDir = path.join(options.agentDir, "data");
  return {
    cwd: options.cwd,
    agentDir: options.agentDir,
    dataDir,
    runtimeRoot: path.join(dataDir, "extension-runtime"),
    config: {},
    logger: { info: noop, warn: noop, error: noop },
    heartbeat: { appendInfo: () => ({ entry: undefined, filePath: "" }) },
    runAsync: noop,
    registerBackgroundService: noop,
    registerChatAdapter: noop,
    registerMemoryProvider: noop,
    on(event: string, handler: unknown) {
      const key = text(event).trim();
      if (!key || typeof handler !== "function") return;
      const handlers = extension.handlers.get(key) ?? [];
      handlers.push(handler);
      extension.handlers.set(key, handlers);
    },
    registerTool(tool: any) {
      const name = text(tool?.name).trim();
      if (!name) return;
      extension.tools.set(name, {
        definition: tool,
        sourceInfo: extension.sourceInfo,
      });
    },
    registerCommand(name: string, command: any) {
      const key = text(name).trim();
      if (!key) return;
      extension.commands.set(key, {
        name: key,
        sourceInfo: extension.sourceInfo,
        ...(command || {}),
      });
    },
    registerShortcut(shortcut: string, shortcutOptions: any) {
      const key = text(shortcut).trim();
      if (!key) return;
      extension.shortcuts.set(key, {
        shortcut: key,
        extensionPath: extension.path,
        ...(shortcutOptions || {}),
      });
    },
    registerFlag(name: string, flag: any) {
      const key = text(name).trim();
      if (!key) return;
      extension.flags.set(key, {
        name: key,
        extensionPath: extension.path,
        ...(flag || {}),
      });
      if (flag?.default !== undefined) {
        extension.defaultFlagValues ??= new Map();
        extension.defaultFlagValues.set(key, flag.default);
      }
    },
    registerMessageRenderer(customType: string, renderer: unknown) {
      const key = text(customType).trim();
      if (!key || typeof renderer !== "function") return;
      extension.messageRenderers.set(key, renderer);
    },
    registerProvider: noop,
    unregisterProvider: noop,
    getFlag: (name: string) =>
      extension.defaultFlagValues?.get(text(name).trim()),
    sendMessage: noop,
    sendUserMessage: noop,
    appendEntry: noop,
    setSessionName: noop,
    getSessionName: () => undefined,
    setLabel: noop,
    exec: async () => ({ stdout: "", stderr: "", exitCode: 1 }),
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: noop,
    getCommands: () => [],
    setModel: async () => false,
    getThinkingLevel: () => "medium",
    setThinkingLevel: noop,
    events: { on: noop, off: noop, emit: noop },
  };
}

async function loadRinExtension(
  resource: ExtensionResource,
  options: { cwd: string; agentDir: string },
) {
  const moduleValue = await importExtensionModule(resource.path);
  const factory =
    typeof moduleValue === "function"
      ? moduleValue
      : typeof moduleValue?.default === "function"
        ? moduleValue.default
        : undefined;
  if (typeof factory !== "function") return undefined;
  const extension = createExtension(resource);
  await factory(createExtensionApi(extension, options));
  return extension;
}

function unique(values: string[]) {
  return [
    ...new Set(values.map((value) => text(value).trim()).filter(Boolean)),
  ];
}

function enabledResources(resources: ExtensionResource[]) {
  return resources.filter((entry) => entry?.enabled);
}

function uniqueResources(resources: ExtensionResource[]) {
  const seen = new Set<string>();
  const result: ExtensionResource[] = [];
  for (const resource of resources) {
    const key = path.resolve(text(resource.path));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(resource);
  }
  return result;
}

export function createRinDefaultResourceLoader(PiAgentRuntime: any) {
  const BaseLoader = PiAgentRuntime.DefaultResourceLoader;
  const PackageManager = PiAgentRuntime.DefaultPackageManager;
  return class RinDefaultResourceLoader extends BaseLoader {
    private readonly rinExtensionPaths: string[];
    private readonly rinNoExtensions: boolean;
    private readonly rinPackageManager: any;

    constructor(options: any) {
      super({ ...options, additionalExtensionPaths: [], noExtensions: true });
      this.rinExtensionPaths = unique(options?.additionalExtensionPaths || []);
      this.rinNoExtensions = Boolean(options?.noExtensions);
      this.rinPackageManager = new PackageManager({
        cwd: this.cwd,
        agentDir: this.agentDir,
        settingsManager: this.settingsManager,
      });
    }

    async reload() {
      await super.reload();
      const cliSources = await this.rinPackageManager.resolveExtensionSources(
        this.rinExtensionPaths,
        {
          temporary: true,
        },
      );
      const configuredSources = this.rinNoExtensions
        ? { extensions: [] }
        : await this.rinPackageManager.resolve();
      const extensionResources = uniqueResources(
        enrichResolvedExtensionResources([
          ...enabledResources(cliSources.extensions || []),
          ...enabledResources(configuredSources.extensions || []),
        ]),
      );
      const loaded = [];
      const errors = [];
      for (const resource of extensionResources) {
        try {
          const extension = await loadRinExtension(resource, {
            cwd: this.cwd,
            agentDir: this.agentDir,
          });
          if (extension) loaded.push(extension);
        } catch (error: any) {
          errors.push({
            path: resource.path,
            error: `Failed to load extension: ${error?.message || error}`,
          });
        }
      }
      this.extensionsResult.extensions.push(...loaded);
      this.extensionsResult.errors.push(...errors);
    }
  };
}
