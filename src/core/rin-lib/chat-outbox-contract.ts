export type ChatMessagePart =
  | { type: "text"; text: string }
  | { type: "markdown"; text: string }
  | { type: "at"; id: string; name?: string }
  | { type: "quote"; id: string }
  | { type: "image"; path?: string; url?: string; mimeType?: string }
  | {
      type: "file";
      path?: string;
      url?: string;
      name?: string;
      mimeType?: string;
    }
  | {
      type: "video" | "audio" | "sticker";
      path?: string;
      url?: string;
      name?: string;
      mimeType?: string;
    }
  | {
      type: "todo";
      title?: string;
      items: Array<{ text: string; done?: boolean }>;
    };

export type ChatDeliveryKind = "final" | "interim" | "passive_notice" | "error";

export type ChatOutboxIncomingMessage = {
  text: string;
  session: Record<string, unknown>;
  promptMeta: Record<string, unknown>;
  deliverFinal?: boolean;
  quietMode?: boolean;
};

export type ChatOutboxPayload = {
  createdAt: string;
  requestId?: string;
  taskId?: string;
  runId?: string;
  chatKey: string;
  deliveryKind?: ChatDeliveryKind;
  coalesceWithWorkingMessage?: boolean;
  exclusiveProgressMessage?: boolean;
  sessionId?: string;
  sessionFile?: string;
  sessionBinding?: "conversation";
  parts: ChatMessagePart[];
  incomingMessage?: ChatOutboxIncomingMessage;
};

export type ChatOutboxPayloadInput =
  | ChatOutboxPayload
  | {
      createdAt?: string;
      chatKey: string;
      taskId?: string;
      runId?: string;
      requestId?: string;
      deliveryKind?: ChatDeliveryKind;
      coalesceWithWorkingMessage?: boolean;
      exclusiveProgressMessage?: boolean;
      sessionId?: string;
      sessionFile?: string;
      sessionBinding?: "conversation";
      parts?: ChatMessagePart[];
      incomingMessage?: ChatOutboxIncomingMessage;
    };

export type ChatOutboxDeliveryKind =
  | "final"
  | "interim"
  | "passive_notice"
  | "error"
  | "command_ack"
  | "generic";

export type ChatOutboxPostDelivery = {
  markProcessed?: {
    chatKey: string;
    messageId: string;
    sessionFile?: string;
    bindSession?: boolean;
  };
  markJoinedProcessed?: {
    ownerTurnId: string;
    deliveryKind: "outbox_final" | "outbox_error";
  };
};

export type ChatOutboxItemStatus =
  | "queued"
  | "sending"
  | "delivered"
  | "failed";

export type ChatOutboxItem = {
  id: string;
  turnId?: string;
  idempotencyKey?: string;
  status: ChatOutboxItemStatus;
  createdAt: string;
  updatedAt: string;
  sequence: number;
  deliveryKind: ChatOutboxDeliveryKind;
  payload: ChatOutboxPayload;
  attempts: number;
  ownerEpoch?: string;
  leaseUntil?: string;
  lastError?: string;
  nextAttemptAt?: string;
  failedAt?: string;
  failureKind?:
    | "retryable"
    | "partial"
    | "permanent"
    | "attempts_exhausted"
    | "expired";
  deliveredAt?: string;
  deliveryResult?: string[];
  deliveryUnconfirmed?: boolean;
  postDelivery?: ChatOutboxPostDelivery;
  postDeliveryAppliedAt?: string;
  dispatchStartedAt?: string;
  claimedFromStatus?: "queued" | "sending";
};

export type ChatOutboxDelivery = {
  deliveryId: string;
  outboxId: string;
  destination: string;
  fragmentIndex: number;
  state: "queued" | "sending" | "delivered" | "failed" | "unconfirmed";
  providerMessageId?: string;
  attempt: number;
  ownerEpoch?: string;
};

export type EnqueueChatOutboxOptions = {
  id?: string;
  idempotencyKey?: string;
  deliveryKind?: ChatOutboxDeliveryKind;
  normalizeExistingErrorParts?: (parts: ChatMessagePart[]) => ChatMessagePart[];
  postDelivery?: ChatOutboxPostDelivery;
  turnFence?: ChatOutboxTurnFence;
  terminalTurn?: ChatTerminalTurn;
  terminalRecordId?: string;
};

export type ChatTerminalTurn = {
  turnId: string;
  chatKey: string;
  messageId: string;
};

export type ChatOutboxTurnFence = {
  agentDir: string;
  turnId: string;
  chatKey: string;
  messageId: string;
  ownerEpoch: string;
  attempt: number;
};
