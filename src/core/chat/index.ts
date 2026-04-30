import type {
  RinCapabilityDefinition,
  RinCapabilityOptions,
} from "../rin-lib/capability-types.js";

import chatBridgeModule from "./chat-bridge.js";
import configureChatBridgeCommandModule from "./configure-chat-bridge.js";
import getChatMessageExtension from "./get-chat-message.js";
import listChatLogExtension from "./list-chat-log.js";
import saveChatUserTrustModule from "./save-chat-user-trust.js";

function mergeChatDefinitions(
  definitions: Array<RinCapabilityDefinition | void>,
): RinCapabilityDefinition {
  const current = definitions.map((definition) => definition || {});
  return {
    name: "chat",
    tools: current.flatMap((definition) => definition.tools || []),
    commands: current.flatMap((definition) => definition.commands || []),
    hooks: Object.assign(
      {},
      ...current.map((definition) => definition.hooks || {}),
    ),
  };
}

export default function chatModule(
  options: RinCapabilityOptions,
): RinCapabilityDefinition {
  return mergeChatDefinitions([
    configureChatBridgeCommandModule(),
    chatBridgeModule(),
    getChatMessageExtension(options),
    listChatLogExtension(options),
    saveChatUserTrustModule(options),
  ]);
}
