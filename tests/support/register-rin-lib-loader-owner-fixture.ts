import "./require-test-sandbox.ts";
import { register } from "node:module";

const hookSource = `
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith("/dist/core/rin-lib/loader.js")) return loaded;
  const original = String(loaded.source);
  const source = original.replace(
    /await import\\(([^)]+)\\)/g,
    "await import(__rinOwnerImportSpecifier($1))",
  ) +
    "\\nconst __rinOwnerImportSpecifier = (specifier) => globalThis.__rinOwnerLoaderReject" +
    " ? specifier + '/owner-lazy-import-failure' : specifier;\\n";
  return { ...loaded, source, shortCircuit: true };
}
`;
register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);
