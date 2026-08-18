import type { RinRpcCommand } from "./types.js";
import type { RpcFrontendClient } from "./frontend-surface.js";

type OAuthCredentialSummary = { type: string } | undefined;
type OAuthProviderSummary = {
  id: string;
  name: string;
  usesCallbackServer?: boolean;
};
type ModelProviderSummary = {
  id: string;
  name: string;
  auth: {
    apiKey?: { name: string; interactive: boolean };
    oauth?: {
      name: string;
      loginLabel?: string;
      isSubscription?: boolean;
    };
  };
};
type ProviderAuthStatusSummary = {
  configured: boolean;
  source?: string;
  label?: string;
};
type LoginState = {
  onAuth?: (info: { url: string; instructions?: string }) => void;
  onDeviceCode?: (info: {
    userCode: string;
    verificationUri: string;
    intervalSeconds?: number;
    expiresInSeconds?: number;
  }) => void;
  onPrompt?: (prompt: {
    type: string;
    message: string;
    placeholder?: string;
    allowEmpty?: boolean;
    signal?: AbortSignal;
  }) => Promise<string>;
  onSelect?: (prompt: {
    message: string;
    options: { id: string; label: string }[];
    signal?: AbortSignal;
  }) => Promise<string | undefined>;
  onProgress?: (message: string) => void;
  onInfo?: (info: { message: string; links?: unknown[] }) => void;
  onManualCodeInput?: (prompt: {
    message?: string;
    placeholder?: string;
    signal?: AbortSignal;
  }) => Promise<string>;
  resolve: () => void;
  reject: (error: Error) => void;
  cleanup?: () => void;
  interactiveRequests: Map<string, AbortController>;
};

function trimText(value: unknown) {
  return String(value || "").trim();
}

function normalizeProviderId(value: unknown) {
  return trimText(value);
}

function normalizeLoginId(value: unknown) {
  return trimText(value);
}

function normalizeRequestId(value: unknown) {
  return trimText(value);
}

function normalizeCredentialSummary(value: any): OAuthCredentialSummary {
  const type = trimText(value?.type);
  return type ? { type } : undefined;
}

function normalizeApiKey(value: unknown) {
  return String(value ?? "").trim();
}

async function sendIgnoredClientCommand(
  client: RpcFrontendClient,
  payload: RinRpcCommand,
) {
  await client.send(payload).catch(() => {});
}

function restoreCredential(
  credentials: Record<string, OAuthCredentialSummary>,
  providerId: string,
  previous: OAuthCredentialSummary,
) {
  if (typeof previous !== "undefined") {
    credentials[providerId] = previous;
  } else {
    delete credentials[providerId];
  }
}

function normalizeCredentials(input: any) {
  const credentials: Record<string, OAuthCredentialSummary> = {};
  if (!input || typeof input !== "object") return credentials;
  for (const [providerId, summary] of Object.entries(input)) {
    const id = normalizeProviderId(providerId);
    if (!id || id in credentials) continue;
    credentials[id] = normalizeCredentialSummary(summary);
  }
  return credentials;
}

