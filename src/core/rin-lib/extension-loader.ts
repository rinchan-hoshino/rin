import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveRuntimePackageAliases } from "./jiti-aliases.js";

function text(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

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

async function importExtensionModule(extensionPath: string) {
  if (extensionPath.endsWith(".ts")) {
    const { createJiti } = await import(
      pathToFileURL(resolveJitiStaticPath()).href
    );
    const jiti = createJiti(import.meta.url, {
      moduleCache: false,
      alias: resolveRuntimePackageAliases({ includeDevDependencies: true }),
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

async function loadRinExtension(
  extensionPath: string,
  options: { cwd: string; agentDir: string },
  eventBus: any,
  runtime: any,
) {
  const moduleValue = await importExtensionModule(extensionPath);
  const factory =
    typeof moduleValue === "function"
      ? moduleValue
      : typeof moduleValue?.default === "function"
        ? moduleValue.default
        : undefined;
  if (typeof factory !== "function") return undefined;
  const { loadPiExtensionFromFactory } = await import("../pi/private-api.js");
  return await loadPiExtensionFromFactory(
    (piApi: any) => factory(piApi),
    options.cwd,
    eventBus,
    runtime,
    extensionPath,
  );
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

    async reload(options?: any) {
      await super.reload(options);
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
          const extension = await loadRinExtension(
            extensionPath,
            {
              cwd: this.cwd,
              agentDir: this.agentDir,
            },
            this.eventBus,
            this.extensionsResult.runtime,
          );
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
