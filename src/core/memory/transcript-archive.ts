import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { appendJsonLine } from "../platform/fs.js";
import { nowIso } from "../time-utils.js";
import {
  normalizeSessionNameDetail,
  readSessionDisplayNameParts,
  resolveSessionDisplayName,
} from "../session/names.js";
import { parseTimestampMs, safeString, sha, trimText } from "./utils.js";
import type {
  TranscriptArchiveEntry,
  TranscriptFileState,
  TranscriptResultMessage,
  TranscriptSessionResult,
} from "./transcript-types.js";

export const MAX_MATCHED_ENTRIES_PER_SESSION = 3;

function resolveMemoryRoot(rootOverride = ""): string {
  return safeString(rootOverride).trim()
    ? path.join(path.resolve(rootOverride), "memory")
    : path.join(
        process.env.RIN_DIR || path.join(process.env.HOME || "", ".rin"),
        "memory",
      );
}

export function resolveTranscriptRoot(rootOverride = ""): string {
  return path.join(resolveMemoryRoot(rootOverride), "transcripts");
}

export function resolveTranscriptSearchDbPath(rootOverride = ""): string {
  return path.join(resolveMemoryRoot(rootOverride), "search.db");
}

function resolveTranscriptSessionDisplayName(
  sessionFile: string,
  fallbackPreview: string,
): string {
  const normalizedSessionFile = safeString(sessionFile).trim();
  if (!normalizedSessionFile) {
    return normalizeSessionNameDetail(fallbackPreview, 180);
  }

  return resolveSessionDisplayName(
    readSessionDisplayNameParts(path.resolve(normalizedSessionFile)),
    fallbackPreview,
  );
}

function transcriptSessionBasename(input: Record<string, unknown>): string {
  const sessionId = safeString(input.sessionId || "").trim();
  if (sessionId) return `${sessionId}.jsonl`;
  const sessionFile = safeString(input.sessionFile || "").trim();
  if (sessionFile) return `${sha(sessionFile).slice(0, 16)}.jsonl`;
  return "unknown-session.jsonl";
}

function transcriptDateParts(input: Record<string, unknown>): {
  year: string;
  month: string;
} {
  const raw = safeString(input.timestamp || "").trim();
  const parsedTimestampMs = parseTimestampMs(raw);
  const date = raw ? new Date(parsedTimestampMs || raw) : new Date();
  if (Number.isNaN(date.getTime())) {
    const now = new Date();
    return {
      year: String(now.getUTCFullYear()),
      month: String(now.getUTCMonth() + 1).padStart(2, "0"),
    };
  }
  return {
    year: String(date.getUTCFullYear()),
    month: String(date.getUTCMonth() + 1).padStart(2, "0"),
  };
}

export function getTranscriptArchivePath(
  input: Record<string, unknown> | string = "",
  rootOverride = "",
): string {
  const root = resolveTranscriptRoot(rootOverride);
  if (typeof input === "string") {
    const key = safeString(input).trim();
    if (!key) return path.join(root, "unknown", "unknown-session.jsonl");
    if (
      key.endsWith(".jsonl") &&
      (key.includes("/") || key.includes(path.sep))
    ) {
      return path.join(root, key);
    }
    if (key.includes(path.sep) || key.includes("/")) {
      return path.join(root, "unknown", `${sha(key).slice(0, 16)}.jsonl`);
    }
    return path.join(root, "unknown", `${key}.jsonl`);
  }
  const { year, month } = transcriptDateParts(input);
  return path.join(root, year, month, transcriptSessionBasename(input));
}

function normalizeInlineValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function summarizePart(part: unknown): string {
  if (!part || typeof part !== "object") return "";
  const value = part as Record<string, unknown>;
  if (value.type === "text") return safeString(value.text || "");
  if (value.type === "thinking") return safeString(value.thinking || "");
  if (value.type === "toolCall") {
    const name =
      safeString(value.name || value.toolName || "tool").trim() || "tool";
    const args = normalizeInlineValue(value.args || value.arguments || "");
    return args ? `[tool:${name}] ${args}` : `[tool:${name}]`;
  }
  if (value.type === "image") {
    const mimeType = safeString(value.mimeType || "image").trim() || "image";
    return `[image:${mimeType}]`;
  }
  if (value.type === "file") {
    const name =
      safeString(value.name || value.path || value.url || "file").trim() ||
      "file";
    return `[file:${name}]`;
  }
  return "";
}

