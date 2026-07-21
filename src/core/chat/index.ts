import { Type } from "typebox";

import type { RinCapabilityDefinition } from "../rin-lib/capability-types.js";
import { requestDaemonCommand } from "../rin-daemon/client.js";
import { safeString } from "../text-utils.js";
import { normalizeChatKey } from "./support.js";

type ChatMessageRequest = (
  command: Record<string, unknown>,
) => Promise<unknown>;

type ChatModuleDependencies = {
  request?: ChatMessageRequest;
};

const chatKeyParam = Type.String({
  minLength: 1,
  description: "Exact target chat key, such as telegram/<bot-id>:<chat-id>.",
});

const messageIdParams = Type.Object({
  chatKey: chatKeyParam,
  messageId: Type.String({
    description: "Exact platform message ID in the target chat.",
  }),
});

const messageListParams = Type.Object({
  chatKey: chatKeyParam,
  before: Type.Optional(
    Type.String({
      description: "Return messages before this message ID in the target chat.",
    }),
  ),
  after: Type.Optional(
    Type.String({
      description: "Return messages after this message ID in the target chat.",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 100,
      description: "Number of messages to return (default 20, maximum 100).",
    }),
  ),
});

function requiredChatKey(value: unknown) {
  const chatKey = normalizeChatKey(value);
  if (!chatKey) throw new Error("chat_message_store_chatKey_required");
  return chatKey;
}

function normalizeLimit(value: unknown) {
  const requested = Number(value);
  return Number.isFinite(requested)
    ? Math.max(1, Math.min(100, Math.trunc(requested)))
    : 20;
}

const MAX_RESULT_BYTES = 48 * 1024;

const RESULT_COMPACTION_PLANS = [
  { maxStringChars: 16_000, maxArrayItems: 100, maxRootItems: 100 },
  { maxStringChars: 8_000, maxArrayItems: 100, maxRootItems: 100 },
  { maxStringChars: 4_000, maxArrayItems: 100, maxRootItems: 100 },
  { maxStringChars: 2_000, maxArrayItems: 50, maxRootItems: 100 },
  { maxStringChars: 1_000, maxArrayItems: 25, maxRootItems: 50 },
  { maxStringChars: 500, maxArrayItems: 10, maxRootItems: 25 },
  { maxStringChars: 256, maxArrayItems: 5, maxRootItems: 10 },
  { maxStringChars: 128, maxArrayItems: 3, maxRootItems: 5 },
  { maxStringChars: 64, maxArrayItems: 2, maxRootItems: 1 },
] as const;

type ResultCompaction = {
  stringsTruncated: number;
  arraysTruncated: number;
  arrayItemsOmitted: number;
  paginationRecommended?: boolean;
  resultOmitted?: boolean;
};

function truncateResultString(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  let prefix = value.slice(0, maxChars);
  const lastCodeUnit = prefix.charCodeAt(prefix.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    prefix = prefix.slice(0, -1);
  }
  return `${prefix}… [truncated ${value.length - prefix.length} chars]`;
}

function compactResultValue(
  value: unknown,
  plan: (typeof RESULT_COMPACTION_PLANS)[number],
  state: ResultCompaction,
  root = true,
): unknown {
  if (typeof value === "string") {
    const compacted = truncateResultString(value, plan.maxStringChars);
    if (compacted !== value) state.stringsTruncated += 1;
    return compacted;
  }
  if (Array.isArray(value)) {
    const limit = root ? plan.maxRootItems : plan.maxArrayItems;
    if (value.length > limit) {
      state.arraysTruncated += 1;
      state.arrayItemsOmitted += value.length - limit;
    }
    return value
      .slice(0, limit)
      .map((item) => compactResultValue(item, plan, state, false));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        compactResultValue(item, plan, state, false),
      ]),
    );
  }
  return value;
}

function boundedJsonResult(value: unknown, paginationRecommended: boolean) {
  const original = JSON.stringify(value, null, 2) ?? "null";
  if (Buffer.byteLength(original, "utf8") <= MAX_RESULT_BYTES) {
    return { text: original, truncation: undefined };
  }

  for (const plan of RESULT_COMPACTION_PLANS) {
    const truncation: ResultCompaction = {
      stringsTruncated: 0,
      arraysTruncated: 0,
      arrayItemsOmitted: 0,
      ...(paginationRecommended ? { paginationRecommended: true } : {}),
    };
    const result = compactResultValue(value, plan, truncation);
    const text = JSON.stringify({ result, truncation }, null, 2);
    if (Buffer.byteLength(text, "utf8") <= MAX_RESULT_BYTES) {
      return { text, truncation };
    }
  }

  const truncation: ResultCompaction = {
    stringsTruncated: 0,
    arraysTruncated: 0,
    arrayItemsOmitted: 0,
    ...(paginationRecommended ? { paginationRecommended: true } : {}),
    resultOmitted: true,
  };
  return {
    text: JSON.stringify({ result: null, truncation }, null, 2),
    truncation,
  };
}

function formatResult(
  value: unknown,
  options: { emptyText?: string; paginationRecommended?: boolean } = {},
) {
  if (value == null && options.emptyText) {
    return {
      content: [{ type: "text" as const, text: options.emptyText }],
      isError: true,
    };
  }
  const output = boundedJsonResult(value, !!options.paginationRecommended);
  return {
    content: [{ type: "text" as const, text: output.text }],
    details: { truncation: output.truncation },
  };
}

export default function chatModule(
  dependencies: ChatModuleDependencies = {},
): RinCapabilityDefinition {
  const request = dependencies.request || requestDaemonCommand;
  return {
    name: "chat",
    tools: [
      {
        name: "chat_message_get",
        label: "Get chat message",
        description:
          "Read one stored message by exact chat key and message ID.",
        promptSnippet:
          "Read one stored message by exact chat key and message ID.",
        promptGuidelines: [
          "Use chat_message_get when the request depends on a quoted or referenced message body that is not already present; pass its exact chatKey and message ID.",
        ],
        parameters: messageIdParams,
        async execute(
          _toolCallId: string,
          params: any,
          _signal: unknown,
          _onUpdate: unknown,
        ) {
          const chatKey = requiredChatKey(params?.chatKey);
          const messageId = safeString(params?.messageId).trim();
          if (!messageId) throw new Error("chat_message_id_required");
          const message = await request({
            type: "chat_message_get",
            payload: { chatKey, messageId },
          });
          return formatResult(message, {
            emptyText: `Message not found: ${messageId}`,
          });
        },
      },
      {
        name: "chat_message_list",
        label: "List chat messages",
        description:
          "Read a bounded chronological message window from an exact chat key.",
        promptSnippet:
          "Read a bounded chronological message window from an exact chat key.",
        promptGuidelines: [
          "Use chat_message_list for bounded target-chat context; pass its exact chatKey and paginate with message ID cursors instead of requesting broad history.",
        ],
        parameters: messageListParams,
        async execute(
          _toolCallId: string,
          params: any,
          _signal: unknown,
          _onUpdate: unknown,
        ) {
          const chatKey = requiredChatKey(params?.chatKey);
          const before = safeString(params?.before).trim();
          const after = safeString(params?.after).trim();
          const messages = await request({
            type: "chat_message_list",
            payload: {
              chatKey,
              ...(before ? { before } : {}),
              ...(after ? { after } : {}),
              limit: normalizeLimit(params?.limit),
            },
          });
          return formatResult(messages, { paginationRecommended: true });
        },
      },
    ],
  };
}
