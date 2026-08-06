import { register } from "node:module";

const target = "/dist/core/rin-daemon/lock.js";
const hookSource = `
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith(${JSON.stringify(target)})) return loaded;
  return {
    ...loaded,
    source: String(loaded.source) + "\\nexport { parseLockOwner as __rinOwnerParseLockOwner, readPublishedMarkerTarget as __rinOwnerReadPublishedMarkerTarget, validatedPublishedMarkerTarget as __rinOwnerValidatedPublishedMarkerTarget, removeMarker as __rinOwnerRemoveMarker };\\n",
    shortCircuit: true,
  };
}
`;
register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);
