import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { extensionDataPath } from "../data-layout.js";

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

function isExtensionFile(name: string) {
  return name.endsWith(".ts") || name.endsWith(".js");
}

function resolvePackageEntry(dir: string) {
  const pkg = readJson(path.join(dir, "package.json"));
  if (!pkg || typeof pkg !== "object") return [];
  const entries = Array.isArray(pkg.pi?.extensions) ? pkg.pi.extensions : [];
  return entries
    .map((entry) => resolvePath(text(entry), dir))
    .filter((entry) => fs.existsSync(entry));
}

function resolveExtensionEntries(inputPath: string): string[] {
  if (!fs.existsSync(inputPath)) return [inputPath];
  const stat = fs.statSync(inputPath);
  if (!stat.isDirectory()) return [inputPath];

  const packageEntries = resolvePackageEntry(inputPath);
  if (packageEntries.length) return packageEntries;

  const indexTs = path.join(inputPath, "index.ts");
  const indexJs = path.join(inputPath, "index.js");
  if (fs.existsSync(indexTs)) return [indexTs];
  if (fs.existsSync(indexJs)) return [indexJs];

  return fs.readdirSync(inputPath, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(inputPath, entry.name);
    if (
      (entry.isFile() || entry.isSymbolicLink()) &&
      isExtensionFile(entry.name)
    ) {
      return [entryPath];
    }
    if (!(entry.isDirectory() || entry.isSymbolicLink())) return [];
    const nestedPackageEntries = resolvePackageEntry(entryPath);
    if (nestedPackageEntries.length) return nestedPackageEntries;
    const nestedIndexTs = path.join(entryPath, "index.ts");
    const nestedIndexJs = path.join(entryPath, "index.js");
    if (fs.existsSync(nestedIndexTs)) return [nestedIndexTs];
    if (fs.existsSync(nestedIndexJs)) return [nestedIndexJs];
    return [];
  });
}

function createSourceInfo(extensionPath: string) {
  return {
    path: extensionPath,
    source: "local",
    baseDir: path.dirname(extensionPath),
  };
}

function createExtension(extensionPath: string) {
  return {
    path: extensionPath,
    resolvedPath: extensionPath,
    sourceInfo: createSourceInfo(extensionPath),
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
    runtimeRoot: extensionDataPath(options.agentDir, "runtime"),
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
  extensionPath: string,
  options: { cwd: string; agentDir: string },
) {
  const moduleValue = await importExtensionModule(extensionPath);
  const factory =
    typeof moduleValue === "function"
      ? moduleValue
      : typeof moduleValue?.default === "function"
        ? moduleValue.default
        : undefined;
  if (typeof factory !== "function") return undefined;
  const extension = createExtension(extensionPath);
  await factory(createExtensionApi(extension, options));
  return extension;
}

function unique(values: string[]) {
  return [
    ...new Set(values.map((value) => text(value).trim()).filter(Boolean)),
  ];
}

function enabledPaths(resources: any[]) {
  return resources
    .filter((entry) => entry?.enabled)
    .map((entry) => text(entry.path));
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
      const extensionPaths = unique([
        ...enabledPaths(cliSources.extensions || []),
        ...enabledPaths(configuredSources.extensions || []),
      ]);
      const loaded = [];
      const errors = [];
      for (const extensionPath of extensionPaths.flatMap((entry) =>
        resolveExtensionEntries(resolvePath(entry, this.cwd)),
      )) {
        try {
          const extension = await loadRinExtension(extensionPath, {
            cwd: this.cwd,
            agentDir: this.agentDir,
          });
          if (extension) loaded.push(extension);
        } catch (error: any) {
          errors.push({
            path: extensionPath,
            error: `Failed to load extension: ${error?.message || error}`,
          });
        }
      }
      this.extensionsResult.extensions.push(...loaded);
      this.extensionsResult.errors.push(...errors);
    }
  };
}
