import { readChatOutboxItemById } from "../rin-lib/chat-outbox.js";
import { safeString } from "../text-utils.js";

const CHAT_OUTBOX_DELIVERY_PENDING = "chat_outbox_delivery_pending";

export type ChatOutboxDeliveryPendingError = Error & {
  code: typeof CHAT_OUTBOX_DELIVERY_PENDING;
  outboxId: string;
};

export type ChatOutboxDeliveryPendingState = "pending" | "delivered" | null;

export function createChatOutboxDeliveryPendingError(
  outboxId: string,
): ChatOutboxDeliveryPendingError {
  return Object.assign(new Error(CHAT_OUTBOX_DELIVERY_PENDING), {
    code: CHAT_OUTBOX_DELIVERY_PENDING as typeof CHAT_OUTBOX_DELIVERY_PENDING,
    outboxId: safeString(outboxId).trim(),
  });
}

export function isChatOutboxDeliveryPendingError(
  error: unknown,
): error is ChatOutboxDeliveryPendingError {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    (error as any).code === CHAT_OUTBOX_DELIVERY_PENDING &&
    Boolean(safeString((error as any).outboxId).trim())
  );
}

export function resolveChatOutboxDeliveryPendingState(
  agentDir: string,
  error: unknown,
): ChatOutboxDeliveryPendingState {
  if (!isChatOutboxDeliveryPendingError(error)) return null;
  const current = readChatOutboxItemById(agentDir, error.outboxId)?.item;
  if (current?.status === "delivered") return "delivered";
  if (
    (current?.status === "queued" || current?.status === "sending") &&
    safeString(current.lastError).trim() === CHAT_OUTBOX_DELIVERY_PENDING
  ) {
    return "pending";
  }
  return null;
}
