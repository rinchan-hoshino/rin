import * as PiAgentRuntime from "@earendil-works/pi-coding-agent";

import { createRinDefaultResourceLoader } from "./extension-loader.js";

let rinAgentRuntimeModule: any;

export async function loadPiAgentRuntime() {
  return PiAgentRuntime;
}

function applyExtensionFlagValues(
  extensionsResult: any,
  extensionFlagValues: Map<string, boolean | string> | undefined,
) {
  if (!extensionFlagValues) return [];
  const diagnostics: any[] = [];
  const registeredFlags = new Map<string, { type: "boolean" | "string" }>();
  for (const extension of extensionsResult.extensions || []) {
    for (const [name, flag] of extension.flags || []) {
      registeredFlags.set(name, { type: flag.type });
    }
  }
  const unknownFlags = [];
  for (const [name, value] of extensionFlagValues) {
    const flag = registeredFlags.get(name);
    if (!flag) {
      unknownFlags.push(name);
      continue;
    }
    if (flag.type === "boolean") {
      extensionsResult.runtime.flagValues.set(name, true);
      continue;
    }
    if (typeof value === "string") {
      extensionsResult.runtime.flagValues.set(name, value);
      continue;
    }
    diagnostics.push({
      type: "error",
      message: `Extension flag "--${name}" requires a value`,
    });
  }
  if (unknownFlags.length > 0) {
    diagnostics.push({
      type: "error",
      message: `Unknown option${unknownFlags.length === 1 ? "" : "s"}: ${unknownFlags.map((name) => `--${name}`).join(", ")}`,
    });
  }
  return diagnostics;
}

function createRinAgentSessionServicesFactory(RinDefaultResourceLoader: any) {
  return async function createRinAgentSessionServices(options: any) {
    const cwd = options.cwd;
    const agentDir = options.agentDir ?? PiAgentRuntime.getAgentDir?.();
    const authStorage =
      options.authStorage ??
      PiAgentRuntime.AuthStorage.create(
        agentDir ? `${agentDir}/auth.json` : undefined,
      );
    const settingsManager =
      options.settingsManager ??
      PiAgentRuntime.SettingsManager.create(cwd, agentDir);
    const modelRegistry =
      options.modelRegistry ??
      PiAgentRuntime.ModelRegistry.create(
        authStorage,
        `${agentDir}/models.json`,
      );
    const resourceLoader = new RinDefaultResourceLoader({
      ...(options.resourceLoaderOptions ?? {}),
      cwd,
      agentDir,
      settingsManager,
    });
    await resourceLoader.reload();
    const diagnostics: any[] = [];
    const extensionsResult = resourceLoader.getExtensions();
    for (const { name, config, extensionPath } of extensionsResult.runtime
      .pendingProviderRegistrations || []) {
      try {
        modelRegistry.registerProvider(name, config);
      } catch (error: any) {
        diagnostics.push({
          type: "error",
          message: `Extension "${extensionPath}" error: ${error?.message || error}`,
        });
      }
    }
    extensionsResult.runtime.pendingProviderRegistrations = [];
    diagnostics.push(
      ...applyExtensionFlagValues(
        extensionsResult,
        options.extensionFlagValues,
      ),
    );
    return {
      cwd,
      agentDir,
      authStorage,
      settingsManager,
      modelRegistry,
      resourceLoader,
      diagnostics,
    };
  };
}

export async function loadRinAgentRuntime() {
  if (!rinAgentRuntimeModule) {
    const DefaultResourceLoader =
      createRinDefaultResourceLoader(PiAgentRuntime);
    rinAgentRuntimeModule = {
      ...PiAgentRuntime,
      DefaultResourceLoader,
      createAgentSessionServices: createRinAgentSessionServicesFactory(
        DefaultResourceLoader,
      ),
    };
  }
  return rinAgentRuntimeModule;
}
