import { register } from "node:module";

declare global {
  var __rinPiToolsOwnerModule: Record<string, unknown> | undefined;
}

const replacementUrl = `data:text/javascript,${encodeURIComponent(`
export function getPiToolsManagerModuleUrl() {
  return "file:///owner/pi-tools-manager.js";
}
export async function loadPiToolsManagerModule() {
  return globalThis.__rinPiToolsOwnerModule || {};
}
`)}`;
const hookSource = `
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (resolved.url.endsWith("dist/core/pi/private-api.js")) {
    return { url: ${JSON.stringify(replacementUrl)}, shortCircuit: true };
  }
  return resolved;
}
`;

register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);
