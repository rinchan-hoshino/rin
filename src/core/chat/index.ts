import type { RinCapabilityDefinition } from "../rin-lib/capability-types.js";

import configureChatBridgeCommandModule from "./configure-chat-bridge.js";

function mergeChatDefinitions(
  definitions: Array<RinCapabilityDefinition | void>,
): RinCapabilityDefinition {
  const current = definitions.map((definition) => definition || {});
  return {
    name: "chat",
    tools: current.flatMap((definition) => definition.tools || []),
    hooks: Object.assign(
      {},
      ...current.map((definition) => definition.hooks || {}),
    ),
  };
}

export default function chatModule(): RinCapabilityDefinition {
  return mergeChatDefinitions([configureChatBridgeCommandModule()]);
}
