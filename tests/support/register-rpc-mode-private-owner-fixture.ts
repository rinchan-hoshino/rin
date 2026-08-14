import { register } from "node:module";

const target = "/dist/core/rin-daemon/rpc-mode.js";
const hookSource = `
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith(${JSON.stringify(target)})) return loaded;
  return {
    ...loaded,
    source: String(loaded.source) + "\\nexport { createExtensionUiResponseParser as __rinOwnerCreateExtensionUiResponseParser, stableJson as __rinOwnerStableJson, rpcRequestTag as __rinOwnerRpcRequestTag, nativeInputOutcome as __rinOwnerNativeInputOutcome, getSessionEntries as __rinOwnerGetSessionEntries, getSessionEntriesSince as __rinOwnerGetSessionEntriesSince, getSessionTree as __rinOwnerGetSessionTree, getSessionLeafId as __rinOwnerGetSessionLeafId, persistedNativeIdentityOutcome as __rinOwnerPersistedNativeIdentityOutcome, persistedNativeRequestOutcome as __rinOwnerPersistedNativeRequestOutcome, nativeRequestReceiptState as __rinOwnerNativeRequestReceiptState, logoutSessionProvider as __rinOwnerLogoutSessionProvider };\\n",
    shortCircuit: true,
  };
}
`;
register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);
