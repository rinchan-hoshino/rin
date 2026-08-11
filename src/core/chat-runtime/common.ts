import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ensureExtension as ensureSharedExtension,
  ensureFileName,
  extensionFromMimeType as extensionFromSharedMimeType,
  fileNameFromUrl,
  isImageMimeType,
  isImageName,
} from "../chat/file-utils.js";
import {
  renderChatNodesMarkdown,
  renderChatNodesPlain,
  expandRichTextSyntaxNodes,
  normalizeRenderedText,
  renderChatNodesTelegramHtml,
  extractChatQuoteMessageId,
  withoutChatQuoteNodes,
  type RenderChatNodesOptions,
} from "../chat/rich-text.js";
import {
  createRinHttpTransport,
  discardRinHttpResponseBody,
  type RinHttpTransport,
} from "../http/transport.js";
import { ensureDir } from "../platform/fs.js";
import { sleep } from "../platform/process.js";
import { safeString } from "../text-utils.js";

const ALL_TEXT_MIME_EXTENSION_OPTIONS = {
  allTextMimeTypes: true,
} as const;

export {
  ensureDir,
  ensureFileName,
  isImageMimeType,
  isImageName,
  safeString,
  sleep,
};

export function partialChatDeliveryError(
  error: unknown,
  deliveredMessageIds: string[],
) {
  const message = safeString((error as any)?.message || error) || "send_failed";
  const next = new Error(`chat_delivery_partial:${message}`) as Error & {
    deliveredMessageIds: string[];
    partialDelivery: true;
  };
  next.deliveredMessageIds = [...deliveredMessageIds];
  next.partialDelivery = true;
  return next;
}

const DEFAULT_WORKING_TEXT = "Working...";
const LEGACY_EDITABLE_WORKING_TEXTS = ["Working", "Working.", "Working.."];

export const EDITABLE_INTERMEDIATE_PREFIX = "...";
export const EDITABLE_MESSAGE_SECTION_SEPARATOR = "────────";

type ChatRuntimeWorkingCopy = {
  workingText: string;
  progressTexts: string[];
};

function uniqueStrings(values: unknown[]) {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const text = safeString(value).trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    output.push(text);
  }
  return output;
}

export function resolveChatRuntimeWorkingCopy(): ChatRuntimeWorkingCopy {
  return {
    workingText: DEFAULT_WORKING_TEXT,
    progressTexts: [DEFAULT_WORKING_TEXT, ...LEGACY_EDITABLE_WORKING_TEXTS],
  };
}

export function editableIntermediateHeadText(text: unknown) {
  const value = safeString(text).trim();
  if (!value) return "";
  if (value.startsWith(`${EDITABLE_INTERMEDIATE_PREFIX} `)) {
    return value;
  }
  return `${EDITABLE_INTERMEDIATE_PREFIX} ${value}`;
}

export function isEditableWorkingText(text: unknown, progressTexts?: unknown) {
  const value = safeString(text).trim();
  const resolvedTexts = uniqueStrings([
    DEFAULT_WORKING_TEXT,
    ...LEGACY_EDITABLE_WORKING_TEXTS,
    ...(Array.isArray(progressTexts) ? progressTexts : [progressTexts]),
  ]);
  return Boolean(value && resolvedTexts.includes(value));
}

export function extensionFromMimeType(mimeType: string) {
  return extensionFromSharedMimeType(mimeType, ALL_TEXT_MIME_EXTENSION_OPTIONS);
}

export function ensureExtension(fileName: string, mimeType = "") {
  return ensureSharedExtension(
    fileName,
    mimeType,
    ALL_TEXT_MIME_EXTENSION_OPTIONS,
  );
}

export function createPrefixedLogger(name: string, fallback: any) {
  const prefix = `[${safeString(name).trim() || "chat-runtime"}]`;
  return {
    debug: (...args: any[]) =>
      fallback?.debug ? fallback.debug(prefix, ...args) : undefined,
    info: (...args: any[]) =>
      fallback?.info ? fallback.info(prefix, ...args) : undefined,
    warn: (...args: any[]) =>
      fallback?.warn ? fallback.warn(prefix, ...args) : undefined,
    error: (...args: any[]) =>
      fallback?.error ? fallback.error(prefix, ...args) : undefined,
  };
}

export function emitBotStatus(app: any, bot: any, status: number) {
  if (Number(bot?.status) === status) return;
  bot.status = status;
  app.emit("bot-status-updated", bot);
}

export function stripMentionTokens(text: string, tokens: string[]) {
  let next = safeString(text);
  for (const token of tokens.filter(Boolean)) {
    next = next.replace(
      new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
      " ",
    );
  }
  return next.replace(/^[\s,:，\-—]+/, "").trim();
}

