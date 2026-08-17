import "./require-test-sandbox.ts";
import { register } from "node:module";

const ownerExports: Record<string, string> = {
  "/dist/core/self-improve/async-jobs.js":
    "export { processExists as __rinOwnerProcessExists, lockIsExpired as __rinOwnerLockIsExpired, normalizeChangedFiles as __rinOwnerNormalizeChangedFiles, truncateText as __rinOwnerTruncateText, normalizeErrorMessage as __rinOwnerNormalizeErrorMessage, normalizeAuditReference as __rinOwnerNormalizeAuditReference, recoverHistoryText as __rinOwnerRecoverHistoryText, persistedExecutionStartedAt as __rinOwnerPersistedExecutionStartedAt, lockPayload as __rinOwnerLockPayload };",
  "/dist/core/self-improve/maintenance-queue.js":
    "export { resolveAgentDir as __rinOwnerResolveAgentDir, resolveSessionFile as __rinOwnerResolveSessionFile, normalizeAdditionalExtensionPaths as __rinOwnerNormalizeAdditionalExtensionPaths, sameJob as __rinOwnerSameJob };",
};
const hookSource = `
const ownerExports=${JSON.stringify(ownerExports)};
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  const target = Object.keys(ownerExports).find((candidate) => url.endsWith(candidate));
  if (!target) return loaded;
  return {
    ...loaded,
    source: String(loaded.source) + "\\n" + ownerExports[target] + "\\n",
    shortCircuit: true,
  };
}
`;
register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);
