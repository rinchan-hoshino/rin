import { register } from "node:module";

const target = "/dist/core/self-improve/async-jobs.js";
const hookSource = `
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith(${JSON.stringify(target)})) return loaded;
  return {
    ...loaded,
    source: String(loaded.source) + "\\nexport { resolveAgentDir as __rinOwnerResolveAgentDir, resolveSessionFile as __rinOwnerResolveSessionFile, normalizeAdditionalExtensionPaths as __rinOwnerNormalizeAdditionalExtensionPaths, sameJob as __rinOwnerSameJob, processExists as __rinOwnerProcessExists, lockIsExpired as __rinOwnerLockIsExpired, normalizeChangedFiles as __rinOwnerNormalizeChangedFiles, truncateText as __rinOwnerTruncateText, normalizeErrorMessage as __rinOwnerNormalizeErrorMessage, normalizeAuditReference as __rinOwnerNormalizeAuditReference, recoverHistoryText as __rinOwnerRecoverHistoryText, persistedExecutionStartedAt as __rinOwnerPersistedExecutionStartedAt, lockPayload as __rinOwnerLockPayload };\\n",
    shortCircuit: true,
  };
}
`;
register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);
