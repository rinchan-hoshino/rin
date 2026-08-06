import { register } from "node:module";

const replacement = `data:text/javascript,${encodeURIComponent(`
export async function syncAgentPracticesDocs(agentDir, options) {
  return await globalThis.__rinDocsOwnerSync(agentDir, options);
}
`)}`;
const hook = `
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (resolved.url.includes("dist/core/docs/practices-sync.js")) {
    return { url: ${JSON.stringify(replacement)}, shortCircuit: true };
  }
  return resolved;
}
`;
register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);
