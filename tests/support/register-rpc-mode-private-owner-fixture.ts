import "./require-test-sandbox.ts";
import { register } from "node:module";

const target = "/dist/core/rin-daemon/rpc-mode.js";
const hookSource = `
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith(${JSON.stringify(target)})) return loaded;
  return {
    ...loaded,
    source: String(loaded.source) + "\\nexport { createExtensionUiResponseParser as __rinOwnerCreateExtensionUiResponseParser };\\nexport { stableJson as __rinOwnerStableJson, rpcRequestTag as __rinOwnerRpcRequestTag, nativeInputOutcome as __rinOwnerNativeInputOutcome, persistedNativeIdentityOutcome as __rinOwnerPersistedNativeIdentityOutcome, persistedNativeRequestOutcome as __rinOwnerPersistedNativeRequestOutcome, nativeRequestReceiptState as __rinOwnerNativeRequestReceiptState } from './rpc-turn-command-handler.js';\\nexport { getSessionEntries as __rinOwnerGetSessionEntries, getSessionEntriesSince as __rinOwnerGetSessionEntriesSince, getSessionTree as __rinOwnerGetSessionTree, getSessionLeafId as __rinOwnerGetSessionLeafId } from './rpc-session-command-handler.js';\\nexport { logoutSessionProvider as __rinOwnerLogoutSessionProvider } from './rpc-auth-command-handler.js';\\n",
    shortCircuit: true,
  };
}
`;
register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);
