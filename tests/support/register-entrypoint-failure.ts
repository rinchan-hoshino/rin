import { register } from "node:module";

const target = String(process.env.RIN_TEST_ENTRYPOINT_FAILURE_TARGET || "");
const replacements: Record<string, string> = {
  "dist/core/rin/main.js": `
    export async function startRinCli() {
      const mode = process.env.RIN_TEST_ENTRYPOINT_FAILURE_MODE;
      if (mode === "resolve") return;
      if (mode === "empty") return await Promise.reject(undefined);
      throw new Error("rin_request_failed");
    }
  `,
  "dist/core/rin-install/main.js": `
    export async function startInstaller() {
      if (process.env.RIN_TEST_ENTRYPOINT_FAILURE_MODE === "silent") {
        const error = new Error("silent installer failure");
        error.suppressUserFacingPrint = true;
        throw error;
      }
      return await Promise.reject(undefined);
    }
  `,
  "dist/core/rin-daemon/worker.js": `
    export async function startWorkerProcess() {
      const mode = process.env.RIN_TEST_ENTRYPOINT_FAILURE_MODE;
      if (mode === "resolve") return;
      if (mode === "empty") return await Promise.reject(undefined);
      throw new Error("worker fixture failure");
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

const hookSource = `
const target = ${JSON.stringify(target)};
const replacementUrl = ${JSON.stringify(
  `data:text/javascript,${encodeURIComponent(replacement)}`,
)};
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (resolved.url.endsWith(target)) {
    return { url: replacementUrl, shortCircuit: true };
  }
  return resolved;
}
`;
register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);
