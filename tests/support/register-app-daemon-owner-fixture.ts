import "./require-test-sandbox.ts";
import { register } from "node:module";

const replacements: Record<string, string> = {
  "dist/app/rin-daemon/hosted-nerve-service.js": `
    export function createHostedNerveService(options) {
      let ready = false;
      return {
        async start() { ready = true; globalThis.__rinAppDaemonOwnerEvents.push(["nerve-start", options.agentDir]); },
        async stop() { ready = false; globalThis.__rinAppDaemonOwnerEvents.push(["nerve-stop"]); },
        getOwnerChatKey() { return "discord/owner:nerve"; },
        observeChat: async () => ({ handled: true, stimulated: true }),
        commandRouter: async () => undefined,
        getStatus() { return { ready, working: false, queue: { queued: 0, inflight: 0, delivered: 0 }, triggers: [] }; },
      };
    }
  `,
  "dist/core/chat/daemon-integration.js": `
    export function createChatDaemonIntegration(options) {
      globalThis.__rinAppDaemonOwnerEvents.push(["chat-integration", options.agentDir]);
      const call = async (name, payload) => (await options.getBridge())[name](payload);
      return {
        delivery: {
          send: (payload) => call("send", payload),
          runTurn: (payload) => call("runTurn", payload),
          typing: (payload) => call("typing", payload),
          react: (payload) => call("react", payload),
          terminateTurn: (payload) => call("terminateTurn", payload),
        },
        commandRouter: async (command) => command.type === "owner-command" ? { data: { routed: command.payload } } : undefined,
        extensionApi: { ownerExtensionApi: true },
      };
    }
  `,
  "dist/core/chat/main.js": `
    export async function startChatBridge(options) {
      globalThis.__rinAppDaemonOwnerEvents.push(["chat-start", options.hosted, options.chatAdapterProviders]);
      if (process.env.RIN_TEST_APP_DAEMON_MODE === "services-fail") throw new Error("owner hosted services failed");
      const frontend = options.frontendClientFactory();
      globalThis.__rinAppDaemonOwnerEvents.push(["frontend", frontend.options.socketPath, await frontend.options.connectSocket()]);
      const call = async (name, payload) => {
        globalThis.__rinAppDaemonOwnerEvents.push([name, payload]);
        return { name, payload };
      };
      return {
        stop: async () => globalThis.__rinAppDaemonOwnerEvents.push(["chat-stop"]),
        getStatus: () => ({ status: "ready", owner: true }),
        send: (payload) => call("send", payload),
        runTurn: (payload) => call("runTurn", payload),
        typing: (payload) => call("typing", payload),
        react: (payload) => call("react", payload),
        setWorkingVisible: (payload) => call("working", payload),
        terminateTurn: (payload) => call("terminate", payload),
        evalBridge: (payload) => call("eval", payload),
      };
    }
  `,
  "dist/core/rin-lib/common.js": `
    export function defaultDaemonSocketPath() { return "/owner/default-daemon.sock"; }
  `,
  "dist/core/presentation/error.js": `
    export function formatRuntimeErrorForUser(error) {
      return "formatted:" + String(error?.message || error || "empty");
    }
  `,
  "dist/core/rin-daemon/daemon.js": `
    export async function startDaemon(options) {
      globalThis.__rinAppDaemonOwnerEvents.push(["daemon-start", options.socketPath, options.workerPath, options.selfImproveWorkerPath]);
      if (process.env.RIN_TEST_APP_DAEMON_MODE === "daemon-fail") {
        throw new Error("owner daemon failed");
      }
      const connector = () => "owner-connected-socket";
      options.registerLocalFrontendConnector(connector);
      const starting = options.getExtraStatus();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const ready = options.getExtraStatus();
      const payload = { owner: true };
      await options.chat.send(payload);
      await options.chat.runTurn(payload);
      await options.chat.typing(payload);
      await options.chat.react(payload);
      await options.chat.terminateTurn(payload);
      const routed = await options.additionalCommandRouter({ type: "owner-command", payload });
      const unknown = await options.additionalCommandRouter({ type: "owner-unknown" });
      await options.onShutdown();
      console.log(JSON.stringify({ socketPath: options.socketPath, starting, ready, routed, unknown: unknown ?? null, events: globalThis.__rinAppDaemonOwnerEvents }));
      if (["shutdown", "shutdown-fail"].includes(process.env.RIN_TEST_APP_DAEMON_MODE || "")) {
        setImmediate(() => process.listeners("SIGTERM").at(-1)?.());
      }
      return {
        shutdown:
          process.env.RIN_TEST_APP_DAEMON_MODE === "shutdown-fail"
            ? async () => { throw new Error("owner shutdown failed"); }
            : options.onShutdown,
      };
    }
  `,
  "dist/core/rin-daemon/worker-cgroup-isolation.js": `
    export function createWorkerCgroupIsolation(options) {
      options.warn("owner cgroup warning");
      return { ownerIsolation: true };
    }
  `,
  "dist/core/rin-daemon/lock.js": `
    export async function acquireDaemonInstanceLock(agentDir, options) {
      globalThis.__rinAppDaemonOwnerEvents.push(["lock", agentDir, options.socketPath]);
      if (process.env.RIN_TEST_APP_DAEMON_MODE === "lock-fail") throw new Error("owner lock failed");
      return { async release() { globalThis.__rinAppDaemonOwnerEvents.push(["lock-release"]); } };
    }
  `,
  "dist/core/rin-lib/profile.js": `
    export function resolveRuntimeProfile() { return { cwd: "/owner/workspace", agentDir: "/owner/agent" }; }
    export function applyRuntimeProfileEnvironment(runtime) { globalThis.__rinAppDaemonOwnerEvents.push(["profile", runtime.cwd, runtime.agentDir]); }
    export function getRuntimeSessionDir(_cwd, agentDir) { return agentDir + "/sessions"; }
  `,
  "dist/core/rin-frontend-sdk/daemon-client.js": `
    export class RinDaemonFrontendClient { constructor(options) { this.options = options; } }
  `,
  "dist/core/rin-lib/agent-runtime.js": `
    export async function loadRinAgentRuntime() {
      return { SettingsManager: { create(cwd, agentDir) { return { owner: cwd + ":" + agentDir }; } } };
    }
  `,
  "dist/core/rin-lib/runtime.js": `
    export function applyRinSettingsDefaults(settings) { globalThis.__rinAppDaemonOwnerEvents.push(["settings-defaults", settings.owner]); }
  `,
};

const replacementUrls = Object.fromEntries(
  Object.entries(replacements).map(([target, source]) => [
    target,
    `data:text/javascript,${encodeURIComponent(source)}`,
  ]),
);
const hookSource = `
const replacements = ${JSON.stringify(replacementUrls)};
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  for (const [target, replacementUrl] of Object.entries(replacements)) {
    if (resolved.url.endsWith(target)) return { url: replacementUrl, shortCircuit: true };
  }
  return resolved;
}
`;
register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);

globalThis.__rinAppDaemonOwnerEvents ||= [];
if (
  ["shutdown", "shutdown-fail"].includes(
    process.env.RIN_TEST_APP_DAEMON_MODE || "",
  )
) {
  process.exit = ((code = 0) => {
    globalThis.__rinAppDaemonOwnerEvents.push(["process-exit", code]);
    console.log(JSON.stringify(globalThis.__rinAppDaemonOwnerEvents));
    process.exitCode = code;
  }) as typeof process.exit;
}
