import "./require-test-sandbox.ts";
import { register } from "node:module";

const target = "dist/core/chat/main.js";
const hook = `
const target=${JSON.stringify(target)};
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith(target)) return loaded;
  return {
    ...loaded,
    shortCircuit: true,
    source: String(loaded.source) + "\\nexport { isChatPlatformContribution as __rinOwnerIsChatPlatformContribution, loadExternalChatPlatformContributions as __rinOwnerLoadExternalChatPlatformContributions, isChatPlatform as __rinOwnerIsChatPlatform, addExternalChatPlatforms as __rinOwnerAddExternalChatPlatforms };\\n",
  };
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);
