import crypto from "node:crypto";

import {
  enqueueChatOutboxPayload,
  readChatOutboxItemById,
  type ChatMessagePart,
} from "../rin-lib/chat-outbox.js";
import { toStoredSessionFile } from "../session/ref.js";
import { safeString } from "./chat-helpers.js";
import { drainChatOutbox } from "./boot.js";

export type ChatDeliveryOutcome = {
  messageIds: string[];
  accepted: boolean;
  settled: boolean;
};

export type ChatAssistantDelivery = {
  chatKey: string;
  deliveryKind?: "final" | "interim" | "passive_notice" | "error";
  parts: ChatMessagePart[];
  replyToMessageId?: string;
  coalesceWithWorkingMessage?: boolean;
  sessionFile?: string;
  sessionBinding?: "conversation";
};

export type ChatDeliveryOptions = {
  id?: string;
  idempotencyKey?: string;
  deliveryKind?:
    | "final"
    | "interim"
    | "passive_notice"
    | "error"
    | "command_ack"
    | "generic";
  postDelivery?: any;
  coalesceWithWorkingMessage?: boolean;
  requireDelivery?: boolean;
  waitForDeliveryMs?: number;
  waitUntilDeliverySettled?: boolean;
};

type ChatOutboxItem = {
  status?: string;
  deliveryResult?: string[];
  lastError?: string;
};

type ChatDeliveryDependencies = {
  agentDir: string;
  app: any;
  h: any;
  logger: any;
  quietModeEnabled?: boolean;
  enqueue?: typeof enqueueChatOutboxPayload;
  drain?: typeof drainChatOutbox;
  read?: (id: string) => ChatOutboxItem | undefined;
  sleep?: (ms: number) => Promise<void>;
};

function outcome(
  messageIds: string[] = [],
  options: { accepted?: boolean; settled?: boolean } = {},
): ChatDeliveryOutcome {
  return {
    messageIds,
    accepted: options.accepted !== false,
    settled: options.settled !== false,
  };
}

