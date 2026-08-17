import "./require-test-sandbox.ts";
import { register } from "node:module";

const hookSource = `
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith(${JSON.stringify("dist/core/rin-lib/capability-session.js")})) {
    return loaded;
  }
  const source = typeof loaded.source === "string"
    ? loaded.source
    : new TextDecoder().decode(loaded.source);
  const ownerExport = "\\nexport { noOpCoreActions as __rinOwnerNoOpCoreActions };\\n";
  return {
    ...loaded,
    source: source + ownerExport,
  };
}
`;

register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);
