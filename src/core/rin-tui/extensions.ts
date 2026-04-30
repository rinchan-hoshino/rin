import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

import { loadRinCodingAgent } from "../rin-lib/loader.js";
import type { TuiResourceOptions } from "./cli-options.js";

function sendRpcExtensionMessage(target: any, message: any, options?: any) {
  void target.sendCustomMessage(message, options).catch(() => {});
}

function sendRpcExtensionUserMessage(target: any, content: any, options?: any) {
  void target.sendUserMessage(content, options).catch(() => {});
}

function createRpcCoreActions(
  target: any,
  options: {
    getCommands: () => any[];
    setModel: (model: any) => Promise<boolean>;
  },
) {
  return {
    sendMessage: (message: string, messageOptions?: { images?: any[] }) => {
      sendRpcExtensionMessage(target, message, messageOptions);
    },
    sendUserMessage: (content: any, messageOptions?: any) => {
      sendRpcExtensionUserMessage(target, content, messageOptions);
    },
    appendEntry: (customType: string, data?: unknown) => {
      void target.appendEntry(customType, data).catch(() => {});
    },
    setSessionName: (name: string) => {
      void target.setSessionName(name).catch(() => {});
    },
    getSessionName: () => target.sessionName,
    setLabel: (entryId: string, label: string | undefined) => {
      void target.setEntryLabel(entryId, label).catch(() => {});
    },
    getActiveTools: () => target.activeToolsCache || [],
    getAllTools: () => target.allToolsCache || [],
    setActiveTools: (toolNames: string[]) => {
      target.activeToolsCache = [...toolNames];
      void target.setActiveToolsByName(toolNames).catch(() => {});
    },
    refreshTools: () => {
      void target.refreshTools().catch(() => {});
    },
    getCommands: () => options.getCommands(),
    setModel: (model: any) => options.setModel(model),
    getThinkingLevel: () => target.thinkingLevel,
    setThinkingLevel: (level: ThinkingLevel) => {
      target.setThinkingLevel(level);
    },
  };
}

function createRpcContextActions(target: any) {
  return {
    getModel: () => target.model,
    isIdle: () =>
      (target.getFrontendStatusEvent?.()?.phase || "idle") === "idle",
    getSignal: () => undefined,
    abort: () => {
      void target.abort().catch(() => {});
    },
    hasPendingMessages: () => target.pendingMessageCount > 0,
    shutdown: () => target.extensionBindings.shutdownHandler?.(),
    getContextUsage: () => target.getContextUsage(),
    compact: (options?: { customInstructions?: string }) => {
      void target.compact(options?.customInstructions).catch(() => {});
    },
    getSystemPrompt: () => target.systemPrompt,
  };
}

function applyExtensionFlagValues(
  result: any,
  values?: Map<string, boolean | string>,
) {
  if (!values || values.size <= 0) return;
  const registeredFlags = new Map<string, { type?: string }>();
  for (const extension of result?.extensions || []) {
    for (const [name, flag] of extension?.flags || []) {
      if (!registeredFlags.has(String(name)))
        registeredFlags.set(String(name), flag as any);
    }
  }
  for (const [name, value] of values) {
    const flag = registeredFlags.get(name);
    if (!flag) continue;
    if (flag.type === "boolean") {
      result.runtime.flagValues.set(name, true);
      continue;
    }
    if (typeof value === "string") result.runtime.flagValues.set(name, value);
  }
}

function getResourceOptionArray(target: any, key: string, legacyKey?: string) {
  const optionValue = target.extensionOptions?.[key];
  if (Array.isArray(optionValue)) return optionValue;
  if (legacyKey && Array.isArray(target[legacyKey])) return target[legacyKey];
  return [];
}

export function getRpcLocalExtensionOptions(target: any): TuiResourceOptions {
  return {
    additionalExtensionPaths: getResourceOptionArray(
      target,
      "additionalExtensionPaths",
      "additionalExtensionPaths",
    ),
    noExtensions: Boolean(target.extensionOptions?.noExtensions),
    extensionFlagValues: target.extensionOptions?.extensionFlagValues,
    additionalSkillPaths: getResourceOptionArray(
      target,
      "additionalSkillPaths",
    ),
    additionalPromptTemplatePaths: getResourceOptionArray(
      target,
      "additionalPromptTemplatePaths",
    ),
    additionalThemePaths: getResourceOptionArray(
      target,
      "additionalThemePaths",
    ),
  };
}

export async function loadRpcLocalExtensions(
  target: any,
  _forceReload: boolean,
  runtimeProfile: { cwd: string; agentDir: string },
) {
  const codingAgentModule: any = await loadRinCodingAgent();
  const { createEventBus, DefaultResourceLoader, ExtensionRunner } =
    codingAgentModule;

  const eventBus = createEventBus();
  const extensionOptions = getRpcLocalExtensionOptions(target);
  const resourceLoader = new DefaultResourceLoader({
    cwd: runtimeProfile.cwd,
    agentDir: runtimeProfile.agentDir,
    settingsManager: target.settingsManager,
    eventBus,
    additionalExtensionPaths: extensionOptions.additionalExtensionPaths,
    additionalSkillPaths: extensionOptions.additionalSkillPaths,
    additionalPromptTemplatePaths:
      extensionOptions.additionalPromptTemplatePaths,
    additionalThemePaths: extensionOptions.additionalThemePaths,
    noExtensions: extensionOptions.noExtensions,
  });
  await resourceLoader.reload();
  const result = resourceLoader.getExtensions();
  applyExtensionFlagValues(result, extensionOptions.extensionFlagValues);

  const runner = new ExtensionRunner(
    result.extensions,
    result.runtime,
    runtimeProfile.cwd,
    target.sessionManager,
    target.modelRegistry,
  );
  await Promise.all([
    target.getActiveTools
      ? target.getActiveTools().catch(() => [])
      : Promise.resolve([]),
    target.getAllTools
      ? target.getAllTools().catch(() => [])
      : Promise.resolve([]),
  ]);
  const contextActions = createRpcContextActions(target);

  runner.bindCore(
    createRpcCoreActions(target, {
      getCommands: () => runner.getRegisteredCommands(),
      setModel: async (model: any) => {
        await target.setModel(model);
        return true;
      },
    }),
    contextActions,
  );

  runner.setUIContext(target.extensionBindings.uiContext);
  runner.bindCommandContext(target.extensionBindings.commandContextActions);
  if (target.extensionBindings.onError)
    runner.onError(target.extensionBindings.onError);

  target.extensionRunner = runner;
}
