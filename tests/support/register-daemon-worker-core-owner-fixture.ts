import "./require-test-sandbox.ts";
import { register } from "node:module";

const replacements = {
  "dist/core/rin-lib/loader.js": `
    const make = (kind, values) => ({
      kind,
      values,
      sessionDir: kind === "create" ? values[1] : "",
      newSession(options) {
        globalThis.__rinWorkerCoreOwnerEvents.push(["newSession", options]);
      },
    });
    export async function loadRinSessionManagerModule() {
      if (process.env.RIN_TEST_WORKER_CORE_FAILURE === "error") throw new Error("owner worker failed");
      if (process.env.RIN_TEST_WORKER_CORE_FAILURE === "empty") throw undefined;
      return {
        SessionManager: {
          inMemory(cwd) {
            globalThis.__rinWorkerCoreOwnerEvents.push(["inMemory", cwd]);
            return make("memory", [cwd]);
          },
          open(sessionFile, sessionDir) {
            globalThis.__rinWorkerCoreOwnerEvents.push(["open", sessionFile, sessionDir]);
            return make("open", [sessionFile, sessionDir]);
          },
          create(cwd, sessionDir) {
            globalThis.__rinWorkerCoreOwnerEvents.push(["create", cwd, sessionDir]);
            return make("create", [cwd, sessionDir]);
          },
        },
      };
    }
  `,
  "dist/core/rin-lib/runtime.js": `
    export async function createConfiguredAgentSession(options) {
      globalThis.__rinWorkerCoreOwnerEvents.push(["configured", options]);
      return { runtime: { ownerRuntime: true } };
    }
  `,
  "dist/core/rin-lib/profile.js": `
    export function resolveRuntimeProfile() {
      return { cwd: "/workspace/owner", agentDir: "/agent/owner" };
    }
    export function getRuntimeSessionDir(cwd, agentDir) {
      globalThis.__rinWorkerCoreOwnerEvents.push(["runtimeDir", cwd, agentDir]);
      return "/agent/owner/sessions/runtime";
    }
  `,
  "dist/core/session/managed-paths.js": `
    export function getManagedSessionDir(agentDir, leaf) {
      globalThis.__rinWorkerCoreOwnerEvents.push(["managedDir", agentDir, leaf]);
      return agentDir + "/sessions/managed/" + leaf;
    }
  `,
  "dist/core/rin-daemon/rpc-mode.js": `
    export async function runCustomRpcMode(runtime, options) {
      globalThis.__rinWorkerCoreOwnerEvents.push(["rpc", runtime, options]);
    }
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
    if (resolved.url.endsWith(target)) {
      return { url: replacementUrl, shortCircuit: true };
    }
  }
  return resolved;
}
`;
register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);

globalThis.__rinWorkerCoreOwnerEvents ||= [];
