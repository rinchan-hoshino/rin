import path from "node:path";

import { asArray } from "../json-utils.js";
import {
  applyRuntimeProfileEnvironment,
  createRinCapabilityDefinitions,
  resolveRuntimeProfile,
} from "../rin-lib/runtime.js";
import { loadRinCodingAgent } from "../rin-lib/loader.js";
import { createRinCapabilitySet } from "../rin-lib/capability-session.js";
import {
  collectRuntimeSlashCommands,
  getOAuthStateFromModelRegistry,
} from "./catalog-helpers.js";

type CatalogOptions = {
  cwd?: string;
  agentDir?: string;
  additionalExtensionPaths?: string[];
  noExtensions?: boolean;
  extensionFlagValues?: Array<[string, boolean | string]>;
  additionalSkillPaths?: string[];
  noSkills?: boolean;
  additionalPromptTemplatePaths?: string[];
  noPromptTemplates?: boolean;
  additionalThemePaths?: string[];
  noThemes?: boolean;
  noContextFiles?: boolean;
  systemPrompt?: string;
  appendSystemPrompt?: string[];
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
  return [
    ...new Set(
      asArray(value)
        .map((entry) => String(entry || "").trim())
        .filter(Boolean),
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
    additionalSkillPaths: options.additionalSkillPaths,
    additionalPromptTemplatePaths: options.additionalPromptTemplatePaths,
    additionalThemePaths: options.additionalThemePaths,
    noExtensions: options.noExtensions,
    noSkills: options.noSkills,
    noPromptTemplates: options.noPromptTemplates,
    noThemes: options.noThemes,
    noContextFiles: options.noContextFiles,
    systemPrompt: options.systemPrompt,
    appendSystemPrompt: options.appendSystemPrompt,
  });
  await resourceLoader.reload();

  const authStorage = AuthStorage.create(path.join(agentDir, "auth.json"));
  const modelRegistry = new ModelRegistry(
    authStorage,
    path.join(agentDir, "models.json"),
  );

  const loadedExtensions = resourceLoader.getExtensions();
  if (Array.isArray(options.extensionFlagValues)) {
    for (const [name, value] of options.extensionFlagValues) {
      loadedExtensions.runtime.flagValues.set(String(name), value);
    }
  }
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
  return withCatalogContext(options, async ({ modelRegistry }) => {
    return getOAuthStateFromModelRegistry(modelRegistry);
  });
}
