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
    return src ? `![${label}](${src})` : `[image: ${label}]`;
  }
  return src
    ? `[${normalizedType}: ${label}](${src})`
    : `[${normalizedType}: ${label}]`;
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
  next = next.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  next = next.replace(/^\s{0,3}>\s?/gm, "");
  next = next.replace(/^\s*[-*+]\s+/gm, "- ");
  next = next.replace(/^\s*\d+[.)]\s+/gm, "");
  next = next.replace(/(\*\*|__)(.*?)\1/g, "$2");
  next = next.replace(/(\*|_)(.*?)\1/g, "$2");
  next = next.replace(/~~(.*?)~~/g, "$1");
  return normalizeRenderedText(next);
}

function normalizeRenderedText(text: string) {
  return safeString(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n[\t ]+/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
      return name ? `@${name}` : id ? `@${id}` : "@";
    }
    case "br":
      return "\n";
    case "quote": {
      const body = normalizeRenderedText(
        renderNodeMarkdown(childrenOf(node), options),
      );
      const id = safeString(attrs.id || attrs.messageId).trim();
      const prefix = id ? `quote ${id}` : "quote";
      return body
        ? `> [${prefix}] ${body.replace(/\n/g, "\n> ")}`
        : `[${prefix}]`;
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

export function renderChatNodesPlain(
  nodes: any[],
  options: RenderChatNodesOptions = {},
) {
  const markdown = renderChatNodesMarkdown(nodes, options);
  return options.markdown === "preserve"
    ? markdown
    : stripMarkdownFormatting(markdown);
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
  return sanitizeTelegramHtml(next).trim();
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
      return markdownToTelegramHtml(renderNodeMarkdown(node, options));
    })
    .join("");
  return pieces.trim();
}