export type EditableMessageSections = {
  workingTextChunks: string[];
  contentTextChunks: string[];
  todoTextChunks: string[];
};

function normalizeTextChunks(value: unknown) {
  return (Array.isArray(value) ? value : value ? [value] : [])
    .map((item) => safeString(item))
    .filter(Boolean);
}

export function emptyEditableMessageSections(): EditableMessageSections {
  return {
    workingTextChunks: [],
    contentTextChunks: [],
    todoTextChunks: [],
  };
}

export function editableMessageSectionsFromRecord(
  record: any,
): EditableMessageSections {
  const kind = safeString(record?.kind).trim();
  const legacyMainTextChunks = normalizeTextChunks(
    Array.isArray(record?.mainTextChunks)
      ? record.mainTextChunks
      : record?.mainText,
  );
  const legacyTextChunks = normalizeTextChunks(
    Array.isArray(record?.textChunks) ? record.textChunks : record?.text,
  );
  const workingTextChunks = normalizeTextChunks(
    Array.isArray(record?.workingTextChunks)
      ? record.workingTextChunks
      : record?.workingText,
  );
  const contentTextChunks = normalizeTextChunks(
    Array.isArray(record?.contentTextChunks)
      ? record.contentTextChunks
      : record?.contentText,
  );
  const todoTextChunks = normalizeTextChunks(
    Array.isArray(record?.todoTextChunks)
      ? record.todoTextChunks
      : record?.todoText,
  );
  return {
    workingTextChunks: workingTextChunks.length
      ? workingTextChunks
      : kind === "working"
        ? legacyMainTextChunks.length
          ? legacyMainTextChunks
          : legacyTextChunks
        : [],
    contentTextChunks: contentTextChunks.length
      ? contentTextChunks
      : kind && kind !== "working" && kind !== "todo"
        ? legacyMainTextChunks.length
          ? legacyMainTextChunks
          : legacyTextChunks
        : [],
    todoTextChunks: todoTextChunks.length
      ? todoTextChunks
      : kind === "todo"
        ? legacyMainTextChunks.length
          ? legacyMainTextChunks
          : legacyTextChunks
        : [],
  };
}

export function composeEditableMessageText(sections: EditableMessageSections) {
  return [
    sections.workingTextChunks.map((item) => safeString(item)).join(""),
    sections.contentTextChunks.map((item) => safeString(item)).join(""),
    sections.todoTextChunks.map((item) => safeString(item)).join(""),
  ]
    .filter(Boolean)
    .join(`\n\n${EDITABLE_MESSAGE_SECTION_SEPARATOR}\n\n`);
}

export function updateEditableMessageSections(input: {
  kind?: string;
  textChunks: string[];
  persisted?: Partial<EditableMessageSections> | null;
  fallbackWorkingTextChunks?: string[];
  fallbackTodoTextChunks?: string[];
  exclusive?: boolean;
  finalize?: boolean;
}): EditableMessageSections {
  const kind = safeString(input.kind).trim() || "working";
  const nextTextChunks = normalizeTextChunks(input.textChunks);
  const persisted = input.persisted || emptyEditableMessageSections();
  const existingWorking = normalizeTextChunks(persisted.workingTextChunks);
  const existingContent = normalizeTextChunks(persisted.contentTextChunks);
  const existingTodo = normalizeTextChunks(persisted.todoTextChunks);
  const fallbackWorking = normalizeTextChunks(input.fallbackWorkingTextChunks);
  const fallbackTodo = normalizeTextChunks(input.fallbackTodoTextChunks);
  if (input.exclusive) {
    return {
      workingTextChunks: [],
      contentTextChunks: nextTextChunks,
      todoTextChunks: [],
    };
  }
  const section =
    kind === "todo"
      ? "todo"
      : kind === "working" && !input.finalize
        ? "working"
        : "content";
  return {
    workingTextChunks:
      section === "working"
        ? nextTextChunks
        : input.finalize
          ? []
          : existingWorking.length
            ? existingWorking
            : fallbackWorking,
    contentTextChunks: section === "content" ? nextTextChunks : existingContent,
    todoTextChunks: input.finalize
      ? []
      : section === "todo"
        ? nextTextChunks
        : existingTodo.length
          ? existingTodo
          : fallbackTodo,
  };
}

