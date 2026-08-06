import { register } from "node:module";

const target = "/dist/core/rin-install/daemon-update-fence.js";
const hookSource = `
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith(${JSON.stringify(target)})) return loaded;
  return {
    ...loaded,
    source: String(loaded.source) + "\\nexport { waitForExit as __rinOwnerWaitForExit, waitForConfirmedExit as __rinOwnerWaitForConfirmedExit, terminateHolder as __rinOwnerTerminateHolder };\\n",
    shortCircuit: true,
  };
}
`;
register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);
