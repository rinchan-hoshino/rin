import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { safeString } from "./text-utils.js";

export type RenderMessageTextOptions = {
  includeThinking?: boolean;
  renderAt?: (attrs: Record<string, any>) => string;
  normalizeChildren?: (text: string) => string;
};

type MessagePart = Record<string, any>;
type NormalizedMessagePart = {
  value: MessagePart;
  type: string;
  attrs: Record<string, any>;
  children: any[];
};

const EMPTY_OBJECT: Record<string, any> = {};
const FILE_URL_PATTERN = /file:\/\/[^\s'"`<>]+/g;

function isMessagePart(value: unknown): value is MessagePart {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeMessagePartType(value: unknown) {
  return safeString(value).trim().toLowerCase();
}

function normalizeMessagePart(value: unknown): NormalizedMessagePart | null {
  if (!isMessagePart(value)) return null;
  return {
    value,
    type: normalizeMessagePartType(value.type),
    attrs: isMessagePart(value.attrs) ? value.attrs : EMPTY_OBJECT,
    children: Array.isArray(value.children) ? value.children : [],
  };
}

function normalizeRenderedChildren(
  text: string,
  normalizeChildren?: (text: string) => string,
) {
  return typeof normalizeChildren === "function"
    ? normalizeChildren(text)
    : text;
}

function renderMessageChildren(
  content: any[],
  options: RenderMessageTextOptions,
) {
  return content.map((part) => renderMessageNode(part, options)).join("");
}

function renderContainerMessagePart(
  part: NormalizedMessagePart,
  options: RenderMessageTextOptions,
) {
  const childText = normalizeRenderedChildren(
    renderMessageChildren(part.children, options),
    options.normalizeChildren,
  );
  return part.type === "p" || part.type === "paragraph"
    ? childText
      ? `${childText}\n`
      : ""
    : childText;
}

function renderMessageNode(
  content: any,
  options: RenderMessageTextOptions,
): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return renderMessageChildren(content, options);

  const part = normalizeMessagePart(content);
  if (!part) return "";

  switch (part.type) {
    case "text":
      return safeString(part.value.text ?? part.attrs.content ?? "");
    case "thinking":
      return options.includeThinking ? safeString(part.value.thinking) : "";
    case "at":
      return typeof options.renderAt === "function"
        ? safeString(options.renderAt(part.attrs))
        : "";
    case "br":
      return "\n";
    default:
      return renderContainerMessagePart(part, options);
  }
}

export function renderMessageText(
  content: any,
  options: RenderMessageTextOptions = {},
): string {
  return renderMessageNode(content, options);
}

export function extractMessageText(
  content: any,
  {
    includeThinking = false,
    trim = false,
  }: { includeThinking?: boolean; trim?: boolean } = {},
) {
  const text = renderMessageText(content, { includeThinking });
  return trim ? text.trim() : text;
}

export function extractTextBeforeFirstToolCall(
  content: any,
  {
    includeThinking = false,
    trim = false,
  }: { includeThinking?: boolean; trim?: boolean } = {},
) {
  if (!Array.isArray(content)) {
    const text = renderMessageText(content, { includeThinking });
    return trim ? text.trim() : text;
  }
  const prefixParts: any[] = [];
  for (const entry of content) {
    const part = normalizeMessagePart(entry);
    if (part?.type === "toolcall") break;
    prefixParts.push(entry);
  }
  const text = renderMessageText(prefixParts, { includeThinking });
  return trim ? text.trim() : text;
}

export function normalizeMessageText(text: unknown) {
  return safeString(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n[\t ]+/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function mapMessagePartsByType<T>(
  content: any,
  type: string,
  map: (part: MessagePart) => T | undefined,
) {
  const normalizedType = normalizeMessagePartType(type);
  if (!Array.isArray(content) || !normalizedType) return [] as T[];

  const parts: T[] = [];
  for (const entry of content) {
    const part = normalizeMessagePart(entry);
    if (!part || part.type !== normalizedType) continue;
    const mapped = map(part.value);
    if (mapped !== undefined) parts.push(mapped);
  }
  return parts;
}

function collectUniqueTrimmedStrings<T>(
  values: T[],
  pick: (value: T) => unknown,
) {
  return Array.from(
    new Set(
      values.map((value) => safeString(pick(value)).trim()).filter(Boolean),
    ),
  );
}

export function extractToolCallParts(content: any) {
  return mapMessagePartsByType(content, "toolCall", (part) => part);
}

export function extractToolCallNames(content: any) {
  return collectUniqueTrimmedStrings(
    extractToolCallParts(content),
    (part) => part.name || part.toolName || "",
  );
}

export function countToolCalls(content: any) {
  return extractToolCallParts(content).length;
}

export function isAssistantFailedMessage(message: any) {
  if (String(message?.role || "").trim() !== "assistant") return false;
  const stopReason = safeString(message?.stopReason).trim();
  return (
    stopReason === "error" ||
    stopReason === "aborted" ||
    Boolean(safeString(message?.errorMessage).trim())
  );
}

export function extractAssistantFinalText(message: any) {
  if (String(message?.role || "").trim() !== "assistant") return "";
  if (isAssistantFailedMessage(message)) return "";
  if (countToolCalls(message?.content) > 0) return "";
  return safeString(
    extractMessageText(message?.content, {
      includeThinking: false,
      trim: true,
    }),
  ).trim();
}

export function isAssistantFinalMessage(message: any) {
  return Boolean(extractAssistantFinalText(message));
}

export function extractImageParts(content: any) {
  return mapMessagePartsByType(content, "image", (part) => {
    const data = safeString(part.data || "");
    if (!data) return undefined;
    return {
      data,
      mimeType: safeString(part.mimeType || "").trim() || "image/png",
    };
  });
}

function normalizeFileUrlPath(rawUrl: string) {
  const value = safeString(rawUrl).trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "file:") return "";
    parsed.search = "";
    parsed.hash = "";
    return path.resolve(fileURLToPath(parsed));
  } catch {
    return "";
  }
}

function isExistingFile(filePath: string) {
  if (!filePath) return false;
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function extractExistingFilePaths(text: string, max = 8) {
  const limit = Math.max(0, max);
  if (!limit) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of safeString(text).matchAll(FILE_URL_PATTERN)) {
    const resolved = normalizeFileUrlPath(match[0]);
    if (!resolved || seen.has(resolved) || !isExistingFile(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
    if (out.length >= limit) break;
  }
  return out;
}
