import type { ChatMessagePart } from "../rin-lib/chat-outbox-contract.js";
import { toStoredSessionFile } from "../session/ref.js";
import { safeString } from "../text-utils.js";

export type ChatAssistantDelivery = {
  chatKey: string;
  deliveryKind?: "final" | "interim" | "passive_notice" | "error";
  parts: ChatMessagePart[];
  coalesceWithWorkingMessage?: boolean;
  exclusiveProgressMessage?: boolean;
  sessionFile?: string;
  sessionBinding?: "conversation";
};

export type ChatAssistantDeliveryInput = {
  text?: string;
  parts?: ChatMessagePart[];
  replyToMessageId?: string;
  sessionFile?: string;
  bindSession?: boolean;
  deliveryKind?: "final" | "error";
};

export function withChatQuotePart(
  parts: ChatMessagePart[] | undefined,
  replyToMessageId: unknown,
) {
  const nodes = Array.isArray(parts) ? parts.filter(Boolean) : [];
  const id = safeString(replyToMessageId).trim();
  if (!id || nodes.some((part) => part.type === "quote")) return nodes;
  return [{ type: "quote" as const, id }, ...nodes];
}

export function conversationSessionPayload(
  enabled: boolean,
  sessionFile: string | undefined,
) {
  if (!enabled || !sessionFile) return {};
  return {
    sessionFile,
    sessionBinding: "conversation" as const,
  };
}

export function buildChatAssistantDelivery(
  owner: {
    agentDir: string;
    chatKey: string;
    currentSessionFile?: string;
  },
  input: ChatAssistantDeliveryInput,
): ChatAssistantDelivery {
  const text = safeString(input.text).trim();
  const parts = Array.isArray(input.parts) ? input.parts.filter(Boolean) : [];
  const sessionFile = toStoredSessionFile(
    owner.agentDir,
    input.sessionFile || owner.currentSessionFile,
  );
  const sessionPayload =
    input.bindSession === false || !sessionFile
      ? {}
      : {
          sessionFile,
          sessionBinding: "conversation" as const,
        };
  return {
    chatKey: owner.chatKey,
    deliveryKind: input.deliveryKind || "final",
    parts: withChatQuotePart(
      parts.length ? parts : [{ type: "text", text }],
      input.replyToMessageId,
    ),
    ...sessionPayload,
  };
}
