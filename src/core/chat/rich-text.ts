import { Lexer } from "marked";

import { formatRinTodoChecklistMarkdownContent } from "../rin-lib/todo-state.js";
import { safeString } from "../text-utils.js";

export type ChatMarkdownPolicy = "render" | "preserve" | "strip";

export type RenderChatNodesOptions = {
  renderAt?: (attrs: Record<string, any>) => string;
  markdown?: "preserve" | "strip";
  includeMedia?: boolean;
};

export function chatMarkdownPolicyForPlatform(
  platform: string,
): ChatMarkdownPolicy {
  const value = safeString(platform).trim().toLowerCase();
  if (value === "telegram") return "render";
  if (value === "discord" || value === "slack") return "preserve";
  return "strip";
}

function attrsOf(node: any): Record<string, any> {
  return node?.attrs && typeof node.attrs === "object" ? node.attrs : {};
}

function childrenOf(node: any): any[] {
  return Array.isArray(node?.children) ? node.children : [];
}

function textAttr(node: any, attrs: Record<string, any>) {
  return safeString(
    node?.text ??
      node?.content ??
      attrs.content ??
      attrs.text ??
      attrs.value ??
      "",
  );
}

function resourceLabel(attrs: Record<string, any>) {
  return (
    safeString(attrs.name).trim() ||
    safeString(attrs.title).trim() ||
    safeString(attrs.fileName).trim() ||
    safeString(attrs.file).trim() ||
    safeString(attrs.src).trim() ||
    safeString(attrs.url).trim()
  );
}

function mediaMarkdown(type: string, attrs: Record<string, any>) {
  const normalizedType = type === "img" ? "image" : type;
  const label = resourceLabel(attrs) || normalizedType;
  const src = safeString(attrs.src || attrs.url || attrs.file || "").trim();
  if (normalizedType === "image") {
    return src ? `[image: ${label}](${src})` : `[image: ${label}]`;
  }
  return src
    ? `[${normalizedType}: ${label}](${src})`
    : `[${normalizedType}: ${label}]`;
}

function todoItemsFromAttrs(attrs: Record<string, any>) {
  const rawItems = Array.isArray(attrs.items)
    ? attrs.items
    : Array.isArray(attrs.todos)
      ? attrs.todos
      : [];
  return rawItems
    .map((item) => {
      const value = item && typeof item === "object" ? (item as any) : null;
      if (!value) return null;
      const text = safeString(value.text).replace(/\s+/g, " ").trim();
      if (!text) return null;
      return { text, done: Boolean(value.done) };
    })
    .filter((item): item is { text: string; done: boolean } => Boolean(item));
}

function todoPlainText(attrs: Record<string, any>) {
  const items = todoItemsFromAttrs(attrs);
  if (!items.length) return "";
  const title = safeString(attrs.title).trim();
  const body = formatRinTodoChecklistMarkdownContent(items);
  return title ? `${title}\n${body}` : body;
}

