import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { chatDataPath } from "../data-layout.js";
import {
  removeFileIfExists,
  readJsonFile,
  writeJsonAtomic,
} from "../platform/fs.js";
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
    }
  | {
      type: "todo";
      title?: string;
      items: Array<{ text: string; done?: boolean }>;
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
      coalesceWithWorkingMessage?: boolean;
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
      deliveryKind?: ChatDeliveryKind;
      coalesceWithWorkingMessage?: boolean;
      sessionId?: string;
      sessionFile?: string;
      sessionBinding?: "conversation";
      parts: ChatMessagePart[];
    };

export type ChatOutboxPayloadInput =
  | ChatOutboxPayload
  | {
      type?: "text_delivery" | "parts_delivery";
      createdAt?: string;
      chatKey: string;
      taskId?: string;
      runId?: string;
      requestId?: string;
      deliveryKind?: ChatDeliveryKind;
      text?: string;
      replyToMessageId?: string;
      coalesceWithWorkingMessage?: boolean;
      sessionId?: string;
      sessionFile?: string;
      sessionBinding?: "conversation";
      parts?: ChatMessagePart[];
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
  idempotencyKey?: string;
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
  deliveryUnconfirmed?: boolean;
  postDelivery?: ChatOutboxPostDelivery;
};

export type EnqueueChatOutboxOptions = {
  id?: string;
  idempotencyKey?: string;
  deliveryKind?: ChatOutboxDeliveryKind;
  postDelivery?: ChatOutboxPostDelivery;
};

const DAY_MS = 24 * 60 * 60 * 1000;
export const CHAT_OUTBOX_DELIVERED_HISTORY_RETENTION_MS = 7 * DAY_MS;
export const CHAT_OUTBOX_FAILED_HISTORY_RETENTION_MS = 14 * DAY_MS;

let sequenceCounter = 0;

export function chatOutboxDir(agentDir: string) {
  return chatDataPath(agentDir, "outbox");
}

export function chatOutboxItemsDir(agentDir: string) {
  return path.join(chatOutboxDir(agentDir), "items");
}

export function chatOutboxHistoryDir(agentDir: string) {
  return path.join(chatOutboxDir(agentDir), "history");
}

export function chatOutboxHistoryItemsDir(
  agentDir: string,
  status: Extract<ChatOutboxItemStatus, "delivered" | "failed">,
) {
  return path.join(chatOutboxHistoryDir(agentDir), status);
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

function stableOutboxIdForKey(key: string) {
  return `dedupe-${crypto.createHash("sha256").update(key).digest("hex")}`;
}

export function chatOutboxItemPath(agentDir: string, id: string) {
  return path.join(chatOutboxItemsDir(agentDir), `${sanitizeIdPart(id)}.json`);
}

export function chatOutboxHistoryItemPath(
  agentDir: string,
  id: string,
  status: Extract<ChatOutboxItemStatus, "delivered" | "failed">,
) {
  return path.join(
    chatOutboxHistoryItemsDir(agentDir, status),
    `${sanitizeIdPart(id)}.json`,
  );
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

export function normalizeChatOutboxPayload(
  raw: unknown,
): ChatOutboxPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as Record<string, unknown>;
  const chatKey = safeString(payload.chatKey).trim();
  if (!chatKey) return null;
  const explicitType = safeString(payload.type).trim();
  const type =
    explicitType === "text_delivery" || explicitType === "parts_delivery"
      ? explicitType
      : Array.isArray(payload.parts)
        ? "parts_delivery"
        : safeString(payload.text).trim()
          ? "text_delivery"
          : "";
  if (type === "text_delivery") {
    const text = safeString(payload.text).trim();
    if (!text) return null;
    return {
      ...payload,
      type,
      chatKey,
      text,
      createdAt: safeString(payload.createdAt).trim() || nowIso(),
    } as ChatOutboxPayload;
  }
  if (type === "parts_delivery") {
    const parts = Array.isArray(payload.parts)
      ? payload.parts.filter(Boolean)
      : [];
    if (!parts.length) return null;
    return {
      ...payload,
      type,
      chatKey,
      parts,
      createdAt: safeString(payload.createdAt).trim() || nowIso(),
    } as ChatOutboxPayload;
  }
  return null;
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
    idempotencyKey: safeString(raw?.idempotencyKey).trim() || undefined,
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
    deliveryUnconfirmed: raw?.deliveryUnconfirmed === true || undefined,
    postDelivery:
      raw?.postDelivery && typeof raw.postDelivery === "object"
        ? raw.postDelivery
        : undefined,
  };
}

