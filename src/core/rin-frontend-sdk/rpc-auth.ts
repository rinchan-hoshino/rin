import type { RinRpcCommand } from "./types.js";
import type { RpcFrontendClient } from "./frontend-surface.js";

type OAuthCredentialSummary = { type: string } | undefined;
type OAuthProviderSummary = {
  id: string;
  name: string;
  usesCallbackServer?: boolean;
};
type ProviderAuthStatusSummary = {
  configured: boolean;
  source?: string;
  label?: string;
};
type LoginState = {
  onAuth?: (info: { url: string; instructions?: string }) => void;
  onPrompt?: (prompt: {
    message: string;
    placeholder?: string;
  }) => Promise<string>;
  onSelect?: (prompt: {
    message: string;
    options: { id: string; label: string }[];
  }) => Promise<string | undefined>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
  resolve: () => void;
  reject: (error: Error) => void;
  cleanup?: () => void;
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
    providerDisplayNames: {} as Record<string, string>,
    providerAuthStatuses: {} as Record<string, ProviderAuthStatusSummary>,
    logins: new Map<string, LoginState>(),
  };

  const applyState = (data: any) => {
    state.credentials = normalizeCredentials(data?.credentials);
    state.providers = normalizeProviders(data?.providers);
    state.providerDisplayNames = normalizeStringMap(data?.providerDisplayNames);
    state.providerAuthStatuses = normalizeProviderAuthStatuses(
      data?.providerAuthStatuses,
    );
  };

  const cleanupLogin = (loginId: string) => {
    const login = state.logins.get(loginId);
    if (!login) return undefined;
    state.logins.delete(loginId);
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
    handler: (() => Promise<string>) | undefined,
  ) => {
    Promise.resolve(handler?.() ?? "")
      .then((value) =>
        sendLoginResponse(payload?.loginId, payload?.requestId, value),
      )
      .catch(() => sendLoginCancel(payload?.loginId));
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
    if (payload.event === "prompt") {
      handleInteractiveEvent(
        payload,
        () =>
          login.onPrompt?.({
            message: String(payload.message || ""),
            placeholder:
              typeof payload.placeholder === "string"
                ? payload.placeholder
                : undefined,
          }) ?? Promise.resolve(""),
      );
      return;
    }
    if (payload.event === "select") {
      handleInteractiveEvent(
        payload,
        () =>
          login.onSelect?.({
            message: String(payload.message || ""),
            options: Array.isArray(payload.options)
              ? payload.options.map((option: any) => ({
                  id: String(option?.id || ""),
                  label: String(option?.label || option?.id || ""),
                }))
              : [],
          }) ?? Promise.resolve(""),
      );
      return;
    }
    if (payload.event === "manual_code") {
      handleInteractiveEvent(
        payload,
        () => login.onManualCodeInput?.() ?? Promise.resolve(""),
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
      const nextProviderId = normalizeProviderId(providerId);
      const apiKey = normalizeApiKey(credential?.key);
      if (!nextProviderId || !apiKey) return;
      const previous = state.credentials[nextProviderId];
      state.credentials[nextProviderId] = { type: "api_key" };
      void client
        .send({
          type: "oauth_set_api_key",
          providerId: nextProviderId,
          key: apiKey,
        })
        .then((response: any) => {
          if (response?.success === true) {
            applyState(response.data);
            return;
          }
          restoreCredential(state.credentials, nextProviderId, previous);
        })
        .catch(() => {
          restoreCredential(state.credentials, nextProviderId, previous);
        });
    },
    logout(providerId: string) {
      const nextProviderId = normalizeProviderId(providerId);
      if (!nextProviderId) return;
      const previous = state.credentials[nextProviderId];
      delete state.credentials[nextProviderId];
      void client
        .send({ type: "oauth_logout", providerId: nextProviderId })
        .then((response: any) => {
          if (response?.success === true) {
            applyState(response.data);
            return;
          }
          restoreCredential(state.credentials, nextProviderId, previous);
        })
        .catch(() => {
          restoreCredential(state.credentials, nextProviderId, previous);
        });
    },
    async login(providerId: string, callbacks: any = {}) {
      const nextProviderId = normalizeProviderId(providerId);
      if (!nextProviderId) {
        throw new Error("oauth_provider_id_required");
      }
      const response: any = await client.send({
        type: "oauth_login_start",
        providerId: nextProviderId,
      });
      const loginId = normalizeLoginId(response?.data?.loginId);
      if (!response || response.success !== true || !loginId) {
        throw new Error(String(response?.error || "oauth_login_failed"));
      }
      await new Promise<void>((resolve, reject) => {
        const login: LoginState = {
          onAuth: callbacks.onAuth,
          onPrompt: callbacks.onPrompt,
          onSelect: callbacks.onSelect,
          onProgress: callbacks.onProgress,
          onManualCodeInput: callbacks.onManualCodeInput,
          resolve,
          reject,
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
