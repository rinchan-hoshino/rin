import path from "node:path";
import { createHash } from "node:crypto";

import {
  asArray,
  cloneJson,
  cloneJsonIfObject,
  isJsonRecord,
} from "../json-utils.js";
import {
  claimFileToDir,
  listJsonFiles,
  moveFileToDir,
  removeFileIfExists,
  writeJsonAtomic,
} from "../platform/fs.js";
import {
  buildChatInboxRouting,
  serializeChatInboxSession,
} from "./inbound-normalization.js";
import { readJsonFile } from "./support.js";
import { nowIso } from "../time-utils.js";
import { safeString } from "../text-utils.js";
import { chatDataPath } from "../data-layout.js";

function hashKey(value: string) {
  return createHash("sha1").update(value).digest("hex");
}

export type ChatInboxItemRouting = {
  chatType: "private" | "group";
  isDirect: boolean;
  mentionLike: boolean;
  text?: string;
  userId?: string;
  nickname?: string;
  chatName?: string;
  replyToMessageId?: string;
};

export type ChatInboxItem = {
  version: 1;
  itemId: string;
  chatKey: string;
  messageId: string;
  createdAt: string;
  updatedAt: string;
  attemptCount: number;
  nextAttemptAt?: string;
  lastError?: string;
  routing: ChatInboxItemRouting;
  session: Record<string, unknown>;
  elements: any[];
};

export function chatInboxDir(agentDir: string) {
  return chatDataPath(agentDir, "inbox");
}

function pendingDir(agentDir: string) {
  return path.join(chatInboxDir(agentDir), "pending");
}

function processingDir(agentDir: string) {
  return path.join(chatInboxDir(agentDir), "processing");
}

function failedDir(agentDir: string) {
  return path.join(chatInboxDir(agentDir), "failed");
}

function itemFileName(itemId: string) {
  return `${itemId}.json`;
}

export function buildChatInboxItem(input: {
  chatKey: string;
  messageId: string;
  session: any;
  elements: any[];
}) {
  const chatKey = safeString(input.chatKey).trim();
  const messageId = safeString(input.messageId).trim();
  if (!chatKey) throw new Error("chat_inbox_chatKey_required");
  if (!messageId) throw new Error("chat_inbox_messageId_required");
  const now = nowIso();
  return {
    version: 1 as const,
    itemId: hashKey(`${chatKey}\n${messageId}`),
    chatKey,
    messageId,
    createdAt: now,
    updatedAt: now,
    attemptCount: 0,
    routing: buildChatInboxRouting(input.session, input.elements),
    session: serializeChatInboxSession(input.session),
    elements: cloneJson(asArray(input.elements)),
  } satisfies ChatInboxItem;
}

export function enqueueChatInboxItem(
  agentDir: string,
  input: { chatKey: string; messageId: string; session: any; elements: any[] },
) {
  const item = buildChatInboxItem(input);
  return writeChatInboxItem(
    path.join(pendingDir(agentDir), itemFileName(item.itemId)),
    item,
  );
}

export function listPendingChatInboxFiles(agentDir: string) {
  return listJsonFiles(pendingDir(agentDir));
}

export function listProcessingChatInboxFiles(agentDir: string) {
  return listJsonFiles(processingDir(agentDir));
}

export function readChatInboxItem(filePath: string) {
  return readJsonFile<ChatInboxItem | null>(filePath, null);
}

function asRecord(value: unknown): Record<string, any> {
  return isJsonRecord(value) ? value : {};
}

function pickTrimmedString(...values: unknown[]) {
  for (const value of values) {
    const text = safeString(value).trim();
    if (text) return text;
  }
  return undefined;
}

function mergeSessionRecord(
  session: Record<string, any>,
  key: string,
  patch: Record<string, unknown>,
) {
  const next = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  );
  if (!Object.keys(next).length) return;
  session[key] = {
    ...asRecord(session[key]),
    ...next,
  };
}

function updateChatInboxItem(
  item: ChatInboxItem,
  patch: Partial<ChatInboxItem>,
): ChatInboxItem {
  return {
    ...item,
    attemptCount: Number(item.attemptCount || 0) + 1,
    updatedAt: nowIso(),
    ...patch,
  };
}

function writeChatInboxItem(filePath: string, item: ChatInboxItem) {
  writeJsonAtomic(filePath, item);
  return { item, filePath };
}

