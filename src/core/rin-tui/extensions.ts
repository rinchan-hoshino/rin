import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

import { loadRinCodingAgent } from "../rin-lib/loader.js";
import type { TuiResourceOptions } from "./cli-options.js";
import { extractText } from "./session-helpers.js";

function sendRpcExtensionMessage(
  target: any,
  message: string,
  options?: { images?: any[] },
) {
  void target
    .prompt(message, {
      images: options?.images,
      source: "extension" as any,
    })
    .catch(() => {});
}

function sendRpcExtensionUserMessage(target: any, content: any) {
  const text = extractText(content);
  if (!text) return;
  void target.prompt(text, { source: "extension" as any }).catch(() => {});
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
    sendUserMessage: (content: any) => {
      sendRpcExtensionUserMessage(target, content);
    },
    appendEntry: () => {},
    setSessionName: (name: string) => {
      void target.setSessionName(name).catch(() => {});
    },
    getSessionName: () => target.sessionName,
    setLabel: (entryId: string, label: string | undefined) => {
      void target.setEntryLabel(entryId, label).catch(() => {});
    },
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
    refreshTools: () => {},
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

function getExtensionOptions(target: any): TuiResourceOptions {
  return {
    additionalExtensionPaths: Array.isArray(
      target.extensionOptions?.additionalExtensionPaths,
    )
      ? target.extensionOptions.additionalExtensionPaths
      : Array.isArray(target.additionalExtensionPaths)
        ? target.additionalExtensionPaths
        : [],
    noExtensions: Boolean(target.extensionOptions?.noExtensions),
    extensionFlagValues: target.extensionOptions?.extensionFlagValues,
    additionalSkillPaths: [],
    additionalPromptTemplatePaths: [],
    additionalThemePaths: [],
  };
}

export async function loadRpcLocalExtensions(
  target: any,
  forceReload: boolean,
  runtimeProfile: { cwd: string; agentDir: string },
) {
  const codingAgentModule: any = await loadRinCodingAgent();
  const { createEventBus, DefaultResourceLoader, ExtensionRunner } =
    codingAgentModule;

  const eventBus = createEventBus();
  const extensionOptions = getExtensionOptions(target);
  const resourceLoader = new DefaultResourceLoader({
    cwd: runtimeProfile.cwd,
    agentDir: runtimeProfile.agentDir,
    settingsManager: target.settingsManager,
    eventBus,
    additionalExtensionPaths: extensionOptions.additionalExtensionPaths,
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
  if (forceReload || result.extensions.length > 0) {
    await runner.emit({
      type: "session_start",
      reason: forceReload ? "reload" : "startup",
    });
  }
}