export function splitPlainText(text: string, maxLength: number) {
  const normalized = normalizeRenderedText(text);
  const trimChunk = (chunk: string) => normalizeRenderedText(chunk);
  if (!normalized) return [];
  const chars = Array.from(normalized);
  const limit = Math.max(1, Math.floor(maxLength) || 1);
  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < chars.length) {
    const remaining = chars.length - cursor;
    if (remaining <= limit) {
      const chunk = trimChunk(chars.slice(cursor).join(""));
      if (chunk) chunks.push(chunk);
      break;
    }

    const windowText = chars.slice(cursor, cursor + limit).join("");
    let splitOffset = -1;
    for (const marker of ["\n\n", "\n", " "]) {
      const markerOffset = windowText.lastIndexOf(marker);
      if (markerOffset >= 0) {
        splitOffset = markerOffset + marker.length;
        break;
      }
    }
    if (splitOffset <= 0) splitOffset = limit;

    const nextCursor = cursor + splitOffset;
    const chunk = trimChunk(chars.slice(cursor, nextCursor).join(""));
    if (chunk) {
      chunks.push(chunk);
      cursor = nextCursor;
      continue;
    }

    chunks.push(chars.slice(cursor, cursor + limit).join(""));
    cursor += limit;
  }

  return chunks;
}

