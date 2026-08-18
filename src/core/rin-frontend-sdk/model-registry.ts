import type {
  Api,
  AssistantMessage,
  AuthCheck,
  Context,
  Model,
  ModelsApiStreamOptions,
  ModelsRefreshOptions,
  ModelsRefreshResult,
  Provider,
} from "@earendil-works/pi-ai";
import {
  ModelRegistry as PiModelRegistry,
  type ModelRuntime as PiModelRuntime,
} from "@earendil-works/pi-coding-agent";

import type { RpcFrontendClient } from "./frontend-surface.js";
import { createAuthStorageProxy } from "./rpc-auth.js";

type ProviderConfigInput = Parameters<PiModelRuntime["registerProvider"]>[1];
type RuntimeAuthStatus = ReturnType<PiModelRuntime["getProviderAuthStatus"]>;

type PiModelRegistryRuntimePort = Pick<
  PiModelRuntime,
  | "refresh"
  | "getError"
  | "getModels"
  | "getAvailableSnapshot"
  | "getModel"
  | "hasConfiguredAuth"
  | "getAuth"
  | "getCompatibilityRequestConfig"
  | "getProviderAuthStatus"
  | "getProvider"
  | "complete"
  | "isUsingOAuth"
  | "registerNativeProvider"
  | "registerProvider"
  | "unregisterProvider"
  | "getRegisteredProviderConfig"
  | "getRegisteredProviderIds"
  | "getRegisteredNativeProvider"
>;

type RemoteAuthInteraction = {
  signal?: AbortSignal;
  notify?: (event: Record<string, unknown>) => void;
  prompt?: (prompt: Record<string, unknown>) => Promise<string | undefined>;
};

type RemoteCredentialSummary = {
  providerId: string;
  type: string | undefined;
};

export type RpcModelRegistry = PiModelRegistry;

const FRONTEND_PROVIDER_MUTATION_UNSUPPORTED =
  "rin_frontend_provider_mutation_unsupported";
const FRONTEND_PROVIDER_DETAILS_UNAVAILABLE =
  "rin_frontend_provider_registry_details_unavailable";
const FRONTEND_MODEL_EXECUTION_UNSUPPORTED =
  "rin_frontend_model_execution_unsupported";

function unsupportedFrontendModelExecution(): never {
  throw new Error(FRONTEND_MODEL_EXECUTION_UNSUPPORTED);
}

function unsupportedFrontendProviderMutation(): never {
  throw new Error(FRONTEND_PROVIDER_MUTATION_UNSUPPORTED);
}

function unsupportedFrontendProviderDetails(): never {
  throw new Error(FRONTEND_PROVIDER_DETAILS_UNAVAILABLE);
}

function remoteLoginMarker(): never {
  throw new Error("Provider login must be started through modelRuntime.login");
}

function normalizeProviderId(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  return String((value as { provider?: unknown }).provider || "").trim();
}

function normalizeAuthStatusSource(
  source: string | undefined,
): RuntimeAuthStatus["source"] {
  if (source === "oauth") return "stored";
  if (
    source === "stored" ||
    source === "runtime" ||
    source === "environment" ||
    source === "fallback" ||
    source === "models_json_key" ||
    source === "models_json_command"
  ) {
    return source;
  }
  return undefined;
}

function normalizeRpcModels(value: unknown): Model<Api>[] {
  return Array.isArray(value) ? (value as Model<Api>[]) : [];
}

export class RpcModelRuntime {
  readonly authStorage: ReturnType<typeof createAuthStorageProxy>;

  private readonly state: {
    allModels: Model<Api>[];
    availableModels: Model<Api>[];
    error: string | undefined;
  } = {
    allModels: [],
    availableModels: [],
    error: undefined,
  };

  constructor(private readonly client: RpcFrontendClient) {
    this.authStorage = createAuthStorageProxy(client);
  }

  async refresh(
    options: ModelsRefreshOptions = {},
  ): Promise<ModelsRefreshResult> {
    const signal = options.signal;
    if (signal?.aborted) {
      return { aborted: true, errors: new Map<string, Error>() };
    }
    const sync = this.sync({ signal });
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
  }

  getError(): string | undefined {
    return this.state.error;
  }

