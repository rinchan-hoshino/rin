import fs from "node:fs/promises";
import path from "node:path";

import { normalizeSessionValue } from "./ref.js";
import type { BoundSessionListItem } from "./listing.js";

export const DEFAULT_SESSION_LIST_PAGE_LIMIT = 30;
export const MAX_SESSION_LIST_PAGE_LIMIT = 500;

const HEAD_READ_BYTES = 256 * 1024;
const TAIL_READ_BYTES = 128 * 1024;
const MAX_TEXT_SAMPLE_CHARS = 16_000;
const MAX_MESSAGE_TEXT_CHARS = 2_000;
const MAX_CONCURRENT_SESSION_SUMMARY_LOADS = 20;

type SessionSummary = BoundSessionListItem & {
  parentSessionPath?: string;
};

export type BoundSessionPage = {
  sessions: SessionSummary[];
  offset: number;
  limit: number;
  total: number;
  hasMore: boolean;
  nextOffset?: number;
};

export function normalizeSessionPageLimit(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0)
    return DEFAULT_SESSION_LIST_PAGE_LIMIT;
  return Math.min(parsed, MAX_SESSION_LIST_PAGE_LIMIT);
}

export function normalizeSessionPageOffset(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed;
}

function isSessionRecordFile(name: string): boolean {
  return name.endsWith(".jsonl");
}

async function listSessionRecordFiles(sessionDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(sessionDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && isSessionRecordFile(entry.name))
      .map((entry) => path.join(sessionDir, entry.name));
  } catch {
    return [];
  }
}

async function readFileSlice(
  filePath: string,
  start: number,
  length: number,
): Promise<string> {
  if (length <= 0) return "";
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function completeHeadLines(text: string, complete: boolean): string[] {
  const lines = text.split("\n");
  if (!complete && !text.endsWith("\n")) lines.pop();
  return lines.map((line) => line.trim()).filter(Boolean);
}

function completeTailLines(text: string, startsAtFileStart: boolean): string[] {
  const lines = text.split("\n");
  if (!startsAtFileStart) lines.shift();
  return lines.map((line) => line.trim()).filter(Boolean);
}

function parseJsonLine(line: string): any | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function normalizeEntryTimestamp(entry: any): Date | undefined {
  const timestamp = normalizeSessionValue(entry?.timestamp);
  if (!timestamp) return undefined;
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const value = part as { type?: unknown; text?: unknown };
      if (value.type !== "text" || typeof value.text !== "string") return "";
      return value.text;
    })
    .filter(Boolean)
    .join("\n");
}

function sanitizeMessageText(text: string): string {
  return Array.from(text)
    .map((char) => {
      const code = char.charCodeAt(0);
      return code <= 31 || code === 127 ? " " : char;
    })
    .join("")
    .trim();
}

function extractMessageText(entry: any): string {
  if (entry?.type !== "message") return "";
  const message = entry.message;
  if (!message || typeof message !== "object") return "";
  if (message.role !== "user" && message.role !== "assistant") return "";
  return sanitizeMessageText(extractTextFromContent(message.content)).slice(
    0,
    MAX_MESSAGE_TEXT_CHARS,
  );
}

function appendTextSample(parts: string[], value: string): void {
  const text = value.trim();
  if (!text) return;
  const currentLength = parts.reduce((sum, part) => sum + part.length + 1, 0);
  if (currentLength >= MAX_TEXT_SAMPLE_CHARS) return;
  parts.push(text.slice(0, MAX_TEXT_SAMPLE_CHARS - currentLength));
}

