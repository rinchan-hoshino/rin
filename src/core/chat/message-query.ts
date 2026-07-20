import {
  getChatMessage,
  listChatMessagesByChatWindow,
  type ChatMessageListWindow,
  type StoredChatMessage,
} from "./message-store.js";
import { extractChatQuoteMessageId } from "./rich-text.js";
import { safeString } from "../text-utils.js";

export type ChatMessageRead = Omit<
  StoredChatMessage,
  "quote" | "replyToMessageId"
>;

function canonicalizeQuoteNodes(nodes: any[]): any[] {
  return (Array.isArray(nodes) ? nodes : []).flatMap((node) => {
    if (!node || typeof node !== "object") return [];
    const type = safeString(node.type).trim().toLowerCase();
    if (type === "quote") {
      const id = safeString(node?.attrs?.id || node?.attrs?.messageId).trim();
      return id ? [{ type: "quote", attrs: { id }, children: [] }] : [];
    }
    return [
      Array.isArray(node.children)
        ? { ...node, children: canonicalizeQuoteNodes(node.children) }
        : node,
    ];
  });
}

export function canonicalizeChatMessageRead(
  record: StoredChatMessage,
): ChatMessageRead {
  const {
    quote: legacyQuote,
    replyToMessageId: legacyReplyToMessageId,
    ...message
  } = record;
  let elements = canonicalizeQuoteNodes(record.elements || []);
  if (!extractChatQuoteMessageId(elements)) {
    const id = safeString(
      legacyQuote?.messageId || legacyReplyToMessageId,
    ).trim();
    if (id) {
      elements = [
        { type: "quote", attrs: { id }, children: [] },
        ...(elements.length
          ? [{ type: "br", attrs: {}, children: [] }, ...elements]
          : []),
      ];
    }
  }
  return {
    ...message,
    elements,
  };
}

export function getChatMessageRead(
  agentDir: string,
  chatKey: string,
  messageId: string,
) {
  const record = getChatMessage(agentDir, chatKey, messageId);
  return record ? canonicalizeChatMessageRead(record) : null;
}

export function listChatMessageReads(
  agentDir: string,
  window: ChatMessageListWindow,
) {
  return listChatMessagesByChatWindow(agentDir, window).map(
    canonicalizeChatMessageRead,
  );
}
