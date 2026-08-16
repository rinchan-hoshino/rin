import type {
  RpcCommandRequest,
  RpcDone,
  RpcRun,
} from "./rpc-command-handler-context.js";

export type RpcAuthCommandContext = {
  getSession: () => any;
  getOAuthState: (...args: any[]) => any;
  authState: {
    loginSeq: number;
    activeLogins: Map<string, any>;
  };
  deferOAuthLoginStart: (...args: any[]) => any;
  loginSessionProvider: (...args: any[]) => any;
  emitLoginEvent: (...args: any[]) => any;
  waitForLoginInput: (...args: any[]) => any;
  refreshSessionModels: (...args: any[]) => any;
  finishLogin: (...args: any[]) => any;
  ensureLogin: (...args: any[]) => any;
  setSessionApiKey: (...args: any[]) => any;
  logoutSessionProvider: (...args: any[]) => any;
  done: RpcDone;
  run: RpcRun;
};

export function createRpcAuthCommandHandlers(context: RpcAuthCommandContext) {
  const {
    getSession,
    getOAuthState,
    authState,
    deferOAuthLoginStart,
    loginSessionProvider,
    emitLoginEvent,
    waitForLoginInput,
    refreshSessionModels,
    finishLogin,
    ensureLogin,
    setSessionApiKey,
    logoutSessionProvider,
    done,
    run,
  } = context;
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
