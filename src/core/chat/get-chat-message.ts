import type {
  RinCapabilityDefinition,
  RinCapabilityOptions,
} from "../rin-lib/capability-types.js";

import { type TruncationResult } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";

import {
  buildUserFacingTextResult,
  formatToolCallLine,
  getToolResultUserText,
  prepareTruncatedAgentUserText,
  renderTextToolResult,
} from "../pi/render-utils.js";
import { safeString } from "../text-utils.js";

async function loadMessageStoreModule() {
  return await import("./message-store.js");
}

type GetChatMessageDetails = {
  messageId: string;
  chatKey?: string;
  matches: any[];
  userText?: string;
  truncation?: TruncationResult;
};

function formatGetChatMessageCall(args: any, theme: any) {
  const messageId = safeString(args?.messageId).trim();
  const chatKey = safeString(args?.chatKey).trim();
  return formatToolCallLine("get_chat_msg", messageId || "message", theme, {
    suffix: chatKey ? theme.fg("muted", ` ${chatKey}`) : "",
  });
}

function formatGetChatMessageResult(
  result: any,
  options: { expanded: boolean },
  theme: any,
  showImages: boolean,
) {
  return renderTextToolResult(result, options, theme, showImages, {
    truncation: result.details?.truncation as TruncationResult | undefined,
  });
}

function stripRequestedMessageFields(
  text: string,
  messageId: string,
  chatKey?: string,
) {
  const filtered = text
    .split("\n")
    .filter((line) => line !== `messageId=${messageId}`)
    .filter((line) => !(chatKey && line === `chatKey=${chatKey}`));
  return filtered.length ? filtered.join("\n") : text;
}

export default function chatGetMessageModule(
  options: RinCapabilityOptions,
): RinCapabilityDefinition {
  return {
    name: "chat-get-message",
    tools: [
      {
        name: "get_chat_msg",
        label: "Get Chat Message",
        description: "Get a specific chat message.",
        promptSnippet: "Get a specific chat message.",
        promptGuidelines: [
          "When chat metadata has `reply to message id: <id>`, always call get_chat_msg with that id before answering.",
        ],
        parameters: Type.Object({
          messageId: Type.String({
            description: "Platform message ID to look up.",
          }),
          chatKey: Type.Optional(
            Type.String({
              description:
                "Optional chat to disambiguate duplicated platform message IDs.",
            }),
          ),
        }),
        renderCall(args, theme) {
          return new Text(formatGetChatMessageCall(args, theme), 0, 0);
        },
        execute: (async (_toolCallId, params) => {
          const messageId = safeString((params as any)?.messageId).trim();
          const chatKey =
            safeString((params as any)?.chatKey).trim() || undefined;
          if (!messageId)
            throw new Error("chat_get_message_messageId_required");

          const agentDir = options.agentDir;
          const { normalizeChatMessageLookup, describeChatMessageRecord } =
            await loadMessageStoreModule();
          const matches = normalizeChatMessageLookup(
            agentDir,
            messageId,
            chatKey,
          );
          if (!matches.length) {
            return {
              content: [
                {
                  type: "text",
                  text: `Message not found: ${messageId}${chatKey ? ` (chatKey=${chatKey})` : ""}`,
                },
              ],
              details: {
                messageId,
                chatKey,
                matches,
              } satisfies GetChatMessageDetails,
              isError: true,
            };
          }

          const text = matches
            .map((item: any, index: number) => {
              const body = describeChatMessageRecord(item);
              return matches.length > 1 ? `match ${index + 1}\n${body}` : body;
            })
            .join("\n\n");
          const userText = matches
            .map((item: any, index: number) => {
              const body = stripRequestedMessageFields(
                describeChatMessageRecord(item),
                messageId,
                chatKey,
              );
              return matches.length > 1 ? `match ${index + 1}\n${body}` : body;
            })
            .join("\n\n");
          const truncated = prepareTruncatedAgentUserText(text, userText);

          return {
            content: [{ type: "text", text: truncated.outputText }],
            details: {
              messageId,
              chatKey,
              matches,
              userText: truncated.userPreviewText,
              truncation: truncated.userTruncation,
            } satisfies GetChatMessageDetails,
            isError: false,
          };
        }) as any,
        renderResult(result: any, options, theme, context) {
          const details = result.details as GetChatMessageDetails | undefined;
          if (!result.isError) {
            const userResult = buildUserFacingTextResult(
              result,
              context.showImages,
              {
                userText: details?.userText,
                details: { truncation: details?.truncation },
              },
            );
            return new Text(
              formatGetChatMessageResult(
                userResult,
                options,
                theme,
                context.showImages,
              ),
              0,
              0,
            );
          }
          return new Text(
            getToolResultUserText(
              result,
              context.showImages,
              details?.userText,
            ),
            0,
            0,
          );
        },
      },
    ],
  };
}
