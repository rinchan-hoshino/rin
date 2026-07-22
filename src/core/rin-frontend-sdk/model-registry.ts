import type { RpcFrontendClient } from "./frontend-surface.js";
import { createAuthStorageProxy } from "./rpc-auth.js";

export function createModelRegistry(client: RpcFrontendClient) {
  const state = {
    allModels: [] as any[],
    availableModels: [] as any[],
    error: undefined as string | undefined,
  };
  const authStorage = createAuthStorageProxy(client);

  const providerId = (value: unknown) => String(value || "").trim();
  const availableModels = () => {
    const merged = new Map(
      state.availableModels.map((model) => [
        `${model?.provider || ""}/${model?.id || ""}`,
        model,
      ]),
    );
    for (const model of state.allModels) {
      if (!model?.provider || !model?.id) continue;
      if (!authStorage.get(model.provider)) continue;
      merged.set(`${model.provider}/${model.id}`, model);
    }
    return [...merged.values()];
  };
  const oauthProviders = () => authStorage.getOAuthProviders();
  const providers = () => {
    const oauthById = new Map(
      oauthProviders().map((provider) => [provider.id, provider]),
    );
    const ids = new Set([
      ...state.allModels.map((model) => providerId(model?.provider)),
      ...oauthById.keys(),
    ]);
    return [...ids].filter(Boolean).map((id) => {
      const oauth = oauthById.get(id);
      return {
        id,
        name: oauth?.name || authStorage.getProviderDisplayName(id) || id,
        auth: {
          apiKey: { login: true },
          ...(oauth
            ? { oauth: { loginLabel: `Sign in to ${oauth.name}` } }
            : {}),
        },
      };
    });
  };

  const registry = {
    authStorage,
    async refresh(options: { signal?: AbortSignal } = {}) {
      const signal = options.signal;
      if (signal?.aborted) {
        return { aborted: true, errors: new Map<string, Error>() };
      }
      const sync = registry.sync({ signal });
      if (signal) {
        let onAbort: (() => void) | undefined;
        const aborted = new Promise<"aborted">((resolve) => {
          onAbort = () => resolve("aborted");
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
        const result = await Promise.race([
          sync.then((error) => ({ error })),
          aborted,
        ]);
        if (onAbort) signal.removeEventListener("abort", onAbort);
        if (result === "aborted") {
          return { aborted: true, errors: new Map<string, Error>() };
        }
        return {
          aborted: false,
          errors: result.error
            ? new Map<string, Error>([["rin-daemon", result.error]])
            : new Map<string, Error>(),
        };
      }
      const error = await sync;
      return {
        aborted: false,
        errors: error
          ? new Map<string, Error>([["rin-daemon", error]])
          : new Map<string, Error>(),
      };
    },
    getError() {
      return state.error;
    },
    getAll() {
      return [...state.allModels];
    },
    getModels(provider?: string) {
      const id = providerId(provider);
      return id
        ? state.allModels.filter((model) => model?.provider === id)
        : [...state.allModels];
    },
    getAvailable(provider?: string) {
      const id = providerId(provider);
      const models = availableModels();
      return id ? models.filter((model) => model?.provider === id) : models;
    },
    getAvailableSnapshot() {
      return availableModels();
    },
    find(provider: string, modelId: string) {
      return state.allModels.find(
        (model) => model.provider === provider && model.id === modelId,
      );
    },
    getModel(provider: string, modelId: string) {
      return registry.find(provider, modelId);
    },
    getProviders() {
      return providers();
    },
    getProvider(provider: string) {
      const id = providerId(provider);
      return providers().find((candidate) => candidate.id === id);
    },
    getProviderDisplayName(provider: string) {
      return authStorage.getProviderDisplayName(provider);
    },
    getProviderAuthStatus(provider: string) {
      return authStorage.getProviderAuthStatus(provider);
    },
    isUsingOAuth(modelOrProvider: any) {
      const id =
        typeof modelOrProvider === "string"
          ? modelOrProvider
          : modelOrProvider?.provider;
      return authStorage.get(id)?.type === "oauth";
    },
    async checkAuth(provider: string) {
      const error = await registry.sync();
      if (error) throw error;
      const id = providerId(provider);
      const credential = authStorage.get(id);
      if (credential?.type) return { type: credential.type };
      const status = authStorage.getProviderAuthStatus(id);
      return status?.configured ? { type: "api_key" } : undefined;
    },
    async getAuth(_provider: string) {
      // Provider secrets stay daemon-owned. The frontend can query auth status
      // and initiate login/logout, but it must never receive request credentials.
      return undefined;
    },
    async listCredentials() {
      return authStorage
        .list()
        .map((id) => ({ providerId: id, type: authStorage.get(id)?.type }));
    },
    async login(provider: string, type: string, interaction: any = {}) {
      const id = providerId(provider);
      if (type === "api_key") {
        const key = await interaction.prompt?.({
          type: "prompt",
          message: `Enter API key for ${id}`,
          placeholder: "API key",
          allowEmpty: false,
          signal: interaction.signal,
        });
        if (!String(key || "").trim()) throw new Error("Login cancelled");
        await authStorage.setAndWait(id, { key });
        await registry.sync();
        return { type: "api_key" };
      }
      await authStorage.login(id, {
        signal: interaction.signal,
        onAuth: (info: any) =>
          interaction.notify?.({ type: "auth_url", ...info }),
        onDeviceCode: (info: any) =>
          interaction.notify?.({ type: "device_code", ...info }),
        onProgress: (message: string) =>
          interaction.notify?.({ type: "progress", message }),
        onPrompt: (prompt: any) =>
          interaction.prompt?.({ type: "prompt", ...prompt }),
        onSelect: (prompt: any) =>
          interaction.prompt?.({ type: "select", ...prompt }),
        onManualCodeInput: (prompt: any) =>
          interaction.prompt?.({ type: "manual_code", ...prompt }),
      });
      await registry.sync();
      return { type: "oauth" };
    },
    async logout(provider: string) {
      await authStorage.logoutAndWait(providerId(provider));
      await registry.sync();
    },
    async sync(options: { signal?: AbortSignal } = {}) {
      try {
        if (options.signal?.aborted) return undefined;
        const [allModelsResponse, modelsResponse, oauthResponse]: any =
          await Promise.all([
            client.send({ type: "get_all_models" }),
            client.send({ type: "get_available_models" }),
            client.send({ type: "get_oauth_state" }),
          ]);
        if (options.signal?.aborted) return undefined;
        for (const response of [
          allModelsResponse,
          modelsResponse,
          oauthResponse,
        ]) {
          if (response?.success !== true) {
            throw new Error(
              String(response?.error || "Failed to synchronize model catalog"),
            );
          }
        }
        const allModelsData: any = allModelsResponse.data;
        const modelsData: any = modelsResponse.data;
        state.allModels = Array.isArray(allModelsData?.models)
          ? allModelsData.models
          : [];
        state.availableModels = Array.isArray(modelsData?.models)
          ? modelsData.models
          : [];
        state.error = undefined;
        authStorage.applyState(oauthResponse.data);
        return undefined;
      } catch (error: any) {
        if (options.signal?.aborted) return undefined;
        const failure =
          error instanceof Error
            ? error
            : new Error(String(error || "Failed to synchronize model catalog"));
        state.error = failure.message;
        return failure;
      }
    },
  };
  return registry;
}
