import "./require-test-sandbox.ts";
import { register } from "node:module";

const target = "/dist/core/chat/transport.js";
const hookSource = `
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith(${JSON.stringify(target)})) return loaded;
  return {
    ...loaded,
    source: String(loaded.source) + "\\nexport { buildOutboundMessageRecord as __rinOwnerBuildOutboundMessageRecord, normalizePositiveInteger as __rinOwnerNormalizePositiveInteger, dimensionsForMaxEdge as __rinOwnerDimensionsForMaxEdge, maybeKeepBestCandidate as __rinOwnerMaybeKeepBestCandidate };\\n",
    shortCircuit: true,
  };
}
`;
register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);