function moveChatInboxItem(
  filePath: string,
  targetDir: string,
  item: ChatInboxItem,
) {
  const targetPath = path.join(targetDir, itemFileName(item.itemId));
  writeJsonAtomic(targetPath, item);
  completeChatInboxFile(filePath);
  return { item, filePath: targetPath };
}

function normalizeChatInboxError(value: unknown) {
  return safeString(value).trim() || undefined;
}

function applyChatInboxAttemptState(
  item: ChatInboxItem,
  options: {
    delayMs?: number;
    error?: string;
    clearNextAttemptAt?: boolean;
  } = {},
) {
  const delayMs = Math.max(0, Number(options.delayMs || 0));
  return updateChatInboxItem(item, {
    nextAttemptAt: options.clearNextAttemptAt
      ? undefined
      : new Date(Date.now() + delayMs).toISOString(),
    lastError: normalizeChatInboxError(options.error),
  });
}

export function restoreChatInboxSession(item: ChatInboxItem, bot?: any) {
  const session = asRecord(cloneJsonIfObject(item?.session) ?? {});
  const routing =
    item?.routing && typeof item.routing === "object" ? item.routing : null;
  if (bot) session.bot = bot;
  if (!routing) return session;

  session.isDirect = Boolean(routing.isDirect);
  session.userId = pickTrimmedString(session.userId, routing.userId);

  if (routing.text || routing.mentionLike) {
    mergeSessionRecord(session, "stripped", {
      content: routing.text
        ? pickTrimmedString(session?.stripped?.content, routing.text)
        : undefined,
      appel: routing.mentionLike ? true : undefined,
    });
  }

  if (routing.replyToMessageId) {
    mergeSessionRecord(session, "quote", {
      messageId: pickTrimmedString(
        session?.quote?.messageId,
        routing.replyToMessageId,
      ),
    });
  }

  if (routing.nickname) {
    mergeSessionRecord(session, "author", {
      name: pickTrimmedString(session?.author?.name, routing.nickname),
    });
  }

  if (routing.chatName) {
    session.channelName = pickTrimmedString(
      session?.channelName,
      routing.chatName,
    );
  }

  return session;
}

export function claimChatInboxFile(agentDir: string, filePath: string) {
  return claimFileToDir(filePath, processingDir(agentDir));
}

export function completeChatInboxFile(filePath: string) {
  removeFileIfExists(filePath);
}

export function touchChatInboxFile(filePath: string, item: ChatInboxItem) {
  writeChatInboxItem(filePath, {
    ...item,
    updatedAt: nowIso(),
  });
}

export function restoreChatInboxFile(
  agentDir: string,
  filePath: string,
  item: ChatInboxItem,
) {
  const targetPath = moveFileToDir(
    filePath,
    pendingDir(agentDir),
    itemFileName(item.itemId),
  );
  return { item, filePath: targetPath };
}

export function requeueChatInboxFile(
  agentDir: string,
  filePath: string,
  item: ChatInboxItem,
  options: { delayMs: number; error?: string },
) {
  return moveChatInboxItem(
    filePath,
    pendingDir(agentDir),
    applyChatInboxAttemptState(item, options),
  );
}

export function failChatInboxFile(
  agentDir: string,
  filePath: string,
  item: ChatInboxItem,
  error?: string,
) {
  return moveChatInboxItem(
    filePath,
    failedDir(agentDir),
    applyChatInboxAttemptState(item, {
      error,
      clearNextAttemptAt: true,
    }),
  );
}

export function restoreProcessingChatInboxFiles(
  agentDir: string,
  options: { staleMs?: number; nowMs?: number; limit?: number } = {},
) {
  const restored: Array<{ itemId: string; filePath: string }> = [];
  const staleMs = Number(options.staleMs || 0);
  const nowMs = Number(options.nowMs || Date.now());
  const limit = Math.max(0, Number(options.limit || 0));
  for (const filePath of listProcessingChatInboxFiles(agentDir)) {
    if (limit > 0 && restored.length >= limit) break;
    const item = readChatInboxItem(filePath);
    if (!item) {
      completeChatInboxFile(filePath);
      continue;
    }
    if (staleMs > 0) {
      const updatedAtMs = Date.parse(safeString(item.updatedAt || ""));
      if (Number.isFinite(updatedAtMs) && nowMs - updatedAtMs < staleMs) {
        continue;
      }
    }
    const next = restoreChatInboxFile(agentDir, filePath, item);
    restored.push({ itemId: item.itemId, filePath: next.filePath });
  }
  return restored;
}
