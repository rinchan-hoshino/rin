import fs from "node:fs";
import path from "node:path";

import { createRinDefaultResourceLoader } from "./extension-loader.js";

let rinAgentRuntimeModule: any;

function readAuthData(authPath: string | undefined, fallback: any = {}) {
  if (!authPath) return fallback;
  try {
    return JSON.parse(fs.readFileSync(authPath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeAuthData(authPath: string | undefined, data: any) {
  if (!authPath) return;
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function combinedAuthPromptSignal(
  promptSignal?: AbortSignal,
  loginSignal?: AbortSignal,
) {
  const signals = [promptSignal, loginSignal].filter(Boolean) as AbortSignal[];
  if (!signals.length) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

function authInteractionFromLegacyCallbacks(callbacks: any = {}) {
  if (
    typeof callbacks.prompt === "function" &&
    typeof callbacks.notify === "function"
  ) {
    return callbacks;
  }
  return {
    signal: callbacks.signal,
    async prompt(prompt: any) {
      const signal = combinedAuthPromptSignal(prompt?.signal, callbacks.signal);
      if (prompt?.type === "select") {
        if (typeof callbacks.onSelect !== "function")
          throw new Error("OAuth login cannot show a selection prompt");
        return await callbacks.onSelect({ ...prompt, signal });
      }
      if (prompt?.type === "manual_code") {
        if (typeof callbacks.onManualCodeInput !== "function")
          throw new Error("OAuth login cannot request an authorization code");
        return await callbacks.onManualCodeInput({ ...prompt, signal });
      }
      if (typeof callbacks.onPrompt !== "function")
        throw new Error("OAuth login cannot request text input");
      return await callbacks.onPrompt({
        ...prompt,
        allowEmpty: true,
        signal,
      });
    },
    notify(event: any) {
      const { type, ...info } = event || {};
      if (type === "auth_url") return callbacks.onAuth?.(info);
      if (type === "device_code") return callbacks.onDeviceCode?.(info);
      if (type === "info") return callbacks.onInfo?.(info);
      if (type === "progress") return callbacks.onProgress?.(info.message);
    },
  };
}

function createAuthStorageCompat(authPath: string | undefined, initial?: any) {
  const state = {
    data: initial && typeof initial === "object" ? { ...initial } : undefined,
    modelRuntime: undefined as any,
  };
  const load = () => {
    if (!state.data) state.data = readAuthData(authPath, {});
    return state.data || {};
  };
  const save = () => writeAuthData(authPath, load());
  const api = {
    bindModelRuntime(modelRuntime: any) {
      state.modelRuntime = modelRuntime;
      return api;
    },
    get(provider: string) {
      return load()[String(provider || "")];
    },
    getAll() {
      return { ...load() };
    },
    list() {
      return Object.entries(load()).map(
        ([providerId, credential]: [string, any]) => ({
          providerId,
          type: String(credential?.type || "api_key"),
        }),
      );
    },
    hasAuth(provider: string) {
      return Boolean(api.get(provider));
    },
    getOAuthProviders() {
      return (state.modelRuntime?.getProviders?.() || [])
        .filter((provider: any) => Boolean(provider?.auth?.oauth))
        .map((provider: any) => ({
          id: String(provider.id || ""),
          name: String(
            provider.auth?.oauth?.name || provider.name || provider.id || "",
          ),
          usesCallbackServer: Boolean(provider.auth?.oauth?.usesCallbackServer),
        }))
        .filter((provider: any) => provider.id);
    },
    async read(provider: string) {
      return api.get(provider);
    },
    async modify(provider: string, fn: any) {
      const id = String(provider || "");
      const next = await fn(load()[id]);
      if (typeof next === "undefined") delete load()[id];
      else load()[id] = next;
      save();
      return next;
    },
    async delete(provider: string) {
      delete load()[String(provider || "")];
      save();
    },
    set(provider: string, credential: any) {
      const id = String(provider || "").trim();
      if (!id) return;
      load()[id] = credential;
      save();
      const key = String(credential?.key || "").trim();
      if (key) void state.modelRuntime?.setRuntimeApiKey?.(id, key);
    },
    async login(provider: string, callbacks: any = {}) {
      const id = String(provider || "").trim();
      if (!id) throw new Error("oauth_provider_id_required");
      const credential = await state.modelRuntime?.login?.(
        id,
        "oauth",
        authInteractionFromLegacyCallbacks(callbacks),
      );
      if (credential) {
        load()[id] = credential;
        save();
      }
      return credential;
    },
    logout(provider: string) {
      const id = String(provider || "").trim();
      if (!id) return;
      delete load()[id];
      save();
      void state.modelRuntime?.logout?.(id);
    },
  };
  return api;
}

const AuthStorageCompat = {
  create(authPath?: string) {
    return createAuthStorageCompat(authPath);
  },
  inMemory(data?: any) {
    return createAuthStorageCompat(undefined, data || {});
  },
};

async function createModelRuntimeCompat(PiAgentRuntime: any, options: any) {
  return await PiAgentRuntime.ModelRuntime.create({
    credentials: options.authStorage,
    authPath: options.authPath,
    modelsPath: options.modelsPath,
    allowModelNetwork: options.allowModelNetwork,
  });
}

function createModelRegistryCompat(
  PiAgentRuntime: any,
  modelRuntime: any,
  authStorage: any,
) {
  const modelRegistry = new PiAgentRuntime.ModelRegistry(modelRuntime);
  modelRegistry.authStorage =
    authStorage?.bindModelRuntime?.(modelRuntime) || authStorage;
  return modelRegistry;
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

function composeRinAgentRuntimeExports(PiAgentRuntime: any, tokenHelpers: any) {
  return {
    ...PiAgentRuntime,
    calculateContextTokens: tokenHelpers.calculateContextTokens,
    estimateContextTokens: tokenHelpers.estimateContextTokens,
  };
}

function createRinAgentSessionServicesFactory(
  PiAgentRuntime: any,
  RinDefaultResourceLoader: any,
) {
  return async function createRinAgentSessionServices(options: any) {
    const cwd = options.cwd;
    const agentDir = options.agentDir ?? PiAgentRuntime.getAgentDir?.();
    const authPath = agentDir ? `${agentDir}/auth.json` : undefined;
    const authStorage =
      options.authStorage ?? AuthStorageCompat.create(authPath);
    const settingsManager =
      options.settingsManager ??
      PiAgentRuntime.SettingsManager.create(cwd, agentDir);
    const modelRuntime =
      options.modelRuntime ??
      (await createModelRuntimeCompat(PiAgentRuntime, {
        authStorage,
        authPath,
        modelsPath: agentDir ? `${agentDir}/models.json` : undefined,
      }));
    const modelRegistry =
      options.modelRegistry ??
      createModelRegistryCompat(PiAgentRuntime, modelRuntime, authStorage);
    const resourceLoader = new RinDefaultResourceLoader({
      ...(options.resourceLoaderOptions ?? {}),
      cwd,
      agentDir,
      settingsManager,
    });
    await resourceLoader.reload(options.resourceLoaderReloadOptions);
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
      modelRuntime,
      modelRegistry,
      resourceLoader,
      diagnostics,
    };
  };
}

export async function loadRinAgentRuntime() {
  if (!rinAgentRuntimeModule) {
    const [PiAgentRuntimeBase, tokenHelpers] = await Promise.all([
      import("@earendil-works/pi-coding-agent"),
      import("./context-token-estimator.js"),
    ]);
    const PiAgentRuntime = composeRinAgentRuntimeExports(
      PiAgentRuntimeBase,
      tokenHelpers,
    );
    const DefaultResourceLoader =
      createRinDefaultResourceLoader(PiAgentRuntime);
    rinAgentRuntimeModule = {
      ...PiAgentRuntime,
      AuthStorage: AuthStorageCompat,
      createModelRegistry: (modelRuntime: any, authStorage: any) =>
        createModelRegistryCompat(PiAgentRuntime, modelRuntime, authStorage),
      DefaultResourceLoader,
      createAgentSessionServices: createRinAgentSessionServicesFactory(
        PiAgentRuntime,
        DefaultResourceLoader,
      ),
    };
  }
  return rinAgentRuntimeModule;
}