export function extractTranscriptText(input: Record<string, unknown>): string {
  const role = safeString(input.role || "").trim();
  const content = input.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => summarizePart(part))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (role === "bashExecution") {
    const command = safeString(input.command || "").trim();
    const output = safeString(input.output || "").trim();
    return [command ? `[bash] ${command}` : "", output]
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }
  if (role === "branchSummary" || role === "compactionSummary") {
    return safeString(input.summary || "").trim();
  }
  return safeString(input.text || "").trim();
}

export async function appendTranscriptArchiveRecord(
  input: Record<string, unknown>,
  rootOverride = "",
): Promise<
  | {
      entry: TranscriptArchiveEntry;
      filePath: string;
      fileState: TranscriptFileState;
    }
  | undefined
> {
  const role = safeString(input.role || "").trim();
  if (!role) return undefined;
  if (isLegacySyntheticSessionSummaryEntry(input)) return undefined;
  const rawSessionFile = safeString(input.sessionFile || "").trim();
  if (!rawSessionFile) return undefined;
  const sessionFile = path.resolve(rawSessionFile);
  const text = extractTranscriptText(input);
  if (!text) return undefined;
  const entry: TranscriptArchiveEntry = {
    id:
      safeString(input.id || "").trim() ||
      sha(
        [
          safeString(input.timestamp || "").trim(),
          safeString(input.sessionId || "").trim(),
          role,
          text,
          safeString(input.toolCallId || "").trim(),
          safeString(input.toolName || "").trim(),
        ].join("\n"),
      ).slice(0, 16),
    timestamp: safeString(input.timestamp || nowIso()).trim(),
    sessionId: safeString(input.sessionId || "").trim(),
    sessionFile,
    role,
    text,
    content: input.content,
    toolName: safeString(input.toolName || "").trim() || undefined,
    toolCallId: safeString(input.toolCallId || "").trim() || undefined,
    customType: safeString(input.customType || "").trim() || undefined,
    stopReason: safeString(input.stopReason || "").trim() || undefined,
    errorMessage: safeString(input.errorMessage || "").trim() || undefined,
    provider: safeString(input.provider || "").trim() || undefined,
    model: safeString(input.model || "").trim() || undefined,
    display: typeof input.display === "boolean" ? input.display : undefined,
  };
  const filePath = getTranscriptArchivePath(entry, rootOverride);
  await appendJsonLine(filePath, entry);
  const stat = await fs.stat(filePath);
  return {
    entry,
    filePath,
    fileState: {
      archivePath: filePath,
      mtimeMs: Math.trunc(stat.mtimeMs),
      size: stat.size,
    },
  };
}

