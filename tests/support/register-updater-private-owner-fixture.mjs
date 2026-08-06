import { register } from "node:module";

const target = "dist/core/rin-install/updater.js";
const hook = `
const target=${JSON.stringify(target)};
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith(target)) return loaded;
  return {
    ...loaded,
    shortCircuit: true,
    source: String(loaded.source) + "\\nexport { defaultReadInstalledRelease as __rinOwnerDefaultReadInstalledRelease, readInstalledReleasePreference as __rinOwnerReadInstalledReleasePreference };\\n",
  };
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);
