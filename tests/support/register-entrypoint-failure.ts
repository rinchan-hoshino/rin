import { register } from "node:module";

const target = String(process.env.RIN_TEST_ENTRYPOINT_FAILURE_TARGET || "");
const replacements: Record<string, string> = {
  "dist/core/rin/main.js": `
    export async function startRinCli() {
      const mode = process.env.RIN_TEST_ENTRYPOINT_FAILURE_MODE;
      if (mode === "resolve") return;
      if (mode === "number") return 19;
      if (mode === "termination") throw { ownerExitCode: 23 };
      if (mode === "empty") return await Promise.reject(undefined);
      throw new Error("rin_request_failed");
    }
  `,
  "dist/core/rin-install/main.js": `
    export async function startInstaller() {
      const mode = process.env.RIN_TEST_ENTRYPOINT_FAILURE_MODE;
      if (mode === "resolve") return 17;
      if (mode === "termination") throw { ownerExitCode: 23 };
      if (mode === "uncaught-termination") {
        queueMicrotask(() => { throw { ownerExitCode: 29 }; });
        return await new Promise(() => {});
      }
      if (mode === "uncaught") {
        queueMicrotask(() => { throw new Error("owner installer uncaught"); });
        return await new Promise(() => {});
      }
      if (mode === "silent") {
        const error = new Error("silent installer failure");
        error.suppressUserFacingPrint = true;
        throw error;
      }
      return await Promise.reject(undefined);
    }
  `,
  "dist/core/rin-daemon/worker.js": `
    export async function startWorkerProcess(options = {}) {
      const mode = process.env.RIN_TEST_ENTRYPOINT_FAILURE_MODE;
      if (mode === "resolve") return;
      if (mode === "terminate") return options.terminateProcess?.(23);
      if (mode === "empty") return await Promise.reject(undefined);
      throw new Error("worker fixture failure");
    }
  `,
  "dist/core/self-improve/worker.js": `
    export async function runMemoryWorker() {
      const mode = process.env.RIN_TEST_ENTRYPOINT_FAILURE_MODE;
      if (mode === "string") throw "owner self-improve string";
      if (mode === "empty") throw undefined;
      throw new Error("owner self-improve failure");
    }
  `,
  "dist/core/rin-tui/launcher.js": `
    export async function startTui() {
      throw new Error("rin_request_failed");
    }
  `,
};
const replacement = replacements[target];
if (!replacement)
  throw new Error(`entrypoint_failure_target_invalid:${target}`);

const processLifetimeTarget = "/dist/core/platform/process-lifetime.js";
const processLifetimeReplacement = `
export function processTerminationExitCode(error) { return error?.ownerExitCode; }
`;
const hookSource = `
const target = ${JSON.stringify(target)};
const replacementUrl = ${JSON.stringify(
  `data:text/javascript,${encodeURIComponent(replacement)}`,
)};
const processLifetimeTarget = ${JSON.stringify(processLifetimeTarget)};
const processLifetimeReplacementUrl = ${JSON.stringify(
  `data:text/javascript,${encodeURIComponent(processLifetimeReplacement)}`,
)};
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (resolved.url.endsWith(target)) {
    return { url: replacementUrl, shortCircuit: true };
  }
  if (
    ["termination", "uncaught-termination"].includes(
      process.env.RIN_TEST_ENTRYPOINT_FAILURE_MODE,
    ) && resolved.url.endsWith(processLifetimeTarget)
  ) {
    return { url: processLifetimeReplacementUrl, shortCircuit: true };
  }
  return resolved;
}
`;
register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);