export function readChatOutboxItemById(agentDir: string, id: string) {
  const activePath = chatOutboxItemPath(agentDir, id);
  const active = readChatOutboxItem(agentDir, activePath);
  if (active) return { filePath: activePath, item: active };
  for (const status of ["delivered", "failed"] as const) {
    const filePath = chatOutboxHistoryItemPath(agentDir, id, status);
    const item = readChatOutboxItem(agentDir, filePath);
    if (item) return { filePath, item };
  }
  return null;
}

export function writeChatOutboxItem(agentDir: string, item: ChatOutboxItem) {
  if (item.status === "delivered" || item.status === "failed") {
    writeJsonAtomic(
      chatOutboxHistoryItemPath(agentDir, item.id, item.status),
      item,
    );
    removeFileIfExists(chatOutboxItemPath(agentDir, item.id));
    return;
  }
  writeJsonAtomic(chatOutboxItemPath(agentDir, item.id), item);
  removeFileIfExists(chatOutboxHistoryItemPath(agentDir, item.id, "delivered"));
  removeFileIfExists(chatOutboxHistoryItemPath(agentDir, item.id, "failed"));
}

export function readChatOutboxItem(agentDir: string, filePath: string) {
  const raw = readJsonFile<any>(filePath, null);
  return normalizeOutboxItem(agentDir, raw);
}

export function cleanupChatOutboxHistory(
  agentDir: string,
  options: {
    nowMs?: number;
    deliveredRetentionMs?: number;
    failedRetentionMs?: number;
  } = {},
) {
  const nowMs = Number(options.nowMs || Date.now());
  const retentionByStatus = {
    delivered: Math.max(
      0,
      Number(
        options.deliveredRetentionMs ??
          CHAT_OUTBOX_DELIVERED_HISTORY_RETENTION_MS,
      ),
    ),
    failed: Math.max(
      0,
      Number(
        options.failedRetentionMs ?? CHAT_OUTBOX_FAILED_HISTORY_RETENTION_MS,
      ),
    ),
  } as const;
  const result = { delivered: 0, failed: 0 };
  for (const status of ["delivered", "failed"] as const) {
    const dir = chatOutboxHistoryItemsDir(agentDir, status);
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const retentionMs = retentionByStatus[status];
    const cutoffMs = nowMs - retentionMs;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const filePath = path.join(dir, name);
      const item = readChatOutboxItem(agentDir, filePath);
      if (!item || item.status !== status) continue;
      const completedAt =
        status === "delivered"
          ? item.deliveredAt || item.updatedAt || item.createdAt
          : item.failedAt || item.updatedAt || item.createdAt;
      const completedAtMs = Date.parse(safeString(completedAt).trim());
      if (!Number.isFinite(completedAtMs) || completedAtMs > cutoffMs) {
        continue;
      }
      removeFileIfExists(filePath);
      result[status] += 1;
    }
  }
  return result;
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
      if (!item) return null;
      if (item.status === "delivered" || item.status === "failed") {
        writeChatOutboxItem(agentDir, item);
        return null;
      }
      return { filePath, item };
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
  payload: ChatOutboxPayloadInput,
  options: EnqueueChatOutboxOptions = {},
) {
  const createdAt = safeString(payload.createdAt).trim() || nowIso();
  const normalizedPayload = normalizeChatOutboxPayload({
    ...payload,
    createdAt,
  });
  if (!normalizedPayload) throw new Error("chat_outbox_invalid_payload");
  const idempotencyKey = safeString(options.idempotencyKey).trim();
  const id =
    sanitizeIdPart(options.id) ||
    (idempotencyKey ? stableOutboxIdForKey(idempotencyKey) : createOutboxId());
  const filePath = chatOutboxItemPath(agentDir, id);
  const existing = readChatOutboxItemById(agentDir, id);
  if (existing) {
    if (idempotencyKey && existing.item.idempotencyKey !== idempotencyKey) {
      throw new Error("chat_outbox_idempotency_collision");
    }
    return existing.filePath;
  }
  const sequence =
    Date.now() * 1000 + (sequenceCounter = (sequenceCounter + 1) % 1_000_000);
  const item: ChatOutboxItem = {
    id,
    idempotencyKey: idempotencyKey || undefined,
    status: "queued",
    createdAt: normalizedPayload.createdAt,
    updatedAt: normalizedPayload.createdAt,
    sequence,
    deliveryKind: normalizeDeliveryKind(options.deliveryKind),
    payload: normalizedPayload,
    attempts: 0,
    postDelivery: options.postDelivery,
  };
  writeChatOutboxItem(agentDir, item);
  return filePath;
}