async function readSessionSummary(
  filePath: string,
): Promise<SessionSummary | null> {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) return null;

    const size = stats.size;
    const headLength = Math.min(size, HEAD_READ_BYTES);
    const tailStart = Math.max(0, size - TAIL_READ_BYTES);
    const [headText, tailText] = await Promise.all([
      readFileSlice(filePath, 0, headLength),
      tailStart === 0
        ? Promise.resolve("")
        : readFileSlice(filePath, tailStart, size - tailStart),
    ]);
    const headLines = completeHeadLines(headText, headLength >= size);
    const tailLines = tailStart === 0 ? [] : completeTailLines(tailText, false);
    const entries = [...headLines, ...tailLines]
      .map(parseJsonLine)
      .filter((entry): entry is any => Boolean(entry));

    const header = entries.find((entry) => entry?.type === "session");
    if (!header) return null;

    const id = normalizeSessionValue(header.id) || path.basename(filePath);
    const cwd = normalizeSessionValue(header.cwd);
    const parentSessionPath = normalizeSessionValue(header.parentSession);
    const created = normalizeEntryTimestamp(header);
    let modified = created || stats.mtime;
    let firstMessage = "";
    let name: string | undefined;
    let messageCount = 0;
    const allMessages: string[] = [];

    for (const entry of entries) {
      const timestamp = normalizeEntryTimestamp(entry);
      if (timestamp && timestamp.getTime() > modified.getTime()) {
        modified = timestamp;
      }

      if (entry?.type === "session_info") {
        const nextName = normalizeSessionValue(entry.name);
        name = nextName || undefined;
      }

      if (entry?.type !== "message") continue;
      messageCount += 1;
      const text = extractMessageText(entry);
      if (!text) continue;
      appendTextSample(allMessages, text);
      if (!firstMessage && entry.message?.role === "user") {
        firstMessage = text;
      }
    }

    const fallbackTitle = firstMessage || name || "(no messages)";
    return {
      id,
      path: filePath,
      name,
      firstMessage: fallbackTitle,
      modified,
      messageCount,
      cwd,
      allMessagesText: allMessages.join(" ") || fallbackTitle,
      ...(parentSessionPath ? { parentSessionPath } : {}),
    };
  } catch {
    return null;
  }
}

async function loadSessionSummaries(
  files: string[],
): Promise<SessionSummary[]> {
  const results: Array<SessionSummary | null> = new Array(files.length).fill(
    null,
  );
  const inFlight = new Set<Promise<void>>();
  let nextIndex = 0;

  const startNext = () => {
    const index = nextIndex++;
    const file = files[index];
    if (!file) return;
    const task = readSessionSummary(file)
      .then((summary) => {
        results[index] = summary;
      })
      .catch(() => {
        results[index] = null;
      })
      .finally(() => {
        inFlight.delete(task);
      });
    inFlight.add(task);
  };

  while (nextIndex < files.length || inFlight.size > 0) {
    while (
      nextIndex < files.length &&
      inFlight.size < MAX_CONCURRENT_SESSION_SUMMARY_LOADS
    ) {
      startNext();
    }
    if (inFlight.size > 0) await Promise.race(inFlight);
  }

  return results.filter((summary): summary is SessionSummary =>
    Boolean(summary),
  );
}

export async function listBoundSessionPage(options: {
  sessionDir: string;
  cwd?: string;
  offset?: unknown;
  limit?: unknown;
}): Promise<BoundSessionPage> {
  const offset = normalizeSessionPageOffset(options.offset);
  const limit = normalizeSessionPageLimit(options.limit);
  const resolvedCwd = normalizeSessionValue(options.cwd)
    ? path.resolve(String(options.cwd))
    : undefined;
  const files = await listSessionRecordFiles(options.sessionDir);
  const summaries = (await loadSessionSummaries(files)).filter(
    (summary) =>
      !resolvedCwd ||
      (summary.cwd ? path.resolve(summary.cwd) === resolvedCwd : false),
  );
  summaries.sort(
    (left, right) => right.modified.getTime() - left.modified.getTime(),
  );
  const total = summaries.length;
  const sessions = summaries.slice(offset, offset + limit);
  const nextOffset = offset + sessions.length;
  const hasMore = nextOffset < total;
  return {
    sessions,
    offset,
    limit,
    total,
    hasMore,
    ...(hasMore ? { nextOffset } : {}),
  };
}
