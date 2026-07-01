import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

import { normalizeSessionValue } from "./ref.js";
import type { BoundSessionListItem } from "./listing.js";

const SESSION_CATALOG_DIR_NAME = ".rin-session-catalog";
const SESSION_CATALOG_VERSION = "v1";
const SESSION_CATALOG_SCHEMA_VERSION = 1;
const CATALOG_TAIL_READ_BYTES = 64 * 1024;
const HEAD_READ_BYTES = 256 * 1024;
const TAIL_READ_BYTES = 128 * 1024;
const MAX_TEXT_SAMPLE_CHARS = 16_000;
const MAX_MESSAGE_TEXT_CHARS = 2_000;
const MAX_CONCURRENT_SESSION_SUMMARY_LOADS = 20;

export type SessionSummary = BoundSessionListItem & {
  parentSessionPath?: string;
};

type SessionCatalogRecord = {
  schemaVersion: 1;
  path: string;
  id: string;
  name?: string;
  firstMessage: string;
  modified: string;
  messageCount: number;
  cwd?: string;
  parentSessionPath?: string;
  allMessagesText: string;
};

export type SessionCatalogPage = {
  sessions: SessionSummary[];
  offset: number;
  limit: number;
  total: number;
  hasMore: boolean;
  nextOffset?: number;
};

function isSessionRecordFile(name: string): boolean {
  return name.endsWith(".jsonl");
}

export async function listSessionRecordFiles(
  sessionDir: string,
): Promise<string[]> {
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

export function summarizeSessionEntries(
  filePath: string,
  entries: any[],
  fallbackModified?: Date,
): SessionSummary | null {
  const header = entries.find((entry) => entry?.type === "session");
  if (!header) return null;

  const id = normalizeSessionValue(header.id) || path.basename(filePath);
  const cwd = normalizeSessionValue(header.cwd);
  const parentSessionPath = normalizeSessionValue(header.parentSession);
  const created = normalizeEntryTimestamp(header);
  let modified = created || fallbackModified || new Date();
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
}

export async function readSessionSummary(
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

    return summarizeSessionEntries(filePath, entries, stats.mtime);
  } catch {
    return null;
  }
}

