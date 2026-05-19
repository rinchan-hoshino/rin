import { submitNativeFrontendPromptTurn } from "./turn-driver.js";

export const FRONTEND_SDK_RUNTIME_WRAPPER_KEY = Symbol.for(
  "rin.frontendSdkRuntimeWrapper",
);
export const FRONTEND_SDK_SESSION_WRAPPER_KEY = Symbol.for(
  "rin.frontendSdkSessionWrapper",
);

export function isFrontendSdkRuntimeWrapper(value: unknown) {
  return Boolean((value as any)?.[FRONTEND_SDK_RUNTIME_WRAPPER_KEY]);
}

export function isFrontendSdkSessionWrapper(value: unknown) {
  return Boolean((value as any)?.[FRONTEND_SDK_SESSION_WRAPPER_KEY]);
}

export function createFrontendSdkSessionWrapper<T extends object>(
  session: T,
): T {
  if (!session || typeof session !== "object") return session;
  if (isFrontendSdkSessionWrapper(session)) return session;

  return new Proxy(session as any, {
    get(target, property, receiver) {
      if (property === FRONTEND_SDK_SESSION_WRAPPER_KEY) return true;
      if (property === "prompt" && typeof target.prompt === "function") {
        return async (text: string, options: Record<string, any> = {}) => {
          await submitNativeFrontendPromptTurn(
            {
              prompt: async (nextText, nextOptions = {}) => {
                await target.prompt.call(target, nextText, nextOptions);
              },
            },
            {
              text,
              images: options.images,
              streamingBehavior: options.streamingBehavior,
              source: options.source,
              requestTag: options.requestTag,
              promptContext: options.promptContext,
              sessionFile: options.sessionFile,
              sessionId: options.sessionId,
            },
          );
        };
      }
      const value = Reflect.get(target, property, receiver);
      if (typeof value === "function") return value.bind(target);
      return value;
    },
    set(target, property, value, receiver) {
      return Reflect.set(target, property, value, receiver);
    },
  }) as T;
}

export function createFrontendSdkRuntimeWrapper<T extends object>(
  runtime: T,
): T {
  if (!runtime || typeof runtime !== "object") return runtime;
  if (isFrontendSdkRuntimeWrapper(runtime)) return runtime;

  let wrappedSession: unknown;
  let wrappedSource: unknown;
  const sessionFor = (source: unknown) => {
    if (!source || typeof source !== "object") return source;
    if (wrappedSource !== source) {
      wrappedSource = source;
      wrappedSession = createFrontendSdkSessionWrapper(source as any);
    }
    return wrappedSession;
  };

  return new Proxy(runtime as any, {
    get(target, property, receiver) {
      if (property === FRONTEND_SDK_RUNTIME_WRAPPER_KEY) return true;
      if (property === "session")
        return sessionFor(Reflect.get(target, property, receiver));
      const value = Reflect.get(target, property, receiver);
      if (typeof value === "function") return value.bind(target);
      return value;
    },
    set(target, property, value, receiver) {
      if (property === "session") {
        wrappedSource = undefined;
        wrappedSession = undefined;
      }
      return Reflect.set(target, property, value, receiver);
    },
  }) as T;
}
