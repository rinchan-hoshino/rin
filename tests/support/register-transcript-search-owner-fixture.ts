import "./require-test-sandbox.ts";
import { register } from "node:module";

const target = "/dist/core/memory/transcript-search.js";
const hookSource = `
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith(${JSON.stringify(target)})) return loaded;
  return {
    ...loaded,
    source: String(loaded.source) + "\\nexport { buildStructuredTokens as __rinOwnerBuildStructuredTokens, createCjkTrigrams as __rinOwnerCreateCjkTrigrams, escapeFtsPhrase as __rinOwnerEscapeFtsPhrase, buildTokenFtsQuery as __rinOwnerBuildTokenFtsQuery, buildTrigramFtsQuery as __rinOwnerBuildTrigramFtsQuery, timestampValue as __rinOwnerTimestampValue, isRebuildableTranscriptSearchDbError as __rinOwnerIsRebuildableTranscriptSearchDbError, isSqliteBusyError as __rinOwnerIsSqliteBusyError, processIsAlive as __rinOwnerProcessIsAlive, addCandidateScore as __rinOwnerAddCandidateScore, candidateHaystack as __rinOwnerCandidateHaystack, exactCandidateBoost as __rinOwnerExactCandidateBoost };\\n",
    shortCircuit: true,
  };
}
`;
register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);
