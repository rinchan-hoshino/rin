import "./require-test-sandbox.ts";
import { register } from "node:module";

const source = `
  export async function ensureSessionCatalog() {
    if (globalThis.__rinPagedListingEnsureError) {
      throw globalThis.__rinPagedListingEnsureError;
    }
  }
  export async function tryListSessionCatalogPage() {
    return globalThis.__rinPagedListingCatalogPage;
  }
  export async function listSessionRecordFiles() {
    return globalThis.__rinPagedListingFiles || [];
  }
  export async function loadSessionSummaries() {
    return globalThis.__rinPagedListingSummaries || [];
  }
`;
const replacementUrl = `data:text/javascript,${encodeURIComponent(source)}`;
const hookSource = `
  const replacementUrl = ${JSON.stringify(replacementUrl)};
  export async function resolve(specifier, context, nextResolve) {
    const resolved = await nextResolve(specifier, context);
    if (resolved.url.endsWith("/dist/core/session/catalog.js")) {
      return { url: replacementUrl, shortCircuit: true };
    }
    return resolved;
  }
`;
register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);
