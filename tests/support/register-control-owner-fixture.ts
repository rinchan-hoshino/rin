import { register } from "node:module";

const controlTarget = "dist/core/rin/control.js";
const managedTarget = "dist/core/rin/managed-runtime-service.js";
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
const controlTarget = ${JSON.stringify(controlTarget)};
const managedTarget = ${JSON.stringify(managedTarget)};
const replacementUrl = ${JSON.stringify(replacementUrl)};
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (resolved.url.endsWith(managedTarget)) {
    return { url: replacementUrl, shortCircuit: true };
  }
  return resolved;
}
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith(controlTarget)) return loaded;
  return {
    ...loaded,
    shortCircuit: true,
    source: String(loaded.source) + "\\nexport { assertLifecycleUpdateFence as __rinOwnerAssertLifecycleUpdateFence };\\n",
  };
}
`;
register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);
