import { register } from "node:module";

const target = "dist/core/rin-tui/launcher.js";
const sources: Record<string, string> = {
  "@earendil-works/pi-coding-agent": `
    export class InteractiveMode {
      constructor(runtime, options) { this.runtime = runtime; this.options = options; globalThis.__rinTuiOwnerEvents.push(["interactive-construct", runtime, options]); }
      async init() { globalThis.__rinTuiOwnerEvents.push(["interactive-init"]); if (globalThis.__rinTuiOwnerScenario.interactiveInitError) throw globalThis.__rinTuiOwnerScenario.interactiveInitError; }
      async run() { globalThis.__rinTuiOwnerEvents.push(["interactive-run"]); await this.init(); if (globalThis.__rinTuiOwnerScenario.interactiveRunError) throw globalThis.__rinTuiOwnerScenario.interactiveRunError; }
      stop() { globalThis.__rinTuiOwnerEvents.push(["interactive-stop"]); }
    }
  `,
  "dist/core/rin-lib/profile.js": `
    export function resolveRuntimeProfile() { globalThis.__rinTuiOwnerEvents.push(["resolve-profile"]); return globalThis.__rinTuiOwnerScenario.runtime; }
    export function applyRuntimeProfileEnvironment(runtime) { globalThis.__rinTuiOwnerEvents.push(["apply-profile", runtime]); }
  `,
  "dist/core/tui-runtime-env.js": `
    export const RIN_TUI_MAINTENANCE_ROLE = "maintenance-tui";
    export const RIN_TUI_RPC_FRONTEND_ROLE = "rpc-frontend";
    export function setRinTuiRuntimeRole(role) { globalThis.__rinTuiOwnerEvents.push(["role", role]); }
  `,
  "dist/core/rin-daemon/client.js": `
    export async function requestDaemonCommand(command, options) { globalThis.__rinTuiOwnerEvents.push(["daemon-command", command, options]); const result = globalThis.__rinTuiOwnerScenario.daemonResults.shift(); if (result instanceof Error) throw result; return result; }
  `,
  "dist/core/rin-lib/user-facing-errors.js": `
    export function rawErrorMessage(error) { return error instanceof Error ? error.message : error == null ? "" : String(error); }
    export function formatRuntimeErrorForFrontendDisplay(error) { return globalThis.__rinTuiOwnerScenario.formattedError ?? (error instanceof Error ? error.message : String(error || "")); }
  `,
  "dist/core/rin-tui/cli-options.js": `
    export function parseTuiCliOptions(argv, cwd) { globalThis.__rinTuiOwnerEvents.push(["parse", argv, cwd]); return { ...globalThis.__rinTuiOwnerScenario.parsed, resources: { ...(globalThis.__rinTuiOwnerScenario.parsed.resources || {}) } }; }
  `,
  "dist/core/rin-frontend-sdk/daemon-client.js": `
    export class RinDaemonFrontendClient { constructor(options) { this.options = options; globalThis.__rinTuiOwnerEvents.push(["client", options]); } }
  `,
  "dist/core/rin-frontend-sdk/frontend-identity.js": `export const TUI_FRONTEND_IDENTITY = { kind: "tui", id: "owner" };`,
  "dist/core/rin-frontend-sdk/runtime-wrapper.js": `export function createFrontendSdkRuntimeWrapper(runtime) { globalThis.__rinTuiOwnerEvents.push(["wrap", runtime]); return runtime; }`,
  "dist/core/rin-tui/runtime.js": `
    export class RpcInteractiveSession {
      constructor(client, resources) { this.client = client; this.resources = resources; this.settingsManager = { getQuietStartup: () => globalThis.__rinTuiOwnerScenario.quiet }; globalThis.__rinTuiOwnerEvents.push(["rpc-session", resources]); }
      async prepareForInteractiveStartup() { globalThis.__rinTuiOwnerEvents.push(["rpc-prepare"]); if (globalThis.__rinTuiOwnerScenario.rpcPrepareError) throw globalThis.__rinTuiOwnerScenario.rpcPrepareError; }
      async connect() { globalThis.__rinTuiOwnerEvents.push(["rpc-connect"]); if (globalThis.__rinTuiOwnerScenario.rpcConnectError) throw globalThis.__rinTuiOwnerScenario.rpcConnectError; }
      async ensureSessionReady() { globalThis.__rinTuiOwnerEvents.push(["rpc-ready"]); if (globalThis.__rinTuiOwnerScenario.rpcReadyError) throw globalThis.__rinTuiOwnerScenario.rpcReadyError; }
      async setSessionName(name) { globalThis.__rinTuiOwnerEvents.push(["rpc-name", name]); if (globalThis.__rinTuiOwnerScenario.rpcNameError) throw globalThis.__rinTuiOwnerScenario.rpcNameError; }
      async disconnect() { globalThis.__rinTuiOwnerEvents.push(["rpc-disconnect"]); }
    }
  `,
  "dist/core/rin-tui/runtime-host.js": `
    export function createRpcRuntimeHost(session) { globalThis.__rinTuiOwnerEvents.push(["runtime-host", session]); return { session, async dispose() { globalThis.__rinTuiOwnerEvents.push(["runtime-dispose"]); } }; }
  `,
  "dist/core/pi/tui-patches/index.js": `export async function applyRinTuiOverrides() { globalThis.__rinTuiOwnerEvents.push(["patches"]); }`,
  "dist/core/self-improve/onboarding.js": `
    export async function prepareOnboardingStartup(resolveAgentDir, trigger) { globalThis.__rinTuiOwnerEvents.push(["onboarding", resolveAgentDir(), trigger]); return { shouldStart: globalThis.__rinTuiOwnerScenario.onboarding }; }
    export function buildOnboardingPrompt(mode) { globalThis.__rinTuiOwnerEvents.push(["onboarding-prompt", mode]); return "owner onboarding"; }
  `,
  "dist/core/rin-lib/runtime.js": `
    export async function createConfiguredAgentSession(options) { globalThis.__rinTuiOwnerEvents.push(["configured-session", options]); return { runtime: { session: { settingsManager: { getQuietStartup: () => globalThis.__rinTuiOwnerScenario.quiet } }, async dispose() { globalThis.__rinTuiOwnerEvents.push(["configured-dispose"]); } } }; }
  `,
};
const urls = Object.fromEntries(
  Object.entries(sources).map(([key, source]) => [
    key,
    `data:text/javascript,${encodeURIComponent(source)}`,
  ]),
);
const hook = `
const target=${JSON.stringify(target)};const urls=${JSON.stringify(urls)};
export async function resolve(specifier,context,nextResolve){
 if(specifier === "@earendil-works/pi-coding-agent" && context.parentURL?.endsWith(target)) return {url:urls[specifier],shortCircuit:true};
 const resolved=await nextResolve(specifier,context);
 if(context.parentURL?.endsWith(target)) for(const [key,url] of Object.entries(urls)) if(resolved.url.endsWith(key)) return {url,shortCircuit:true};
 return resolved;
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);

(globalThis as any).__rinTuiOwnerEvents ||= [];
(globalThis as any).__rinTuiOwnerScenario ||= {};
