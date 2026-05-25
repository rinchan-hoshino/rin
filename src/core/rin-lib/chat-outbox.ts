import fs from "node:fs";
import path from "node:path";

import { chatDataPath } from "../data-layout.js";
import { readJsonFile, writeJsonAtomic } from "../platform/fs.js";
import { safeString } from "../text-utils.js";

export type ChatMessagePart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "markdown";
      text: string;
    }
  | {
      type: "at";
      id: string;
      name?: string;
    }
  | {
      type: "quote";
      id: string;
    }
  | {
      type: "image";
      path?: string;
      url?: string;
      mimeType?: string;
    }
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
    };

export type ChatDeliveryKind = "final" | "interim" | "passive_notice";

export type ChatOutboxPayload =
  | {
      type: "text_delivery";
      createdAt: string;
      chatKey: string;
      taskId?: string;
      runId?: string;
      requestId?: string;
      deliveryKind?: ChatDeliveryKind;
      text: string;
      replyToMessageId?: string;
      sessionId?: string;
      sessionFile?: string;
      sessionBinding?: "conversation";
    }
  | {
      type: "parts_delivery";
      createdAt: string;
      requestId?: string;
      taskId?: string;
      runId?: string;
      chatKey: string;
      sessionId?: string;
      sessionFile?: string;
      sessionBinding?: "conversation";
      parts: ChatMessagePart[];
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
};

export type ChatOutboxItemStatus =
  | "queued"
  | "sending"
  | "delivered"
  | "failed";

export type ChatOutboxItem = {
  id: string;
  status: ChatOutboxItemStatus;
  createdAt: string;
  updatedAt: string;
  sequence: number;
  deliveryKind: ChatOutboxDeliveryKind;
  payload: ChatOutboxPayload;
  attempts: number;
  lastError?: string;
  nextAttemptAt?: string;
  failedAt?: string;
  failureKind?: "retryable" | "permanent" | "attempts_exhausted";
  deliveredAt?: string;
  deliveryResult?: string[];
  postDelivery?: ChatOutboxPostDelivery;
};

export type EnqueueChatOutboxOptions = {
  id?: string;
  deliveryKind?: ChatOutboxDeliveryKind;
  postDelivery?: ChatOutboxPostDelivery;
};

let sequenceCounter = 0;

export function chatOutboxDir(agentDir: string) {
  return chatDataPath(agentDir, "outbox");
}

export function chatOutboxItemsDir(agentDir: string) {
  return path.join(chatOutboxDir(agentDir), "items");
}

function nowIso() {
  return new Date().toISOString();
}

function sanitizeIdPart(value: unknown) {
  return safeString(value)
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, "-");
}

function createOutboxId() {
  const seq = (sequenceCounter = (sequenceCounter + 1) % 1_000_000);
  return `${Date.now()}-${process.pid}-${seq}-${Math.random().toString(36).slice(2)}`;
}

export function chatOutboxItemPath(agentDir: string, id: string) {
  return path.join(chatOutboxItemsDir(agentDir), `${sanitizeIdPart(id)}.json`);
}

function normalizeDeliveryKind(value: unknown): ChatOutboxDeliveryKind {
  const text = safeString(value).trim();
  if (
    text === "final" ||
    text === "interim" ||
    text === "passive_notice" ||
    text === "error" ||
    text === "command_ack" ||
    text === "generic"
  ) {
    return text;
  }
  return "generic";
}

function normalizeOutboxItem(
  agentDir: string,
  raw: any,
): ChatOutboxItem | null {
  const payload =
    raw?.payload && typeof raw.payload === "object" ? raw.payload : raw;
  const chatKey = safeString(payload?.chatKey).trim();
  const type = safeString(payload?.type).trim();
  if (!chatKey || (type !== "text_delivery" && type !== "parts_delivery")) {
    return null;
  }
  const id = safeString(raw?.id).trim() || createOutboxId();
  const createdAt =
    safeString(raw?.createdAt).trim() ||
    safeString(payload.createdAt).trim() ||
    nowIso();
  return {
    id,
    status:
      raw?.status === "sending" ||
      raw?.status === "delivered" ||
      raw?.status === "failed"
        ? raw.status
        : "queued",
    createdAt,
    updatedAt: safeString(raw?.updatedAt).trim() || createdAt,
    sequence: Number.isFinite(Number(raw?.sequence))
      ? Number(raw.sequence)
      : Date.parse(createdAt) || Date.now(),
    deliveryKind: normalizeDeliveryKind(raw?.deliveryKind),
    payload,
    attempts: Math.max(0, Math.floor(Number(raw?.attempts || 0))),
    lastError: safeString(raw?.lastError).trim() || undefined,
    nextAttemptAt: safeString(raw?.nextAttemptAt).trim() || undefined,
    failedAt: safeString(raw?.failedAt).trim() || undefined,
    failureKind:
      raw?.failureKind === "retryable" ||
      raw?.failureKind === "permanent" ||
      raw?.failureKind === "attempts_exhausted"
        ? raw.failureKind
        : undefined,
    deliveredAt: safeString(raw?.deliveredAt).trim() || undefined,
    deliveryResult: Array.isArray(raw?.deliveryResult)
      ? raw.deliveryResult
          .map((item: unknown) => safeString(item).trim())
          .filter(Boolean)
      : undefined,
    postDelivery:
      raw?.postDelivery && typeof raw.postDelivery === "object"
        ? raw.postDelivery
        : undefined,
  };
}

export function writeChatOutboxItem(agentDir: string, item: ChatOutboxItem) {
  writeJsonAtomic(chatOutboxItemPath(agentDir, item.id), item);
}

export function readChatOutboxItem(agentDir: string, filePath: string) {
  const raw = readJsonFile<any>(filePath, null);
  return normalizeOutboxItem(agentDir, raw);
}

export function listChatOutboxItems(agentDir: string) {
  const dir = chatOutboxItemsDir(agentDir);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [] as Array<{ filePath: string; item: ChatOutboxItem }>;
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const filePath = path.join(dir, name);
      const item = readChatOutboxItem(agentDir, filePath);
      return item ? { filePath, item } : null;
    })
    .filter(Boolean)
    .sort(
      (a: any, b: any) =>
        a.item.sequence - b.item.sequence || a.item.id.localeCompare(b.item.id),
    ) as Array<{
    filePath: string;
    item: ChatOutboxItem;
  }>;
}

export function enqueueChatOutboxPayload(
  agentDir: string,
  payload: ChatOutboxPayload,
  options: EnqueueChatOutboxOptions = {},
) {
  const createdAt = safeString(payload.createdAt).trim() || nowIso();
  const sequence =
    Date.now() * 1000 + (sequenceCounter = (sequenceCounter + 1) % 1_000_000);
  const item: ChatOutboxItem = {
    id: sanitizeIdPart(options.id) || createOutboxId(),
    status: "queued",
    createdAt,
    updatedAt: createdAt,
    sequence,
    deliveryKind: normalizeDeliveryKind(options.deliveryKind),
    payload: { ...payload, createdAt } as ChatOutboxPayload,
    attempts: 0,
    postDelivery: options.postDelivery,
  };
  writeChatOutboxItem(agentDir, item);
  return chatOutboxItemPath(agentDir, item.id);
}