function normalizeProviders(input: any): OAuthProviderSummary[] {
  if (!Array.isArray(input)) return [];
  const providers: OAuthProviderSummary[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const id = normalizeProviderId(item?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    providers.push({
      id,
      name: trimText(item?.name) || id,
      ...(typeof item?.usesCallbackServer === "undefined"
        ? {}
        : { usesCallbackServer: Boolean(item?.usesCallbackServer) }),
    });
  }
  return providers;
}

function normalizeModelProviders(input: any) {
  if (!Array.isArray(input)) return [];
  const providers: ModelProviderSummary[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const id = normalizeProviderId(item?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = trimText(item?.name) || id;
    const auth: ModelProviderSummary["auth"] = {};
    if (item?.auth?.apiKey) {
      auth.apiKey = {
        name: trimText(item.auth.apiKey.name) || `${name} API key`,
        interactive: Boolean(item.auth.apiKey.interactive),
      };
    }
    if (item?.auth?.oauth) {
      const loginLabel = trimText(item.auth.oauth.loginLabel);
      auth.oauth = {
        name: trimText(item.auth.oauth.name) || name,
        ...(loginLabel ? { loginLabel } : {}),
        ...(item.auth.oauth.isSubscription === true
          ? { isSubscription: true }
          : {}),
      };
    }
    providers.push({ id, name, auth });
  }
  return providers;
}

function normalizeStringMap(input: any) {
  const values: Record<string, string> = {};
  if (!input || typeof input !== "object") return values;
  for (const [key, value] of Object.entries(input)) {
    const id = normalizeProviderId(key);
    const text = trimText(value);
    if (id && text) values[id] = text;
  }
  return values;
}

function normalizeProviderAuthStatuses(input: any) {
  const statuses: Record<string, ProviderAuthStatusSummary> = {};
  if (!input || typeof input !== "object") return statuses;
  for (const [key, value] of Object.entries(input)) {
    const id = normalizeProviderId(key);
    if (!id) continue;
    const source = trimText((value as any)?.source);
    const label = trimText((value as any)?.label);
    statuses[id] = {
      configured: Boolean((value as any)?.configured),
      ...(source ? { source } : {}),
      ...(label ? { label } : {}),
    };
  }
  return statuses;
}

export function createAuthStorageProxy(client: RpcFrontendClient) {
  const state = {
    credentials: {} as Record<string, OAuthCredentialSummary>,
    providers: [] as OAuthProviderSummary[],
    modelProviders: [] as ModelProviderSummary[],
    providerDisplayNames: {} as Record<string, string>,
    providerAuthStatuses: {} as Record<string, ProviderAuthStatusSummary>,
    logins: new Map<string, LoginState>(),
  };

  const applyState = (data: any) => {
    state.credentials = normalizeCredentials(data?.credentials);
    state.providers = normalizeProviders(data?.providers);
    state.modelProviders = normalizeModelProviders(data?.modelProviders);
    state.providerDisplayNames = normalizeStringMap(data?.providerDisplayNames);
    state.providerAuthStatuses = normalizeProviderAuthStatuses(
      data?.providerAuthStatuses,
    );
  };

  const cleanupLogin = (loginId: string) => {
    const login = state.logins.get(loginId);
    if (!login) return undefined;
    state.logins.delete(loginId);
    for (const controller of login.interactiveRequests.values()) {
      controller.abort();
    }
    login.interactiveRequests.clear();
    try {
      login.cleanup?.();
    } catch {}
    return login;
  };

  const sendLoginCancel = async (loginId: unknown) => {
    const nextLoginId = normalizeLoginId(loginId);
    if (!nextLoginId) return;
    await sendIgnoredClientCommand(client, {
      type: "oauth_login_cancel",
      loginId: nextLoginId,
    });
  };

  const sendLoginResponse = async (
    loginId: unknown,
    requestId: unknown,
    value: unknown,
  ) => {
    const nextLoginId = normalizeLoginId(loginId);
    const nextRequestId = normalizeRequestId(requestId);
    if (!nextLoginId || !nextRequestId) {
      await sendLoginCancel(loginId);
      return;
    }
    await sendIgnoredClientCommand(client, {
      type: "oauth_login_respond",
      loginId: nextLoginId,
      requestId: nextRequestId,
      value: String(value ?? ""),
    });
  };

  const finishLogin = (loginId: unknown, payload: any) => {
    const nextLoginId = normalizeLoginId(loginId);
    if (!nextLoginId) return;
    const login = cleanupLogin(nextLoginId);
    if (!login) return;
    if (payload?.state) applyState(payload.state);
    if (payload?.success === true) {
      login.resolve();
      return;
    }
    login.reject(new Error(trimText(payload?.error) || "oauth_login_failed"));
  };

  const handleInteractiveEvent = (
    payload: any,
    login: LoginState,
    handler: ((signal: AbortSignal) => Promise<string>) | undefined,
  ) => {
    const requestId = normalizeRequestId(payload?.requestId);
    if (!requestId) {
      void sendLoginCancel(payload?.loginId);
      return;
    }
    const controller = new AbortController();
    login.interactiveRequests.set(requestId, controller);
    Promise.resolve(handler?.(controller.signal) ?? "")
      .then((value) => {
        if (login.interactiveRequests.get(requestId) !== controller) return;
        login.interactiveRequests.delete(requestId);
        return sendLoginResponse(payload?.loginId, requestId, value);
      })
      .catch(() => {
        if (login.interactiveRequests.get(requestId) !== controller) return;
        login.interactiveRequests.delete(requestId);
        return sendLoginCancel(payload?.loginId);
      });
  };

  const handleEvent = (payload: any) => {
    if (!payload || payload.type !== "oauth_login_event") return;
    const loginId = normalizeLoginId(payload.loginId);
    const login = loginId ? state.logins.get(loginId) : undefined;
    if (!login) return;

    if (payload.event === "auth") {
      login.onAuth?.({
        url: String(payload.url || ""),
        instructions:
          typeof payload.instructions === "string"
            ? payload.instructions
            : undefined,
      });
      return;
    }
    if (payload.event === "progress") {
      login.onProgress?.(String(payload.message || ""));
      return;
    }
    if (payload.event === "info") {
      login.onInfo?.({
        message: String(payload.message || ""),
        ...(Array.isArray(payload.links) ? { links: payload.links } : {}),
      });
      return;
    }
    if (payload.event === "device_code") {
      login.onDeviceCode?.({
        userCode: String(payload.userCode || ""),
        verificationUri: String(payload.verificationUri || ""),
        ...(typeof payload.intervalSeconds === "number"
          ? { intervalSeconds: payload.intervalSeconds }
          : {}),
        ...(typeof payload.expiresInSeconds === "number"
          ? { expiresInSeconds: payload.expiresInSeconds }
          : {}),
      });
      return;
    }
    if (payload.event === "prompt_cancel") {
      const requestId = normalizeRequestId(payload.requestId);
      const controller = login.interactiveRequests.get(requestId);
      if (controller) {
        login.interactiveRequests.delete(requestId);
        controller.abort();
      }
      return;
    }
    if (payload.event === "prompt") {
      handleInteractiveEvent(
        payload,
        login,
        (signal) =>
          login.onPrompt?.({
            type: trimText(payload.promptType) || "text",
            message: String(payload.message || ""),
            placeholder:
              typeof payload.placeholder === "string"
                ? payload.placeholder
                : undefined,
            ...(typeof payload.allowEmpty === "undefined"
              ? {}
              : { allowEmpty: Boolean(payload.allowEmpty) }),
            signal,
          }) ?? Promise.resolve(""),
      );
      return;
    }
    if (payload.event === "select") {
      handleInteractiveEvent(
        payload,
        login,
        (signal) =>
          login.onSelect?.({
            message: String(payload.message || ""),
            options: Array.isArray(payload.options)
              ? payload.options.map((option: any) => ({
                  id: String(option?.id || ""),
                  label: String(option?.label || option?.id || ""),
                }))
              : [],
            signal,
          }) ?? Promise.resolve(""),
      );
      return;
    }
    if (payload.event === "manual_code") {
      handleInteractiveEvent(
        payload,
        login,
        (signal) =>
          login.onManualCodeInput?.({
            message:
              typeof payload.message === "string" ? payload.message : undefined,
            placeholder:
              typeof payload.placeholder === "string"
                ? payload.placeholder
                : undefined,
            signal,
          }) ?? Promise.resolve(""),
      );
      return;
    }
    if (payload.event === "complete") {
      finishLogin(loginId, payload);
    }
  };

  return {
    list: () => Object.keys(state.credentials),
    get: (providerId: string) =>
      state.credentials[normalizeProviderId(providerId)],
    getOAuthProviders: () =>
      state.providers.map((provider) => ({ ...provider })),
    getModelProviders: () =>
      state.modelProviders.map((provider) => ({
        ...provider,
        auth: {
          ...(provider.auth.apiKey
            ? { apiKey: { ...provider.auth.apiKey } }
            : {}),
          ...(provider.auth.oauth ? { oauth: { ...provider.auth.oauth } } : {}),
        },
      })),
    getProviderDisplayName(providerId: string) {
      const id = normalizeProviderId(providerId);
      if (!id) return id;
      return state.providerDisplayNames[id] || id;
    },
    getProviderAuthStatus(providerId: string) {
      const id = normalizeProviderId(providerId);
      return { ...(state.providerAuthStatuses[id] || { configured: false }) };
    },
    applyState,
    async sync() {
      const response: any = await client.send({ type: "get_oauth_state" });
      const data: any =
        response && response.success === true ? response.data : null;
      applyState(data);
    },
    set(providerId: string, credential: any) {
      void this.setAndWait(providerId, credential).catch(() => {});
    },
    async setAndWait(providerId: string, credential: any) {
      const nextProviderId = normalizeProviderId(providerId);
      const apiKey = normalizeApiKey(credential?.key);
      if (!nextProviderId || !apiKey) throw new Error("API key is required");
      const previous = state.credentials[nextProviderId];
      state.credentials[nextProviderId] = { type: "api_key" };
      try {
        const response: any = await client.send({
          type: "oauth_set_api_key",
          providerId: nextProviderId,
          key: apiKey,
        });
        if (response?.success !== true) {
          throw new Error(String(response?.error || "Failed to save API key"));
        }
        applyState(response.data);
      } catch (error) {
        restoreCredential(state.credentials, nextProviderId, previous);
        throw error;
      }
    },
    logout(providerId: string) {
      void this.logoutAndWait(providerId).catch(() => {});
    },
    async logoutAndWait(providerId: string) {
      const nextProviderId = normalizeProviderId(providerId);
      if (!nextProviderId) throw new Error("Provider ID is required");
      const previous = state.credentials[nextProviderId];
      delete state.credentials[nextProviderId];
      try {
        const response: any = await client.send({
          type: "oauth_logout",
          providerId: nextProviderId,
        });
        if (response?.success !== true) {
          throw new Error(String(response?.error || "Failed to log out"));
        }
        applyState(response.data);
      } catch (error) {
        restoreCredential(state.credentials, nextProviderId, previous);
        throw error;
      }
    },
    async login(providerId: string, callbacks: any = {}) {
      const nextProviderId = normalizeProviderId(providerId);
      if (!nextProviderId) {
        throw new Error("oauth_provider_id_required");
      }
      const authType = trimText(callbacks.authType);
      const response: any = await client.send({
        type: "oauth_login_start",
        providerId: nextProviderId,
        ...(authType ? { authType } : {}),
      });
      const loginId = normalizeLoginId(response?.data?.loginId);
      if (!response || response.success !== true || !loginId) {
        throw new Error(String(response?.error || "oauth_login_failed"));
      }
      await new Promise<void>((resolve, reject) => {
        const login: LoginState = {
          onAuth: callbacks.onAuth,
          onDeviceCode: callbacks.onDeviceCode,
          onPrompt: callbacks.onPrompt,
          onSelect: callbacks.onSelect,
          onProgress: callbacks.onProgress,
          onInfo: callbacks.onInfo,
          onManualCodeInput: callbacks.onManualCodeInput,
          resolve,
          reject,
          interactiveRequests: new Map(),
        };
        state.logins.set(loginId, login);
        if (callbacks.signal) {
          const abortHandler = () => {
            cleanupLogin(loginId);
            void sendLoginCancel(loginId);
            reject(new Error("Login cancelled"));
          };
          login.cleanup = () => {
            callbacks.signal.removeEventListener("abort", abortHandler);
          };
          if (callbacks.signal.aborted) {
            abortHandler();
            return;
          }
          callbacks.signal.addEventListener("abort", abortHandler, {
            once: true,
          });
        }
      });
    },
    handleEvent,
  };
}
