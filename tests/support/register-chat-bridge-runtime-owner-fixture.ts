import "./require-test-sandbox.ts";
import { register } from "node:module";

const target = "dist/core/chat-bridge/runtime.js";
const hook = `
const target=${JSON.stringify(target)};
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith(target)) return loaded;
  return {
    ...loaded,
    shortCircuit: true,
    source: String(loaded.source) + "\\nexport { waitForOutboxDelivery as __rinOwnerWaitForOutboxDelivery };\\n",
  };
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);