export async function downloadToFile(
  filePath: string,
  url: string,
  headers?: Record<string, string>,
  transport?: RinHttpTransport,
) {
  const requestTransport = transport || createRinHttpTransport();
  try {
    const response = await requestTransport.fetch(url, { headers });
    try {
      if (!response.ok) {
        throw new Error(`download_failed:${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      await fs.promises.writeFile(filePath, buffer);
      return buffer;
    } finally {
      await discardRinHttpResponseBody(response);
    }
  } finally {
    if (!transport) await requestTransport.close();
  }
}

export function compactObject<T extends Record<string, any>>(value: T) {
  const next: Record<string, any> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue;
    if (typeof item === "string" && !item.trim()) continue;
    next[key] = item;
  }
  return next as T;
}

export function normalizeNode(
  type: string,
  attrs?: Record<string, any>,
  children?: any[],
) {
  return {
    type: safeString(type).trim().toLowerCase(),
    attrs: attrs && typeof attrs === "object" ? attrs : {},
    children: Array.isArray(children)
      ? children.flat(Infinity).filter(Boolean)
      : [],
  };
}

export function prependChatQuoteNode(nodes: any[], messageId: unknown) {
  const work = Array.isArray(nodes) ? nodes : [];
  const id = safeString(messageId).trim();
  if (!id) return work;
  return [
    normalizeNode("quote", { id }),
    ...(work.length ? [normalizeNode("br"), ...work] : []),
  ];
}

export function flattenNodes(value: any): any[] {
  if (!Array.isArray(value)) return value ? [value] : [];
  return value.flatMap((item) => flattenNodes(item)).filter(Boolean);
}

function assertOutboundStructuredMentions(nodes: any[]) {
  for (const node of flattenNodes(nodes)) {
    const type = safeString(node?.type).trim().toLowerCase();
    if (type === "at" && !safeString(node?.attrs?.id).trim()) {
      throw new Error("chat_send_at_id_required");
    }
    if (Array.isArray(node?.children)) {
      assertOutboundStructuredMentions(node.children);
    }
  }
}

export function prepareOutboundNodes(content: any) {
  const nodes = expandRichTextSyntaxNodes(
    flattenNodes(content)
      .map((node) =>
        typeof node === "string"
          ? normalizeNode("text", { content: node })
          : node,
      )
      .filter(Boolean),
  );
  assertOutboundStructuredMentions(nodes);
  return {
    nodes,
    work: withoutChatQuoteNodes(nodes),
    replyToMessageId: extractChatQuoteMessageId(nodes),
  };
}

export type RenderPlainTextOptions = RenderChatNodesOptions;

export function renderPlainTextFromNodes(
  nodes: any[],
  options: RenderPlainTextOptions = {},
) {
  return renderChatNodesPlain(nodes, options);
}

export function renderMarkdownFromNodes(
  nodes: any[],
  options: RenderPlainTextOptions = {},
) {
  return renderChatNodesMarkdown(nodes, options);
}

export function renderTelegramHtmlFromNodes(
  nodes: any[],
  options: RenderPlainTextOptions = {},
) {
  return renderChatNodesTelegramHtml(nodes, options);
}

export function isEditableProgressDeliveryKind(value: unknown) {
  const deliveryKind = safeString(value).trim();
  return deliveryKind === "interim" || deliveryKind === "passive_notice";
}

const RICH_DELIVERY_MEDIA_TYPES = new Set([
  "image",
  "file",
  "video",
  "audio",
  "sticker",
]);

function isLocalMediaSource(value: unknown) {
  const source = safeString(value).trim();
  if (!source || source.startsWith("//")) return false;
  if (path.isAbsolute(source) || path.win32.isAbsolute(source)) return true;
  if (/^file:/i.test(source)) return true;
  return !/^[a-z][a-z0-9+.-]*:/i.test(source);
}

function localMediaFallbackText(type: string, attrs: Record<string, any>) {
  const source = safeString(
    attrs.src || attrs.url || attrs.file || attrs.path || "",
  ).trim();
  if (!isLocalMediaSource(source)) return "";
  const nameSource = safeString(attrs.name || attrs.file || source).trim();
  const name = fileNameFromUrl(nameSource.replace(/\\/g, "/"), type);
  return `[${type}: ${name}]`;
}

function richDeliverySourceText(node: any): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(richDeliverySourceText).join("");
  if (typeof node !== "object") return "";
  const type = safeString(node.type).trim().toLowerCase();
  const attrs = node.attrs && typeof node.attrs === "object" ? node.attrs : {};
  if (RICH_DELIVERY_MEDIA_TYPES.has(type)) {
    const fallback = localMediaFallbackText(type, attrs);
    if (fallback) return fallback;
  }
  if (typeof node.raw === "string" && node.raw) return node.raw;
  if (type === "text" || type === "markdown" || type === "md") {
    return safeString(
      node.text ??
        node.content ??
        attrs.content ??
        attrs.text ??
        attrs.value ??
        "",
    );
  }
  if (type === "br") return "\n";
  if (Array.isArray(node.children) && node.children.length) {
    return node.children.map(richDeliverySourceText).join("");
  }
  try {
    return renderMarkdownFromNodes([node]);
  } catch {
    return "";
  }
}

export function renderRichDeliveryFallback(nodes: any[]) {
  try {
    const sourceNodes = flattenNodes(nodes).filter(Boolean);
    if (!sourceNodes.length) return "";
    const source = sourceNodes.map(richDeliverySourceText).join("");
    if (source.trim()) return source;
    const plain = renderPlainTextFromNodes(sourceNodes, {
      markdown: "preserve",
    });
    return plain.trim() ? plain : "";
  } catch {
    return "";
  }
}

export function fileUrl(filePath: string) {
  return pathToFileURL(path.resolve(filePath)).href;
}

function resolveLocalMediaPath(src: string) {
  if (!src) return "";
  if (src.startsWith("file://")) return fileURLToPath(src);
  if (/^https?:\/\//i.test(src)) return "";
  return path.resolve(src);
}

function mediaNameFromSource(src: string) {
  const localPath = resolveLocalMediaPath(src);
  if (localPath) return path.basename(localPath);
  try {
    const url = new URL(src);
    return /^https?:$/i.test(url.protocol) ? path.basename(url.pathname) : "";
  } catch {
    return "";
  }
}

function mediaSourceMissingError(filePath: string) {
  return new Error(`chat_media_file_missing:${filePath}`);
}

export async function readBinaryFromNode(node: any) {
  const attrs = node?.attrs && typeof node.attrs === "object" ? node.attrs : {};
  const src = safeString(attrs.src || attrs.url || "").trim();
  const name = ensureFileName(
    safeString(attrs.name).trim() ||
      (!src.startsWith("data:") ? mediaNameFromSource(src) : "") ||
      `${safeString(node?.type).trim() || "file"}`,
    "file",
  );
  const mimeType = safeString(attrs.mimeType || attrs.mime || "").trim();
  if (Buffer.isBuffer(attrs.data)) {
    return {
      data: attrs.data,
      name: ensureExtension(name, mimeType),
      mimeType,
    };
  }
  if (!src) return null;
  const inlineData = /^data:([^;,]+)?;base64,(.*)$/is.exec(src);
  if (inlineData) {
    const inlineMimeType = safeString(inlineData[1] || mimeType).trim();
    return {
      data: Buffer.from(inlineData[2] || "", "base64"),
      name: ensureExtension(name, inlineMimeType),
      mimeType: inlineMimeType,
    };
  }
  if (src.startsWith("file://")) {
    const filePath = fileURLToPath(src);
    try {
      const data = await fs.promises.readFile(filePath);
      return {
        data,
        name:
          ensureExtension(path.basename(filePath), mimeType) ||
          ensureExtension(name, mimeType),
        mimeType,
      };
    } catch (error: any) {
      if (error?.code === "ENOENT") throw mediaSourceMissingError(filePath);
      throw error;
    }
  }
  if (/^https?:\/\//i.test(src)) {
    return {
      url: src,
      name: ensureExtension(name, mimeType),
      mimeType,
    };
  }
  const filePath = path.resolve(src);
  try {
    const data = await fs.promises.readFile(filePath);
    return {
      data,
      name:
        ensureExtension(path.basename(src), mimeType) ||
        ensureExtension(name, mimeType),
      mimeType,
    };
  } catch (error: any) {
    if (error?.code === "ENOENT") throw mediaSourceMissingError(filePath);
    throw error;
  }
}

export const extractQuoteMessageId = extractChatQuoteMessageId;
