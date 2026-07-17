import { register } from "node:module";

const replacements: Record<string, string> = {
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
  "dist/core/rin-lib/user-facing-errors.js": `
    export function formatRuntimeErrorForUser(error) {
      return "formatted:" + String(error?.message || error || "empty");
    }
  `,
  "dist/core/rin-daemon/daemon.js": `
    export async function startDaemon(options) {
      globalThis.__rinAppDaemonOwnerEvents.push(["daemon-start", options.socketPath, options.workerPath]);
      if (process.env.RIN_TEST_APP_DAEMON_MODE === "daemon-fail") {
        await new Promise((resolve) => setTimeout(resolve, 0));
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
      await options.chat.setWorkingVisible(payload);
      await options.chat.terminateTurn(payload);
      const commands = [
        { type: "list_builtin_extensions" },
        { type: "set_builtin_extension", extensionId: "owner-extension", enabled: true },
        { type: "set_builtin_extension", id: "owner-id", enabled: false },
        { type: "set_builtin_extension" },
        { type: "chat_send", payload },
        { type: "chat_send" },
        { type: "chat_run_turn", payload },
        { type: "chat_run_turn" },
        { type: "chat_typing", payload },
        { type: "chat_typing" },
        { type: "chat_react", payload },
        { type: "chat_react" },
        { type: "chat_set_working_visible", payload },
        { type: "chat_set_working_visible" },
        { type: "chat_terminate_turn", payload },
        { type: "chat_terminate_turn" },
        { type: "chat_bridge_eval", payload },
        { type: "chat_bridge_eval" },
        { type: "owner-unknown" },
        {},
      ];
      const results = [];
      for (const command of commands) results.push(await options.handleLocalCommand(command));
      await options.onShutdown();
      console.log(JSON.stringify({ socketPath: options.socketPath, starting, ready, results }));
    }
  `,
  "dist/core/rin-daemon/extensions.js": `
    export class RinBackgroundExtensionManager {
      constructor(options) { this.options = options; globalThis.__rinAppDaemonOwnerEvents.push(["manager-new", options.cwd, options.agentDir]); }
      async start() { globalThis.__rinAppDaemonOwnerEvents.push(["manager-start"]); }
      async stop() { globalThis.__rinAppDaemonOwnerEvents.push(["manager-stop"]); }
      getChatAdapterProviders() { return [{ id: "owner-provider" }]; }
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
  `,
  "dist/core/rin-frontend-sdk/daemon-client.js": `
    export class RinDaemonFrontendClient { constructor(options) { this.options = options; } }
  `,
  "dist/core/rin-builtin-extension-controls.js": `
    export async function listBuiltInRinExtensionStatesWithLifecycle(settings) {
      globalThis.__rinAppDaemonOwnerEvents.push(["list-extensions", settings.owner]);
      return [{ id: "owner-extension" }];
    }
    export async function setBuiltInRinExtensionState(settings, id, enabled) {
      globalThis.__rinAppDaemonOwnerEvents.push(["set-extension", settings.owner, id, enabled]);
      return { id, enabled };
    }
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
