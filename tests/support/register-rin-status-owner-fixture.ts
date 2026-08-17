import "./require-test-sandbox.ts";
import { register } from "node:module";

const target = "dist/core/rin/status.js";
const dependency = "dist/core/rin-daemon/client.js";
const source = `
  const state = () => globalThis.__rinStatusOwnerState ?? {};
  export async function canConnectDaemonSocket() {
    return state().connected === true;
  }
  export async function requestDaemonCommand(request) {
    state().requests?.push(request);
    if (state().requestError) throw state().requestError;
    return state().respond?.(request) ?? { success: true };
  }
`;
const replacement = `data:text/javascript,${encodeURIComponent(source)}`;
const hook = `
const target=${JSON.stringify(target)};
const dependency=${JSON.stringify(dependency)};
const replacement=${JSON.stringify(replacement)};
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (context.parentURL?.endsWith(target) && resolved.url.endsWith(dependency)) {
    return { url: replacement, shortCircuit: true };
  }
  return resolved;
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);
