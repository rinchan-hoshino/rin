import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ensureExtension as ensureSharedExtension,
  ensureFileName,
  extensionFromMimeType as extensionFromSharedMimeType,
  isImageMimeType,
  isImageName,
} from "../chat/file-utils.js";
import {
  renderChatNodesMarkdown,
  renderChatNodesPlain,
  expandRichTextSyntaxNodes,
  renderChatNodesTelegramHtml,
  type RenderChatNodesOptions,
} from "../chat/rich-text.js";
import { ensureDir } from "../platform/fs.js";
import { safeString } from "../text-utils.js";

const ALL_TEXT_MIME_EXTENSION_OPTIONS = {
  allTextMimeTypes: true,
} as const;

export { ensureDir, ensureFileName, isImageMimeType, isImageName, safeString };

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

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export function splitPlainText(text: string, maxLength: number) {
  const normalized = safeString(text);
  if (!normalized) return [];
  const chars = Array.from(normalized);
  const limit = Math.max(1, Math.floor(maxLength) || 1);
  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < chars.length) {
    const remaining = chars.length - cursor;
    if (remaining <= limit) {
      const chunk = chars.slice(cursor).join("").trim();
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
    const chunk = chars.slice(cursor, nextCursor).join("").trim();
    if (chunk) {
      chunks.push(chunk);
      cursor = nextCursor;
      while (cursor < chars.length && /\s/.test(chars[cursor] || "")) {
        cursor += 1;
      }
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
) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`download_failed:${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.promises.writeFile(filePath, buffer);
  return buffer;
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
    work: nodes.filter(
      (node) => safeString(node?.type).toLowerCase() !== "quote",
    ),
    replyToMessageId: extractQuoteMessageId(nodes),
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

export function fileUrl(filePath: string) {
  return pathToFileURL(path.resolve(filePath)).href;
}

export async function readBinaryFromNode(node: any) {
  const attrs = node?.attrs && typeof node.attrs === "object" ? node.attrs : {};
  const name = ensureFileName(
    safeString(attrs.name).trim() ||
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
  const src = safeString(attrs.src || attrs.url || "").trim();
  if (!src) return null;
  if (src.startsWith("file://")) {
    const filePath = fileURLToPath(src);
    const data = await fs.promises.readFile(filePath);
    return {
      data,
      name:
        ensureExtension(path.basename(filePath), mimeType) ||
        ensureExtension(name, mimeType),
      mimeType,
    };
  }
  if (/^https?:\/\//i.test(src)) {
    return {
      url: src,
      name: ensureExtension(name, mimeType),
      mimeType,
    };
  }
  const data = await fs.promises.readFile(path.resolve(src));
  return {
    data,
    name:
      ensureExtension(path.basename(src), mimeType) ||
      ensureExtension(name, mimeType),
    mimeType,
  };
}

export function extractQuoteMessageId(nodes: any[]) {
  const quote = nodes.find(
    (node) => safeString(node?.type).toLowerCase() === "quote",
  );
  return safeString(quote?.attrs?.id || "").trim() || undefined;
}