  getModels(provider?: string): readonly Model<Api>[] {
    const id = normalizeProviderId(provider);
    return id
      ? this.state.allModels.filter((model) => model?.provider === id)
      : [...this.state.allModels];
  }

  async getAvailable(
    provider?: string,
    _options?: unknown,
  ): Promise<readonly Model<Api>[]> {
    const id = normalizeProviderId(provider);
    const models = this.availableModels();
    return id ? models.filter((model) => model?.provider === id) : models;
  }

  getAvailableSnapshot(): readonly Model<Api>[] {
    return this.availableModels();
  }

  getModel(provider: string, modelId: string): Model<Api> | undefined {
    return this.state.allModels.find(
      (model) => model.provider === provider && model.id === modelId,
    );
  }

  getProviders(): readonly Provider[] {
    return this.authStorage.getModelProviders().map((provider) => {
      const auth = {
        ...(provider.auth.apiKey
          ? {
              apiKey: {
                name: provider.auth.apiKey.name,
                ...(provider.auth.apiKey.interactive
                  ? { login: remoteLoginMarker }
                  : {}),
                resolve: async () => undefined,
              },
            }
          : {}),
        ...(provider.auth.oauth
          ? {
              oauth: {
                name: provider.auth.oauth.name,
                ...(provider.auth.oauth.loginLabel
                  ? { loginLabel: provider.auth.oauth.loginLabel }
                  : {}),
                ...(provider.auth.oauth.isSubscription === true
                  ? { isSubscription: true }
                  : {}),
                login: remoteLoginMarker,
                refresh: unsupportedFrontendModelExecution,
                toAuth: unsupportedFrontendModelExecution,
              },
            }
          : {}),
      };
      return {
        id: provider.id,
        name: provider.name,
        auth,
        getModels: () => this.getModels(provider.id),
        stream: unsupportedFrontendModelExecution,
        streamSimple: unsupportedFrontendModelExecution,
      } as Provider;
    });
  }

  getProvider(provider: string): Provider | undefined {
    const id = normalizeProviderId(provider);
    return this.getProviders().find((candidate) => candidate.id === id);
  }

  getProviderDisplayName(provider: string): string {
    return this.authStorage.getProviderDisplayName(provider);
  }

  getProviderAuthStatus(provider: string): RuntimeAuthStatus {
    const status = this.authStorage.getProviderAuthStatus(
      normalizeProviderId(provider),
    );
    const source = normalizeAuthStatusSource(status.source);
    return {
      configured: status.configured,
      ...(source ? { source } : {}),
      ...(status.label ? { label: status.label } : {}),
    };
  }

  isUsingOAuth(provider: string): boolean {
    return (
      this.authStorage.get(normalizeProviderId(provider))?.type === "oauth"
    );
  }

  isUsingSubscription(provider: string): boolean {
    const id = normalizeProviderId(provider);
    return (
      this.isUsingOAuth(id) &&
      this.getProvider(id)?.auth.oauth?.isSubscription === true
    );
  }

  hasConfiguredAuth(provider: string): boolean {
    const id = normalizeProviderId(provider);
    return Boolean(
      this.authStorage.get(id) ||
      this.authStorage.getProviderAuthStatus(id)?.configured,
    );
  }

  async checkAuth(
    provider: string,
    _options?: unknown,
  ): Promise<AuthCheck | undefined> {
    const error = await this.sync();
    if (error) throw error;
    const id = normalizeProviderId(provider);
    const credential = this.authStorage.get(id);
    if (credential?.type) return { type: credential.type } as AuthCheck;
    const status = this.authStorage.getProviderAuthStatus(id);
    return status?.configured ? ({ type: "api_key" } as AuthCheck) : undefined;
  }

  async getAuth(
    _providerOrModel: string | Model<Api>,
    _overrides?: unknown,
  ): Promise<undefined> {
    // Provider secrets stay daemon-owned. The frontend can query auth status
    // and initiate login/logout, but it must never receive request credentials.
    return undefined;
  }

  getCompatibilityRequestConfig(_model: Model<Api>) {
    return { authHeader: true };
  }

  async listCredentials(): Promise<readonly RemoteCredentialSummary[]> {
    return this.authStorage
      .list()
      .map((id) => ({ providerId: id, type: this.authStorage.get(id)?.type }));
  }

