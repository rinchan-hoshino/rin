import { register } from "node:module";

const target = "dist/core/rin-install/legacy-service-hold.js";
const hook = `
const target=${JSON.stringify(target)};
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith(target)) return loaded;
  return {
    ...loaded,
    shortCircuit: true,
    source: String(loaded.source) + "\\nexport { isDevNullSymlink as __rinOwnerIsDevNullSymlink, restoreEntryNoReplace as __rinOwnerRestoreEntryNoReplace, sameFile as __rinOwnerSameFile };\\n",
  };
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);
