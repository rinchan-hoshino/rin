import { register } from "node:module";

const loaderUrl = `data:text/javascript,${encodeURIComponent(`
class OwnerSessionManager {
  static open(sessionFile, sessionDir) {
    globalThis.__rinRunOwnerEvents.push(["open", sessionFile, sessionDir]);
    return { kind: "open", sessionFile, sessionDir };
  }
  static create(cwd, sessionDir) {
    globalThis.__rinRunOwnerEvents.push(["create", cwd, sessionDir]);
    return { kind: "create", cwd, sessionDir };
  }
}
export async function loadRinSessionManagerModule() { return { SessionManager: OwnerSessionManager }; }
`)}`;

const profileUrl = `data:text/javascript,${encodeURIComponent(`
export function resolveRuntimeProfile(options = {}) {
  const agentDir = String(options.agentDir || globalThis.__rinRunOwnerAgentDir || "/agent/owner");
  globalThis.__rinRunOwnerEvents.push(["profile", options, agentDir]);
  return { cwd: "/cwd/owner", agentDir };
}
export function getRuntimeSessionDir(cwd, agentDir) { return agentDir + "/sessions/runtime"; }
`)}`;

const runtimeUrl = `data:text/javascript,${encodeURIComponent(`
export async function createConfiguredAgentSession(options) {
  globalThis.__rinRunOwnerEvents.push(["configured", options]);
  const sessionFile = globalThis.__rinRunOwnerSessionFile || (options.sessionManager.kind === "open" ? options.sessionManager.sessionFile : options.agentDir + "/sessions/transient.jsonl");
  const session = {
    sessionFile,
    sessionId: globalThis.__rinRunOwnerSessionId || "session-owner",
    subscribe(listener) {
      globalThis.__rinRunOwnerEvents.push(["subscribe"]);
      if (globalThis.__rinRunOwnerSubscribeReturn === "invalid") return 42;
      globalThis.__rinRunOwnerListener = listener;
      return () => globalThis.__rinRunOwnerEvents.push(["unsubscribe"]);
    },
    async prompt(text, promptOptions) {
      globalThis.__rinRunOwnerEvents.push(["prompt", text, promptOptions]);
      if (globalThis.__rinRunOwnerPromptFailure) throw new Error(globalThis.__rinRunOwnerPromptFailure);
      const listener = globalThis.__rinRunOwnerListener;
      for (const event of globalThis.__rinRunOwnerMessageEvents || []) listener?.(event);
      if (globalThis.__rinRunOwnerPromptDelayMs) await new Promise((resolve) => setTimeout(resolve, globalThis.__rinRunOwnerPromptDelayMs));
      return globalThis.__rinRunOwnerPromptResult || { result: { ok: true }, finalText: "owner final" };
    },
    agent: { async waitForIdle() { globalThis.__rinRunOwnerEvents.push(["idle"]); } },
    async abort() {
      globalThis.__rinRunOwnerEvents.push(["abort"]);
      if (globalThis.__rinRunOwnerAbortFailure) throw new Error("abort owner failure");
    },
  };
  const runtime = {
    async dispose() {
      globalThis.__rinRunOwnerEvents.push(["dispose"]);
      if (globalThis.__rinRunOwnerDisposeFailure) throw new Error("dispose owner failure");
    },
  };
  return { session, runtime };
}
`)}`;

const replacements = {
  "dist/core/rin-lib/loader.js": loaderUrl,
  "dist/core/rin-lib/profile.js": profileUrl,
  "dist/core/rin-lib/runtime.js": runtimeUrl,
};
const hookSource = `
const replacements = ${JSON.stringify(replacements)};
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  for (const [target, url] of Object.entries(replacements)) {
    if (resolved.url.endsWith(target)) return { url, shortCircuit: true };
  }
  return resolved;
}
`;
register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);
globalThis.__rinRunOwnerEvents ||= [];