  async login(
    provider: string,
    type: string,
    interaction: RemoteAuthInteraction = {},
  ): Promise<{ type: string }> {
    const id = normalizeProviderId(provider);
    await this.authStorage.login(id, {
      authType: type,
      signal: interaction.signal,
      onAuth: (info) => interaction.notify?.({ type: "auth_url", ...info }),
      onDeviceCode: (info) =>
        interaction.notify?.({ type: "device_code", ...info }),
      onProgress: (message) =>
        interaction.notify?.({ type: "progress", message }),
      onInfo: (info) => interaction.notify?.({ type: "info", ...info }),
      onPrompt: (prompt) =>
        interaction.prompt?.({
          type: prompt.type || "text",
          message: prompt.message,
          placeholder: prompt.placeholder,
          signal: prompt.signal,
        }),
      onSelect: (prompt) => interaction.prompt?.({ type: "select", ...prompt }),
      onManualCodeInput: (prompt) =>
        interaction.prompt?.({ type: "manual_code", ...prompt }),
    });
    await this.sync();
    return { type };
  }

  async logout(provider: string, _options?: unknown): Promise<void> {
    await this.authStorage.logoutAndWait(normalizeProviderId(provider));
    await this.sync();
  }

  async complete<TApi extends Api>(
    _model: Model<TApi>,
    _context: Context,
    _options?: ModelsApiStreamOptions<TApi>,
  ): Promise<AssistantMessage> {
    return unsupportedFrontendModelExecution();
  }

  registerNativeProvider(_provider: Provider): never {
    return unsupportedFrontendProviderMutation();
  }

  registerProvider(_providerId: string, _config: ProviderConfigInput): never {
    return unsupportedFrontendProviderMutation();
  }

  unregisterProvider(_providerId: string): never {
    return unsupportedFrontendProviderMutation();
  }

  getRegisteredProviderConfig(_providerId: string): never {
    return unsupportedFrontendProviderDetails();
  }

  getRegisteredProviderIds(): never {
    return unsupportedFrontendProviderDetails();
  }

  getRegisteredNativeProvider(_providerId: string): never {
    return unsupportedFrontendProviderDetails();
  }

  async sync(
    options: { signal?: AbortSignal } = {},
  ): Promise<Error | undefined> {
    try {
      if (options.signal?.aborted) return undefined;
      const [allModelsResponse, modelsResponse, oauthResponse] =
        await Promise.all([
          this.client.send({ type: "get_all_models" }),
          this.client.send({ type: "get_available_models" }),
          this.client.send({ type: "get_oauth_state" }),
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
      const allModelsData = allModelsResponse.data as
        | { models?: unknown }
        | undefined;
      const modelsData = modelsResponse.data as
        | { models?: unknown }
        | undefined;
      this.state.allModels = normalizeRpcModels(allModelsData?.models);
      this.state.availableModels = normalizeRpcModels(modelsData?.models);
      this.state.error = undefined;
      this.authStorage.applyState(oauthResponse.data);
      return undefined;
    } catch (error: unknown) {
      if (options.signal?.aborted) return undefined;
      const failure =
        error instanceof Error
          ? error
          : new Error(String(error || "Failed to synchronize model catalog"));
      this.state.error = failure.message;
      return failure;
    }
  }

  private availableModels(): Model<Api>[] {
    const merged = new Map(
      this.state.availableModels.map((model) => [
        `${model?.provider || ""}/${model?.id || ""}`,
        model,
      ]),
    );
    for (const model of this.state.allModels) {
      if (!model?.provider || !model?.id) continue;
      if (!this.authStorage.get(model.provider)) continue;
      merged.set(`${model.provider}/${model.id}`, model);
    }
    return [...merged.values()];
  }
}

export function createRpcModelBridge(client: RpcFrontendClient): {
  modelRuntime: RpcModelRuntime;
  modelRegistry: RpcModelRegistry;
} {
  const modelRuntime = new RpcModelRuntime(client);
  const modelRegistryRuntime: PiModelRegistryRuntimePort = modelRuntime;
  const modelRegistry = new PiModelRegistry(
    modelRegistryRuntime as PiModelRuntime,
  );
  return { modelRuntime, modelRegistry };
}
