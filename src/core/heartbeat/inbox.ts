import path from "node:path";
import { createHash } from "node:crypto";

import { cloneJson } from "../json-utils.js";
import { listJsonFiles, writeJsonAtomic } from "../platform/fs.js";
import { readJsonFile } from "../platform/fs.js";
import { safeString } from "../text-utils.js";

export type HeartbeatInboxEntry = {
  version: 1;
  id: string;
  source: "chat" | "extension";
  title: string;
  status: "unread" | "read";
  createdAt: string;
  updatedAt: string;
  chatKey?: string;
  bucket?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  readAt?: string;
  readBy?: string;
  result?: string;
};

export type HeartbeatInboxInput = {
  id?: string;
  source?: "chat" | "extension";
  title: string;
  chatKey?: string;
  bucket?: string;
  content?: string;
  metadata?: Record<string, unknown>;
};

function hashKey(value: string) {
  return createHash("sha1").update(value).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeMetadata(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? cloneJson(value as Record<string, unknown>)
    : undefined;
}

function requireText(value: unknown, errorCode: string) {
  const text = safeString(value).trim();
  if (!text) throw new Error(errorCode);
  return text;
}

export function heartbeatInboxDir(agentDir: string) {
  return path.join(path.resolve(agentDir), "data", "heartbeat-inbox");
}

function entryPath(agentDir: string, entryId: string) {
  return path.join(heartbeatInboxDir(agentDir), `${entryId}.json`);
}

export function heartbeatChatReadBucket(nowMs = Date.now()) {
  return new Date(nowMs).toISOString().slice(0, 13);
}

export function heartbeatChatReadEntryId(chatKey: string, bucket: string) {
  return `chat_${hashKey(`${chatKey}\n${bucket}`)}`;
}

export function appendHeartbeatInboxEntry(
  agentDir: string,
  input: HeartbeatInboxInput,
) {
  const title = requireText(input.title, "heartbeat_inbox_title_required");
  const source = input.source === "extension" ? "extension" : "chat";
  const chatKey = safeString(input.chatKey).trim() || undefined;
  const bucket = safeString(input.bucket).trim() || undefined;
  const id =
    safeString(input.id).trim() ||
    `heartbeat_${hashKey(`${source}\n${chatKey || ""}\n${bucket || ""}\n${title}`)}`;
  const filePath = entryPath(agentDir, id);
  const existing = readJsonFile<HeartbeatInboxEntry | null>(filePath, null);
  const now = nowIso();
  const entry: HeartbeatInboxEntry = {
    version: 1,
    id,
    source,
    title,
    status: existing?.status === "read" ? "read" : "unread",
    createdAt: safeString(existing?.createdAt).trim() || now,
    updatedAt: now,
    chatKey,
    bucket,
    content: safeString(input.content).trim() || existing?.content,
    metadata: normalizeMetadata(input.metadata) || existing?.metadata,
    readAt: existing?.readAt,
    readBy: existing?.readBy,
    result: existing?.result,
  };
  writeJsonAtomic(filePath, entry);
  return { entry, filePath };
}

export function appendHeartbeatChatReadEntry(
  agentDir: string,
  input: {
    chatKey: string;
    chatName?: string;
    nowMs?: number;
    metadata?: Record<string, unknown>;
  },
) {
  const chatKey = requireText(input.chatKey, "heartbeat_chatKey_required");
  const bucket = heartbeatChatReadBucket(input.nowMs);
  const titleName = safeString(input.chatName).trim() || chatKey;
  return appendHeartbeatInboxEntry(agentDir, {
    id: heartbeatChatReadEntryId(chatKey, bucket),
    source: "chat",
    title: `阅读 ${titleName} chat 消息`,
    chatKey,
    bucket,
    metadata: input.metadata,
  });
}

export function listHeartbeatInboxEntries(agentDir: string) {
  return listJsonFiles(heartbeatInboxDir(agentDir))
    .map((filePath) => readJsonFile<HeartbeatInboxEntry | null>(filePath, null))
    .filter((entry): entry is HeartbeatInboxEntry =>
      Boolean(entry?.id && entry?.title),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function listUnreadHeartbeatInboxEntries(
  agentDir: string,
  options: { limit?: number } = {},
) {
  const limit = Math.max(1, Number(options.limit || 20));
  return listHeartbeatInboxEntries(agentDir)
    .filter((entry) => entry.status !== "read")
    .slice(0, limit);
}

export function markHeartbeatInboxEntriesRead(
  agentDir: string,
  input: { entryIds: string[]; result?: string; actorId?: string },
) {
  const ids = Array.from(
    new Set(
      (Array.isArray(input.entryIds) ? input.entryIds : [])
        .map((id) => safeString(id).trim())
        .filter(Boolean),
    ),
  );
  if (!ids.length) throw new Error("heartbeat_inbox_entry_ids_required");
  const readAt = nowIso();
  const readBy = safeString(input.actorId).trim() || undefined;
  const result = safeString(input.result).trim() || undefined;
  const entries: HeartbeatInboxEntry[] = [];
  for (const id of ids) {
    const filePath = entryPath(agentDir, id);
    const existing = readJsonFile<HeartbeatInboxEntry | null>(filePath, null);
    if (!existing?.id) throw new Error(`heartbeat_inbox_entry_not_found:${id}`);
    const entry: HeartbeatInboxEntry = {
      ...existing,
      status: "read",
      readAt,
      readBy,
      result,
      updatedAt: readAt,
    };
    writeJsonAtomic(filePath, entry);
    entries.push(entry);
  }
  return { entries };
}
