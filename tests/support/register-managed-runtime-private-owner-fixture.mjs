import { register } from "node:module";

const target = "/dist/core/rin/managed-runtime-service.js";
const hookSource = `
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith(${JSON.stringify(target)})) return loaded;
  return {
    ...loaded,
    source: String(loaded.source) + "\\nexport { launchdDomainForTargetUser as __rinOwnerLaunchdDomainForTargetUser, tryBootoutLaunchd as __rinOwnerTryBootoutLaunchd, stopWindowsDaemonFromLock as __rinOwnerStopWindowsDaemonFromLock, waitForDaemonUnavailable as __rinOwnerWaitForDaemonUnavailable, tryManagedWindowsStartupAction as __rinOwnerTryManagedWindowsStartupAction };\\n",
    shortCircuit: true,
  };
}
`;
register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);
