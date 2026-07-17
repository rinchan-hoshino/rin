import { register } from "node:module";

const target = "dist/core/rin-bundled-extensions.js";
const replacement = `
  export const BUILT_IN_RIN_EXTENSIONS = [
    {
      id: "owner-lifecycle",
      label: "Owner Lifecycle",
      description: "Lifecycle-backed owner fixture",
    },
    {
      id: "owner-fallback",
      label: "Owner Fallback",
      description: "Definition-backed owner fixture",
      onEnable: async ({ agentDir }) => {
        globalThis.__rinBuiltInOwnerEvents.push(["fallback", agentDir]);
      },
    },
  ];
  export function resolveBundledRinExtensionPath(id) {
    return id === "owner-lifecycle" ? process.env.RIN_TEST_BUILT_IN_EXTENSION_DIR || "" : "";
  }
  export function isBuiltInRinExtensionEnabled(entries, id) {
    return entries.includes("rin:" + id);
  }
  export function setBuiltInRinExtensionEnabled(entries, id, enabled) {
    const value = "rin:" + id;
    const next = entries.filter((entry) => entry !== value && entry !== "!" + value);
    if (enabled) next.push(value);
    else next.push("!" + value);
    return next;
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
