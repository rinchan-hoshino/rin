import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import webSearchModule from "../../src/core/rin-web-search/index.ts";

export default function webSearchExtension(pi: ExtensionAPI) {
  const capability = webSearchModule();
  for (const tool of capability.tools || []) {
    pi.registerTool(tool);
  }
}