export async function loadSessionSummaries(
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

function catalogRoot(sessionDir: string): string {
  return path.join(
    path.resolve(sessionDir),
    SESSION_CATALOG_DIR_NAME,
    SESSION_CATALOG_VERSION,
  );
}

function catalogStatePath(sessionDir: string): string {
  return path.join(catalogRoot(sessionDir), "state.json");
}

function allCatalogPath(sessionDir: string): string {
  return path.join(catalogRoot(sessionDir), "all.jsonl");
}

function cwdCatalogPath(sessionDir: string, cwd: string): string {
  const resolved = path.resolve(cwd);
  const digest = crypto.createHash("sha256").update(resolved).digest("hex");
  return path.join(catalogRoot(sessionDir), "cwd", `${digest}.jsonl`);
}

function catalogPathForScope(sessionDir: string, cwd?: string): string {
  const normalizedCwd = normalizeSessionValue(cwd);
  return normalizedCwd
    ? cwdCatalogPath(sessionDir, normalizedCwd)
    : allCatalogPath(sessionDir);
}

function summaryToCatalogRecord(summary: SessionSummary): SessionCatalogRecord {
  return {
    schemaVersion: SESSION_CATALOG_SCHEMA_VERSION,
    path: summary.path,
    id: summary.id,
    name: summary.name,
    firstMessage: summary.firstMessage,
    modified: summary.modified.toISOString(),
    messageCount: summary.messageCount,
    cwd: summary.cwd,
    parentSessionPath: summary.parentSessionPath,
    allMessagesText: summary.allMessagesText,
  };
}

function normalizeCatalogRecord(value: unknown): SessionCatalogRecord | null {
  const record = value && typeof value === "object" ? (value as any) : null;
  if (!record || record.schemaVersion !== SESSION_CATALOG_SCHEMA_VERSION) {
    return null;
  }
  const sessionPath = normalizeSessionValue(record.path);
  const id = normalizeSessionValue(record.id) || path.basename(sessionPath);
  const firstMessage = normalizeSessionValue(record.firstMessage) || id;
  const modified = new Date(normalizeSessionValue(record.modified));
  const messageCount = Number(record.messageCount);
  if (!sessionPath || !id || !Number.isFinite(modified.getTime())) return null;
  return {
    schemaVersion: SESSION_CATALOG_SCHEMA_VERSION,
    path: sessionPath,
    id,
    name: normalizeSessionValue(record.name) || undefined,
    firstMessage,
    modified: modified.toISOString(),
    messageCount:
      Number.isFinite(messageCount) && messageCount >= 0
        ? Math.floor(messageCount)
        : 0,
    cwd: normalizeSessionValue(record.cwd) || undefined,
    parentSessionPath:
      normalizeSessionValue(record.parentSessionPath) || undefined,
    allMessagesText:
      normalizeSessionValue(record.allMessagesText) || firstMessage,
  };
}

function catalogRecordToSummary(record: SessionCatalogRecord): SessionSummary {
  return {
    id: record.id,
    path: record.path,
    name: record.name,
    firstMessage: record.firstMessage,
    modified: new Date(record.modified),
    messageCount: record.messageCount,
    cwd: record.cwd,
    allMessagesText: record.allMessagesText,
    ...(record.parentSessionPath
      ? { parentSessionPath: record.parentSessionPath }
      : {}),
  };
}

function appendCatalogRecordSync(
  sessionDir: string,
  record: SessionCatalogRecord,
): void {
  const line = `${JSON.stringify(record)}\n`;
  const root = catalogRoot(sessionDir);
  fsSync.mkdirSync(root, { recursive: true });
  fsSync.appendFileSync(allCatalogPath(sessionDir), line, "utf8");
  if (record.cwd) {
    const cwdPath = cwdCatalogPath(sessionDir, record.cwd);
    fsSync.mkdirSync(path.dirname(cwdPath), { recursive: true });
    fsSync.appendFileSync(cwdPath, line, "utf8");
  }
  const statePath = catalogStatePath(sessionDir);
  if (!fsSync.existsSync(statePath)) {
    fsSync.writeFileSync(
      statePath,
      `${JSON.stringify(
        {
          schemaVersion: SESSION_CATALOG_SCHEMA_VERSION,
          rebuiltAt: null,
          checked: 0,
          indexed: 0,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
}

export function updateSessionCatalogFromSessionManagerSync(
  sessionManager: any,
): boolean {
  try {
    if (sessionManager?.isPersisted?.() === false) return false;
    const sessionFile = normalizeSessionValue(sessionManager?.sessionFile);
    const entries = Array.isArray(sessionManager?.fileEntries)
      ? sessionManager.fileEntries
      : [];
    if (!sessionFile || entries.length === 0) return false;
    const summary = summarizeSessionEntries(sessionFile, entries);
    if (!summary) return false;
    const sessionDir =
      normalizeSessionValue(sessionManager?.getSessionDir?.()) ||
      path.dirname(sessionFile);
    appendCatalogRecordSync(sessionDir, summaryToCatalogRecord(summary));
    return true;
  } catch {
    return false;
  }
}

export async function rebuildSessionCatalog(sessionDir: string): Promise<{
  checked: number;
  indexed: number;
}> {
  const root = catalogRoot(sessionDir);
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(path.join(root, "cwd"), { recursive: true });

  const files = await listSessionRecordFiles(sessionDir);
  const summaries = await loadSessionSummaries(files);
  summaries.sort(
    (left, right) => left.modified.getTime() - right.modified.getTime(),
  );

  const allLines: string[] = [];
  const cwdLines = new Map<string, string[]>();
  for (const summary of summaries) {
    const record = summaryToCatalogRecord(summary);
    const line = JSON.stringify(record);
    allLines.push(line);
    if (record.cwd) {
      const cwdPath = cwdCatalogPath(sessionDir, record.cwd);
      const lines = cwdLines.get(cwdPath) || [];
      lines.push(line);
      cwdLines.set(cwdPath, lines);
    }
  }

  await fs.writeFile(
    allCatalogPath(sessionDir),
    allLines.length ? `${allLines.join("\n")}\n` : "",
    "utf8",
  );
  for (const [filePath, lines] of cwdLines) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
  }
  await fs.writeFile(
    catalogStatePath(sessionDir),
    `${JSON.stringify(
      {
        schemaVersion: SESSION_CATALOG_SCHEMA_VERSION,
        rebuiltAt: new Date().toISOString(),
        checked: files.length,
        indexed: summaries.length,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { checked: files.length, indexed: summaries.length };
}

async function readCatalogState(sessionDir: string): Promise<any | undefined> {
  try {
    return JSON.parse(await fs.readFile(catalogStatePath(sessionDir), "utf8"));
  } catch {
    return undefined;
  }
}

async function hasCatalogState(sessionDir: string): Promise<boolean> {
  const state = await readCatalogState(sessionDir);
  return state?.schemaVersion === SESSION_CATALOG_SCHEMA_VERSION;
}

async function hasFullCatalogState(sessionDir: string): Promise<boolean> {
  const state = await readCatalogState(sessionDir);
  return (
    state?.schemaVersion === SESSION_CATALOG_SCHEMA_VERSION &&
    Boolean(normalizeSessionValue(state.rebuiltAt))
  );
}

async function readCatalogRecordsFromTail(
  filePath: string,
  options: { needed: number; cwd?: string },
): Promise<{ records: SessionCatalogRecord[]; exhausted: boolean }> {
  const needed = Math.max(0, options.needed);
  if (needed <= 0) return { records: [], exhausted: true };
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, "r");
    const stat = await handle.stat();
    let position = stat.size;
    let carry = "";
    const records: SessionCatalogRecord[] = [];
    const seen = new Set<string>();
    const resolvedCwd = normalizeSessionValue(options.cwd)
      ? path.resolve(String(options.cwd))
      : undefined;

    while (position > 0 && records.length < needed) {
      const length = Math.min(CATALOG_TAIL_READ_BYTES, position);
      position -= length;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      const text = buffer.subarray(0, bytesRead).toString("utf8") + carry;
      const lines = text.split("\n");
      carry = position > 0 ? lines.shift() || "" : "";

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (records.length >= needed) break;
        const line = lines[index]?.trim();
        if (!line) continue;
        const record = normalizeCatalogRecord(parseJsonLine(line));
        if (!record) continue;
        const resolvedPath = path.resolve(record.path);
        if (seen.has(resolvedPath)) continue;
        seen.add(resolvedPath);
        if (
          resolvedCwd &&
          (!record.cwd || path.resolve(record.cwd) !== resolvedCwd)
        ) {
          continue;
        }
        if (!fsSync.existsSync(record.path)) continue;
        records.push(record);
      }
    }
    return { records, exhausted: position <= 0 };
  } catch {
    return { records: [], exhausted: true };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function tryListSessionCatalogPage(options: {
  sessionDir: string;
  cwd?: string;
  offset: number;
  limit: number;
}): Promise<SessionCatalogPage | undefined> {
  if (!(await hasCatalogState(options.sessionDir))) return undefined;
  const needed = options.offset + options.limit + 1;
  const filePath = catalogPathForScope(options.sessionDir, options.cwd);
  const { records } = await readCatalogRecordsFromTail(filePath, {
    needed,
    cwd: options.cwd,
  });
  const pageRecords = records.slice(
    options.offset,
    options.offset + options.limit,
  );
  const hasMore = records.length > options.offset + options.limit;
  const sessions = pageRecords.map(catalogRecordToSummary);
  const nextOffset = options.offset + sessions.length;
  return {
    sessions,
    offset: options.offset,
    limit: options.limit,
    total: hasMore ? nextOffset + 1 : nextOffset,
    hasMore,
    ...(hasMore ? { nextOffset } : {}),
  };
}

export async function ensureSessionCatalog(sessionDir: string): Promise<void> {
  if (await hasFullCatalogState(sessionDir)) return;
  await rebuildSessionCatalog(sessionDir);
}