export function stripHtmlFormatting(text: string) {
  return safeString(text)
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|li|blockquote|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

export function stripMarkdownFormatting(text: string) {
  let next = safeString(text);
  next = next.replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, "$1");
  next = next.replace(/`([^`]+)`/g, "$1");
  next = next.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, url) => {
    const label = safeString(alt).trim() || safeString(url).trim();
    return label ? `[image: ${label}]` : "[image]";
  });
  next = next.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
  next = next.replace(/^([\t ]{0,3})#{1,6}\s+/gm, "$1");
  next = next.replace(/^([\t ]{0,3})>\s?/gm, "$1> ");
  next = next.replace(/^([\t ]*)[-*+]\s+/gm, "$1- ");
  next = next.replace(/^([\t ]*)(\d+)[.)]\s+/gm, "$1$2. ");
  next = next.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  next = next.replace(/(?<!\w)__([^_\n]+)__(?!\w)/g, "$1");
  next = next.replace(/\*([^*\n]+)\*/g, "$1");
  next = next.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "$1");
  next = next.replace(/~~(.*?)~~/g, "$1");
  return normalizeRenderedText(next);
}

export function normalizeRenderedText(text: string) {
  const normalized = safeString(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+\n/g, "\n");
  if (!normalized.trim()) return "";
  return normalized
    .replace(/^(?:[\t ]*\n)+/, "")
    .replace(/(?:\n[\t ]*)+$/, "")
    .replace(/[\t ]+$/, "");
}

function renderNodeMarkdown(
  node: any,
  options: RenderChatNodesOptions,
): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node))
    return node.map((item) => renderNodeMarkdown(item, options)).join("");
  if (!node || typeof node !== "object") return "";
  const type = safeString(node.type).trim().toLowerCase();
  const attrs = attrsOf(node);
  switch (type) {
    case "text":
      return textAttr(node, attrs);
    case "markdown":
    case "md":
      return textAttr(node, attrs);
    case "html":
      return stripHtmlFormatting(textAttr(node, attrs));
    case "at": {
      if (typeof options.renderAt === "function")
        return safeString(options.renderAt(attrs));
      const name = safeString(attrs.name).trim();
      const id = safeString(attrs.id).trim();
      const label = name || id;
      return id ? `[@${label}](at:${id})` : label ? `@${label}` : "@";
    }
    case "br":
      return "\n";
    case "quote": {
      const body = normalizeRenderedText(
        renderNodeMarkdown(childrenOf(node), options),
      );
      const id = safeString(attrs.id || attrs.messageId).trim();
      const marker = id ? `[quote:${id}]` : "[quote]";
      return body ? `${marker}\n> ${body.replace(/\n/g, "\n> ")}` : marker;
    }
    case "forward": {
      const body = normalizeRenderedText(
        renderNodeMarkdown(childrenOf(node), options),
      );
      const id = safeString(attrs.id || attrs.messageId).trim();
      const title =
        safeString(attrs.title).trim() || safeString(attrs.name).trim();
      const marker = ["forward", title, id].filter(Boolean).join(": ");
      return body ? `[${marker}]\n${body}` : `[${marker}]`;
    }
    case "image":
    case "img":
    case "file":
    case "video":
    case "audio":
    case "voice":
    case "sticker":
    case "record":
      return options.includeMedia === false
        ? ""
        : `\n${mediaMarkdown(type, attrs)}\n`;
    case "todo":
    case "checklist":
      return todoPlainText(attrs);
    case "p":
    case "paragraph": {
      const rendered = renderNodeMarkdown(childrenOf(node), options);
      return rendered ? `${rendered}\n` : "";
    }
    default:
      return renderNodeMarkdown(childrenOf(node), options);
  }
}

export function renderChatNodesMarkdown(
  nodes: any[],
  options: RenderChatNodesOptions = {},
) {
  return normalizeRenderedText(renderNodeMarkdown(nodes, options));
}

function firstQuoteNode(nodes: any[]): any | undefined {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (safeString(node?.type).trim().toLowerCase() === "quote") return node;
    const nested = firstQuoteNode(childrenOf(node));
    if (nested) return nested;
  }
  return undefined;
}

export function extractChatQuoteMessageId(nodes: any[]) {
  const quote = firstQuoteNode(nodes);
  const attrs = attrsOf(quote);
  return safeString(attrs.id || attrs.messageId).trim() || undefined;
}

export function withoutChatQuoteNodes(nodes: any[]): any[] {
  return (Array.isArray(nodes) ? nodes : [])
    .filter((node) => safeString(node?.type).trim().toLowerCase() !== "quote")
    .map((node) =>
      Array.isArray(node?.children)
        ? { ...node, children: withoutChatQuoteNodes(node.children) }
        : node,
    );
}

export function renderChatNodesPlain(
  nodes: any[],
  options: RenderChatNodesOptions = {},
) {
  const markdown = renderChatNodesMarkdown(nodes, options);
  return options.markdown === "preserve"
    ? markdown
    : stripMarkdownFormatting(markdown);
}

function richNode(type: string, attrs: Record<string, any> = {}) {
  return { type, attrs, children: [] as any[] };
}

function pushTextNode(target: any[], type: "markdown", text: string) {
  const content = safeString(text);
  if (!content.trim()) return;
  target.push(richNode(type, { content }));
}

function cleanMentionName(text: string) {
  return stripHtmlFormatting(safeString(text)).trim().replace(/^@+/, "");
}

function compactAttrs(attrs: Record<string, any>) {
  const next: Record<string, any> = {};
  for (const [key, value] of Object.entries(attrs)) {
    const text = safeString(value).trim();
    if (text) next[key] = text;
  }
  return next;
}

function mediaNode(type: string, src: string, name = "", raw = "") {
  return {
    ...richNode(
      type,
      compactAttrs({
        src: safeString(src).trim(),
        name: safeString(name).trim(),
      }),
    ),
    ...(raw ? { raw } : {}),
  };
}

type MarkdownSourceRange = { start: number; end: number };

function appendMarkdownRange(
  ranges: MarkdownSourceRange[],
  start: number,
  end: number,
) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
  ranges.push({ start, end });
}

function markdownRangeOverlaps(
  ranges: MarkdownSourceRange[],
  start: number,
  end: number,
) {
  return ranges.some((range) => start < range.end && end > range.start);
}

function locateTokenRaw(source: string, raw: string, cursor: number) {
  if (!raw) return -1;
  const afterCursor = source.indexOf(raw, Math.max(0, cursor));
  return afterCursor >= 0 ? afterCursor : source.indexOf(raw);
}

function childMarkdownTokens(token: any) {
  const children: any[] = [];
  if (Array.isArray(token?.tokens)) children.push(...token.tokens);
  if (Array.isArray(token?.items)) children.push(...token.items);
  return children;
}

function collectNestedMarkdownProtectedRanges(
  ranges: MarkdownSourceRange[],
  blockStart: number,
  blockRaw: string,
  tokens: any[],
) {
  let cursor = 0;
  for (const token of Array.isArray(tokens) ? tokens : []) {
    const raw = safeString(token?.raw);
    const children = childMarkdownTokens(token);
    if (!raw) {
      if (children.length) {
        collectNestedMarkdownProtectedRanges(
          ranges,
          blockStart,
          blockRaw,
          children,
        );
      }
      continue;
    }
    let localStart = blockRaw.indexOf(raw, cursor);
    if (localStart < 0) localStart = blockRaw.indexOf(raw);
    if (localStart < 0) {
      if (children.length) {
        collectNestedMarkdownProtectedRanges(
          ranges,
          blockStart,
          blockRaw,
          children,
        );
      }
      continue;
    }
    const start = blockStart + localStart;
    const end = start + raw.length;
    const type = safeString(token?.type).trim().toLowerCase();
    if (type === "code" || type === "codespan") {
      appendMarkdownRange(ranges, start, end);
    }
    if (children.length) {
      collectNestedMarkdownProtectedRanges(ranges, start, raw, children);
    }
    cursor = localStart + raw.length;
  }
}

function collectMarkdownProtectedRanges(source: string) {
  const ranges: MarkdownSourceRange[] = [];
  let cursor = 0;
  let tokens: any[] = [];
  try {
    tokens = Lexer.lex(source) as any[];
  } catch {
    return ranges;
  }

  for (const token of tokens) {
    const raw = safeString(token?.raw);
    if (!raw) continue;
    const start = locateTokenRaw(source, raw, cursor);
    if (start < 0) continue;
    const end = start + raw.length;
    const type = safeString(token?.type).trim().toLowerCase();
    if (type === "code") {
      appendMarkdownRange(ranges, start, end);
    }
    const children = childMarkdownTokens(token);
    if (children.length) {
      collectNestedMarkdownProtectedRanges(ranges, start, raw, children);
    }
    cursor = end;
  }

  return ranges.sort((a, b) => a.start - b.start || a.end - b.end);
}

function parseMarkdownRichTextNodes(text: string) {
  const source = safeString(text);
  const protectedRanges = collectMarkdownProtectedRanges(source);
  const nodes: any[] = [];
  const tokenPattern =
    /!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\((at|mention|quote):([^)]+)\)|\[(image|file|video|audio|sticker):\s*([^\]]*)\]\(([^)]+)\)|\[quote:\s*([^\]]+)\]/gi;
  let cursor = 0;
  for (const match of source.matchAll(tokenPattern)) {
    const index = typeof match.index === "number" ? match.index : cursor;
    const matchText = safeString(match[0]);
    const end = index + matchText.length;
    if (markdownRangeOverlaps(protectedRanges, index, end)) continue;
    pushTextNode(nodes, "markdown", source.slice(cursor, index));
    cursor = end;

    if (match[1] !== undefined) {
      nodes.push(mediaNode("image", match[2] || "", match[1] || "", matchText));
      continue;
    }
    if (match[3] !== undefined) {
      const scheme = safeString(match[4]).toLowerCase();
      if (scheme === "at" || scheme === "mention") {
        nodes.push({
          ...richNode(
            "at",
            compactAttrs({
              id: match[5] || "",
              name: cleanMentionName(match[3]),
            }),
          ),
          raw: matchText,
        });
      } else {
        nodes.push({
          ...richNode("quote", compactAttrs({ id: match[5] || "" })),
          raw: matchText,
        });
      }
      continue;
    }
    if (match[6] !== undefined) {
      nodes.push(
        mediaNode(
          match[6] || "file",
          match[8] || "",
          match[7] || "",
          matchText,
        ),
      );
      continue;
    }
    nodes.push({
      ...richNode("quote", compactAttrs({ id: match[9] || "" })),
      raw: matchText,
    });
  }
  pushTextNode(nodes, "markdown", source.slice(cursor));
  return nodes.length ? nodes : [richNode("markdown", { content: source })];
}

export function expandRichTextSyntaxNodes(nodes: any[]): any[] {
  return (Array.isArray(nodes) ? nodes : [])
    .flatMap((node) => {
      if (!node || typeof node !== "object") return node ? [node] : [];
      const type = safeString(node.type).trim().toLowerCase();
      const attrs = attrsOf(node);
      if (type === "markdown" || type === "md") {
        return parseMarkdownRichTextNodes(textAttr(node, attrs));
      }
      if (Array.isArray(node.children) && node.children.length) {
        return [
          { ...node, children: expandRichTextSyntaxNodes(node.children) },
        ];
      }
      return [node];
    })
    .filter(Boolean);
}

function escapeHtml(text: string) {
  return safeString(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeHtmlAttr(text: string) {
  return escapeHtml(text).replace(/'/g, "&#39;");
}

function renderTelegramAt(attrs: Record<string, any>) {
  const id = safeString(attrs.id).trim();
  const label =
    safeString(attrs.name).trim() || safeString(attrs.username).trim() || id;
  if (!id) return escapeHtml(label || "@");
  return `<a href="tg://user?id=${escapeHtmlAttr(id)}">${escapeHtml(label || id)}</a>`;
}

function sanitizeTelegramHtml(text: string) {
  let next = safeString(text);
  next = next.replace(
    /<(?!\/?(?:b|strong|i|em|u|s|strike|del|code|pre|a|blockquote|tg-spoiler)\b)[^>]*>/gi,
    "",
  );
  next = next.replace(/<(a)\b([^>]*)>/gi, (_match, tag, attrs) => {
    const href =
      /href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i.exec(attrs || "")?.[1] || "";
    const cleanHref = safeString(href)
      .replace(/^['"]|['"]$/g, "")
      .trim();
    return cleanHref
      ? `<${tag} href="${escapeHtmlAttr(cleanHref)}">`
      : `<${tag}>`;
  });
  return next;
}

export function markdownToTelegramHtml(text: string) {
  const placeholders: string[] = [];
  const keep = (html: string) => {
    const key = `\u0000${placeholders.length}\u0000`;
    placeholders.push(html);
    return key;
  };
  let next = safeString(text).replace(/\r\n?/g, "\n");
  next = next.replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, (_m, body) =>
    keep(`<pre>${escapeHtml(body)}</pre>`),
  );
  next = next.replace(/`([^`]+)`/g, (_m, body) =>
    keep(`<code>${escapeHtml(body)}</code>`),
  );
  next = escapeHtml(next);
  next = next.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  next = next.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  next = next.replace(/__([^_]+)__/g, "<b>$1</b>");
  next = next.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<i>$1</i>");
  next = next.replace(/(?<!_)_([^_\n]+)_(?!_)/g, "<i>$1</i>");
  next = next.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  next = next.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, url) => {
    const label = safeString(alt).trim() || safeString(url).trim();
    return escapeHtml(`[image: ${label}]`);
  });
  next = next.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, label, url) =>
      `<a href="${escapeHtmlAttr(stripHtmlFormatting(url))}">${label}</a>`,
  );
  next = next.replace(/^&gt;\s?(.*)$/gm, "<blockquote>$1</blockquote>");
  for (let i = 0; i < placeholders.length; i += 1) {
    next = next.replaceAll(`\u0000${i}\u0000`, placeholders[i] || "");
  }
  return normalizeRenderedText(sanitizeTelegramHtml(next));
}

export function renderChatNodesTelegramHtml(
  nodes: any[],
  options: RenderChatNodesOptions = {},
) {
  const pieces = (Array.isArray(nodes) ? nodes : [])
    .map((node) => {
      const type = safeString(node?.type).trim().toLowerCase();
      const attrs = attrsOf(node);
      if (type === "html") return sanitizeTelegramHtml(textAttr(node, attrs));
      if (type === "markdown" || type === "md") {
        return markdownToTelegramHtml(textAttr(node, attrs));
      }
      if (type === "at") return renderTelegramAt(attrs);
      return markdownToTelegramHtml(renderNodeMarkdown(node, options));
    })
    .join("");
  return normalizeRenderedText(pieces);
}
