import { register } from "node:module";

const target = "dist/core/rin-install/persist.js";
const hook = `
const target=${JSON.stringify(target)};
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith(target)) return loaded;
  return {
    ...loaded,
    shortCircuit: true,
    source: String(loaded.source) + "\\nexport { parseJsonObject as __rinOwnerParseJsonObject, resolveInstallOwner as __rinOwnerResolveInstallOwner, normalizeManagedFilesManifest as __rinOwnerNormalizeManagedFilesManifest, mergeManagedFilesManifests as __rinOwnerMergeManagedFilesManifests };\\n",
  };
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);
