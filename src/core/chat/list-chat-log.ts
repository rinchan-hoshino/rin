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
  prepareTruncatedAgentUserText,
  renderTextToolResult,
} from "../pi/render-utils.js";
import { safeString } from "../text-utils.js";
import { formatLocalDateOnly } from "./date.js";

async function loadChatLogModule() {
  return await import("./chat-log.js");
}

type ListChatLogDetails = {
  chatKey: string;
  date: string;
  filePath: string;
  count: number;
  entries: any[];
  userText?: string;
  truncation?: TruncationResult;
};

function formatListChatLogCall(args: any, theme: any) {
  const chatKey = safeString(args?.chatKey).trim();
  const date = safeString(args?.date).trim();
  return formatToolCallLine("list_chat_log", chatKey || "current chat", theme, {
    detailStyle: chatKey ? "accent" : "muted",
    suffix: theme.fg("muted", ` ${date || formatLocalDateOnly()}`),
  });
}

function formatListChatLogResult(
  result: any,
  options: { expanded: boolean },
  theme: any,
  showImages: boolean,
) {
  return renderTextToolResult(result, options, theme, showImages, {
    truncation: result.details?.truncation as TruncationResult | undefined,
  });
}

function formatUserListChatLogText(
  filePath: string,
  entries: any[],
  body: string,
) {
  if (!entries.length) {
    return `No chat log found\npath=${filePath}`;
  }
  return [`path=${filePath}`, `count=${entries.length}`, "", body].join("\n");
}

export default function chatListChatLogModule(
  options: RinCapabilityOptions,
): RinCapabilityDefinition {
  return {
    name: "chat-list-log",
    tools: [
      {
        name: "list_chat_log",
        label: "List Chat Log",
        description: "List chat records for a specific chat.",
        promptSnippet: "List chat records for a specific chat.",
        promptGuidelines: [],
        parameters: Type.Object({
          chatKey: Type.String({
            description:
              "Target chat like telegram/123456:987654321 or onebot/123456:private:12345.",
          }),
          date: Type.Optional(
            Type.String({
              description:
                "Optional date to inspect in YYYY-MM-DD format. Defaults to today.",
            }),
          ),
        }),
        execute: async (_toolCallId, params) => {
          const chatKey = safeString((params as any)?.chatKey).trim();
          const date =
            safeString((params as any)?.date).trim() || formatLocalDateOnly();
          if (!chatKey) throw new Error("chat_list_log_chatKey_required");

          const agentDir = options.agentDir;
          const { readChatLog, formatChatLog } = await loadChatLogModule();
          const { filePath, entries } = readChatLog(agentDir, chatKey, date);
          const body = entries.length ? formatChatLog(entries) : "";
          const agentText = entries.length
            ? [
                `chatKey=${chatKey}`,
                `date=${date}`,
                `path=${filePath}`,
                `count=${entries.length}`,
                "",
                body,
              ].join("\n")
            : `No chat log found\nchatKey=${chatKey}\ndate=${date}\npath=${filePath}`;
          const userText = formatUserListChatLogText(filePath, entries, body);
          const truncated = prepareTruncatedAgentUserText(agentText, userText);
          return {
            content: [{ type: "text", text: truncated.outputText }],
            details: {
              chatKey,
              date,
              filePath,
              count: entries.length,
              entries,
              userText: truncated.userPreviewText,
              truncation: truncated.userTruncation,
            } satisfies ListChatLogDetails,
            isError: false,
          };
        },
        renderCall(args, theme) {
          return new Text(formatListChatLogCall(args, theme), 0, 0);
        },
        renderResult(result, options, theme, context) {
          const details = result.details as ListChatLogDetails | undefined;
          const userResult = buildUserFacingTextResult(
            result,
            context.showImages,
            {
              userText: details?.userText,
              details: { truncation: details?.truncation },
            },
          );
          return new Text(
            formatListChatLogResult(
              userResult,
              options,
              theme,
              context.showImages,
            ),
            0,
            0,
          );
        },
      },
    ],
  };
}