function sha256Hex(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function buildChatAssistantDelivery(
  context: {
    agentDir: string;
    chatKey: string;
    currentSessionFile?: string;
  },
  input: {
    text?: string;
    parts?: ChatMessagePart[];
    replyToMessageId?: string;
    sessionFile?: string;
    bindSession?: boolean;
    deliveryKind?: "final" | "error";
  },
): ChatAssistantDelivery {
  const text = safeString(input.text).trim();
  const parts = Array.isArray(input.parts) ? input.parts.filter(Boolean) : [];
  if (!text && !parts.length) {
    throw new Error("chat_final_assistant_text_missing");
  }
  const sessionPayload =
    input.bindSession === false
      ? {}
      : {
          sessionFile: toStoredSessionFile(
            context.agentDir,
            input.sessionFile || context.currentSessionFile,
          ),
          sessionBinding: "conversation" as const,
        };
  const replyToMessageId = safeString(input.replyToMessageId).trim();
  return {
    chatKey: context.chatKey,
    deliveryKind: input.deliveryKind || "final",
    replyToMessageId: replyToMessageId || undefined,
    parts: [
      ...(replyToMessageId
        ? [{ type: "quote" as const, id: replyToMessageId }]
        : []),
      ...(parts.length ? parts : [{ type: "text" as const, text }]),
    ],
    ...sessionPayload,
  };
}

function shouldSuppressQuietDelivery(
  quietModeEnabled: boolean,
  deliveryKind: string,
) {
  return (
    quietModeEnabled && deliveryKind !== "final" && deliveryKind !== "error"
  );
}

async function waitForOutboxDelivery(
  deps: Required<Pick<ChatDeliveryDependencies, "read" | "sleep">>,
  id: string,
  timeoutMs?: number,
): Promise<string[] | null> {
  const hasDeadline = Number.isFinite(timeoutMs);
  const deadline = hasDeadline
    ? Date.now() + Math.max(1, Number(timeoutMs))
    : 0;
  while (!hasDeadline || Date.now() <= deadline) {
    const current = deps.read(id);
    if (current?.status === "delivered") return current.deliveryResult || [];
    if (current?.status === "failed") {
      throw new Error(current.lastError || "chat_outbox_delivery_failed");
    }
    const lastError = safeString(current?.lastError).trim();
    if (lastError && !/^chat_outbox_delivery_pending$/.test(lastError)) {
      throw new Error(lastError);
    }
    await deps.sleep(10);
  }
  return null;
}

export async function enqueueAndDrainChatDelivery(
  dependencies: ChatDeliveryDependencies,
  payload: any,
  options: ChatDeliveryOptions = {},
): Promise<ChatDeliveryOutcome> {
  const idempotencyKey = safeString(options.idempotencyKey).trim();
  const id =
    safeString(options.id).trim() ||
    (idempotencyKey
      ? `dedupe-${sha256Hex(idempotencyKey)}`
      : `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const deliveryKind = safeString(options.deliveryKind).trim();
  const normalizedPayload =
    (deliveryKind === "final" ||
      deliveryKind === "interim" ||
      deliveryKind === "passive_notice" ||
      deliveryKind === "error") &&
    !payload.deliveryKind
      ? { ...payload, deliveryKind }
      : payload;
  const effectiveDeliveryKind = safeString(
    normalizedPayload?.deliveryKind || deliveryKind,
  ).trim();
  if (
    shouldSuppressQuietDelivery(
      Boolean(dependencies.quietModeEnabled),
      effectiveDeliveryKind,
    )
  ) {
    return outcome([], { accepted: false });
  }

  const enqueue = dependencies.enqueue || enqueueChatOutboxPayload;
  const drain = dependencies.drain || drainChatOutbox;
  const read =
    dependencies.read ||
    ((itemId: string) =>
      readChatOutboxItemById(dependencies.agentDir, itemId)?.item);
  const sleep =
    dependencies.sleep ||
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  enqueue(dependencies.agentDir, normalizedPayload, { ...options, id });
  const results = await drain(
    dependencies.app,
    dependencies.agentDir,
    dependencies.h,
    dependencies.logger,
    {
      chatKey: safeString(normalizedPayload?.chatKey).trim(),
      itemId: id,
    },
  );
  const own: any = Array.isArray(results)
    ? results.find((item: any) => item?.id === id)
    : null;
  if (own && own.status !== "delivered") {
    if (own.status === "dispatched") {
      const deliveryResult = options.waitUntilDeliverySettled
        ? await waitForOutboxDelivery({ read, sleep }, id)
        : Number.isFinite(options.waitForDeliveryMs)
          ? await waitForOutboxDelivery(
              { read, sleep },
              id,
              options.waitForDeliveryMs,
            )
          : null;
      if (deliveryResult) return outcome(deliveryResult);
      const current = read(id);
      if (
        (current?.status === "queued" || current?.status === "sending") &&
        /^chat_outbox_delivery_pending$/.test(
          safeString(current.lastError).trim(),
        )
      ) {
        return outcome([], { settled: false });
      }
      if (options.requireDelivery) {
        throw new Error("chat_outbox_delivery_pending");
      }
      return outcome([]);
    }
    const errorMessage =
      safeString(own.error).trim() || "chat_outbox_delivery_pending";
    if (/^chat_outbox_delivery_timeout:/.test(errorMessage)) {
      return outcome(own.deliveryResult || []);
    }
    throw new Error(errorMessage);
  }
  if (!own && idempotencyKey) {
    const current = read(id);
    if (current?.status === "delivered") {
      return outcome(current.deliveryResult || []);
    }
    if (current?.status === "failed") {
      throw new Error(current.lastError || "chat_outbox_delivery_failed");
    }
    if (current?.status === "queued" || current?.status === "sending") {
      return outcome([], { settled: false });
    }
  }
  return outcome(own?.deliveryResult || []);
}
