import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  rpcDone as done,
  rpcRun as run,
  type RpcCommandRequest,
} from "./rpc-command-handler-context.js";
import { sessionModelRuntime } from "./rpc-session-command-handler.js";
import { getOAuthState } from "./worker-helpers.js";

export function combinedLoginPromptSignal(
  promptSignal?: AbortSignal,
  loginSignal?: AbortSignal,
) {
  const signals = [promptSignal, loginSignal].filter(Boolean) as AbortSignal[];
  if (!signals.length) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

export async function loginSessionProvider(
  session: any,
  providerId: string,
  callbacks: any,
) {
  const runtime = sessionModelRuntime(session);
  const authType = callbacks.authType === "api_key" ? "api_key" : "oauth";
  if (authType === "oauth" && runtime.authStorage?.login) {
    return await runtime.authStorage.login(providerId, callbacks);
  }
  return await runtime.login(providerId, authType, {
    signal: callbacks.signal,
    prompt: async (prompt: any) => {
      const signal = combinedLoginPromptSignal(prompt.signal, callbacks.signal);
      if (prompt.type === "select") {
        return await callbacks.onSelect({ ...prompt, signal });
      }
      if (prompt.type === "manual_code") {
        return await callbacks.onManualCodeInput({ ...prompt, signal });
      }
      return await callbacks.onPrompt({
        type: prompt.type,
        message: prompt.message,
        placeholder: prompt.placeholder,
        // Current Pi AuthPrompt leaves blank-input policy to the provider.
        // Preserve flows such as GitHub Enterprise's blank-for-default host.
        allowEmpty: true,
        signal,
      });
    },
    notify: (event: any) => {
      if (event.type === "auth_url") return callbacks.onAuth(event);
      if (event.type === "device_code") return callbacks.onDeviceCode(event);
      if (event.type === "info") return callbacks.onInfo(event);
      if (event.type === "progress") return callbacks.onProgress(event.message);
    },
  });
}

export async function refreshSessionModels(session: any) {
  const runtime = sessionModelRuntime(session);
  await runtime.refresh?.();
}

export async function setSessionApiKey(
  session: any,
  providerId: string,
  key: string,
) {
  const runtime = sessionModelRuntime(session);
  if (runtime.authStorage?.set) {
    runtime.authStorage.set(providerId, { type: "api_key", key });
  } else {
    let promptAnswered = false;
    await runtime.login(providerId, "api_key", {
      prompt: async (prompt: any) => {
        if (promptAnswered || prompt?.type !== "secret") {
          throw new Error(
            `Provider ${providerId} requires interactive API-key setup`,
          );
        }
        promptAnswered = true;
        return key;
      },
      notify: () => {},
    });
  }
  await refreshSessionModels(session);
}

export async function logoutSessionProvider(session: any, providerId: string) {
  const runtime = sessionModelRuntime(session);
  if (runtime.authStorage?.logout) {
    await runtime.authStorage.logout(providerId);
  } else {
    await runtime.logout(providerId);
  }
  await refreshSessionModels(session);
}

export function nextOAuthLoginRequestId(
  login: { nextWaitSeq: number },
  loginId: string,
  kind: string,
) {
  return `${loginId}:${kind}:${++login.nextWaitSeq}`;
}

export function deferOAuthLoginStart(task: () => void | Promise<void>) {
  setImmediate(() => {
    void Promise.resolve()
      .then(task)
      .catch(() => {});
  });
}

export type RpcAuthCommandContext = {
  getSession: () => AgentSession;
  output: (value: unknown) => void;
};

export function createRpcAuthCommandHandlers(context: RpcAuthCommandContext) {
  const { getSession, output } = context;
  const authState: {
    loginSeq: number;
    activeLogins: Map<
      string,
      {
        abort: AbortController;
        waits: Map<
          string,
          { resolve: (value: string) => void; reject: (error: Error) => void }
        >;
        nextWaitSeq: number;
      }
    >;
  } = {
    loginSeq: 0,
    activeLogins: new Map(),
  };
  const emitLoginEvent = (
    loginId: string,
    event: string,
    payload: Record<string, unknown> = {},
  ) => output({ type: "oauth_login_event", loginId, event, ...payload });
  const ensureLogin = (loginId: string) => {
    const login = authState.activeLogins.get(loginId);
    if (!login) throw new Error(`Unknown OAuth login: ${loginId}`);
    return login;
  };
  const waitForLoginInput = (
    loginId: string,
    kind: string,
    payload: Record<string, unknown> = {},
    signal?: AbortSignal,
  ) => {
    const login = ensureLogin(loginId);
    const requestId = nextOAuthLoginRequestId(login, loginId, kind);
    emitLoginEvent(loginId, kind, { requestId, ...payload });
    return new Promise<string>((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const resolveInput = (value: string) => {
        cleanup();
        resolve(value);
      };
      const rejectInput = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        login.waits.delete(requestId);
        emitLoginEvent(loginId, "prompt_cancel", { requestId });
        rejectInput(new Error("OAuth login prompt cancelled"));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      login.waits.set(requestId, {
        resolve: resolveInput,
        reject: rejectInput,
      });
    });
  };
  const finishLogin = (loginId: string) => {
    const login = authState.activeLogins.get(loginId);
    if (!login) return;
    for (const pending of login.waits.values())
      pending.reject(new Error("OAuth login cancelled"));
    authState.activeLogins.delete(loginId);
  };
  return {
    async get_oauth_state({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return run(id, type, () => getOAuthState(session));
    },
    async oauth_login_start({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      {
        const providerId = String(command.providerId || "").trim();
        if (!providerId) throw new Error("providerId is required");
        const authType =
          String(command.authType || "oauth").trim() === "api_key"
            ? "api_key"
            : "oauth";
        const loginId = `login_${++authState.loginSeq}`;
        const abort = new AbortController();
        authState.activeLogins.set(loginId, {
          abort,
          waits: new Map(),
          nextWaitSeq: 0,
        });
        // Let the start response reach the frontend before a provider can
        // synchronously emit its first auth prompt.
        deferOAuthLoginStart(async () => {
          try {
            await loginSessionProvider(session, providerId, {
              authType,
              onAuth: (info: { url: string; instructions?: string }) =>
                emitLoginEvent(loginId, "auth", {
                  url: info.url,
                  instructions: info.instructions,
                }),
              onDeviceCode: (info: {
                userCode: string;
                verificationUri: string;
                intervalSeconds?: number;
                expiresInSeconds?: number;
              }) =>
                emitLoginEvent(loginId, "device_code", {
                  userCode: info.userCode,
                  verificationUri: info.verificationUri,
                  intervalSeconds: info.intervalSeconds,
                  expiresInSeconds: info.expiresInSeconds,
                }),
              onPrompt: (prompt: {
                type?: string;
                message: string;
                placeholder?: string;
                allowEmpty?: boolean;
                signal?: AbortSignal;
              }) =>
                waitForLoginInput(
                  loginId,
                  "prompt",
                  {
                    promptType: prompt.type,
                    message: prompt.message,
                    placeholder: prompt.placeholder,
                    allowEmpty: prompt.allowEmpty,
                  },
                  prompt.signal,
                ),
              onSelect: (prompt: {
                message: string;
                options: readonly { id: string; label: string }[];
                signal?: AbortSignal;
              }) =>
                waitForLoginInput(
                  loginId,
                  "select",
                  {
                    message: prompt.message,
                    options: prompt.options,
                  },
                  prompt.signal,
                ),
              onProgress: (message: string) =>
                emitLoginEvent(loginId, "progress", { message }),
              onInfo: (info: { message: string; links?: unknown[] }) =>
                emitLoginEvent(loginId, "info", info),
              onManualCodeInput: (prompt: {
                message?: string;
                placeholder?: string;
                signal?: AbortSignal;
              }) =>
                waitForLoginInput(
                  loginId,
                  "manual_code",
                  {
                    message: prompt.message,
                    placeholder: prompt.placeholder,
                  },
                  prompt.signal,
                ),
              signal: abort.signal,
            });
            await refreshSessionModels(session);
            emitLoginEvent(loginId, "complete", {
              success: true,
              state: await getOAuthState(session),
            });
          } catch (error: any) {
            emitLoginEvent(loginId, "complete", {
              success: false,
              error: String(error?.message || error || "oauth_login_failed"),
            });
          } finally {
            finishLogin(loginId);
          }
        });
        return done(id, type, { loginId });
      }
    },
    async oauth_login_respond({ command, id, type }: RpcCommandRequest) {
      {
        const login = ensureLogin(String(command.loginId || ""));
        const requestId = String(command.requestId || "");
        const pending = login.waits.get(requestId);
        if (!pending)
          throw new Error(`Unknown OAuth login request: ${requestId}`);
        login.waits.delete(requestId);
        pending.resolve(String(command.value || ""));
        return done(id, type);
      }
    },
    async oauth_login_cancel({ command, id, type }: RpcCommandRequest) {
      {
        const loginId = String(command.loginId || "");
        const login = ensureLogin(loginId);
        login.abort.abort();
        finishLogin(loginId);
        return done(id, type);
      }
    },
    async oauth_set_api_key({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      {
        const providerId = String(command.providerId || "").trim();
        const key = String(command.key || "").trim();
        if (!providerId) throw new Error("providerId is required");
        if (!key) throw new Error("key is required");
        await setSessionApiKey(session, providerId, key);
        return done(id, type, await getOAuthState(session));
      }
    },
    async oauth_logout({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      {
        const providerId = String(command.providerId || "").trim();
        if (!providerId) throw new Error("providerId is required");
        await logoutSessionProvider(session, providerId);
        return done(id, type, await getOAuthState(session));
      }
    },
  };
}

export type RpcAuthCommandHandlers = ReturnType<
  typeof createRpcAuthCommandHandlers
>;
