import path from "node:path";

import {
  applyRuntimeProfileEnvironment,
  createRinCapabilityDefinitions,
  resolveRuntimeProfile,
} from "../rin-lib/runtime.js";
import { loadRinCodingAgent } from "../rin-lib/loader.js";
import { createRinCapabilitySet } from "../rin-lib/capability-session.js";
import {
  collectRuntimeSlashCommands,
  getOAuthStateFromStorage,
} from "./catalog-helpers.js";

type CatalogOptions = {
  cwd?: string;
  agentDir?: string;
  additionalExtensionPaths?: string[];
};

type CatalogContext = {
  cwd: string;
  agentDir: string;
  previousCwd: string;
  authStorage: any;
  modelRegistry: any;
  resourceLoader: any;
  extensionRunner: any;
  rinCapabilities: any;
};

function normalizeAdditionalExtensionPaths(value: string[] | undefined) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.map((entry) => String(entry || "").trim()).filter(Boolean),
    ),
  ];
}

async function closeIfSupported(target: any) {
  for (const method of [
    "dispose",
    "disconnect",
    "close",
    "stop",
    "shutdown",
    "destroy",
  ]) {
    if (typeof target?.[method] !== "function") continue;
    await target[method]();
    return;
  }
}

async function cleanupCatalogContext(context: CatalogContext | undefined) {
  if (!context) return;
  try {
    await closeIfSupported(context.extensionRunner).catch(() => {});
    await closeIfSupported(context.resourceLoader).catch(() => {});
  } finally {
    if (process.cwd() !== context.previousCwd) {
      process.chdir(context.previousCwd);
    }
  }
}

async function createCatalogContext(
  options: CatalogOptions = {},
): Promise<CatalogContext> {
  const codingAgentModule = await loadRinCodingAgent();
  const {
    AuthStorage,
    DefaultResourceLoader,
    ModelRegistry,
    SettingsManager,
    ExtensionRunner,
    createEventBus,
    discoverAndLoadExtensions,
  } = codingAgentModule as any;

  const { cwd, agentDir } = resolveRuntimeProfile({
    cwd: options.cwd,
    agentDir: options.agentDir,
  });
  const previousCwd = process.cwd();
  const additionalExtensionPaths = normalizeAdditionalExtensionPaths(
    options.additionalExtensionPaths,
  );

  applyRuntimeProfileEnvironment({ agentDir });
  if (previousCwd !== cwd) process.chdir(cwd);

  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths,
  });
  await resourceLoader.reload();

  const authStorage = AuthStorage.create(path.join(agentDir, "auth.json"));
  const modelRegistry = new ModelRegistry(
    authStorage,
    path.join(agentDir, "models.json"),
  );

  const eventBus = createEventBus();
  const loadedExtensions = await discoverAndLoadExtensions(
    additionalExtensionPaths,
    cwd,
    agentDir,
    eventBus,
  );
  const extensionRunner = new ExtensionRunner(
    loadedExtensions.extensions,
    loadedExtensions.runtime,
    cwd,
    null,
    modelRegistry,
  );
  const rinCapabilities = createRinCapabilitySet({
    cwd,
    agentDir,
    modelRegistry,
    definitions: createRinCapabilityDefinitions({
      cwd,
      agentDir,
      getThinkingLevel: () => "medium",
      sendMessage: () => {},
    }),
  });

  return {
    cwd,
    agentDir,
    previousCwd,
    authStorage,
    modelRegistry,
    resourceLoader,
    extensionRunner,
    rinCapabilities,
  };
}

async function withCatalogContext<T>(
  options: CatalogOptions,
  run: (context: CatalogContext) => Promise<T>,
) {
  const context = await createCatalogContext(options);
  try {
    return await run(context);
  } finally {
    await cleanupCatalogContext(context);
  }
}

export async function listCatalogCommands(options: CatalogOptions = {}) {
  return withCatalogContext(
    options,
    async ({ resourceLoader, extensionRunner, rinCapabilities }) => {
      return collectRuntimeSlashCommands({
        extensionCommands: extensionRunner.getRegisteredCommands(),
        rinCapabilityCommands: rinCapabilities.getRegisteredCommands(),
        promptTemplates: resourceLoader.getPrompts().prompts,
        skills: resourceLoader.getSkills().skills,
      });
    },
  );
}

export async function listCatalogAllModels(options: CatalogOptions = {}) {
  return withCatalogContext(options, async ({ modelRegistry }) => {
    return modelRegistry.getAll();
  });
}

export async function listCatalogModels(options: CatalogOptions = {}) {
  return withCatalogContext(options, async ({ modelRegistry }) => {
    return modelRegistry.getAvailable();
  });
}

export async function getCatalogOAuthState(options: CatalogOptions = {}) {
  return withCatalogContext(options, async ({ authStorage }) => {
    return getOAuthStateFromStorage(authStorage);
  });
}
