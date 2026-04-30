import type {
  RinCapabilityDefinition,
  RinCapabilityOptions,
} from "../rin-lib/capability-types.js";
import path from "node:path";

import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { formatToolCallLine } from "../pi/render-utils.js";
import { safeString } from "../text-utils.js";

async function loadSupportModule() {
  return await import("./support.js");
}

async function loadMessageStoreModule() {
  return await import("./message-store.js");
}

const paramsSchema = Type.Object({
  trust: Type.Union(
    [Type.Literal("OWNER"), Type.Literal("TRUSTED"), Type.Literal("OTHER")],
    {
      description:
        "Saved trust level for this chat user. Allowed values: `OWNER`, `TRUSTED`, or `OTHER`.",
    },
  ),
  messageId: Type.Optional(
    Type.String({
      description:
        "Platform message ID whose sender should be updated. Use this to save trust from a known chat message.",
    }),
  ),
  chatKey: Type.Optional(
    Type.String({
      description:
        "Optional chat to disambiguate duplicated platform message IDs, or explicit chat when platform/userId are provided.",
    }),
  ),
  platform: Type.Optional(
    Type.String({
      description:
        "Platform name like telegram or onebot. Required with userId when messageId is omitted.",
    }),
  ),
  userId: Type.Optional(
    Type.String({
      description:
        "Platform user ID to update. Required with platform when messageId is omitted.",
    }),
  ),
  name: Type.Optional(
    Type.String({
      description: "Optional display name hint to save with this user record.",
    }),
  ),
});

export default function saveChatUserTrustModule(
  options: RinCapabilityOptions,
): RinCapabilityDefinition {
  return {
    name: "chat-save-user-trust",
    tools: [
      {
        name: "save_chat_user_identity",
        label: "Save Chat User Identity",
        description: "Create or update saved identity info for a chat user.",
        promptSnippet: "Save identity info for a chat user.",
        promptGuidelines: [],
        parameters: paramsSchema,
        renderCall: (args, theme) => {
          const messageId = safeString((args as any)?.messageId).trim();
          const userId = safeString((args as any)?.userId).trim();
          const trust = safeString((args as any)?.trust).trim();
          const target = [messageId || userId || "user", trust]
            .filter(Boolean)
            .join(" ");
          return new Text(
            formatToolCallLine("save_chat_user_identity", target, theme),
            0,
            0,
          );
        },
        execute: (async (_toolCallId, params) => {
          const trust = safeString((params as any)?.trust).trim();
          const messageId = safeString((params as any)?.messageId).trim();
          const chatKey = safeString((params as any)?.chatKey).trim();
          const platformInput = safeString((params as any)?.platform).trim();
          const userIdInput = safeString((params as any)?.userId).trim();
          const nameInput = safeString((params as any)?.name).trim();

          let platform = platformInput;
          let userId = userIdInput;
          let name = nameInput;

          if (messageId) {
            const { normalizeChatMessageLookup } =
              await loadMessageStoreModule();
            const matches = normalizeChatMessageLookup(
              options.agentDir,
              messageId,
              chatKey || undefined,
            );
            if (!matches.length) {
              throw new Error(
                `Message not found: ${messageId}${chatKey ? ` (chatKey=${chatKey})` : ""}`,
              );
            }
            const target = matches[0];
            platform = safeString(target?.platform).trim();
            userId = safeString(target?.userId).trim();
            if (!name)
              name = safeString(target?.nickname || target?.chatName).trim();
          }

          if (!platform || !userId) {
            throw new Error(
              "Provide either messageId (optionally with chatKey) or platform and userId.",
            );
          }

          const { setIdentityTrust } = await loadSupportModule();
          const result = setIdentityTrust({
            dataDir: path.join(options.agentDir, "data"),
            platform,
            userId,
            trust: trust as "OWNER" | "TRUSTED" | "OTHER",
            name: name || undefined,
          });

          return {
            content: [
              {
                type: "text",
                text: [
                  `Saved chat user identity: ${result.trust}`,
                  `platform=${result.platform}`,
                  `userId=${result.userId}`,
                  result.name ? `name=${result.name}` : "",
                  `personId=${result.personId}`,
                  result.path,
                ]
                  .filter(Boolean)
                  .join("\n"),
              },
            ],
            details: result,
            isError: false,
          };
        }) as any,
      },
    ],
  };
}
