import { register } from "node:module";

const target = "/dist/core/self-improve/agent-dir.js";
const replacement = `
export const RIN_AGENT_DIR_ENV = "RIN_AGENT_DIR";
export function resolveAgentDir() { return ""; }
`;
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