function parseTranscriptArchiveLine(
  rawLine: string,
  lineNumber: number,
  filePath: string,
) {
  try {
    const parsed = JSON.parse(rawLine) as TranscriptArchiveEntry;
    if (!parsed?.text) {
      parsed.text = extractTranscriptText(parsed as Record<string, unknown>);
    }
    parsed.archiveLine = lineNumber;
    parsed.archivePath = filePath;
    return parsed.text && !isLegacySyntheticSessionSummaryEntry(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export async function* iterateTranscriptArchiveFile(filePath: string) {
  if (!fssync.existsSync(filePath)) return;
  const input = fssync.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      const rawLine = line.trim();
      if (!rawLine) continue;
      const parsed = parseTranscriptArchiveLine(rawLine, lineNumber, filePath);
      if (parsed) yield parsed;
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

export async function loadTranscriptArchiveFile(filePath: string) {
  const entries: TranscriptArchiveEntry[] = [];
  for await (const entry of iterateTranscriptArchiveFile(filePath)) {
    entries.push(entry);
  }
  return entries;
}

export async function collectTranscriptFiles(dir: string): Promise<string[]> {
  if (!fssync.existsSync(dir)) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTranscriptFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(fullPath);
  }
  return files;
}

export async function loadTranscriptArchiveEntries(
  rootOverride = "",
): Promise<TranscriptArchiveEntry[]> {
  const root = resolveTranscriptRoot(rootOverride);
  const files = await collectTranscriptFiles(root);
  const groups = await Promise.all(
    files.map((filePath) => loadTranscriptArchiveFile(filePath)),
  );
  return groups.flat();
}

function timestampValue(value: string): number {
  return parseTimestampMs(value);
}

export function isLegacySyntheticSessionSummaryEntry(input: {
  role?: unknown;
  customType?: unknown;
}) {
  return (
    safeString(input.role || "").trim() === "sessionSummary" ||
    safeString(input.customType || "").trim() === "session_summary"
  );
}

function compareEntriesByNewest(
  a: TranscriptArchiveEntry,
  b: TranscriptArchiveEntry,
) {
  return timestampValue(b.timestamp) - timestampValue(a.timestamp);
}

function latestTranscriptEntry(entries: TranscriptArchiveEntry[]) {
  return [...entries].sort(compareEntriesByNewest)[0];
}

export function transcriptPreviewText(entry: TranscriptArchiveEntry) {
  const label = entry.toolName
    ? `[${entry.role}:${entry.toolName}]`
    : entry.customType
      ? `[${entry.role}:${entry.customType}]`
      : `[${entry.role}]`;
  return `${label} ${safeString(entry.text || "").trim()}`.trim();
}

function sessionPreviewPriority(entry: TranscriptArchiveEntry) {
  const text = safeString(entry.text || "").trim();
  let score = 0;
  if (entry.role === "assistant") score += 30;
  if (entry.role === "user") score += 20;
  if (entry.role === "toolResult") score += 12;
  if (entry.role === "bashExecution") score += 10;
  if (entry.role === "custom") score += 8;
  if (entry.toolName) score += 18;
  if (entry.toolCallId) score += 8;
  if (text.includes("[tool:")) score += 12;
  if (text.includes("[bash]")) score += 10;
  if (text.includes("http://") || text.includes("https://")) score += 4;
  if (text.includes("/") || text.includes("\\")) score += 3;
  if (text.length >= 24) score += 3;
  if (!text) score -= 100;
  return score;
}

function compareEntriesBySessionPreview(
  a: TranscriptArchiveEntry,
  b: TranscriptArchiveEntry,
) {
  const priority = sessionPreviewPriority(b) - sessionPreviewPriority(a);
  if (priority) return priority;
  return compareEntriesByNewest(a, b);
}

function rankSessionEntries(entries: TranscriptArchiveEntry[]) {
  return [...entries].sort(compareEntriesBySessionPreview);
}

function buildSessionPreviewFromRankedEntries(
  entries: TranscriptArchiveEntry[],
) {
  const topScore = entries.length ? sessionPreviewPriority(entries[0]) : 0;
  const chosen = entries
    .filter(
      (entry, index) =>
        index === 0 || sessionPreviewPriority(entry) >= topScore - 8,
    )
    .slice(0, 2)
    .map((entry) => transcriptPreviewText(entry));
  return trimText(chosen.join("\n"), 240);
}

export function sessionGroupingKey(input: {
  sessionFile?: string;
  sessionId?: string;
  id?: string;
}) {
  return (
    safeString(input.sessionFile || "").trim() ||
    safeString(input.sessionId || "").trim() ||
    safeString(input.id || "").trim()
  );
}

function formatTranscriptMessageText(value: string, max = 240) {
  return trimText(safeString(value).replace(/\s+/g, " ").trim(), max);
}

export function buildResultMessage(
  entry: TranscriptArchiveEntry,
): TranscriptResultMessage {
  return {
    id: entry.id,
    role: entry.role,
    timestamp: entry.timestamp,
    line: Math.max(1, Number(entry.archiveLine || 0) || 1),
    text: formatTranscriptMessageText(entry.text),
    toolName: safeString(entry.toolName || "").trim() || undefined,
  };
}

export function presentSessionResult(
  entries: TranscriptArchiveEntry[],
  score: number,
  rootOverride = "",
  extra: {
    hitCount?: number;
    messages?: TranscriptResultMessage[];
  } = {},
): TranscriptSessionResult {
  const rankedDisplayEntries = rankSessionEntries(entries);
  const previewEntry = rankedDisplayEntries[0];
  const latestEntry = latestTranscriptEntry(entries);
  const preview = buildSessionPreviewFromRankedEntries(rankedDisplayEntries);
  const sessionName = resolveTranscriptSessionDisplayName(
    safeString(previewEntry?.sessionFile || "").trim(),
    preview,
  );
  return {
    sourceType: "session",
    id:
      safeString(
        previewEntry?.sessionId ||
          previewEntry?.sessionFile ||
          previewEntry?.id,
      ).trim() || previewEntry.id,
    name: sessionName || "session",
    role: previewEntry.role,
    score,
    path:
      safeString(previewEntry.archivePath || "").trim() ||
      getTranscriptArchivePath(previewEntry, rootOverride),
    sessionId: previewEntry.sessionId,
    sessionFile: previewEntry.sessionFile,
    timestamp: latestEntry?.timestamp || previewEntry.timestamp,
    description: trimText(preview, 160),
    preview,
    hitCount: extra.hitCount,
    messages:
      extra.messages && extra.messages.length
        ? extra.messages
        : rankedDisplayEntries
            .slice(0, MAX_MATCHED_ENTRIES_PER_SESSION)
            .map((entry) => buildResultMessage(entry)),
  };
}
