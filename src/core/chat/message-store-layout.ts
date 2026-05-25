import path from "node:path";

import { normalizeLocalDateOnly } from "./date.js";
import { parseChatKey } from "./support.js";
import { chatDataPath } from "../data-layout.js";
import { safeString } from "../text-utils.js";

export type ChatMessageStoreRoot = {
  storeDir: string;
  recordsDir: string;
  indexesDir: string;
  logDir: string;
};

export type ChatMessageStoreLayout = {
  storeDir: string;
  recordsDir: string;
  indexesDir: string;
  logDir: string;
  primaryRoot: ChatMessageStoreRoot;
  readRoots: ChatMessageStoreRoot[];
};

export function sanitizePathSegment(value: string, fallback: string) {
  const text = safeString(value)
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, "_");
  return text || fallback;
}

export function recordsDirForStoreDir(storeDir: string) {
  return path.join(storeDir, "records");
}

export function indexesDirForStoreDir(storeDir: string) {
  return path.join(storeDir, "indexes");
}

function buildChatMessageStoreRoot(storeDir: string): ChatMessageStoreRoot {
  return {
    storeDir,
    recordsDir: recordsDirForStoreDir(storeDir),
    indexesDir: indexesDirForStoreDir(storeDir),
    logDir: path.join(storeDir, "chat-log-view"),
  };
}

function dedupeStoreRoots(values: Iterable<ChatMessageStoreRoot | undefined>) {
  const out: ChatMessageStoreRoot[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const storeDir = safeString(value?.storeDir).trim();
    if (!storeDir || seen.has(storeDir) || !value) continue;
    seen.add(storeDir);
    out.push(value);
  }
  return out;
}

function buildChatMessageStoreLayout(
  primaryRoot: ChatMessageStoreRoot,
  readRoots: Iterable<ChatMessageStoreRoot | undefined>,
): ChatMessageStoreLayout {
  return {
    storeDir: primaryRoot.storeDir,
    recordsDir: primaryRoot.recordsDir,
    indexesDir: primaryRoot.indexesDir,
    logDir: primaryRoot.logDir,
    primaryRoot,
    readRoots: dedupeStoreRoots([primaryRoot, ...readRoots]),
  };
}

function detectChatMessageStoreLayout(rootDir: string) {
  const preferredRoot = buildChatMessageStoreRoot(
    chatDataPath(rootDir, "message-store"),
  );
  return buildChatMessageStoreLayout(preferredRoot, []);
}

export function getChatMessageStoreLayout(agentDir: string) {
  return detectChatMessageStoreLayout(path.resolve(agentDir));
}

function mapReadRoots<T>(
  agentDir: string,
  mapRoot: (root: ChatMessageStoreRoot) => T,
) {
  return getChatMessageStoreLayout(agentDir).readRoots.map(mapRoot);
}

export function chatMessageStoreRoots(agentDir: string) {
  return mapReadRoots(agentDir, (root) => root.storeDir);
}

export function recordRoots(agentDir: string) {
  return mapReadRoots(agentDir, (root) => root.recordsDir);
}

export function indexRoots(agentDir: string) {
  return mapReadRoots(agentDir, (root) => root.indexesDir);
}

export function chatScopedDatePath(
  rootDir: string,
  chatKey: string,
  date: string,
  extension: ".json" | ".txt",
) {
  const parsed = parseChatKey(chatKey);
  if (!parsed) throw new Error(`invalid_chatKey:${chatKey}`);
  const day = normalizeLocalDateOnly(date, new Date());
  const platform = sanitizePathSegment(parsed.platform, "platform");
  const chatId = sanitizePathSegment(parsed.chatId, "chat");
  return parsed.botId
    ? path.join(
        rootDir,
        platform,
        sanitizePathSegment(parsed.botId, "bot"),
        chatId,
        `${day}${extension}`,
      )
    : path.join(rootDir, platform, chatId, `${day}${extension}`);
}
