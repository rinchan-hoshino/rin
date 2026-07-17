import { register } from "node:module";

const target = "dist/core/rin/managed-runtime-service.js";
const replacement = `
  export function readManagedRuntimeService() {
    return { kind: "systemd", label: "rin-daemon.service" };
  }
  export async function tryManagedServiceAction(context, action) {
    const handler = globalThis.__rinControlOwnerAction;
    if (typeof handler !== "function") throw new Error("control_owner_action_missing");
    await handler(action, context);
    return "rin-daemon.service";
  }
`;
const replacementUrl = `data:text/javascript,${encodeURIComponent(replacement)}`;
const hookSource = `
const target = ${JSON.stringify(target)};
const replacementUrl = ${JSON.stringify(replacementUrl)};
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
